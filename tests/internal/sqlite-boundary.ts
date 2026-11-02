import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Path } from "effect";
import { FileSystem } from "effect/FileSystem";

import { failureAsValue } from "../shared/failure-as-value.ts";
import { selectOneWithoutFollowingSymlinks } from "../shared/open-sqlite-database.ts";
import {
  appendEntry,
  makeTemporaryDirectory,
  writeFile,
  readFile,
  symlink,
  buildTestServices,
  logName,
} from "../shared/run-memo.ts";

export const sQLiteRefusesASymlinkSubstitutedAfterCatalogValidation = Task.make(
  "sqlite-boundary: SQLite refuses a symlink substituted after catalog validation",
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (process.platform === "win32") {
        return;
      }

      const directory = yield* makeTemporaryDirectory();
      const outside = path.join(yield* makeTemporaryDirectory(), "sentinel");
      yield* writeFile(outside, "untouched");
      yield* appendEntry(logName("default"), "2026-01-01T00:00:00.000Z", "entry").pipe(
        Effect.provideContext(yield* buildTestServices(directory)),
      );
      const filename = yield* Effect.flatMap(FileSystem, (fileSystem) =>
        Effect.tap(
          fileSystem.realPath(path.join(directory, "logs", "default", "entries.sqlite3")),
          (file) => fileSystem.remove(file, { force: true }),
        ),
      );
      yield* symlink(outside, filename);
      yield* failureAsValue(selectOneWithoutFollowingSymlinks(filename));
      expect(yield* readFile(outside)).toBe("untouched");
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);
