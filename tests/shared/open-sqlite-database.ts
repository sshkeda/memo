import { expect } from "bun:test";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, Option, Path, Schema } from "effect";
import type { Duration } from "effect";
import { make as makeReactivity, Reactivity } from "effect/reactivity/Reactivity";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { SEARCH_TOKENIZER, searchWords } from "../../src/internal/split-search-words.ts";
import { SEARCH_INDEX_TABLE } from "../../src/internal/store-logs-in-sqlite.ts";
import {
  changeMode,
  makeDirectory,
  makeTemporaryDirectory,
  OWNER_ONLY_FILE_MODE,
  runProcess,
} from "./run-memo.ts";

const TAMPER_ATTEMPTS = [
  "UPDATE entries SET content='tampered' WHERE id=1",
  "DELETE FROM entries WHERE id=1",
  "INSERT OR REPLACE INTO entries(id,datetime,content) VALUES(1,'x','tampered')",
  "REPLACE INTO entries(id,datetime,content) VALUES(1,'x','tampered')",
  "INSERT INTO entries(id,datetime,content) VALUES(1,'x','tampered') ON CONFLICT(id) DO UPDATE SET datetime=excluded.datetime,content=excluded.content",
] as const;

const useSqliteDatabase = <Success, Failure, Requirements>(
  file: string,
  options: {
    readonly readonly: boolean;
    readonly create?: boolean;
    readonly busyTimeout?: Duration.Input;
  },
  use: (sql: SqlClient) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.make({
        filename: file,
        readonly: options.readonly,
        create: options.create ?? false,
        disableWAL: true,
        busyTimeout: options.busyTimeout,
      }).pipe(Effect.provideService(Reactivity, yield* makeReactivity));
      return yield* use(sql);
    }),
  );

const readOnly = <Success, Failure, Requirements>(
  file: string,
  read: (sql: SqlClient) => Effect.Effect<Success, Failure, Requirements>,
) => useSqliteDatabase(file, { readonly: true }, read);

const readWrite = <Success, Failure, Requirements>(
  file: string,
  write: (sql: SqlClient) => Effect.Effect<Success, Failure, Requirements>,
) => useSqliteDatabase(file, { readonly: false }, write);

const createAndWrite = <Success, Failure, Requirements>(
  file: string,
  write: (sql: SqlClient) => Effect.Effect<Success, Failure, Requirements>,
) => useSqliteDatabase(file, { readonly: false, create: true }, write);

const runEach = (sql: SqlClient, statements: readonly string[]) =>
  Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true });

const NO_REQUEST = Schema.Struct({});

const allRows = <Row extends Schema.Constraint>(
  row: Row,
  execute: Parameters<
    typeof SqlSchema.findAll<typeof NO_REQUEST, Row, SqlError, never>
  >[0]["execute"],
) => SqlSchema.findAll({ Request: NO_REQUEST, Result: row, execute })({});

const CONTENT_ROW = Schema.Struct({ content: Schema.String });
const ENTRY_ROW = Schema.Struct({
  id: Schema.Int,
  datetime: Schema.String,
  content: Schema.String,
});
const NAME_ROW = Schema.Struct({ name: Schema.String });
const DETAIL_ROW = Schema.Struct({ detail: Schema.String });
const TEXT_ROW = Schema.Struct({ text: Schema.String });

const firstValue = (sql: SqlClient, query: string) =>
  Effect.map(sql.unsafe(query).values, (rows) => rows[0]?.[0]);

const ftsMatches = (sql: SqlClient, term: string) =>
  allRows(
    CONTENT_ROW,
    () =>
      sql`SELECT e.content AS content FROM ${sql(SEARCH_INDEX_TABLE)} AS words JOIN entries AS e ON e.id = words.rowid WHERE ${sql(SEARCH_INDEX_TABLE)} MATCH ${term}`,
  ).pipe(Effect.map((rows) => rows.map((row) => row.content)));

const firstEntry = (sql: SqlClient) =>
  allRows(ENTRY_ROW, () => sql`SELECT id, datetime, content FROM entries WHERE id=1`).pipe(
    Effect.map((rows) => rows[0] ?? null),
  );

export const readRows = (file: string) =>
  readOnly(file, (sql) =>
    allRows(ENTRY_ROW, () => sql`SELECT id, datetime, content FROM entries ORDER BY id`),
  );

export const readDatabaseSummary = (file: string) =>
  readOnly(file, (sql) =>
    Effect.all({
      journalMode: Effect.map(firstValue(sql, "PRAGMA journal_mode"), (mode) => String(mode)),
      entryCount: Effect.map(firstValue(sql, "SELECT count(*) FROM entries"), (count) =>
        Number(count),
      ),
      indexedCount: Effect.map(
        firstValue(sql, `SELECT count(*) FROM ${SEARCH_INDEX_TABLE}`),
        (count) => Number(count),
      ),
    }),
  );

export const readEntryColumns = (file: string) =>
  readOnly(file, (sql) =>
    allRows(NAME_ROW, () => sql`SELECT name FROM pragma_table_info('entries')`).pipe(
      Effect.map((columns) => columns.map((column) => column.name)),
    ),
  );

export const triggerExists = (file: string, name: string) =>
  readOnly(file, (sql) =>
    Effect.map(
      sql`SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ${name}`,
      (rows) => rows.length > 0,
    ),
  );

export const newestFirstQueryPlan = (file: string) =>
  readOnly(file, (sql) =>
    allRows(DETAIL_ROW, () =>
      sql.unsafe(
        "EXPLAIN QUERY PLAN SELECT id,datetime,content FROM entries ORDER BY datetime DESC,id DESC LIMIT 50",
      ),
    ).pipe(Effect.map((steps) => steps.map((step) => step.detail))),
  );

const tamperFailure = (sql: SqlClient, statement: string) =>
  sql.unsafe(statement).pipe(
    Effect.as(Option.none<string>()),
    Effect.catchTag("SqlError", (error) => Effect.succeedSome(String(error.reason.cause))),
  );

export const tamperRow = (file: string) =>
  readWrite(file, (sql) =>
    Effect.gen(function* () {
      yield* sql.unsafe("PRAGMA recursive_triggers=ON");
      const recursiveTriggers = Number(yield* firstValue(sql, "PRAGMA recursive_triggers"));
      const attempts = yield* Effect.forEach(TAMPER_ATTEMPTS, (statement) =>
        Effect.gen(function* () {
          const rowBefore = yield* firstEntry(sql);
          const indexedBefore = yield* ftsMatches(sql, "immutable");
          const failure = yield* tamperFailure(sql, statement);
          return {
            statement,
            failure,
            rowBefore,
            rowAfter: yield* firstEntry(sql),
            indexedBefore,
            indexedAfter: yield* ftsMatches(sql, "immutable"),
            tamperedMatches: yield* ftsMatches(sql, "tampered"),
          };
        }),
      );
      return { recursiveTriggers, attempts };
    }),
  );

export const writeForeignEntriesTable = (
  file: string,
  table: string,
  rows: readonly { readonly id: number | string; readonly content: number | string | null }[],
) =>
  createAndWrite(file, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(table);
        yield* sql.unsafe(
          `CREATE VIRTUAL TABLE ${SEARCH_INDEX_TABLE} USING fts5(words, content = '', tokenize = "${SEARCH_TOKENIZER}")`,
        );
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              yield* sql.unsafe("INSERT INTO entries (id, datetime, content) VALUES (?, ?, ?)", [
                row.id,
                "2026-01-01T00:00:00.000Z",
                row.content,
              ]);
              if (typeof row.id === "number") {
                yield* sql.unsafe(
                  `INSERT INTO ${SEARCH_INDEX_TABLE} (rowid, words) VALUES (?, ?)`,
                  [row.id, searchWords(String(row.content)).join(" ")],
                );
              }
            }),
          { discard: true },
        );
      }),
    ),
  );

export const addInsertRejectingTrigger = (file: string) =>
  readWrite(file, (sql) =>
    sql.unsafe(
      "CREATE TRIGGER reject_insert BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'test rejection'); END",
    ),
  );

export const UNTYPED_TABLE = "CREATE TABLE entries (id, datetime, content)";

export const foreignLog = (
  table: string,
  rows: readonly { readonly id: number | string; readonly content: number | string | null }[],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* makeTemporaryDirectory();
    const file = path.join(directory, "logs", "default", "entries.sqlite3");
    yield* makeDirectory(path.dirname(file), { recursive: true });
    yield* writeForeignEntriesTable(file, table, rows);
    yield* changeMode(file, OWNER_ONLY_FILE_MODE);
    return { directory, file };
  });

const LEGACY_SCHEMA = [
  "CREATE TABLE entries (id INTEGER PRIMARY KEY, datetime TEXT NOT NULL, content TEXT NOT NULL) STRICT",
  "CREATE INDEX entries_newest ON entries(datetime DESC, id DESC)",
  "CREATE VIRTUAL TABLE entries_fts USING fts5(content, content = 'entries', content_rowid = 'id', tokenize = 'unicode61')",
  "CREATE TRIGGER entries_after_insert AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content); END",
  "CREATE TRIGGER entries_before_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'entries is append-only: updates are not permitted'); END",
  "CREATE TRIGGER entries_before_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'entries is append-only: deletes are not permitted'); END",
] as const;

export const legacyLog = (contents: readonly string[]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* makeTemporaryDirectory();
    const file = path.join(directory, "logs", "default", "entries.sqlite3");
    yield* makeDirectory(path.dirname(file), { recursive: true });
    yield* createAndWrite(file, (sql) =>
      Effect.andThen(
        runEach(sql, LEGACY_SCHEMA),
        Effect.forEach(
          contents,
          (content) =>
            sql`INSERT INTO entries (datetime, content) VALUES (${"2026-01-01T00:00:00.000Z"}, ${content})`,
          { discard: true },
        ),
      ),
    );
    yield* changeMode(file, OWNER_ONLY_FILE_MODE);
    return { directory, file };
  });

export const schemaNames = (file: string) =>
  readOnly(file, (sql) =>
    allRows(NAME_ROW, () => sql`SELECT name FROM sqlite_schema ORDER BY name`).pipe(
      Effect.map((rows) => rows.map((row) => row.name)),
    ),
  );

export const logFromStatements = (statements: readonly string[]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* makeTemporaryDirectory();
    const file = path.join(directory, "logs", "default", "entries.sqlite3");
    yield* makeDirectory(path.dirname(file), { recursive: true });
    yield* createAndWrite(file, (sql) => runEach(sql, statements));
    yield* changeMode(file, OWNER_ONLY_FILE_MODE);
    return { directory, file };
  });

export const unrelatedLog = logFromStatements([
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
  "INSERT INTO notes (body) VALUES ('unrelated')",
]);

export const runStatements = (file: string, statements: readonly string[]) =>
  readWrite(file, (sql) => runEach(sql, statements));

export const textColumn = (file: string, query: string) =>
  readOnly(file, (sql) =>
    allRows(TEXT_ROW, () => sql.unsafe(query)).pipe(
      Effect.map((rows) => rows.map((row) => row.text)),
    ),
  );

export const addInsertIgnoringTrigger = (file: string) =>
  readWrite(file, (sql) =>
    sql.unsafe(
      "CREATE TRIGGER ignore_insert BEFORE INSERT ON entries BEGIN SELECT RAISE(IGNORE); END",
    ),
  );

export const insertEntryOutOfDateOrder = (file: string, datetime: string, content: string) =>
  readWrite(
    file,
    (sql) => sql`INSERT INTO entries (datetime, content) VALUES (${datetime}, ${content})`,
  );

export const emptySearchIndexFromOlderWordRules = (file: string) =>
  readWrite(file, (sql) =>
    runEach(sql, [
      `DROP TABLE ${SEARCH_INDEX_TABLE}`,
      `CREATE VIRTUAL TABLE entries_search USING fts5(words, content = '', tokenize = "${SEARCH_TOKENIZER}")`,
    ]),
  );

export const dropTrigger = (file: string, name: "entries_before_delete") =>
  readWrite(file, (sql) => sql.unsafe(`DROP TRIGGER ${name}`));

export const dropFullTextIndex = (file: string) =>
  readWrite(file, (sql) => sql.unsafe(`DROP TABLE ${SEARCH_INDEX_TABLE}`));

export const whileWalHoldsCommittedStatements = <Success, Failure, Requirements>(
  file: string,
  statements: readonly string[],
  whileHeld: Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.make({ filename: file }).pipe(
        Effect.provideService(Reactivity, yield* makeReactivity),
      );
      yield* runEach(sql, ["PRAGMA wal_autocheckpoint = 0", ...statements]);
      return yield* whileHeld;
    }),
  );

export const checkpointAndTruncateWal = (file: string) =>
  readWrite(file, (sql) => sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)"));

export const selectOneWithoutFollowingSymlinks = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Layer.build(
        SqliteClient.layer({ filename, noFollow: true, disableWAL: true }),
      );
      return yield* Effect.flatMap(SqlClient, (sql) => sql`SELECT 1`).pipe(
        Effect.provideContext(database),
      );
    }),
  );

const holdingWriteLock = <Success, Failure, Requirements>(
  file: string,
  content: string,
  use: (sql: SqlClient) => Effect.Effect<Success, Failure, Requirements>,
) =>
  readWrite(file, (sql) =>
    Effect.gen(function* () {
      yield* sql.unsafe("BEGIN IMMEDIATE");
      yield* sql`INSERT INTO entries(datetime, content) VALUES ('1970-01-01T00:00:00.000Z', ${content})`;
      return yield* use(sql);
    }),
  );

export const whileHoldingUncommittedEntry = <Success, Failure, Requirements>(
  file: string,
  content: string,
  whileHeld: Effect.Effect<Success, Failure, Requirements>,
) =>
  holdingWriteLock(file, content, (sql) =>
    whileHeld.pipe(Effect.onExit(() => sql.unsafe("ROLLBACK"))),
  );

export const LOCK_HOLDER_CONTENT = "lock holder";

const immediateWriteWithoutWaiting = (file: string) =>
  useSqliteDatabase(file, { readonly: false, busyTimeout: 0 }, (sql) =>
    sql.unsafe("BEGIN IMMEDIATE").pipe(
      Effect.as("Acquired" as const),
      Effect.catchReason("SqlError", "LockTimeoutError", () =>
        Effect.succeed("LockTimeout" as const),
      ),
    ),
  );

export const runWriterAgainstHeldWriteLock = <
  WriterSuccess,
  WriterFailure,
  WriterRequirements,
  HeldSuccess,
  HeldFailure,
  HeldRequirements,
>(
  file: string,
  options: {
    readonly whileHeld: Effect.Effect<HeldSuccess, HeldFailure, HeldRequirements>;
    readonly writer: Effect.Effect<WriterSuccess, WriterFailure, WriterRequirements>;
  },
) =>
  holdingWriteLock(file, LOCK_HOLDER_CONTENT, (sql) =>
    Effect.gen(function* () {
      const heldResult = yield* options.whileHeld;
      const competingWrite = yield* immediateWriteWithoutWaiting(file);
      const [writerResult] = yield* Effect.all([options.writer, sql.unsafe("COMMIT")], {
        concurrency: "unbounded",
      });
      return { heldResult, competingWrite, writerResult };
    }),
  );

const INSERTING_WRITER = String.raw`
  import { Database } from "bun:sqlite";
  const [file, most] = process.argv.slice(-2);
  const database = new Database(file, { readwrite: true });
  database.run("PRAGMA busy_timeout = 5000");
  const insert = database.query("INSERT INTO entries(datetime, content) VALUES ('2026-01-01T00:00:00.000Z', 'concurrent')");
  for (let inserted = 0; inserted < Number(most); inserted += 1) {
    insert.run();
    Bun.sleepSync(1);
  }
  database.close();
`;

export const whileInsertingEntries = <Success, Failure, Requirements>(
  file: string,
  options: {
    readonly most: number;
    readonly whileInserting: Effect.Effect<Success, Failure, Requirements>;
  },
) =>
  Effect.raceFirst(
    options.whileInserting,
    Effect.flatMap(
      runProcess([process.execPath, "-e", INSERTING_WRITER, file, String(options.most)]),
      (writer) =>
        Effect.andThen(
          Effect.sync(() => {
            expect(writer).toEqual({ code: 0, standardOutput: "", standardError: "" });
          }),
          Effect.never,
        ),
    ),
  );
