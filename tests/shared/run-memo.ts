import { Clock, Effect, Layer, Option, Path, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcess } from "effect/process";

import { AppConfig, HOOK_COMMAND } from "../../src/internal/read-memo-config.ts";
import { HookRunnerLive } from "../../src/internal/run-validation-hooks.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  LogStore,
  LOG_NAME,
  LogStoreLive,
} from "../../src/internal/store-logs-in-sqlite.ts";
import { compiledMemo } from "./compile-memo.ts";

export const INVALID_USAGE_EXIT_CODE = 2;
export const PERMISSION_BITS = 0o777;
export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

export const runProcess = Effect.fn("runProcess")(function* (
  command: readonly [string, ...string[]],
  options: {
    readonly workingDirectory?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly standardInput?: Uint8Array | string;
  } = {},
) {
  const [name, ...commandArguments] = command;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(name, commandArguments, {
        cwd: options.workingDirectory,
        env: options.environment,
        extendEnv: true,
        stdin:
          options.standardInput === undefined
            ? "ignore"
            : Stream.make(
                typeof options.standardInput === "string"
                  ? new TextEncoder().encode(options.standardInput)
                  : options.standardInput,
              ),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [standardOutput, standardError, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const code: number = exitCode;
      return { standardOutput, standardError, code };
    }),
  );
});

export const repositoryRoot = Path.Path.use((path) =>
  path.fromFileUrl(new URL("../../", import.meta.url)),
);

export const logName = (name: string) => LOG_NAME.make(name);

export const buildTestServices = (directory: string) =>
  Layer.build(
    HookRunnerLive.pipe(
      Layer.provideMerge(LogStoreLive),
      Layer.provide(Layer.succeed(AppConfig, { directory })),
    ),
  );
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

const clockStoppedAt = (datetime: string) =>
  Effect.map(Clock.Clock, (clock): Clock.Clock => {
    const millis = Date.parse(datetime);
    const nanos = BigInt(millis) * NANOSECONDS_PER_MILLISECOND;
    return {
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      currentTimeNanosUnsafe: () => nanos,
      currentTimeNanos: Effect.succeed(nanos),
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration),
    };
  });

export const appendEntry = (name: typeof LOG_NAME.Type, datetime: string, content: string) =>
  Effect.gen(function* () {
    const logStore = yield* LogStore;
    return yield* logStore
      .append(name, content)
      .pipe(Effect.provideService(Clock.Clock, yield* clockStoppedAt(datetime)));
  });

export const readEntries = (name: typeof LOG_NAME.Type, ids: readonly number[]) =>
  Effect.flatMap(LogStore, (logStore) => logStore.read(name, ids));

export const searchLog = (name: typeof LOG_NAME.Type, query: Option.Option<string>) =>
  Effect.flatMap(LogStore, (logStore) =>
    logStore.search(Option.some(name), query, DEFAULT_SEARCH_LIMIT),
  );

export const makeTemporaryDirectory = ({
  prefix = "memo-test-",
}: { readonly prefix?: string } = {}) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.makeTempDirectoryScoped({ prefix }));
export const writeFile = (file: string, content: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.writeFileString(file, content));
export const readFile = (file: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.readFileString(file));
export const makeDirectory = (directory: string, options: { recursive?: boolean } = {}) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.makeDirectory(directory, options));
export const changeMode = (file: string, mode: number) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.chmod(file, mode));
export const copy = (source: string, destination: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.copy(source, destination));
export const symlink = (target: string, file: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.symlink(target, file));
export const exists = (file: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.exists(file));
export const stat = (file: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.stat(file));
export const readLink = (file: string) =>
  Effect.flatMap(FileSystem, (fileSystem) => fileSystem.readLink(file));
export const runMemo = (
  argv: readonly string[],
  options: {
    readonly memoHome: string | undefined;
    readonly standardInput?: Uint8Array | string;
    readonly command?: readonly [string, ...string[]];
    readonly workingDirectory?: string;
    readonly environment?: Readonly<Record<string, string>>;
  },
) =>
  Effect.gen(function* () {
    const command = options.command ?? [yield* compiledMemo];
    return yield* runProcess([...command, ...argv], {
      workingDirectory: options.workingDirectory ?? (yield* repositoryRoot),
      environment: { ...options.environment, MEMO_HOME: options.memoHome },
      ...(options.standardInput === undefined ? {} : { standardInput: options.standardInput }),
    });
  });

const JSON_LINE = Schema.fromJsonString(Schema.JsonObject);
const FAILURE_LINE = Schema.fromJsonString(Schema.Struct({ message: Schema.String }));
const LOG_CONFIG = Schema.fromJsonString(Schema.Struct({ hook: HOOK_COMMAND }));

export const jsonLines = (text: string) =>
  Effect.forEach(text.trim() === "" ? [] : text.trimEnd().split("\n"), (line) =>
    Schema.decodeEffect(JSON_LINE)(line),
  );

export const locatedFailureAsText = (run: Effect.Success<ReturnType<typeof runProcess>>) =>
  Effect.map(Schema.decodeEffect(FAILURE_LINE)(run.standardError), (failure) => ({
    code: run.code,
    standardOutput: run.standardOutput,
    standardError: `${failure.message}\n`,
  }));

export const makeNamedPipe = (file: string) => runProcess(["mkfifo", file]);

export const startMemo = (argv: readonly string[], options: { readonly memoHome: string }) =>
  Effect.gen(function* () {
    const memo = yield* compiledMemo;
    const workingDirectory = yield* repositoryRoot;
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([memo, ...argv], {
          cwd: workingDirectory,
          env: { MEMO_HOME: options.memoHome },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      ),
      (running) =>
        Effect.sync(() => {
          running.kill("SIGKILL");
        }),
    );
  });

export const writeHookConfig = (logDirectory: string, hook: readonly [string, ...string[]]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const text = yield* Schema.encodeEffect(LOG_CONFIG)({ hook });
    yield* writeFile(path.join(logDirectory, "config.json"), text);
  });
