import { expect } from "bun:test";

import { BunPath } from "@effect/platform-bun";
import { Task } from "@sshkeda/task";
import {
  Cause,
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Path,
  Sink,
  Stream,
} from "effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Stdio from "effect/Stdio";

import { PREVIEW_CHARACTERS, previewAround } from "../../src/internal/choose-previews.ts";
import { HookTimedOutError } from "../../src/internal/memo-errors.ts";
import {
  isSymbolicLink,
  outputColor,
  resolveDataDirectory,
} from "../../src/internal/read-memo-config.ts";
import {
  checkResultLine,
  entryLines,
  humanCheckResult,
  humanConfirmation,
  humanEntries,
  humanLogDetails,
  humanLogsResult,
  HookConfigured,
  NoHookConfigured,
} from "../../src/internal/render-results.ts";
import { reportFor } from "../../src/internal/report-failures.ts";
import {
  HookAccepted,
  HookRejected,
  HookRunner,
  HookTimedOut,
  HookTimeLimit,
  NoHook,
} from "../../src/internal/run-validation-hooks.ts";
import {
  suppliedContent,
  writeOut,
  writeStandardError,
} from "../../src/internal/standard-streams.ts";
import { directoryExists, LogStore } from "../../src/internal/store-logs-in-sqlite.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { readEntryColumns, tamperRow } from "../shared/open-sqlite-database.ts";
import {
  changeMode,
  exists,
  makeDirectory,
  readFile,
  writeFile,
  symlink,
  jsonLines,
  writeHookConfig,
  makeTemporaryDirectory,
  buildTestServices,
  readLink,
  runMemo,
  INVALID_USAGE_EXIT_CODE,
  logName,
  appendEntry,
  readEntries,
  searchLog,
  makeNamedPipe,
} from "../shared/run-memo.ts";

const SECOND_ENTRY_ID = 2;
const MISSING_ENTRY_ID = 9;
const OVERSIZED_HOOK_ARGUMENT = 2_000_000;
const TAMPER_ATTEMPT_COUNT = 5;
const OWNER_ONLY_EXECUTABLE_MODE = 0o700;
const HOUR = 3_600_000;
const UTC = DateTime.zoneMakeOffset(0);
const HOURS_BEHIND_UTC = 7;
const SEVEN_HOURS_BEHIND_UTC = DateTime.zoneMakeOffset(-HOURS_BEHIND_UTC * HOUR);
const SPACED_WORD = "ab ";
const FILLER_SENTENCE = "Routine validation passed. ";
const FILLER_REPEATS_PAST_A_PREVIEW = Math.ceil(PREVIEW_CHARACTERS / FILLER_SENTENCE.length) + 1;
const FILLER = FILLER_SENTENCE.repeat(FILLER_REPEATS_PAST_A_PREVIEW);
const NOISE_WORD = "noise ";
const NOISE_REPEATS_WITHIN_A_PREVIEW = 60;
const NOISE_REPEATS_PAST_A_PREVIEW = Math.ceil(PREVIEW_CHARACTERS / NOISE_WORD.length) + 1;

const dataDirectoryOnPosix = (options: Parameters<typeof resolveDataDirectory>[0]) =>
  resolveDataDirectory(options).pipe(Effect.provide(BunPath.layerPosix));
const dataDirectoryOnWindows = (environment: Readonly<Record<string, string>>) =>
  resolveDataDirectory({ platform: "win32", environment, homeDirectory: String.raw`C:\a` }).pipe(
    Effect.provide(BunPath.layerWin32),
  );

export const usesMemoSpecificPlatformDirectoriesAndMEMOHOME = Task.make(
  "Memo core: uses Memo-specific platform directories and MEMO_HOME",
  Effect.gen(function* () {
    expect(
      yield* dataDirectoryOnPosix({
        platform: "darwin",
        environment: {},
        homeDirectory: "/Users/a",
      }),
    ).toBe("/Users/a/Library/Application Support/Memo");
    expect(
      yield* dataDirectoryOnPosix({ platform: "linux", environment: {}, homeDirectory: "/home/a" }),
    ).toBe("/home/a/.local/share/memo");
    expect(
      yield* dataDirectoryOnPosix({
        platform: "linux",
        environment: { XDG_DATA_HOME: "/data/" },
        homeDirectory: "/home/a",
      }),
    ).toBe("/data/memo");
    expect(
      yield* dataDirectoryOnPosix({
        platform: "linux",
        environment: { XDG_DATA_HOME: "data" },
        homeDirectory: "/home/a",
      }),
    ).toBe("/home/a/.local/share/memo");
    expect(
      yield* dataDirectoryOnPosix({
        platform: "linux",
        environment: { MEMO_HOME: "/data/memo" },
        homeDirectory: undefined,
      }),
    ).toBe("/data/memo");
    expect(
      (yield* failureAsValue(
        dataDirectoryOnPosix({
          platform: "linux",
          environment: { MEMO_HOME: "memo" },
          homeDirectory: "/home/a",
        }),
      )).message,
    ).toBe("MEMO_HOME is `memo`, but it must be an absolute path");
    expect(
      yield* dataDirectoryOnWindows({ LOCALAPPDATA: String.raw`C:\Users\a\AppData\Local` }),
    ).toBe(String.raw`C:\Users\a\AppData\Local\Memo`);
    for (const memoHome of [String.raw`C:\memo`, "C:/memo", String.raw`\\server\share\memo`]) {
      expect(yield* dataDirectoryOnWindows({ MEMO_HOME: memoHome })).toBe(memoHome);
    }
    for (const memoHome of [String.raw`\memo`, "/memo", "C:memo", "memo"]) {
      expect((yield* failureAsValue(dataDirectoryOnWindows({ MEMO_HOME: memoHome }))).message).toBe(
        `MEMO_HOME is \`${memoHome}\`, but it must be an absolute path`,
      );
    }
    for (const environment of [{}, { LOCALAPPDATA: " " }]) {
      expect(yield* failureAsValue(dataDirectoryOnWindows(environment))).toMatchObject({
        variables: ["MEMO_HOME", "LOCALAPPDATA"],
      });
    }
    expect(
      yield* failureAsValue(
        dataDirectoryOnPosix({ platform: "linux", environment: {}, homeDirectory: undefined }),
      ),
    ).toMatchObject({ variables: ["MEMO_HOME", "HOME"] });
    for (const memoHome of ["", " \t"]) {
      expect(
        (yield* failureAsValue(
          dataDirectoryOnPosix({
            platform: "darwin",
            environment: { MEMO_HOME: memoHome },
            homeDirectory: "/Users/a",
          }),
        )).message,
      ).toBe("MEMO_HOME is blank, but it must be an absolute path");
      expect(
        (yield* failureAsValue(
          dataDirectoryOnWindows({ MEMO_HOME: memoHome, LOCALAPPDATA: String.raw`C:\local` }),
        )).message,
      ).toBe("MEMO_HOME is blank, but it must be an absolute path");
    }
  }),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const configuredHookCommandRejectsBeforeStorage = Task.make(
  "Memo core: runs a configured command on a non-executable file and rejects before storage",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "events");
      yield* makeDirectory(logDirectory, { recursive: true });
      const hook = path.join(directory, "reject.ts");
      yield* writeFile(hook, 'await Bun.stdin.text(); console.error("blocked"); process.exit(7);');
      yield* writeHookConfig(logDirectory, ["bun", hook]);
      const result = yield* Effect.flatMap(HookRunner, (runner) =>
        runner.check(logName("events"), "candidate"),
      ).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      expect(result).toEqual(new HookRejected({ hook: ["bun", hook], reason: "blocked" }));
      const rejected = yield* runMemo(["append", "--log", "events", "candidate"], {
        memoHome: directory,
      });
      expect(rejected.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(rejected.standardError).toContain("blocked");
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aHookThatNeverExitsTimesOutAndLeavesNoProcessBehind = Task.make(
  "Memo core: a hook that runs past the time limit is stopped with everything it started",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const directory = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "events");
      yield* makeDirectory(logDirectory, { recursive: true });
      const heldByEveryHookProcess = path.join(directory, "held-by-every-hook-process");
      yield* makeNamedPipe(heldByEveryHookProcess);
      const hook = [
        "sh",
        "-c",
        'exec 3>"$0"; sleep 90 & sleep 90 & wait',
        heldByEveryHookProcess,
      ] as const;
      yield* writeHookConfig(logDirectory, hook);
      const [result, written] = yield* Effect.all(
        [
          Effect.flatMap(HookRunner, (runner) => runner.check(logName("events"), "candidate")).pipe(
            Effect.provideService(HookTimeLimit, Duration.seconds(1)),
            Effect.provideContext(yield* buildTestServices(directory)),
          ),
          readFile(heldByEveryHookProcess),
        ],
        { concurrency: "unbounded" },
      );
      expect(result).toEqual(new HookTimedOut({ hook }));
      expect(written).toBe("");
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aHookThatExitsStillLeavesNoProcessBehind = Task.make(
  "Memo core: a hook that exits while a process it started is still running doesn't leave that process behind",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }
      const directory = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "events");
      yield* makeDirectory(logDirectory, { recursive: true });
      const heldByEveryHookProcess = path.join(directory, "held-by-every-hook-process");
      yield* makeNamedPipe(heldByEveryHookProcess);
      const hook = [
        "/bin/sh",
        "-c",
        'exec 3>"$0"; sleep 90 & echo left a child running >&2; exit 3',
        heldByEveryHookProcess,
      ] as const;
      yield* writeHookConfig(logDirectory, hook);
      const [result, written] = yield* Effect.all(
        [
          Effect.flatMap(HookRunner, (runner) => runner.check(logName("events"), "candidate")).pipe(
            Effect.provideContext(yield* buildTestServices(directory)),
          ),
          readFile(heldByEveryHookProcess),
        ],
        { concurrency: "unbounded" },
      );
      expect(result).toEqual(new HookRejected({ hook, reason: "left a child running" }));
      expect(written).toBe("");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const aTimedOutHookIsReportedLikeOtherHookFailures = Task.make(
  "Memo output: a hook that runs past the time limit is reported with a hint, as text and as JSON",
  Effect.gen(function* () {
    const timedOut = new HookTimedOutError({ log: "events" });
    expect(
      yield* reportFor(Cause.fail(timedOut), {
        argv: [],
        debug: false,
        home: "/home/a",
        json: false,
      }),
    ).toEqual({
      code: INVALID_USAGE_EXIT_CODE,
      lines: [
        "error: the hook for events didn't finish within 1 minute",
        "hint: run the hook yourself on the same stdin to see where it waits, and make it exit within 1 minute",
      ],
    });
    expect(
      yield* reportFor(Cause.fail(timedOut), {
        argv: [],
        debug: false,
        home: "/home/a",
        json: true,
      }),
    ).toEqual({
      code: INVALID_USAGE_EXIT_CODE,
      lines: [
        '{"error":"HookTimedOut","message":"the hook for events didn\'t finish within 1 minute","hint":"run the hook yourself on the same stdin to see where it waits, and make it exit within 1 minute","log":"events"}',
      ],
    });
    expect(yield* checkResultLine("events", new HookTimedOut({ hook: ["sh"] }))).toBe(
      '{"log":"events","ok":false,"checks":[{"hook":["sh"],"ok":false,"message":"the hook didn\'t finish within 1 minute"}]}\n',
    );
  }),
);

export const hasNoBuiltInContentPolicyAndSQLiteAcceptsEmptyText = Task.make(
  "Memo core: has no built-in content policy and SQLite accepts empty text",
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory();
      const checked = yield* Effect.flatMap(HookRunner, (hooks) =>
        hooks.check(logName("default"), ""),
      ).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      expect(checked).toEqual(new NoHook());
      yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "").pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", " \n\t").pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      const entries = yield* readEntries(logName("default"), [1, SECOND_ENTRY_ID]).pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      expect(entries.map((entry) => entry.content)).toEqual(["", " \n\t"]);
      expect(
        yield* searchLog(logName("default"), Option.some("   ")).pipe(
          Effect.provideContext(yield* buildTestServices(directory)),
        ),
      ).toEqual({ entries: [], hasMore: false, logsSearched: 1, unreadable: [] });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const persistsExactContentSearchesLiterallyAndReadsIDsInRequestedOrder = Task.make(
  "Memo core: persists exact content, searches literally, and reads IDs in requested order",
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory();
      yield* Effect.gen(function* () {
        yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "Alpha OR beta\n");
        yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "second café");
      }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      const results = yield* searchLog(logName("default"), Option.some("alpha OR beta")).pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      expect(results.entries.map(({ entry }) => entry.content)).toEqual(["Alpha OR beta\n"]);
      const read = yield* readEntries(logName("default"), [SECOND_ENTRY_ID, 1]).pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      expect(read.map((entry) => entry.content)).toEqual(["second café", "Alpha OR beta\n"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const datesFollowEntryOrderWhenTheClockGoesBack = Task.make(
  "Memo core: an entry is never dated before the entry saved ahead of it",
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory();
      const later = "2026-01-03T00:00:00.000Z";
      const saved = yield* Effect.gen(function* () {
        yield* appendEntry(logName("default"), later, "first");
        return yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "second");
      }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      expect(saved).toEqual({ id: SECOND_ENTRY_ID, datetime: later, content: "second" });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const missingReadsFailAtomically = Task.make(
  "Memo core: missing reads fail atomically",
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory();
      yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "one").pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      yield* failureAsValue(
        readEntries(logName("default"), [1, MISSING_ENTRY_ID]).pipe(
          Effect.provideContext(yield* buildTestServices(directory)),
        ),
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const neutralCompactPreviewsDoNotInterpretMarkdown = Task.make(
  "Memo core: neutral compact previews do not interpret Markdown",
  Effect.scoped(
    Effect.gen(function* () {
      const rendered = yield* entryLines(
        [
          {
            log: "work",
            entry: {
              id: 1,
              datetime: "2026-01-01T00:00:00.000Z",
              content: "# Title\n\nEvidence\n- item",
            },
          },
        ],
        { full: false, includeLog: false },
      );
      expect((yield* jsonLines(rendered))[0]?.["preview"]).toBe("# Title\n\nEvidence\n- item");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const compactPreviewsPreserveLinesAndBoundCharacters = Task.make(
  "Memo core: compact previews preserve lines and bound characters",
  Effect.gen(function* () {
    for (const [content, expected] of [
      ["one\n\n  two\nthree", "one\n\n  two\nthree"],
      ["one\n\n  two\nthree\nfour", "one\n\n  two\nthree\nfour"],
      ["x".repeat(PREVIEW_CHARACTERS), "x".repeat(PREVIEW_CHARACTERS)],
      ["x".repeat(PREVIEW_CHARACTERS + 1), `${"x".repeat(PREVIEW_CHARACTERS)}…`],
      [
        SPACED_WORD.repeat(PREVIEW_CHARACTERS),
        `${SPACED_WORD.repeat(PREVIEW_CHARACTERS / SPACED_WORD.length).trimEnd()}…`,
      ],
    ] as const) {
      const rendered = yield* entryLines(
        [{ log: "work", entry: { id: 1, datetime: "2026-01-01T00:00:00.000Z", content } }],
        { full: false, includeLog: false },
      );
      expect((yield* jsonLines(rendered))[0]?.["preview"]).toBe(expected);
    }
  }),
);

export const previewsShowAnEntryThatFitsWhole = Task.make(
  "Memo core: a search preview shows the whole entry when it fits, with no ellipsis",
  Effect.sync(() => {
    for (const [content, word] of [
      ["Not\nallowed: deploytarget.", "deploytarget"],
      ["Never\rallow releasetarget.", "releasetarget"],
      ["Do not approve Dr. Smith for production access.", "smith"],
      ["Do NOT execute this command:\nDROP TABLE customers;", "drop"],
      [
        `Not allowed: ${NOISE_WORD.repeat(NOISE_REPEATS_WITHIN_A_PREVIEW)}releasegate.`,
        "releasegate",
      ],
      ["x".repeat(PREVIEW_CHARACTERS), "x"],
    ] as const) {
      expect(previewAround(content, [word])).toBe(content);
    }
  }),
);

export const previewsOfLongEntriesStartAtTheMatchsParagraph = Task.make(
  "Memo core: a long entry's preview starts at the paragraph of the match, then its sentence, then a few words before it",
  Effect.sync(() => {
    const rejected =
      "Rejected options (do not implement):\n- Enable unconditional retries\n- Disable authentication checks";
    expect(previewAround(`${FILLER}\n\n${rejected}`, ["unconditional"])).toBe(`…${rejected}`);
    expect(previewAround(`${FILLER}\n \n${rejected}\n\n${FILLER}`, ["unconditional"])).toBe(
      `…${`${rejected}\n\n${FILLER}`.slice(0, PREVIEW_CHARACTERS).trimEnd()}…`,
    );
    expect(previewAround(`${FILLER}Do not deploy Atlas.`, ["deploy"])).toBe(
      "…Do not deploy Atlas.",
    );
    const longSentence = `Not allowed: ${NOISE_WORD.repeat(NOISE_REPEATS_PAST_A_PREVIEW)}releasegate.`;
    const preview = previewAround(longSentence, ["releasegate"]);
    expect(preview.startsWith(`…${NOISE_WORD}`)).toBe(true);
    expect(preview.endsWith("releasegate.")).toBe(true);
  }),
);

export const humanRenderersAreReadableAndTerminalSafe = Task.make(
  "Memo core: human renderers are readable and terminal-safe",
  Effect.scoped(
    Effect.sync(() => {
      const entry = {
        id: 7,
        datetime: "2026-09-02T07:30:00.000Z",
        content: "first\n\u001B[31mred\u001B[0m",
      };
      const plain = { color: false, includeLog: true, timeZone: UTC } as const;
      expect(humanConfirmation("events", entry)).toBe("Appended events #7.\n");
      expect(humanEntries([{ log: "events", entry }], { ...plain, full: false })).toBe(
        "events #7  2026-09-02 07:30\n  first\n  red\n",
      );
      expect(
        humanEntries([{ log: "events", entry }], {
          ...plain,
          full: false,
          includeLog: false,
          timeZone: SEVEN_HOURS_BEHIND_UTC,
        }),
      ).toBe("#7  2026-09-02 00:30\n  first\n  red\n");
      expect(humanEntries([{ log: "events", entry }], { ...plain, full: true })).toBe(
        "events #7  2026-09-02 07:30\nfirst\nred\n",
      );
      expect(humanCheckResult("events", new NoHook())).toBe(
        "events has no hook, so memo append would save this content.\n",
      );
      expect(humanCheckResult("events", new HookAccepted({ hook: ["sh"] }))).toBe(
        "The hook for events accepted the content.\n",
      );
      expect(humanLogsResult("/home/a/logs", [], [], "/home/a")).toBe(
        "There are no logs in `~/logs` yet.\n\nRun `memo append <content> --log <log>` to create one.\n",
      );
      expect(
        humanLogsResult(
          "/data/logs",
          [
            { name: "default", entries: 1, hook: new NoHookConfigured() },
            {
              name: "events",
              entries: 2,
              hook: new HookConfigured({ hook: ["bun", "/home/a/my hooks/check.ts"] }),
            },
          ],
          [],
          "/home/a",
        ),
      ).toBe(
        [
          "There are 2 logs in `/data/logs`.",
          "",
          "default has 1 entry.",
          "events has 2 entries, and its hook is `bun ~/'my hooks/check.ts'`.",
          "",
        ].join("\n"),
      );
      expect(
        humanLogsResult(
          "/data/logs",
          [{ name: "default", entries: 1, hook: new NoHookConfigured() }],
          ["broken"],
          "/home/a",
        ),
      ).toBe("There are 2 logs in `/data/logs`.\n\ndefault has 1 entry.\nbroken can't be read.\n");
      expect(humanLogsResult("/data/logs", [], ["broken"], "/home/a")).toBe(
        "There's 1 log in `/data/logs`.\n\nbroken can't be read.\n",
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const schemaRejectsUpdatesDeletesAndReplacementsWhileFTSRemainsIntact = Task.make(
  "Memo core: schema rejects updates, deletes, and replacements while FTS remains intact",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "immutable token").pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      const file = path.join(directory, "logs", "default", "entries.sqlite3");
      expect(yield* readEntryColumns(file)).toEqual(["id", "datetime", "content"]);
      const { recursiveTriggers, attempts } = yield* tamperRow(file);
      expect(recursiveTriggers).toBe(1);
      expect(attempts).toHaveLength(TAMPER_ATTEMPT_COUNT);
      for (const attempt of attempts) {
        expect(Option.getOrUndefined(attempt.failure)).toMatch(/append-only/u);
        expect(attempt.rowAfter).toEqual(attempt.rowBefore);
        expect(attempt.indexedAfter).toEqual(attempt.indexedBefore);
        expect(attempt.tamperedMatches).toEqual([]);
      }
      const found = yield* searchLog(logName("default"), Option.some("immutable")).pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      expect(found.entries).toHaveLength(1);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const refusesSymlinkDanglingAndDirectoryDatabasePaths = Task.make(
  "Memo core: refuses symlink, dangling, and directory database paths",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }

      const directory = yield* makeTemporaryDirectory();
      const target = path.join(yield* makeTemporaryDirectory(), "target");
      yield* writeFile(target, "untouched");
      yield* Effect.forEach(
        [
          [
            "linked",
            () => symlink(target, path.join(directory, "logs", "linked", "entries.sqlite3")),
          ],
          [
            "dangling",
            () =>
              symlink(
                path.join(directory, "missing"),
                path.join(directory, "logs", "dangling", "entries.sqlite3"),
              ),
          ],
          [
            "directory",
            () => makeDirectory(path.join(directory, "logs", "directory", "entries.sqlite3")),
          ],
        ] as const,
        ([name, make]) =>
          Effect.gen(function* () {
            yield* makeDirectory(path.join(directory, "logs", name), { recursive: true });
            yield* make();
            const error = yield* appendEntry(
              logName(name),
              "2026-01-01T00:00:00.000Z",
              "candidate",
            ).pipe(Effect.provideContext(yield* buildTestServices(directory)), failureAsValue);
            expect(error).toMatchObject({
              file: path.join(directory, "logs", name, "entries.sqlite3"),
            });
          }),
        { discard: true },
      );
      expect(yield* readFile(target)).toBe("untouched");
      expect(yield* readLink(path.join(directory, "logs", "dangling", "entries.sqlite3"))).toBe(
        path.join(directory, "missing"),
      );
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const discoversOnlyMaterializedCanonicalRegularLogsAndIgnoresUnrelatedFiles = Task.make(
  "Memo core: discovers only materialized canonical regular logs and ignores unrelated files",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      yield* writeFile(path.join(directory, "unrelated.sqlite3"), "old");
      yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "entry").pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      const result = yield* Effect.flatMap(LogStore, (logStore) => logStore.list).pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      expect(result).toEqual({
        logs: [
          {
            name: logName("default"),
            directory: path.join(directory, "logs", "default"),
            entries: 1,
            hook: undefined,
          },
        ],
        unreadable: [],
      });
      expect(yield* exists(path.join(directory, "unrelated.sqlite3"))).toBe(true);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const colorsOnlyDecorateHumanMetadata = Task.make(
  "Memo core: colors decorate metadata without changing content",
  Effect.sync(() => {
    const entries = [
      {
        log: "work",
        entry: {
          id: 1,
          datetime: "2026-01-01T00:00:00.000Z",
          content: "# Title\n\nbody\u001B[31m",
        },
      },
    ];
    const options = { full: true, includeLog: true, timeZone: UTC } as const;
    const plain = humanEntries(entries, { ...options, color: false });
    const colored = humanEntries(entries, { ...options, color: true });
    expect(colored).toContain("\u001B[36mwork #1\u001B[0m");
    expect(colored).toContain("\u001B[2m2026-01-01 00:00\u001B[0m");
    expect(colored).toContain("\n# Title\n\nbody\n");
    expect(
      colored.replaceAll("\u001B[36m", "").replaceAll("\u001B[2m", "").replaceAll("\u001B[0m", ""),
    ).toBe(plain);
  }),
);

export const colorsRespectTerminalAndEnvironment = Task.make(
  "Memo core: colors require a terminal and respect NO_COLOR and TERM",
  Effect.scoped(
    Effect.gen(function* () {
      for (const [terminal, environment, expected] of [
        [true, { TERM: "xterm-256color" }, true],
        [false, { TERM: "xterm-256color" }, false],
        [true, { NO_COLOR: "1" }, false],
        [true, { NO_COLOR: "0" }, false],
        [true, { TERM: "dumb" }, false],
        [true, { NO_COLOR: "" }, true],
      ] as const) {
        const stdio = yield* Layer.build(
          Stdio.layerTest({ stdoutIsTerminal: Effect.succeed(terminal) }),
        );
        expect(
          yield* outputColor.pipe(
            Effect.provideContext(stdio),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown(environment),
            ),
          ),
        ).toBe(expected);
      }
    }),
  ),
);

export const configuredCommandIgnoresOtherHookFiles = Task.make(
  "Memo hooks: per-log config selects one command without discovering other files",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      const external = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "career");
      yield* makeDirectory(path.join(logDirectory, "hooks"), { recursive: true });
      yield* writeFile(path.join(logDirectory, "hooks", "local"), "#!/bin/sh\nexit 1\n");
      yield* changeMode(path.join(logDirectory, "hooks", "local"), OWNER_ONLY_EXECUTABLE_MODE);
      yield* writeFile(
        path.join(external, "verify.ts"),
        'const content = await Bun.stdin.text(); process.exit(process.env.MEMO_LOG === "career" && content === "accepted" ? 0 : 1);',
      );
      yield* changeMode(path.join(external, "verify.ts"), OWNER_ONLY_EXECUTABLE_MODE);
      yield* writeHookConfig(logDirectory, ["bun", path.join(external, "verify.ts")]);
      const result = yield* runMemo(["append", "accepted", "--log", "career"], {
        memoHome: directory,
      });
      expect(result.code).toBe(0);
      const inspection = yield* runMemo(["read", "career", "--json"], { memoHome: directory });
      expect(inspection.code).toBe(0);
      expect(inspection.standardOutput).toContain("accepted");
      const rejected = yield* runMemo(["append", "rejected", "--log", "career"], {
        memoHome: directory,
      });
      expect(rejected.code).toBe(INVALID_USAGE_EXIT_CODE);
      const hooks = yield* Effect.flatMap(LogStore, (logStore) =>
        logStore.hookOf(logName("career")),
      ).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      expect(hooks.hook).toEqual(["bun", path.join(external, "verify.ts")]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const invalidHookConfigurationStopsReads = Task.make(
  "Memo hooks: reads of a log stop at an invalid hook config with the error append gives",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      expect(
        (yield* runMemo(["append", "kept", "--log", "career"], { memoHome: directory })).code,
      ).toBe(0);
      const config = path.join(directory, "logs", "career", "config.json");
      yield* writeFile(config, "{");
      const appended = yield* runMemo(["append", "blocked", "--log", "career"], {
        memoHome: directory,
      });
      expect(appended).toEqual({
        code: 1,
        standardOutput: "",
        standardError: `error: ${config}: the file isn't a JSON object like \`{ "hook": ["bun", "/path/to/check.ts"] }\`\n`,
      });
      expect(yield* runMemo(["read", "career"], { memoHome: directory })).toEqual(appended);
      expect(yield* runMemo(["read"], { memoHome: directory })).toEqual({
        ...appended,
        standardOutput: `There's 1 log in \`${path.join(directory, "logs")}\`.\n\ncareer can't be read.\n`,
      });
      const appendedAsJson = yield* runMemo(["append", "blocked", "--log", "career", "--json"], {
        memoHome: directory,
      });
      for (const commandArguments of [
        ["read", "--json"],
        ["read", "career", "--json"],
      ]) {
        expect(yield* runMemo(commandArguments, { memoHome: directory })).toEqual(appendedAsJson);
      }
      expect(appendedAsJson.code).toBe(1);
      expect(yield* jsonLines(appendedAsJson.standardError)).toMatchObject([
        {
          error: "ConfigFile",
          message: appended.standardError.trimEnd().replace(/^error: /u, ""),
          file: config,
        },
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const hookInspectionRefusesLinkedConfigs = Task.make(
  "Memo hooks: inspection accepts absent configs and command lists and refuses linked configs",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "career");
      yield* makeDirectory(logDirectory, { recursive: true });
      const services = yield* buildTestServices(directory);
      const inspect = (log: string) =>
        Effect.flatMap(LogStore, (logStore) => logStore.hookOf(logName(log))).pipe(
          Effect.provideContext(services),
        );
      const configFile = path.join(logDirectory, "config.json");
      expect(yield* inspect("career")).toEqual({ hook: undefined, configFile });
      yield* writeHookConfig(logDirectory, ["sh", "-c", "exit 0"]);
      expect(yield* inspect("career")).toEqual({ hook: ["sh", "-c", "exit 0"], configFile });
      const linkedLogDirectory = path.join(directory, "logs", "linked");
      yield* makeDirectory(linkedLogDirectory, { recursive: true });
      yield* symlink(
        path.join(logDirectory, "config.json"),
        path.join(linkedLogDirectory, "config.json"),
      );
      const refusedConfig = yield* failureAsValue(inspect("linked"));
      expect(refusedConfig).toMatchObject({
        file: path.join(linkedLogDirectory, "config.json"),
        fault: "is a symlink, and memo doesn't follow symlinks",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const invalidHookConfigurationFailsClosed = Task.make(
  "Memo hooks: invalid hook configs fail closed and say what to write",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "career");
      const config = path.join(logDirectory, "config.json");
      yield* makeDirectory(logDirectory, { recursive: true });
      const example = '`{ "hook": ["bun", "/path/to/check.ts"] }`';
      const notAnObject = `the file isn't a JSON object like ${example}`;
      for (const [content, expectedMessage] of [
        ["{", notAnObject],
        ['["bun", "/path/to/check.ts"]', notAnObject],
        ['"hook"', notAnObject],
        [
          '{"hook":42}',
          `the file gives the hook as a number instead of a list of words, as in ${example}`,
        ],
        [
          '{"hook":null}',
          `the file gives the hook as null instead of a list of words, as in ${example}`,
        ],
        [
          '{"hook":[]}',
          `the file gives the hook as an empty list, but the list needs at least a command, as in ${example}`,
        ],
        ['{"hook":["", "x"]}', `the file gives the hook an empty command, as in ${example}`],
        [
          '{"hook":["bun", 1]}',
          `the file gives the hook a word that is a number, but every word must be a string, as in ${example}`,
        ],
        [
          '{"hooks":["bun"]}',
          "the file has the field `hooks`, but `hook` is the only field memo reads",
        ],
        [
          '{"hook":"/hooks/check.ts"}',
          'the file gives the hook as a string instead of a list of words, as in `{ "hook": ["bun", "/hooks/check.ts"] }`',
        ],
        [
          '{"hook":"true"}',
          'the file gives the hook as a string instead of a list of words, as in `{ "hook": ["true"] }`',
        ],
        [
          '{"hook":"python3 /hooks/check.py --strict"}',
          'the file gives the hook as a string instead of a list of words, as in `{ "hook": ["python3", "/hooks/check.py", "--strict"] }`',
        ],
        [
          '{"hook":"grep -q TODO && exit 1"}',
          'the file gives the hook as a string instead of a list of words, as in `{ "hook": ["sh", "-c", "grep -q TODO && exit 1"] }`',
        ],
        [
          '{"hook":["./check.sh"]}',
          "the file gives the hook command `./check.sh`, which isn't a name on PATH or an absolute path",
        ],
        [
          '{"hook":["hooks/check.sh"]}',
          "the file gives the hook command `hooks/check.sh`, which isn't a name on PATH or an absolute path",
        ],
        [
          String.raw`{"hook":["echo","a\u0000b"]}`,
          "the file gives the hook a word with a NUL character, which a command can't receive",
        ],
      ] as const) {
        yield* writeFile(config, content);
        const result = yield* runMemo(["check", "candidate", "--log", "career"], {
          memoHome: directory,
        });
        expect(result.code).toBe(1);
        expect(result.standardError).toBe(`error: ${config}: ${expectedMessage}\n`);
      }
      const spacedHook = path.join(directory, "My Hooks", "check");
      yield* makeDirectory(path.dirname(spacedHook), { recursive: true });
      yield* writeFile(spacedHook, "exit 0\n");
      yield* writeFile(config, `{"hook":"${spacedHook}"}`);
      const spaced = yield* runMemo(["check", "candidate", "--log", "career"], {
        memoHome: directory,
      });
      expect(spaced.standardError).toBe(
        `error: ${config}: the file gives the hook as a string instead of a list of words, as in \`{ "hook": ["${spacedHook}"] }\`\n`,
      );
      yield* writeFile(config, '{ "hook": ["true"] }');
      expect(
        yield* runMemo(["check", "candidate", "--log", "career"], { memoHome: directory }),
      ).toEqual({
        code: 0,
        standardOutput: "The hook for career accepted the content.\n",
        standardError: "",
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const hookCommandRunsWithoutAShell = Task.make(
  "Memo hooks: the command list runs directly, so its words reach the hook unchanged",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "career");
      yield* makeDirectory(logDirectory, { recursive: true });
      yield* writeFile(
        path.join(logDirectory, "config.json"),
        `{ "hook": ["sh", "-c", "if grep -q TODO; then echo 'the entry has a TODO' >&2; exit 1; fi"] }`,
      );
      const rejected = yield* runMemo(["append", "TODO: finish", "--log", "career"], {
        memoHome: directory,
      });
      expect(rejected.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(rejected.standardError).toBe(
        "error: the hook for career rejected the entry: the entry has a TODO\n",
      );
      const accepted = yield* runMemo(["append", "finished", "--log", "career"], {
        memoHome: directory,
      });
      expect(accepted.code).toBe(0);
      const checked = yield* runMemo(["check", "TODO", "--log", "career"], {
        memoHome: directory,
      });
      expect(checked.standardOutput).toBe("");
      expect(checked.standardError).toBe(
        "error: the hook for career rejected the content: the entry has a TODO\n",
      );
      const literalWords = [
        "sh",
        "-c",
        'echo "$1" "$MEMO_LOG" >&2; exit 3',
        "sh",
        "$HOME *",
      ] as const;
      yield* writeHookConfig(logDirectory, literalWords);
      const literal = yield* runMemo(["check", "candidate", "--log", "career", "--json"], {
        memoHome: directory,
      });
      expect(literal.code).toBe(INVALID_USAGE_EXIT_CODE);
      expect(yield* jsonLines(literal.standardOutput)).toEqual([
        {
          log: "career",
          ok: false,
          checks: [{ hook: literalWords, ok: false, message: "$HOME * career" }],
        },
      ]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const hookCommandsReadAsShellWords = Task.make(
  "Memo hooks: human output quotes only the words a shell would split or expand",
  Effect.sync(() => {
    expect(
      humanLogDetails(
        {
          name: "career",
          directory: "/home/a/logs/career",
          entries: 1,
          hook: new HookConfigured({
            hook: ["python3", "/a b/it's.py", "", "--mode=fast", "$HOME", "/home/a/check.ts"],
          }),
        },
        "/home/a",
      ),
    ).toBe(
      [
        "career has 1 entry, and its hook is `python3 '/a b/it'\\''s.py' '' --mode=fast '$HOME' ~/check.ts`.",
        "Its folder is `~/logs/career`.",
        "",
      ].join("\n"),
    );
  }),
);

export const missingHookCommandsAreNamed = Task.make(
  "Memo hooks: a hook command that cannot run is named instead of rejecting the entry",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      const logDirectory = path.join(directory, "logs", "career");
      yield* makeDirectory(logDirectory, { recursive: true });
      const notExecutable = path.join(directory, "check.sh");
      yield* writeFile(notExecutable, "exit 0\n");
      for (const [command, expectedMessage] of [
        ["memo-no-such-command", "isn't on PATH"],
        [notExecutable, "isn't an executable file"],
        [directory, "isn't an executable file"],
      ] as const) {
        yield* writeHookConfig(logDirectory, [command]);
        const result = yield* runMemo(["append", "candidate", "--log", "career"], {
          memoHome: directory,
        });
        expect(result.code).toBe(1);
        expect(result.standardError).toBe(
          `error: ${path.join(logDirectory, "config.json")}: the hook command \`${command}\` ${expectedMessage}\n`,
        );
      }
      const withoutShebang = path.join(directory, "no-shebang");
      yield* writeFile(withoutShebang, "exit 0\n");
      yield* changeMode(withoutShebang, OWNER_ONLY_EXECUTABLE_MODE);
      yield* writeHookConfig(logDirectory, [withoutShebang]);
      const notAProgram = yield* runMemo(["append", "candidate", "--log", "career"], {
        memoHome: directory,
      });
      expect(notAProgram.code).toBe(1);
      expect(notAProgram.standardError).toBe(
        [
          `error: ${path.join(logDirectory, "config.json")}: the hook command \`${withoutShebang}\` isn't a program the system can run (ENOEXEC)`,
          "hint: start the script with a line like `#!/bin/sh`, or put its interpreter first in the hook",
          "",
        ].join("\n"),
      );
      const missingInterpreter = path.join(directory, "missing-interpreter");
      yield* writeFile(missingInterpreter, `#!${path.join(directory, "absent")}\nexit 0\n`);
      yield* changeMode(missingInterpreter, OWNER_ONLY_EXECUTABLE_MODE);
      yield* writeHookConfig(logDirectory, [missingInterpreter]);
      const interpreterNotFound = yield* runMemo(["check", "candidate", "--log", "career"], {
        memoHome: directory,
      });
      expect(interpreterNotFound.code).toBe(1);
      expect(interpreterNotFound.standardError).toBe(
        [
          `error: ${path.join(logDirectory, "config.json")}: the hook command \`${missingInterpreter}\` starts with a #! line whose interpreter isn't installed`,
          "hint: install the interpreter, fix the script's #! line, or put an installed interpreter first in the hook",
          "",
        ].join("\n"),
      );
      yield* writeHookConfig(logDirectory, ["true", "x".repeat(OVERSIZED_HOOK_ARGUMENT)]);
      const tooLong = yield* runMemo(["check", "candidate", "--log", "career", "--json"], {
        memoHome: directory,
      });
      expect(tooLong.code).toBe(1);
      expect(yield* jsonLines(tooLong.standardError)).toMatchObject([
        { error: "HookLaunch", command: "true", code: "E2BIG" },
      ]);
      expect(tooLong.standardError.length).toBeLessThan(OVERSIZED_HOOK_ARGUMENT);
      expect(yield* exists(path.join(logDirectory, "entries.sqlite3"))).toBe(false);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const symlinkChecksFailOnReadLinkErrorsOtherThanNotALink = Task.make(
  "Memo layout: symlink checks fail when lstat fails for a reason other than a missing file",
  Effect.scoped(
    Effect.gen(function* () {
      const file = "/memo/logs/career";
      const inputOutputError = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "lstat",
        pathOrDescriptor: file,
        cause: { code: "EIO" },
      });
      const fileSystem = FileSystem.makeNoop({
        lstat: () => Effect.fail(inputOutputError),
      });
      expect(
        yield* failureAsValue(directoryExists(file)).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      ).toBe(inputOutputError);
      expect(
        yield* failureAsValue(isSymbolicLink(file)).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      ).toBe(inputOutputError);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

const inputOutputFailure = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "Stdio", method, cause: { code: "EIO" } });

export const standardStreamFailuresNameTheStream = Task.make(
  "Memo output: a failed stdin, stdout or stderr names the stream instead of a storage error",
  Effect.gen(function* () {
    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fail(inputOutputFailure("stdin")),
      stdout: () => Sink.fail(inputOutputFailure("stdout")),
      stderr: () => Sink.fail(inputOutputFailure("stderr")),
    });
    const failures = yield* Effect.all([
      failureAsValue(writeOut("text")),
      failureAsValue(writeStandardError("text")),
      failureAsValue(suppliedContent(Option.none(), "append")),
    ]).pipe(Effect.provideService(Stdio.Stdio, stdio));
    const reports = yield* Effect.forEach(failures, (error) =>
      reportFor(Cause.fail(error), { argv: [], debug: false, home: "/home/a", json: false }),
    );
    expect(reports).toEqual([
      { code: 1, lines: [expect.stringMatching(/^error: memo couldn't write stdout: .+/u)] },
      { code: 1, lines: [expect.stringMatching(/^error: memo couldn't write stderr: .+/u)] },
      { code: 1, lines: [expect.stringMatching(/^error: memo couldn't read stdin: .+/u)] },
    ]);
  }),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const unexpectedFailuresPointToDebugMode = Task.make(
  "Memo output: an unexpected failure says so and points to MEMO_DEBUG",
  Effect.gen(function* () {
    expect(
      yield* reportFor(Cause.die("boom"), { argv: [], debug: false, home: "/home/a", json: false }),
    ).toEqual({
      code: 1,
      lines: [
        "error: memo failed for an unexpected reason",
        "hint: run again with `MEMO_DEBUG=1` to see the cause",
      ],
    });
    expect(
      yield* reportFor(Cause.die("boom"), { argv: [], debug: false, home: "/home/a", json: true }),
    ).toEqual({
      code: 1,
      lines: [
        '{"error":"Unexpected","message":"memo failed for an unexpected reason","hint":"run again with `MEMO_DEBUG=1` to see the cause"}',
      ],
    });
  }),
);
