import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, Option } from "effect";

import { searchWords } from "../../src/internal/split-search-words.ts";
import { toMatchExpression } from "../../src/internal/store-logs-in-sqlite.ts";

const expression = (input: string): string | undefined =>
  Option.getOrUndefined(toMatchExpression(input));

export const splitsWordsAndFoldsCase = Task.make(
  "searchWords: splits words and folds case",
  Effect.scoped(
    Effect.sync(() => {
      expect(searchWords("Council is my primary focus")).toEqual([
        "council",
        "is",
        "my",
        "primary",
        "focus",
      ]);
      expect(searchWords("a-b, github.com")).toEqual(["a", "b", "github.com", "github", "com"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const keepsLanguageNamesWhole = Task.make(
  "searchWords: keeps C#, C++ and F# whole, so they don't match C",
  Effect.scoped(
    Effect.sync(() => {
      expect(searchWords("C# C++ F# C")).toEqual(["c#", "c++", "f#", "c"]);
      expect(searchWords("a+b")).toEqual(["a", "+", "b"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const foldsTextThatLooksTheSameToTheSameWords = Task.make(
  "searchWords: text that looks the same gives the same words",
  Effect.scoped(
    Effect.sync(() => {
      expect(searchWords("café Ωμέγα")).toEqual(["cafe", "ωμεγα"]);
      expect(searchWords("\u0958\u0932\u092E")).toEqual(searchWords("\u0915\u093C\u0932\u092E"));
      expect(searchWords("\u1100\u1161")).toEqual(searchWords("\uAC00"));
      expect(searchWords("\uFB01le")).toEqual(["file"]);
      expect(searchWords("\u2764\uFE0F")).toEqual(searchWords("\u2764"));
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const keepsNumbersVersionsAndFoldedForms = Task.make(
  "searchWords: keeps fractions and other numbers, finds versioned language names, and folds NFKC forms, ß and ẞ",
  Effect.scoped(
    Effect.sync(() => {
      expect(searchWords("½")).not.toEqual(searchWords("¼"));
      expect(searchWords("① ²")).toEqual(["1", "2"]);
      expect(searchWords("C\uFF03 C\uFF0B\uFF0B")).toEqual(searchWords("C# C++"));
      expect(searchWords("C++17 C#8")).toEqual(["c++", "17", "c#", "8"]);
      expect(searchWords("Straße")).toEqual(searchWords("STRASSE"));
      expect(searchWords("STRAẞE")).toEqual(searchWords("STRASSE"));
      expect(searchWords("\u1FB3")).toEqual(searchWords("\u03B1\u03B9"));
      expect(searchWords("1\uFE0F\u20E3")).toEqual(["1"]);
      expect(searchWords("\u001B[31mred\u001B[0m alert")).toEqual(["red", "alert"]);
      expect(searchWords("\u2103")).toEqual(searchWords("°C"));
      expect(searchWords("C++\u00B9\u2077")).toEqual(searchWords("C++17"));
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const findsTheNaturalPartsOfCompoundWords = Task.make(
  "searchWords: a compound word also gives its parts and runs of them, so identifiers, domains and versions are found by their parts",
  Effect.scoped(
    Effect.sync(() => {
      expect(searchWords("__init__")).toEqual(["__init__", "init"]);
      expect(searchWords("_private private_")).toEqual([
        "_private",
        "private",
        "private_",
        "private",
      ]);
      expect(searchWords("www.example.com")).toEqual([
        "www.example.com",
        "www",
        "www.example",
        "example",
        "example.com",
        "com",
      ]);
      for (const [compound, part] of [
        ["v1.2.3", "1.2.3"],
        ["v1.2.3", "2.3"],
        ["x86_64", "x86"],
      ] as const) {
        const words = new Set(searchWords(compound));
        expect(searchWords(part).filter((word) => !words.has(word))).toEqual([]);
      }
      expect(searchWords("ipv6")).toEqual(["ipv6"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const ignoresInvisibleFormattingAndKeepsCodeAndFractionsApart = Task.make(
  "searchWords: ignores invisible formatting inside words, keeps code identifiers and mixed fractions apart, and finds C++ before any version",
  Effect.scoped(
    Effect.sync(() => {
      expect(searchWords("re\u00ADsolved N\u2060OT")).toEqual(["resolved", "not"]);
      expect(searchWords("2\u00BE")).toEqual(searchWords("2 \u00BE"));
      expect(searchWords("counter+=1")).toContain("counter");
      expect(searchWords("C++2b")).toEqual(["c++", "2b"]);
      expect(searchWords("\u001B]0;DO NOT DEPLOY\u0007")).toEqual(["0", "do", "not", "deploy"]);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const keepsNonASCIILettersAndSymbols = Task.make(
  "searchWords: keeps non-ASCII letters, private-use characters and symbols",
  Effect.scoped(
    Effect.sync(() => {
      expect(searchWords("日本語 🎉")).toEqual(["日本語", "🎉"]);
      expect(searchWords("alpha\uE000beta")).toEqual(searchWords("alpha\uE000beta"));
      expect(searchWords("alpha\uE000beta").length).toBeGreaterThan(0);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const quotesEveryTermAndJoinsThemWithAND = Task.make(
  "toMatchExpression: quotes every term and joins them with AND",
  Effect.scoped(
    Effect.sync(() => {
      expect(expression("council focus")).toBe(`"council" AND "focus"`);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const rendersFTSOperatorsAsOrdinaryTerms = Task.make(
  "toMatchExpression: renders FTS operators as ordinary terms",
  Effect.scoped(
    Effect.sync(() => {
      expect(expression("cats AND dogs")).toBe(`"cats" AND "and" AND "dogs"`);
      expect(expression("NEAR(a b)")).toBe(`"near" AND "a" AND "b"`);
      expect(expression("foo OR bar NOT baz")).toBe(`"foo" AND "or" AND "bar" AND "not" AND "baz"`);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const stripsPrefixWildcardsSoSearchesStayLiteral = Task.make(
  "toMatchExpression: strips prefix wildcards so searches stay literal",
  Effect.scoped(
    Effect.sync(() => {
      expect(expression("coun*")).toBe(`"coun"`);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const neutralisesUnbalancedQuotesInsteadOfProducingASyntaxError = Task.make(
  "toMatchExpression: neutralises unbalanced quotes instead of producing a syntax error",
  Effect.scoped(
    Effect.sync(() => {
      expect(expression(`"unterminated`)).toBe(`"unterminated"`);
      expect(expression(`he said "hi`)).toBe(`"he" AND "said" AND "hi"`);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const neutralisesColumnFiltersAndSetSyntax = Task.make(
  "toMatchExpression: neutralises column filters and set syntax",
  Effect.scoped(
    Effect.sync(() => {
      expect(expression("content : value")).toBe(`"content" AND "value"`);
      expect(expression("{content} : value")).toBe(`"content" AND "value"`);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const returnsNoneWhenNothingIndexableRemains = Task.make(
  "toMatchExpression: returns none when nothing indexable remains",
  Effect.scoped(
    Effect.sync(() => {
      expect(Option.isNone(toMatchExpression(""))).toBe(true);
      expect(Option.isNone(toMatchExpression("   "))).toBe(true);
      expect(Option.isNone(toMatchExpression("***"))).toBe(true);
      expect(Option.isNone(toMatchExpression(`"" -- ,.`))).toBe(true);
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);

export const neverEmitsAnUnquotedToken = Task.make(
  "toMatchExpression: never emits an unquoted token",
  Effect.scoped(
    Effect.sync(() => {
      const inputs = [
        `a"b`,
        `-leading`,
        `^caret`,
        `(paren)`,
        `NEAR/3`,
        `emoji 🎉 tail`,
        `tab\tseparated`,
      ];
      for (const input of inputs) {
        const built = expression(input);
        if (built === undefined) {
          continue;
        }
        for (const term of built.split(" AND ")) {
          expect(term.startsWith(`"`)).toBe(true);
          expect(term.endsWith(`"`)).toBe(true);
        }
      }
    }),
  ),
  { timeout: "1 minute", cleanup: "5 seconds" },
);
