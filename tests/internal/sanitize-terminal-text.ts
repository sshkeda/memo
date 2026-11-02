import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import { sanitize } from "../../src/internal/sanitize-terminal-text.ts";

export const normalizesLineEndings = Task.make(
  "sanitize: normalizes line endings",
  Effect.sync(() => {
    const [input, expected] = ["a\r\nb\rc\tend", "a\nb\nc\tend"] as const;
    expect(sanitize(input)).toBe(expected);
  }),
);

export const removesSgr = Task.make(
  "sanitize: removes SGR sequences",
  Effect.sync(() => {
    const [input, expected] = ["\u001B[31mred\u001B[0m", "red"] as const;
    expect(sanitize(input)).toBe(expected);
  }),
);

export const showsTheTextOfTerminalTitleCodes = Task.make(
  "sanitize: shows the text a terminal title code carries, with its escape and bell made visible",
  Effect.sync(() => {
    expect(sanitize("before\u001B]0;DO NOT DEPLOY\u0007after")).toBe(
      "before\u241B]0;DO NOT DEPLOY\u2407after",
    );
    expect(sanitize("before\u001B]0;title\u001B\\after")).toBe("before\u241B]0;title\u241B\\after");
    expect(sanitize("before\u001B]unterminated")).toBe("before\u241B]unterminated");
  }),
);

export const removesIncompleteCsi = Task.make(
  "sanitize: removes incomplete CSI",
  Effect.sync(() => {
    const [input, expected] = ["a\u001B[31", "a"] as const;
    expect(sanitize(input)).toBe(expected);
  }),
);

export const showsControlBytesWithoutJoiningWords = Task.make(
  "sanitize: shows control bytes as control pictures or U+FFFD and line-break controls as newlines, so no text hides and no words join",
  Effect.sync(() => {
    expect(sanitize("a\u001B")).toBe("a\u241B");
    expect(sanitize("a\u001BXb")).toBe("a\u241BXb");
    expect(sanitize("a\u0000\u0008\u001F\u007F\u009Fb")).toBe("a\u2400\u2408\u241F\u2421\uFFFDb");
    expect(sanitize("1\u00852 \u000B\u000C")).toBe("1\n2 \n\n");
  }),
);

export const preservesUnicodeAndNewlines = Task.make(
  "sanitize: preserves unicode and newlines",
  Effect.sync(() => {
    const [input, expected] = ["café 🌍\n", "café 🌍\n"] as const;
    expect(sanitize(input)).toBe(expected);
  }),
);
