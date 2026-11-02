import { Effect } from "effect";
import { Command } from "effect/cli";

import { contentArgument, jsonFlag, logFlag } from "./command-options.ts";
import {
  CheckRejectedError,
  HookKilledError,
  HookRejectedError,
  HookTimedOutError,
} from "./memo-errors.ts";
import {
  checkResultLine,
  code,
  confirmationLine,
  humanCheckResult,
  humanConfirmation,
} from "./render-results.ts";
import {
  HOOK_TIME_LIMIT_TEXT,
  HookKilled,
  HookRejected,
  HookRunner,
  HookTimedOut,
} from "./run-validation-hooks.ts";
import { suppliedContent, writeResult } from "./standard-streams.ts";
import { LOG_NAME_RULE, LogStore, validateLogName } from "./store-logs-in-sqlite.ts";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const appendCommand = Command.make(
  "append",
  {
    content: contentArgument(
      "The text to save. Leave it out to read the text from stdin. Put `--` before text that starts with a dash.",
    ),
    json: jsonFlag("Print the new entry's ID and date as one JSON object."),
    log: logFlag(`The log to save the entry in. ${capitalized(LOG_NAME_RULE)}.`),
  },
  ({ content, json, log: requestedLog }) =>
    Effect.gen(function* () {
      const source = yield* suppliedContent(content, "append");
      const log = yield* Effect.fromResult(validateLogName(requestedLog, "append"));
      const verdict = yield* Effect.flatMap(HookRunner, (hooks) => hooks.check(log, source));
      if (verdict instanceof HookRejected) {
        return yield* new HookRejectedError({ log, subject: "entry", reason: verdict.reason });
      }
      if (verdict instanceof HookKilled) {
        return yield* new HookKilledError({ log, signal: verdict.signal, reason: verdict.reason });
      }
      if (verdict instanceof HookTimedOut) {
        return yield* new HookTimedOutError({ log });
      }
      const entry = yield* Effect.flatMap(LogStore, (logStore) => logStore.append(log, source));
      yield* writeResult(confirmationLine(entry), humanConfirmation(log, entry), json);
    }),
).pipe(
  Command.withShortDescription("Save content as a new entry in a log."),
  Command.withDescription(
    `Save content as a new entry at the end of a log. Give the content as one argument or on stdin. With an argument, memo doesn't read stdin. The first entry creates the log. If the log has a hook, memo saves the entry only when the hook accepts it within ${HOOK_TIME_LIMIT_TEXT}.`,
  ),
);

export const checkCommand = Command.make(
  "check",
  {
    content: contentArgument(
      "The text to check. Leave it out to read the text from stdin. Put `--` before text that starts with a dash.",
    ),
    json: jsonFlag("Print the result as one JSON object."),
    log: logFlag("The log whose hook runs."),
  },
  ({ content, json, log: requestedLog }) =>
    Effect.gen(function* () {
      const source = yield* suppliedContent(content, "check");
      const log = yield* Effect.fromResult(validateLogName(requestedLog, "check"));
      const verdict = yield* Effect.flatMap(HookRunner, (hooks) => hooks.check(log, source));
      if (verdict instanceof HookRejected) {
        if (!json) {
          return yield* new HookRejectedError({ log, subject: "content", reason: verdict.reason });
        }
        yield* writeResult(checkResultLine(log, verdict), "", json);
        return yield* new CheckRejectedError({});
      }
      if (verdict instanceof HookKilled) {
        if (!json) {
          return yield* new HookKilledError({
            log,
            signal: verdict.signal,
            reason: verdict.reason,
          });
        }
        yield* writeResult(checkResultLine(log, verdict), "", json);
        return yield* new CheckRejectedError({});
      }
      if (verdict instanceof HookTimedOut) {
        if (!json) {
          return yield* new HookTimedOutError({ log });
        }
        yield* writeResult(checkResultLine(log, verdict), "", json);
        return yield* new CheckRejectedError({});
      }
      yield* Effect.flatMap(LogStore, (logStore) => logStore.check(log, source));
      yield* writeResult(checkResultLine(log, verdict), humanCheckResult(log, verdict), json);
    }),
).pipe(
  Command.withShortDescription("Run a log's hook on content without saving it."),
  Command.withDescription(
    [
      "Run a log's hook on content without saving it, the same way memo append does, and check that the log's database can take the entry. Give the content as one argument or on stdin.",
      `A log can have one hook, which is a command that accepts or rejects each entry before memo saves it. Set it in ${code("config.json")} in the log's folder, which ${code("memo read <log>")} shows. Write the command as a list of words, as in ${code('{ "hook": ["bun", "/absolute/path/to/check.ts"] }')}. Memo runs it without a shell, and finds the first word on PATH unless it's an absolute path.`,
      `The hook gets the content on stdin and the log's name in MEMO_LOG. It accepts the content by exiting 0. It rejects it by exiting with any other code, and should write the reason to stderr. If it doesn't exit within ${HOOK_TIME_LIMIT_TEXT}, memo treats the content as rejected. On macOS and Linux, once the hook exits or runs out of time, memo stops the processes it started, except any that detach into their own process group.`,
    ].join("\n\n"),
  ),
);
