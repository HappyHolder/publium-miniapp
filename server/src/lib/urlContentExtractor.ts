/**
 * urlContentExtractor.ts
 *
 * Fetches a web page and extracts its readable article content (title +
 * description + body paragraphs) so the AI rewrites the real article instead of
 * just seeing a bare URL string.
 *
 * Dependency-free: native fetch + lightweight HTML heuristics. Good enough for
 * news/blog pages with Open Graph tags and <article>/<p> markup. Never throws —
 * returns null when the page can't be fetched or has too little usable text, so
 * callers can fall back to the original input.
 */

import { publicFetch } from './publicFetch';

export interface ExtractedArticle {
  title: string;
  text:  string;
}

const FETCH_TIMEOUT_MS = 9_000;
const MAX_HTML_BYTES    = 2_000_000; // cap parsed HTML at ~2 MB
const MAX_TEXT_CHARS    = 4_000;     // cap content handed to the model

// ─── HTML helpers ──────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°', copy: '©',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named ?? m;
  });
}

/** Strips all tags, decodes entities, and collapses whitespace. */
function clean(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reads a <meta property|name="key" content="..."> value (attribute order agnostic). */
function getMeta(html: string, key: string): string {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i'),
  )?.[0];
  if (!tag) return '';
  const content = tag.match(/content=["']([\s\S]*?)["']/i)?.[1] ?? '';
  return clean(content);
}

/**
 * Pure extraction from a raw HTML string — no network. Exported for testing.
 * Returns null when there isn't enough usable text.
 */
export function extractArticleFromHtml(html: string): ExtractedArticle | null {
  if (!html || typeof html !== 'string') return null;

  // Drop comments and non-content blocks before paragraph scanning.
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ');

  const title = getMeta(html, 'og:title') || getMeta(html, 'twitter:title') ||
    clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const description = getMeta(html, 'og:description') || getMeta(html, 'description');

  // Prefer the main article region, else <main>, else the whole stripped doc.
  const region =
    stripped.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ||
    stripped.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ||
    stripped;

  // Collect meaningful paragraphs (skip nav/boilerplate by length).
  const paragraphs: string[] = [];
  const seen = new Set<string>();
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(region)) !== null) {
    const txt = clean(m[1] ?? '');
    if (txt.length >= 40 && !seen.has(txt)) {
      seen.add(txt);
      paragraphs.push(txt);
    }
  }

  let body = paragraphs.join('\n\n');

  // Assemble: title, then description if the body is thin, then the body.
  const parts: string[] = [];
  if (title) parts.push(title);
  if (body.replace(/\s/g, '').length < 200 && description) parts.push(description);
  if (body) parts.push(body);

  let text = parts.join('\n\n').trim().slice(0, MAX_TEXT_CHARS);

  // Require a real amount of content, otherwise signal failure.
  if (text.replace(/\s/g, '').length < 80) return null;

  return { title: title || description.slice(0, 80) || 'Article', text };
}

// ─── Network ───────────────────────────────────────────────────────────────────

/** Resolves the response charset from headers, then a <meta charset> sniff. */
function resolveCharset(contentType: string, head: string): string {
  const fromHeader = contentType.match(/charset=([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const fromMeta =
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ||
    head.match(/charset=["']?([\w-]+)/i)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

/**
 * Fetches `url` and extracts its article content. Returns null on any failure
 * (network, non-HTML, blocked, too little text). Never throws.
 */
export async function fetchArticle(url: string): Promise<ExtractedArticle | null> {
  if (!/^https?:\/\//i.test(url)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await publicFetch(url, { maxBytes: MAX_HTML_BYTES, timeoutMs: FETCH_TIMEOUT_MS });
    if (!res || !res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !/html|xml/i.test(contentType)) return null; // skip pdf/img/json

    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_HTML_BYTES);
    const charset = resolveCharset(contentType, buf.subarray(0, 2_048).toString('latin1'));

    let html: string;
    try {
      html = new TextDecoder(charset).decode(buf);
    } catch {
      html = buf.toString('utf-8'); // unknown charset → best effort
    }

    return extractArticleFromHtml(html);
  } catch {
    return null; // timeout / DNS / TLS / abort — caller falls back
  } finally {
    clearTimeout(timer);
  }
}
