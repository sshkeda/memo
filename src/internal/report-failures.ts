import { Cause, Effect, Match, Option, Schema } from "effect";
import { CliError } from "effect/cli";

import type {
  CheckRejectedError,
  ConfigFileError,
  ConfigFileTypeError,
  ConfigurationError,
  DamagedLogError,
  DataDirectoryTypeError,
  DataDirectoryUnsetError,
  EntriesNotFoundError,
  EntryDecodeError,
  HookCommandNotFoundError,
  HookKilledError,
  HookLaunchError,
  HookRejectedError,
  HookTimedOutError,
  InvalidInputError,
  LogLockedError,
  LogNotFoundError,
  OutdatedSearchIndexError,
  OutputEncodeError,
  SharedDatabaseFileError,
  StandardOutputClosedError,
  StandardStreamError,
  StorageError,
  UnreadableDatabaseFileError,
} from "./memo-errors.ts";
import {
  code,
  entryCount,
  entryReference,
  homeRelative,
  shellPath,
  shellWord,
} from "./render-results.ts";
import { HOOK_TIME_LIMIT_TEXT } from "./run-validation-hooks.ts";
import { sanitize } from "./sanitize-terminal-text.ts";
import { BUSY_TIMEOUT_TEXT } from "./store-logs-in-sqlite.ts";

const KILLED_BY_SIGNAL_EXIT_CODE_OFFSET = 128;
const SIGPIPE = 13;
const EXIT_CODE = {
  Success: 0,
  Failure: 1,
  InvalidUsage: 2,
  BrokenPipe: KILLED_BY_SIGNAL_EXIT_CODE_OFFSET + SIGPIPE,
} as const;

const HOOK_COMMAND_FAULTS = {
  NotOnPath: "isn't on PATH",
  NotExecutable: "isn't an executable file",
  NotAProgram: "isn't a program the system can run (ENOEXEC)",
  InterpreterNotFound: "starts with a #! line whose interpreter isn't installed",
} as const;

const reasonText = (reason: string) => (reason.includes("\n") ? `\n${reason}` : ` ${reason}`);

const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(", ");
const LIST = new Intl.ListFormat("en", { type: "conjunction" });

const OPERANDS_SEPARATOR = "--";
const NEGATIVE_NUMBER = /^-(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
const SHORT_FLAGS_TOGETHER = /^-[^-]./su;
const FLAG_AND_VALUE = 2;
const AT_MOST_ONE_VALUE = "at most 1 value";

const splitAtSeparator = (argv: readonly string[]) => {
  const separator = argv.indexOf(OPERANDS_SEPARATOR);
  return separator === -1
    ? { flags: argv, operands: [] }
    : { flags: argv.slice(0, separator), operands: argv.slice(separator + 1) };
};

const memoCommand = (argv: readonly string[]) =>
  code(["memo", ...argv].map((word) => shellWord(word)).join(" "));

const COMMANDS_WITH_ONE_TEXT = new Set(["append", "check", "search"]);
const FLAGS_WITH_VALUES = new Set(["--log", "--limit", "--offset"]);

const STANDARD_INPUT_WORD = "-";

const isFlagWord = (word: string) =>
  word.startsWith("-") && word !== STANDARD_INPUT_WORD && !NEGATIVE_NUMBER.test(word);

const positionalWords = (words: readonly string[]) =>
  words.filter(
    (word, position) => !isFlagWord(word) && !FLAGS_WITH_VALUES.has(words[position - 1] ?? ""),
  );

const leavesOneText = (commandPath: readonly string[], argv: readonly string[]) => {
  const { flags, operands } = splitAtSeparator(argv);
  const texts = [...positionalWords(flags.slice(commandPath.length - 1)), ...operands];
  return COMMANDS_WITH_ONE_TEXT.has(commandPath.at(-1) ?? "") && texts.length === 1;
};

const isShortFlags = (word: string) =>
  word.startsWith("-") && !word.startsWith(OPERANDS_SEPARATOR) && !NEGATIVE_NUMBER.test(word);

const shortFlagsIn = (word: string) => {
  const names = word.slice(1);
  const equals = names.indexOf("=");
  return Array.from(equals === -1 ? names : names.slice(0, equals), (letter) => `-${letter}`);
};

const isUsableValue = (value: string | undefined) =>
  value !== undefined && value !== "" && !isFlagWord(value);

const flagAfterSeparator = (
  argv: readonly string[],
  flag: string,
  commandPath: readonly string[],
) => {
  const { flags, operands } = splitAtSeparator(argv);
  const at = operands.findIndex((word) => word === flag || word.startsWith(`${flag}=`));
  if (at === -1) {
    return Option.none<Option.Option<readonly string[]>>();
  }
  const word = operands[at] ?? flag;
  const end = at + (word === flag ? FLAG_AND_VALUE : 1);
  const value = word === flag ? operands[at + 1] : word.slice(flag.length + 1);
  const reordered = [
    ...flags,
    ...operands.slice(at, end),
    OPERANDS_SEPARATOR,
    ...operands.slice(0, at),
    ...operands.slice(end),
  ];
  const isRunnable = isUsableValue(value) && leavesOneText(commandPath, reordered);
  return Option.some(isRunnable ? Option.some(reordered) : Option.none<readonly string[]>());
};

const usageError = (
  error: Exclude<CliError.CliError, CliError.ShowHelp>,
  commandPath: readonly string[],
  argv: readonly string[],
) => {
  const command = commandPath.join(" ");
  const seeHelp = `hint: run ${code(`${command} --help`)}`;
  return Match.valueTags(error, {
    UnknownSubcommand: (unknown) => ({
      error: `error: ${command} has no command ${unknown.subcommand}`,
      hint:
        unknown.suggestions.length > 0
          ? `hint: did you mean ${unknown.suggestions.map((suggestion) => code(`${command} ${suggestion}`)).join(" or ")}?`
          : seeHelp,
    }),
    UnrecognizedOption: (unrecognized) => ({
      error: `error: ${command} has no flag ${unrecognized.option}`,
      hint:
        unrecognized.suggestions.length > 0
          ? `hint: did you mean ${unrecognized.suggestions.join(" or ")}?`
          : seeHelp,
    }),
    MissingOption: (missing) =>
      Option.match(flagAfterSeparator(argv, `--${missing.option}`, commandPath), {
        onNone: () => ({ error: `error: ${command} needs --${missing.option}`, hint: seeHelp }),
        onSome: (reordered) => ({
          error: `error: ${command} needs --${missing.option} before --, because everything after -- is content`,
          hint: Option.match(reordered, {
            onNone: () => seeHelp,
            onSome: (words) => `hint: put flags before --: ${memoCommand(words)}`,
          }),
        }),
      }),
    MissingArgument: (missing) => ({
      error: `error: ${command} needs <${missing.argument}>`,
      hint: seeHelp,
    }),
    UnexpectedArgument: (unexpected) => ({
      error: `error: ${command} doesn't take the extra ${unexpected.arguments.length === 1 ? "argument" : "arguments"} ${quoted(unexpected.arguments)}`,
      hint: seeHelp,
    }),
    InvalidValue: (invalid) => {
      const target = invalid.kind === "flag" ? `--${invalid.option}` : `<${invalid.option}>`;
      if (invalid.expected === AT_MOST_ONE_VALUE) {
        return {
          error: `error: ${target} was given more than once, but memo takes it at most once`,
          hint: seeHelp,
        };
      }
      return {
        error:
          invalid.value === ""
            ? `error: ${target} needs a value`
            : `error: ${quoted([invalid.value])} isn't a valid value for ${target}`,
        hint: seeHelp,
      };
    },
    DuplicateOption: (duplicate) => ({ error: `error: ${duplicate.message}`, hint: seeHelp }),
    ValidationError: (invalid) => ({ error: `error: ${invalid.message}`, hint: seeHelp }),
    UserError: (failed) => ({ error: `error: ${failed.message}`, hint: seeHelp }),
  });
};

const reportForMemoError = (
  error:
    | CheckRejectedError
    | ConfigFileError
    | ConfigFileTypeError
    | ConfigurationError
    | DamagedLogError
    | DataDirectoryTypeError
    | DataDirectoryUnsetError
    | EntriesNotFoundError
    | EntryDecodeError
    | HookCommandNotFoundError
    | HookKilledError
    | HookLaunchError
    | HookRejectedError
    | HookTimedOutError
    | InvalidInputError
    | LogLockedError
    | LogNotFoundError
    | OutdatedSearchIndexError
    | OutputEncodeError
    | SharedDatabaseFileError
    | StandardOutputClosedError
    | StandardStreamError
    | StorageError
    | UnreadableDatabaseFileError,
  home: string | undefined,
): { readonly code: number; readonly lines: readonly string[] } => {
  const stored = (file: string | undefined, message: string) =>
    `error: ${file === undefined ? message : `${homeRelative(file, home)}: ${message}`}`;
  return Match.valueTags(error, {
    HookRejectedError: (rejected) => ({
      code: EXIT_CODE.InvalidUsage,
      lines: [
        `error: the hook for ${rejected.log} rejected the ${rejected.subject}:${reasonText(rejected.reason)}`,
      ],
    }),
    HookKilledError: (killed) => ({
      code: EXIT_CODE.InvalidUsage,
      lines: [
        `error: the hook for ${killed.log} was killed by ${killed.signal}${killed.reason === undefined ? " and wrote no reason to stderr" : `:${reasonText(killed.reason)}`}`,
      ],
    }),
    HookTimedOutError: (timedOut) => ({
      code: EXIT_CODE.InvalidUsage,
      lines: [
        `error: the hook for ${timedOut.log} didn't finish within ${HOOK_TIME_LIMIT_TEXT}`,
        `hint: run the hook yourself on the same stdin to see where it waits, and make it exit within ${HOOK_TIME_LIMIT_TEXT}`,
      ],
    }),
    CheckRejectedError: () => ({ code: EXIT_CODE.InvalidUsage, lines: [] }),
    InvalidInputError: (invalid) => ({
      code: EXIT_CODE.InvalidUsage,
      lines: [`error: ${invalid.message}`, `hint: run ${code(`memo ${invalid.command} --help`)}`],
    }),
    LogNotFoundError: (missing) => ({
      code: EXIT_CODE.Failure,
      lines: [
        `error: there's no log named ${missing.log}`,
        `hint: run ${code("memo read")} to see your logs, or ${code(`memo append <content> --log ${missing.log}`)} to create it in ${code(homeRelative(missing.directory, home))}`,
      ],
    }),
    EntriesNotFoundError: (missing) => {
      const references = LIST.format(missing.ids.map((id) => entryReference(missing.log, id)));
      const reason =
        missing.entries === 0
          ? `${missing.log} has no entries`
          : `${missing.log} has only ${entryCount(missing.entries)}`;
      return {
        code: EXIT_CODE.InvalidUsage,
        lines: [
          `error: ${references} ${missing.ids.length === 1 ? "doesn't" : "don't"} exist, because ${reason}`,
          `hint: run ${code(`memo read ${missing.log}`)}`,
        ],
      };
    },
    ConfigFileError: (invalid) => ({
      code: EXIT_CODE.Failure,
      lines: [stored(invalid.file, `the file ${invalid.fault}`)],
    }),
    ConfigFileTypeError: (invalid) => ({
      code: EXIT_CODE.Failure,
      lines: [stored(invalid.file, `config.json is ${invalid.type}, not a file`)],
    }),
    DataDirectoryTypeError: (invalid) => ({
      code: EXIT_CODE.Failure,
      lines: [
        `error: MEMO_HOME is ${code(invalid.directory)}, which is ${invalid.type}, but it must be a folder`,
      ],
    }),
    LogLockedError: (locked) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(
          locked.file,
          `another process kept the log locked for more than ${BUSY_TIMEOUT_TEXT}`,
        ),
        "hint: wait for it to finish, then run the command again",
      ],
    }),
    UnreadableDatabaseFileError: (unreadable) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(unreadable.file, "memo doesn't have permission to read the file"),
        ...(unreadable.isOwnedByYou
          ? [`hint: run ${code(`chmod 600 ${shellPath(unreadable.file, home)}`)}`]
          : []),
      ],
    }),
    ConfigurationError: (invalid) => ({
      code: EXIT_CODE.Failure,
      lines: [`error: ${invalid.message}`],
    }),
    DataDirectoryUnsetError: (unset) => ({
      code: EXIT_CODE.Failure,
      lines: [
        `error: memo can't find its data folder, because ${LIST.format(unset.variables)} are unset or blank`,
        "hint: set MEMO_HOME to an absolute path",
      ],
    }),
    HookCommandNotFoundError: (missing) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(
          missing.file,
          `the hook command ${code(missing.command)} ${HOOK_COMMAND_FAULTS[missing.reason]}`,
        ),
        ...(missing.reason === "NotAProgram"
          ? [
              `hint: start the script with a line like ${code("#!/bin/sh")}, or put its interpreter first in the hook`,
            ]
          : []),
        ...(missing.reason === "InterpreterNotFound"
          ? [
              `hint: install the interpreter, fix the script's #! line, or put an installed interpreter first in the hook`,
            ]
          : []),
      ],
    }),
    HookLaunchError: (failed) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(
          failed.file,
          `the system couldn't start the hook command ${code(failed.command)} for ${failed.log} (${failed.code})`,
        ),
      ],
    }),
    EntryDecodeError: (failed) => ({
      code: EXIT_CODE.Failure,
      lines: [stored(failed.file, failed.message)],
    }),
    OutputEncodeError: () => ({
      code: EXIT_CODE.Failure,
      lines: ["error: memo couldn't encode its output as JSON"],
    }),
    OutdatedSearchIndexError: (outdated) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(
          outdated.file,
          `${outdated.log}'s search index is from an older memo, and memo needs to write to the log once to update it`,
        ),
        "hint: give yourself write access to the log's folder and its files, then run the command again",
      ],
    }),
    SharedDatabaseFileError: (shared) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(
          shared.file,
          `the file has mode ${shared.mode}, so other users can access it, and memo needs 0600`,
        ),
        `hint: run ${code(`chmod 600 ${shellPath(shared.file, home)}`)}`,
      ],
    }),
    StandardOutputClosedError: () => ({ code: EXIT_CODE.BrokenPipe, lines: [] }),
    StandardStreamError: (failed) => ({
      code: EXIT_CODE.Failure,
      lines: [
        `error: memo couldn't ${failed.stream === "stdin" ? "read" : "write"} ${failed.stream}: ${failed.message}`,
      ],
    }),
    DamagedLogError: (damaged) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(damaged.file, damaged.message),
        `hint: stop anything using ${damaged.log}, then restore its folder ${code(homeRelative(damaged.directory, home))} from a backup, or move that whole folder, -wal and -shm files included, out of the logs folder to keep a copy and start ${damaged.log} over`,
      ],
    }),
    StorageError: (failed) => ({
      code: EXIT_CODE.Failure,
      lines: [
        stored(failed.file, failed.message),
        ...(failed.cause === undefined
          ? []
          : [`hint: run again with ${code("MEMO_DEBUG=1")} to see the cause`]),
      ],
    }),
  });
};

const isShowHelp = Schema.is(CliError.ShowHelp);
const isUnrecognizedOption = Schema.is(CliError.UnrecognizedOption);

const usageErrors = (
  errors: readonly Exclude<CliError.CliError, CliError.ShowHelp>[],
  commandPath: readonly string[],
  argv: readonly string[],
) => {
  const unexplained = new Map<string, number>();
  for (const item of errors) {
    if (isUnrecognizedOption(item)) {
      unexplained.set(item.option, (unexplained.get(item.option) ?? 0) + 1);
    }
  }
  const explained = new Map<string, number>();
  const { flags, operands } = splitAtSeparator(argv);
  const dashTextPositions = new Set<number>();
  for (const [position, word] of flags.entries()) {
    if (!isShortFlags(word)) {
      continue;
    }
    const matched = shortFlagsIn(word).filter((flag) => {
      const left = unexplained.get(flag) ?? 0;
      unexplained.set(flag, left - 1);
      return left > 0;
    });
    const isDashText = matched.length > 0 && SHORT_FLAGS_TOGETHER.test(word);
    if (isDashText) {
      dashTextPositions.add(position);
      for (const flag of matched) {
        explained.set(flag, (explained.get(flag) ?? 0) + 1);
      }
    }
  }
  const dashTexts = flags.filter((_word, position) => dashTextPositions.has(position));
  const kept = flags.filter((_word, position) => !dashTextPositions.has(position));
  const fixed = [...kept, OPERANDS_SEPARATOR, ...dashTexts, ...operands];
  const command = commandPath.join(" ");
  const hint = leavesOneText(commandPath, fixed)
    ? `hint: put -- before text that starts with a dash: ${memoCommand(fixed)}`
    : `hint: run ${code(`${command} --help`)}`;
  return [
    ...dashTexts.map((word) => ({
      error: `error: ${command} has no flag ${word}`,
      hint,
      kind: "UnrecognizedOption",
    })),
    ...errors
      .filter((item) => {
        if (!isUnrecognizedOption(item)) {
          return true;
        }
        const left = explained.get(item.option) ?? 0;
        explained.set(item.option, left - 1);
        return left <= 0;
      })
      .map((item) => {
        const usage = usageError(item, commandPath, argv);
        return { error: usage.error, hint: usage.hint, kind: item._tag };
      }),
  ];
};

const ERROR_PREFIX = "error: ";
const HINT_PREFIX = "hint: ";
const UNREPORTED_FIELDS = new Set(["_tag", "message", "cause"]);
const isJson = Schema.is(Schema.Json);
const FAILURE_OBJECT = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const kindOf = (tag: string) => tag.replace(/Error$/u, "");

const fieldsOf = (error: Parameters<typeof reportForMemoError>[0]) =>
  Object.fromEntries(
    Object.entries(error).filter(
      ([field, value]) => !UNREPORTED_FIELDS.has(field) && isJson(value),
    ),
  );

const reportForError = (
  error: CliError.CliError | Parameters<typeof reportForMemoError>[0],
  home: string | undefined,
  argv: readonly string[],
): {
  readonly code: number;
  readonly kind: string;
  readonly fields: Readonly<Record<string, Schema.Json>>;
  readonly lines: readonly string[];
} => {
  if (!CliError.isCliError(error)) {
    return {
      ...reportForMemoError(error, home),
      kind: kindOf(error._tag),
      fields: fieldsOf(error),
    };
  }
  if (!isShowHelp(error)) {
    const usage = usageError(error, ["memo"], argv);
    return {
      code: EXIT_CODE.InvalidUsage,
      kind: error._tag,
      fields: {},
      lines: [usage.error, usage.hint],
    };
  }
  const [first, ...rest] = usageErrors(error.errors, error.commandPath, argv);
  if (first === undefined) {
    return { code: EXIT_CODE.Success, kind: "ShowHelp", fields: {}, lines: [] };
  }
  return {
    code: EXIT_CODE.InvalidUsage,
    kind: first.kind,
    fields: {},
    lines: [first.error, ...rest.map((usage) => usage.error), first.hint],
  };
};

const failureObject = (report: ReturnType<typeof reportForError>, cause: Option.Option<string>) => {
  const hint = report.lines.find((line) => line.startsWith(HINT_PREFIX));
  const message = report.lines
    .filter((line) => !line.startsWith(HINT_PREFIX))
    .map((line) => (line.startsWith(ERROR_PREFIX) ? line.slice(ERROR_PREFIX.length) : line))
    .join("\n");
  return {
    error: report.kind,
    message,
    ...(hint === undefined ? {} : { hint: hint.slice(HINT_PREFIX.length) }),
    ...report.fields,
    ...Option.match(cause, { onNone: () => ({}), onSome: (pretty) => ({ cause: pretty }) }),
  };
};

const UNEXPECTED_REPORT = {
  code: EXIT_CODE.Failure,
  kind: "Unexpected",
  fields: {},
  lines: [
    "error: memo failed for an unexpected reason",
    `hint: run again with ${code("MEMO_DEBUG=1")} to see the cause`,
  ],
};

const renderReport = (
  report: ReturnType<typeof reportForError>,
  detail: Option.Option<string>,
  json: boolean,
): Effect.Effect<readonly string[]> => {
  if (report.lines.length === 0) {
    return Effect.succeed([]);
  }
  if (json) {
    return Schema.encodeEffect(FAILURE_OBJECT)(failureObject(report, detail)).pipe(
      Effect.map((text) => [text]),
      Effect.catchTag("SchemaError", (encodeFailure) => Effect.die(encodeFailure)),
    );
  }
  return Effect.succeed([...report.lines, ...Option.toArray(detail)].map((line) => sanitize(line)));
};

export const reportFor = (
  cause: Cause.Cause<CliError.CliError | Parameters<typeof reportForMemoError>[0]>,
  options: {
    readonly argv: readonly string[];
    readonly debug: boolean;
    readonly home: string | undefined;
    readonly json: boolean;
  },
): Effect.Effect<{ readonly code: number; readonly lines: readonly string[] }> => {
  const failures = cause.reasons.filter(Cause.isFailReason);
  const detailOf = (part: Cause.Cause<unknown>) =>
    options.debug ? Option.some(Cause.pretty(part)) : Option.none<string>();
  const [first] = failures;
  if (first === undefined) {
    return Effect.map(renderReport(UNEXPECTED_REPORT, detailOf(cause), options.json), (lines) => ({
      code: UNEXPECTED_REPORT.code,
      lines,
    }));
  }
  const isSingle = failures.length === 1;
  return Effect.map(
    Effect.forEach(failures, (failure) =>
      renderReport(
        reportForError(failure.error, options.home, options.argv),
        detailOf(isSingle ? cause : Cause.fromReasons([failure])),
        options.json,
      ),
    ),
    (rendered) => ({
      code: reportForError(first.error, options.home, options.argv).code,
      lines: rendered.flat(),
    }),
  );
};
