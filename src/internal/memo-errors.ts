import { Cause, Effect, Schema } from "effect";

export const MEMO_COMMAND = Schema.Literals(["append", "search", "read", "check"]);

export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()(
  "InvalidInputError",
  { command: MEMO_COMMAND, message: Schema.String },
) {}
export class LogNotFoundError extends Schema.TaggedError<LogNotFoundError>()("LogNotFoundError", {
  log: Schema.String,
  directory: Schema.String,
}) {}
export class EntriesNotFoundError extends Schema.TaggedError<EntriesNotFoundError>()(
  "EntriesNotFoundError",
  { log: Schema.String, ids: Schema.Array(Schema.Int), entries: Schema.Int },
) {}
export class HookRejectedError extends Schema.TaggedError<HookRejectedError>()(
  "HookRejectedError",
  { log: Schema.String, subject: Schema.Literals(["entry", "content"]), reason: Schema.String },
) {}
export class HookKilledError extends Schema.TaggedError<HookKilledError>()("HookKilledError", {
  log: Schema.String,
  signal: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}
export class HookTimedOutError extends Schema.TaggedError<HookTimedOutError>()(
  "HookTimedOutError",
  { log: Schema.String },
) {}
export class CheckRejectedError extends Schema.TaggedError<CheckRejectedError>()(
  "CheckRejectedError",
  {},
) {}
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  { message: Schema.String },
) {}
export class DataDirectoryUnsetError extends Schema.TaggedError<DataDirectoryUnsetError>()(
  "DataDirectoryUnsetError",
  { variables: Schema.Array(Schema.String) },
) {}
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  file: Schema.String,
  fault: Schema.String,
}) {}
export class ConfigFileTypeError extends Schema.TaggedError<ConfigFileTypeError>()(
  "ConfigFileTypeError",
  { file: Schema.String, type: Schema.String },
) {}
export class DataDirectoryTypeError extends Schema.TaggedError<DataDirectoryTypeError>()(
  "DataDirectoryTypeError",
  { directory: Schema.String, type: Schema.String },
) {}
export class LogLockedError extends Schema.TaggedError<LogLockedError>()("LogLockedError", {
  file: Schema.String,
  cause: Schema.Defect(),
}) {}
export class UnreadableDatabaseFileError extends Schema.TaggedError<UnreadableDatabaseFileError>()(
  "UnreadableDatabaseFileError",
  { file: Schema.String, isOwnedByYou: Schema.Boolean },
) {}
export class HookCommandNotFoundError extends Schema.TaggedError<HookCommandNotFoundError>()(
  "HookCommandNotFoundError",
  {
    file: Schema.String,
    command: Schema.String,
    reason: Schema.Literals(["NotOnPath", "NotExecutable", "NotAProgram", "InterpreterNotFound"]),
  },
) {}
export class HookLaunchError extends Schema.TaggedError<HookLaunchError>()("HookLaunchError", {
  file: Schema.String,
  log: Schema.String,
  command: Schema.String,
  code: Schema.String,
  cause: Schema.Defect(),
}) {}
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  file: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
export class DamagedLogError extends Schema.TaggedError<DamagedLogError>()("DamagedLogError", {
  file: Schema.String,
  directory: Schema.String,
  log: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
export class OutdatedSearchIndexError extends Schema.TaggedError<OutdatedSearchIndexError>()(
  "OutdatedSearchIndexError",
  { file: Schema.String, log: Schema.String },
) {}
export class SharedDatabaseFileError extends Schema.TaggedError<SharedDatabaseFileError>()(
  "SharedDatabaseFileError",
  { file: Schema.String, mode: Schema.String },
) {}
export class StandardStreamError extends Schema.TaggedError<StandardStreamError>()(
  "StandardStreamError",
  {
    stream: Schema.Literals(["stdin", "stdout", "stderr"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
export class OutputEncodeError extends Schema.TaggedError<OutputEncodeError>()(
  "OutputEncodeError",
  { cause: Schema.instanceOf(Schema.SchemaError) },
) {}
export class StandardOutputClosedError extends Schema.TaggedError<StandardOutputClosedError>()(
  "StandardOutputClosedError",
  {},
) {}
export class EntryDecodeError extends Schema.TaggedError<EntryDecodeError>()("EntryDecodeError", {
  file: Schema.String,
  message: Schema.String,
  cause: Schema.instanceOf(Schema.SchemaError),
}) {}

export const failEach = <Failure>(failures: readonly [Failure, ...Failure[]]) =>
  Effect.failCause(Cause.fromReasons(failures.map((failure) => Cause.makeFailReason(failure))));
