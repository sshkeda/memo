import { inspect } from "node:util";

import { Schema } from "effect";

export class SucceededInsteadOfFailing extends Schema.TaggedError<SucceededInsteadOfFailing>()(
  "SucceededInsteadOfFailing",
  { value: Schema.Unknown },
) {
  public override get message() {
    return `the effect succeeded with ${inspect(this.value)}, but the test expects it to fail`;
  }
}
