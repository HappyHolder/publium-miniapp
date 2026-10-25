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

export function profanityNotice(label: string, notice: string, rewrite: string | null, warning = ''): string {
  const heading = `${label}, ${notice.trim() || 'Пиши без мата.'}`;
  return [heading, rewrite ? `«${rewrite}»` : '', warning].filter(Boolean).join('\n\n');
}
