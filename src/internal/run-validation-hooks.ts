import type { ReadableStreamDefaultReader as StandardErrorReader } from "node:stream/web";

import type { Subprocess } from "bun";
import { Context, Data, Duration, Effect, Layer, Option, Schema } from "effect";
import { Path } from "effect/Path";

import { HookCommandNotFoundError, HookLaunchError, StorageError } from "./memo-errors.ts";
import { hookEnvironment } from "./read-memo-config.ts";
import type { HOOK_COMMAND } from "./read-memo-config.ts";
import { sanitize } from "./sanitize-terminal-text.ts";
import { LogStore } from "./store-logs-in-sqlite.ts";
import type { LOG_NAME } from "./store-logs-in-sqlite.ts";

export class NoHook extends Data.TaggedClass("NoHook") {}
export class HookAccepted extends Data.TaggedClass("HookAccepted")<{
  readonly hook: typeof HOOK_COMMAND.Type;
}> {}
export class HookRejected extends Data.TaggedClass("HookRejected")<{
  readonly hook: typeof HOOK_COMMAND.Type;
  readonly reason: string;
}> {}
export class HookTimedOut extends Data.TaggedClass("HookTimedOut")<{
  readonly hook: typeof HOOK_COMMAND.Type;
}> {}
export class HookKilled extends Data.TaggedClass("HookKilled")<{
  readonly hook: typeof HOOK_COMMAND.Type;
  readonly signal: string;
  readonly reason: string | undefined;
}> {}

export const HOOK_TIME_LIMIT = Duration.minutes(1);
export const HOOK_TIME_LIMIT_TEXT = "1 minute";
export const HookTimeLimit = Context.Reference<Duration.Duration>("memo/HookTimeLimit", {
  defaultValue: () => HOOK_TIME_LIMIT,
});

const MAX_REASON_GRAPHEMES = 200;
const BUN_CRASH_BANNER = /^Bun v\d/u;
const STACK_FRAME = /^at .*:\d+:\d+\)?$/u;
const ERROR_LABEL = /^error:\s*/iu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const capped = (reason: string) => {
  const characters = Array.from(graphemes.segment(reason), ({ segment }) => segment);
  return characters.length <= MAX_REASON_GRAPHEMES
    ? reason
    : `${characters.slice(0, MAX_REASON_GRAPHEMES - 1).join("")}…`;
};

const crashReason = (lines: readonly string[]) =>
  lines
    .map((candidate) => candidate.trim())
    .findLast(
      (candidate) =>
        candidate !== "" && !BUN_CRASH_BANNER.test(candidate) && !STACK_FRAME.test(candidate),
    );

const hookReason = (standardError: string): string | undefined => {
  const lines = sanitize(standardError)
    .split("\n")
    .map((line) => line.trimEnd());
  const isBunCrash = lines.some((line) => BUN_CRASH_BANNER.test(line.trim()));
  const reason = isBunCrash ? crashReason(lines) : lines.join("\n").trim();
  const isMissing = reason === undefined || reason === "";
  return isMissing ? undefined : capped(reason.replace(ERROR_LABEL, ""));
};

const SIGNAL_NAME = /^SIG[A-Z0-9]+$/u;
const signalName = (signal: NonNullable<Subprocess["signalCode"]>) =>
  SIGNAL_NAME.test(String(signal)) ? String(signal) : `signal ${String(signal)}`;
const LAUNCH_FAULTS = { ENOEXEC: "NotAProgram", ENOENT: "InterpreterNotFound" } as const;
const isLaunchFault = Schema.is(Schema.Struct({ code: Schema.Literals(["ENOEXEC", "ENOENT"]) }));
const hasErrorCode = Schema.is(Schema.Struct({ code: Schema.String }));

const readChunk = (pending: ReturnType<StandardErrorReader<Uint8Array<ArrayBuffer>>["read"]>) =>
  Effect.tryPromise({
    try: () => pending,
    catch: (cause) =>
      new StorageError({
        message: `memo couldn't read the hook's stderr: ${String(cause)}`,
        cause,
      }),
  });

const drainBuffered = (
  reader: StandardErrorReader<Uint8Array<ArrayBuffer>>,
  pending: ReturnType<StandardErrorReader<Uint8Array<ArrayBuffer>>["read"]>,
  chunks: readonly Uint8Array[],
): Effect.Effect<readonly Uint8Array[], StorageError> =>
  Effect.raceFirst(
    Effect.asSome(readChunk(pending)),
    Effect.as(Effect.yieldNow, Option.none()),
  ).pipe(
    Effect.flatMap((read) => {
      const nothingMoreIsBuffered = Option.isNone(read) || read.value.done;
      return nothingMoreIsBuffered
        ? Effect.succeed(chunks)
        : drainBuffered(reader, reader.read(), [...chunks, read.value.value]);
    }),
  );

const readWhileRunning = (
  reader: StandardErrorReader<Uint8Array<ArrayBuffer>>,
  exited: Effect.Effect<number>,
  pending: ReturnType<StandardErrorReader<Uint8Array<ArrayBuffer>>["read"]>,
  chunks: readonly Uint8Array[],
): Effect.Effect<readonly Uint8Array[], StorageError> =>
  Effect.raceFirst(Effect.asSome(readChunk(pending)), Effect.as(exited, Option.none())).pipe(
    Effect.flatMap((read) => {
      if (Option.isNone(read)) {
        return drainBuffered(reader, pending, chunks);
      }
      return read.value.done
        ? Effect.succeed(chunks)
        : readWhileRunning(reader, exited, reader.read(), [...chunks, read.value.value]);
    }),
  );

const readUntilExitThenDrain = (
  reader: StandardErrorReader<Uint8Array<ArrayBuffer>>,
  exited: Effect.Effect<number>,
) => readWhileRunning(reader, exited, reader.read(), []);

class HookAlreadyStoppedError extends Data.TaggedError("HookAlreadyStoppedError") {}

const ignoringStoppedHook = (stop: () => void) =>
  Effect.try({ try: stop, catch: () => new HookAlreadyStoppedError() }).pipe(
    Effect.catchTag("HookAlreadyStoppedError", () => Effect.void),
  );

const stopHookProcesses = (child: Subprocess) =>
  process.platform === "win32"
    ? Effect.andThen(
        Effect.tryPromise({
          try: () =>
            Bun.spawn(["taskkill", "/pid", String(child.pid), "/T", "/F"], {
              stdout: "ignore",
              stderr: "ignore",
            }).exited,
          catch: () => new HookAlreadyStoppedError(),
        }).pipe(Effect.catchTag("HookAlreadyStoppedError", () => Effect.void)),
        ignoringStoppedHook(() => {
          child.kill();
        }),
      )
    : ignoringStoppedHook(() => {
        process.kill(-child.pid, "SIGKILL");
      });

const decodeChunks = (chunks: readonly Uint8Array[]) => {
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
};

const make = Effect.gen(function* () {
  const logStore = yield* LogStore;
  const path = yield* Path;
  const check = Effect.fn("HookRunner.check")(function* (
    log: typeof LOG_NAME.Type,
    content: string,
  ) {
    const { hook, configFile } = yield* logStore.hookOf(log);
    if (hook === undefined) {
      return new NoHook();
    }
    const [command, ...commandArguments] = hook;
    const executable = Bun.which(command);
    if (executable === null) {
      return yield* new HookCommandNotFoundError({
        file: configFile,
        command,
        reason: path.isAbsolute(command) ? "NotExecutable" : "NotOnPath",
      });
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              Bun.spawn([executable, ...commandArguments], {
                env: hookEnvironment(log),
                detached: true,
                stdin: new TextEncoder().encode(content),
                stdout: "ignore",
                stderr: "pipe",
              }),
            catch: (cause) =>
              isLaunchFault(cause)
                ? new HookCommandNotFoundError({
                    file: configFile,
                    command,
                    reason: LAUNCH_FAULTS[cause.code],
                  })
                : new HookLaunchError({
                    file: configFile,
                    log,
                    command,
                    code: hasErrorCode(cause) ? cause.code : String(cause),
                    cause,
                  }),
          }),
          stopHookProcesses,
        );
        const standardError = yield* Effect.acquireRelease(
          Effect.sync(() => child.stderr.getReader()),
          (reader) => Effect.promise(() => reader.cancel()),
        );
        const finished = yield* readUntilExitThenDrain(
          standardError,
          Effect.promise(() => child.exited),
        ).pipe(
          Effect.tap(() => Effect.promise(() => child.exited)),
          Effect.timeoutOption(yield* HookTimeLimit),
        );
        if (Option.isNone(finished)) {
          return new HookTimedOut({ hook });
        }
        const reason = hookReason(decodeChunks(finished.value));
        if (child.signalCode !== null) {
          return new HookKilled({ hook, signal: signalName(child.signalCode), reason });
        }
        if (child.exitCode === 0) {
          return new HookAccepted({ hook });
        }
        return new HookRejected({
          hook,
          reason:
            reason ?? `the hook exited with code ${child.exitCode} and wrote no reason to stderr`,
        });
      }),
    );
  });
  return { check };
});
export class HookRunner extends Context.Service<HookRunner, Effect.Success<typeof make>>()(
  "memo/HookRunner",
) {}

export const HookRunnerLive = Layer.effect(HookRunner, make);
