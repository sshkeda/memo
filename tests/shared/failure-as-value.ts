import { Effect } from "effect";

import { SucceededInsteadOfFailing } from "./test-errors.ts";

export const failureAsValue = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
) => Effect.flip(effect).pipe(Effect.mapError((value) => new SucceededInsteadOfFailing({ value })));
