import { templateFetch } from './templateFetch';
import { publicFetch } from './publicFetch';
/**
 * playwrightRenderer.ts
 *
 * Renders user-uploaded HTML cover templates to PNG via Playwright + Chromium.
 * The user designs their own HTML/CSS, uploads it, and this module:
 *   1. Fetches the stored HTML from local storage
 *   2. Replaces {{slot}} placeholders with actual post content
 *   3. Injects brand CSS variables (--primary, --bg, --accent, --logo)
 *   4. Takes a full-page screenshot at the template's declared dimensions
 *   5. Uploads the PNG to local storage and returns a GeneratedCover
 *
 * Available slots in user templates:
 *   {{headline}}     — post cover headline (max ~60 chars)
 *   {{subheadline}}  — secondary line / summary (optional)
 *   {{stat}}         — key metric, e.g. "1,500+" (optional, milestone posts)
 *   {{category}}     — short category label, e.g. "UPDATE" (optional, news posts)
 *   {{logo}}         — brand logo URL (or empty string if no logo)
 *
 * Available CSS variables (injected into :root):
 *   --primary        — brand primary/accent color, e.g. #0098EA
 *   --bg             — background color, e.g. #000000
 *   --accent         — same as --primary (alias for convenience)
 *   --logo           — logo URL as CSS string (for background-image: var(--logo))
 *
 * Browser lifecycle:
 *   A single Chromium instance is kept alive as a module-level singleton.
 *   It is lazily launched on the first render call and reused for all subsequent
 *   requests. If the browser crashes and disconnects, the next call re-launches it.
 */

// playwright is imported lazily (dynamic import) so the server starts fine
// even when Chromium binaries are not installed.
import { putObject }         from './storage';
import { isBlockedRequestUrl } from './ssrfGuard';
import type { GeneratedCover } from './imageGenerator';
import type { TemplateBrand }  from './templateRenderer';
import type { TemplateClassification } from './aiGenerator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Browser = any;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HtmlRenderInput {
  /** Public URL of the user's stored HTML template file */
  htmlTemplateUrl:  string;
  brand:            TemplateBrand;
  classification:   TemplateClassification;
  headline:         string;
  aspectRatio?:     string;
}

// ─── Browser singleton ────────────────────────────────────────────────────────

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  // Dynamic import — keeps the module loadable when playwright/Chromium absent
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = await import('playwright');
  console.log('[playwrightRenderer] Launching Chromium...');
  _browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  }).catch((err: Error) => {
    console.error(
      '[playwrightRenderer] FATAL: Chromium launch failed.\n' +
      '  The Docker image installs it via: npx playwright install --with-deps chromium\n' +
      '  Error:', err.message,
    );
    throw err;
  });
  _browser.on('disconnected', () => {
    console.warn('[playwrightRenderer] Browser disconnected, will re-launch on next render');
    _browser = null;
  });
  return _browser;
}

/**
 * Closes the shared Chromium.
 *
 * The long-running server never calls this — it wants the browser warm. One-shot
 * scripts (seeds) MUST: an open browser keeps the event loop alive, so `node`
 * hangs forever after the script's last line and the command never returns.
 */
export async function closeBrowser(): Promise<void> {
  if (!_browser) return;
  const browser = _browser;
  _browser = null;
  await browser.close().catch((err: Error) =>
    console.warn('[playwrightRenderer] browser close failed:', err.message));
}

// ─── SSRF guard ─────────────────────────────────────────────────────────────
// Cover HTML (user-uploaded templates and AI-generated markup) is rendered in a
// real browser. Intercept every subresource request and abort any that targets
// a non-public address or a non-http(s) scheme, so a crafted template cannot
// probe the internal network or read local files into the screenshot.
async function guardPage(page: Browser): Promise<void> {
  await page.routeWebSocket('**/*', (socket: { close: () => void }) => socket.close());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.route('**/*', async (route: any) => {
    try {
      if (await isBlockedRequestUrl(route.request().url())) return route.abort();
      if (!/^https?:/.test(route.request().url())) return route.continue();
      if (route.request().method() !== 'GET') return route.abort();
      const response = await publicFetch(route.request().url(), { maxBytes: 16 * 1024 * 1024 });
      const headers = Object.fromEntries(response.headers.entries());
      delete headers['content-length']; delete headers['transfer-encoding'];
      return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
    } catch {
      return route.abort();
    }
  });
}

// ─── Dimensions ───────────────────────────────────────────────────────────────

function getDimensions(ratio?: string): { W: number; H: number } {
  switch (ratio) {
    case '16:9': return { W: 1080, H: 607  };
    case '4:5':  return { W: 1080, H: 1350 };
    case '9:16': return { W: 607,  H: 1080 };
    default:     return { W: 1080, H: 1080 };
  }
}

// ─── Slot replacement ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function replaceSlots(html: string, slots: Record<string, string>): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = slots[key];
    return val !== undefined ? escapeHtml(val) : '';
  });
}

// ─── Emoji fallback font ──────────────────────────────────────────────────────
// Linux Chromium on Render has no system emoji font, so any emoji in headlines,
// slot content, user templates, or AI-generated markup renders as tofu (□).
// Inject Noto Color Emoji as a webfont and append it to every font-family chain
// so emoji glyphs resolve. display=block makes document.fonts.ready wait for it.
const EMOJI_FONT_INJECT =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=block">\n' +
  // Lowest-priority default: injected before the template's own styles, so a
  // template body font-family rule still wins. Unquoted family name on purpose —
  // quotes would break inside style="" attributes rewritten below.
  '<style id="cf-emoji-font">body { font-family: sans-serif, Noto Color Emoji; }</style>' +
  // tsx/esbuild (keepNames) wraps named arrows inside page.evaluate callbacks in
  // a __name() helper that does not exist in the browser: every evaluate with a
  // named inner function (autoFitText, collapseEmptyBlocks, measureContentZone)
  // throws "__name is not defined" when the server runs via tsx. Define a no-op
  // shim on every rendered page so the serialized callbacks resolve it.
  '<script id="cf-esbuild-name-shim">globalThis.__name = globalThis.__name || function (t) { return t; };</script>';

function injectEmojiFallback(html: string): string {
  // The family list is bare chars or complete quoted names — an unpaired quote
  // (i.e. the closing quote of a style="" attribute) ends the match, so inline
  // declarations are rewritten without swallowing the attribute delimiter.
  const withFamilies = html.replace(
    /font-family\s*:\s*((?:[^;{}<"']|"[^"<]*"|'[^'<]*')+)/gi,
    (match, families: string) =>
      /noto color emoji/i.test(families)
        ? match
        : `font-family: ${families.trim()}, Noto Color Emoji`,
  );
  return /<head[\s>]/i.test(withFamilies)
    ? withFamilies.replace(/(<head[^>]*>)/i, `$1\n${EMOJI_FONT_INJECT}`)
    : EMOJI_FONT_INJECT + withFamilies;
}

// ─── CSS variable injection ───────────────────────────────────────────────────

function buildCssVars(brand: TemplateBrand): string {
  const logoUrl = brand.logoUrl ?? '';
  // Emit `none` (not url("")) when absent so `background-image: var(--logo)`
  // resolves cleanly and templates can gate logo-only chrome on it.
  const logoVal = logoUrl ? `url("${logoUrl.replace(/"/g, '\\"')}")` : 'none';
  return `
<style id="cf-brand-vars">
:root {
  --primary: ${brand.primaryColor};
  --accent:  ${brand.primaryColor};
  --bg:      ${brand.bgColor};
  --logo:    ${logoVal};
}
</style>`;
}

/** Adds `has-logo` to <body> when the channel has a logo, so templates can show
 *  the brand logo in place of a placeholder mark (and hide it otherwise). */
function addHasLogoClass(html: string, brand: TemplateBrand): string {
  if (!brand.logoUrl) return html;
  if (/<body[^>]*\sclass=["']/i.test(html)) return html.replace(/(<body[^>]*\sclass=["'])/i, '$1has-logo ');
  if (/<body/i.test(html)) return html.replace(/<body/i, '<body class="has-logo"');
  return html;
}

// ─── Auto-fit text (shrink-to-box) ──────────────────────────────────────────
// Designer templates use large fixed font sizes tuned for SHORT content. When a
// slot receives longer text the word no longer fits one line and the browser
// breaks it mid-word ("POLYMARK ET"). To prevent that, for every text box we:
//   1. forbid mid-word breaking (so a too-wide word overflows measurably);
//   2. shrink its font-size until the content no longer overflows its box.
// This is the same "fit" behaviour template-image services (Placid etc.) use —
// generic, no per-template annotation, runs entirely in-page in a few ms.
async function autoFitText(page: Browser): Promise<void> {
  try {
    await page.evaluate(() => {
      // Browser globals — typed via cast since the server tsconfig has no DOM lib.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = globalThis as any;
      const doc = win.document;

      // A "text box" is an element that holds text and has no BLOCK-level child
      // (its children, if any, are inline spans — e.g. a title split into
      // <span class="white">/<span class="accent">). Font-size lives on it.
      const isInline = (el: unknown): boolean => {
        const d = win.getComputedStyle(el).display;
        return d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'contents';
      };
      const isTextBox = (el: { children: ArrayLike<unknown>; textContent?: string }): boolean => {
        if (!(el.textContent || '').trim()) return false;
        for (const c of Array.from(el.children)) if (!isInline(c)) return false;
        return true;
      };

      for (const el of Array.from(doc.body.querySelectorAll('*')) as any[]) {
        if (!isTextBox(el)) continue;
        // Stop mid-word breaks (overflow-wrap/word-break inherit to inline spans),
        // so a too-wide word overflows the box instead of shattering.
        el.style.wordBreak = 'normal';
        el.style.overflowWrap = 'normal';
        let size = parseFloat(win.getComputedStyle(el).fontSize);
        if (!size || size < 12) continue;
        const min = Math.max(8, size * 0.3);
        let guard = 0;
        // Height tolerance must absorb the font's ink overshoot: a glyph content
        // area (~1.15em for most sans, Space Grotesk ≈1.14em) taller than the
        // line box makes EVERY text box with a tight line-height report a
        // permanent scrollHeight excess, and a 1px tolerance shrink-loops such
        // text to the minimum. Estimate that overshoot and only treat anything
        // beyond it (a genuinely clipped line) as vertical overflow.
        const overflows = () => {
          const cs = win.getComputedStyle(el);
          const fs = parseFloat(cs.fontSize) || size;
          const lh = parseFloat(cs.lineHeight) || fs * 1.2;
          const inkSlack = Math.max(0, fs * 1.15 - lh);
          return el.scrollWidth > el.clientWidth + 2 ||
                 el.scrollHeight > el.clientHeight + inkSlack + 6;
        };
        while (guard++ < 40 && size > min && overflows()) {
          size *= 0.94;
          el.style.fontSize = `${size}px`;
        }
      }
    });
  } catch (err) {
    console.warn('[playwrightRenderer] autoFitText failed (non-fatal):', (err as Error).message);
  }
}

// ─── Collapse empty slot blocks ─────────────────────────────────────────────
// When a slot resolves to empty (e.g. a post with no real numbers leaves all
// {{METRIC*}} blank — we forbid inventing figures), the template still draws the
// now-empty block + its decorative dividers, leaving an ugly skeleton. This pass
// hides any block that ended up with no text/image/background, plus the leftover
// decorative separators around removed items. Generic — no per-template config.
async function collapseEmptyBlocks(page: Browser): Promise<void> {
  try {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = globalThis as any;
      const doc = win.document;

      const hasText = (el: any): boolean => (el.textContent || '').replace(/\s+/g, '').length > 0;
      const hasBgImage = (el: any): boolean => {
        const nodes = [el, ...Array.from(el.querySelectorAll('*'))] as any[];
        return nodes.some(n => {
          const b = win.getComputedStyle(n).backgroundImage;
          return b && b !== 'none';
        });
      };
      // Drawn SVG shapes (e.g. a decorative <svg> dot lattice / figures) are
      // visible content too — otherwise an <svg> full of <circle>s reads as an
      // "empty" block (no text/img/bg-image) and gets hidden, stripping the art.
      const hasShape = (el: any): boolean =>
        (typeof el.tagName === 'string' && el.tagName.toLowerCase() === 'svg') ||
        !!el.querySelector('svg, circle, rect, path, line, polygon, polyline, ellipse');
      // Content = real text, a real <img>, a background image (logos/icons), or SVG art.
      const isContent = (el: any): boolean => hasText(el) || !!el.querySelector('img') || hasBgImage(el) || hasShape(el);

      const all = Array.from(doc.body.querySelectorAll('*')) as any[];

      // Pass 1: hide container blocks that have children but no content at all
      // (e.g. a whole metrics row, or a single metric card, whose slots are empty).
      for (const el of all) {
        if (el.children.length > 0 && !isContent(el)) el.style.display = 'none';
      }

      // Pass 2: in any parent that just lost a child, drop the leftover blank
      // decorative leaves (e.g. divider lines between removed metric cards).
      for (const parent of all) {
        if (parent.style?.display === 'none') continue;
        const kids = Array.from(parent.children) as any[];
        if (!kids.some(k => k.style?.display === 'none')) continue;
        for (const k of kids) {
          if (k.style?.display === 'none') continue;
          if (k.children.length === 0 && !isContent(k)) k.style.display = 'none';
        }
      }
    });
  } catch (err) {
    console.warn('[playwrightRenderer] collapseEmptyBlocks failed (non-fatal):', (err as Error).message);
  }
}

// ─── Measure where a template's text sits ───────────────────────────────────
// So the photo behind a template-over-photo cover can keep THAT zone calmer for
// legibility — instead of a hardcoded "lower half". Different templates place
// text differently (centered, bottom, left…); this reads it from the actual
// rendered layout. Generic — no per-template config.

/** Coarse region of a template's text content, used to steer photo composition. */
export type CalmZone = 'top' | 'bottom' | 'left' | 'right' | 'center' | 'full';

export async function measureContentZone(
  html:         string,
  aspectRatio?: string,
): Promise<CalmZone | null> {
  const { W, H } = getDimensions(aspectRatio);
  try {
    const browser = await getBrowser();
    const page    = await browser.newPage({ serviceWorkers: 'block' });
    await guardPage(page);
    try {
      await page.setViewportSize({ width: W, height: H });
      await page.setContent(injectEmojiFallback(html), { waitUntil: 'load', timeout: 15_000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(() => (globalThis as any).document.fonts.ready).catch(() => {});
      await page.waitForTimeout(200);
      // Match the final render so measured positions are real.
      await collapseEmptyBlocks(page);
      await autoFitText(page);
      const rect = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = globalThis as any;
        const doc = win.document;
        const isInline = (el: any): boolean => {
          const d = win.getComputedStyle(el).display;
          return d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'contents';
        };
        const isTextBox = (el: any): boolean => {
          if (!(el.textContent || '').trim()) return false;
          for (const c of Array.from(el.children)) if (!isInline(c)) return false;
          return true;
        };
        const isChrome = (el: any): boolean => !!el.closest('.topbar,.brand,.rubric-pill,.bottom,.tags,.handle,.logo,nav,header,footer');
        // Collect visible content text boxes with their font size. Ignore chrome
        // (brand bar, rubric pill, tags, footer): it is not the main headline
        // and must not steer the AI background composition.
        const boxes: { r: any; fs: number }[] = [];
        for (const el of Array.from(doc.body.querySelectorAll('*')) as any[]) {
          if (isChrome(el)) continue;
          if (!isTextBox(el)) continue;
          const cs = win.getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          boxes.push({ r, fs: parseFloat(cs.fontSize) || 0 });
        }
        if (boxes.length === 0) return null;
        // Only the DOMINANT text (the headline) drives the calm zone — not the
        // body, stats, or the tiny chrome (rubric, tags, byline) hugging the
        // edges, which would otherwise make every template measure as "full".
        const maxFs = Math.max(...boxes.map(b => b.fs));
        const threshold = maxFs * 0.9;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
        for (const b of boxes) {
          if (b.fs < threshold) continue;
          minX = Math.min(minX, b.r.left); minY = Math.min(minY, b.r.top);
          maxX = Math.max(maxX, b.r.right); maxY = Math.max(maxY, b.r.bottom);
          found = true;
        }
        if (!found) return null;
        const w = win.innerWidth, h = win.innerHeight;
        return { x: minX / w, y: minY / h, w: (maxX - minX) / w, h: (maxY - minY) / h };
      });
      if (!rect) return null;
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      let label: CalmZone;
      if (rect.w * rect.h > 0.6) label = 'full';
      else if (cy > 0.62)        label = 'bottom';
      else if (cy < 0.38)        label = 'top';
      else if (cx < 0.38)        label = 'left';
      else if (cx > 0.62)        label = 'right';
      else                       label = 'center';
      console.log(`[playwrightRenderer] content zone=${label} (cx=${cx.toFixed(2)}, cy=${cy.toFixed(2)})`);
      return label;
    } finally {
      await page.close();
    }
  } catch (err) {
    console.warn('[playwrightRenderer] measureContentZone failed (non-fatal):', (err as Error).message);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Renders an arbitrary HTML string to PNG.
 * Used for AI-generated covers where the HTML is already fully prepared.
 * Returns null on any error so the caller can fall back gracefully.
 */
export async function renderHtmlString(
  html:         string,
  aspectRatio?: string,
): Promise<GeneratedCover | null> {
  // Channel copy rule: dashes are "-", never em/en. Inputs are normalized
  // upstream, but the model can reintroduce typographic dashes when composing;
  // in markup these characters can only occur in text content, so a global
  // replace is safe.
  html = html.replace(/[—–―]/g, '-');

  const { W, H } = getDimensions(aspectRatio);
  let pngBuffer: Buffer;

  try {
    const browser = await getBrowser();
    const page    = await browser.newPage({ serviceWorkers: 'block' });
    await guardPage(page);
    try {
      await page.setViewportSize({ width: W, height: H });
      // 'load' instead of 'networkidle' — canvas requestAnimationFrame loops never
      // reach networkidle and would time out after 30 s on every user template.
      await page.setContent(injectEmojiFallback(html), { waitUntil: 'load', timeout: 15_000 });
      // Wait for web fonts (templates often load Google Fonts) so the screenshot
      // uses the intended typeface, not a fallback. Non-fatal if it times out.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(() => (globalThis as any).document.fonts.ready).catch(() => {});
      // Extra settle time so CSS transitions and font rendering finish
      await page.waitForTimeout(300);
      // Remove blocks whose slots came back empty (e.g. metrics with no figures),
      // then shrink any text that overflows its box. Both run before body-scale.
      await collapseEmptyBlocks(page);
      await autoFitText(page);
      // Auto-fit: the model targets ${W}×${H} but often overshoots the height,
      // and overflow:hidden then clips the bottom card. Measure the real content
      // height and, if it overflows, uniformly scale the body down to fit. The
      // html background is filled with the body's bg so the side margins created
      // by uniform scaling blend in instead of showing as gaps.
      await page.evaluate(({ H }: { H: number }) => {
        // Browser globals — typed via cast since the server tsconfig has no DOM lib.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = globalThis as any;
        const body = win.document.body;
        const root = win.document.documentElement;
        const bg = win.getComputedStyle(body).backgroundColor;
        root.style.margin = '0';
        root.style.background = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#000';
        // Remember the template's own height/overflow to restore after measuring.
        const prevHeight   = body.style.height;
        const prevOverflow = body.style.overflow;
        // Measure natural content height with overflow released.
        body.style.height = 'auto';
        body.style.overflow = 'visible';
        const real = body.scrollHeight;
        if (real > H + 2) {
          // Content overflows the canvas — scale the whole body down to fit.
          const scale = H / real;
          body.style.height = `${real}px`;
          body.style.overflow = 'hidden';
          body.style.transformOrigin = 'top center';
          body.style.transform = `scale(${scale})`;
        } else {
          // Fits — restore the template's own height/overflow so fixed-height,
          // space-between layouts keep filling the full canvas (no black gap).
          body.style.height = prevHeight;
          body.style.overflow = prevOverflow;
        }
      }, { H });
      const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
      pngBuffer = Buffer.from(screenshot);
    } finally {
      await page.close();
    }
  } catch (err) {
    console.warn('[playwrightRenderer] renderHtmlString screenshot failed:', (err as Error).message);
    return null;
  }

  try {
    const obj = await putObject(`covers/ai-html-${Date.now()}.png`, pngBuffer, {
      contentType: 'image/png',
    });
    console.log(`[playwrightRenderer] AI HTML cover ${W}×${H} → ${obj.url}`);
    return { bannerUrl: obj.url, coverBaseUrl: null };
  } catch (err) {
    console.warn('[playwrightRenderer] Blob upload failed:', (err as Error).message);
    return null;
  }
}

/**
 * Renders a user's HTML cover template to PNG.
 * Returns null on any error so the caller can fall back to Satori templates.
 */
export async function renderHtmlTemplate(
  input: HtmlRenderInput,
): Promise<GeneratedCover | null> {
  let html: string;
  try {
    const res = await templateFetch(input.htmlTemplateUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching template`);
    html = await res.text();
  } catch (err) {
    console.warn('[playwrightRenderer] Failed to fetch HTML template:', (err as Error).message);
    return null;
  }

  // Build slot map from classification + brand
  const { classification, headline, brand } = input;
  const slots: Record<string, string> = {
    headline:    headline,
    subheadline: classification.subheadline ?? '',
    stat:        classification.stat        ?? '',
    category:    classification.category    ?? '',
    logo:        brand.logoUrl              ?? '',
  };

  // Inject CSS vars right after <head> (or at the very top if no <head>)
  // Inject brand vars at the END of <head> — AFTER the template's own <style>
  // so its :root defaults (fallbacks incl. --logo:none) are overridden, not the
  // other way around. Matches claudeHtmlGenerator.insertIntoHead.
  const cssVars  = buildCssVars(brand);
  let finalHtml  = addHasLogoClass(replaceSlots(html, slots), brand);
  if (/<\/head>/i.test(finalHtml)) {
    finalHtml = finalHtml.replace(/<\/head>/i, `${cssVars}\n</head>`);
  } else if (/<head[\s>]/i.test(finalHtml)) {
    finalHtml = finalHtml.replace(/(<head[^>]*>)/i, `$1\n${cssVars}`);
  } else {
    finalHtml = cssVars + finalHtml;
  }

  const { W, H } = getDimensions(input.aspectRatio);

  let pngBuffer: Buffer;
  try {
    const browser = await getBrowser();
    const page    = await browser.newPage({ serviceWorkers: 'block' });
    await guardPage(page);
    try {
      await page.setViewportSize({ width: W, height: H });
      await page.setContent(injectEmojiFallback(finalHtml), { waitUntil: 'load', timeout: 15_000 });
      // Wait for web fonts (incl. the injected emoji font) before the screenshot.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(() => (globalThis as any).document.fonts.ready).catch(() => {});
      await page.waitForTimeout(300);
      // Hide empty slot blocks, then shrink overflowing text (no mid-word breaks).
      await collapseEmptyBlocks(page);
      await autoFitText(page);
      const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
      pngBuffer = Buffer.from(screenshot);
    } finally {
      await page.close();
    }
  } catch (err) {
    console.warn('[playwrightRenderer] Screenshot failed:', (err as Error).message);
    return null;
  }

  try {
    const obj = await putObject(`covers/html-${Date.now()}.png`, pngBuffer, {
      contentType: 'image/png',
    });
    console.log(`[playwrightRenderer] HTML template ${W}×${H} → ${obj.url}`);
    return { bannerUrl: obj.url, coverBaseUrl: null };
  } catch (err) {
    console.warn('[playwrightRenderer] Blob upload failed:', (err as Error).message);
    return null;
  }
}

// ─── Render a market demo preview ─────────────────────────────────────────────
// Like renderHtmlTemplate, but fills an ARBITRARY slot map (not just the 5
// standard slots) with curated demo values — used to pre-render the static
// preview PNGs shown in the Styles market. Stores under a `styles/previews/`
// path so previews are easy to identify/clean up.

export interface PreviewRenderInput {
  htmlTemplateUrl: string;
  brand:           TemplateBrand;
  /** Full slot→value map (any {{key}} in the template). */
  slots:           Record<string, string>;
  aspectRatio?:    string;
}

export async function renderHtmlPreview(input: PreviewRenderInput): Promise<string | null> {
  let html: string;
  try {
    const res = await templateFetch(input.htmlTemplateUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching template`);
    html = await res.text();
  } catch (err) {
    console.warn('[playwrightRenderer] preview: failed to fetch template:', (err as Error).message);
    return null;
  }

  // Slot map always carries {{logo}} from the brand so logo-bearing templates work.
  const slots: Record<string, string> = { logo: input.brand.logoUrl ?? '', ...input.slots };
  // Inject brand vars at the END of <head> so template :root defaults are
  // overridden (see note in the main render path above).
  const cssVars = buildCssVars(input.brand);
  let finalHtml = addHasLogoClass(replaceSlots(html, slots), input.brand);
  finalHtml = /<\/head>/i.test(finalHtml)
    ? finalHtml.replace(/<\/head>/i, `${cssVars}\n</head>`)
    : /<head[\s>]/i.test(finalHtml)
      ? finalHtml.replace(/(<head[^>]*>)/i, `$1\n${cssVars}`)
      : cssVars + finalHtml;

  const { W, H } = getDimensions(input.aspectRatio);

  let pngBuffer: Buffer;
  try {
    const browser = await getBrowser();
    const page    = await browser.newPage({ serviceWorkers: 'block' });
    await guardPage(page);
    try {
      await page.setViewportSize({ width: W, height: H });
      await page.setContent(injectEmojiFallback(finalHtml), { waitUntil: 'load', timeout: 15_000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(() => (globalThis as any).document.fonts.ready).catch(() => {});
      await page.waitForTimeout(300);
      await collapseEmptyBlocks(page);
      await autoFitText(page);
      const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
      pngBuffer = Buffer.from(screenshot);
    } finally {
      await page.close();
    }
  } catch (err) {
    console.warn('[playwrightRenderer] preview screenshot failed:', (err as Error).message);
    return null;
  }

  try {
    const obj = await putObject(`styles/previews/preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`, pngBuffer, {
      contentType: 'image/png',
    });
    console.log(`[playwrightRenderer] style preview ${W}×${H} → ${obj.url}`);
    return obj.url;
  } catch (err) {
    console.warn('[playwrightRenderer] preview upload failed:', (err as Error).message);
    return null;
  }
}
