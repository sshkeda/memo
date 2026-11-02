import { fileURLToPath } from "node:url";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Schema } from "effect";

import packageJson from "../../package.json" with { type: "json" };

class MemoBuildFailed extends Schema.TaggedError<MemoBuildFailed>()("MemoBuildFailed", {
  message: Schema.String,
}) {}

const EXECUTABLE_NAME = process.platform === "win32" ? "memo.exe" : "memo";
const OUTPUT_DIRECTORY_MODE = 0o700;

const repository = fileURLToPath(new URL("../..", import.meta.url));

const describeBuildLog = (log: BuildMessage | ResolveMessage, path: Path.Path) => {
  if (log.position === null) {
    return `${log.level}: ${log.message}`;
  }
  const { file, line, column, lineText } = log.position;
  return `${path.relative(repository, file)}:${line}:${column}: ${log.level}: ${log.message}\n  ${lineText}`;
};

const compile = Effect.fn("compile")(function* (requestedOutfile: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outfile = path.resolve(repository, requestedOutfile);
  yield* fileSystem.makeDirectory(path.dirname(outfile), {
    recursive: true,
    mode: OUTPUT_DIRECTORY_MODE,
  });
  const compileFailure = (reason: string) =>
    new MemoBuildFailed({ message: `could not compile ${outfile}:\n${reason}` });
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
        target: "bun",
        minify: true,
        compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
        throw: false,
      }),
    catch: (cause) => compileFailure(String(cause)),
  });
  if (!result.success) {
    return yield* compileFailure(result.logs.map((log) => describeBuildLog(log, path)).join("\n"));
  }
  return outfile;
});

export const compiledMemo = Task.make(
  "build test executable",
  Path.Path.use((path) => compile(path.join(repository, "dist", "test", EXECUTABLE_NAME))),
  { timeout: "3 minutes", cleanup: "5 seconds" },
);

export const build = Task.make(
  "build",
  Effect.gen(function* () {
    const built = yield* compile(packageJson.bin.memo);
    yield* Effect.log(`Built memo at ${built}`);
  }),
  { timeout: "3 minutes", cleanup: "5 seconds" },
);
