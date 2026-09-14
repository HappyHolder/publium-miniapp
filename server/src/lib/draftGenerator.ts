import { assertStyleAccess } from './styleAccess';
import { storageOwner } from './storageContext';
/**
 * draftGenerator.ts
 *
 * Shared helper: given a channelId + source text, loads BrandKit, generates
 * 3 post variants via AI (or placeholder fallback), persists GeneratedPost +
 * PostVariant rows in a Prisma transaction, and returns the frontend-compatible
 * post shape identical to what POST /api/posts/generate returns.
 *
 * Used by:
 *   - POST /api/posts/generate (manual Create → Generate flow)
 *   - POST /api/bot/webhook   (automatic draft from bot source)
 */

import { prisma } from '../db';
import { env } from '../env';
import { generatePostVariants, classifyPostRubric, type RubricItem } from './aiGenerator';
import { type GeneratedCover } from './imageGenerator';
import { buildCoverRouted } from './coverEngineRouter';
import { buildCarousel, insertCarouselBlock } from './carouselEngine';
import { generateRichBlocks } from './richPostGenerator';
import type { PostBlock } from './richPost';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parses visualKit.rubrics into a clean, validated RubricItem list (or []). */
function parseRubrics(vkObj: Record<string, unknown>): RubricItem[] {
  const raw = vkObj['rubrics'];
  if (!Array.isArray(raw)) return [];
  const out: RubricItem[] = [];
  for (const r of raw as unknown[]) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
    if (!name) continue;
    const rawMode = o['mode'];
    const mode: 'ai' | 'html' | 'ai_html' = rawMode === 'html' || rawMode === 'ai_html' ? rawMode : 'ai';
    const templateUrl = typeof o['templateUrl'] === 'string' && o['templateUrl'] ? o['templateUrl'] : undefined;
    out.push({
      id:          typeof o['id'] === 'string' && o['id'] ? o['id'] : name,
      name,
      description: typeof o['description'] === 'string' ? o['description'] : undefined,
      mode,
      templateUrl,
      hybridPrompt: typeof o['hybridPrompt'] === 'string' && o['hybridPrompt'].trim() ? o['hybridPrompt'].trim() : undefined,
    });
  }
  return out;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CreateDraftParams {
  channelId:    string;
  input:        string;
  sourceType:   string;
  sourceUrl:    string | null;
  imagePrompt?: string;    // optional; if provided, Replicate image generation is attempted
  useBrandKit?: boolean;   // default true; false = ignore channel style for this generation
  imageOnly?:   boolean;   // skip text AI generation, produce one empty-text variant
  allowHtmlCovers?: boolean; // default true; false (FREE tier) forces coverMode 'ai'
  coverModeOverride?: 'ai' | 'html' | 'ai_html'; // per-generation cover engine; overrides channel setting
  generateVisual?: boolean; // false = text-only post; no image provider call
  // Content-manager path: use this pre-chosen rubric instead of classifying.
  // Resolved against visualKit.rubrics for its mode/template; a plain AI rubric
  // is used if the id isn't found. See docs/content-manager-plan.md.
  forcedRubric?: { id: string; name: string };
}

/** Frontend-compatible post shape — identical to what /api/posts/generate returns. */
export interface DraftPost {
  id:               string;
  title:            string;
  sourceType:       string;
  sourceUrl:        string | null;
  editorMode:       'rich';
  sourceSummary:    string;
  channelId:        string;
  channelUsername:  string;
  variants: {
    id:         string;
    label:      string;
    text:       string;
    isSelected: boolean;
    bannerUrl:  string | null;
    blocks:     PostBlock[] | null;
  }[];
  selectedVariantId: string | null;
  linkButtons:       unknown[];
  status:            'new';
  createdAt:         string;   // ISO string
  scheduledAt:       null;
  publishedAt:       null;
  textRegensUsed:    number;
  imageRegensUsed:   number;
  coverMode:         'ai' | 'html' | 'ai_html';
  coverAspectRatio:  '1:1' | '16:9' | '4:5' | '9:16';
  rubricId:          string | null;
  rubricName:        string | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildTitle(input: string): string {
  const firstLine = input.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'Generated post';
  return firstLine.length <= 60 ? firstLine : firstLine.slice(0, 57) + '…';
}

/**
 * Derives a clean headline from the generated post text: the first non-empty
 * line with markdown markers stripped, capped to ~80 chars. Used for the post
 * title and cover headline so they reflect the actual post, not the raw input's
 * first line (which for links/tweets is often an author handle or URL).
 */
function extractHeadline(text: string): string {
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, '')   // markdown heading marker
    .replace(/^[-*•>]\s*/, '')   // bullet / quote marker
    .replace(/\*\*|__/g, '')     // bold markers
    .trim();
  if (!cleaned) return '';
  return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 79).replace(/[\s.,;:!?—-]*$/, '') + '…';
}

/**
 * Extracts LinkItem entries from the BrandKit linkKit that should appear as
 * Telegram inline keyboard buttons (usage === 'button' | 'always').
 * brandKit is typed as unknown because Prisma Json columns arrive untyped.
 */
function extractButtonLinks(brandKit: unknown): {
  id: string; label: string; url: string;
  anchorText: string; buttonLabel: string; usage: string;
}[] {
  if (!brandKit || typeof brandKit !== 'object') return [];
  const lk = (brandKit as Record<string, unknown>)['linkKit'];
  if (!lk || typeof lk !== 'object' || Array.isArray(lk)) return [];
  const links = (lk as Record<string, unknown>)['links'];
  if (!Array.isArray(links)) return [];
  return links.filter((l): l is {
    id: string; label: string; url: string;
    anchorText: string; buttonLabel: string; usage: string;
  } => {
    if (!l || typeof l !== 'object') return false;
    const usage = (l as Record<string, unknown>)['usage'];
    return usage === 'button' || usage === 'always';
  });
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Creates a GeneratedPost with exactly 3 PostVariant rows for the given channel.
 *
 * - Loads BrandKit for Channel Style context (non-fatal if absent or DB error).
 * - Calls generatePostVariants() through the unified primary AI model.
 * - Runs a Prisma interactive transaction: create post+variants → set selectedVariantId.
 * - Returns the mapped frontend post shape.
 *
 * Throws on channel-not-found or DB transaction failure.
 * Callers decide how to surface those errors to users.
 */
export async function createDraftPostForChannel(params: CreateDraftParams): Promise<DraftPost> {
  const owner = await prisma.channel.findUniqueOrThrow({ where: { id: params.channelId }, select: { userId: true } });
  return storageOwner.run(owner.userId, () => createDraftInternal(params));
}

async function createDraftInternal(
  params: CreateDraftParams,
): Promise<DraftPost> {
  const { channelId, input, sourceType, sourceUrl, imagePrompt, useBrandKit = true, imageOnly = false, allowHtmlCovers = true, coverModeOverride, generateVisual = true, forcedRubric } = params;

  const imageModel = env.HIGH_IMAGE_MODEL;

  // ── Load channel ──────────────────────────────────────────────────────────
  const channel = await prisma.channel.findUniqueOrThrow({
    where:  { id: channelId },
    select: { id: true, handle: true, name: true, userId: true },
  });

  // ── Load BrandKit (skipped when useBrandKit === false) ───────────────────
  // When useBrandKit is false the user has explicitly asked the model to follow
  // their prompt directly, ignoring channel style. BrandKit is not loaded so
  // the AI receives no style context, and no link buttons are injected.
  let brandKit: unknown | null = null;
  if (useBrandKit) {
    try {
      const bk = await prisma.brandKit.findUnique({
        where:  { channelId },
        select: {
          channelAbout: true,
          voiceProfile: true,
          postRules:    true,
          linkKit:      true,
          signature:    true,
          visualKit:    true,
        },
      });
      brandKit = bk ?? null;
    } catch (err) {
      console.error('[draftGenerator] BrandKit lookup failed:', (err as Error).message);
    }
  }

  await assertStyleAccess(channel.userId, (brandKit as any)?.visualKit);

  // ── Extract button links from BrandKit (empty when useBrandKit === false) ─
  const buttonLinks = extractButtonLinks(brandKit);

  // ── Generate variant drafts (AI or placeholder fallback) ──────────────────
  const title         = buildTitle(input || imagePrompt || 'Image post');
  const sourceSummary = (input || imagePrompt || '').slice(0, 120);
  const variantDrafts = imageOnly
    ? [{ label: 'Visual', text: '' }]
    : await generatePostVariants({
        input,
        sourceType,
        channel: { handle: channel.handle, name: channel.name },
        brandKit,
      });

  // Prefer the AI-written headline (first line of the generated post) over the
  // raw input's first line — for links/tweets the latter is often junk (author
  // handle, URL). Falls back to the input-based title (and for image-only mode).
  const contentHeadline = imageOnly ? '' : extractHeadline(variantDrafts[0]?.text ?? '');
  const finalTitle = contentHeadline || title;

  // ── Persist: GeneratedPost + 3 PostVariant rows (interactive transaction) ─
  // Step A — create post with nested variants in one round-trip.
  // Step B — write selectedVariantId (needs variant IDs from step A).
  const dbPost = await prisma.$transaction(async (tx) => {
    const created = await tx.generatedPost.create({
      data: {
        title: finalTitle,
        channelId,
        sourceType,
        editorMode: 'RICH',
        sourceSummary,
        sourceUrl:    sourceUrl ?? null,
        imagePrompt:  imagePrompt?.trim() || null,
        status:       'NEW',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        linkButtons: buttonLinks as any,
        variants: {
          create: variantDrafts.map((v, i) => ({
            label:        v.label,
            variantIndex: i,
            text:         v.text,
            isSelected:   i === 0,
          })),
        },
      },
      include: {
        variants: { orderBy: { variantIndex: 'asc' } },
      },
    });

    const firstVariantId = created.variants[0]!.id;

    await tx.generatedPost.update({
      where: { id: created.id },
      data:  { selectedVariantId: firstVariantId },
    });

    // Return fully assembled object — selectedVariantId is now set
    return { ...created, selectedVariantId: firstVariantId };
  });

  // ── Image generation (non-fatal) ─────────────────────────────────────────
  // Image prompt priority:
  //   1. User-provided imagePrompt (explicit override — use as-is)
  //   2. AI-generated prompt from post title + BrandKit visual style (auto)
  //   3. Skip image generation when the primary AI provider is unavailable
  //
  // The AI translates post topic + brand colors/mood into natural visual English
  // so the image model receives "electric blue neon road, dark space atmosphere"
  // instead of raw hex tokens that get rendered as visible text on the image.
  //
  // DB persistence is in a separate try/catch so a write failure doesn't leave
  // the response inconsistent with what /list will return from DB.
  let firstVariantBannerUrl: string | null = null;
  const variantBlocksById = new Map<string, PostBlock[]>();

  const visualKit = (useBrandKit && brandKit && typeof brandKit === 'object')
    ? (brandKit as Record<string, unknown>)['visualKit'] ?? undefined
    : undefined;

  // ── Cover generation ─────────────────────────────────────────────────────
  // Two modes, driven by visualKit.coverMode (chosen in the UI):
  //   'ai'   — Flux neural image via Replicate (same engine as "Regenerate visual")
  //   'html' — user's HTML style templates → Sonnet composes a unique cover,
  //            Playwright renders it (Satori only as an internal fallback)
  let cover: GeneratedCover | null = null;

  const vkObj = (visualKit && typeof visualKit === 'object')
    ? visualKit as Record<string, unknown>
    : null;
  // ── Rubric resolution (new path) ──────────────────────────────────────────
  // When the channel defines rubrics, classify the post into one; its mode +
  // template drive the cover, replacing the channel coverMode toggle and the
  // keyword template guess. No rubrics → legacy path (unchanged). A per-generation
  // coverModeOverride (Create switch) still wins over the rubric's mode.
  const rubrics = (useBrandKit && vkObj) ? parseRubrics(vkObj) : [];
  let rubricTemplate: { name: string; url: string } | null = null;
  let rubricMode: 'ai' | 'html' | 'ai_html' | null = null;
  let rubricId: string | null = null;
  let rubricName: string | null = null;
  let rubricHybridPrompt: string | undefined;
  if (forcedRubric && !coverModeOverride) {
    // Content-manager path: use the plan's pre-chosen rubric. Resolve its mode +
    // template from visualKit.rubrics; fall back to a plain AI rubric if the id
    // isn't present. No classifier call.
    const chosen = rubrics.find(r => r.id === forcedRubric.id);
    rubricMode = chosen?.mode ?? 'ai';
    rubricId = forcedRubric.id;
    rubricName = chosen?.name ?? forcedRubric.name;
    rubricHybridPrompt = chosen?.hybridPrompt;
    if (chosen?.templateUrl) rubricTemplate = { name: chosen.name, url: chosen.templateUrl };
    console.log(`[draftGenerator] Forced rubric "${rubricName}" → mode=${rubricMode}, template=${rubricTemplate ? 'yes' : 'no'}`);
  } else if (rubrics.length > 0 && !coverModeOverride) {
    try {
      const chosen = await classifyPostRubric(title, sourceSummary, rubrics);
      if (chosen) {
        rubricMode = chosen.mode;
        rubricId = chosen.id; rubricName = chosen.name;
        rubricHybridPrompt = chosen.hybridPrompt;
        if (chosen.templateUrl) rubricTemplate = { name: chosen.name, url: chosen.templateUrl };
        console.log(`[draftGenerator] Rubric "${chosen.name}" → mode=${chosen.mode}, template=${chosen.templateUrl ? 'yes' : 'no'}`);
      }
    } catch (err) {
      console.warn('[draftGenerator] Rubric classify failed (legacy path):', (err as Error).message);
    }
  }

  // Precedence: per-generation override (Create switch) → rubric mode → channel coverMode.
  const rawCoverMode = coverModeOverride
    ?? rubricMode
    ?? (typeof vkObj?.['coverMode'] === 'string' ? vkObj['coverMode'] as string : 'ai');
  const normalizedCoverMode: 'ai' | 'html' | 'ai_html' =
    rawCoverMode === 'html' || rawCoverMode === 'ai_html' ? rawCoverMode : 'ai';
  // HTML and AI+HTML modes use Sonnet (paid); FREE tier is coerced to AI/Flux.
  const isPaidMode = normalizedCoverMode === 'html' || normalizedCoverMode === 'ai_html';
  const coverMode: 'ai' | 'html' | 'ai_html' =
    (isPaidMode && !allowHtmlCovers) ? 'ai' : normalizedCoverMode;
  if (isPaidMode && !allowHtmlCovers) {
    console.warn('[draftGenerator] Paid cover mode not allowed on this plan — using AI/Flux');
  }
  const rawAspectRatio = vkObj?.['aspectRatio'];
  const aspectRatio: '1:1' | '16:9' | '4:5' | '9:16' =
    rawAspectRatio === '16:9' || rawAspectRatio === '4:5' || rawAspectRatio === '9:16'
      ? rawAspectRatio
      : '1:1';
  // Channel identity for slot filling / overlay — so covers read as THIS channel
  // (author/rubric/tags = the channel's own, content in the channel's voice),
  // never mirrored from the source outlet. Shared by all cover paths below.
  const bkRec = (brandKit && typeof brandKit === 'object') ? brandKit as Record<string, unknown> : null;

  // Cover text language. Explicit ru/en wins. 'auto' INHERITS the channel's post
  // language (voiceProfile.language) so an EN channel gets EN covers and a RU
  // channel gets RU covers — instead of letting the model guess (and drift to RU
  // because the brand voice is described in Russian). BI/unset stays auto (the
  // fill prompt then follows the post text language).
  const rawCoverLang = vkObj?.['coverLanguage'];
  let coverLanguage: 'ru' | 'en' | undefined =
    rawCoverLang === 'ru' || rawCoverLang === 'en' ? rawCoverLang as 'ru' | 'en' : undefined;
  if (!coverLanguage) {
    const vp = bkRec?.['voiceProfile'];
    const chLang = (vp && typeof vp === 'object') ? (vp as Record<string, unknown>)['language'] : undefined;
    if (chLang === 'EN') coverLanguage = 'en';
    else if (chLang === 'RU') coverLanguage = 'ru';
  }
  const slotBrandCtx = {
    handle: channel.handle,
    name:   channel.name,
    about:  bkRec && typeof bkRec['channelAbout'] === 'object'
      ? JSON.stringify(bkRec['channelAbout']).slice(0, 400) : undefined,
    voice:  bkRec?.['voiceProfile']
      ? JSON.stringify(bkRec['voiceProfile']).slice(0, 400) : undefined,
  };

  // Persist what this post actually used. The channel setting may change later,
  // and Create can override it for a single generation.
  await prisma.generatedPost.update({
    where: { id: dbPost.id },
    data:  { coverMode, coverAspectRatio: aspectRatio, rubricId, rubricName },
  });

  // ── Cover generation (extracted to coverBuilder; reused by set-rubric) ─────
  cover = generateVisual ? await buildCoverRouted({
    coverMode, useBrandKit, visualKit, vkObj, rubricTemplate, rubricHybridPrompt, rubricSelected: rubricMode !== null,
    title, sourceSummary, finalTitle, input,
    imagePrompt: imagePrompt?.trim() || undefined,
    coverLanguage, aspectRatio, imageModel, slotBrandCtx,
  }) : null;

  // Persist cover URLs to DB (non-fatal)
  if (cover?.bannerUrl) {
    const variantIds = dbPost.variants.map(v => v.id);
    if (variantIds.length > 0) {
      try {
        await prisma.postVariant.updateMany({
          where: { id: { in: variantIds } },
          data:  { bannerUrl: cover.bannerUrl },
        });
        firstVariantBannerUrl = cover.bannerUrl;
        if (cover.coverBaseUrl) {
          await prisma.generatedPost.update({
            where: { id: dbPost.id },
            data:  { coverBaseUrl: cover.coverBaseUrl },
          }).catch(() => { /* non-fatal: text editing just won't be available */ });
        }
      } catch (err) {
        console.error('[draftGenerator] Failed to persist bannerUrl to DB:', (err as Error).message);
      }
    }
  }

  // ── Structured formatting — EVERY post is a rich formatted post ────────────
  // The layout engine reads the post text + the cover image and lays it out
  // automatically (plain-ish or full structure, decided by content). Persisted
  // on the selected variant. Non-fatal: a failure leaves blocks null and publish
  // uses the legacy text+banner path as an emergency fallback only.
  try {
    const images = cover?.bannerUrl ? [cover.bannerUrl] : [];
    if (imageOnly) {
      for (const variant of dbPost.variants) {
        variantBlocksById.set(variant.id, images[0] ? [{ type: 'image', url: images[0] }] : []);
      }
    } else {
      const generated = await Promise.all(dbPost.variants.map(async variant => ({
        id: variant.id,
        blocks: await generateRichBlocks({
          postText: variant.text,
          level:    'auto',
          images,
          handle:   channel.handle ? `@${channel.handle.replace(/^@/, '')}` : null,
          lang:     coverLanguage,
        }),
      })));
      for (const item of generated) variantBlocksById.set(item.id, item.blocks);

      const selected = dbPost.variants.find(v => v.id === dbPost.selectedVariantId) ?? dbPost.variants[0];
      if (selected) {
        const selectedBlocks = variantBlocksById.get(selected.id) ?? [];
        if (selectedBlocks.length > 0) {
          const carousel = await buildCarousel({
            useBrandKit, visualKit, vkObj,
            postText:      selected.text,
            rubricName,
            channelName:   channel.name,
            handle:        channel.handle,
            coverLanguage,
          });
          console.log(`[draftGenerator] carousel: ${carousel.plan.scenario} (${carousel.plan.slideCount} slides); ${carousel.debug.join(' | ')}`);
          if (carousel.block) {
            variantBlocksById.set(selected.id, insertCarouselBlock(selectedBlocks, carousel.block, carousel.plan.position));
          }
        }
      }
    }

    await prisma.$transaction(dbPost.variants.map(variant => prisma.postVariant.update({
      where: { id: variant.id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data:  { blocks: (variantBlocksById.get(variant.id) ?? []) as any },
    })));
  } catch (err) {
    console.warn('[draftGenerator] block generation failed; Rich fallback was not persisted:', (err as Error).message);
  }

  // ── Map to frontend shape ─────────────────────────────────────────────────
  // - status always 'new' (just created)
  // - createdAt as ISO string (frontend does new Date() on receipt)
  // - linkButtons: BrandKit links with usage 'button' | 'always' (may be [])
  // - channelUsername: handle preferred; name as fallback
  // - bannerUrl: only set on variant[0] if image was generated, null otherwise
  return {
    id:               dbPost.id,
    title:            dbPost.title,
    sourceType:       dbPost.sourceType ?? sourceType,
    editorMode:       'rich',
    sourceUrl:        dbPost.sourceUrl ?? null,
    sourceSummary:    dbPost.sourceSummary ?? '',
    channelId:        dbPost.channelId,
    channelUsername:  channel.handle ?? channel.name,
    variants: dbPost.variants.map(v => ({
      id:         v.id,
      label:      v.label ?? 'Variant',
      text:       v.text,
      isSelected: v.id === dbPost.selectedVariantId,
      bannerUrl:  firstVariantBannerUrl,
      blocks:     variantBlocksById.get(v.id) ?? [],
    })),
    selectedVariantId: dbPost.selectedVariantId,
    linkButtons:       buttonLinks,
    status:            'new',
    createdAt:         dbPost.createdAt.toISOString(),
    scheduledAt:       null,
    publishedAt:       null,
    textRegensUsed:    0,
    imageRegensUsed:   0,
    coverMode,
    coverAspectRatio: aspectRatio,
    rubricId,
    rubricName,
  };
}
