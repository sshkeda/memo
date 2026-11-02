import { Effect, Layer, Option, Result, Schema, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { make as makeStdio, Stdio } from "effect/Stdio";

import { decodeUtf8Strictly } from "./decode-utf8-strictly.ts";
import {
  InvalidInputError,
  OutputEncodeError,
  StandardOutputClosedError,
  StandardStreamError,
} from "./memo-errors.ts";
import type { MEMO_COMMAND } from "./memo-errors.ts";

const isBrokenPipe = Schema.is(Schema.Struct({ code: Schema.Literal("EPIPE") }));

export const writeOut = (
  text: string,
): Effect.Effect<void, StandardOutputClosedError | StandardStreamError, Stdio> =>
  text === ""
    ? Effect.void
    : Effect.flatMap(Stdio, (stdio) =>
        Stream.run(Stream.make(text), stdio.stdout()).pipe(
          Effect.mapError((cause) =>
            isBrokenPipe(cause.cause)
              ? new StandardOutputClosedError({})
              : new StandardStreamError({ stream: "stdout", message: cause.message, cause }),
          ),
        ),
      );

export const writeStandardError = (text: string) =>
  Effect.flatMap(Stdio, (stdio) =>
    Stream.run(Stream.make(text), stdio.stderr()).pipe(
      Effect.mapError(
        (cause) => new StandardStreamError({ stream: "stderr", message: cause.message, cause }),
      ),
    ),
  );

export const writeResult = <Requirements>(
  json: Effect.Effect<string, Schema.SchemaError, Requirements>,
  human: string,
  forceJson: boolean,
) =>
  forceJson
    ? json.pipe(
        Effect.mapError((cause) => new OutputEncodeError({ cause })),
        Effect.flatMap(writeOut),
      )
    : writeOut(human);

const readStandardInput = Effect.gen(function* () {
  const stdio = yield* Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return Option.none<Uint8Array>();
  }
  const bytes = yield* Stream.mkUint8Array(stdio.stdin).pipe(
    Effect.mapError(
      (cause) => new StandardStreamError({ stream: "stdin", message: cause.message, cause }),
    ),
  );
  return bytes.length === 0 ? Option.none<Uint8Array>() : Option.some(bytes);
});

const REPLACEMENT_CHARACTER = "\uFFFD";

const decodeContent = (
  bytes: Uint8Array,
  command: Extract<typeof MEMO_COMMAND.Type, "append" | "check">,
) =>
  Result.match(decodeUtf8Strictly(bytes), {
    onSuccess: (text) => Effect.succeed(text),
    onFailure: (offset) =>
      Effect.fail(
        new InvalidInputError({
          command,
          message: `the content isn't valid UTF-8 at byte ${offset}`,
        }),
      ),
  });

export const checkArgument = (
  argument: string,
  command: Extract<typeof MEMO_COMMAND.Type, "append" | "check" | "search">,
) => {
  const replaced = argument.indexOf(REPLACEMENT_CHARACTER);
  const offset = new TextEncoder().encode(argument.slice(0, replaced)).length;
  const fault = `isn't valid UTF-8 at byte ${offset}, or has U+FFFD there, which an argument can't carry`;
  return replaced === -1
    ? Effect.succeed(argument)
    : Effect.fail(
        new InvalidInputError({
          command,
          message:
            command === "search"
              ? `the query ${fault}`
              : `the content ${fault}; pass it on stdin to keep a U+FFFD`,
        }),
      );
};

export const suppliedContent = (
  argument: Option.Option<string>,
  command: Extract<typeof MEMO_COMMAND.Type, "append" | "check">,
) =>
  Effect.gen(function* () {
    const purpose = command === "append" ? "save" : "check";
    const noContent = new InvalidInputError({
      command,
      message: `memo ${command} got no content to ${purpose}`,
    });
    if (Option.isSome(argument)) {
      return argument.value === ""
        ? yield* noContent
        : yield* checkArgument(argument.value, command);
    }
    const piped = yield* readStandardInput;
    if (Option.isNone(piped)) {
      return yield* noContent;
    }
    return yield* decodeContent(piped.value, command);
  });

export const standardInputFromItsPosition = Layer.effect(
  Stdio,
  Effect.map(Stdio, (stdio) =>
    makeStdio({
      ...stdio,
      stdin: Stream.fromEffect(
        Effect.tryPromise({
          try: () => Bun.stdin.bytes(),
          catch: (cause) =>
            systemError({ _tag: "Unknown", module: "Stdio", method: "stdin", cause }),
        }),
      ),
    }),
  ),
);
