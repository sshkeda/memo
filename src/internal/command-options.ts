import { Data, Effect, Schema, SchemaTransformation } from "effect";
import { Argument, Flag, Primitive } from "effect/cli";

const INTEGER_TEXT = Schema.String.check(Schema.isPattern(/^[+-]?\d+$/u)).pipe(
  Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
);

export const logFlag = (description: string) =>
  Flag.String("log").pipe(Flag.withDescription(description));
export const contentArgument = (description: string) =>
  Argument.String("content").pipe(Argument.withDescription(description), Argument.optional);
export const integerFlag = (name: string) =>
  Flag.String(name).pipe(Flag.withMetavar("integer"), Flag.withSchema(INTEGER_TEXT));
export const integerArgument = (name: string) =>
  Argument.String(name).pipe(Argument.withMetavar("integer"), Argument.withSchema(INTEGER_TEXT));
export const limitFlag = (description: string) =>
  integerFlag("limit").pipe(Flag.withDescription(description));
class JsonValueIsNotBoolean extends Data.TaggedError("JsonValueIsNotBoolean") {}

const JSON_FLAG = "json";
const JSON_SWITCH = `--${JSON_FLAG}`;
const JSON_SWITCH_WITH_VALUE = `${JSON_SWITCH}=`;

export const jsonFlag = (description: string) =>
  Flag.Boolean(JSON_FLAG).pipe(Flag.withDefault(false), Flag.withDescription(description));

const jsonSwitches = (argv: readonly string[]) => {
  const operandsStart = argv.indexOf("--");
  return (operandsStart === -1 ? argv : argv.slice(0, operandsStart)).filter(
    (word) => word === JSON_SWITCH || word.startsWith(JSON_SWITCH_WITH_VALUE),
  );
};

export const repeatsJson = (argv: readonly string[]) => jsonSwitches(argv).length > 1;

export const asksForJson = (argv: readonly string[]) => {
  const [first] = jsonSwitches(argv);
  if (first === undefined) {
    return Effect.succeed(false);
  }
  if (first === JSON_SWITCH) {
    return Effect.succeed(true);
  }
  return Primitive.Boolean.parse(first.slice(JSON_SWITCH_WITH_VALUE.length)).pipe(
    Effect.mapError(() => new JsonValueIsNotBoolean()),
    Effect.catchTag("JsonValueIsNotBoolean", () => Effect.succeed(false)),
  );
};
