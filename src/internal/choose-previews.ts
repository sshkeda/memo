import { searchWordsIn } from "./split-search-words.ts";

export const PREVIEW_CHARACTERS = 600;

const SNIPPET_TOKENS = 64;
const PREVIEW_LEAD_WORDS = 8;
const SENTENCES = new Intl.Segmenter(undefined, { granularity: "sentence" });
const PARAGRAPH_BREAK = /(?:\r\n|[\n\r\p{Zl}])[^\S\n\r\p{Zl}\p{Zp}]*(?:\r\n|[\n\r\p{Zl}])|\p{Zp}/gu;

const fitsInPreview = (text: string) =>
  text[Symbol.iterator]()
    .take(PREVIEW_CHARACTERS + 1)
    .toArray().length <= PREVIEW_CHARACTERS;

const clipped = (content: string, start: number) => {
  const rest = content.slice(start);
  const kept = rest[Symbol.iterator]().take(PREVIEW_CHARACTERS).toArray().join("");
  const lead = start > 0 ? "…" : "";
  return kept.length < rest.length ? `${lead}${kept.trimEnd()}…` : `${lead}${kept}`;
};

export const previewFromStart = (content: string) => clipped(content, 0);

const bestWindowStart = (hits: readonly (string | undefined)[]) => {
  const inWindow = new Map<string, number>();
  const shift = (word: string | undefined, change: number) => {
    if (word === undefined) {
      return;
    }
    const count = (inWindow.get(word) ?? 0) + change;
    if (count === 0) {
      inWindow.delete(word);
    } else {
      inWindow.set(word, count);
    }
  };
  for (const word of hits.slice(0, SNIPPET_TOKENS)) {
    shift(word, 1);
  }
  const best = { start: 0, words: inWindow.size, startsAtHit: hits[0] !== undefined };
  for (const [index, entering] of hits.slice(SNIPPET_TOKENS).entries()) {
    shift(hits[index], -1);
    shift(entering, 1);
    const start = index + 1;
    const startsAtHit = hits[start] !== undefined;
    const isBetter =
      inWindow.size > best.words ||
      (inWindow.size === best.words && startsAtHit && !best.startsAtHit);
    if (isBetter) {
      Object.assign(best, { start, words: inWindow.size, startsAtHit });
    }
  }
  return best.start;
};

const paragraphStart = (content: string, position: number) =>
  Array.from(content.matchAll(PARAGRAPH_BREAK), (found) => found.index + found[0].length).findLast(
    (end) => end <= position,
  ) ?? 0;

export const previewAround = (content: string, words: readonly string[]) => {
  if (fitsInPreview(content)) {
    return content;
  }
  const wanted = new Set(words);
  const tokens = searchWordsIn(content);
  const hits = tokens.map(({ word }) => (wanted.has(word) ? word : undefined));
  const windowStart = bestWindowStart(hits);
  const firstHit = hits.findIndex((hit, index) => index >= windowStart && hit !== undefined);
  const best = firstHit === -1 ? windowStart : firstHit;
  const match = tokens[best] ?? { start: 0, end: 0 };
  const startsBefore = [...new Set(tokens.slice(0, best).map((token) => token.start))];
  const candidates = [
    paragraphStart(content, match.start),
    SENTENCES.segment(content).containing(match.start)?.index ?? 0,
    startsBefore.at(-PREVIEW_LEAD_WORDS) ?? 0,
  ];
  const start =
    candidates.find((candidate) => fitsInPreview(content.slice(candidate, match.end))) ??
    match.start;
  return clipped(content, start);
};
