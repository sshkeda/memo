import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Path } from "effect";

import { compiledMemo } from "../shared/compile-memo.ts";
import {
  copy,
  exists,
  makeDirectory,
  readFile,
  writeFile,
  writeHookConfig,
  jsonLines,
  repositoryRoot,
  runMemo,
  makeTemporaryDirectory,
  runProcess,
  symlink,
  INVALID_USAGE_EXIT_CODE,
} from "../shared/run-memo.ts";

const checkoutCopy = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repository = yield* repositoryRoot;
  const checkout = yield* makeTemporaryDirectory({ prefix: "memo-build-" });
  yield* Effect.forEach(
    ["package.json", "scripts", "src", "tests"],
    (entry) => copy(path.join(repository, entry), path.join(checkout, entry)),
    { discard: true },
  );
  yield* symlink(path.join(repository, "node_modules"), path.join(checkout, "node_modules"));
  return checkout;
});

export const bunLinkInstallsTheBuiltExecutable = Task.make(
  "compiled memo: bun link installs the executable the build writes",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const checkout = yield* checkoutCopy;
      const home = yield* makeTemporaryDirectory();
      const bunInstall = yield* makeTemporaryDirectory();
      const built = yield* runProcess(["bun", path.join(checkout, "scripts", "build.ts")], {
        workingDirectory: checkout,
        environment: {
          HOME: home,
          MEMO_INSTALL: "true",
          SSHKEDA_TASK_STATE_DIRECTORY: yield* makeTemporaryDirectory(),
        },
      });
      expect(built.code).toBe(0);
      expect(yield* exists(path.join(home, ".local"))).toBe(false);
      const linked = yield* runProcess(["bun", "link"], {
        workingDirectory: checkout,
        environment: { HOME: home, BUN_INSTALL: bunInstall },
      });
      expect(linked.code).toBe(0);
      const version = yield* runProcess([path.join(bunInstall, "bin", "memo"), "--version"]);
      expect(version.standardOutput).toContain("memo v1.0.0");
    }),
  ),
  { timeout: "3 minutes", cleanup: "5 seconds" },
);

export const runsStandaloneAndExercisesTheCompleteCommandSurface = Task.make(
  "compiled memo: runs standalone and exercises the complete command surface",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const executable = yield* compiledMemo;

      const memoHome = yield* makeTemporaryDirectory();
      const command = [executable] as const;
      expect((yield* runMemo(["--version"], { memoHome, command })).standardOutput).toContain(
        "memo v1.0.0",
      );
      expect(
        (yield* runMemo(["check", "--log", "default", "candidate"], { memoHome, command })).code,
      ).toBe(0);
      expect(
        (yield* runMemo(["append", "--log", "default", "compiled exact"], { memoHome, command }))
          .code,
      ).toBe(0);
      expect(
        (yield* jsonLines(
          (yield* runMemo(["search", "--log", "default", "--json"], { memoHome, command }))
            .standardOutput,
        ))[0]?.["preview"],
      ).toBe("compiled exact");
      expect(
        (yield* jsonLines(
          (yield* runMemo(["search", "--log", "default", "compiled", "--full", "--json"], {
            memoHome,
            command,
          })).standardOutput,
        ))[0]?.["content"],
      ).toBe("compiled exact");
      expect(
        (yield* jsonLines(
          (yield* runMemo(["read", "default", "1", "--json"], { memoHome, command }))
            .standardOutput,
        ))[0]?.["content"],
      ).toBe("compiled exact");
      expect(
        yield* jsonLines(
          (yield* runMemo(["read", "--json"], { memoHome, command })).standardOutput,
        ),
      ).toEqual([
        { name: "default", directory: path.join(memoHome, "logs", "default"), entries: 1 },
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const refusesEmptyRecordsAndAcceptsWhitespaceOnlyRecords = Task.make(
  "compiled memo: refuses empty records however they arrive and accepts whitespace-only records",
  Effect.scoped(
    Effect.gen(function* () {
      const executable = yield* compiledMemo;

      const memoHome = yield* makeTemporaryDirectory();
      const command = [executable] as const;
      for (const argv of [
        ["append", "--log", "default"],
        ["append", "--log", "default", ""],
        ["check", "--log", "default", ""],
      ]) {
        expect((yield* runMemo(argv, { memoHome, command })).code).toBe(INVALID_USAGE_EXIT_CODE);
      }
      expect(
        (yield* runMemo(["append", "--log", "default", "   "], { memoHome, command })).code,
      ).toBe(0);
      const rows = yield* jsonLines(
        (yield* runMemo(["read", "default", "1", "--json"], { memoHome, command })).standardOutput,
      );
      expect(rows.map((row) => row["content"])).toEqual(["   "]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const runsConfiguredHookCommand = Task.make(
  "compiled memo: runs a configured hook command on a file without a shebang or executable bit",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const executable = yield* compiledMemo;

      const memoHome = yield* makeTemporaryDirectory();
      const directory = path.join(memoHome, "logs", "default", "hooks");
      yield* makeDirectory(directory, { recursive: true });
      const hook = path.join(directory, "reject.ts");
      yield* writeFile(
        hook,
        'await Bun.stdin.text(); console.error("compiled-policy"); process.exit(1);',
      );
      yield* writeHookConfig(path.join(memoHome, "logs", "default"), ["bun", hook]);
      const run = yield* runMemo(["append", "--log", "default", "candidate"], {
        memoHome,
        command: [executable],
      });
      expect(run.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(run.standardError).toContain("compiled-policy");
      expect(yield* exists(path.join(memoHome, "logs", "default", "entries.sqlite3"))).toBe(false);
      expect(yield* readFile(hook)).toContain("compiled-policy");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const namesAMissingHookCommand = Task.make(
  "compiled memo: names the hook command when it must run and is not on PATH",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const executable = yield* compiledMemo;

      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "default");
      yield* makeDirectory(logDirectory, { recursive: true });
      const hook = path.join(memoHome, "accept.ts");
      yield* writeFile(hook, "await Bun.stdin.text();");
      yield* writeHookConfig(logDirectory, ["bun", hook]);
      const run = yield* runMemo(["check", "--log", "default", "candidate"], {
        memoHome,
        command: [executable],
        environment: { PATH: "" },
      });
      expect(run.code).toBe(1);
      expect(run.standardError).toBe(
        `error: ${path.join(logDirectory, "config.json")}: the hook command \`bun\` isn't on PATH\n`,
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const ignoresAmbientConfigAndRunsWithoutBunOnPATH = Task.make(
  "compiled memo: ignores ambient config and runs without Bun on PATH",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const executable = yield* compiledMemo;

      const memoHome = yield* makeTemporaryDirectory();
      const hijacked = yield* makeTemporaryDirectory();
      const workingDirectory = yield* makeTemporaryDirectory();
      yield* writeFile(path.join(workingDirectory, ".env"), `MEMO_HOME=${hijacked}\n`);
      yield* writeFile(path.join(workingDirectory, "bunfig.toml"), "[run]\nbun = true\n");
      const run = yield* runMemo(["append", "--log", "default", "standalone"], {
        command: [executable],
        workingDirectory,
        environment: { PATH: "" },
        memoHome,
      });
      expect(run.code).toBe(0);
      expect(yield* exists(path.join(memoHome, "logs", "default", "entries.sqlite3"))).toBe(true);
      expect(yield* exists(path.join(hijacked, "logs", "default", "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const usageErrorsPrintTheErrorAndAHintInsteadOfHelp = Task.make(
  "compiled memo: usage errors print the error and a hint instead of the whole help",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const results = yield* Effect.forEach(
        [
          ["sadf"],
          ["app"],
          ["append", "sdf"],
          ["append", "--lgo", "work", "x"],
          ["search", "a", "b"],
        ],
        (commandArguments) => runMemo(commandArguments, { memoHome }),
      );
      expect(results).toEqual([
        {
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: "error: memo has no command sadf\nhint: run `memo --help`\n",
        },
        {
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: "error: memo has no command app\nhint: run `memo --help`\n",
        },
        {
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: "error: memo append needs --log\nhint: run `memo append --help`\n",
        },
        {
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: "error: memo append has no flag --lgo\nhint: did you mean --log?\n",
        },
        {
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError:
            'error: memo search doesn\'t take the extra argument "b"\nhint: run `memo search --help`\n',
        },
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const explicitLogs = Task.make(
  "compiled memo: requires explicit log selection",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const command = [yield* compiledMemo] as const;
      const memoHome = yield* makeTemporaryDirectory();
      yield* Effect.forEach(
        [
          ["append", "candidate"],
          ["check", "candidate"],
        ],
        (commandArguments) =>
          Effect.gen(function* () {
            const result = yield* runMemo(commandArguments, { memoHome, command });
            expect(result.code).toBe(INVALID_USAGE_EXIT_CODE);
            expect(result.standardOutput).toBe("");
            expect(result.standardError).toContain("log");
          }),
      );
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
      const logs = yield* runMemo(["read", "--json"], { memoHome, command });
      expect(logs.code).toBe(0);
      expect(logs.standardOutput).toBe("");
      const search = yield* runMemo(["search", "AI", "--json"], { memoHome, command });
      expect(search.code).toBe(0);
      expect(search.standardOutput).toBe("");
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const BROKEN_PIPE_EXIT_CODE = 141;
const BYTES_BEYOND_A_PIPE_BUFFER = 262_144;

export const stopsQuietlyWhenTheReaderClosesStandardOutput = Task.make(
  "compiled memo: stops quietly with exit code 141 when the reader closes stdout early",
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return;
      }
      const executable = yield* compiledMemo;
      const memoHome = yield* makeTemporaryDirectory();
      const appended = yield* runMemo(["append", "--log", "default"], {
        memoHome,
        command: [executable],
        standardInput: "x".repeat(BYTES_BEYOND_A_PIPE_BUFFER),
      });
      expect(appended.code).toBe(0);
      const piped = yield* runProcess(
        [
          "sh",
          "-c",
          '{ "$0" read default 1; echo "memo exited $?" >&2; } | head -c 1 >/dev/null',
          executable,
        ],
        { environment: { MEMO_HOME: memoHome } },
      );
      expect(piped.standardError).toBe(`memo exited ${BROKEN_PIPE_EXIT_CODE}\n`);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const refusesAnEmptyArgumentWhileStandardInputStaysOpen = Task.make(
  "compiled memo: append and check refuse an empty argument without waiting for an open stdin to close",
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return;
      }
      const executable = yield* compiledMemo;
      const memoHome = yield* makeTemporaryDirectory();
      const held = yield* runProcess(
        [
          "sh",
          "-c",
          'exec 3>&2 2>/dev/null; sleep 120 | { "$0" append --log default "" 2>&3; echo "append $?"; "$0" check --log default "" 2>&3; echo "check $?"; pkill -P $$ sleep; }',
          executable,
        ],
        { environment: { MEMO_HOME: memoHome } },
      );
      expect(held).toEqual({
        code: 0,
        standardOutput: `append ${INVALID_USAGE_EXIT_CODE}\ncheck ${INVALID_USAGE_EXIT_CODE}\n`,
        standardError:
          "error: memo append got no content to save\nhint: run `memo append --help`\nerror: memo check got no content to check\nhint: run `memo check --help`\n",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const usesTheArgumentWhileStandardInputStaysOpen = Task.make(
  "compiled memo: append and check use their argument without waiting for an open stdin to close",
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return;
      }
      const executable = yield* compiledMemo;
      const memoHome = yield* makeTemporaryDirectory();
      const held = yield* runProcess(
        [
          "sh",
          "-c",
          'exec 3>&2 2>/dev/null; sleep 120 | { "$0" append --log default "from an argument" 2>&3; "$0" check --log default "from an argument" 2>&3; pkill -P $$ sleep; }',
          executable,
        ],
        { environment: { MEMO_HOME: memoHome } },
      );
      expect(held).toEqual({
        code: 0,
        standardOutput:
          "Appended default #1.\ndefault has no hook, so memo append would save this content.\n",
        standardError: "",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);
