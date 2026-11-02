import { Data, DateTime, Effect, Match, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { integerArgument, integerFlag, jsonFlag, limitFlag } from "./command-options.ts";
import { failEach, InvalidInputError } from "./memo-errors.ts";
import { userHome, outputColor } from "./read-memo-config.ts";
import type { HOOK_COMMAND } from "./read-memo-config.ts";
import {
  code,
  entryLines,
  HookConfigured,
  humanEntries,
  humanLogDetails,
  humanLogsResult,
  humanUnstartedLog,
  logDetailsLine,
  logLines,
  NoHookConfigured,
} from "./render-results.ts";
import type { hookClause } from "./render-results.ts";
import { writeResult, writeStandardError } from "./standard-streams.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  LogStore,
  MAX_SEARCH_LIMIT,
  validateLogName,
  validateSearchLimit,
  validateSearchOffset,
} from "./store-logs-in-sqlite.ts";
import type { LOG_NAME, LogPage, UnstartedLog } from "./store-logs-in-sqlite.ts";

class ListLogs extends Data.TaggedClass("ListLogs") {}
class BrowseLog extends Data.TaggedClass("BrowseLog")<{
  readonly name: typeof LOG_NAME.Type;
  readonly limit: number;
  readonly offset: number;
}> {}
class ReadIds extends Data.TaggedClass("ReadIds")<{
  readonly name: typeof LOG_NAME.Type;
  readonly ids: readonly number[];
}> {}

const invalidRead = (message: string) => new InvalidInputError({ command: "read", message });

const parseReadRequest = Effect.fn("parseReadRequest")(function* (input: {
  readonly log: Option.Option<string>;
  readonly ids: readonly number[];
  readonly limit: Option.Option<number>;
  readonly offset: Option.Option<number>;
}) {
  const isPaging = Option.isSome(input.limit) || Option.isSome(input.offset);
  if (Option.isNone(input.log)) {
    if (isPaging) {
      return yield* invalidRead("memo read needs a log to use --limit or --offset");
    }
    return new ListLogs();
  }
  const name = yield* Effect.fromResult(validateLogName(input.log.value, "read"));
  const limit = yield* Effect.fromResult(
    validateSearchLimit(
      Option.getOrElse(input.limit, () => DEFAULT_SEARCH_LIMIT),
      "read",
    ),
  );
  const offset = yield* Effect.fromResult(
    validateSearchOffset(Option.getOrElse(input.offset, () => 0)),
  );
  if (input.ids.length === 0) {
    return new BrowseLog({ name, limit, offset });
  }
  if (isPaging) {
    return yield* invalidRead("memo read can't use --limit or --offset with entry IDs");
  }
  if (input.ids.length > MAX_SEARCH_LIMIT) {
    return yield* invalidRead(
      `memo read can show at most ${MAX_SEARCH_LIMIT} entries at once, not ${input.ids.length}`,
    );
  }
  const invalidId = input.ids.find((id) => id < 1);
  if (invalidId !== undefined) {
    return yield* invalidRead(`${invalidId} isn't a valid entry ID, because IDs start at 1`);
  }
  return new ReadIds({ name, ids: input.ids });
});

const hookStatus = (hook: typeof HOOK_COMMAND.Type | undefined) =>
  hook === undefined ? new NoHookConfigured() : new HookConfigured({ hook });

const hookFields = (status: Parameters<typeof hookClause>[0]) =>
  Match.valueTags(status, {
    NoHookConfigured: () => ({ hook: null }),
    HookConfigured: ({ hook }) => ({ hook }),
  });

const writeLogList = Effect.fn("writeLogList")(function* (json: boolean) {
  const logStore = yield* LogStore;
  const listed = yield* logStore.list;
  const logs = listed.logs.map(({ name, directory, entries, hook }) => ({
    name,
    directory,
    entries,
    hook: hookStatus(hook),
  }));
  yield* writeResult(
    logLines(logs),
    humanLogsResult(
      logStore.logsDirectory,
      logs,
      listed.unreadable.map(({ name }) => name),
      yield* userHome,
    ),
    json,
  );
  const [first, ...rest] = listed.unreadable.map(({ failure }) => failure);
  if (first !== undefined) {
    return yield* failEach([first, ...rest]);
  }
});

const nextPageCommand = (request: BrowseLog, json: boolean) =>
  code(
    [
      `memo read ${request.name} --offset ${request.offset + request.limit}`,
      ...(request.limit === DEFAULT_SEARCH_LIMIT ? [] : [`--limit ${request.limit}`]),
      ...(json ? ["--json"] : []),
    ].join(" "),
  );

const pageFooter = (
  request: BrowseLog,
  page: { readonly ids: readonly number[]; readonly total: number; readonly hasMore: boolean },
  json: boolean,
) => {
  const [first] = page.ids;
  const last = page.ids.at(-1);
  const isEmptyPage = first === undefined || last === undefined;
  if (isEmptyPage) {
    const isPastTheEnd = request.offset > 0 && page.total > 0;
    return isPastTheEnd
      ? Option.some(`${request.name} has no entries after #${page.total}.`)
      : Option.none();
  }
  const range = first === last ? `#${first}` : `#${first} to #${last}`;
  const showing = `Showing ${range} of ${page.total}.`;
  if (page.hasMore) {
    return Option.some(`${showing} Run ${nextPageCommand(request, json)} to see more.`);
  }
  return request.offset > 0 ? Option.some(showing) : Option.none();
};

const writeUnstartedLog = Effect.fn("writeUnstartedLog")(function* (
  log: UnstartedLog,
  json: boolean,
) {
  const { name, directory } = log;
  const hook = hookStatus(log.hook);
  yield* writeResult(
    logDetailsLine({ name, directory, exists: false, entries: 0, ...hookFields(hook) }),
    humanUnstartedLog({ name, directory, entries: 0, hook }, yield* userHome),
    json,
  );
});

const writeLogPage = Effect.fn("writeLogPage")(function* (
  request: BrowseLog,
  page: LogPage,
  json: boolean,
  color: boolean,
) {
  const { name, directory, total, entries, hasMore } = page;
  const hook = hookStatus(page.hook);
  const logged = entries.map((entry) => ({ log: name, entry }));
  const footer = pageFooter(
    request,
    { ids: entries.map((entry) => entry.id), total, hasMore },
    json,
  );
  const details = humanLogDetails({ name, directory, entries: total, hook }, yield* userHome);
  const listed =
    logged.length === 0
      ? ""
      : `\n${humanEntries(logged, { full: false, color, includeLog: false, timeZone: DateTime.zoneMakeLocal() })}`;
  const footerText = Option.match(footer, { onNone: () => "", onSome: (text) => `\n${text}\n` });
  yield* writeResult(
    Effect.zipWith(
      logDetailsLine({ name, directory, exists: true, entries: total, ...hookFields(hook) }),
      entryLines(logged, { full: false, includeLog: false }),
      (detailsLine, lines) => detailsLine + lines,
    ),
    `${details}${listed}${footerText}`,
    json,
  );
  const hasMoreAsJson = json && hasMore;
  if (hasMoreAsJson) {
    yield* writeStandardError(
      Option.match(footer, { onNone: () => "", onSome: (text) => `${text}\n` }),
    );
  }
});

const browseLog = Effect.fn("browseLog")(function* (
  request: BrowseLog,
  json: boolean,
  color: boolean,
) {
  const browsed = yield* Effect.flatMap(LogStore, (logStore) =>
    logStore.browse(request.name, request.limit, request.offset),
  );
  yield* Match.valueTags(browsed, {
    UnstartedLog: (log) => writeUnstartedLog(log, json),
    LogPage: (page) => writeLogPage(request, page, json, color),
  });
});

const writeFullEntries = Effect.fn("writeFullEntries")(function* (
  request: ReadIds,
  json: boolean,
  color: boolean,
) {
  const { name, ids } = request;
  const entries = yield* Effect.flatMap(LogStore, (logStore) => logStore.read(name, ids));
  const logged = entries.map((entry) => ({ log: name, entry }));
  yield* writeResult(
    entryLines(logged, { full: true, includeLog: false }),
    humanEntries(logged, {
      full: true,
      color,
      includeLog: false,
      timeZone: DateTime.zoneMakeLocal(),
    }),
    json,
  );
});

export const readCommand = Command.make(
  "read",
  {
    log: Argument.String("log").pipe(
      Argument.withDescription("The log to show. Leave it out to list your logs."),
      Argument.optional,
    ),
    ids: integerArgument("id").pipe(
      Argument.withDescription("The IDs of the entries to show in full, as in 3 for work #3."),
      Argument.variadic({ min: 0 }),
    ),
    json: jsonFlag(
      "Print one JSON object per line. When you browse a log, the first line describes the log, and each other line is an entry. When you give entry IDs, each line is one of those entries.",
    ),
    limit: limitFlag(
      `Show this many entries. The default is ${DEFAULT_SEARCH_LIMIT}, and the most is ${MAX_SEARCH_LIMIT}.`,
    ).pipe(Flag.optional),
    offset: integerFlag("offset").pipe(
      Flag.withDescription("Skip this many entries first. The default is 0."),
      Flag.optional,
    ),
  },
  ({ json, ...input }) =>
    Effect.gen(function* () {
      const color = !json && (yield* outputColor);
      const request = yield* parseReadRequest(input);
      yield* Match.valueTags(request, {
        ListLogs: () => writeLogList(json),
        BrowseLog: (browse) => browseLog(browse, json, color),
        ReadIds: (read) => writeFullEntries(read, json, color),
      });
    }),
).pipe(
  Command.withShortDescription("List your logs, or show a log's entries."),
  Command.withDescription(
    `Without a log, list your logs. With a log, show how many entries it has, its folder, its hook and its first ${DEFAULT_SEARCH_LIMIT} entries, oldest first. With entry IDs, show those entries in full.`,
  ),
);
