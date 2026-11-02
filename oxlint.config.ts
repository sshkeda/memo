import { lintConfig } from "@sshkeda/check";

export default lintConfig({
  ".patches": { allow: ["patchesADependency"] },
  "tests/shared/open-sqlite-database.ts": { allow: ["usesSqlDatabases"] },
  "tests/shared/run-memo.ts": { allow: ["spawnsCommands"] },
  "tests/shared/failure-as-value.ts": {
    allow: [{ handlesEveryFailure: "tests assert how an effect failed" }],
  },
  "tests/internal/storage.ts": {
    allow: [
      {
        handlesEveryFailure:
          "a test checks that a defect thrown by a tracer reaches the caller unchanged",
      },
    ],
  },
  "tests/internal/memo-core.ts": { allow: ["writesToTheTerminal"] },
  "src/internal/read-memo-config.ts": { allow: ["readsConfig"], services: ["AppConfig"] },
  "src/index.ts": {
    allow: [
      {
        handlesEveryFailure:
          "runMain runs memo as the process's main fiber, and the exit code follows however it ended",
      },
    ],
  },
  "src/internal/run-memo-cli.ts": {
    allow: [
      "readsConfig",
      "writesToTheTerminal",
      {
        handlesEveryFailure:
          "memo reports every failure, defects included, as an error message and an exit code",
      },
    ],
  },
  "src/internal/standard-streams.ts": { allow: ["writesToTheTerminal"] },
  "src/internal/run-validation-hooks.ts": {
    allow: ["spawnsCommands"],
    services: ["HookRunner", "HookTimeLimit"],
  },
  "src/internal/store-logs-in-sqlite.ts": {
    allow: [
      "usesSqlDatabases",
      {
        handlesEveryFailure:
          "memo read and memo search without a log report each log they can't read and go on with the others",
      },
    ],
    services: ["LogStore"],
  },
});
