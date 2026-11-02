import { TERMINAL_FORMATTING } from "./sanitize-terminal-text.ts";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
const LANGUAGE_SUFFIX = /^[#+]+$/u;
const SYMBOL_OR_NUMBER = /[\p{S}\p{N}\p{Extended_Pictographic}]/u;
const STARTS_WITH_A_LETTER = /^\p{L}/u;
const LANGUAGE_NAME = /^\p{L}[#+]*$/u;
const INVISIBLE_FORMATTING = /\p{Cf}/gu;
const EMOJI = /\p{Extended_Pictographic}/u;
const FRACTION_SLASH = "\u2044";
const ENDS_WITH_A_DIGIT = /\p{Nd}$/u;
const FOLDED_DIACRITICS = /(?<base>[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu;
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/gu;
const ENCLOSING_MARKS = /\p{Me}/gu;
const SEPARATOR = /[^\p{L}\p{N}\p{M}\p{Co}]/u;
const WORD_PART = /[\p{L}\p{M}\p{Co}]+|[\p{N}\p{M}]+/gu;
const MOST_PARTS_IN_A_RUN = 4;

export const SEARCH_WORDS_VERSION = 6;

export const SEARCH_TOKENIZER = `unicode61 remove_diacritics 0 categories 'L* M* N* P* S* Co Cf Cn Cs'`;

const escapedPositions = (text: string) =>
  new Set(
    Array.from(text.matchAll(TERMINAL_FORMATTING), (escape) =>
      Array.from({ length: escape[0].length }, (_unused, offset) => escape.index + offset),
    ).flat(),
  );

const searchableForm = (grapheme: string) => {
  const compatible = grapheme.normalize("NFKC");
  return EMOJI.test(compatible) ? compatible : compatible.replaceAll(INVISIBLE_FORMATTING, "");
};

const normalized = (text: string) => {
  const escaped = escapedPositions(text);
  const forms = Array.from(GRAPHEMES.segment(text), ({ segment, index }) => ({
    text: escaped.has(index) ? "" : searchableForm(segment),
    start: index,
    end: index + segment.length,
  }));
  const graphemes = forms.map((grapheme, position) => {
    const isFractionAfterADigit =
      grapheme.text.includes(FRACTION_SLASH) &&
      ENDS_WITH_A_DIGIT.test(forms[position - 1]?.text ?? "");
    return {
      text: isFractionAfterADigit ? ` ${grapheme.text}` : grapheme.text,
      start: grapheme.start,
      end: grapheme.end,
    };
  });
  return {
    text: graphemes.map((grapheme) => grapheme.text).join(""),
    origins: graphemes.flatMap((grapheme) =>
      Array.from({ length: grapheme.text.length }, () => grapheme),
    ),
  };
};

const fold = (word: string) =>
  word
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(FOLDED_DIACRITICS, "$<base>")
    .replaceAll(ENCLOSING_MARKS, "")
    .replaceAll(VARIATION_SELECTORS, "")
    .normalize("NFC");

const isSearchable = (segment: Intl.SegmentData) =>
  segment.isWordLike === true || SYMBOL_OR_NUMBER.test(segment.segment);

const withParts = (word: string) => {
  if (!SEPARATOR.test(word)) {
    return [word];
  }
  const parts = Array.from(word.matchAll(WORD_PART), (part) => ({
    start: part.index,
    end: part.index + part[0].length,
  }));
  const runs = parts.flatMap((first, index) =>
    parts
      .slice(index, index + MOST_PARTS_IN_A_RUN)
      .map((last) => word.slice(first.start, last.end)),
  );
  return [...new Set([word, ...runs])];
};

const endsAWord = (next: Intl.SegmentData | undefined) =>
  !STARTS_WITH_A_LETTER.test(next?.segment ?? "");

export const searchWordsIn = (text: string) => {
  const { text: normalizedText, origins } = normalized(text);
  const segments = [...WORDS.segment(normalizedText)];
  const found: { word: string; start: number; end: number; isLetters: boolean }[] = [];
  for (const [position, segment] of segments.entries()) {
    const previous = found.at(-1);
    const start = origins[segment.index]?.start ?? text.length;
    const end = origins[segment.index + segment.segment.length - 1]?.end ?? text.length;
    const isSuffix =
      LANGUAGE_SUFFIX.test(segment.segment) &&
      previous?.isLetters === true &&
      LANGUAGE_NAME.test(previous.word) &&
      previous.end === start &&
      endsAWord(segments[position + 1]);
    if (isSuffix) {
      found.splice(-1, 1, { ...previous, word: `${previous.word}${segment.segment}`, end });
    } else if (isSearchable(segment)) {
      const isLetters = segment.isWordLike === true;
      found.push(
        ...withParts(fold(segment.segment)).map((word) => ({ word, start, end, isLetters })),
      );
    }
  }
  return found.map(({ word, start, end }) => ({ word, start, end }));
};

export const searchWords = (text: string) => searchWordsIn(text).map(({ word }) => word);
