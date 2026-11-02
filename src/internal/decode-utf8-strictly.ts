import { Option, Result } from "effect";

const CONTINUATION_MASK = 0b1100_0000;
const CONTINUATION_BITS = 0b1000_0000;
const MOST_CONTINUATION_BYTES = 3;
const isContinuationByte = (byte: number | undefined) =>
  byte !== undefined && (byte & CONTINUATION_MASK) === CONTINUATION_BITS;

const firstInvalidByte = (bytes: Uint8Array, text: string) => {
  const reencoded = new TextEncoder().encode(text);
  const difference = reencoded.findIndex((byte, index) => byte !== bytes[index]);
  if (difference === -1) {
    return Option.none<number>();
  }
  const steps = [...Array.from({ length: MOST_CONTINUATION_BYTES + 1 }).keys()];
  const backtrack = steps.find((step) => !isContinuationByte(reencoded[difference - step]));
  return Option.some(difference - (backtrack ?? 0));
};

export const decodeUtf8Strictly = (bytes: Uint8Array): Result.Result<string, number> => {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return Option.match(firstInvalidByte(bytes, text), {
    onNone: () => Result.succeed(text),
    onSome: (offset) => Result.fail(offset),
  });
};
