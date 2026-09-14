import { templateFetch } from '../templateFetch';
import { publicFetch } from '../publicFetch';
/**
 * carouselEngine/templateResolver.ts
 *
 * Fetches the three slide templates and decides whether a carousel is even
 * possible. Runs BEFORE the planner, so a channel without templates never pays
 * for the planner's AI call.
 *
 * The `item` template is fetched once and reused for every point — a 7-point
 * carousel must not pull the same HTML seven times over the network.
 */

import type { CarouselContext, CarouselScenario, CarouselTemplateSet, ResolvedTemplates } from './types';

// ─── Fetch cache ──────────────────────────────────────────────────────────────
// Slide templates are immutable per URL (re-seeding a pack writes a new file, and
// applying a style copies the URL into the channel). A short TTL keeps a restart
// of the storage layer from serving stale HTML forever.

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { html: string; at: number }>();

/** Fetches a template's HTML, memoized per URL. Returns null on any failure. */
async function fetchTemplate(url: string): Promise<string | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.html;
  try {
    const res = await templateFetch(url);
    if (!res.ok) {
      console.warn(`[carouselEngine] template fetch HTTP ${res.status}: ${url}`);
      return null;
    }
    const html = await res.text();
    cache.set(url, { html, at: Date.now() });
    return html;
  } catch (err) {
    console.warn('[carouselEngine] template fetch failed:', (err as Error).message);
    return null;
  }
}

/** A slide template must expose {{SLOT}} placeholders — we fill them ourselves. */
function hasSlots(html: string): boolean {
  return /\{\{\w+\}\}/.test(html);
}

export type TemplateResolution =
  | { ok: true;  templates: ResolvedTemplates }
  | { ok: false; scenario: Extract<CarouselScenario, 'no_template' | 'template_invalid' | 'template_fetch_failed'>; reason: string };

/**
 * Resolves the template set. `item` is mandatory: it is the slide repeated per
 * point, and without it there is nothing to repeat. `cover` and `outro` are
 * optional — a missing one just yields a shorter carousel, never a failure.
 */
export async function resolveTemplates(ctx: CarouselContext): Promise<TemplateResolution> {
  const set: CarouselTemplateSet = ctx.templates;

  if (!set.item) {
    return { ok: false, scenario: 'no_template', reason: 'channel has no carousel item template' };
  }

  const itemHtml = await fetchTemplate(set.item);
  if (!itemHtml) {
    return { ok: false, scenario: 'template_fetch_failed', reason: 'item template URL is dead' };
  }
  if (!hasSlots(itemHtml)) {
    return { ok: false, scenario: 'template_invalid', reason: 'item template has no {{SLOT}} placeholders' };
  }

  // A cover/outro that fails to fetch or carries no slots is dropped, not fatal.
  const optional = async (url?: string): Promise<string | null> => {
    if (!url) return null;
    const html = await fetchTemplate(url);
    if (!html) return null;
    return hasSlots(html) ? html : null;
  };

  return {
    ok: true,
    templates: {
      cover: await optional(set.cover),
      item:  itemHtml,
      outro: await optional(set.outro),
    },
  };
}
