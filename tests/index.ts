import { check } from "@sshkeda/check/tasks";
import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import * as compiled from "./internal/compiled-executable.ts";
import * as query from "./internal/fts-query.ts";
import * as memo from "./internal/memo-core.ts";
import * as processTests from "./internal/memo-process.ts";
import * as sanitize from "./internal/sanitize-terminal-text.ts";
import * as sqlite from "./internal/sqlite-boundary.ts";
import * as storage from "./internal/storage.ts";
import { TESTS_AT_ONCE } from "./internal/tests-at-once.ts";
import { compiledMemo } from "./shared/compile-memo.ts";

export { build } from "./shared/compile-memo.ts";

export const ci = Task.make(
  "ci",
  Effect.andThen(
    compiledMemo,
    Task.all([check, compiled, query, memo, storage, processTests, sanitize, sqlite], {
      concurrency: TESTS_AT_ONCE,
    }),
  ),
);
