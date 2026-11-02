import { DateTime, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { jsonFlag, limitFlag, logFlag } from "./command-options.ts";
import { failEach } from "./memo-errors.ts";
import { userHome, outputColor } from "./read-memo-config.ts";
import {
  code,
  entryCount,
  entryLines,
  humanEntries,
  humanNoLogs,
  shellWord,
} from "./render-results.ts";
import { sanitize } from "./sanitize-terminal-text.ts";
import { searchWords } from "./split-search-words.ts";
import { checkArgument, writeOut, writeResult, writeStandardError } from "./standard-streams.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  LogStore,
  MAX_SEARCH_LIMIT,
  validateLogName,
  validateSearchLimit,
} from "./store-logs-in-sqlite.ts";

const LIMIT_GROWTH = 2;

const quoted = (text: string) => `"${sanitize(text)}"`;

const operand = (text: string) =>
  text.startsWith("-") ? `-- ${shellWord(text)}` : shellWord(text);

const searchFooter = (
  request: {
    readonly query: Option.Option<string>;
    readonly log: Option.Option<string>;
    readonly full: boolean;
    readonly json: boolean;
    readonly limit: number;
  },
  shown: number,
) => {
  const found = Option.match(request.query, {
    onNone: () => "entries",
    onSome: (query) => `matches for ${quoted(query)}`,
  });
  const scope = Option.match(request.log, { onNone: () => "", onSome: (log) => ` in ${log}` });
  const showing = `Showing the ${shown} newest ${found}${scope}`;
  if (request.limit >= MAX_SEARCH_LIMIT) {
    const narrower = [
      Option.isSome(request.query) ? "add words to the query" : "add a query",
      ...(Option.isNone(request.log) ? ["use --log"] : []),
    ].join(" or ");
    return `${showing}, the most memo search shows. To narrow the search, ${narrower}.`;
  }
  const command = [
    "memo search",
    ...Option.toArray(Option.map(request.log, (log) => `--log ${log}`)),
    ...(request.full ? ["--full"] : []),
    `--limit ${Math.min(request.limit * LIMIT_GROWTH, MAX_SEARCH_LIMIT)}`,
    ...(request.json ? ["--json"] : []),
    ...Option.toArray(Option.map(request.query, operand)),
  ].join(" ");
  return `${showing}. Run ${code(sanitize(command))} to see more.`;
};

const emptyLogSearch = (query: Option.Option<string>, log: string) =>
  Option.match(query, {
    onNone: () => `${log} has ${entryCount(0)}.\n`,
    onSome: (text) => `No entry in ${log} matches ${quoted(text)}.\n`,
  });

const emptySearch = (
  query: Option.Option<string>,
  logs: { readonly searched: number; readonly unreadable: number },
  logsDirectory: string,
  home: string | undefined,
) => {
  if (logs.searched === 0) {
    return logs.unreadable === 0 ? humanNoLogs(logsDirectory, home) : "";
  }
  return Option.match(query, {
    onNone: () => "No log has entries yet.\n",
    onSome: (text) => `No entry matches ${quoted(text)}.\n`,
  });
};

const writeSearchResults = Effect.fn("writeSearchResults")(function* (
  request: Parameters<typeof searchFooter>[0],
  found: {
    readonly entries: Parameters<typeof entryLines>[0];
    readonly hasMore: boolean;
    readonly logsSearched: number;
    readonly unreadable: readonly unknown[];
  },
  logsDirectory: string,
) {
  const { query, log, full, json } = request;
  const { entries, hasMore } = found;
  if (entries.length === 0) {
    if (json) {
      return yield* writeOut("");
    }
    const hasNoWords = Option.isSome(query) && searchWords(query.value).length === 0;
    if (hasNoWords) {
      return yield* writeOut(`${quoted(query.value)} has no words to search for.\n`);
    }
    return yield* writeOut(
      Option.isSome(log)
        ? emptyLogSearch(query, log.value)
        : emptySearch(
            query,
            { searched: found.logsSearched, unreadable: found.unreadable.length },
            logsDirectory,
            yield* userHome,
          ),
    );
  }
  yield* writeResult(
    entryLines(entries, { full, includeLog: Option.isNone(log) }),
    humanEntries(entries, {
      full,
      color: !json && (yield* outputColor),
      includeLog: true,
      timeZone: DateTime.zoneMakeLocal(),
    }),
    json,
  );
  const hasFooter = hasMore && !(json && found.unreadable.length > 0);
  if (hasFooter) {
    const footer = searchFooter(request, entries.length);
    yield* json ? writeStandardError(`${footer}\n`) : writeOut(`\n${footer}\n`);
  }
});

export const searchCommand = Command.make(
  "search",
  {
    full: Flag.Boolean("full").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Show whole entries instead of previews."),
    ),
    json: jsonFlag("Print one JSON object per entry, and nothing when no entry matches."),
    limit: limitFlag(
      `Show at most this many entries. The default is ${DEFAULT_SEARCH_LIMIT}, and the most is ${MAX_SEARCH_LIMIT}.`,
    ).pipe(Flag.withDefault(DEFAULT_SEARCH_LIMIT)),
    log: logFlag("Search only this log.").pipe(Flag.optional),
    query: Argument.String("query").pipe(
      Argument.withDescription(
        "The words to find. An entry matches when it has every word. Put `--` before a query that starts with a dash.",
      ),
      Argument.optional,
    ),
  },
  ({ full, json, limit, log: requestedLog, query: requestedQuery }) =>
    Effect.gen(function* () {
      yield* Effect.fromResult(validateSearchLimit(limit, "search"));
      const query = Option.isSome(requestedQuery)
        ? Option.some(yield* checkArgument(requestedQuery.value, "search"))
        : Option.none<string>();
      const log = Option.isSome(requestedLog)
        ? Option.some(yield* Effect.fromResult(validateLogName(requestedLog.value, "search")))
        : Option.none();
      const logStore = yield* LogStore;
      const found = yield* logStore.search(log, query, limit);
      yield* writeSearchResults({ query, log, full, json, limit }, found, logStore.logsDirectory);
      const [first, ...rest] = found.unreadable.map(({ failure }) => failure);
      if (first !== undefined) {
        return yield* failEach([first, ...rest]);
      }
    }),
).pipe(
  Command.withShortDescription("Search every log, newest entries first."),
  Command.withDescription(
    "Search the entries in every log, newest first. Each result shows the whole entry, or the passage that matches when the entry is long. A preview with … leaves text out, so read the entry with `memo read <log> <id>` before you act on it. Use --log to search one log, and --full to show whole entries. Leave out the query to show the newest entries.",
  ),
);
