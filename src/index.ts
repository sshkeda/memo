import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { exitWithReportedCode, memoProgram } from "./internal/run-memo-cli.ts";
import { standardInputFromItsPosition } from "./internal/standard-streams.ts";

BunRuntime.runMain(
  memoProgram.pipe(
    Effect.provide(Layer.provideMerge(standardInputFromItsPosition, BunServices.layer)),
  ),
  {
    disableErrorReporting: true,
    teardown: exitWithReportedCode,
  },
);
