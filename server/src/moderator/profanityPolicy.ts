import { normalizeAllowedWords } from './config';

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
const wordCharacter = (char: string | undefined) => Boolean(char && /[\p{L}\p{N}_]/u.test(char));

/** Match whole words/phrases, never turn an allowlisted fragment into a wildcard. */
function occurrences(text: string, term: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (let start = text.indexOf(term); start >= 0; start = text.indexOf(term, start + 1)) {
    const end = start + term.length;
    if (!wordCharacter(text[start - 1]) && !wordCharacter(text[end])) found.push([start, end]);
  }
  return found;
}

/** A verdict must cite actual source fragments outside explicitly permitted words. */
export function verifiedProfanityTerms(text: string, terms: unknown, allowedWords: string[]): string[] {
  if (!Array.isArray(terms)) return [];
  const source = normalize(text);
  const allowedRanges = normalizeAllowedWords(allowedWords).flatMap(term => occurrences(source, term));
  return [...new Set(terms.flatMap(term => {
    if (typeof term !== 'string' || !term.trim() || term.length > 100) return [];
    const candidate = normalize(term.trim());
    return occurrences(source, candidate).some(([start, end]) => !allowedRanges.some(([from, to]) => start < to && end > from)) ? [term.trim()] : [];
  }))].slice(0, 12);
}

/** Deterministic fallback: preserve the source, replacing only verified profanity.
 * Keep source offsets even when NFKC expands a character or combines accents.
 */
export function redactProfanity(text: string, terms: string[], allowedWords: string[]): string {
  let normalized = '';
  const offsets: Array<[number, number]> = [];
  for (const match of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const part = normalize(match[0]);
    normalized += part;
    for (let i = 0; i < part.length; i++) offsets.push([match.index!, match.index! + match[0].length]);
  }
  const allowed = normalizeAllowedWords(allowedWords).flatMap(term => occurrences(normalized, term));
  const ranges = verifiedProfanityTerms(text, terms, allowedWords).flatMap(term => occurrences(normalized, normalize(term)))
    .filter(([start, end]) => !allowed.some(([from, to]) => start < to && end > from))
    .map(([start, end]) => [offsets[start]![0], offsets[end - 1]![1]] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  let cleaned = text;
  for (const [start, end] of merged.reverse()) cleaned = cleaned.slice(0, start) + '[мат удалён]' + cleaned.slice(end);
  return cleaned;
}
