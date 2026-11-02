import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Order,
  Result,
  Schema,
  SchemaIssue,
} from "effect";
import type { Cause } from "effect";
import { SecureRandom } from "effect/crypto";
import { FileSystem } from "effect/FileSystem";
import type { File } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { make as makeReactivity, Reactivity } from "effect/reactivity/Reactivity";
import { SqlClient } from "effect/sql/SqlClient";
import { LockTimeoutError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { previewAround } from "./choose-previews.ts";
import {
  DamagedLogError,
  EntriesNotFoundError,
  EntryDecodeError,
  InvalidInputError,
  LogLockedError,
  LogNotFoundError,
  OutdatedSearchIndexError,
  SharedDatabaseFileError,
  StorageError,
  UnreadableDatabaseFileError,
} from "./memo-errors.ts";
import type { MEMO_COMMAND } from "./memo-errors.ts";
import {
  AppConfig,
  CONFIG_FILE,
  DIRECTORY_MODE,
  FILE_MODE,
  fileTypeName,
  hookCommand,
  symbolicLinkStatus,
} from "./read-memo-config.ts";
import type { HOOK_COMMAND } from "./read-memo-config.ts";
import { SEARCH_TOKENIZER, SEARCH_WORDS_VERSION, searchWords } from "./split-search-words.ts";

const GROUP_AND_OTHER_PERMISSIONS = 0o077;
const PERMISSION_BITS = 0o777;
const OCTAL_RADIX = 8;
const OCTAL_MODE_DIGITS = 4;

const DATABASE_FILE = "entries.sqlite3";
const DRAFT_PREFIX = `${DATABASE_FILE}.new-`;

export const LOG_NAME = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u)),
  Schema.brand("LogName"),
);

export const LOG_NAME_RULE =
  "a log name has 1 to 64 lowercase letters, digits, dots, underscores or hyphens, and starts and ends with a letter or digit";

export const validateLogName = (name: string, command: typeof MEMO_COMMAND.Type) =>
  Result.mapError(
    Schema.decodeResult(LOG_NAME)(name),
    () =>
      new InvalidInputError({
        command,
        message: `"${name}" isn't a valid log name, because ${LOG_NAME_RULE}`,
      }),
  );
const isLogName = Schema.is(LOG_NAME);

class LogDatabase extends Data.Class<{
  readonly name: typeof LOG_NAME.Type;
  readonly directory: string;
  readonly file: string;
}> {}

const storageError = (cause: PlatformError) =>
  new StorageError({
    message: `memo couldn't read or write its data folder: ${cause.message}`,
    cause,
  });
const wrongType = (expected: string, file: string, found: File.Type) =>
  new StorageError({ file, message: `memo expected ${expected} but found ${fileTypeName(found)}` });

const inspectPath = Effect.fn("inspectPath")(function* (file: string) {
  const fileSystem = yield* FileSystem;
  const link = yield* symbolicLinkStatus(file);
  if (link !== "NotALink") {
    return { type: link };
  }
  return yield* fileSystem.stat(file).pipe(
    Effect.map((information) =>
      information.type === "File"
        ? { type: "File" as const, mode: information.mode, owner: information.uid }
        : { type: information.type },
    ),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed({ type: "Absent" as const }),
    ),
  );
});

export const directoryExists = Effect.fn("directoryExists")(function* (directory: string) {
  const entry = yield* inspectPath(directory);
  if (entry.type === "Absent") {
    return false;
  }
  if (entry.type === "SymbolicLink") {
    return yield* new StorageError({
      file: directory,
      message: "the folder is a symlink, and memo doesn't follow symlinks",
    });
  }
  if (entry.type !== "Directory") {
    return yield* wrongType("a folder", directory, entry.type);
  }
  return true;
});

const sameFile = (first: File.Info, second: File.Info) => {
  const inode = Option.getOrUndefined(first.ino);
  return (
    inode !== undefined && first.dev === second.dev && inode === Option.getOrUndefined(second.ino)
  );
};

const ONE_NAME = 1n;

const quote = (token: string): string => `"${token.replaceAll(`"`, `""`)}"`;

export const toMatchExpression = (input: string): Option.Option<string> => {
  const words = [...new Set(searchWords(input))];
  if (words.length === 0) {
    return Option.none();
  }
  return Option.some(words.map((word) => quote(word)).join(" AND "));
};

const FTS5_TOKEN_BYTES = 32_768;
const MOST_UTF8_BYTES_PER_UTF16_UNIT = 3;

const isPastTokenLimit = (word: string) =>
  word.length * MOST_UTF8_BYTES_PER_UTF16_UNIT >= FTS5_TOKEN_BYTES;

const hasEveryLongWord = (content: string, longWords: readonly string[]) => {
  const words = new Set(searchWords(content).filter((word) => isPastTokenLimit(word)));
  return longWords.every((word) => words.has(word));
};

export const ENTRY_ROW = Schema.Struct({
  id: Schema.Int,
  datetime: Schema.String.check(Schema.makeFilter((text) => Option.isSome(DateTime.make(text)))),
  content: Schema.String,
});

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

export const DEFAULT_SEARCH_LIMIT = 50;

export const MAX_SEARCH_LIMIT = 1000;

export const BUSY_TIMEOUT_TEXT = "5 seconds";

const BUSY_TIMEOUT_MILLIS = Duration.toMillis(Duration.fromInputUnsafe(BUSY_TIMEOUT_TEXT));

export const validateSearchLimit = (
  limit: number,
  command: Extract<typeof MEMO_COMMAND.Type, "read" | "search">,
): Result.Result<number, InvalidInputError> => {
  const isInRange = Number.isInteger(limit) && limit >= 1 && limit <= MAX_SEARCH_LIMIT;
  return isInRange
    ? Result.succeed(limit)
    : Result.fail(
        new InvalidInputError({
          command,
          message: `--limit is ${limit}, but it must be from 1 to ${MAX_SEARCH_LIMIT}`,
        }),
      );
};

const MAX_SEARCH_OFFSET = Number.MAX_SAFE_INTEGER - MAX_SEARCH_LIMIT;

export const validateSearchOffset = (offset: number): Result.Result<number, InvalidInputError> => {
  const isInRange = Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_SEARCH_OFFSET;
  if (isInRange) {
    return Result.succeed(offset);
  }
  const range = offset < 0 ? "0 or more" : `at most ${MAX_SEARCH_OFFSET}`;
  return Result.fail(
    new InvalidInputError({
      command: "read",
      message: `--offset is ${offset}, but it must be ${range}`,
    }),
  );
};

export const SEARCH_INDEX_TABLE = `search_words_v${SEARCH_WORDS_VERSION}`;

const CREATE_SEARCH_INDEX_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH_INDEX_TABLE} USING fts5(
    words,
    content = '',
    tokenize = "${SEARCH_TOKENIZER}"
  );`;

const INITIALIZE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    datetime TEXT NOT NULL,
    content TEXT NOT NULL
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS entries_newest ON entries(datetime DESC, id DESC);`,
  CREATE_SEARCH_INDEX_SQL,
  `CREATE TRIGGER IF NOT EXISTS entries_before_update BEFORE UPDATE ON entries BEGIN
    SELECT RAISE(ABORT, 'entries is append-only: updates are not permitted');
  END;`,
  `CREATE TRIGGER IF NOT EXISTS entries_before_delete BEFORE DELETE ON entries BEGIN
    SELECT RAISE(ABORT, 'entries is append-only: deletes are not permitted');
  END;`,
] as const;

const EXPECTED_PRAGMAS = [
  ["journal_mode", "wal"],
  ["synchronous", "2"],
  ["busy_timeout", String(BUSY_TIMEOUT_MILLIS)],
  ["trusted_schema", "0"],
  ["recursive_triggers", "1"],
  ["wal_autocheckpoint", "0"],
] as const;

const unreadable =
  (configuredFile: string, entry: string, outcome: string) => (cause: Schema.SchemaError) =>
    Effect.fromOption(
      Option.fromUndefinedOr(
        formatIssue(cause.issue).issues[0]?.path?.find((key) => typeof key === "string"),
      ),
    ).pipe(
      Effect.catchTag("NoSuchElementError", () => Effect.die(cause)),
      Effect.flatMap((field) =>
        Effect.fail(
          new EntryDecodeError({
            file: configuredFile,
            message: `${entry} has an invalid ${field} field${outcome}`,
            cause,
          }),
        ),
      ),
    );

const decodeSqliteFailure = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.String, message: Schema.String }),
);
const DAMAGED_DATABASE_CODES = ["SQLITE_NOTADB", "SQLITE_CORRUPT"] as const;
const isDamagedDatabaseCode = (code: string) =>
  DAMAGED_DATABASE_CODES.some((damaged) => code === damaged || code.startsWith(`${damaged}_`));

const damaged = (database: LogDatabase, message: string) =>
  new DamagedLogError({
    file: database.file,
    directory: database.directory,
    log: database.name,
    message,
  });

const damageReport = (cause: SqlError) =>
  Option.map(
    Option.filter(decodeSqliteFailure(cause.reason.cause), (failure) =>
      isDamagedDatabaseCode(failure.code),
    ),
    (failure) => failure.message,
  );

const isLockTimeout = Schema.is(LockTimeoutError);

const failedOperation =
  (database: LogDatabase) =>
  (cause: SqlError): Effect.Effect<never, DamagedLogError | LogLockedError | StorageError> => {
    if (isLockTimeout(cause.reason)) {
      return Effect.fail(new LogLockedError({ file: database.file, cause }));
    }
    const damage = damageReport(cause);
    if (Option.isSome(damage)) {
      return Effect.fail(
        new DamagedLogError({
          file: database.file,
          directory: database.directory,
          log: database.name,
          message: `the log is damaged, and SQLite reports "${damage.value}"`,
          cause,
        }),
      );
    }
    return Effect.fail(
      new StorageError({
        file: database.file,
        message: `SQLite failed: ${String(cause.reason.cause)}`,
        cause,
      }),
    );
  };

const withHasMore = <Row>(rows: readonly Row[], limit: number) => ({
  entries: rows.slice(0, limit),
  hasMore: rows.length > limit,
});

const SCHEMA_TABLE = Schema.Struct({ name: Schema.String, isFts5: Schema.Int });

const LEGACY_INDEX_WITH_TRIGGER = "entries_fts";
const LEGACY_INDEX_TRIGGER = "entries_after_insert";
const OLDER_INDEX_NAME = /^search_words_v(?<version>\d+)$/u;

const isOlderIndexName = (name: string) => {
  const version = OLDER_INDEX_NAME.exec(name)?.groups?.["version"];
  const isOlderVersion = version !== undefined && Number(version) < SEARCH_WORDS_VERSION;
  return [LEGACY_INDEX_WITH_TRIGGER, "entries_search"].includes(name) || isOlderVersion;
};

const searchIndexIn = (sql: SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: SCHEMA_TABLE,
    execute: () =>
      sql`SELECT name, coalesce(sql LIKE 'CREATE VIRTUAL TABLE % USING fts5%', 0) AS isFts5 FROM sqlite_schema WHERE type = 'table'`,
  })({}).pipe(
    Effect.catchTag("SchemaError", (cause) => Effect.die(cause)),
    Effect.map((tables) => {
      const names = new Set(tables.map((table) => table.name));
      const isMemoIndex = (table: typeof SCHEMA_TABLE.Type) =>
        table.isFts5 === 1 && !names.has(`${table.name}_content`);
      const current = tables.find((table) => table.name === SEARCH_INDEX_TABLE);
      const currentState = () => {
        if (current === undefined) {
          return "Absent" as const;
        }
        return isMemoIndex(current) ? ("Index" as const) : ("NotAnIndex" as const);
      };
      return {
        hasEntries: names.has("entries"),
        current: currentState(),
        older: tables
          .filter((table) => isOlderIndexName(table.name) && isMemoIndex(table))
          .map((table) => table.name),
      };
    }),
  );

const verifySchemaIn = (sql: SqlClient, database: LogDatabase) =>
  Effect.gen(function* () {
    const { hasEntries, current, older } = yield* searchIndexIn(sql);
    if (!hasEntries) {
      return yield* damaged(
        database,
        current === "Absent"
          ? "the file isn't a memo log, because it has none of memo's tables"
          : "the log is damaged, because its database has no entries table",
      );
    }
    if (current === "Index") {
      return;
    }
    if (current === "NotAnIndex") {
      return yield* damaged(
        database,
        `the log is damaged, because its ${SEARCH_INDEX_TABLE} table isn't a search index memo made`,
      );
    }
    if (older.length > 0) {
      return yield* new OutdatedSearchIndexError({ file: database.file, log: database.name });
    }
    return yield* damaged(
      database,
      `the log is damaged, because its database has no ${SEARCH_INDEX_TABLE} table`,
    );
  });

const verifySchema = (database: LogDatabase) =>
  Effect.flatMap(SqlClient, (sql) => verifySchemaIn(sql, database));

const readerFor = (database: LogDatabase) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const inSnapshot = <Success, Failure, Requirements>(
      reads: Effect.Effect<Success, Failure, Requirements>,
    ) =>
      Effect.gen(function* () {
        yield* sql.unsafe("BEGIN DEFERRED");
        return yield* reads.pipe(
          Effect.onExit((result) => sql.unsafe(Exit.isSuccess(result) ? "COMMIT" : "ROLLBACK")),
        );
      });
    const countEntries = SqlSchema.findOne({
      Request: Schema.Struct({}),
      Result: Schema.Struct({ entries: Schema.Int }),
      execute: () => sql`SELECT count(*) AS entries FROM entries`,
    });
    const findNewest = SqlSchema.findAll({
      Request: Schema.Int,
      Result: ENTRY_ROW,
      execute: (limit) =>
        sql`SELECT id, datetime, content FROM entries ORDER BY datetime DESC, id DESC LIMIT ${limit}`,
    });
    const findInIdOrder = SqlSchema.findAll({
      Request: Schema.Struct({ limit: Schema.Int, offset: Schema.Int }),
      Result: ENTRY_ROW,
      execute: ({ limit, offset }) =>
        sql`SELECT id, datetime, content FROM entries ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}`,
    });
    const findMatches = SqlSchema.findAll({
      Request: Schema.Struct({ expression: Schema.String, limit: Schema.Int }),
      Result: ENTRY_ROW,
      execute: ({ expression, limit }) =>
        sql`SELECT e.id AS id, e.datetime AS datetime, e.content AS content FROM ${sql(SEARCH_INDEX_TABLE)} AS words JOIN entries AS e ON e.id = words.rowid WHERE ${sql(SEARCH_INDEX_TABLE)} MATCH ${expression} ORDER BY e.datetime DESC, e.id DESC LIMIT ${limit}`,
    });
    const findEveryMatch = SqlSchema.findAll({
      Request: Schema.String,
      Result: ENTRY_ROW,
      execute: (expression) =>
        sql`SELECT e.id AS id, e.datetime AS datetime, e.content AS content FROM ${sql(SEARCH_INDEX_TABLE)} AS words JOIN entries AS e ON e.id = words.rowid WHERE ${sql(SEARCH_INDEX_TABLE)} MATCH ${expression} ORDER BY e.datetime DESC, e.id DESC`,
    });
    const findById = SqlSchema.findOneOption({
      Request: Schema.Int,
      Result: ENTRY_ROW,
      execute: (id) => sql`SELECT id, datetime, content FROM entries WHERE id = ${id}`,
    });
    const count = countEntries({}).pipe(
      Effect.map((row) => row.entries),
      Effect.catchTags({
        SchemaError: (cause) => Effect.die(cause),
        NoSuchElementError: () =>
          Effect.fail(
            new StorageError({ file: database.file, message: "SQLite returned no entry count" }),
          ),
        SqlError: failedOperation(database),
      }),
    );
    const searchRecent = Effect.fn("LogReader.searchRecent")(
      function* (limit: number) {
        return withHasMore(yield* findNewest(limit + 1), limit);
      },
      Effect.catchTags({
        SchemaError: unreadable(database.file, "an entry", ""),
        SqlError: failedOperation(database),
      }),
    );
    const page = Effect.fn("LogReader.page")(
      function* (limit: number, offset: number) {
        return withHasMore(yield* findInIdOrder({ limit: limit + 1, offset }), limit);
      },
      Effect.catchTags({
        SchemaError: unreadable(database.file, "an entry", ""),
        SqlError: failedOperation(database),
      }),
    );
    const browse = Effect.fn("LogReader.browse")(
      function* (limit: number, offset: number) {
        return yield* inSnapshot(Effect.all({ total: count, found: page(limit, offset) }));
      },
      Effect.map(({ total, found }) => ({ total, ...found })),
      Effect.catchTag("SqlError", failedOperation(database)),
    );
    const searchText = Effect.fn("LogReader.searchText")(
      function* (query: string, limit: number) {
        const expression = toMatchExpression(query);
        if (Option.isNone(expression)) {
          return withHasMore([], limit);
        }
        yield* verifySchemaIn(sql, database);
        const words = searchWords(query);
        const longWords = words.filter((word) => isPastTokenLimit(word));
        const matches =
          longWords.length > 0
            ? (yield* findEveryMatch(expression.value)).filter((entry) =>
                hasEveryLongWord(entry.content, longWords),
              )
            : yield* findMatches({ expression: expression.value, limit: limit + 1 });
        return withHasMore(
          matches.map(({ id, datetime, content }) => ({
            id,
            datetime,
            content,
            preview: previewAround(content, words),
          })),
          limit,
        );
      },
      Effect.catchTags({
        SchemaError: unreadable(database.file, "an entry", ""),
        SqlError: failedOperation(database),
      }),
    );
    const readIds = Effect.fn("LogReader.readIds")(
      function* (ids: readonly number[]) {
        const rows = yield* Effect.forEach(ids, (id) =>
          findById(id).pipe(
            Effect.map((row) => ({ id, row })),
            Effect.catchTag(
              "SchemaError",
              unreadable(database.file, `${database.name} #${id}`, ""),
            ),
          ),
        );
        const missing = rows.filter(({ row }) => Option.isNone(row)).map(({ id }) => id);
        if (missing.length > 0) {
          return yield* new EntriesNotFoundError({
            log: database.name,
            ids: missing,
            entries: yield* count,
          });
        }
        return rows.flatMap(({ row }) => Option.toArray(row));
      },
      Effect.catchTag("SqlError", failedOperation(database)),
    );
    const read = Effect.fn("LogReader.read")(
      function* (ids: readonly number[]) {
        return yield* inSnapshot(readIds(ids));
      },
      Effect.catchTag("SqlError", failedOperation(database)),
    );
    return { count, browse, searchRecent, searchText, read };
  });

const verifyPragmas = (database: LogDatabase) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe("PRAGMA synchronous = FULL");
    yield* sql.unsafe("PRAGMA wal_autocheckpoint = 0");
    for (const [setting, expected] of EXPECTED_PRAGMAS) {
      const rows = yield* sql.unsafe(`PRAGMA ${setting}`).values;
      const actual = String(rows[0]?.[0]).toLowerCase();
      if (actual !== expected) {
        return yield* new StorageError({
          file: database.file,
          message: `SQLite's ${setting} is ${actual} instead of ${expected}`,
        });
      }
    }
  });

const createSchemaObjects = Effect.flatMap(SqlClient, (sql) =>
  Effect.forEach(INITIALIZE_SCHEMA_SQL, (statement) => sql.unsafe(statement), {
    discard: true,
  }),
);

const initializeSchema = Effect.flatMap(SqlClient, (sql) =>
  sql.withTransaction(createSchemaObjects),
);

const indexerFor = (sql: SqlClient) => (id: number, content: string) =>
  sql`INSERT INTO ${sql(SEARCH_INDEX_TABLE)} (rowid, words) VALUES (${id}, ${searchWords(content).join(" ")})`;

const rebuildSearchIndex = (database: LogDatabase) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const { current, older } = yield* searchIndexIn(sql);
    if (current !== "Absent") {
      return;
    }
    if (older.includes(LEGACY_INDEX_WITH_TRIGGER)) {
      yield* sql`DROP TRIGGER IF EXISTS ${sql(LEGACY_INDEX_TRIGGER)}`;
    }
    for (const table of older) {
      yield* sql`DROP TABLE ${sql(table)}`;
    }
    yield* sql.unsafe(CREATE_SEARCH_INDEX_SQL);
    const entries = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ id: Schema.Int, content: Schema.String }),
      execute: () => sql`SELECT id, content FROM entries`,
    })().pipe(
      Effect.catchTag(
        "SchemaError",
        unreadable(database.file, "an entry", ", so the search index wasn't rebuilt"),
      ),
    );
    const indexWords = indexerFor(sql);
    yield* Effect.forEach(entries, ({ id, content }) => indexWords(id, content), {
      discard: true,
    });
  });

const updateSearchIndex = (database: LogDatabase) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const { hasEntries, current, older } = yield* searchIndexIn(sql);
    const isOutdated = hasEntries && current === "Absent" && older.length > 0;
    if (isOutdated) {
      yield* sql.withTransaction(rebuildSearchIndex(database));
    }
  });

class AppendRehearsed extends Data.TaggedError("AppendRehearsed") {}

const appenderFor = (database: LogDatabase, setup: "initialize" | "rehearse") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* verifyPragmas(database);
    if (setup === "initialize") {
      yield* sql.withTransaction(Effect.andThen(verifySchema(database), createSchemaObjects));
    }
    const indexWords = indexerFor(sql);
    const insertRow = SqlSchema.findOne({
      Request: Schema.Struct({ datetime: Schema.String, content: Schema.String }),
      Result: ENTRY_ROW,
      execute: ({ datetime, content }) =>
        sql`INSERT INTO entries (datetime, content) VALUES (${datetime}, ${content}) RETURNING id, datetime, content`,
    });
    const findNewestDatetime = SqlSchema.findOneOption({
      Request: Schema.Struct({}),
      Result: Schema.Struct({ datetime: Schema.String }),
      execute: () => sql`SELECT datetime FROM entries ORDER BY datetime DESC LIMIT 1`,
    });
    const insertEntry = (content: string) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const newest = yield* findNewestDatetime({});
        const datetime = Option.match(newest, {
          onNone: () => now,
          onSome: (row) => (row.datetime > now ? row.datetime : now),
        });
        const row = yield* insertRow({ datetime, content });
        yield* indexWords(row.id, row.content);
        return row;
      });
    const reportFailures = <Success>(
      inserted: Effect.Effect<Success, Cause.NoSuchElementError | Schema.SchemaError | SqlError>,
    ) =>
      inserted.pipe(
        Effect.catchTags({
          SchemaError: unreadable(database.file, "the inserted entry", ", so no entry was stored"),
          NoSuchElementError: () =>
            Effect.fail(
              new StorageError({ file: database.file, message: "SQLite saved no entry" }),
            ),
          SqlError: failedOperation(database),
        }),
      );
    const append = (content: string) => reportFailures(sql.withTransaction(insertEntry(content)));
    const rehearse = (content: string) =>
      reportFailures(
        sql
          .withTransaction(Effect.andThen(insertEntry(content), Effect.fail(new AppendRehearsed())))
          .pipe(Effect.catchTag("AppendRehearsed", () => Effect.void)),
      );
    return { append, rehearse };
  }).pipe(Effect.catchTag("SqlError", failedOperation(database)));

const sqliteUri = (file: string) => {
  const path = process.platform === "win32" ? `/${file.replaceAll("\\", "/")}` : file;
  return `file:${path.replaceAll("%", "%25").replaceAll("?", "%3f").replaceAll("#", "%23")}`;
};

const connect = (filename: string, mode: { readonly readonly: boolean; readonly wal: boolean }) =>
  Effect.gen(function* () {
    const client = yield* SqliteClient.make({
      filename,
      readonly: mode.readonly,
      create: false,
      noFollow: true,
      disableWAL: !mode.wal,
      busyTimeout: BUSY_TIMEOUT_MILLIS,
    }).pipe(Effect.provideService(Reactivity, yield* makeReactivity));
    return Effect.provideService(SqlClient, client);
  });

const initializeDraft = (draft: LogDatabase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* SqliteClient.make({
        filename: draft.file,
        create: false,
        noFollow: true,
        disableWAL: true,
        busyTimeout: BUSY_TIMEOUT_MILLIS,
      }).pipe(Effect.provideService(Reactivity, yield* makeReactivity));
      yield* initializeSchema.pipe(Effect.provideService(SqlClient, client));
    }),
  ).pipe(Effect.catchTag("SqlError", failedOperation(draft)));

const NEWEST_FIRST = Order.combineAll<{
  readonly log: string;
  readonly entry: { readonly id: number; readonly datetime: string };
}>([
  Order.flip(Order.mapInput(Order.String, (result) => result.entry.datetime)),
  Order.mapInput(Order.String, (result) => result.log),
  Order.flip(Order.mapInput(Order.Number, (result) => result.entry.id)),
]);

export class UnstartedLog extends Data.TaggedClass("UnstartedLog")<{
  readonly name: typeof LOG_NAME.Type;
  readonly directory: string;
  readonly hook: typeof HOOK_COMMAND.Type | undefined;
}> {}
export class LogPage extends Data.TaggedClass("LogPage")<{
  readonly name: typeof LOG_NAME.Type;
  readonly directory: string;
  readonly hook: typeof HOOK_COMMAND.Type | undefined;
  readonly total: number;
  readonly entries: readonly (typeof ENTRY_ROW.Type)[];
  readonly hasMore: boolean;
}> {}

const make = Effect.gen(function* () {
  const { directory } = yield* AppConfig;
  const fileSystem = yield* FileSystem;
  const path = yield* Path;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const logs = path.join(directory, "logs");
  const directoryFor = (name: typeof LOG_NAME.Type) => path.join(logs, name);
  const fileFor = (name: typeof LOG_NAME.Type) => path.join(directoryFor(name), DATABASE_FILE);
  const inspect = (file: string) =>
    inspectPath(file).pipe(Effect.provideService(FileSystem, fileSystem));
  const isPresent = (file: string) => Effect.map(inspect(file), (entry) => entry.type !== "Absent");
  const existingDirectory = (candidate: string) =>
    directoryExists(candidate).pipe(Effect.provideService(FileSystem, fileSystem));
  const ensureDirectory = Effect.fn("LogStore.ensureDirectory")(function* (candidate: string) {
    if (!(yield* existingDirectory(candidate))) {
      yield* fileSystem.makeDirectory(candidate, { recursive: true, mode: DIRECTORY_MODE });
      yield* existingDirectory(candidate);
    }
  });
  const listNames = Effect.gen(function* () {
    if (!(yield* existingDirectory(logs))) {
      return [];
    }
    return (yield* fileSystem.readDirectory(logs))
      .filter((entry) => isLogName(entry))
      .toSorted(Order.String);
  }).pipe(Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))));
  const isListed = Effect.fn("LogStore.isListed")(
    function* (name: typeof LOG_NAME.Type) {
      if (!(yield* existingDirectory(directoryFor(name)))) {
        return false;
      }
      const hasConfig = yield* isPresent(path.join(directoryFor(name), CONFIG_FILE));
      return hasConfig || (yield* isPresent(fileFor(name)));
    },
    Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))),
  );
  const hasDirectory = Effect.fn("LogStore.hasDirectory")(
    function* (name: typeof LOG_NAME.Type) {
      return (yield* existingDirectory(logs)) && (yield* existingDirectory(directoryFor(name)));
    },
    Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))),
  );
  const locate = (name: typeof LOG_NAME.Type) =>
    Effect.gen(function* () {
      const isStored = (yield* hasDirectory(name)) && (yield* isPresent(fileFor(name)));
      return isStored
        ? Option.some(new LogDatabase({ name, directory: directoryFor(name), file: fileFor(name) }))
        : Option.none();
    }).pipe(Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))));
  const prepare = Effect.fn("LogStore.prepare")(
    function* (name: typeof LOG_NAME.Type) {
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: DIRECTORY_MODE });
      yield* ensureDirectory(logs);
      yield* ensureDirectory(directoryFor(name));
      return new LogDatabase({ name, directory: directoryFor(name), file: fileFor(name) });
    },
    Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))),
  );
  const nearestExisting = (candidate: string): Effect.Effect<string, PlatformError> =>
    Effect.flatMap(fileSystem.exists(candidate), (isFound) => {
      const parent = path.dirname(candidate);
      const isRoot = parent === candidate;
      const isNearest = isFound || isRoot;
      return isNearest ? Effect.succeed(candidate) : nearestExisting(parent);
    });
  const parentOfDatabase = Effect.fn("LogStore.parentOfDatabase")(function* (
    name: typeof LOG_NAME.Type,
  ) {
    if (!(yield* existingDirectory(logs))) {
      return yield* nearestExisting(directory);
    }
    return (yield* existingDirectory(directoryFor(name))) ? directoryFor(name) : logs;
  });
  const verifyCreatable = Effect.fn("LogStore.verifyCreatable")(
    function* (name: typeof LOG_NAME.Type) {
      yield* fileSystem.access(yield* parentOfDatabase(name), { writable: true });
    },
    Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))),
  );
  const createIfAbsent = Effect.fn("LogStore.createIfAbsent")(
    function* (database: LogDatabase) {
      if ((yield* inspect(database.file)).type !== "Absent") {
        return;
      }
      const realDirectory = yield* fileSystem.realPath(directoryFor(database.name));
      const draft = path.join(realDirectory, `${DRAFT_PREFIX}${yield* secureRandom.uuidV4()}`);
      yield* fileSystem.writeFileString(draft, "", { flag: "wx", mode: FILE_MODE });
      yield* Effect.andThen(
        initializeDraft(
          new LogDatabase({ name: database.name, directory: realDirectory, file: draft }),
        ),
        fileSystem
          .link(draft, database.file)
          .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void)),
      ).pipe(
        Effect.onExit(() =>
          Effect.forEach(
            ["", "-journal"],
            (suffix) => fileSystem.remove(draft + suffix, { force: true }),
            { discard: true },
          ),
        ),
      );
    },
    Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))),
  );
  const removeDraftNames = Effect.fn("LogStore.removeDraftNames")(function* (file: string) {
    const published = yield* fileSystem.stat(file);
    if (Option.getOrElse(published.nlink, () => ONE_NAME) <= ONE_NAME) {
      return;
    }
    const logDirectory = path.dirname(file);
    for (const name of yield* fileSystem.readDirectory(logDirectory)) {
      if (!name.startsWith(DRAFT_PREFIX)) {
        continue;
      }
      const draft = path.join(logDirectory, name);
      const isOtherName = yield* fileSystem.stat(draft).pipe(
        Effect.map((information) => sameFile(published, information)),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      if (isOtherName) {
        yield* fileSystem
          .remove(draft, { force: true })
          .pipe(Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.void));
      }
    }
  });
  const verifiedFile = Effect.fn("LogStore.verifiedFile")(
    function* (database: LogDatabase) {
      const present = new Set<string>();
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const file = database.file + suffix;
        const entry = yield* inspect(file);
        const isMissingDatabase = entry.type === "Absent" && suffix === "";
        if (isMissingDatabase) {
          return yield* new StorageError({
            file,
            message: "the file is missing or isn't a regular file",
          });
        }
        if (entry.type === "Absent") {
          continue;
        }
        present.add(suffix);
        if (entry.type !== "File") {
          return yield* wrongType("a regular file", file, entry.type);
        }
        const isSharedWithOthers =
          process.platform !== "win32" && (entry.mode & GROUP_AND_OTHER_PERMISSIONS) !== 0;
        if (isSharedWithOthers) {
          const mode = (entry.mode & PERMISSION_BITS)
            .toString(OCTAL_RADIX)
            .padStart(OCTAL_MODE_DIGITS, "0");
          return yield* new SharedDatabaseFileError({ file, mode });
        }
        const isReadable = yield* fileSystem.access(file, { readable: true }).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(false)),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
        );
        if (!isReadable) {
          const you = process.getuid?.();
          const isOwnedByYou = you !== undefined && Option.contains(entry.owner, you);
          return yield* new UnreadableDatabaseFileError({ file, isOwnedByYou });
        }
      }
      yield* removeDraftNames(database.file);
      const realDirectory = yield* fileSystem.realPath(directoryFor(database.name));
      const writable = yield* Effect.forEach([realDirectory, database.file], (candidate) =>
        fileSystem.access(candidate, { writable: true }).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(false)),
        ),
      );
      return {
        file: path.join(realDirectory, DATABASE_FILE),
        isWritable: writable.every(Boolean),
        hasWal: present.has("-wal"),
      };
    },
    Effect.catchTag("PlatformError", (cause) => Effect.fail(storageError(cause))),
  );
  const open = <Connection, Failure>(
    database: LogDatabase,
    queryOnly: boolean,
    connection: Effect.Effect<Connection, Failure, SqlClient>,
  ) =>
    Effect.gen(function* () {
      const { readonly, withClient } = yield* Effect.gen(function* () {
        const verified = yield* verifiedFile(database);
        const isReadOnly = queryOnly && !verified.isWritable;
        const isFrozen = isReadOnly && !verified.hasWal;
        const filename = isFrozen ? `${sqliteUri(verified.file)}?immutable=1` : verified.file;
        return {
          readonly: isReadOnly,
          withClient: yield* connect(filename, { readonly: isReadOnly, wal: !queryOnly }),
        };
      }).pipe(Effect.catchTag("SqlError", failedOperation(database)));
      const configure = Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe("PRAGMA trusted_schema = OFF");
        yield* sql.unsafe("PRAGMA recursive_triggers = ON");
        if (!readonly) {
          yield* updateSearchIndex(database);
        }
        if (queryOnly) {
          yield* sql.unsafe("PRAGMA query_only = ON");
        }
      }).pipe(Effect.catchTag("SqlError", failedOperation(database)));
      return yield* Effect.andThen(configure, connection).pipe(withClient);
    });
  const openReader = (database: LogDatabase) => open(database, true, readerFor(database));
  const probeSchema = (database: LogDatabase) =>
    Effect.scoped(
      open(
        database,
        true,
        verifySchema(database).pipe(Effect.catchTag("SqlError", failedOperation(database))),
      ),
    );
  const reading = <Success, Failure, Requirements>(
    database: LogDatabase,
    use: (
      reader: Effect.Success<ReturnType<typeof readerFor>>,
    ) => Effect.Effect<Success, Failure, Requirements>,
  ) => Effect.scoped(Effect.flatMap(openReader(database), use));
  const hookOf = Effect.fn("LogStore.hookOf")(
    function* (name: typeof LOG_NAME.Type) {
      const configFile = path.join(directoryFor(name), CONFIG_FILE);
      if (!(yield* hasDirectory(name))) {
        return { hook: undefined, configFile };
      }
      return { hook: yield* hookCommand(configFile), configFile };
    },
    Effect.provideService(FileSystem, fileSystem),
    Effect.provideService(Path, path),
    (effect, name) =>
      Effect.catchTag(effect, "PlatformError", (cause) =>
        Effect.fail(
          new StorageError({
            cause,
            message: `memo couldn't read the hook for ${name}: ${cause.message}`,
          }),
        ),
      ),
  );
  const eachLog = <Success, Failure, Requirements>(
    use: (name: typeof LOG_NAME.Type) => Effect.Effect<Success, Failure, Requirements>,
  ) =>
    Effect.flatMap(listNames, (names) =>
      Effect.map(
        Effect.forEach(names, (name) =>
          Effect.map(
            Effect.result(
              Effect.flatMap(isListed(name), (listed) =>
                listed ? Effect.asSome(use(name)) : Effect.succeedNone,
              ),
            ),
            (result) => ({ name, result }),
          ),
        ),
        (results) => ({
          found: results.flatMap(({ result }) =>
            Result.isSuccess(result) ? Option.toArray(result.success) : [],
          ),
          unreadable: results.flatMap(({ name, result }) =>
            Result.isFailure(result) ? [{ name, failure: result.failure }] : [],
          ),
        }),
      ),
    );
  const list = Effect.map(
    eachLog((name) =>
      Effect.all({
        name: Effect.succeed(name),
        directory: Effect.succeed(directoryFor(name)),
        entries: Effect.flatMap(locate(name), (database) =>
          Option.match(database, {
            onNone: () => Effect.succeed(0),
            onSome: (stored) => reading(stored, (reader) => reader.count),
          }),
        ),
        hook: Effect.map(hookOf(name), ({ hook }) => hook),
      }),
    ),
    (each) => ({ logs: each.found, unreadable: each.unreadable }),
  );
  const append = Effect.fn("LogStore.append")(function* (
    name: typeof LOG_NAME.Type,
    content: string,
  ) {
    const database = yield* prepare(name);
    yield* createIfAbsent(database);
    yield* probeSchema(database);
    const appender = yield* open(database, false, appenderFor(database, "initialize"));
    return yield* appender.append(content);
  }, Effect.scoped);
  const check = Effect.fn("LogStore.check")(function* (
    name: typeof LOG_NAME.Type,
    content: string,
  ) {
    const database = yield* locate(name);
    if (Option.isNone(database)) {
      return yield* verifyCreatable(name);
    }
    yield* probeSchema(database.value);
    const appender = yield* open(database.value, false, appenderFor(database.value, "rehearse"));
    yield* appender.rehearse(content);
  }, Effect.scoped);
  const browse = Effect.fn("LogStore.browse")(function* (
    name: typeof LOG_NAME.Type,
    limit: number,
    offset: number,
  ) {
    const { hook } = yield* hookOf(name);
    const database = yield* locate(name);
    if (Option.isNone(database)) {
      if (!(yield* hasDirectory(name))) {
        return yield* new LogNotFoundError({ log: name, directory: directoryFor(name) });
      }
      return new UnstartedLog({ name, directory: directoryFor(name), hook });
    }
    const page = yield* reading(database.value, (reader) => reader.browse(limit, offset));
    return new LogPage({ name, directory: directoryFor(name), hook, ...page });
  });
  const read = Effect.fn("LogStore.read")(function* (
    name: typeof LOG_NAME.Type,
    ids: readonly number[],
  ) {
    const database = yield* locate(name);
    if (Option.isNone(database)) {
      return yield* new LogNotFoundError({ log: name, directory: directoryFor(name) });
    }
    return yield* reading(database.value, (reader) => reader.read(ids));
  });
  const entriesIn = Effect.fn("LogStore.entriesIn")(function* (
    name: typeof LOG_NAME.Type,
    query: Option.Option<string>,
    limit: number,
  ) {
    const database = yield* locate(name);
    if (Option.isNone(database)) {
      if (!(yield* hasDirectory(name))) {
        return yield* new LogNotFoundError({ log: name, directory: directoryFor(name) });
      }
      return { entries: [], hasMore: false };
    }
    const found = yield* reading(database.value, (reader) =>
      Option.isSome(query) ? reader.searchText(query.value, limit) : reader.searchRecent(limit),
    );
    return {
      entries: found.entries.map((entry) => ({ log: name, entry })),
      hasMore: found.hasMore,
    };
  });
  const search = Effect.fn("LogStore.search")(function* (
    log: Option.Option<typeof LOG_NAME.Type>,
    query: Option.Option<string>,
    limit: number,
  ) {
    const searched = Option.isSome(log)
      ? { found: [yield* entriesIn(log.value, query, limit)], unreadable: [] }
      : yield* eachLog((name) => entriesIn(name, query, limit));
    const sorted = searched.found.flatMap(({ entries }) => entries).toSorted(NEWEST_FIRST);
    return {
      entries: sorted.slice(0, limit),
      hasMore: sorted.length > limit || searched.found.some(({ hasMore }) => hasMore),
      logsSearched: searched.found.length,
      unreadable: searched.unreadable,
    };
  });
  return { logsDirectory: logs, list, hookOf, append, check, browse, read, search };
});

export class LogStore extends Context.Service<LogStore, Effect.Success<typeof make>>()(
  "memo/LogStore",
) {}

export const LogStoreLive = Layer.effect(LogStore, make).pipe(
  Layer.provide(BunCrypto.layerSecureRandom),
);
