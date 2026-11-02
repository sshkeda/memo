import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Option, Path, Schema, Tracer } from "effect";

import { DamagedLogError, EntryDecodeError, StorageError } from "../../src/internal/memo-errors.ts";
import { DEFAULT_SEARCH_LIMIT, LogStore } from "../../src/internal/store-logs-in-sqlite.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import {
  addInsertIgnoringTrigger,
  addInsertRejectingTrigger,
  dropTrigger,
  foreignLog,
  newestFirstQueryPlan,
  readDatabaseSummary,
  triggerExists,
  UNTYPED_TABLE,
  whileHoldingUncommittedEntry,
} from "../shared/open-sqlite-database.ts";
import {
  makeTemporaryDirectory,
  buildTestServices,
  writeFile,
  makeDirectory,
  changeMode,
  OWNER_ONLY_FILE_MODE,
  logName,
  appendEntry,
  readEntries,
  searchLog,
} from "../shared/run-memo.ts";

const MISSING_ENTRY_ID = 999;

export const corruptDatabase = Task.make(
  "storage: maps a file that isn't a database to DamagedLogError",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      yield* makeDirectory(path.join(directory, "logs", "default"), { recursive: true });
      yield* writeFile(
        path.join(directory, "logs", "default", "entries.sqlite3"),
        "not a database",
      );
      yield* changeMode(
        path.join(directory, "logs", "default", "entries.sqlite3"),
        OWNER_ONLY_FILE_MODE,
      );
      const error = yield* appendEntry(
        logName("default"),
        "2026-01-01T00:00:00.000Z",
        "candidate",
      ).pipe(Effect.provideContext(yield* buildTestServices(directory)), failureAsValue);
      expect(Schema.is(DamagedLogError)(error)).toBe(true);
      expect(error).toMatchObject({
        file: path.join(directory, "logs", "default", "entries.sqlite3"),
        log: "default",
        message: 'the log is damaged, and SQLite reports "file is not a database"',
      });
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const failedStatement = Task.make(
  "storage: maps statement failures and preserves stored entries",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      yield* Effect.gen(function* () {
        yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "original");
        yield* addInsertRejectingTrigger(
          path.join(directory, "logs", "default", "entries.sqlite3"),
        );
        const error = yield* appendEntry(
          logName("default"),
          "2026-01-01T00:00:00.000Z",
          "rejected",
        ).pipe(failureAsValue);
        expect(Schema.is(StorageError)(error)).toBe(true);
        expect([error.file, error.message]).toEqual([
          path.join(directory, "logs", "default", "entries.sqlite3"),
          "SQLite failed: SQLiteError: test rejection",
        ]);
        const entries = yield* searchLog(logName("default"), Option.none());
        expect(entries.entries.map(({ entry }) => entry.content)).toEqual(["original"]);
      }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const readsDuringWrite = Task.make(
  "storage: reads and searches succeed while another connection holds a write lock",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      yield* Effect.gen(function* () {
        yield* appendEntry(logName("work"), "2026-01-01T00:00:00.000Z", "original");
        yield* whileHoldingUncommittedEntry(
          path.join(directory, "logs", "work", "entries.sqlite3"),
          "uncommitted",
          Effect.gen(function* () {
            expect((yield* readEntries(logName("work"), [1]))[0]?.content).toBe("original");
            expect(
              (yield* searchLog(logName("work"), Option.none())).entries.map(
                ({ entry }) => entry.content,
              ),
            ).toEqual(["original"]);
            expect(
              (yield* searchLog(logName("work"), Option.some("original"))).entries[0]?.entry.id,
            ).toBe(1);
          }),
        );
      }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const readsDoNotRepairSchema = Task.make(
  "storage: reading does not recreate missing schema objects",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      yield* Effect.gen(function* () {
        yield* appendEntry(logName("work"), "2026-01-01T00:00:00.000Z", "original");
        const file = path.join(directory, "logs", "work", "entries.sqlite3");
        yield* dropTrigger(file, "entries_before_delete");
        expect((yield* readEntries(logName("work"), [1]))[0]?.content).toBe("original");
        expect(yield* triggerExists(file, "entries_before_delete")).toBe(false);
      }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const recentQueryUsesIndex = Task.make(
  "sql: newest-first browsing uses an index without a temporary sort",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      yield* appendEntry(logName("work"), "2026-01-01T00:00:00.000Z", "entry").pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      const plan = (yield* newestFirstQueryPlan(
        path.join(directory, "logs", "work", "entries.sqlite3"),
      )).join("\n");
      expect(plan).toContain("entries_newest");
      expect(plan).not.toContain("TEMP B-TREE");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const foreignRowsAreRejected = Task.make(
  "storage: rows that do not match the entry schema fail with EntryDecodeError naming the field and the requested id",
  Effect.scoped(
    Effect.gen(function* () {
      const cases = [
        { row: { id: "one", content: "text id" }, field: "id", reads: ["browse", "recent"] },
        { row: { id: 1, content: null }, field: "content", reads: ["browse", "recent", "read"] },
        {
          row: { id: 1, content: 42 },
          field: "content",
          reads: ["browse", "recent", "read", "search"],
        },
      ] as const;
      for (const { row, field, reads } of cases) {
        const { directory, file } = yield* foreignLog(UNTYPED_TABLE, [row]);
        yield* Effect.gen(function* () {
          const logStore = yield* LogStore;
          const failures = {
            browse: failureAsValue(logStore.browse(logName("default"), DEFAULT_SEARCH_LIMIT, 0)),
            recent: failureAsValue(searchLog(logName("default"), Option.none())),
            read: failureAsValue(readEntries(logName("default"), [1])),
            search: failureAsValue(searchLog(logName("default"), Option.some("42"))),
          };
          for (const read of reads) {
            const error = yield* failures[read];
            expect(Schema.is(EntryDecodeError)(error)).toBe(true);
            expect(error).toMatchObject({
              file,
              message: `${read === "read" ? "default #1" : "an entry"} has an invalid ${field} field`,
            });
          }
        }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const readReportsUnreadableRowsBeforeMissingIds = Task.make(
  "storage: read fails with EntryDecodeError when any requested row is unreadable, even if other ids are missing",
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, file } = yield* foreignLog(UNTYPED_TABLE, [{ id: 1, content: 42 }]);
      for (const ids of [
        [1, MISSING_ENTRY_ID],
        [MISSING_ENTRY_ID, 1],
      ]) {
        const error = yield* readEntries(logName("default"), ids).pipe(
          Effect.provideContext(yield* buildTestServices(directory)),
          failureAsValue,
        );
        expect(Schema.is(EntryDecodeError)(error)).toBe(true);
        expect(error).toMatchObject({ file, message: "default #1 has an invalid content field" });
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const appendRollsBackUnreadableEntry = Task.make(
  "storage: append fails with EntryDecodeError and stores no entry when the inserted row does not match the entry schema",
  Effect.scoped(
    Effect.gen(function* () {
      const cases = [
        {
          log: yield* foreignLog(
            "CREATE TABLE entries (id TEXT PRIMARY KEY, datetime TEXT, content TEXT)",
            [],
          ),
          entriesBefore: 0,
        },
        {
          log: yield* foreignLog(
            "CREATE TABLE entries (id INTEGER PRIMARY KEY, datetime TEXT, content TEXT)",
            [{ id: Number.MAX_SAFE_INTEGER, content: "largest safe id" }],
          ),
          entriesBefore: 1,
        },
      ];
      for (const { log, entriesBefore } of cases) {
        const error = yield* appendEntry(
          logName("default"),
          "2026-01-01T00:00:00.000Z",
          "candidate",
        ).pipe(Effect.provideContext(yield* buildTestServices(log.directory)), failureAsValue);
        expect(Schema.is(EntryDecodeError)(error)).toBe(true);
        expect([error.file, error.message]).toEqual([
          log.file,
          "the inserted entry has an invalid id field, so no entry was stored",
        ]);
        expect(yield* readDatabaseSummary(log.file)).toMatchObject({
          entryCount: entriesBefore,
          indexedCount: entriesBefore,
        });
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const appendWithoutReturnedRow = Task.make(
  "storage: append fails with StorageError when the insert returns no row",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* makeTemporaryDirectory();
      const file = path.join(directory, "logs", "default", "entries.sqlite3");
      yield* Effect.gen(function* () {
        yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "original");
        yield* addInsertIgnoringTrigger(file);
        const error = yield* appendEntry(
          logName("default"),
          "2026-01-01T00:00:00.000Z",
          "ignored",
        ).pipe(failureAsValue);
        expect(Schema.is(StorageError)(error)).toBe(true);
        expect([error.file, error.message]).toEqual([file, "SQLite saved no entry"]);
      }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      expect((yield* readDatabaseSummary(file)).entryCount).toBe(1);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const defectInsideConnection = Task.make(
  "storage: a defect inside a database operation stays a defect instead of becoming a StorageError",
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory();
      const defect = new Error("defect injected by the test");
      const tracerWithDefect = Tracer.make({
        span(options) {
          if (options.name === "LogReader.read") {
            throw defect;
          }
          return Tracer.nativeTracer.span(options);
        },
      });
      const caught = yield* Effect.gen(function* () {
        yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "original");
        return yield* readEntries(logName("default"), [1]).pipe(
          Effect.withTracer(tracerWithDefect),
          Effect.catchDefect(Effect.succeed),
        );
      }).pipe(Effect.provideContext(yield* buildTestServices(directory)));
      expect(caught).toBe(defect);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const theWriterChecksItsBusyTimeoutBeforeWriting = Task.make(
  "storage: memo's writer connection reads its busy_timeout and checks it before it inserts, so a writer waits on a held lock",
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory();
      const spans: Tracer.Span[] = [];
      const recordingTracer = Tracer.make({
        span(options) {
          const span = Tracer.nativeTracer.span(options);
          spans.push(span);
          return span;
        },
      });
      yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "waits").pipe(
        Effect.withTracer(recordingTracer),
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      const statements = spans.flatMap((span) => {
        const text = span.attributes.get("db.query.text");
        return typeof text === "string" ? [text] : [];
      });
      const busyTimeoutRead = statements.indexOf("PRAGMA busy_timeout");
      const insert = statements.findIndex((statement) =>
        statement.startsWith("INSERT INTO entries"),
      );
      expect(busyTimeoutRead).toBeGreaterThanOrEqual(0);
      expect(insert).toBeGreaterThan(busyTimeoutRead);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);
