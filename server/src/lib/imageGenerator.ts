import { publicFetch } from './publicFetch';
/**
 * imageGenerator.ts
 *
 * Generates one cover image and composites the headline and logo onto it with
 * sharp. Returns the hosted cover + the clean text-free base, or null when
 * generation is disabled or fails.
 *
 * The picture comes from the direct OpenAI Images API (see openaiImage.ts) —
 * previously the same gpt-image model rented through Replicate, which meant
 * creating a prediction, polling it and downloading the result. Now it is one
 * call that returns bytes, so nothing here needs a URL round trip.
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { putObject } from './storage';
import { env } from '../env';
import { openAiImage, sizeForAspectRatio } from './openaiImage';

// Bundled Cyrillic-capable font for the headline overlay. Resolved across the
// possible runtime cwds (dist/lib in prod, src/lib under tsx). Passing an explicit
// fontfile to sharp's text renderer removes any dependency on system fonts being
// installed on the host (Render). Null → fall back to the default sans font.
function resolveFontFile(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../assets/DejaVuSans-Bold.ttf'),
    path.resolve(process.cwd(), 'assets/DejaVuSans-Bold.ttf'),
    path.resolve(process.cwd(), 'server/assets/DejaVuSans-Bold.ttf'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  console.warn('[imageGenerator] Headline font not found — falling back to system sans');
  return null;
}
const FONT_FILE = resolveFontFile();

// ─── Public API ───────────────────────────────────────────────────────────────

interface RawBrandColor {
  name?:  unknown;
  hex?:   unknown;
  usage?: unknown;
}

/**
 * Short negative suffix appended to every image prompt.
 *
 * Image generation models render everything as visual content — long
 * instruction blocks get drawn on the image. Only minimal, well-known
 * negative tokens are safe to append.
 */
const NEGATIVE_SUFFIX = ', no text, no typography, no letters, no words, no watermark, no border, no frame, no margin, full-bleed';

/**
 * Returns the first uploaded style reference URL from visualKit, or null.
 * Used as image input for models that support it (e.g. gpt-image-2).
 *
 * The logo is deliberately NOT a fallback here: it is branding, not a style
 * reference, and it is composited by sharp after generation anyway. Feeding it
 * as img2img input made every cover of a channel without references inherit the
 * logo's shapes and finish.
 */
function extractReferenceImage(visualKit: unknown): string | null {
  if (!visualKit || typeof visualKit !== 'object') return null;
  const vk = visualKit as Record<string, unknown>;

  const refs = vk['references'];
  if (Array.isArray(refs)) {
    for (const r of refs) {
      const url = typeof r === 'string' ? r : (r as Record<string, unknown>)?.['url'];
      if (typeof url === 'string' && url.startsWith('http')) return url;
    }
  }

  return null;
}

/**
 * Appends a minimal BrandKit mood suffix to the image prompt.
 *
 * When the AI (generateImagePromptWithAI) is available it already describes
 * colors and style in natural language — no hex tokens needed here.
 * This function adds only a short mood adjective from the font preset as
 * extra style reinforcement. Colors are intentionally NOT added here to
 * prevent hex codes from appearing in the final prompt.
 *
 * Never throws. Returns '' when nothing to add.
 */
export function buildVisualKitPromptHints(visualKit: unknown): string {
  if (!visualKit || typeof visualKit !== 'object') return '';
  const vk = visualKit as Record<string, unknown>;

  const tokens: string[] = [];

  // Font preset → short mood adjective only (no color tokens, no hex)
  const presetMoodMap: Record<string, string> = {
    serif:       'editorial aesthetic',
    sans:        'clean modern aesthetic',
    mono:        'tech minimal aesthetic',
    display:     'bold graphic aesthetic',
    handwritten: 'organic handcrafted aesthetic',
  };
  const preset = typeof vk['visualFontPreset'] === 'string' ? vk['visualFontPreset'] : 'default';
  if (preset !== 'default' && presetMoodMap[preset]) {
    tokens.push(presetMoodMap[preset]);
  }

  return tokens.length > 0 ? ', ' + tokens.join(', ') : '';
}

function buildVisualMoodSuffix(vk: Record<string, unknown> | null): string {
  if (!vk) return '';
  const style = [
    vk['visualCoverStyle'],
    vk['backgroundStyle'],
    vk['bannerTemplate'],
  ].filter((v): v is string => typeof v === 'string').join(' ').toLowerCase();

  const darkByStyle = /dark|near-black|black|noir|night|темн|тёмн|glass|стекл/.test(style);
  const rawColors = vk['brandColors'];
  const darkByColor = Array.isArray(rawColors) && rawColors.some(c => {
    const hex = (c as Record<string, unknown>)?.['hex'];
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 45;
  });

  if (!darkByStyle && !darkByColor) return '';
  return '. Brand mood: dark low-key near-black premium background, controlled highlights, clear contrast for the HTML overlay, no flat black overlay';
}
export interface GenerateImageInput {
  prompt:     string;
  visualKit?: unknown;
  aspectRatio?: '1:1' | '16:9' | '4:5' | '9:16';
  /**
   * Short headline (usually the post title) to overlay on the cover as real,
   * crisp text via sharp — only applied when visualKit.textOnCover !== false.
   * The model itself still renders a clean, text-free background (flux-schnell
   * draws garbled letters), and we composite legible typography on top.
   */
  headline?:  string;
  /**
   * When true, produce a clean text-free image with NO headline/logo overlay —
   * used as the background layer for the AI+HTML hybrid cover.
   */
  backgroundOnly?: boolean;
  backgroundKind?: 'photo' | 'abstract';
  /**
   * Where the template's text sits, so the photo keeps THAT zone a touch calmer
   * for legibility while the rest of the frame stays full of detail. Set only on
   * the template-over-photo path (measured from the actual template). 'full' = no
   * calm zone (fill edge to edge). When omitted on a backgroundOnly image, the
   * old behaviour applies (reserve a dark, empty lower half for an AI overlay).
   */
  calmZone?: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'full';
  /**
   * Model override. Accepts a bare id ('gpt-image-2') or a legacy Replicate slug
   * ('openai/gpt-image-2') — the owner prefix is stripped. Defaults to
   * env.OPENAI_IMAGE_MODEL.
   */
  model?: string;
}

/** Result of cover generation: the final (text-baked) cover + the clean base. */
export interface GeneratedCover {
  /** Composited cover (background + headline + logo) to show and publish. */
  bannerUrl:    string;
  /** Clean, text-free background re-hosted to Blob — lets the headline be
   *  re-rendered later without regenerating the picture. Null if not re-hosted. */
  coverBaseUrl: string | null;
}

/**
 * Generates an image and returns the composited cover + clean base, or null if
 * generation is disabled, misconfigured, or hits a non-fatal error.
 *
 * Never throws — callers (draftGenerator) can safely ignore a null result.
 */
export async function generateImageForPost(
  input: GenerateImageInput,
): Promise<GeneratedCover | null> {

  // ── Guard: image generation switched off entirely ─────────────────────────
  // 'replicate' is the legacy value that means "on" — kept so existing
  // deployments keep generating covers without an env edit.
  if (env.IMAGE_PROVIDER === 'none') return null;

  if (!env.OPENAI_API_KEY) {
    console.warn('[imageGenerator] OPENAI_API_KEY is not set — skipping image generation');
    return null;
  }

  // Callers may still pass a Replicate-style slug ('openai/gpt-image-2'); the
  // direct API wants the bare model id.
  const model = (input.model ?? env.OPENAI_IMAGE_MODEL).replace(/^[^/]+\//, '');

  const userPrompt = input.prompt.trim();
  if (!userPrompt) return null;

  // ── Prompt assembly ───────────────────────────────────────────────────────
  // visualCoverStyle is intentionally NOT prepended raw here — it is passed
  // as context to DeepSeek (generateImagePromptWithAI → buildVisualStyleDescription)
  // which distils it into a clean English image description. Prepending a raw
  // style spec (possibly in Russian, multi-line, bullet-pointed) confuses the
  // image model and degrades output quality.
  const vkObj = (input.visualKit && typeof input.visualKit === 'object')
    ? input.visualKit as Record<string, unknown>
    : null;
  const rawAspectRatio = input.aspectRatio ?? vkObj?.['aspectRatio'];
  const aspectRatio: '1:1' | '16:9' | '4:5' | '9:16' =
    rawAspectRatio === '16:9' || rawAspectRatio === '4:5' || rawAspectRatio === '9:16'
      ? rawAspectRatio
      : '1:1';
  const brandTokens = buildVisualKitPromptHints(input.visualKit);
  // Respect the channel's logo usage: 'never' = no logo on the cover (e.g. a
  // writer who wants a clean illustration). 'always'/'when_relevant' keep it.
  const logoUsage = typeof vkObj?.['logoUsage'] === 'string' ? vkObj['logoUsage'] as string : undefined;
  const logoUrl = !input.backgroundOnly
    && logoUsage !== 'never'
    && typeof vkObj?.['logoUrl'] === 'string' && (vkObj['logoUrl'] as string).startsWith('http')
    ? vkObj['logoUrl'] as string
    : null;

  // Text-on-cover overlay: honour the visualKit.textOnCover toggle (default on,
  // matching the UI default). The model keeps producing a clean background; the
  // headline is drawn on top by sharp so it is always crisp and on-brand.
  // backgroundOnly (AI+HTML hybrid) → never overlay headline or logo: the HTML
  // layer draws all text/branding on top of this clean image.
  const textOnCover = !input.backgroundOnly && vkObj?.['textOnCover'] !== false;
  const headline = textOnCover && typeof input.headline === 'string' && input.headline.trim()
    ? input.headline.trim()
    : null;
  const brandColor = pickBrandColor(vkObj);

  // Background detail + visual style — channel settings (Cover settings, AI mode;
  // the hybrid reuses the same generated background, so it inherits these too).
  const bgDetailPhrase: Record<string, string> = {
    minimal:  'minimalist composition, lots of negative space, a single simple subject, clean and uncluttered',
    detailed: 'richly detailed, intricate, layered scene with depth',
  };
  const bgStylePhrase: Record<string, string> = {
    hyperreal: 'hyperrealistic, ultra-detailed, lifelike photography',
    cinematic: 'cinematic film still, dramatic lighting, shallow depth of field, color-graded',
    '3d':      '3D render, octane render, volumetric lighting, CGI',
    cartoon:   'flat 2D cartoon illustration, bold clean shapes, vector style',
    anime:     'anime style illustration, cel shading',
    clay:      'claymation, plasticine clay model, stop-motion look, soft studio light',
    pixel:     'pixel art, 8-bit retro game aesthetic, crisp pixelated shapes, limited palette, dithering',
    scifi:     'sci-fi concept art, futuristic high-tech world, sleek advanced technology, holographic UI, sleek surfaces',
    cyberpunk: 'cyberpunk aesthetic, neon-lit rainy night, blade-runner mood, high-tech low-life, glowing signage, deep shadows',
    vaporwave: 'vaporwave / synthwave, 80s retro-futurism, magenta-cyan neon gradient, sunset grid horizon, chrome, glitchy nostalgia',
    isometric: 'isometric 3D illustration, clean vector shapes, orthographic view, soft ambient shadows, tidy composition',
    minimal:   'minimalist flat design, generous negative space, simple bold shapes, restrained muted palette, clean',
    lowpoly:   'low-poly 3D, faceted geometric polygons, flat gradient shading, crystalline forms',
    glitch:    'glitch art, datamosh, chromatic aberration, scanlines, RGB channel shift, digital distortion',
    blueprint: 'technical blueprint schematic, white line-art on deep blue, engineering drawing, measurement grid, annotations',
    watercolor:'watercolor painting, soft translucent washes, bleeding pigments, textured cold-press paper, loose edges',
    oil:       'oil painting, visible impasto brushstrokes, rich layered texture, classical painterly lighting',
  };
  const detailKey = typeof vkObj?.['coverBgDetail'] === 'string' ? vkObj['coverBgDetail'] as string : 'balanced';
  const styleKey  = typeof vkObj?.['coverBgStyle']  === 'string' ? vkObj['coverBgStyle']  as string : 'auto';
  const styleHint = [bgStylePhrase[styleKey], bgDetailPhrase[detailKey]]
    .filter(Boolean).join(', ');
  const styleSuffix = styleHint ? `. Style: ${styleHint}` : '';
  const visualMoodSuffix = buildVisualMoodSuffix(vkObj);

  // Hybrid background composition. The "fill" wording is DETAIL-AWARE so it never
  // fights the detail setting — minimal must not be told to "fill with rich
  // detail" (that's why minimal looked busy before).
  const detailFill =
    detailKey === 'minimal'
      ? 'keep it minimal and clean — a single simple subject with generous negative space, uncluttered and calm, but the whole square still filled with a soft clean atmosphere (NO black bars, NO empty dead zones)'
      : detailKey === 'detailed'
        ? 'fill the whole frame with rich, layered detail, edge to edge'
        : 'a clear subject with the whole frame filled edge to edge';
  const calmZonePhrase: Record<string, string> = {
    top: 'the top area', bottom: 'the lower area', left: 'the left side',
    right: 'the right side', center: 'the central area',
  };
  const focalAvoidancePhrase: Record<string, string> = {
    top: 'place the main focal subject away from the top text/header area',
    bottom: 'place the main focal subject away from the lower text/tags area',
    left: 'place the main focal subject away from the left text area',
    right: 'place the main focal subject away from the right text area',
    center: 'place the main focal subject off-center or in the background, never directly behind the central headline',
  };
  const zoneClause = (input.calmZone && input.calmZone !== 'full' && calmZonePhrase[input.calmZone])
    ? `; keep ${calmZonePhrase[input.calmZone]} a touch calmer and lower-contrast (NOT empty, NOT black) so overlaid text stays legible; ${focalAvoidancePhrase[input.calmZone]}`
    : '';
  const compositionHint = input.backgroundOnly
    ? (input.backgroundKind === 'abstract'
        ? '. Composition: abstract low-detail background texture only, soft atmospheric material, blurred shapes, subtle noise, premium lighting, no literal room, no person, no object, no device, no focal subject; fill the whole frame calmly edge to edge'
        : input.calmZone
          ? `. Composition: ${detailFill}${zoneClause}`
          : '. Composition: main subject in the upper third of the frame, slightly above center; the lower half is calm, uncluttered negative space with natural atmosphere only, reserved for a text overlay')
    : '';

  // Logo is composited via sharp AFTER generation — never passed to the model
  const prompt = `${userPrompt}${brandTokens}${styleSuffix}${visualMoodSuffix}${compositionHint}${NEGATIVE_SUFFIX}`;

  // Reference image: first uploaded reference from visualKit (or logo as fallback).
  // Passed as img2img input so the model inherits the brand's color palette and
  // visual atmosphere. prompt_strength 0.35 — low enough to keep creative freedom,
  // high enough to pull in dark/neon/color mood from the reference.
  const refImageUrl = extractReferenceImage(input.visualKit);

  console.log(`[imageGenerator] model=${model} size=${sizeForAspectRatio(aspectRatio)} logo=${logoUrl ? 'yes' : 'no'} ref=${refImageUrl ? 'yes' : 'no'} detail=${detailKey} style=${styleKey} promptLen=${prompt.length}`);
  console.log(`[imageGenerator] prompt — ${prompt}`);

  try {
    // One direct call — no prediction to create, poll and download. The brand
    // reference (when present) is uploaded to /images/edits so the palette and
    // mood carry over; medium quality is the cost/quality sweet spot for covers
    // (see docs/low-high-plan.md).
    const imageBuf = await openAiImage({
      prompt,
      aspectRatio,
      quality: 'medium',
      referenceImageUrl: refImageUrl,
      model,
    });
    return imageBuf ? composeCover(imageBuf, { logoUrl, headline, brandColor }) : null;
  } catch (err) {
    console.warn('[imageGenerator] Unexpected error:', (err as Error).message);
    return null;
  }
}

// ─── Sharp cover compositing (headline text + logo) ───────────────────────────

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Picks the first valid brand hex color from visualKit (brandColors → primaryColor). */
function pickBrandColor(vk: Record<string, unknown> | null): string | null {
  if (!vk) return null;
  const colors = vk['brandColors'];
  if (Array.isArray(colors)) {
    for (const c of colors) {
      const hex = (c as { hex?: unknown })?.hex;
      if (typeof hex === 'string' && HEX_RE.test(hex)) return hex;
    }
  }
  const primary = vk['primaryColor'];
  if (typeof primary === 'string' && HEX_RE.test(primary)) return primary;
  return null;
}

/** Escapes the Pango markup special characters in user text. */
function escapePango(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Collapses whitespace and truncates an over-long headline to ~maxChars (+ ellipsis). */
function clampHeadline(text: string, maxChars: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1).replace(/[\s.,;:!?]*$/, '') + '…';
}

/**
 * Renders the headline to a transparent PNG via sharp's native (Pango) text
 * engine, using the bundled fontfile so it never depends on host fonts. Wraps to
 * `wrapWidth` and is clamped to roughly three lines. Returns the buffer + height.
 */
async function renderHeadline(
  text: string,
  W: number,
  H: number,
  padX: number,
): Promise<{ buf: Buffer; h: number; fontSize: number } | null> {
  const fontSize  = Math.max(28, Math.round(H * 0.072));
  const wrapWidth = W - padX * 2;
  // Cap to ~2 lines so the overlaid headline sits at the bottom and never climbs
  // up into the picture/subject. Over-long titles are truncated with an ellipsis.
  const maxChars  = Math.floor((wrapWidth / (fontSize * 0.52)) * 2);
  const safe      = escapePango(clampHeadline(text, maxChars));
  if (!safe) return null;

  const textInput: sharp.CreateText = {
    text:  `<span foreground="#FFFFFF">${safe}</span>`,
    font:  `${FONT_FILE ? 'DejaVu Sans' : 'sans-serif'} Bold ${fontSize}`,
    rgba:  true,
    width: wrapWidth,
    align: 'left',
  };
  if (FONT_FILE) textInput.fontfile = FONT_FILE;

  const buf  = await sharp({ text: textInput }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  return { buf, h: meta.height ?? fontSize, fontSize };
}

/** Fetches an image URL into a Buffer. Throws on failure (callers handle it). */
async function downloadImage(url: string): Promise<Buffer> {
  return publicFetch(url).then(r => r.arrayBuffer()).then(b => Buffer.from(b));
}

/** Uploads a composited cover JPEG to Blob and returns its public URL. */
async function uploadCover(buf: Buffer, kind: 'cover' | 'base'): Promise<string> {
  const obj = await putObject(`covers/${kind}-${Date.now()}.jpg`, buf, {
    contentType: 'image/jpeg',
  });
  return obj.url;
}

/**
 * Builds the sharp overlay layers (bottom scrim + brand accent bar + headline
 * text image, then the top-right logo) for a cover of size W×H. Returns [] when
 * there's nothing to overlay. Shared by generation and headline re-rendering.
 */
async function buildOverlayLayers(
  W: number,
  H: number,
  opts: { headline: string | null; brandColor: string | null; logoUrl: string | null },
): Promise<sharp.OverlayOptions[]> {
  const { headline, brandColor, logoUrl } = opts;
  const layers: sharp.OverlayOptions[] = [];

  // Headline: scrim + brand accent bar (SVG shapes, no fonts) + text image.
  if (headline) {
    const padX      = Math.round(W * 0.06);
    const padBottom = Math.round(H * 0.07);
    const rendered  = await renderHeadline(headline, W, H, padX);
    if (rendered) {
      const { buf: textBuf, h: th, fontSize } = rendered;
      const textTop  = Math.max(0, H - padBottom - th);
      const barH     = Math.max(4, Math.round(fontSize * 0.22));
      const barW     = Math.round(W * 0.11);
      const barGap   = Math.round(fontSize * 0.5);
      const barY     = Math.max(0, textTop - barGap - barH);
      const scrimTop = Math.max(0, barY - Math.round(H * 0.05));
      const accent   = brandColor && HEX_RE.test(brandColor) ? brandColor : '#FF6A00';

      const scrimBar = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="${(scrimTop / H).toFixed(3)}" stop-color="#000000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000000" stop-opacity="0.82"/>
  </linearGradient></defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#scrim)"/>
  <rect x="${padX}" y="${barY}" width="${barW}" height="${barH}" rx="${Math.round(barH / 2)}" fill="${accent}"/>
</svg>`;

      layers.push({ input: Buffer.from(scrimBar), top: 0, left: 0 });
      layers.push({ input: textBuf, top: textTop, left: padX });
    }
  }

  // Brand logo, top-right (non-fatal — skip if it can't be fetched).
  if (logoUrl) {
    try {
      const logoBuf  = await downloadImage(logoUrl);
      const logoSize = Math.round(W * 0.18);
      const logoPng  = await sharp(logoBuf)
        .resize(logoSize, logoSize, { fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer();
      const logoMeta = await sharp(logoPng).metadata();
      const logoW = logoMeta.width ?? logoSize;
      const margin = Math.round(W * 0.04);
      layers.push({ input: logoPng, top: margin, left: W - logoW - margin, blend: 'over' });
    } catch (err) {
      console.warn('[imageGenerator] Logo fetch/resize failed (skipping logo):', (err as Error).message);
    }
  }

  return layers;
}

/**
 * Downloads the model's (text-free) output, re-hosts it as the clean base, then
 * composites the headline + logo and uploads the final cover. Returns both URLs.
 * Falls back to the original URL on any error (or when no blob token) so
 * generation always returns something.
 */
async function composeCover(
  coverBuf: Buffer,
  opts: { logoUrl: string | null; headline: string | null; brandColor: string | null },
): Promise<GeneratedCover | null> {
  try {

    // Re-host the clean (text-free) background so the headline can be re-rendered
    // later without regenerating the picture.
    let coverBaseUrl: string | null = null;
    try {
      coverBaseUrl = await uploadCover(await sharp(coverBuf).jpeg({ quality: 90 }).toBuffer(), 'base');
    } catch (err) {
      console.warn('[imageGenerator] Clean base re-host failed:', (err as Error).message);
    }

    const meta = await sharp(coverBuf).metadata();
    const W = meta.width  ?? 1024;
    const H = meta.height ?? 1024;

    const layers = await buildOverlayLayers(W, H, opts);
    if (layers.length === 0) {
      // No overlay → the banner IS the clean base. There is no remote URL to
      // fall back on any more (the model hands us bytes), so if the base re-host
      // failed above, host the image now.
      const bannerUrl = coverBaseUrl ?? await uploadCover(await sharp(coverBuf).jpeg({ quality: 90 }).toBuffer(), 'cover');
      return { bannerUrl, coverBaseUrl };
    }

    const bannerUrl = await uploadCover(
      await sharp(coverBuf).composite(layers).jpeg({ quality: 90 }).toBuffer(),
      'cover',
    );
    console.log(`[imageGenerator] Cover composed (text=${!!opts.headline} logo=${!!opts.logoUrl}) → ${bannerUrl}`);
    return { bannerUrl, coverBaseUrl };

  } catch (err) {
    console.warn('[imageGenerator] Cover compose failed — publishing the plain image:', (err as Error).message);
    try {
      return { bannerUrl: await uploadCover(await sharp(coverBuf).jpeg({ quality: 90 }).toBuffer(), 'cover'), coverBaseUrl: null };
    } catch (uploadErr) {
      console.warn('[imageGenerator] Plain image upload failed too:', (uploadErr as Error).message);
      return null;
    }
  }
}

/**
 * Re-renders the headline (and logo) over an existing clean base cover and
 * uploads the result. Used by "edit cover text" — the picture stays identical,
 * only the overlaid text changes. `headline` empty/null = remove text. Returns
 * the new banner URL, or null on failure / when no blob token.
 */
export async function renderCoverFromBase(
  baseUrl: string,
  headline: string | null,
  visualKit: unknown,
): Promise<string | null> {
  const vkObj = (visualKit && typeof visualKit === 'object')
    ? visualKit as Record<string, unknown>
    : null;
  const brandColor = pickBrandColor(vkObj);
  const logoUrl = typeof vkObj?.['logoUrl'] === 'string' && (vkObj['logoUrl'] as string).startsWith('http')
    ? vkObj['logoUrl'] as string
    : null;
  const cleanHeadline = headline && headline.trim() ? headline.trim() : null;

  try {
    const baseBuf = await downloadImage(baseUrl);
    const meta = await sharp(baseBuf).metadata();
    const W = meta.width  ?? 1024;
    const H = meta.height ?? 1024;

    const layers = await buildOverlayLayers(W, H, { headline: cleanHeadline, brandColor, logoUrl });
    const out = layers.length === 0
      ? await sharp(baseBuf).jpeg({ quality: 90 }).toBuffer()
      : await sharp(baseBuf).composite(layers).jpeg({ quality: 90 }).toBuffer();

    return await uploadCover(out, 'cover');
  } catch (err) {
    console.warn('[imageGenerator] renderCoverFromBase failed:', (err as Error).message);
    return null;
  }
}
