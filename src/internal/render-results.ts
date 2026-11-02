import { Data, DateTime, Effect, Match, Schema } from "effect";
import type { Context } from "effect";

import { previewFromStart } from "./choose-previews.ts";
import { HOOK_COMMAND } from "./read-memo-config.ts";
import { HOOK_TIME_LIMIT_TEXT } from "./run-validation-hooks.ts";
import type { HookRunner } from "./run-validation-hooks.ts";
import { sanitize } from "./sanitize-terminal-text.ts";
import type { ENTRY_ROW } from "./store-logs-in-sqlite.ts";

const ENTRY_LINE = Schema.Struct({
  log: Schema.optionalKey(Schema.String),
  id: Schema.Int,
  datetime: Schema.String,
  content: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
});
const CHECK_RESULT_LINE = Schema.Struct({
  log: Schema.String,
  ok: Schema.Boolean,
  checks: Schema.Array(
    Schema.Struct({
      hook: HOOK_COMMAND,
      ok: Schema.Boolean,
      signal: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
const CONFIRMATION_LINE = Schema.Struct({ id: Schema.Int, datetime: Schema.String });
const LOG_LINE = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  entries: Schema.Int,
});
const LOG_DETAILS = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  exists: Schema.Boolean,
  entries: Schema.Int,
  hook: Schema.NullOr(HOOK_COMMAND),
});

const jsonLine =
  <Value, Encoded>(schema: Schema.Codec<Value, Encoded>) =>
  (value: Value) =>
    Effect.map(Schema.encodeEffect(Schema.fromJsonString(schema))(value), (text) => `${text}\n`);

export const code = (text: string) => `\`${text}\``;

export const homeRelative = (file: string, home: string | undefined) => {
  const isHomeUnknown = home === undefined || home === "";
  if (isHomeUnknown) {
    return file;
  }
  const separator = file.charAt(home.length);
  const isSeparator = separator === "/" || separator === "\\";
  const isInHome = file.startsWith(home) && isSeparator;
  return isInHome ? `~${file.slice(home.length)}` : file;
};

const SHELL_SAFE_WORD = /^[\w@%+=:,./-]+$/u;
export const shellWord = (word: string) =>
  SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", String.raw`'\''`)}'`;

export const shellPath = (file: string, home: string | undefined) => {
  const relative = homeRelative(file, home);
  return relative === file ? shellWord(file) : `~/${shellWord(relative.slice("~/".length))}`;
};

const shellCommand = (command: typeof HOOK_COMMAND.Type, home: string | undefined) =>
  command.map((word) => shellPath(word, home)).join(" ");

const TWO_DIGITS = 2;
const twoDigits = (value: number) => String(value).padStart(TWO_DIGITS, "0");

const minuteIn = (datetime: string, timeZone: DateTime.TimeZone) => {
  const local = DateTime.toParts(DateTime.makeZonedUnsafe(datetime, { timeZone }));
  return `${local.year}-${twoDigits(local.month)}-${twoDigits(local.day)} ${twoDigits(local.hour)}:${twoDigits(local.minute)}`;
};

const previewText = (text: string) => sanitize(text.replaceAll("\u0000", " "));

const excerptOf = (entry: typeof ENTRY_ROW.Type & { readonly preview?: string }) =>
  previewText(entry.preview ?? previewFromStart(entry.content));

const accent = (text: string, color: boolean) => (color ? `\u001B[36m${text}\u001B[0m` : text);
const muted = (text: string, color: boolean) => (color ? `\u001B[2m${text}\u001B[0m` : text);

export const entryReference = (log: string, id: number) => `${sanitize(log)} #${id}`;

const humanBlock = (header: string, body: string) => {
  const safe = sanitize(body);
  return safe === "" ? `${header}\n` : `${header}\n${safe}\n`;
};

export const confirmationLine = (entry: typeof ENTRY_ROW.Type) =>
  jsonLine(CONFIRMATION_LINE)({ id: entry.id, datetime: entry.datetime });

export const humanConfirmation = (log: string, entry: typeof ENTRY_ROW.Type) =>
  `Appended ${entryReference(log, entry.id)}.\n`;

export const entryLines = (
  entries: readonly {
    readonly log: string;
    readonly entry: typeof ENTRY_ROW.Type & { readonly preview?: string };
  }[],
  options: { readonly full: boolean; readonly includeLog: boolean },
) =>
  Effect.map(
    Effect.forEach(entries, ({ entry, log }) =>
      jsonLine(ENTRY_LINE)({
        ...(options.includeLog ? { log } : {}),
        id: entry.id,
        datetime: entry.datetime,
        ...(options.full ? { content: entry.content } : { preview: excerptOf(entry) }),
      }),
    ),
    (lines) => lines.join(""),
  );

export const humanEntries = (
  entries: Parameters<typeof entryLines>[0],
  options: {
    readonly full: boolean;
    readonly color: boolean;
    readonly includeLog: boolean;
    readonly timeZone: DateTime.TimeZone;
  },
) =>
  entries
    .map(({ entry, log }) => {
      const reference = options.includeLog ? entryReference(log, entry.id) : `#${entry.id}`;
      const header = `${accent(reference, options.color)}  ${muted(minuteIn(entry.datetime, options.timeZone), options.color)}`;
      if (options.full) {
        return humanBlock(header, entry.content);
      }
      const excerpt = excerptOf(entry);
      return humanBlock(header, excerpt === "" ? excerpt : excerpt.replaceAll(/^/gmu, "  "));
    })
    .join("\n");

export const checkResultLine = (
  log: string,
  verdict: Effect.Success<ReturnType<Context.Service.Shape<typeof HookRunner>["check"]>>,
) =>
  jsonLine(CHECK_RESULT_LINE)(
    Match.valueTags(verdict, {
      NoHook: () => ({ log, ok: true, checks: [] }),
      HookAccepted: ({ hook }) => ({ log, ok: true, checks: [{ hook, ok: true }] }),
      HookRejected: ({ hook, reason }) => ({
        log,
        ok: false,
        checks: [{ hook, ok: false, message: reason }],
      }),
      HookTimedOut: ({ hook }) => ({
        log,
        ok: false,
        checks: [
          { hook, ok: false, message: `the hook didn't finish within ${HOOK_TIME_LIMIT_TEXT}` },
        ],
      }),
      HookKilled: ({ hook, signal, reason }) => ({
        log,
        ok: false,
        checks: [
          {
            hook,
            ok: false,
            signal,
            message: reason ?? `the hook was killed by ${signal} and wrote no reason to stderr`,
          },
        ],
      }),
    }),
  );

export const humanCheckResult = (
  log: string,
  verdict: Exclude<
    Parameters<typeof checkResultLine>[1],
    { readonly _tag: "HookKilled" | "HookRejected" | "HookTimedOut" }
  >,
) =>
  Match.valueTags(verdict, {
    NoHook: () => `${sanitize(log)} has no hook, so memo append would save this content.\n`,
    HookAccepted: () => `The hook for ${sanitize(log)} accepted the content.\n`,
  });

export const entryCount = (entries: number) => {
  if (entries === 0) {
    return "no entries";
  }
  return entries === 1 ? "1 entry" : `${entries} entries`;
};

export class NoHookConfigured extends Data.TaggedClass("NoHookConfigured") {}
export class HookConfigured extends Data.TaggedClass("HookConfigured")<{
  readonly hook: typeof HOOK_COMMAND.Type;
}> {}
export const hookClause = (status: HookConfigured | NoHookConfigured, home: string | undefined) =>
  Match.valueTags(status, {
    NoHookConfigured: () => "",
    HookConfigured: ({ hook }) => `, and its hook is ${code(sanitize(shellCommand(hook, home)))}`,
  });

const logSentence = (
  log: {
    readonly name: string;
    readonly entries: number;
    readonly hook: Parameters<typeof hookClause>[0];
  },
  home: string | undefined,
) => `${sanitize(log.name)} has ${entryCount(log.entries)}${hookClause(log.hook, home)}.`;

export const logLines = (
  logs: readonly { readonly name: string; readonly directory: string; readonly entries: number }[],
) =>
  Effect.map(
    Effect.forEach(logs, ({ name, directory, entries }) =>
      jsonLine(LOG_LINE)({ name, directory, entries }),
    ),
    (lines) => lines.join(""),
  );

const createFirstLog = `Run ${code("memo append <content> --log <log>")} to create one.`;

export const humanNoLogs = (logsDirectory: string, home: string | undefined) =>
  `There are no logs in ${code(sanitize(homeRelative(logsDirectory, home)))} yet.\n\n${createFirstLog}\n`;

export const humanLogsResult = (
  logsDirectory: string,
  logs: readonly Parameters<typeof logSentence>[0][],
  unreadable: readonly string[],
  home: string | undefined,
) => {
  const total = logs.length + unreadable.length;
  if (total === 0) {
    return humanNoLogs(logsDirectory, home);
  }
  const place = code(sanitize(homeRelative(logsDirectory, home)));
  const summary =
    total === 1 ? `There's 1 log in ${place}.` : `There are ${total} logs in ${place}.`;
  const sentences = [
    ...logs.map((log) => logSentence(log, home)),
    ...unreadable.map((name) => `${sanitize(name)} can't be read.`),
  ];
  return `${summary}\n\n${sentences.map((sentence) => `${sentence}\n`).join("")}`;
};

export const logDetailsLine = jsonLine(LOG_DETAILS);

export const humanLogDetails = (
  log: Parameters<typeof logSentence>[0] & { readonly directory: string },
  home: string | undefined,
) =>
  [
    logSentence(log, home),
    `Its folder is ${code(sanitize(homeRelative(log.directory, home)))}.`,
    "",
  ].join("\n");

export const humanUnstartedLog = (
  log: Parameters<typeof humanLogDetails>[0],
  home: string | undefined,
) =>
  `${humanLogDetails(log, home)}\nRun ${code(`memo append <content> --log ${sanitize(log.name)}`)} to add its first entry.\n`;
