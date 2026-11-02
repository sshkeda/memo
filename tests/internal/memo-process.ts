import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Path } from "effect";
import { FileSystem } from "effect/FileSystem";

import {
  SEARCH_INDEX_TABLE,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "../../src/internal/store-logs-in-sqlite.ts";
import { compiledMemo } from "../shared/compile-memo.ts";
import {
  checkpointAndTruncateWal,
  dropFullTextIndex,
  foreignLog,
  emptySearchIndexFromOlderWordRules,
  logFromStatements,
  runStatements,
  textColumn,
  insertEntryOutOfDateOrder,
  legacyLog,
  LOCK_HOLDER_CONTENT,
  unrelatedLog,
  readDatabaseSummary,
  readRows,
  runWriterAgainstHeldWriteLock,
  schemaNames,
  UNTYPED_TABLE,
  whileInsertingEntries,
  whileHoldingUncommittedEntry,
  whileWalHoldsCommittedStatements,
} from "../shared/open-sqlite-database.ts";
import {
  changeMode,
  exists,
  makeDirectory,
  readFile,
  writeFile,
  symlink,
  stat,
  jsonLines,
  locatedFailureAsText,
  writeHookConfig,
  runMemo,
  runProcess,
  makeTemporaryDirectory,
  buildTestServices,
  INVALID_USAGE_EXIT_CODE,
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  PERMISSION_BITS,
  logName,
  appendEntry,
  makeNamedPipe,
  startMemo,
} from "../shared/run-memo.ts";

const TRUNCATED_REASON_GRAPHEMES = 199;
const CONCURRENT_APPENDS = 8;
const ENTRIES_BEYOND_ONE_PAGE = DEFAULT_SEARCH_LIMIT + 1;
const ENTRY_YEAR = 2026;
const LONG_ENTRY_WORD_REPEATS = 100;
const NEWEST_ALPHA_ID = 4;
const OLDER_SAME_DAY_ALPHA_ID = 2;
const WORLD_READABLE_FILE_MODE = 0o644;
const READ_ONLY_DIRECTORY_MODE = 0o500;
const UNREADABLE_FILE_MODE = 0o000;
const UNLISTABLE_DIRECTORY_MODE = 0o100;
const BURYING_SENTENCE_REPEATS = 100;
const REPEATED_QUERY_WORDS = 100_000;
const BROWSED_ENTRY_COUNT = 3;
const BROWSE_PAGE_SIZE = 2;
const JUNK_DATABASE_REPEATS = 100;
const TRUNCATED_LOG_ENTRIES = 40;
const TRUNCATED_LOG_FILLER_WORDS = 400;
const HALF = 2;
const READ_ONLY_FILE_MODE = 0o400;
const RACING_READS = 60;
const OUTPUT_MODES = 2;
const RACING_READ_CONCURRENCY = 6;
const MOST_RACING_INSERTS = 900;
const MISSING_ENTRY_ID = 2;
const BACKGROUND_SLEEP_SECONDS = 600;
const CHILD_SLEEP_SECONDS = 90;
const DARWIN_SIGEMT = 7;
const restoreHintText = (log: string, directory: string) =>
  `stop anything using ${log}, then restore its folder \`${directory}\` from a backup, or move that whole folder, -wal and -shm files included, out of the logs folder to keep a copy and start ${log} over`;
const restoreHint = (log: string, directory: string) =>
  `hint: ${restoreHintText(log, directory)}\n`;
const DEBUG_HINT = "hint: run again with `MEMO_DEBUG=1` to see the cause\n";
const asHumanError = (
  located: {
    readonly code: number;
    readonly standardOutput: string;
    readonly standardError: string;
  },
  hint = "",
) => ({ ...located, standardError: `error: ${located.standardError}${hint}` });
const notFoundHint = (log: string, directory: string) =>
  `run \`memo read\` to see your logs, or \`memo append <content> --log ${log}\` to create it in \`${directory}\``;
const logNotFound = (log: string, directory: string) => ({
  code: 1,
  standardOutput: "",
  standardError: `error: there's no log named ${log}\nhint: ${notFoundHint(log, directory)}\n`,
});

const installHook = (memoHome: string, log: string, name: string, body: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = path.join(memoHome, "logs", log);
    yield* makeDirectory(directory, { recursive: true });
    const file = path.join(directory, name.endsWith(".ts") ? name : `${name}.ts`);
    yield* writeFile(file, body);
    yield* writeHookConfig(directory, ["bun", file]);
    return file;
  });

export const generatedHelpExposesCommands = Task.make(
  "memo process: help lists the commands in the layout bl and other Cobra CLIs use",
  Effect.scoped(
    Effect.gen(function* () {
      const run = yield* runMemo(["--help"], { memoHome: yield* makeTemporaryDirectory() });
      expect(run.code).toBe(0);
      expect(run.standardOutput).toContain("append");
      expect(run.standardOutput).toContain("search");
      expect(run.standardOutput).toContain("read");
      expect(run.standardOutput).toContain("check");
      expect(run.standardOutput).not.toMatch(/^logs\s/mu);
      expect(run.standardOutput).not.toContain("\npath\n");
      expect(run.standardOutput).toBe(
        [
          "Memo keeps append-only logs that you and your agents can search later.",
          "",
          "Usage:",
          "  memo <command> [flags]",
          "",
          "Available Commands:",
          "  append   Save content as a new entry in a log.",
          "  search   Search every log, newest entries first.",
          "  read     List your logs, or show a log's entries.",
          "  check    Run a log's hook on content without saving it.",
          "",
          "Flags:",
          "  -h, --help      Show help for memo or one command.",
          "  -v, --version   Show memo's version.",
          "",
          'Use "memo <command> --help" for more information about a command.',
          "",
        ].join("\n"),
      );
      expect(run.standardOutput).not.toMatch(/^\s+(?:recall|list|stores)\s/mu);
      const bare = yield* runMemo([], { memoHome: yield* makeTemporaryDirectory() });
      expect(bare.code).toBe(0);
      expect(bare.standardOutput).toBe(run.standardOutput);
      expect(bare.standardError).toBe("");
      const bareWithInvalidConfig = yield* runMemo([], { memoHome: "relative" });
      expect(bareWithInvalidConfig.code).toBe(0);
      expect(bareWithInvalidConfig.standardOutput).toBe(run.standardOutput);
      expect(bareWithInvalidConfig.standardError).toBe("");
      yield* Effect.forEach(
        [["logs"], ["recall"], ["list"], ["stores"], ["append", "--store", "old"]],
        (argv) =>
          Effect.gen(function* () {
            expect((yield* runMemo(argv, { memoHome: yield* makeTemporaryDirectory() })).code).toBe(
              INVALID_USAGE_EXIT_CODE,
            );
          }),
        { discard: true },
      );
      const subcommand = yield* runMemo(["search", "--help"], {
        memoHome: yield* makeTemporaryDirectory(),
      });
      expect(subcommand.code).toBe(0);
      expect(subcommand.standardOutput).toBe(
        [
          "Search the entries in every log, newest first. Each result shows the whole entry, or the passage that matches when the entry is long. A preview with … leaves text out, so read the entry with `memo read <log> <id>` before you act on it. Use --log to search one log, and --full to show whole entries. Leave out the query to show the newest entries.",
          "",
          "Usage:",
          "  memo search [flags] [<query>]",
          "",
          "Arguments:",
          "  query string   The words to find. An entry matches when it has every word. Put `--` before a query that starts with a dash.",
          "",
          "Flags:",
          "      --full            Show whole entries instead of previews.",
          "      --json            Print one JSON object per entry, and nothing when no entry matches.",
          `      --limit integer   Show at most this many entries. The default is ${DEFAULT_SEARCH_LIMIT}, and the most is ${MAX_SEARCH_LIMIT}.`,
          "      --log string      Search only this log.",
          "",
          "Global Flags:",
          "  -h, --help      Show help for memo or one command.",
          "  -v, --version   Show memo's version.",
          "",
        ].join("\n"),
      );
      for (const command of ["append", "read", "check"]) {
        const page = (yield* runMemo([command, "--help"], { memoHome: "relative" })).standardOutput;
        expect(page).toContain(`\n\nUsage:\n  memo ${command} [flags]`);
        expect(page).toContain("\n\nArguments:\n");
        expect(page).toContain("\n\nFlags:\n      --json ");
        expect(page).toEndWith(
          "\n\nGlobal Flags:\n  -h, --help      Show help for memo or one command.\n  -v, --version   Show memo's version.\n",
        );
        expect(page).not.toMatch(/^[A-Z ]+$/mu);
        expect(page).not.toContain("Examples:");
      }
      yield* Effect.forEach(
        [
          ["nope"],
          ["nope", "--help"],
          ["--help", "nope"],
          ["nope", "-h"],
          ["search", "--bogus"],
          ["--wizard"],
          ["--completions", "zsh"],
        ],
        (argv) =>
          Effect.gen(function* () {
            const invalid = yield* runMemo(argv, { memoHome: yield* makeTemporaryDirectory() });
            expect(invalid.code).toBe(INVALID_USAGE_EXIT_CODE);
            expect(invalid.standardOutput).toBe("");
            expect(invalid.standardError).toStartWith("error: ");
            expect(invalid.standardError).not.toContain("USAGE");
            expect(invalid.standardError).not.toContain("wizard mode");
          }),
        { discard: true },
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const defaultTextIsConciseAndJsonIsStableJSONL = Task.make(
  "memo process: default text is concise and --json is stable JSONL",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      expect((yield* runMemo(["read"], { memoHome })).standardOutput).toBe(
        `There are no logs in \`${path.join(memoHome, "logs")}\` yet.\n\nRun \`memo append <content> --log <log>\` to create one.\n`,
      );
      expect((yield* runMemo(["read", "--json"], { memoHome })).standardOutput).toBe("");
      expect(
        (yield* runMemo(["append", "--log", "default", "first generic entry"], { memoHome }))
          .standardOutput,
      ).toBe("Appended default #1.\n");
      expect(
        (yield* runMemo(["append", "--log", "events"], {
          memoHome,
          standardInput: "second\nexact\n",
        })).standardOutput,
      ).toBe("Appended events #1.\n");
      const text = (yield* runMemo(["search", "--log", "default", "generic"], { memoHome }))
        .standardOutput;
      expect(text).toContain("default #1  ");
      expect(text).toContain("  first generic entry");
      expect(text).not.toContain("·");
      const compact = yield* jsonLines(
        (yield* runMemo(["search", "--log", "default", "generic", "--json"], { memoHome }))
          .standardOutput,
      );
      expect(compact[0]).toMatchObject({ id: 1, preview: "first generic entry" });
      expect(compact[0]).not.toHaveProperty("content");
      const full = yield* jsonLines(
        (yield* runMemo(["search", "--log", "events", "--full", "--json"], { memoHome }))
          .standardOutput,
      );
      expect(full[0]?.["content"]).toBe("second\nexact\n");
      const read = yield* jsonLines(
        (yield* runMemo(["read", "events", "1", "1", "--json"], { memoHome })).standardOutput,
      );
      expect(read.map((row) => row["content"])).toEqual(["second\nexact\n", "second\nexact\n"]);
      expect((yield* runMemo(["read"], { memoHome })).standardOutput).toBe(
        `There are 2 logs in \`${path.join(memoHome, "logs")}\`.\n\ndefault has 1 entry.\nevents has 1 entry.\n`,
      );
      expect(
        yield* jsonLines((yield* runMemo(["read", "--json"], { memoHome })).standardOutput),
      ).toEqual([
        { name: "default", directory: path.join(memoHome, "logs", "default"), entries: 1 },
        { name: "events", directory: path.join(memoHome, "logs", "events"), entries: 1 },
      ]);
      expect(
        yield* jsonLines(
          (yield* runMemo(["search", "--log", "default", "--json"], { memoHome })).standardOutput,
        ),
      ).not.toHaveLength(0);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const missingIDsAndLogsFailWithoutPartialStandardOutput = Task.make(
  "memo process: missing IDs produce exit 2, a missing log exit 1, and no partial stdout",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "--log", "default", "one"], { memoHome });
      const run = yield* runMemo(["read", "default", "1", "9"], { memoHome });
      expect(run.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(run.standardOutput).toBe("");
      expect(run.standardError).toBe(
        "error: default #9 doesn't exist, because default has only 1 entry\nhint: run `memo read default`\n",
      );
      const missingLog = yield* runMemo(["read", "nolog", "3"], { memoHome });
      expect(missingLog).toEqual(logNotFound("nolog", path.join(memoHome, "logs", "nolog")));
      const missingMany = yield* runMemo(["read", "default", "1", "8", "9"], { memoHome });
      expect(missingMany.standardError).toBe(
        "error: default #8 and default #9 don't exist, because default has only 1 entry\nhint: run `memo read default`\n",
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const noContent = (command: string, purpose: string) => ({
  code: INVALID_USAGE_EXIT_CODE,
  standardOutput: "",
  standardError: `error: memo ${command} got no content to ${purpose}\nhint: run \`memo ${command} --help\`\n`,
});

export const emptyTextIsRefusedEitherWayAndWhitespacePassesCheckAppendReadAndFTSSetup = Task.make(
  "memo process: empty text is refused as an argument and on stdin, and whitespace passes check, append, read, and FTS setup",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      for (const [command, purpose] of [
        ["check", "check"],
        ["append", "save"],
      ] as const) {
        const argv = [command, "--log", "default"];
        expect(yield* runMemo([...argv, ""], { memoHome })).toEqual(noContent(command, purpose));
        expect(yield* runMemo([...argv, ""], { memoHome, standardInput: "piped" })).toEqual(
          noContent(command, purpose),
        );
        expect(yield* runMemo(argv, { memoHome, standardInput: "" })).toEqual(
          noContent(command, purpose),
        );
        for (const asJson of [
          yield* runMemo([...argv, "--json", ""], { memoHome }),
          yield* runMemo([...argv, "--json"], { memoHome, standardInput: "" }),
        ]) {
          expect(asJson).toMatchObject({ code: INVALID_USAGE_EXIT_CODE, standardOutput: "" });
          expect(yield* jsonLines(asJson.standardError)).toEqual([
            {
              error: "InvalidInput",
              message: `memo ${command} got no content to ${purpose}`,
              hint: `run \`memo ${command} --help\``,
              command,
            },
          ]);
        }
      }
      expect(yield* exists(`${memoHome}/logs/default/entries.sqlite3`)).toBe(false);
      const missing = yield* runMemo(["append", "--log", "default"], { memoHome });
      expect(missing).toEqual(noContent("append", "save"));
      const twice = yield* runMemo(["append", "--log", "default", "argument"], {
        memoHome,
        standardInput: "piped",
      });
      expect(twice).toMatchObject({ code: 0, standardOutput: "Appended default #1.\n" });
      const checked = yield* runMemo(["check", "--log", "default", " \n\t"], { memoHome });
      expect(checked.code).toBe(0);
      expect(checked.standardOutput).toBe(
        "default has no hook, so memo append would save this content.\n",
      );
      expect((yield* runMemo(["append", "--log", "default", " \n\t"], { memoHome })).code).toBe(0);
      expect(
        (yield* runMemo(["append", "--log", "default"], { memoHome, standardInput: " " })).code,
      ).toBe(0);
      const rows = yield* jsonLines(
        (yield* runMemo(["read", "default", "1", "2", "3", "--json"], { memoHome })).standardOutput,
      );
      expect(rows.map((row) => row["content"])).toEqual(["argument", " \n\t", " "]);
      expect((yield* runMemo(["search", "--log", "default", "   "], { memoHome })).code).toBe(0);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aLeadingByteOrderMarkIsKeptFromAPipeAsFromAnArgument = Task.make(
  "memo process: a leading U+FEFF reaches the hook and the log the same way from stdin and from an argument",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const observed = path.join(memoHome, "observed");
      yield* installHook(
        memoHome,
        "bom",
        "01-capture",
        String.raw`const bytes = await Bun.stdin.bytes(); const { appendFileSync } = await import("node:fs"); appendFileSync(process.env.OBSERVED, Buffer.from(bytes).toString("hex") + "\n");`,
      );
      const content = "\uFEFFhello";
      const environment = { OBSERVED: observed };
      expect(
        (yield* runMemo(["append", "--log", "bom", content], { memoHome, environment })).code,
      ).toBe(0);
      expect(
        (yield* runMemo(["append", "--log", "bom"], {
          memoHome,
          environment,
          standardInput: content,
        })).code,
      ).toBe(0);
      const hex = Buffer.from(content).toString("hex");
      expect(yield* readFile(observed)).toBe(`${hex}\n${hex}\n`);
      const rows = yield* jsonLines(
        (yield* runMemo(["read", "bom", "1", "2", "--json"], { memoHome })).standardOutput,
      );
      expect(rows.map((row) => row["content"])).toEqual([content, content]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const TRUNCATED_EURO_SIGN = [...Uint8Array.fromHex("e282")];
const LONE_INVALID_BYTE = [...Uint8Array.fromHex("ff")];
const TRUNCATED_REPLACEMENT_CHARACTER = [...Uint8Array.fromHex("efbf")];
const encode = (text: string) => [...new TextEncoder().encode(text)];

const refusedAsInvalidUtf8 = (offset: number, command: string) =>
  `error: the content isn't valid UTF-8 at byte ${offset}\nhint: run \`memo ${command} --help\`\n`;

export const contentThatIsntValidUtf8IsRefused = Task.make(
  "memo process: content that isn't valid UTF-8 is refused with the byte where it goes wrong",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const keep = encode("keep");
      const replacement = encode("\uFFFD");
      for (const [bytes, offset] of [
        [[...keep, ...TRUNCATED_EURO_SIGN], keep.length],
        [TRUNCATED_EURO_SIGN, 0],
        [LONE_INVALID_BYTE, 0],
        [[...keep, ...LONE_INVALID_BYTE, ...keep], keep.length],
        [[...replacement, ...TRUNCATED_REPLACEMENT_CHARACTER, ...encode("A")], replacement.length],
      ] as const) {
        for (const command of ["append", "check"]) {
          expect(
            yield* runMemo([command, "--log", "default"], {
              memoHome,
              standardInput: new Uint8Array(bytes),
            }),
          ).toEqual({
            code: INVALID_USAGE_EXIT_CODE,
            standardOutput: "",
            standardError: refusedAsInvalidUtf8(offset, command),
          });
        }
      }
      expect(yield* runMemo(["append", "--log", "default", "keep\uFFFD"], { memoHome })).toEqual({
        code: INVALID_USAGE_EXIT_CODE,
        standardOutput: "",
        standardError: `error: the content isn't valid UTF-8 at byte ${keep.length}, or has U+FFFD there, which an argument can't carry; pass it on stdin to keep a U+FFFD\nhint: run \`memo append --help\`\n`,
      });
      expect(yield* exists(`${memoHome}/logs/default/entries.sqlite3`)).toBe(false);
      const valid = yield* runMemo(["append", "--log", "default", "--json"], {
        memoHome,
        standardInput: new Uint8Array([...keep, ...replacement]),
      });
      expect(valid.code).toBe(0);
      const rows = yield* jsonLines(
        (yield* runMemo(["read", "default", "1", "--json"], { memoHome })).standardOutput,
      );
      expect(rows.map((row) => row["content"])).toEqual(["keep\uFFFD"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const checkAndAppendRunIdenticalExecutableHooksBeforeStorage = Task.make(
  "memo process: check and append run the same hook command before storage",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }

      const memoHome = yield* makeTemporaryDirectory();
      const observed = path.join(memoHome, "observed");
      const order = path.join(memoHome, "order");
      yield* installHook(
        memoHome,
        "api",
        "01-capture",
        String.raw`const { OBSERVED, ORDER } = process.env; await Bun.write(OBSERVED, await Bun.stdin.text()); await Bun.write(ORDER, ((await Bun.file(ORDER).exists()) ? await Bun.file(ORDER).text() : "") + "checked:" + process.env.MEMO_LOG + "\n");`,
      );
      const content = "exact\nbytes\n";
      const environment = { OBSERVED: observed, ORDER: order };
      const checked = yield* runMemo(["check", "--log", "api"], {
        memoHome,
        environment,
        standardInput: content,
      });
      expect(checked.code).toBe(0);
      expect(yield* exists(path.join(memoHome, "logs", "api", "entries.sqlite3"))).toBe(false);
      expect(yield* readFile(observed)).toBe(content);
      const appended = yield* runMemo(["append", "--log", "api"], {
        memoHome,
        environment,
        standardInput: content,
      });
      expect(appended.code).toBe(0);
      expect(yield* readFile(order)).toBe("checked:api\nchecked:api\n");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aRejectingExecutableHookIsSafeAndDoesNotMaterializeItsLog = Task.make(
  "memo process: a rejecting hook command is safe and does not materialize its log",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }

      const memoHome = yield* makeTemporaryDirectory();
      yield* installHook(
        memoHome,
        "guarded",
        "01-reject",
        String.raw`await Bun.stdin.text(); console.error("\u001b[31mblocked by policy\u001b[0m"); process.exit(7);`,
      );
      const run = yield* runMemo(["append", "--log", "guarded", "candidate"], { memoHome });
      expect(run.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(run.standardError).toContain("blocked by policy");
      expect(run.standardError).not.toContain("\u001B");
      expect(yield* exists(path.join(memoHome, "logs", "guarded", "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aRejectingHookReportsItsWholeReason = Task.make(
  "memo process: a rejecting hook reports its whole stderr reason, not just the last line",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const hook = yield* installHook(
        memoHome,
        "work",
        "01-reject",
        String.raw`await Bun.stdin.text(); console.error("checking title\nchecking evidence\n\nmissing evidence section\n"); process.exit(1);`,
      );
      const checked = yield* runMemo(["check", "candidate", "--log", "work", "--json"], {
        memoHome,
      });
      expect(checked.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect((yield* jsonLines(checked.standardOutput))[0]).toMatchObject({
        checks: [
          {
            hook: ["bun", hook],
            ok: false,
            message: "checking title\nchecking evidence\n\nmissing evidence section",
          },
        ],
      });
      const logDirectory = path.join(memoHome, "logs", "json");
      yield* makeDirectory(logDirectory, { recursive: true });
      const jsonReason = [
        "sh",
        "-c",
        String.raw`printf '{\n  "reason": "missing tag"\n}\n' >&2; exit 7`,
      ] as const;
      yield* writeHookConfig(logDirectory, jsonReason);
      const reason = '{\n  "reason": "missing tag"\n}';
      const json = yield* runMemo(["check", "candidate", "--log", "json", "--json"], { memoHome });
      expect(json.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(yield* jsonLines(json.standardOutput)).toEqual([
        { log: "json", ok: false, checks: [{ hook: jsonReason, ok: false, message: reason }] },
      ]);
      expect(yield* runMemo(["append", "candidate", "--log", "json"], { memoHome })).toEqual({
        code: INVALID_USAGE_EXIT_CODE,
        standardOutput: "",
        standardError: `error: the hook for json rejected the entry:\n${reason}\n`,
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const anUncaughtHookCrashReportsItsErrorInsteadOfTheBunBanner = Task.make(
  "memo process: an uncaught hook crash reports its error instead of the Bun banner",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const hook = yield* installHook(
        memoHome,
        "work",
        "01-crash",
        'await Bun.stdin.text()\nthrow new Error("missing evidence section")\n',
      );
      const checked = yield* runMemo(["check", "candidate", "--log", "work", "--json"], {
        memoHome,
      });
      expect(checked.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect((yield* jsonLines(checked.standardOutput))[0]).toMatchObject({
        checks: [{ hook: ["bun", hook], ok: false, message: "missing evidence section" }],
      });
      const appended = yield* runMemo(["append", "candidate", "--log", "work"], { memoHome });
      expect(appended.standardError).toBe(
        "error: the hook for work rejected the entry: missing evidence section\n",
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aHookKilledByASignalIsNamedAndKeepsItsReason = Task.make(
  "memo process: a hook killed by a signal names the signal and keeps its stderr reason",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }

      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      yield* makeDirectory(logDirectory, { recursive: true });
      const hook = ["sh", "-c", "echo HOOK_STARTED >&2; kill -TERM $$"] as const;
      yield* writeHookConfig(logDirectory, hook);
      const checked = yield* runMemo(["check", "candidate", "--log", "work"], { memoHome });
      expect(checked).toMatchObject({
        code: INVALID_USAGE_EXIT_CODE,
        standardOutput: "",
        standardError: "error: the hook for work was killed by SIGTERM: HOOK_STARTED\n",
      });
      const json = yield* runMemo(["check", "candidate", "--log", "work", "--json"], { memoHome });
      expect(json.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(yield* jsonLines(json.standardOutput)).toEqual([
        {
          log: "work",
          ok: false,
          checks: [{ hook, ok: false, signal: "SIGTERM", message: "HOOK_STARTED" }],
        },
      ]);
      const silentHook = ["sh", "-c", "kill -KILL $$"] as const;
      yield* writeHookConfig(logDirectory, silentHook);
      const appended = yield* runMemo(["append", "candidate", "--log", "work"], { memoHome });
      expect(appended).toMatchObject({
        code: INVALID_USAGE_EXIT_CODE,
        standardError:
          "error: the hook for work was killed by SIGKILL and wrote no reason to stderr\n",
      });
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
      const silentJson = yield* runMemo(["check", "candidate", "--log", "work", "--json"], {
        memoHome,
      });
      expect((yield* jsonLines(silentJson.standardOutput))[0]).toMatchObject({
        checks: [
          {
            ok: false,
            signal: "SIGKILL",
            message: "the hook was killed by SIGKILL and wrote no reason to stderr",
          },
        ],
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const longHookReasonsAreCappedWithoutSplittingGraphemes = Task.make(
  "memo process: long hook reasons are capped without splitting graphemes",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      yield* installHook(
        memoHome,
        "work",
        "01-reject",
        'await Bun.stdin.text(); console.error("👩‍👩‍👧".repeat(250)); process.exit(1);',
      );
      const checked = yield* runMemo(["check", "candidate", "--log", "work", "--json"], {
        memoHome,
      });
      expect(checked.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect((yield* jsonLines(checked.standardOutput))[0]).toMatchObject({
        checks: [{ ok: false, message: `${"👩‍👩‍👧".repeat(TRUNCATED_REASON_GRAPHEMES)}…` }],
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const allLogSearchIsBoundedAndLabelsSources = Task.make(
  "memo process: all-log search is bounded and labels sources",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      yield* Effect.gen(function* () {
        yield* appendEntry(logName("alpha"), "2026-01-01T00:00:00.000Z", "shared alpha");
        yield* appendEntry(logName("zeta"), "2026-01-02T00:00:00.000Z", "shared zeta");
      }).pipe(Effect.provideContext(yield* buildTestServices(memoHome)));
      const rows = yield* jsonLines(
        (yield* runMemo(["search", "shared", "--full", "--limit", "1", "--json"], {
          memoHome,
        })).standardOutput,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["log"]).toBe("zeta");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const concurrentFirstAppendsConvergeWithoutLostIDs = Task.make(
  "memo process: concurrent first appends converge without lost IDs",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const runs = yield* Effect.all(
        Array.from({ length: CONCURRENT_APPENDS }, (_unused, index) =>
          runMemo(["append", "--log", "race", `entry ${index}`], { memoHome }),
        ),
        { concurrency: "unbounded" },
      );
      expect(runs.every((run) => run.code === 0)).toBe(true);
      const rows = yield* jsonLines(
        (yield* runMemo(["search", "--log", "race", "--full", "--json"], { memoHome }))
          .standardOutput,
      );
      expect(rows).toHaveLength(CONCURRENT_APPENDS);
      expect(new Set(rows.map((row) => row["id"])).size).toBe(CONCURRENT_APPENDS);
      const summary = yield* readDatabaseSummary(
        path.join(memoHome, "logs", "race", "entries.sqlite3"),
      );
      expect(summary.entryCount).toBe(CONCURRENT_APPENDS);
      expect(summary.indexedCount).toBe(CONCURRENT_APPENDS);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const openingALogRemovesItsLeftoverDraftName = Task.make(
  "memo process: memo removes a new log's leftover draft name before opening it, so macOS SQLite never sees the file lose a name",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const logDirectory = path.join(memoHome, "logs", "work");
      const file = path.join(logDirectory, "entries.sqlite3");
      const draft = `${file}.new-leftover`;
      yield* Effect.flatMap(FileSystem, (fileSystem) => fileSystem.link(file, draft));
      const read = yield* runMemo(["read", "work", "1", "--json"], { memoHome });
      expect(read).toMatchObject({ code: 0, standardError: "" });
      expect(yield* exists(draft)).toBe(false);
      expect(yield* exists(file)).toBe(true);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const repeatedConcurrentFirstAppendsNeverSeeTransientSidecars = Task.make(
  "memo process: repeated concurrent first appends never trip on transient sidecars",
  Effect.scoped(
    Effect.forEach(
      Array.from({ length: 10 }, (_unused, round) => round),
      (round) =>
        Effect.gen(function* () {
          const memoHome = yield* makeTemporaryDirectory();
          const runs = yield* Effect.all(
            Array.from({ length: CONCURRENT_APPENDS }, (_unused, index) =>
              runMemo(["append", "--log", "race", `round ${round} entry ${index}`], { memoHome }),
            ),
            { concurrency: "unbounded" },
          );
          expect(runs.filter((run) => run.code !== 0).map((run) => run.standardError)).toEqual([]);
        }),
      { discard: true },
    ),
  ),
  { timeout: "2 minutes", cleanup: "5 seconds" },
);

export const corruptStoresAndInvalidDataDirectoryPathsFailCleanly = Task.make(
  "memo process: corrupt stores and invalid data-directory paths fail cleanly",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const corruptHome = yield* makeTemporaryDirectory();
      yield* makeDirectory(path.join(corruptHome, "logs", "default"), { recursive: true });
      yield* writeFile(path.join(corruptHome, "logs", "default", "entries.sqlite3"), "not sqlite");
      yield* changeMode(
        path.join(corruptHome, "logs", "default", "entries.sqlite3"),
        OWNER_ONLY_FILE_MODE,
      );
      const corrupt = yield* runMemo(["search", "--log", "default"], { memoHome: corruptHome });
      expect(corrupt.code).toBe(1);
      expect(corrupt.standardOutput).toBe("");
      expect(corrupt.standardError).toBe(
        `error: ${path.join(corruptHome, "logs", "default", "entries.sqlite3")}: the log is damaged, and SQLite reports "file is not a database"\n${restoreHint("default", path.join(corruptHome, "logs", "default"))}`,
      );

      const fileHome = path.join(yield* makeTemporaryDirectory(), "not-a-directory");
      yield* writeFile(fileHome, "sentinel");
      const invalidDirectory = yield* runMemo(["append", "--log", "default", "candidate"], {
        memoHome: fileHome,
      });
      expect(invalidDirectory.code).toBe(1);
      expect(yield* readFile(fileHome)).toBe("sentinel");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const appendRefusesCanonicalSymlinksWithoutTouchingTargets = Task.make(
  "memo process: append refuses canonical symlinks without touching targets",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }

      const memoHome = yield* makeTemporaryDirectory();
      const target = path.join(yield* makeTemporaryDirectory(), "outside");
      yield* writeFile(target, "sentinel");
      yield* makeDirectory(path.join(memoHome, "logs", "default"), { recursive: true });
      yield* symlink(target, path.join(memoHome, "logs", "default", "entries.sqlite3"));
      const run = yield* runMemo(["append", "--log", "default", "candidate"], { memoHome });
      expect(run.code).toBe(1);
      expect(yield* readFile(target)).toBe("sentinel");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const connectionDurabilityPragmasAreActive = Task.make(
  "memo process: connection durability settings are active",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "--log", "default", "durable"], { memoHome });
      const summary = yield* readDatabaseSummary(
        path.join(memoHome, "logs", "default", "entries.sqlite3"),
      );
      expect(summary.journalMode).toBe("wal");
      expect(summary.entryCount).toBe(1);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aWriterFinishesAfterACompetingProcessAndWALKeepsReadsAvailable = Task.make(
  "memo process: a competing process's write lock refuses writers that don't wait, memo's writer finishes once it's released, and WAL keeps reads available",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "--log", "default", "seed"], { memoHome });
      const file = path.join(memoHome, "logs", "default", "entries.sqlite3");
      const { heldResult, competingWrite, writerResult } = yield* runWriterAgainstHeldWriteLock(
        file,
        {
          whileHeld: runMemo(["search", "--log", "default", "--full", "--json"], { memoHome }),
          writer: runMemo(["append", "--log", "default", "waited"], { memoHome }),
        },
      );

      expect(heldResult.code).toBe(0);
      expect((yield* jsonLines(heldResult.standardOutput)).map((row) => row["content"])).toEqual([
        "seed",
      ]);
      expect(competingWrite).toBe("LockTimeout");
      expect(writerResult.code).toBe(0);
      expect((yield* readRows(file)).map((row) => row.content)).toEqual([
        "seed",
        LOCK_HOLDER_CONTENT,
        "waited",
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const readsWorkAfterAnotherClientRemovesTheSidecars = Task.make(
  "memo process: reads work after another SQLite client closes the log and removes its -wal and -shm",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      yield* checkpointAndTruncateWal(file);
      yield* Effect.flatMap(FileSystem, (fileSystem) =>
        Effect.forEach(
          ["-wal", "-shm"],
          (suffix) => fileSystem.remove(file + suffix, { force: true }),
          {
            discard: true,
          },
        ),
      );
      for (const commandArguments of [
        ["read", "work", "1", "--json"],
        ["search", "seed", "--log", "work", "--full", "--json"],
      ]) {
        const result = yield* runMemo(commandArguments, { memoHome });
        expect(result).toMatchObject({ code: 0, standardError: "" });
        expect((yield* jsonLines(result.standardOutput)).map((row) => row["content"])).toEqual([
          "seed",
        ]);
      }
      for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
        if (yield* exists(sidecar)) {
          expect((yield* stat(sidecar)).mode & PERMISSION_BITS).toBe(OWNER_ONLY_FILE_MODE);
        }
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const dataOutsideMEMOHOMERemainsUntouchedAndUndiscovered = Task.make(
  "memo process: data outside MEMO_HOME remains untouched and undiscovered",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const legacy = yield* makeTemporaryDirectory();
      const oldFile = path.join(legacy, "log-default.sqlite3");
      yield* writeFile(oldFile, "unrelated product data");
      yield* runMemo(["append", "--log", "default", "isolated"], { memoHome });
      expect(yield* readFile(oldFile)).toBe("unrelated product data");
      expect(
        yield* jsonLines((yield* runMemo(["read", "--json"], { memoHome })).standardOutput),
      ).toEqual([
        { name: "default", directory: path.join(memoHome, "logs", "default"), entries: 1 },
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const databasePermissionsAreOwnerOnly = Task.make(
  "memo process: database permissions are owner-only",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }

      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "--log", "default", "private"], { memoHome });
      expect((yield* stat(memoHome)).mode & PERMISSION_BITS).toBe(OWNER_ONLY_DIRECTORY_MODE);
      expect(
        (yield* stat(path.join(memoHome, "logs", "default", "entries.sqlite3"))).mode &
          PERMISSION_BITS,
      ).toBe(OWNER_ONLY_FILE_MODE);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const hostileControlBytesAreInertInPreviewsAndExactThroughJSON = Task.make(
  "memo process: hostile control bytes are inert in previews, text they carry stays visible, and JSON stays exact",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const content = "\u001B[31mred\u001B]0;title\u0007";
      yield* runMemo(["append", "--log", "default", content], { memoHome });
      const compact = yield* runMemo(["search", "--log", "default"], { memoHome });
      expect(compact.standardOutput).not.toContain("\u001B");
      expect(compact.standardOutput).toContain("  red");
      const compactJson = yield* runMemo(["search", "--log", "default", "--json"], { memoHome });
      expect((yield* jsonLines(compactJson.standardOutput))[0]?.["preview"]).toBe(
        "red\u241B]0;title\u2407",
      );
      const read = yield* runMemo(["read", "default", "1"], { memoHome });
      expect(read.standardOutput).toContain("red\u241B]0;title\u2407");
      const titled = yield* runMemo(["search", "title", "--log", "default", "--json"], {
        memoHome,
      });
      expect(yield* jsonLines(titled.standardOutput)).toHaveLength(1);
      const full = yield* runMemo(["search", "--log", "default", "--full", "--json"], { memoHome });
      expect((yield* jsonLines(full.standardOutput))[0]?.["content"]).toBe(content);
      expect(full.standardOutput).not.toContain("\u001B");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const appendRequiresLog = Task.make(
  "memo process: append requires an explicit log",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const result = yield* runMemo(["append", "candidate"], { memoHome });
      expect(result.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(result.standardOutput).toBe("");
      expect(result.standardError).toContain("--log");
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const readBrowsesEntriesInIDOrder = Task.make(
  "memo process: read browses a positional log and preserves exact ID reads",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const directory = path.join(memoHome, "logs", "work");
      expect(yield* runMemo(["read", "work"], { memoHome })).toEqual(
        logNotFound("work", directory),
      );
      const missingAsJson = yield* runMemo(["read", "work", "--json"], { memoHome });
      expect(missingAsJson).toMatchObject({ code: 1, standardOutput: "" });
      expect(yield* jsonLines(missingAsJson.standardError)).toEqual([
        {
          error: "LogNotFound",
          message: "there's no log named work",
          hint: notFoundHint("work", directory),
          log: "work",
          directory,
        },
      ]);
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
      yield* Effect.forEach(
        Array.from({ length: ENTRIES_BEYOND_ONE_PAGE }, (_unused, offset) => offset + 1),
        (index) =>
          appendEntry(
            logName("work"),
            new Date(Date.UTC(ENTRY_YEAR, 0, ENTRIES_BEYOND_ONE_PAGE + 1 - index)).toISOString(),
            `Entry ${index}\nExact content.\n`,
          ),
        { discard: true },
      ).pipe(Effect.provideContext(yield* buildTestServices(memoHome)));
      const recent = yield* runMemo(["read", "work", "--json"], { memoHome });
      expect(recent.code).toBe(0);
      const [recentDetails, ...recentEntries] = yield* jsonLines(recent.standardOutput);
      expect(recentDetails).toMatchObject({
        name: "work",
        exists: true,
        entries: ENTRIES_BEYOND_ONE_PAGE,
      });
      expect(recent.standardError).toBe(
        `Showing #1 to #${DEFAULT_SEARCH_LIMIT} of ${ENTRIES_BEYOND_ONE_PAGE}. Run \`memo read work --offset ${DEFAULT_SEARCH_LIMIT} --json\` to see more.\n`,
      );
      expect(recentEntries.map((row) => row["id"])).toEqual(
        Array.from({ length: DEFAULT_SEARCH_LIMIT }, (_unused, index) => index + 1),
      );
      const exact = yield* runMemo(["read", "work", "2", "1", "--json"], { memoHome });
      expect(exact.code).toBe(0);
      expect((yield* jsonLines(exact.standardOutput)).map((row) => row["content"])).toEqual([
        "Entry 2\nExact content.\n",
        "Entry 1\nExact content.\n",
      ]);
      expect((yield* runMemo(["read", "--help"], { memoHome })).standardOutput).toContain(
        "--json             Print one JSON object per line. When you browse a log, the first line describes the log, and each other line is an entry. When you give entry IDs, each line is one of those entries.\n",
      );
      expect((yield* runMemo(["read", "../work"], { memoHome })).code).toBe(
        INVALID_USAGE_EXIT_CODE,
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const readWithoutLogListsLogs = Task.make(
  "memo process: read lists logs and rejects entry pagination without a log",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const result = yield* runMemo(["read"], { memoHome });
      expect(result.code).toBe(0);
      expect(result.standardOutput).toContain("There are no logs in ");
      for (const paging of [
        ["--limit", "1"],
        ["--limit", String(DEFAULT_SEARCH_LIMIT)],
        ["--offset", "1"],
        ["--offset", "0"],
      ]) {
        const rejected = yield* runMemo(["read", ...paging], { memoHome });
        expect(rejected.code).toBe(INVALID_USAGE_EXIT_CODE);
        expect(rejected.standardError).toBe(
          "error: memo read needs a log to use --limit or --offset\nhint: run `memo read --help`\n",
        );
      }
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const checkRequiresLog = Task.make(
  "memo process: check requires an explicit log",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const result = yield* runMemo(["check", "candidate"], { memoHome });
      expect(result.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(result.standardOutput).toBe("");
      expect(result.standardError).toContain("--log");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchDefaultsToAllLogs = Task.make(
  "memo process: search defaults to all logs without creating a store",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const result = yield* runMemo(["search", "query"], { memoHome });
      expect(result.code).toBe(0);
      expect(result.standardOutput).toBe(
        `There are no logs in \`${path.join(memoHome, "logs")}\` yet.\n\nRun \`memo append <content> --log <log>\` to create one.\n`,
      );
      expect(result.standardError).toBe("");
      expect((yield* runMemo(["search", "--json"], { memoHome })).standardOutput).toBe("");
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const chronologicalSearch = Task.make(
  "memo process: search selects newest matches before applying single-log and global limits",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* Effect.gen(function* () {
        yield* appendEntry(logName("alpha"), "2026-01-01T00:00:00.000Z", "token");
        yield* appendEntry(
          logName("alpha"),
          "2026-01-03T00:00:00.000Z",
          `token ${"filler ".repeat(LONG_ENTRY_WORD_REPEATS)}`,
        );
        yield* insertEntryOutOfDateOrder(
          path.join(memoHome, "logs", "alpha", "entries.sqlite3"),
          "2026-01-02T00:00:00.000Z",
          "token token",
        );
        yield* appendEntry(logName("beta"), "2026-01-03T00:00:00.000Z", "token beta");
        yield* appendEntry(
          logName("alpha"),
          "2026-01-03T00:00:00.000Z",
          `token ${"newer ".repeat(LONG_ENTRY_WORD_REPEATS)}`,
        );
      }).pipe(Effect.provideContext(yield* buildTestServices(memoHome)));
      for (const query of [[], ["token"]]) {
        const single = yield* runMemo(
          ["search", ...query, "--log", "alpha", "--limit", "2", "--json"],
          { memoHome },
        );
        expect(single.code).toBe(0);
        expect((yield* jsonLines(single.standardOutput)).map((row) => row["id"])).toEqual([
          NEWEST_ALPHA_ID,
          OLDER_SAME_DAY_ALPHA_ID,
        ]);
        const global = yield* runMemo(["search", ...query, "--limit", "3", "--json"], { memoHome });
        expect(global.code).toBe(0);
        expect(
          (yield* jsonLines(global.standardOutput)).map((row) => [row["log"], row["id"]]),
        ).toEqual([
          ["alpha", NEWEST_ALPHA_ID],
          ["alpha", OLDER_SAME_DAY_ALPHA_ID],
          ["beta", 1],
        ]);
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const booleanSwitchesPreserveOperands = Task.make(
  "memo process: boolean switches preserve numeric and boolean positional values",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      for (const content of ["1", "0", "true", "false"]) {
        const appended = yield* runMemo(["append", "--log", "true", "--json", content], {
          memoHome,
        });
        expect(appended.code).toBe(0);
      }
      const one = yield* runMemo(["read", "true", "--json", "1"], { memoHome });
      expect(one.code).toBe(0);
      expect((yield* jsonLines(one.standardOutput))[0]?.["content"]).toBe("1");
      const requestedIds = ["1", "2"];
      const two = yield* runMemo(["read", "true", "--json", ...requestedIds], { memoHome });
      expect(two.code).toBe(0);
      expect((yield* jsonLines(two.standardOutput)).map((row) => row["id"])).toEqual(
        requestedIds.map((id) => Number(id)),
      );
      for (const content of ["1", "0", "true", "false"]) {
        const found = yield* runMemo(["search", "--json", "--full", content], {
          memoHome,
        });
        expect(found.code).toBe(0);
        expect((yield* jsonLines(found.standardOutput)).map((row) => row["content"])).toEqual([
          content,
        ]);
      }
      const explicit = yield* runMemo(["read", "true", "--json=false", "1"], { memoHome });
      expect(explicit.code).toBe(0);
      expect(explicit.standardOutput).toContain("#1  ");
      const literal = yield* runMemo(["append", "--log", "true", "--", "--json"], { memoHome });
      expect(literal.code).toBe(0);
      const stored = yield* runMemo(["read", "true", "5", "--json"], { memoHome });
      expect((yield* jsonLines(stored.standardOutput))[0]?.["content"]).toBe("--json");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const logDetailsAndSetupHelp = Task.make(
  "memo process: a missing log is an error, a log folder without entries shows its details, and help explains setup",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const workDirectory = path.join(memoHome, "logs", "work");
      expect(yield* runMemo(["read", "work"], { memoHome })).toEqual(
        logNotFound("work", workDirectory),
      );
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
      const careersDirectory = path.join(memoHome, "logs", "careers");
      yield* runMemo(["append", "first", "--log", "career"], { memoHome });
      expect(yield* runMemo(["read", "careers"], { memoHome })).toEqual(
        logNotFound("careers", careersDirectory),
      );
      expect(yield* exists(careersDirectory)).toBe(false);
      const logs = path.join(memoHome, "logs");
      yield* changeMode(logs, UNLISTABLE_DIRECTORY_MODE);
      const unlistable = yield* runMemo(["read", "careers", "--json"], { memoHome });
      yield* changeMode(logs, OWNER_ONLY_DIRECTORY_MODE);
      expect(unlistable).toMatchObject({ code: 1, standardOutput: "" });
      expect(yield* jsonLines(unlistable.standardError)).toMatchObject([
        { error: "LogNotFound", log: "careers", directory: careersDirectory },
      ]);
      expect((yield* runMemo(["read", "../escape"], { memoHome })).code).toBe(
        INVALID_USAGE_EXIT_CODE,
      );
      expect((yield* runMemo(["path"], { memoHome })).code).toBe(INVALID_USAGE_EXIT_CODE);
      const help = yield* runMemo(["check", "--help"], { memoHome });
      for (const text of ["`config.json`", "stdin", "MEMO_LOG", "exiting 0", '"hook": ["bun",']) {
        expect(help.standardOutput).toContain(text);
      }
      const hook = yield* installHook(memoHome, "work", "01-accept", "process.exit(0)");
      expect(yield* runMemo(["read", "work"], { memoHome })).toEqual({
        code: 0,
        standardOutput: `work has no entries, and its hook is \`bun ${hook}\`.\nIts folder is \`${workDirectory}\`.\n\nRun \`memo append <content> --log work\` to add its first entry.\n`,
        standardError: "",
      });
      expect(yield* runMemo(["search", "--log", "work"], { memoHome })).toEqual({
        code: 0,
        standardOutput: "work has no entries.\n",
        standardError: "",
      });
      expect(
        yield* jsonLines((yield* runMemo(["read", "work", "--json"], { memoHome })).standardOutput),
      ).toEqual([
        {
          name: "work",
          directory: path.join(memoHome, "logs", "work"),
          exists: false,
          entries: 0,
          hook: ["bun", hook],
        },
      ]);
      const checked = yield* runMemo(["check", "--log", "work", "--json", "note"], { memoHome });
      expect((yield* jsonLines(checked.standardOutput))[0]).toMatchObject({
        checks: [{ hook: ["bun", hook], ok: true }],
      });
      expect(yield* exists(path.join(memoHome, "logs", "work", "entries.sqlite3"))).toBe(false);
      const append = yield* runMemo(["append", "--help"], { memoHome });
      expect(append.standardOutput).toContain("stdin");
      expect(append.standardOutput).toContain("JSON object");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const listsLogWithOnlyAHook = Task.make(
  "memo process: memo read and memo search without a log count a log folder that has only a hook, and skip a folder that has neither entries nor a hook",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const logs = path.join(memoHome, "logs");
      const workDirectory = path.join(logs, "work");
      yield* makeDirectory(workDirectory, { recursive: true });
      yield* writeHookConfig(workDirectory, ["true"]);
      yield* makeDirectory(path.join(logs, "notes.old"));
      expect(yield* runMemo(["read"], { memoHome })).toEqual({
        code: 0,
        standardOutput: `There's 1 log in \`${logs}\`.\n\nwork has no entries, and its hook is \`true\`.\n`,
        standardError: "",
      });
      expect(yield* runMemo(["search"], { memoHome })).toEqual({
        code: 0,
        standardOutput: "No log has entries yet.\n",
        standardError: "",
      });
      expect(yield* runMemo(["search", "anything"], { memoHome })).toEqual({
        code: 0,
        standardOutput: 'No entry matches "anything".\n',
        standardError: "",
      });
      yield* runMemo(["append", "first", "--log", "good"], { memoHome });
      expect(
        yield* jsonLines((yield* runMemo(["read", "--json"], { memoHome })).standardOutput),
      ).toEqual([
        { name: "good", directory: path.join(logs, "good"), entries: 1 },
        { name: "work", directory: workDirectory, entries: 0 },
      ]);
      expect(yield* exists(path.join(workDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchEmptyStates = Task.make(
  "memo process: empty searches explain human results and keep JSONL empty, and a missing log is an error",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const directory = path.join(memoHome, "logs", "work");
      expect(yield* runMemo(["search", "--log", "work"], { memoHome })).toEqual(
        logNotFound("work", directory),
      );
      const missingAsJson = yield* runMemo(["search", "absent", "--log", "work", "--json"], {
        memoHome,
      });
      expect(missingAsJson).toMatchObject({ code: 1, standardOutput: "" });
      expect(yield* jsonLines(missingAsJson.standardError)).toEqual([
        {
          error: "LogNotFound",
          message: "there's no log named work",
          hint: notFoundHint("work", directory),
          log: "work",
          directory,
        },
      ]);
      expect((yield* runMemo(["search"], { memoHome })).standardOutput).toStartWith(
        "There are no logs in ",
      );
      yield* runMemo(["append", "hello", "--log", "work"], { memoHome });
      for (const [scope, expected] of [
        [["--log", "work"], 'No entry in work matches "absent".\n'],
        [[], 'No entry matches "absent".\n'],
      ] as const) {
        const missing = yield* runMemo(["search", "absent", ...scope, "--full"], { memoHome });
        expect(missing.code).toBe(0);
        expect(missing.standardOutput).toBe(expected);
        expect(
          (yield* runMemo(["search", "absent", ...scope, "--json"], { memoHome })).standardOutput,
        ).toBe("");
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const parserOwnsHelpAndOperands = Task.make(
  "memo process: native parser handles help variants, errors, and literal flag operands",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = "relative";
      for (const commandArguments of [
        ["--help"],
        ["--help=true"],
        ["-h"],
        ["--version=true"],
        ["append", "--help"],
      ]) {
        const result = yield* runMemo(commandArguments, { memoHome });
        expect(result.code).toBe(0);
        expect(result.standardOutput.length).toBeGreaterThan(0);
        expect(result.standardError).toBe("");
      }
      for (const commandArguments of [
        ["--help=true", "nope"],
        ["--version=true", "nope"],
        ["nope", "--help"],
        ["--help", "--bogus"],
      ]) {
        const result = yield* runMemo(commandArguments, { memoHome });
        expect(result.code).toBe(INVALID_USAGE_EXIT_CODE);
        expect(result.standardOutput).toBe("");
        expect(result.standardError).toStartWith("error: ");
        expect(result.standardError).not.toContain("MEMO_HOME is");
      }
      const directory = yield* makeTemporaryDirectory();
      const appended = yield* runMemo(["append", "--log", "work", "--no-json", "1"], {
        memoHome: directory,
      });
      expect(appended.code).toBe(0);
      const literal = yield* runMemo(["append", "--log", "work", "--", "--help"], {
        memoHome: directory,
      });
      expect(literal.code).toBe(0);
      const read = yield* runMemo(["read", "work", "--json", "1", "2"], {
        memoHome: directory,
      });
      expect((yield* jsonLines(read.standardOutput)).map((row) => row["content"])).toEqual([
        "1",
        "--help",
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const repeatedFlagSaysItWasGivenMoreThanOnce = Task.make(
  "memo process: a flag given twice is named as repeated instead of as an invalid value",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      for (const [commandArguments, flag] of [
        [["append", "x", "--log", "a", "--log", "b"], "log"],
        [["search", "--limit", "2", "--limit", "3"], "limit"],
        [["search", "--full", "--full"], "full"],
        [["read", "work", "--offset", "1", "--offset", "2"], "offset"],
      ] as const) {
        const [command] = commandArguments;
        expect(yield* runMemo(commandArguments, { memoHome })).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: `error: --${flag} was given more than once, but memo takes it at most once\nhint: run \`memo ${command} --help\`\n`,
        });
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const bareMemoShowsHelpAndShortVersionFlag = Task.make(
  "memo process: memo with no command shows the same help as --help, and -v shows the same version as --version",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const help = yield* runMemo(["--help"], { memoHome });
      expect(help.standardOutput).toContain("Available Commands:");
      expect(yield* runMemo([], { memoHome })).toEqual(help);
      const version = yield* runMemo(["--version"], { memoHome });
      expect(version).toEqual({ code: 0, standardOutput: "memo v1.0.0\n", standardError: "" });
      expect(yield* runMemo(["-v"], { memoHome })).toEqual(version);
      expect(yield* exists(path.join(memoHome, "logs"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const unicodeSearchNormalization = Task.make(
  "memo process: canonical Unicode forms find the same stored entries",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const spellings = ["naïve", "naïve"];
      for (const content of spellings) {
        expect((yield* runMemo(["append", content, "--log", "work"], { memoHome })).code).toBe(0);
      }
      for (const query of ["naïve", "naïve"]) {
        const result = yield* runMemo(["search", query, "--log", "work", "--json"], { memoHome });
        expect(result.code).toBe(0);
        expect(yield* jsonLines(result.standardOutput)).toHaveLength(spellings.length);
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const FTS5_TOKEN_BYTES = 32_768;
const ENTRIES_PER_LONG_WORD = 3;
const LONG_WORD_ENDINGS = ["a", "b"] as const;

export const searchMatchesWordsPastTheFullTextTokenLimit = Task.make(
  "memo process: search matches whole words longer than SQLite's full-text token limit",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const prefix = "x".repeat(FTS5_TOKEN_BYTES);
      for (const word of LONG_WORD_ENDINGS.map((ending) => `${prefix}${ending}`)) {
        for (const index of Array.from({ length: ENTRIES_PER_LONG_WORD }, (_unused, at) => at)) {
          yield* runMemo(["append", `entry ${index} ${word}`, "--log", "work"], { memoHome });
        }
      }
      const idsFor = (query: string, extra: readonly string[] = []) =>
        Effect.gen(function* () {
          const result = yield* runMemo(["search", query, "--log", "work", "--json", ...extra], {
            memoHome,
          });
          expect(result.code).toBe(0);
          return {
            ids: (yield* jsonLines(result.standardOutput)).map((row) => row["id"]),
            footer: result.standardError,
          };
        });
      const newestFirst = (first: number) =>
        Array.from({ length: ENTRIES_PER_LONG_WORD }, (_unused, index) => first - index);
      const withA = newestFirst(ENTRIES_PER_LONG_WORD);
      const withB = newestFirst(ENTRIES_PER_LONG_WORD * LONG_WORD_ENDINGS.length);
      expect(yield* idsFor(`${prefix}a`)).toEqual({ ids: withA, footer: "" });
      expect(yield* idsFor(`${prefix.toUpperCase()}B`)).toEqual({ ids: withB, footer: "" });
      expect(yield* idsFor(`${prefix}c`)).toEqual({ ids: [], footer: "" });
      expect(yield* idsFor(prefix)).toEqual({ ids: [], footer: "" });
      expect(yield* idsFor(`entry ${prefix}a`)).toEqual({ ids: withA, footer: "" });
      const shown = ENTRIES_PER_LONG_WORD - 1;
      const limited = yield* idsFor(`${prefix}a`, ["--limit", String(shown)]);
      expect(limited.ids).toEqual(withA.slice(0, shown));
      expect(limited.footer).toStartWith(`Showing the ${shown} newest matches for `);
      expect((yield* idsFor("entry")).ids).toEqual([...withB, ...withA]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const safeHookDiagnostics = Task.make(
  "memo process: human hook diagnostics remove controls while JSON preserves names",
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") {
        return;
      }
      const memoHome = yield* makeTemporaryDirectory();
      const name = "01-[31mreject";
      const hook = yield* installHook(
        memoHome,
        "work",
        name,
        'await Bun.stdin.text(); console.error("denied"); process.exit(1);',
      );
      const rejected = yield* runMemo(["append", "candidate", "--log", "work"], { memoHome });
      expect(rejected.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(rejected.standardError).not.toContain("");
      expect(rejected.standardError).toContain("denied");
      const human = yield* runMemo(["check", "candidate", "--log", "work"], { memoHome });
      expect(human.standardError).toBe("error: the hook for work rejected the content: denied\n");
      const details = yield* runMemo(["read", "work"], { memoHome });
      expect(details.standardOutput).toContain("reject.ts");
      expect(details.standardOutput).not.toContain("\u001B");
      const checked = yield* runMemo(["check", "candidate", "--log", "work", "--json"], {
        memoHome,
      });
      expect(checked.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect((yield* jsonLines(checked.standardOutput))[0]).toMatchObject({
        checks: [{ hook: ["bun", hook] }],
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const typedFailureDebugDetails = Task.make(
  "memo process: debug mode explains typed SQLite failures",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      yield* makeDirectory(logDirectory, { recursive: true });
      const file = path.join(logDirectory, "entries.sqlite3");
      yield* writeFile(file, "not a database");
      yield* changeMode(file, OWNER_ONLY_FILE_MODE);
      const normal = yield* runMemo(["search", "--log", "work"], { memoHome });
      const debug = yield* runMemo(["search", "--log", "work"], {
        memoHome,
        environment: { MEMO_DEBUG: "1" },
      });
      expect(normal.code).toBe(1);
      expect(debug.code).toBe(1);
      expect(debug.standardError).toContain('SQLite reports "file is not a database"');
      expect(debug.standardError.length).toBeGreaterThan(normal.standardError.length);
      expect(debug.standardError).toContain("SqlError");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const unsafeSidecarsNeverChangeTargets = Task.make(
  "memo process: unsafe sidecars fail without touching their targets",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const memoHome = yield* makeTemporaryDirectory();
        const outside = path.join(yield* makeTemporaryDirectory(), "sentinel");
        yield* writeFile(outside, "untouched");
        yield* changeMode(outside, WORLD_READABLE_FILE_MODE);
        const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
        expect((yield* runMemo(["append", "seed", "--log", "work"], { memoHome })).code).toBe(0);
        yield* checkpointAndTruncateWal(file);
        yield* Effect.flatMap(FileSystem, (fileSystem) =>
          fileSystem.remove(file + suffix, { force: true }),
        );
        yield* symlink(outside, file + suffix);
        for (const commandArguments of [
          ["append", "candidate", "--log", "work"],
          ["search", "--log", "work"],
        ]) {
          const result = yield* runMemo(commandArguments, { memoHome });
          expect(result.code).toBe(1);
          expect(result.standardError).toContain(
            `${file + suffix}: memo expected a regular file but found a symlink`,
          );
          expect(yield* readFile(outside)).toBe("untouched");
          expect((yield* stat(outside)).mode & PERMISSION_BITS).toBe(WORLD_READABLE_FILE_MODE);
        }
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const unsafeStorageErrorsNameTheFaultyPath = Task.make(
  "memo process: storage errors name the faulty path and the reason",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const seeded = Effect.gen(function* () {
        const memoHome = yield* makeTemporaryDirectory();
        expect((yield* runMemo(["append", "seed", "--log", "work"], { memoHome })).code).toBe(0);
        return { memoHome, file: path.join(memoHome, "logs", "work", "entries.sqlite3") };
      });

      const fifo = yield* seeded;
      yield* Effect.flatMap(FileSystem, (fileSystem) =>
        fileSystem.remove(`${fifo.file}-journal`, { force: true }),
      );
      expect((yield* runProcess(["mkfifo", `${fifo.file}-journal`])).code).toBe(0);
      expect(
        (yield* runMemo(["append", "candidate", "--log", "work"], { memoHome: fifo.memoHome }))
          .standardError,
      ).toContain(`${fifo.file}-journal: memo expected a regular file but found a FIFO`);

      const shared = yield* seeded;
      yield* writeFile(`${shared.file}-wal`, "");
      yield* changeMode(`${shared.file}-wal`, WORLD_READABLE_FILE_MODE);
      expect(
        (yield* runMemo(["search", "--log", "work"], { memoHome: shared.memoHome })).standardError,
      ).toBe(
        `error: ${shared.file}-wal: the file has mode 0644, so other users can access it, and memo needs 0600\nhint: run \`chmod 600 ${shared.file}-wal\`\n`,
      );

      const locked = path.join(yield* makeTemporaryDirectory(), "home");
      yield* makeDirectory(path.join(locked, "logs"), { recursive: true });
      yield* changeMode(path.join(locked, "logs"), READ_ONLY_DIRECTORY_MODE);
      expect(
        (yield* runMemo(["append", "candidate", "--log", "work"], { memoHome: locked }))
          .standardError,
      ).toContain(
        `error: memo couldn't read or write its data folder: PermissionDenied: FileSystem.makeDirectory (${path.join(locked, "logs", "work")})`,
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aDatabasePathThatIsntAFileIsAStorageError = Task.make(
  "memo process: reads and searches report a database path that isn't a regular file instead of a missing log",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const variants = [
        ["a folder", (file: string) => makeDirectory(file)],
        ["a FIFO", (file: string) => Effect.asVoid(runProcess(["mkfifo", file]))],
        ["a symlink", (file: string) => symlink(`${file}.elsewhere`, file)],
      ] as const;
      for (const [found, replace] of variants) {
        const memoHome = yield* makeTemporaryDirectory();
        const logs = path.join(memoHome, "logs");
        for (const log of ["a", "work"]) {
          yield* runMemo(["append", "seed", "--log", log], { memoHome });
        }
        const file = path.join(logs, "a", "entries.sqlite3");
        yield* Effect.flatMap(FileSystem, (fileSystem) =>
          Effect.forEach(
            ["", "-wal", "-shm"],
            (suffix) => fileSystem.remove(file + suffix, { force: true }),
            { discard: true },
          ),
        );
        yield* replace(file);
        const storageError = `${file}: memo expected a regular file but found ${found}\n`;
        expect(yield* runMemo(["read"], { memoHome })).toEqual({
          code: 1,
          standardOutput: `There are 2 logs in \`${logs}\`.\n\nwork has 1 entry.\na can't be read.\n`,
          standardError: `error: ${storageError}`,
        });
        for (const commandArguments of [
          ["read", "a"],
          ["read", "a", "1"],
          ["search", "hi", "--log", "a"],
          ["append", "x", "--log", "a"],
        ]) {
          expect(yield* runMemo(commandArguments, { memoHome })).toEqual({
            code: 1,
            standardOutput: "",
            standardError: `error: ${storageError}`,
          });
        }
        expect(
          yield* locatedFailureAsText(yield* runMemo(["read", "a", "--json"], { memoHome })),
        ).toEqual({ code: 1, standardOutput: "", standardError: storageError });
        const listed = yield* runMemo(["read", "--json"], { memoHome });
        expect(listed.code).toBe(1);
        expect((yield* jsonLines(listed.standardOutput)).map((log) => log["name"])).toEqual([
          "work",
        ]);
        expect(yield* locatedFailureAsText({ ...listed, standardOutput: "" })).toMatchObject({
          standardError: storageError,
        });
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchFindsExactTextAndKeepsLanguageNamesApart = Task.make(
  "memo process: search finds any saved text by its exact words and keeps C#, C++ and C apart",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const exactTexts = ["\u0958\u0932\u092E", "alpha\uE000beta", "Café ❤️"];
      const entries = [
        "The C++ compiler segfaults.",
        "The C compiler succeeds.",
        "The C# service cannot start.",
        ...exactTexts,
      ];
      for (const content of entries) {
        yield* runMemo(["append", content, "--log", "work"], { memoHome });
      }
      const found = (query: string) =>
        Effect.flatMap(
          runMemo(["search", query, "--log", "work", "--full", "--json"], { memoHome }),
          (result) =>
            Effect.map(jsonLines(result.standardOutput), (rows) =>
              rows.map((row) => row["content"]),
            ),
        );
      expect(yield* found("C#")).toEqual(["The C# service cannot start."]);
      expect(yield* found("c++")).toEqual(["The C++ compiler segfaults."]);
      expect(yield* found("C compiler")).toEqual(["The C compiler succeeds."]);
      for (const content of exactTexts) {
        expect(yield* found(content)).toEqual([content]);
      }
      expect(yield* found("\u0915\u093C\u0932\u092E")).toEqual(["\u0958\u0932\u092E"]);
      expect(yield* found("cafe ❤")).toEqual(["Café ❤️"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchTreatsQuerySyntaxAsWords = Task.make(
  "memo process: search treats quotes, OR, NOT, *, : and parentheses as plain words, and an entry must have every word",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const fox = "The quick brown fox jumps over the lazy dog";
      const operators = "foxes are not dogs; NOT AND OR NEAR";
      const punctuation = 'he said "hello world" (really) foo* bar:baz';
      for (const content of [fox, operators, punctuation]) {
        yield* runMemo(["append", content, "--log", "work"], { memoHome });
      }
      const found = (query: string) =>
        Effect.flatMap(
          runMemo(["search", "--log", "work", "--json", "--", query], { memoHome }),
          (result) =>
            Effect.map(jsonLines(result.standardOutput), (rows) =>
              rows.map((row) => row["preview"]),
            ),
        );
      for (const [query, previews] of [
        ["quick fox", [fox]],
        ["fox cat", []],
        ['"brown quick"', [fox]],
        ["fox OR dog", []],
        ["NOT", [operators]],
        ["near", [operators]],
        ["foo*", [punctuation]],
        ["fo*", []],
        ["bar:baz", [punctuation]],
        ["baz", [punctuation]],
        ["(really)", [punctuation]],
        ["-fox", [fox]],
        ["...", []],
      ] as const) {
        expect(yield* found(query)).toEqual([...previews]);
      }
      expect(yield* runMemo(["search", "--log", "work", "..."], { memoHome })).toEqual({
        code: 0,
        standardOutput: '"..." has no words to search for.\n',
        standardError: "",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchPreviewsKeepTheWordsBeforeAMatch = Task.make(
  "memo process: a search preview keeps the words just before the match, so a negation isn't cut off",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const content = `${"Routine validation passed. ".repeat(BURYING_SENTENCE_REPEATS)}Do not deploy Atlas. ${"Background detail. ".repeat(BURYING_SENTENCE_REPEATS)}`;
      yield* runMemo(["append", "--log", "work"], { memoHome, standardInput: content });
      const result = yield* runMemo(["search", "deploy", "--json"], { memoHome });
      expect((yield* jsonLines(result.standardOutput))[0]?.["preview"]).toContain(
        "Do not deploy Atlas.",
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const appendReadsStandardInputFromWhereTheCallerLeftIt = Task.make(
  "memo process: append reads a file on stdin from where the caller left it, not from the start",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const input = path.join(memoHome, "input.txt");
      yield* writeFile(input, "Discarded scratch.\nThe decision.\n");
      const appended = yield* runMemo(["append", "--log", "work"], {
        memoHome,
        command: ["sh", "-c", '{ read -r line; exec "$0" "$@"; } < "$INPUT"', yield* compiledMemo],
        environment: { INPUT: input },
      });
      expect(appended.code).toBe(0);
      const read = yield* runMemo(["read", "work", "1", "--json"], { memoHome });
      expect((yield* jsonLines(read.standardOutput))[0]?.["content"]).toBe("The decision.\n");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchPreviewsStartAtTheSentenceOfTheMatch = Task.make(
  "memo process: a search preview starts at the sentence holding the match, so a long clause can't hide its negation",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const instruction =
        "Do not, even if the deployment dashboard shows all green checks and the canary metrics look healthy, approve production rollout.";
      yield* runMemo(
        ["append", `Week five review. ${instruction} Dana has final authority.`, "--log", "work"],
        {
          memoHome,
        },
      );
      const result = yield* runMemo(["search", "production rollout", "--json"], { memoHome });
      expect((yield* jsonLines(result.standardOutput))[0]?.["preview"]).toContain(instruction);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchPreviewsKeepTheQualificationAfterAMatch = Task.make(
  "memo process: a search preview starts at the match, so a qualification after it isn't cut off",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const qualification = "Rollout approved only in staging; production is NOT approved.";
      yield* runMemo(["append", "--log", "work"], {
        memoHome,
        standardInput: `${"Queue metrics were stable. ".repeat(BURYING_SENTENCE_REPEATS)}${qualification}`,
      });
      const result = yield* runMemo(["search", "approved", "--json"], { memoHome });
      expect((yield* jsonLines(result.standardOutput))[0]?.["preview"]).toContain(qualification);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchCallsAnEmptyDatabaseNotALog = Task.make(
  "memo process: searching an empty database file says it isn't a memo log, not that its index is outdated",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      yield* makeDirectory(path.dirname(file), { recursive: true });
      yield* writeFile(file, "");
      yield* changeMode(file, OWNER_ONLY_FILE_MODE);
      const result = yield* runMemo(["search", "anything", "--log", "work"], { memoHome });
      expect(result).toEqual({
        code: 1,
        standardOutput: "",
        standardError: `error: ${file}: the file isn't a memo log, because it has none of memo's tables\n${restoreHint("work", path.dirname(file))}`,
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const unreadableHookConfigIsAConfigFileError = Task.make(
  "memo process: a config.json memo can't read is a ConfigFile error naming the file",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const config = path.join(memoHome, "logs", "work", "config.json");
      yield* writeFile(config, '{ "hook": ["true"] }');
      yield* changeMode(config, UNREADABLE_FILE_MODE);
      const ignoresReadPermissions = yield* Effect.flatMap(FileSystem, (fileSystem) =>
        fileSystem.readFileString(config).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(false)),
        ),
      );
      if (ignoresReadPermissions) {
        return;
      }
      const result = yield* runMemo(["check", "candidate", "--log", "work", "--json"], {
        memoHome,
      }).pipe(Effect.onExit(() => changeMode(config, OWNER_ONLY_FILE_MODE)));
      expect(result.code).toBe(1);
      expect(yield* jsonLines(result.standardError)).toMatchObject([
        { error: "ConfigFile", file: config },
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchRebuildsAnIndexBuiltWithOlderWordRules = Task.make(
  "memo process: a search index built with older word rules is rebuilt with the current ones",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "Straße", "--log", "work"], { memoHome });
      yield* emptySearchIndexFromOlderWordRules(
        path.join(memoHome, "logs", "work", "entries.sqlite3"),
      );
      const result = yield* runMemo(["search", "STRASSE", "--log", "work", "--full", "--json"], {
        memoHome,
      });
      expect((yield* jsonLines(result.standardOutput)).map((row) => row["content"])).toEqual([
        "Straße",
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchNamesAnOlderReadOnlyLogsIndex = Task.make(
  "memo process: searching an older log memo can't write to says its search index needs one update",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { directory, file } = yield* legacyLog(["The C# service cannot start."]);
      const logDirectory = path.dirname(file);
      yield* changeMode(logDirectory, READ_ONLY_DIRECTORY_MODE);
      const [read, searched, appended] = yield* Effect.forEach(
        [
          ["read", "default", "1", "--json"],
          ["search", "service", "--log", "default", "--json"],
          ["append", "more", "--log", "default", "--json"],
        ],
        (commandArguments) => runMemo(commandArguments, { memoHome: directory }),
      ).pipe(Effect.onExit(() => changeMode(logDirectory, OWNER_ONLY_DIRECTORY_MODE)));
      expect(read?.code).toBe(0);
      for (const failed of [searched, appended]) {
        expect(failed?.code).toBe(1);
        expect(yield* jsonLines(failed?.standardError ?? "")).toMatchObject([
          { error: "OutdatedSearchIndex", log: "default", file },
        ]);
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchRebuildsAnOlderLogsIndexOnce = Task.make(
  "memo process: the first command on a log from an older memo rebuilds its search index once",
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, file } = yield* legacyLog([
        "The C# service cannot start.",
        "The C compiler succeeds.",
      ]);
      const searched = yield* runMemo(["search", "C#", "--log", "default", "--json"], {
        memoHome: directory,
      });
      expect(searched.code).toBe(0);
      expect((yield* jsonLines(searched.standardOutput)).map((row) => row["id"])).toEqual([1]);
      expect(yield* schemaNames(file)).not.toContain("entries_fts");
      expect(yield* schemaNames(file)).not.toContain("entries_after_insert");
      const appended = yield* runMemo(["append", "C# again", "--log", "default", "--json"], {
        memoHome: directory,
      });
      expect(appended.code).toBe(0);
      const again = yield* runMemo(["search", "C#", "--log", "default", "--full", "--json"], {
        memoHome: directory,
      });
      expect((yield* jsonLines(again.standardOutput)).map((row) => row["content"])).toEqual([
        "C# again",
        "The C# service cannot start.",
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchPreviewsStayFastWhenAQueryWordRepeats = Task.make(
  "memo process: a long entry that repeats a query word previews the passage with every query word",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const filler = "common ".repeat(REPEATED_QUERY_WORDS);
      yield* runMemo(["append", "--log", "work"], {
        memoHome,
        standardInput: `${filler}rare ${filler}`,
      });
      const result = yield* runMemo(["search", "common rare", "--json"], { memoHome });
      expect(result.code).toBe(0);
      expect((yield* jsonLines(result.standardOutput))[0]?.["preview"]).toContain("rare");
    }),
  ),
  { timeout: "30 seconds", cleanup: "5 seconds" },
);

export const searchPreviewsShowBuriedMatches = Task.make(
  "memo process: search previews show buried matches and full reads stay exact",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const content = `Opening paragraph.\n\n${"Unrelated background. ".repeat(
        BURYING_SENTENCE_REPEATS,
      )}\n\nDreamBook helped a founder ship.\n${"Later details. ".repeat(BURYING_SENTENCE_REPEATS)}`;
      yield* runMemo(["append", "--log", "work"], { memoHome, standardInput: content });
      const result = yield* runMemo(["search", "DreamBook", "--json"], { memoHome });
      expect(result.code).toBe(0);
      expect((yield* jsonLines(result.standardOutput))[0]?.["preview"]).toContain(
        "DreamBook helped a founder ship.",
      );
      expect((yield* jsonLines(result.standardOutput))[0]?.["preview"]).not.toContain(
        "Opening paragraph",
      );
      const full = yield* runMemo(["search", "DreamBook", "--full", "--json"], { memoHome });
      expect((yield* jsonLines(full.standardOutput))[0]?.["content"]).toBe(content);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const browsingPagesExposeLaterEntries = Task.make(
  "memo process: browsing pages expose later entries without polluting JSONL",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      yield* Effect.forEach(
        Array.from({ length: BROWSED_ENTRY_COUNT }, (_unused, index) => index + 1),
        (id) => appendEntry(logName("work"), "2026-01-01T00:00:00.000Z", `entry ${id}`),
      ).pipe(Effect.provideContext(yield* buildTestServices(memoHome)));
      const first = yield* runMemo(["read", "work", "--limit", "2", "--json"], { memoHome });
      expect(first.code).toBe(0);
      expect((yield* jsonLines(first.standardOutput)).map((row) => row["id"])).toEqual([
        undefined,
        1,
        BROWSE_PAGE_SIZE,
      ]);
      expect(first.standardError).toBe(
        "Showing #1 to #2 of 3. Run `memo read work --offset 2 --limit 2 --json` to see more.\n",
      );
      const last = yield* runMemo(["read", "work", "--limit", "2", "--offset", "2", "--json"], {
        memoHome,
      });
      expect((yield* jsonLines(last.standardOutput)).map((row) => row["id"])).toEqual([
        undefined,
        BROWSED_ENTRY_COUNT,
      ]);
      expect(last.standardError).toBe("");
      const human = yield* runMemo(["read", "work", "--limit", "2"], { memoHome });
      expect(human.standardOutput).toEndWith(
        "\n\nShowing #1 to #2 of 3. Run `memo read work --offset 2 --limit 2` to see more.\n",
      );
      expect(
        (yield* runMemo(["read", "work", "--limit", "2", "--offset", "2"], { memoHome }))
          .standardOutput,
      ).toEndWith("\n\nShowing #3 of 3.\n");
      expect(
        (yield* runMemo(["read", "work", "--offset", "3"], { memoHome })).standardOutput,
      ).toEndWith("\n\nwork has no entries after #3.\n");
      expect((yield* runMemo(["read", "work", "--offset", "-1"], { memoHome })).code).toBe(
        INVALID_USAGE_EXIT_CODE,
      );
      for (const paging of [
        ["--limit", "1"],
        ["--limit", String(DEFAULT_SEARCH_LIMIT)],
        ["--offset", "1"],
        ["--offset", "0"],
      ]) {
        const rejected = yield* runMemo(["read", "work", "1", ...paging], { memoHome });
        expect(rejected.code).toBe(INVALID_USAGE_EXIT_CODE);
        expect(rejected.standardError).toBe(
          "error: memo read can't use --limit or --offset with entry IDs\nhint: run `memo read --help`\n",
        );
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const unreadableEntriesFailWithOneDiagnosticLine = Task.make(
  "memo process: entries that do not match the entry schema exit 1 with one diagnostic line",
  Effect.scoped(
    Effect.gen(function* () {
      const unreadable = yield* foreignLog(UNTYPED_TABLE, [{ id: 1, content: 42 }]);
      const read = yield* runMemo(["read", "default", "1"], { memoHome: unreadable.directory });
      expect(read.code).toBe(1);
      expect(read.standardOutput).toBe("");
      expect(read.standardError).toBe(
        `error: ${unreadable.file}: default #1 has an invalid content field\n`,
      );

      const textKey = yield* foreignLog(
        "CREATE TABLE entries (id TEXT PRIMARY KEY, datetime TEXT, content TEXT)",
        [],
      );
      const append = yield* runMemo(["append", "--log", "default", "candidate"], {
        memoHome: textKey.directory,
      });
      expect(append.code).toBe(1);
      expect(append.standardOutput).toBe("");
      expect(append.standardError).toBe(
        `error: ${textKey.file}: the inserted entry has an invalid id field, so no entry was stored\n`,
      );
      expect((yield* readDatabaseSummary(textKey.file)).entryCount).toBe(0);

      const debug = yield* runMemo(["read", "default", "1"], {
        memoHome: unreadable.directory,
        environment: { MEMO_DEBUG: "1" },
      });
      expect(debug.code).toBe(1);
      expect(debug.standardError).toContain("[cause]: SchemaError: Expected string");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchFootersOfferMoreResults = Task.make(
  "memo process: search says when it shows only the newest results and how to see more",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      yield* Effect.forEach(
        Array.from({ length: BROWSED_ENTRY_COUNT }, (_unused, index) => index + 1),
        (id) => appendEntry(logName("work"), "2026-01-01T00:00:00.000Z", `shared note ${id}`),
        { discard: true },
      ).pipe(Effect.provideContext(yield* buildTestServices(memoHome)));
      const limit = String(BROWSE_PAGE_SIZE);
      const human = yield* runMemo(["search", "shared note", "--limit", limit], { memoHome });
      expect(human.standardOutput).toEndWith(
        "\n\nShowing the 2 newest matches for \"shared note\". Run `memo search --limit 4 'shared note'` to see more.\n",
      );
      const json = yield* runMemo(
        ["search", "--log", "work", "--full", "--limit", limit, "--json"],
        { memoHome },
      );
      expect(yield* jsonLines(json.standardOutput)).toHaveLength(BROWSE_PAGE_SIZE);
      expect(json.standardError).toBe(
        "Showing the 2 newest entries in work. Run `memo search --log work --full --limit 4 --json` to see more.\n",
      );
      const everything = yield* runMemo(["search", "--limit", String(BROWSED_ENTRY_COUNT)], {
        memoHome,
      });
      expect(everything.standardOutput).not.toContain("Showing");
      const crowded = yield* foreignLog(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, datetime TEXT, content TEXT)",
        Array.from({ length: MAX_SEARCH_LIMIT + 1 }, (_unused, index) => ({
          id: index + 1,
          content: "bulk",
        })),
      );
      const capped = yield* runMemo(["search", "bulk", "--limit", String(MAX_SEARCH_LIMIT)], {
        memoHome: crowded.directory,
      });
      expect(capped.standardOutput).toEndWith(
        `\n\nShowing the ${MAX_SEARCH_LIMIT} newest matches for "bulk", the most memo search shows. To narrow the search, add words to the query or use --log.\n`,
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const inputErrorsNameTheValueAndGiveAHint = Task.make(
  "memo process: input errors name the value and give a hint",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const tooManyIds = Array.from({ length: MAX_SEARCH_LIMIT + 1 }, () => "1");
      for (const [commandArguments, expected] of [
        [
          ["append", "hi", "--log", "Work"],
          'error: "Work" isn\'t a valid log name, because a log name has 1 to 64 lowercase letters, digits, dots, underscores or hyphens, and starts and ends with a letter or digit\nhint: run `memo append --help`\n',
        ],
        [
          ["read", "work", "0"],
          "error: 0 isn't a valid entry ID, because IDs start at 1\nhint: run `memo read --help`\n",
        ],
        [
          ["read", "work", ...tooManyIds],
          `error: memo read can show at most ${MAX_SEARCH_LIMIT} entries at once, not ${MAX_SEARCH_LIMIT + 1}\nhint: run \`memo read --help\`\n`,
        ],
        [
          ["read", "work", "--limit", "0"],
          `error: --limit is 0, but it must be from 1 to ${MAX_SEARCH_LIMIT}\nhint: run \`memo read --help\`\n`,
        ],
        [
          ["search", "--limit", "5000"],
          `error: --limit is 5000, but it must be from 1 to ${MAX_SEARCH_LIMIT}\nhint: run \`memo search --help\`\n`,
        ],
        [
          ["read", "work", "--offset", "-1"],
          "error: --offset is -1, but it must be 0 or more\nhint: run `memo read --help`\n",
        ],
        [
          ["read", "work", "2.9999999999999999"],
          'error: "2.9999999999999999" isn\'t a valid value for <id>\nhint: run `memo read --help`\n',
        ],
        [
          ["read", "work", "--limit", "2.9999999999999999"],
          'error: "2.9999999999999999" isn\'t a valid value for --limit\nhint: run `memo read --help`\n',
        ],
        [
          ["read", "work", "--offset", "0.0000000000000001"],
          'error: "0.0000000000000001" isn\'t a valid value for --offset\nhint: run `memo read --help`\n',
        ],
        [
          ["search", "--limit", "1.0"],
          'error: "1.0" isn\'t a valid value for --limit\nhint: run `memo search --help`\n',
        ],
      ] as const) {
        const result = yield* runMemo(commandArguments, { memoHome });
        expect(result.code).toBe(INVALID_USAGE_EXIT_CODE);
        expect(result.standardError).toBe(expected);
      }
      const relative = yield* runMemo(["read"], { memoHome: "relative/path" });
      expect(relative.code).toBe(1);
      expect(relative.standardError).toBe(
        "error: MEMO_HOME is `relative/path`, but it must be an absolute path\n",
      );
      for (const blank of ["", " "]) {
        expect(yield* runMemo(["read"], { memoHome: blank })).toEqual({
          code: 1,
          standardOutput: "",
          standardError: "error: MEMO_HOME is blank, but it must be an absolute path\n",
        });
      }
      const homeless = yield* runMemo(["read"], {
        memoHome: undefined,
        environment: { HOME: "", USERPROFILE: "" },
      });
      expect(homeless.code).toBe(1);
      expect(homeless.standardError).toBe(
        "error: memo can't find its data folder, because MEMO_HOME and HOME are unset or blank\nhint: set MEMO_HOME to an absolute path\n",
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const jsonFailuresAreOneObjectOnStandardError = Task.make(
  "memo process: with --json, a failure is one JSON object on stderr and the exit code is unchanged",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const guarded = path.join(memoHome, "logs", "guarded");
      yield* makeDirectory(guarded, { recursive: true });
      yield* writeHookConfig(guarded, ["sh", "-c", "echo missing tag >&2; exit 1"]);
      for (const [commandArguments, code, expected] of [
        [
          ["search", "--json", "--limit", "x"],
          INVALID_USAGE_EXIT_CODE,
          {
            error: "InvalidValue",
            message: '"x" isn\'t a valid value for --limit',
            hint: "run `memo search --help`",
          },
        ],
        [
          ["read", "missing", "1", "--json"],
          1,
          {
            error: "LogNotFound",
            message: "there's no log named missing",
            hint: notFoundHint("missing", path.join(memoHome, "logs", "missing")),
            log: "missing",
            directory: path.join(memoHome, "logs", "missing"),
          },
        ],
        [
          ["read", "work", String(MISSING_ENTRY_ID), "--json=true"],
          INVALID_USAGE_EXIT_CODE,
          {
            error: "EntriesNotFound",
            message: `work #${MISSING_ENTRY_ID} doesn't exist, because work has only 1 entry`,
            hint: "run `memo read work`",
            log: "work",
            ids: [MISSING_ENTRY_ID],
            entries: 1,
          },
        ],
        [
          ["append", "candidate", "--log", "guarded", "--json"],
          INVALID_USAGE_EXIT_CODE,
          {
            error: "HookRejected",
            message: "the hook for guarded rejected the entry: missing tag",
            log: "guarded",
            subject: "entry",
            reason: "missing tag",
          },
        ],
      ] as const) {
        const result = yield* runMemo(commandArguments, { memoHome });
        expect(result.code).toBe(code);
        expect(result.standardOutput).toBe("");
        expect(result.standardError).toEndWith("\n");
        expect(yield* jsonLines(result.standardError)).toEqual([expected]);
      }
      const relative = yield* runMemo(["read", "--json"], { memoHome: "relative/path" });
      expect(relative.code).toBe(1);
      expect(yield* jsonLines(relative.standardError)).toEqual([
        {
          error: "Configuration",
          message: "MEMO_HOME is `relative/path`, but it must be an absolute path",
        },
      ]);
      const empty = yield* runMemo(["read", "--json"], { memoHome: "" });
      expect(empty.code).toBe(1);
      expect(yield* jsonLines(empty.standardError)).toEqual([
        { error: "Configuration", message: "MEMO_HOME is blank, but it must be an absolute path" },
      ]);
      const checked = yield* runMemo(["check", "candidate", "--log", "guarded", "--json"], {
        memoHome,
      });
      expect(checked.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(checked.standardError).toBe("");
      expect(yield* jsonLines(checked.standardOutput)).toMatchObject([{ ok: false }]);
      for (const [flags, isJson] of [
        [["--json", "--json=false"], true],
        [["--json=false", "--json"], false],
      ] as const) {
        const repeated = yield* runMemo(["check", "candidate", "--log", "fresh", ...flags], {
          memoHome,
        });
        expect(repeated.code).toBe(INVALID_USAGE_EXIT_CODE);
        expect(repeated.standardOutput).toBe("");
        expect(repeated.standardError.startsWith("{")).toBe(isJson);
        expect(repeated.standardError).toContain(
          "--json was given more than once, but memo takes it at most once",
        );
      }
      for (const commandArguments of [
        ["search", "--json=false", "--limit", "x"],
        ["search", "--limit", "x", "--", "--json"],
      ]) {
        expect(yield* runMemo(commandArguments, { memoHome })).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError:
            'error: "x" isn\'t a valid value for --limit\nhint: run `memo search --help`\n',
        });
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const pathsInTheHomeDirectoryUseATilde = Task.make(
  "memo process: paths in the home directory start with ~ and stay runnable in hints",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeTemporaryDirectory();
      const memoHome = path.join(home, "Application Support", "Memo");
      const environment = { HOME: home };
      expect((yield* runMemo(["read"], { memoHome, environment })).standardOutput).toBe(
        "There are no logs in `~/Application Support/Memo/logs` yet.\n\nRun `memo append <content> --log <log>` to create one.\n",
      );
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome, environment });
      expect((yield* runMemo(["read", "work"], { memoHome, environment })).standardOutput).toMatch(
        /^work has 1 entry\.\nIts folder is `~\/Application Support\/Memo\/logs\/work`\.\n\n#1 {2}\d{4}-\d\d-\d\d \d\d:\d\d\n {2}seed\n$/u,
      );
      yield* changeMode(
        path.join(memoHome, "logs", "work", "entries.sqlite3"),
        WORLD_READABLE_FILE_MODE,
      );
      expect((yield* runMemo(["read", "work"], { memoHome, environment })).standardError).toBe(
        "error: ~/Application Support/Memo/logs/work/entries.sqlite3: the file has mode 0644, so other users can access it, and memo needs 0600\nhint: run `chmod 600 ~/'Application Support/Memo/logs/work/entries.sqlite3'`\n",
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const commandsOverEveryLogReportDamagedLogsAndShowTheRest = Task.make(
  "memo process: memo read and memo search without a log show the readable logs, report each damaged one, and exit 1",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem;
      const memoHome = yield* makeTemporaryDirectory();
      const logs = path.join(memoHome, "logs");
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const junk = path.join(logs, "junk", "entries.sqlite3");
      yield* makeDirectory(path.dirname(junk));
      yield* writeFile(junk, "not a database ".repeat(JUNK_DATABASE_REPEATS));
      yield* changeMode(junk, OWNER_ONLY_FILE_MODE);
      const cut = path.join(logs, "cut", "entries.sqlite3");
      yield* Effect.forEach(
        Array.from({ length: TRUNCATED_LOG_ENTRIES }, (_unused, index) => index),
        (index) =>
          appendEntry(
            logName("cut"),
            "2026-01-01T00:00:00.000Z",
            `seed ${index} ${"filler ".repeat(TRUNCATED_LOG_FILLER_WORDS)}`,
          ),
        { discard: true },
      ).pipe(Effect.provideContext(yield* buildTestServices(memoHome)));
      yield* checkpointAndTruncateWal(cut);
      yield* Effect.forEach(["-wal", "-shm"], (suffix) =>
        fileSystem.remove(cut + suffix, { force: true }),
      );
      const whole = yield* fileSystem.readFile(cut);
      yield* fileSystem.writeFile(cut, whole.subarray(0, whole.length / HALF));
      const damagedCut = `error: ${cut}: the log is damaged, and SQLite reports "database disk image is malformed"\n${restoreHint("cut", path.dirname(cut))}`;
      const damagedJunk = `error: ${junk}: the log is damaged, and SQLite reports "file is not a database"\n${restoreHint("junk", path.dirname(junk))}`;
      for (const [log, standardError] of [
        ["cut", damagedCut],
        ["junk", damagedJunk],
      ] as const) {
        expect(yield* runMemo(["read", log], { memoHome })).toEqual({
          code: 1,
          standardOutput: "",
          standardError,
        });
      }
      expect(yield* runMemo(["read"], { memoHome })).toEqual({
        code: 1,
        standardOutput: `There are 3 logs in \`${logs}\`.\n\nwork has 1 entry.\ncut can't be read.\njunk can't be read.\n`,
        standardError: `${damagedCut}${damagedJunk}`,
      });
      const searched = yield* runMemo(["search", "seed"], { memoHome });
      expect(searched).toMatchObject({ code: 1, standardError: `${damagedCut}${damagedJunk}` });
      expect(searched.standardOutput).toMatch(/^work #1 {2}.+\n {2}seed\n$/u);
      for (const commandArguments of [
        ["read", "--json"],
        ["search", "seed", "--json"],
      ]) {
        const result = yield* runMemo(commandArguments, { memoHome });
        expect(result.code).toBe(1);
        expect(
          (yield* jsonLines(result.standardOutput)).map((line) => line["log"] ?? line["name"]),
        ).toEqual(["work"]);
        expect(yield* jsonLines(result.standardError)).toMatchObject([
          {
            error: "DamagedLog",
            message: `${cut}: the log is damaged, and SQLite reports "database disk image is malformed"`,
            hint: restoreHintText("cut", path.dirname(cut)),
            file: cut,
            log: "cut",
          },
          {
            error: "DamagedLog",
            message: `${junk}: the log is damaged, and SQLite reports "file is not a database"`,
            hint: restoreHintText("junk", path.dirname(junk)),
            file: junk,
            log: "junk",
          },
        ]);
      }
      expect((yield* runMemo(["read", "work"], { memoHome })).code).toBe(0);
      expect((yield* runMemo(["search", "seed", "--log", "work"], { memoHome })).code).toBe(0);
      yield* fileSystem.rename(path.dirname(junk), path.join(memoHome, "junk-backup"));
      expect(yield* runMemo(["read", "junk"], { memoHome })).toEqual(
        logNotFound("junk", path.dirname(junk)),
      );
      expect((yield* runMemo(["append", "again", "--log", "junk"], { memoHome })).code).toBe(0);
      expect(yield* runMemo(["search", "again"], { memoHome })).toMatchObject({
        code: 1,
        standardError: damagedCut,
      });
      yield* runMemo(["append", "seed again", "--log", "work"], { memoHome });
      const paged = yield* runMemo(["search", "seed", "--limit", "1", "--json"], { memoHome });
      expect(paged.code).toBe(1);
      expect(yield* jsonLines(paged.standardOutput)).toMatchObject([{ log: "work" }]);
      expect(yield* jsonLines(paged.standardError)).toMatchObject([
        { error: "DamagedLog", log: "cut" },
      ]);
      const pagedForPeople = yield* runMemo(["search", "seed", "--limit", "1"], { memoHome });
      expect(pagedForPeople.standardOutput).toContain("Showing the 1 newest matches");
      expect(pagedForPeople.standardError).toBe(damagedCut);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const followingTheDamagedLogHintKeepsEntriesThatWereStillInTheWal = Task.make(
  "memo process: moving a damaged log's folder aside, as the hint says, keeps entries still in its WAL and starts the log over",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem;
      if (process.platform === "win32") {
        return;
      }
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "first", "--log", "work"], { memoHome });
      const logDirectory = path.join(memoHome, "logs", "work");
      const file = path.join(logDirectory, "entries.sqlite3");
      const backup = path.join(memoHome, "work-backup");
      yield* whileWalHoldsCommittedStatements(
        file,
        [
          "INSERT INTO entries (datetime, content) VALUES ('2026-01-01T00:00:00.000Z', 'only in the wal')",
          `DROP TABLE ${SEARCH_INDEX_TABLE}`,
        ],
        Effect.gen(function* () {
          expect(yield* exists(`${file}-wal`)).toBe(true);
          const searched = yield* runMemo(["search", "first", "--log", "work"], { memoHome });
          expect(searched).toEqual({
            code: 1,
            standardOutput: "",
            standardError: `error: ${file}: the log is damaged, because its database has no ${SEARCH_INDEX_TABLE} table\n${restoreHint("work", logDirectory)}`,
          });
          yield* fileSystem.rename(logDirectory, backup);
          expect((yield* runMemo(["append", "again", "--log", "work"], { memoHome })).code).toBe(0);
          expect((yield* runMemo(["search", "again", "--log", "work"], { memoHome })).code).toBe(0);
        }),
      );
      expect(
        (yield* readRows(path.join(backup, "entries.sqlite3"))).map((row) => row.content),
      ).toEqual(["first", "only in the wal"]);
      expect((yield* readRows(file)).map((row) => row.content)).toEqual(["again"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const emptyLogsSayTheyHaveNoEntries = Task.make(
  "memo process: a log whose database has no entries says so",
  Effect.scoped(
    Effect.gen(function* () {
      const empty = yield* foreignLog(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, datetime TEXT, content TEXT)",
        [],
      );
      const read = yield* runMemo(["read", "default"], { memoHome: empty.directory });
      expect(read.standardOutput).toStartWith("default has no entries.\n");
      expect(read.standardOutput).not.toContain("Showing");
      const searched = yield* runMemo(["search", "--log", "default"], {
        memoHome: empty.directory,
      });
      expect(searched.standardOutput).toBe("default has no entries.\n");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const readsAndSearchesWorkInAReadOnlyLogDirectory = Task.make(
  "memo process: read and search open a log in a read-only folder without writing to it",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      for (const removesSidecars of [true, false]) {
        const memoHome = yield* makeTemporaryDirectory();
        expect((yield* runMemo(["append", "seed", "--log", "work"], { memoHome })).code).toBe(0);
        const logDirectory = path.join(memoHome, "logs", "work");
        const file = path.join(logDirectory, "entries.sqlite3");
        if (removesSidecars) {
          yield* checkpointAndTruncateWal(file);
          yield* Effect.flatMap(FileSystem, (fileSystem) =>
            Effect.forEach(
              ["-wal", "-shm"],
              (suffix) => fileSystem.remove(file + suffix, { force: true }),
              {
                discard: true,
              },
            ),
          );
        }
        const hadWal = yield* exists(`${file}-wal`);
        yield* changeMode(logDirectory, READ_ONLY_DIRECTORY_MODE);
        const runs = yield* Effect.forEach(
          [
            ["read", "work", "1", "--json"],
            ["search", "seed", "--log", "work", "--full", "--json"],
            ["search", "seed", "--full", "--json"],
          ],
          (commandArguments) => runMemo(commandArguments, { memoHome }),
        ).pipe(Effect.onExit(() => changeMode(logDirectory, OWNER_ONLY_DIRECTORY_MODE)));
        for (const result of runs) {
          expect(result).toMatchObject({ code: 0, standardError: "" });
          expect((yield* jsonLines(result.standardOutput)).map((row) => row["content"])).toEqual([
            "seed",
          ]);
        }
        expect(yield* exists(`${file}-wal`)).toBe(hadWal);
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchPreviewsKeepTheWordsAroundANulCharacter = Task.make(
  "memo process: search previews keep every word of an entry with a NUL character",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const content = "beforezero\u0000afterzero uniquenultail";
      yield* runMemo(["append", "--log", "work"], { memoHome, standardInput: content });
      for (const query of ["beforezero", "afterzero", "uniquenultail"]) {
        const result = yield* runMemo(["search", query, "--log", "work", "--json"], { memoHome });
        expect(result.code).toBe(0);
        expect((yield* jsonLines(result.standardOutput))[0]?.["preview"]).toBe(
          "beforezero afterzero uniquenultail",
        );
        const human = yield* runMemo(["search", query, "--log", "work"], { memoHome });
        expect(human.standardOutput).toEndWith("\n  beforezero afterzero uniquenultail\n");
      }
      const full = yield* runMemo(["search", "afterzero", "--full", "--json"], { memoHome });
      expect((yield* jsonLines(full.standardOutput))[0]?.["content"]).toBe(content);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchHonoursSymbolsTheIndexDrops = Task.make(
  "memo process: search finds emoji and other symbols, and a query with one only matches entries that have it",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      for (const content of ["launch 🚀", "launch without symbol", "warn ⚠️ now", "price 5€"]) {
        expect((yield* runMemo(["append", content, "--log", "work"], { memoHome })).code).toBe(0);
      }
      const found = (query: string) =>
        Effect.gen(function* () {
          const result = yield* runMemo(["search", query, "--log", "work", "--json"], {
            memoHome,
          });
          expect(result).toMatchObject({ code: 0, standardError: "" });
          return (yield* jsonLines(result.standardOutput)).map((row) => row["preview"]);
        });
      expect(yield* found("🚀")).toEqual(["launch 🚀"]);
      expect(yield* found("launch 🚀")).toEqual(["launch 🚀"]);
      expect(yield* found("launch")).toEqual(["launch without symbol", "launch 🚀"]);
      for (const query of ["⚠️", "⚠", "warn ⚠️"]) {
        expect(yield* found(query)).toEqual(["warn ⚠️ now"]);
      }
      expect(yield* found("€")).toEqual(["price 5€"]);
      expect(yield* found("launch 🎉")).toEqual([]);
      expect(yield* found("🎉")).toEqual([]);
      const human = yield* runMemo(["search", "🎉", "--log", "work"], { memoHome });
      expect(human.standardOutput).toBe('No entry in work matches "🎉".\n');
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const appendStopsAtALogWithoutItsSearchIndex = Task.make(
  "memo process: append stops at a log whose search index is missing instead of rebuilding it with only the new entry",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "originalneedle", "--log", "work"], { memoHome });
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      yield* dropFullTextIndex(file);
      const damaged = {
        code: 1,
        standardOutput: "",
        standardError: `${file}: the log is damaged, because its database has no ${SEARCH_INDEX_TABLE} table\n`,
      };
      for (const command of ["append", "check"]) {
        const argv = [command, "newneedle", "--log", "work"];
        expect(yield* runMemo(argv, { memoHome })).toEqual(
          asHumanError(damaged, restoreHint("work", path.dirname(file))),
        );
        expect(
          yield* locatedFailureAsText(yield* runMemo([...argv, "--json"], { memoHome })),
        ).toEqual(damaged);
      }
      expect((yield* readRows(file)).map((row) => row.content)).toEqual(["originalneedle"]);
      expect(
        (yield* runMemo(["search", "originalneedle", "--log", "work"], { memoHome })).code,
      ).toBe(1);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const appendStopsAtAnExistingDatabaseWithoutMemosTables = Task.make(
  "memo process: append stops at an existing database without memo's tables instead of starting the log over",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const truncated = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "originalneedle", "--log", "work"], { memoHome: truncated });
      const truncatedFile = path.join(truncated, "logs", "work", "entries.sqlite3");
      yield* checkpointAndTruncateWal(truncatedFile);
      yield* writeFile(truncatedFile, "");
      const foreign = yield* unrelatedLog;
      for (const [memoHome, file, log] of [
        [truncated, truncatedFile, "work"],
        [foreign.directory, foreign.file, "default"],
      ] as const) {
        const notALog = {
          code: 1,
          standardOutput: "",
          standardError: `${file}: the file isn't a memo log, because it has none of memo's tables\n`,
        };
        for (const commandArguments of [
          ["append", "replacementneedle", "--log", log],
          ["check", "replacementneedle", "--log", log],
        ]) {
          expect(yield* runMemo(commandArguments, { memoHome })).toEqual(
            asHumanError(notALog, restoreHint(log, path.dirname(file))),
          );
        }
        expect(
          yield* locatedFailureAsText(
            yield* runMemo(["append", "replacementneedle", "--log", log, "--json"], { memoHome }),
          ),
        ).toEqual(notALog);
        expect((yield* runMemo(["read", log, "1"], { memoHome })).code).toBe(1);
      }
      expect(Number((yield* stat(truncatedFile)).size)).toBe(0);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const checkStopsAtADatabaseAppendCantUse = Task.make(
  "memo process: check fails like append when the log's database is corrupt instead of promising a save",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "originalneedle", "--log", "work"], { memoHome });
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      yield* checkpointAndTruncateWal(file);
      yield* Effect.flatMap(FileSystem, (fileSystem) =>
        Effect.forEach(
          ["-wal", "-shm"],
          (suffix) => fileSystem.remove(file + suffix, { force: true }),
          {
            discard: true,
          },
        ),
      );
      yield* writeFile(file, "not a database");
      const damaged = {
        code: 1,
        standardOutput: "",
        standardError: `${file}: the log is damaged, and SQLite reports "file is not a database"\n`,
      };
      const appended = yield* runMemo(["append", "candidate", "--log", "work"], { memoHome });
      expect(appended).toEqual(asHumanError(damaged, restoreHint("work", path.dirname(file))));
      expect(yield* runMemo(["check", "candidate", "--log", "work"], { memoHome })).toEqual(
        appended,
      );
      expect(
        yield* locatedFailureAsText(
          yield* runMemo(["check", "candidate", "--log", "work", "--json"], { memoHome }),
        ),
      ).toEqual(damaged);
      const fresh = yield* runMemo(["check", "candidate", "--log", "new", "--json"], { memoHome });
      expect(yield* jsonLines(fresh.standardOutput)).toEqual([
        { log: "new", ok: true, checks: [] },
      ]);
      expect(yield* exists(path.join(memoHome, "logs", "new"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const listingAndSearchingEveryLogSkipALogPathThatIsntADirectory = Task.make(
  "memo process: memo read and memo search without a log report a log folder that is a file or a symlink and still show the other logs",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const variants = [
        [
          (logPath: string) => writeFile(logPath, "damaged log folder"),
          "memo expected a folder but found a file",
        ],
        [
          (logPath: string) => symlink(`${logPath}.elsewhere`, logPath),
          "the folder is a symlink, and memo doesn't follow symlinks",
        ],
        [
          (logPath: string) =>
            Effect.gen(function* () {
              yield* makeDirectory(`${logPath}.target`);
              yield* symlink(`${logPath}.target`, logPath);
            }),
          "the folder is a symlink, and memo doesn't follow symlinks",
        ],
      ] as const;
      for (const [replace, fault] of variants) {
        const memoHome = yield* makeTemporaryDirectory();
        yield* runMemo(["append", "needle", "--log", "good"], { memoHome });
        const logPath = path.join(memoHome, "logs", "bad");
        yield* replace(logPath);
        const located = `${logPath}: ${fault}\n`;
        const expected = { code: 1, standardOutput: "", standardError: `error: ${located}` };
        for (const commandArguments of [
          ["read", "bad"],
          ["search", "needle", "--log", "bad"],
        ]) {
          expect(yield* runMemo(commandArguments, { memoHome })).toEqual(expected);
        }
        expect(yield* runMemo(["read"], { memoHome })).toEqual({
          ...expected,
          standardOutput: `There are 2 logs in \`${path.dirname(logPath)}\`.\n\ngood has 1 entry.\nbad can't be read.\n`,
        });
        for (const commandArguments of [["search", "needle"], ["search"]]) {
          const searched = yield* runMemo(commandArguments, { memoHome });
          expect(searched).toMatchObject({ code: 1, standardError: expected.standardError });
          expect(searched.standardOutput).toContain("needle");
        }
        for (const commandArguments of [
          ["read", "--json"],
          ["search", "needle", "--json"],
        ]) {
          const listed = yield* runMemo(commandArguments, { memoHome });
          expect(
            (yield* jsonLines(listed.standardOutput)).map((line) => line["log"] ?? line["name"]),
          ).toEqual(["good"]);
          expect(yield* locatedFailureAsText({ ...listed, standardOutput: "" })).toEqual({
            code: 1,
            standardOutput: "",
            standardError: located,
          });
        }
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const checkFailsLikeAppendWhenStorageIsReadOnly = Task.make(
  "memo process: check fails like append when the log's database or a new log's folder is read-only",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      yield* changeMode(file, READ_ONLY_FILE_MODE);
      const runs = yield* Effect.forEach(
        [
          ["append", "candidate", "--log", "work"],
          ["check", "candidate", "--log", "work"],
          ["check", "candidate", "--log", "work", "--json"],
        ],
        (commandArguments) =>
          commandArguments.includes("--json")
            ? Effect.flatMap(runMemo(commandArguments, { memoHome }), locatedFailureAsText)
            : runMemo(commandArguments, { memoHome }),
      ).pipe(
        Effect.onExit(() =>
          Effect.forEach(
            ["", "-wal", "-shm"],
            (suffix) =>
              Effect.flatMap(exists(file + suffix), (isPresent) =>
                isPresent ? changeMode(file + suffix, OWNER_ONLY_FILE_MODE) : Effect.void,
              ),
            { discard: true },
          ),
        ),
      );
      const readOnly = {
        code: 1,
        standardOutput: "",
        standardError: `${file}: SQLite failed: SQLiteError: attempt to write a readonly database\n`,
      };
      expect(runs).toEqual([
        asHumanError(readOnly, DEBUG_HINT),
        asHumanError(readOnly, DEBUG_HINT),
        readOnly,
      ]);
      const checked = yield* runMemo(["check", "candidate", "--log", "work", "--json"], {
        memoHome,
      });
      expect(yield* jsonLines(checked.standardOutput)).toEqual([
        { log: "work", ok: true, checks: [] },
      ]);
      expect(
        (yield* runMemo(["append", "candidate", "--log", "work"], { memoHome })).standardOutput,
      ).toBe("Appended work #2.\n");
      expect((yield* readRows(file)).map((row) => row.content)).toEqual(["seed", "candidate"]);
      const fresh = path.join(memoHome, "logs", "fresh");
      yield* makeDirectory(fresh);
      yield* changeMode(fresh, READ_ONLY_DIRECTORY_MODE);
      const [appended, freshCheck, freshCheckAsJson] = yield* Effect.forEach(
        [
          ["append", "candidate", "--log", "fresh"],
          ["check", "candidate", "--log", "fresh"],
          ["check", "candidate", "--log", "fresh", "--json"],
        ],
        (commandArguments) => runMemo(commandArguments, { memoHome }),
      ).pipe(Effect.onExit(() => changeMode(fresh, OWNER_ONLY_DIRECTORY_MODE)));
      expect(appended).toMatchObject({ code: 1, standardOutput: "" });
      expect(appended?.standardError).toStartWith(
        "error: memo couldn't read or write its data folder: PermissionDenied: FileSystem.writeFile (",
      );
      expect(appended?.standardError).toContain(
        `${path.join("logs", "fresh", "entries.sqlite3")}.new-`,
      );
      const denied = `memo couldn't read or write its data folder: PermissionDenied: FileSystem.access (${fresh})`;
      expect(freshCheck).toEqual({
        code: 1,
        standardOutput: "",
        standardError: `error: ${denied}\n${DEBUG_HINT}`,
      });
      expect(freshCheckAsJson).toMatchObject({ code: 1, standardOutput: "" });
      expect(yield* jsonLines(freshCheckAsJson?.standardError ?? "")).toEqual([
        {
          error: "Storage",
          message: denied,
          hint: "run again with `MEMO_DEBUG=1` to see the cause",
        },
      ]);
      expect(
        yield* Effect.flatMap(FileSystem, (fileSystem) => fileSystem.readDirectory(fresh)),
      ).toEqual([]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const ENTRY_COUNT_SENTENCE = / has (?<count>\d+) entr/u;
const ENTRY_HEADER = /^#\d+ /gmu;

const readCountAndRows = (standardOutput: string, json: boolean) =>
  Effect.gen(function* () {
    if (!json) {
      return {
        count: Number(ENTRY_COUNT_SENTENCE.exec(standardOutput)?.groups?.["count"]),
        rows: standardOutput.match(ENTRY_HEADER)?.length ?? 0,
      };
    }
    const [details, ...entries] = yield* jsonLines(standardOutput);
    return { count: details?.["entries"], rows: entries.length };
  });

export const readCountsTheEntriesItListsWhileAppendsRun = Task.make(
  "memo read reports the same number of entries it lists while another process appends",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      const reads = yield* whileInsertingEntries(file, {
        most: MOST_RACING_INSERTS,
        whileInserting: Effect.forEach(
          Array.from({ length: RACING_READS }, (_unused, index) => index % OUTPUT_MODES === 0),
          (json) =>
            Effect.map(
              runMemo(
                ["read", "work", "--limit", String(MAX_SEARCH_LIMIT), ...(json ? ["--json"] : [])],
                {
                  memoHome,
                },
              ),
              (result) => ({ json, result }),
            ),
          { concurrency: RACING_READ_CONCURRENCY },
        ),
      });
      const mismatches = [];
      for (const { json, result } of reads) {
        expect(result).toMatchObject({ code: 0, standardError: "" });
        const { count, rows } = yield* readCountAndRows(result.standardOutput, json);
        if (count !== rows) {
          mismatches.push({ json, count, rows });
        }
      }
      expect(mismatches).toEqual([]);
      expect((yield* readRows(file)).length).toBeGreaterThan(RACING_READS);
    }),
  ),
  { timeout: "2 minutes", cleanup: "5 seconds" },
);

export const searchFootersKeepAQueryThatStartsWithADash = Task.make(
  "memo process: search's see-more command keeps a query that starts with a dash as the query",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      for (const content of ["--help", "--help", "-v --json", "-v --json"]) {
        yield* runMemo(["append", "--log", "dash", "--", content], { memoHome });
      }
      for (const [query, operand] of [
        ["--help", "-- --help"],
        ["-v --json", "-- '-v --json'"],
      ] as const) {
        const more = `\`memo search --log dash --limit 2 ${operand}\``;
        const human = yield* runMemo(["search", "--log", "dash", "--limit", "1", "--", query], {
          memoHome,
        });
        expect(human.code).toBe(0);
        expect(human.standardOutput).toEndWith(
          `\n\nShowing the 1 newest matches for "${query}" in dash. Run ${more} to see more.\n`,
        );
        const json = yield* runMemo(
          ["search", "--log", "dash", "--limit", "1", "--json", "--", query],
          { memoHome },
        );
        expect(json.standardError).toBe(
          `Showing the 1 newest matches for "${query}" in dash. Run \`memo search --log dash --limit 2 --json ${operand}\` to see more.\n`,
        );
        const suggested = yield* runMemo(["search", "--log", "dash", "--limit", "2", "--", query], {
          memoHome,
        });
        expect(suggested.standardOutput.match(/^dash #\d+ /gmu)).toHaveLength(BROWSE_PAGE_SIZE);
      }
      const unscoped = yield* runMemo(["search", "--limit", "1", "--", "--help"], { memoHome });
      expect(unscoped.standardOutput).toEndWith(
        'Showing the 1 newest matches for "--help". Run `memo search --limit 2 -- --help` to see more.\n',
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const textThatStartsWithADashGetsOneErrorThatPointsToTheSeparator = Task.make(
  "memo process: text that starts with a dash gets one unknown-flag error and a hint to put -- before it",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const hintHome = yield* makeTemporaryDirectory();
      for (const [argv, command, word, fixed] of [
        [["check", "--log", "dash", "-dash"], "check", "-dash", "check --log dash -- -dash"],
        [["append", "--log", "dash", "-dash"], "append", "-dash", "append --log dash -- -dash"],
        [["search", "-dash", "--limit", "2"], "search", "-dash", "search --limit 2 -- -dash"],
        [["search", "-v --json"], "search", "-v --json", "search -- '-v --json'"],
      ] as const) {
        expect(yield* runMemo(argv, { memoHome })).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: `error: memo ${command} has no flag ${word}\nhint: put -- before text that starts with a dash: \`memo ${fixed}\`\n`,
        });
        if (process.platform !== "win32") {
          const suggested = yield* runProcess(["sh", "-c", `"$0" ${fixed}`, yield* compiledMemo], {
            environment: { MEMO_HOME: hintHome },
          });
          expect(suggested).toMatchObject({ code: 0, standardError: "" });
        }
      }
      for (const [argv, errors] of [
        [
          ["append", "--log", "dash", "-dash", "-dash"],
          "error: memo append has no flag -dash\nerror: memo append has no flag -dash\n",
        ],
        [["search", "-dash", "other"], "error: memo search has no flag -dash\n"],
        [["search", "-dash", "--", "other"], "error: memo search has no flag -dash\n"],
        [["search", "-dash", "-"], "error: memo search has no flag -dash\n"],
        [["check", "--log", "dash", "-", "-dash"], "error: memo check has no flag -dash\n"],
      ] as const) {
        expect(yield* runMemo(argv, { memoHome })).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: `${errors}hint: run \`memo ${argv[0]} --help\`\n`,
        });
      }
      const asJson = yield* runMemo(["append", "--log", "dash", "--json", "-dash"], { memoHome });
      expect(asJson).toMatchObject({ code: INVALID_USAGE_EXIT_CODE, standardOutput: "" });
      expect(yield* jsonLines(asJson.standardError)).toEqual([
        {
          error: "UnrecognizedOption",
          message: "memo append has no flag -dash",
          hint: "put -- before text that starts with a dash: `memo append --log dash --json -- -dash`",
        },
      ]);
      const valueAfterEquals = yield* runMemo(["search", "--json", "-v=false", "-s"], {
        memoHome,
      });
      expect(valueAfterEquals).toMatchObject({ code: INVALID_USAGE_EXIT_CODE, standardOutput: "" });
      expect(yield* jsonLines(valueAfterEquals.standardError)).toEqual([
        {
          error: "UnrecognizedOption",
          message: "memo search has no flag -s",
          hint: "run `memo search --help`",
        },
      ]);
      expect(yield* exists(`${memoHome}/logs/dash`)).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const flagsAfterTheSeparatorAreNamedAsMisplaced = Task.make(
  "memo process: a needed flag given after -- is named as misplaced, with the command in the right order",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      const hintHome = yield* makeTemporaryDirectory();
      for (const [argv, command, fixed] of [
        [["check", "--", "--log=dash", "-dash"], "check", "check --log=dash -- -dash"],
        [["append", "--", "-dash", "--log", "dash"], "append", "append --log dash -- -dash"],
      ] as const) {
        expect(yield* runMemo(argv, { memoHome })).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: `error: memo ${command} needs --log before --, because everything after -- is content\nhint: put flags before --: \`memo ${fixed}\`\n`,
        });
        if (process.platform !== "win32") {
          const suggested = yield* runProcess(["sh", "-c", `"$0" ${fixed}`, yield* compiledMemo], {
            environment: { MEMO_HOME: hintHome },
          });
          expect(suggested).toMatchObject({ code: 0, standardError: "" });
        }
      }
      const asJson = yield* runMemo(["append", "--json", "--", "-dash", "--log", "dash"], {
        memoHome,
      });
      expect(asJson).toMatchObject({ code: INVALID_USAGE_EXIT_CODE, standardOutput: "" });
      expect(yield* jsonLines(asJson.standardError)).toEqual([
        {
          error: "MissingOption",
          message: "memo append needs --log before --, because everything after -- is content",
          hint: "put flags before --: `memo append --json --log dash -- -dash`",
        },
      ]);
      for (const argv of [
        ["check", "--", "--log"],
        ["check", "--", "--log", "--json"],
        ["check", "--", "--log="],
        ["check", "--", "one", "two", "--log", "dash"],
      ]) {
        expect(yield* runMemo(argv, { memoHome })).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError:
            "error: memo check needs --log before --, because everything after -- is content\nhint: run `memo check --help`\n",
        });
      }
      expect(yield* runMemo(["append", "--", "-dash"], { memoHome })).toEqual({
        code: INVALID_USAGE_EXIT_CODE,
        standardOutput: "",
        standardError: "error: memo append needs --log\nhint: run `memo append --help`\n",
      });
      expect(yield* exists(`${memoHome}/logs/dash`)).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchingAndReadingOneLogIgnoreOtherBrokenLogs = Task.make(
  "memo process: searching or reading one log doesn't depend on another, broken log",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "present", "--log", "good"], { memoHome });
      const bad = path.join(memoHome, "logs", "bad");
      yield* symlink(`${bad}.elsewhere`, bad);
      for (const [commandArguments, standardOutput] of [
        [["search", "absent", "--log", "good"], 'No entry in good matches "absent".\n'],
        [["search", "absent", "--log", "good", "--json"], ""],
      ] as const) {
        expect(yield* runMemo(commandArguments, { memoHome })).toEqual({
          code: 0,
          standardOutput,
          standardError: "",
        });
      }
      for (const commandArguments of [
        ["search", "absent", "--log", "typo"],
        ["read", "typo"],
      ]) {
        expect(yield* runMemo(commandArguments, { memoHome })).toEqual(
          logNotFound("typo", path.join(memoHome, "logs", "typo")),
        );
      }
      const everyLog = yield* runMemo(["search", "present"], { memoHome });
      expect(everyLog.code).toBe(1);
      expect(everyLog.standardOutput).toContain("present");
      expect(everyLog.standardError).toBe(
        `error: ${bad}: the folder is a symlink, and memo doesn't follow symlinks\n`,
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aHookKilledByASignalBunCantNameNeverAccepts = Task.make(
  "memo process: a hook killed by a signal Bun has no name for is reported as killed, not accepted",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform !== "darwin") {
        return;
      }
      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      yield* makeDirectory(logDirectory, { recursive: true });
      const hook = ["sh", "-c", "kill -EMT $$"] as const;
      yield* writeHookConfig(logDirectory, hook);
      const killed = `the hook for work was killed by signal ${DARWIN_SIGEMT} and wrote no reason to stderr`;
      for (const command of ["append", "check"]) {
        expect(yield* runMemo([command, "candidate", "--log", "work"], { memoHome })).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError: `error: ${killed}\n`,
        });
      }
      const json = yield* runMemo(["check", "candidate", "--log", "work", "--json"], { memoHome });
      expect(json.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(yield* jsonLines(json.standardOutput)).toEqual([
        {
          log: "work",
          ok: false,
          checks: [
            {
              hook,
              ok: false,
              signal: `signal ${DARWIN_SIGEMT}`,
              message: `the hook was killed by signal ${DARWIN_SIGEMT} and wrote no reason to stderr`,
            },
          ],
        },
      ]);
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aHookThatLeavesAChildHoldingStandardErrorDoesntHoldUpMemo = Task.make(
  "memo process: memo stops waiting once the hook exits, even when a child the hook left behind keeps its stderr open",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      yield* makeDirectory(logDirectory, { recursive: true });
      const children = path.join(memoHome, "children.txt");
      const heldByEveryHookProcess = path.join(memoHome, "held-by-every-hook-process");
      yield* makeNamedPipe(heldByEveryHookProcess);
      const runLeavingAChild = (ending: string, argv: readonly string[]) =>
        Effect.andThen(
          writeHookConfig(logDirectory, [
            "sh",
            "-c",
            `exec 3>"$1"; sleep ${CHILD_SLEEP_SECONDS} & echo $! >> "$0"; ${ending}`,
            children,
            heldByEveryHookProcess,
          ]),
          Effect.all([runMemo(argv, { memoHome }), readFile(heldByEveryHookProcess)], {
            concurrency: "unbounded",
          }),
        );
      const { rejected, accepted, killed } = yield* Effect.gen(function* () {
        const [rejectedRun, writtenAfterRejection] = yield* runLeavingAChild(
          "echo the summary is missing >&2; exit 3",
          ["append", "candidate", "--log", "work"],
        );
        expect(writtenAfterRejection).toBe("");
        const [acceptedRun, writtenAfterAcceptance] = yield* runLeavingAChild("exit 0", [
          "append",
          "candidate",
          "--log",
          "work",
        ]);
        expect(writtenAfterAcceptance).toBe("");
        const [killedRun, writtenAfterKill] = yield* runLeavingAChild("kill -KILL $$", [
          "check",
          "candidate",
          "--log",
          "work",
        ]);
        expect(writtenAfterKill).toBe("");
        return { rejected: rejectedRun, accepted: acceptedRun, killed: killedRun };
      }).pipe(
        Effect.onExit(() =>
          Effect.flatMap(readFile(children), (started) =>
            runProcess(["kill", ...started.trim().split("\n")], {}),
          ),
        ),
      );
      expect(rejected).toEqual({
        code: INVALID_USAGE_EXIT_CODE,
        standardOutput: "",
        standardError: "error: the hook for work rejected the entry: the summary is missing\n",
      });
      expect(accepted).toEqual({
        code: 0,
        standardOutput: "Appended work #1.\n",
        standardError: "",
      });
      expect(killed.standardError).toBe(
        "error: the hook for work was killed by SIGKILL and wrote no reason to stderr\n",
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const stoppingMemoStopsTheHookAndEverythingItStarted = Task.make(
  "memo process: SIGTERM or SIGINT to memo stops a running hook and every process it started",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      for (const signal of ["TERM", "INT"]) {
        const memoHome = yield* makeTemporaryDirectory();
        const logDirectory = path.join(memoHome, "logs", "work");
        yield* makeDirectory(logDirectory, { recursive: true });
        const started = path.join(memoHome, "started");
        const heldByEveryHookProcess = path.join(memoHome, "held-by-every-hook-process");
        yield* makeNamedPipe(started);
        yield* makeNamedPipe(heldByEveryHookProcess);
        yield* writeHookConfig(logDirectory, [
          "/bin/sh",
          "-c",
          'exec 3>"$1"; sleep 90 & sleep 90 & echo started > "$0"; wait',
          started,
          heldByEveryHookProcess,
        ]);
        const [written, code] = yield* Effect.all(
          [
            readFile(heldByEveryHookProcess),
            Effect.scoped(
              Effect.gen(function* () {
                const running = yield* startMemo(["append", "candidate", "--log", "work"], {
                  memoHome,
                });
                yield* readFile(started);
                yield* runProcess(["kill", `-${signal}`, String(running.pid)]);
                return yield* Effect.promise(() => running.exited);
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect(written).toBe("");
        expect(code).not.toBe(0);
        expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const HOOK_REASON_RUNS = 20;
const LINES_BEFORE_EXIT = 20_000;

export const aHookReasonWrittenRightBeforeExitIsNeverLost = Task.make(
  "memo process: every line a hook writes to stderr right before it exits reaches memo, even while a child it left behind keeps stderr open",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      yield* makeDirectory(logDirectory, { recursive: true });
      const children = path.join(memoHome, "children.txt");
      yield* writeHookConfig(logDirectory, [
        "sh",
        "-c",
        `sleep ${BACKGROUND_SLEEP_SECONDS} & echo $! >> "$0"; { echo "Bun v1.4.4 (test banner)"; awk 'BEGIN { for (line = 1; line <= ${LINES_BEFORE_EXIT}; line++) print "progress line " line; print "the last line names the missing summary" }'; } >&2; exit 1`,
        children,
      ]);
      const runs = yield* Effect.forEach(
        Array.from({ length: HOOK_REASON_RUNS }, (_unused, run) => run),
        () => runMemo(["check", "candidate", "--log", "work"], { memoHome }),
      ).pipe(
        Effect.onExit(() =>
          Effect.flatMap(readFile(children), (started) =>
            runProcess(["kill", ...started.trim().split("\n")], {}),
          ),
        ),
      );
      expect(runs).toHaveLength(HOOK_REASON_RUNS);
      for (const run of runs) {
        expect(run).toEqual({
          code: INVALID_USAGE_EXIT_CODE,
          standardOutput: "",
          standardError:
            "error: the hook for work rejected the content: the last line names the missing summary\n",
        });
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aConfigFileThatIsntValidUtf8IsAConfigFileError = Task.make(
  "memo process: a config.json that isn't valid UTF-8 is a ConfigFile error, and its hook never runs",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      yield* makeDirectory(logDirectory, { recursive: true });
      const config = path.join(logDirectory, "config.json");
      const before = '{ "hook": ["sh", "-c", "exit 0", "before';
      yield* Effect.flatMap(FileSystem, (fileSystem) =>
        fileSystem.writeFile(
          config,
          new Uint8Array([...encode(before), ...LONE_INVALID_BYTE, ...encode('after"] }')]),
        ),
      );
      const refused = `error: ${config}: the file isn't valid UTF-8 at byte ${encode(before).length}\n`;
      for (const command of ["append", "check"]) {
        expect(yield* runMemo([command, "candidate", "--log", "work"], { memoHome })).toEqual({
          code: 1,
          standardOutput: "",
          standardError: refused,
        });
      }
      const json = yield* runMemo(["append", "candidate", "--log", "work", "--json"], { memoHome });
      expect(yield* jsonLines(json.standardError)).toMatchObject([
        { error: "ConfigFile", file: config },
      ]);
      expect((yield* runMemo(["read", "work"], { memoHome })).code).toBe(1);
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const invalidHookConfigsFailClosedThroughTheBinary = Task.make(
  "memo process: each invalid config.json stops append, check and read with a ConfigFile error that says what to write, and saves nothing",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const example = '`{ "hook": ["bun", "/path/to/check.ts"] }`';
      const cases = [
        ["{ bad json", `isn't a JSON object like ${example}`],
        ["[]", `isn't a JSON object like ${example}`],
        ["", `isn't a JSON object like ${example}`],
        [
          '{ "hook": "grep -q TODO" }',
          'gives the hook as a string instead of a list of words, as in `{ "hook": ["grep", "-q", "TODO"] }`',
        ],
        [
          '{ "hook": { "command": "sh" } }',
          `gives the hook as an object instead of a list of words, as in ${example}`,
        ],
        [
          '{ "hook": [] }',
          `gives the hook as an empty list, but the list needs at least a command, as in ${example}`,
        ],
        [
          '{ "hook": ["sh", 1] }',
          `gives the hook a word that is a number, but every word must be a string, as in ${example}`,
        ],
        ['{ "hook": [""] }', `gives the hook an empty command, as in ${example}`],
        [
          String.raw`{ "hook": ["sh", "-c", "a\u0000b"] }`,
          "gives the hook a word with a NUL character, which a command can't receive",
        ],
        [
          '{ "hook": ["./check.sh"] }',
          "gives the hook command `./check.sh`, which isn't a name on PATH or an absolute path",
        ],
        ['{ "hooks": ["sh"] }', "has the field `hooks`, but `hook` is the only field memo reads"],
      ] as const;
      for (const [text, fault] of cases) {
        const memoHome = yield* makeTemporaryDirectory();
        const logDirectory = path.join(memoHome, "logs", "work");
        yield* makeDirectory(logDirectory, { recursive: true });
        const config = path.join(logDirectory, "config.json");
        yield* writeFile(config, text);
        const refused = {
          code: 1,
          standardOutput: "",
          standardError: `error: ${config}: the file ${fault}\n`,
        };
        for (const commandArguments of [
          ["append", "candidate", "--log", "work"],
          ["check", "candidate", "--log", "work"],
          ["read", "work"],
        ]) {
          expect(yield* runMemo(commandArguments, { memoHome })).toEqual(refused);
        }
        const json = yield* runMemo(["append", "candidate", "--log", "work", "--json"], {
          memoHome,
        });
        expect(json).toMatchObject({ code: 1, standardOutput: "" });
        expect(yield* jsonLines(json.standardError)).toMatchObject([
          { error: "ConfigFile", file: config, fault },
        ]);
        expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
      }
      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      const config = path.join(logDirectory, "config.json");
      yield* makeDirectory(config, { recursive: true });
      expect(yield* runMemo(["append", "candidate", "--log", "work"], { memoHome })).toEqual({
        code: 1,
        standardOutput: "",
        standardError: `error: ${config}: config.json is a folder, not a file\n`,
      });
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchRefusesAQueryThatIsntValidUtf8 = Task.make(
  "memo process: search refuses a query with U+FFFD, which is how invalid UTF-8 in an argument arrives",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "--log", "work"], {
        memoHome,
        standardInput: "alpha\uFFFDbeta",
      });
      const alpha = encode("alpha").length;
      expect(yield* runMemo(["search", "alpha\uFFFDbeta", "--log", "work"], { memoHome })).toEqual({
        code: INVALID_USAGE_EXIT_CODE,
        standardOutput: "",
        standardError: `error: the query isn't valid UTF-8 at byte ${alpha}, or has U+FFFD there, which an argument can't carry\nhint: run \`memo search --help\`\n`,
      });
      const json = yield* runMemo(["search", "alpha\uFFFDbeta", "--json"], { memoHome });
      expect(json.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(yield* jsonLines(json.standardError)).toMatchObject([
        { error: "InvalidInput", command: "search" },
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const searchFindsWordsInsideIdentifiersDomainsAndVersions = Task.make(
  "memo process: search finds ẞ as ss, a word between underscores, a domain without www and a version without v",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      for (const content of [
        "STRAẞE",
        "__init__",
        "_private",
        "https://www.example.com/repo v1.2.3",
      ]) {
        yield* runMemo(["append", content, "--log", "work"], { memoHome });
      }
      const found = (query: string) =>
        Effect.flatMap(
          runMemo(["search", query, "--log", "work", "--full", "--json"], { memoHome }),
          (result) =>
            Effect.map(jsonLines(result.standardOutput), (rows) =>
              rows.map((row) => row["content"]),
            ),
        );
      expect(yield* found("strasse")).toEqual(["STRAẞE"]);
      expect(yield* found("Straße")).toEqual(["STRAẞE"]);
      expect(yield* found("init")).toEqual(["__init__"]);
      expect(yield* found("__init__")).toEqual(["__init__"]);
      expect(yield* found("private")).toEqual(["_private"]);
      for (const query of ["example.com", "1.2.3", "2.3", "v1.2.3", "www.example.com"]) {
        expect(yield* found(query)).toEqual(["https://www.example.com/repo v1.2.3"]);
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const FOREIGN_ENTRIES = [
  "CREATE TABLE entries (id INTEGER PRIMARY KEY, datetime TEXT, content TEXT)",
  "INSERT INTO entries VALUES (1, '2020-01-01T00:00:00Z', 'unrelated application record')",
] as const;

export const anIndexUpgradeDropsOnlyIndexesMemoMade = Task.make(
  "memo process: updating an older search index keeps every table memo didn't make",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const contentful = yield* logFromStatements([
        ...FOREIGN_ENTRIES,
        "CREATE VIRTUAL TABLE entries_search USING fts5(words)",
        "INSERT INTO entries_search(words) VALUES ('irreplaceable search-only payload')",
      ]);
      const damaged = `error: ${contentful.file}: the log is damaged, because its database has no ${SEARCH_INDEX_TABLE} table\n${restoreHint("default", path.dirname(contentful.file))}`;
      for (const commandArguments of [
        ["search", "irreplaceable", "--log", "default"],
        ["append", "adopted", "--log", "default"],
        ["check", "adopted", "--log", "default"],
      ]) {
        expect(yield* runMemo(commandArguments, { memoHome: contentful.directory })).toEqual({
          code: 1,
          standardOutput: "",
          standardError: damaged,
        });
      }
      expect(
        yield* textColumn(contentful.file, "SELECT words AS text FROM entries_search"),
      ).toEqual(["irreplaceable search-only payload"]);
      const { directory, file } = yield* legacyLog(["The C# service cannot start."]);
      yield* runStatements(file, [
        "CREATE VIRTUAL TABLE notes_search USING fts5(body, content = '')",
        "CREATE VIRTUAL TABLE search_words_v0 USING fts5(words)",
      ]);
      const searched = yield* runMemo(["search", "service", "--log", "default", "--json"], {
        memoHome: directory,
      });
      expect(searched.code).toBe(0);
      const names = yield* schemaNames(file);
      expect(names).not.toContain("entries_fts");
      expect(names).toContain("notes_search");
      expect(names).toContain("search_words_v0");
      expect(names).toContain(SEARCH_INDEX_TABLE);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aPlainTableNamedLikeTheSearchIndexIsDamage = Task.make(
  "memo process: a plain table with the search index's name fails the schema check instead of being used as the index",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { directory, file } = yield* logFromStatements([
        ...FOREIGN_ENTRIES,
        `CREATE TABLE ${SEARCH_INDEX_TABLE} (words TEXT)`,
      ]);
      const before = yield* schemaNames(file);
      const damaged = `error: ${file}: the log is damaged, because its ${SEARCH_INDEX_TABLE} table isn't a search index memo made\n${restoreHint("default", path.dirname(file))}`;
      for (const commandArguments of [
        ["check", "new entry", "--log", "default"],
        ["append", "new entry", "--log", "default"],
        ["search", "new", "--log", "default"],
      ]) {
        expect(yield* runMemo(commandArguments, { memoHome: directory })).toEqual({
          code: 1,
          standardOutput: "",
          standardError: damaged,
        });
      }
      expect(yield* schemaNames(file)).toEqual(before);
      expect(yield* textColumn(file, "SELECT content AS text FROM entries")).toEqual([
        "unrelated application record",
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aLongHeldLockSaysAnotherProcessHoldsTheLog = Task.make(
  "memo process: a log another process keeps locked past the busy timeout is reported as locked, and the command works once the lock is gone",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      const locked = yield* whileHoldingUncommittedEntry(
        file,
        LOCK_HOLDER_CONTENT,
        runMemo(["append", "blocked", "--log", "work"], { memoHome }),
      );
      expect(locked).toEqual({
        code: 1,
        standardOutput: "",
        standardError: `error: ${file}: another process kept the log locked for more than 5 seconds\nhint: wait for it to finish, then run the command again\n`,
      });
      expect(yield* runMemo(["append", "blocked", "--log", "work"], { memoHome })).toEqual({
        code: 0,
        standardOutput: "Appended work #2.\n",
        standardError: "",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const anUnreadableDatabaseSaysMemoLacksPermission = Task.make(
  "memo process: a database file memo can't read is reported as a permission problem, and the chmod in the hint fixes it",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed", "--log", "work"], { memoHome });
      const file = path.join(memoHome, "logs", "work", "entries.sqlite3");
      yield* changeMode(file, UNREADABLE_FILE_MODE);
      const ignoresReadPermissions = yield* Effect.flatMap(FileSystem, (fileSystem) =>
        fileSystem.readFile(file).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(false)),
        ),
      );
      const cannotDenyReads = ignoresReadPermissions || process.platform === "win32";
      if (cannotDenyReads) {
        return yield* changeMode(file, OWNER_ONLY_FILE_MODE);
      }
      const unreadable = {
        code: 1,
        standardOutput: "",
        standardError: `error: ${file}: memo doesn't have permission to read the file\nhint: run \`chmod 600 ${file}\`\n`,
      };
      for (const commandArguments of [
        ["read", "work"],
        ["search", "seed", "--log", "work"],
        ["append", "more", "--log", "work"],
        ["check", "more", "--log", "work"],
      ]) {
        expect(yield* runMemo(commandArguments, { memoHome })).toEqual(unreadable);
      }
      expect(yield* runProcess(["chmod", "600", file])).toMatchObject({ code: 0 });
      expect(yield* runMemo(["read", "work", "1"], { memoHome })).toMatchObject({
        code: 0,
        standardError: "",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aMemoHomeThatIsNotADirectoryIsNamed = Task.make(
  "memo process: a MEMO_HOME that is a file or a device, or is blank, is named in the error",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const file = path.join(yield* makeTemporaryDirectory(), "not-a-directory");
      yield* writeFile(file, "sentinel");
      for (const commandArguments of [["read"], ["append", "x", "--log", "work"]]) {
        expect(yield* runMemo(commandArguments, { memoHome: file })).toEqual({
          code: 1,
          standardOutput: "",
          standardError: `error: MEMO_HOME is \`${file}\`, which is a file, but it must be a folder\n`,
        });
      }
      expect(yield* readFile(file)).toBe("sentinel");
      if (process.platform !== "win32") {
        expect(yield* runMemo(["search"], { memoHome: "/dev/null" })).toEqual({
          code: 1,
          standardOutput: "",
          standardError:
            "error: MEMO_HOME is `/dev/null`, which is a character device, but it must be a folder\n",
        });
      }
      for (const blank of ["", "   "]) {
        expect(yield* runMemo(["read"], { memoHome: blank })).toEqual({
          code: 1,
          standardOutput: "",
          standardError: "error: MEMO_HOME is blank, but it must be an absolute path\n",
        });
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aConfigFileThatIsADirectoryIsNamed = Task.make(
  "memo process: a config.json that is a folder is named as one, as text and as JSON",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const memoHome = yield* makeTemporaryDirectory();
      const logDirectory = path.join(memoHome, "logs", "work");
      const config = path.join(logDirectory, "config.json");
      yield* makeDirectory(config, { recursive: true });
      for (const commandArguments of [
        ["append", "x", "--log", "work"],
        ["check", "x", "--log", "work"],
        ["read", "work"],
      ]) {
        expect(yield* runMemo(commandArguments, { memoHome })).toEqual({
          code: 1,
          standardOutput: "",
          standardError: `error: ${config}: config.json is a folder, not a file\n`,
        });
      }
      const json = yield* runMemo(["append", "x", "--log", "work", "--json"], { memoHome });
      expect(yield* jsonLines(json.standardError)).toEqual([
        {
          error: "ConfigFileType",
          message: `${config}: config.json is a folder, not a file`,
          file: config,
          type: "a folder",
        },
      ]);
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aQueryWithNoWordsSaysSo = Task.make(
  "memo process: a query with no searchable words says it has no words to search for, and --json prints nothing",
  Effect.scoped(
    Effect.gen(function* () {
      const memoHome = yield* makeTemporaryDirectory();
      yield* runMemo(["append", "seed ...", "--log", "work"], { memoHome });
      for (const [commandArguments, query] of [
        [["search", "..."], "..."],
        [["search", "--log", "work", ""], ""],
        [["search", "--log", "work", "--", "-!-"], "-!-"],
      ] as const) {
        expect(yield* runMemo(commandArguments, { memoHome })).toEqual({
          code: 0,
          standardOutput: `"${query}" has no words to search for.\n`,
          standardError: "",
        });
      }
      expect(yield* runMemo(["search", "...", "--json"], { memoHome })).toEqual({
        code: 0,
        standardOutput: "",
        standardError: "",
      });
      expect(yield* runMemo(["search", "...", "--log", "absent"], { memoHome })).toMatchObject({
        code: 1,
        standardOutput: "",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);
