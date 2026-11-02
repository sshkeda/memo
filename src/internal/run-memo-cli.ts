import { Effect, Exit, Layer, Schema, Stream } from "effect";
import type { Runtime } from "effect";
import { CliConfig, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import { Stdio } from "effect/Stdio";

import packageJson from "../../package.json" with { type: "json" };
import { appendCommand, checkCommand } from "./append-and-check-commands.ts";
import { asksForJson, repeatsJson } from "./command-options.ts";
import { helpFormatter } from "./format-help.ts";
import { InvalidInputError, MEMO_COMMAND } from "./memo-errors.ts";
import { readCommand } from "./read-command.ts";
import {
  AppConfigLive,
  debugEnabled,
  userHome,
  outputColor,
  withEmptyEnvironmentValues,
} from "./read-memo-config.ts";
import { reportFor } from "./report-failures.ts";
import { HookRunnerLive } from "./run-validation-hooks.ts";
import { searchCommand } from "./search-command.ts";
import { LogStoreLive } from "./store-logs-in-sqlite.ts";

const appLive = HookRunnerLive.pipe(Layer.provideMerge(LogStoreLive), Layer.provide(AppConfigLive));

const commands = [
  appendCommand.pipe(Command.provide(appLive)),
  searchCommand.pipe(Command.provide(appLive)),
  readCommand.pipe(Command.provide(appLive)),
  checkCommand.pipe(Command.provide(appLive)),
];

const memoCommand = Command.make("memo").pipe(
  Command.withDescription("Memo keeps append-only logs that you and your agents can search later."),
  Command.withSubcommands(commands),
);
const runCli = Command.run(memoCommand, {
  renderErrors: false,
  version: packageJson.version,
}).pipe(
  Effect.provideService(
    CliConfig.CliConfig,
    CliConfig.make({
      builtIns: [
        GlobalFlag.Action({
          flag: Flag.Boolean("help").pipe(
            Flag.withAlias("h"),
            Flag.withDescription("Show help for memo or one command."),
            Flag.withDefault(false),
          ),
          run: GlobalFlag.Help.run,
        }),
        GlobalFlag.Action({
          flag: Flag.Boolean("version").pipe(
            Flag.withAlias("v"),
            Flag.withDescription("Show memo's version."),
            Flag.withDefault(false),
          ),
          run: GlobalFlag.Version.run,
        }),
      ],
    }),
  ),
);

const isMemoCommand = Schema.is(MEMO_COMMAND);

const runAndReport = Effect.gen(function* () {
  const stdio = yield* Stdio;
  const debug = yield* debugEnabled;
  const home = yield* userHome;
  const color = yield* outputColor;
  const argv = yield* stdio.args;
  const json = yield* asksForJson(argv);
  const [command] = argv;
  const isRepeatedJson = repeatsJson(argv) && isMemoCommand(command);
  const run = isRepeatedJson
    ? Effect.fail(
        new InvalidInputError({
          command,
          message: "--json was given more than once, but memo takes it at most once",
        }),
      )
    : runCli;
  return yield* run.pipe(
    Effect.provideService(CliOutput.Formatter, helpFormatter(color)),
    Effect.as(0),
    Effect.catchCause((cause) =>
      Effect.flatMap(reportFor(cause, { argv, debug, home, json }), (report) =>
        Stream.run(
          Stream.fromIterable(report.lines.map((line) => `${line}\n`)),
          stdio.stderr(),
        ).pipe(Effect.as(report.code)),
      ),
    ),
  );
});

export const memoProgram = withEmptyEnvironmentValues(runAndReport);

export const exitWithReportedCode: Runtime.Teardown = (exit, onExit) => {
  const exitedWithCode = Exit.isSuccess(exit) && typeof exit.value === "number";
  onExit(exitedWithCode ? exit.value : 1);
};
