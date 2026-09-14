import { publishPost } from './publication';
/**
 * scheduler.ts
 *
 * Background polling loop that auto-publishes SCHEDULED posts whose
 * scheduledAt timestamp has passed.
 *
 * Manual and scheduled publication share an atomic database claim. Ambiguous
 * delivery outcomes are held for reconciliation instead of blindly retried.
 */

import { cleanupInterventionContext } from '../moderator/interventionEngine';
import { prisma } from '../db';
import { env } from '../env';
import { moderatorTokenForCommunity } from '../moderator/managedBotCrypto';
import { sendChannelPost, sendRichChannelPost, buildInlineKeyboard, deleteBotMessage, kickChatUser, restrictChatUser } from './telegramBot';
import { deleteObject, purgeOldFiles } from './storage';
import { rollupAllCommunities, purgePulseClaims } from './communityPulse';
import { POST_EDIT_WINDOW_MS } from './postRetention';
import { normalizePostBlocks, type PostBlock } from './richPost';
import { queuePublishedPostContentSupport } from '../communityManager/contentRelease';

async function publishDuePosts(): Promise<void> {
  const due = await prisma.generatedPost.findMany({ where: { status: 'SCHEDULED', publishState: 'IDLE', scheduledAt: { lte: new Date() } }, select: { id: true }, take: 50, orderBy: { scheduledAt: 'asc' } });
  for (const post of due) await publishPost(post.id, true).catch(error => console.error('[scheduler]', post.id, error.message));
}

// ─── Retention purge ──────────────────────────────────────────────────────────
// A published post "lives fully" only for POST_EDIT_WINDOW_MS (5h) — during it
// the user can pull it back, edit and re-publish (edit in place). After that we
// drop the DB row and its stored media so data doesn't accumulate forever. The
// Telegram message itself stays in the channel; we just stop tracking it.

/** Collects every stored media URL (cover + block media) from a post's variants. */
function mediaUrlsOf(variants: { bannerUrl: string | null; blocks: unknown }[]): string[] {
  const urls = new Set<string>();
  for (const v of variants) {
    if (v.bannerUrl) urls.add(v.bannerUrl);
    const blocks = Array.isArray(v.blocks) ? (v.blocks as PostBlock[]) : [];
    for (const b of blocks) {
      if (b.type === 'image' && b.url) urls.add(b.url);
      else if (b.type === 'video') { if (b.url) urls.add(b.url); if (b.poster) urls.add(b.poster); }
      else if (b.type === 'document' && b.url) urls.add(b.url);
      else if (b.type === 'gallery') for (const u of b.urls) if (u) urls.add(u);
    }
  }
  return [...urls];
}

async function purgeExpiredPublished(): Promise<void> {
  const cutoff = new Date(Date.now() - POST_EDIT_WINDOW_MS);

  let expired: { id: string; channel: { userId: string }; variants: { bannerUrl: string | null; blocks: unknown }[] }[];
  try {
    expired = await prisma.generatedPost.findMany({
      where:  { status: 'PUBLISHED', publishedAt: { lt: cutoff } },
      select: { id: true, channel: { select: { userId: true } }, variants: { select: { bannerUrl: true, blocks: true } } },
      take:   100, // bound each sweep
    });
  } catch (err) {
    console.error('[scheduler] purge query failed:', (err as Error).message);
    return;
  }
  if (expired.length === 0) return;

  for (const post of expired) {
    await prisma.generatedPost.delete({ where: { id: post.id } });
    for (const url of mediaUrlsOf(post.variants)) await deleteObject(url, post.channel.userId).catch(error => console.error('[scheduler] media cleanup', error.message));
  }
  console.log(`[scheduler] purged ${expired.length} expired published post(s)`);
}

async function purgeModerationSamples(): Promise<void> {
  await prisma.moderationMessageSample.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } });
}

async function processScheduledModerationActions(): Promise<void> {
  const actions = await prisma.scheduledModerationAction.findMany({
    where: { status: 'PENDING', executeAt: { lte: new Date() } }, orderBy: { executeAt: 'asc' }, take: 100,
  });
  for (const action of actions) {
    try {
      const moderatorToken = await moderatorTokenForCommunity(action.communityId);
      if (action.actionType === 'UNMUTE_USER' && action.tgUserId) { const member = await prisma.communityMember.findUnique({ where: { communityId_tgUserId: { communityId: action.communityId, tgUserId: action.tgUserId } } }); if (!member || member.status !== 'MUTED' || !member.muteUntil || member.muteUntil > new Date() || member.muteUntil > action.executeAt) { await prisma.scheduledModerationAction.update({ where: { id: action.id }, data: { status: 'CANCELLED', completedAt: new Date() } }); continue; } // Telegram expires until_date itself; never undo a newer restriction.
await prisma.communityMember.updateMany({ where: { communityId: action.communityId, tgUserId: action.tgUserId, status: 'MUTED', muteUntil: { lte: action.executeAt } }, data: { status: 'ACTIVE', muteUntil: null } }); await prisma.moderationEvent.create({ data: { communityId: action.communityId, telegramUpdateId: `scheduled:${action.id}`, telegramMessageId: action.telegramMessageId, tgUserId: action.tgUserId, eventType: 'SANCTION_EXPIRED', action: 'UNMUTE', status: 'PROCESSED' } }); } else if (action.actionType.startsWith('CAPTCHA_TIMEOUT') && action.tgUserId) { const claimed = await prisma.communityMember.updateMany({ where: { communityId: action.communityId, tgUserId: action.tgUserId, captchaStatus: 'PENDING' }, data: { captchaStatus: 'TIMEOUT_PROCESSING' } }); if (claimed.count !== 1) { await prisma.scheduledModerationAction.update({ where: { id: action.id }, data: { status: 'CANCELLED', completedAt: new Date() } }); continue; } if (action.actionType === 'CAPTCHA_TIMEOUT_KICK') await kickChatUser(action.tgChatId, Number(action.tgUserId), moderatorToken); await prisma.communityMember.updateMany({ where: { communityId: action.communityId, tgUserId: action.tgUserId, captchaStatus: 'TIMEOUT_PROCESSING' }, data: { captchaStatus: 'FAILED', status: action.actionType === 'CAPTCHA_TIMEOUT_KICK' ? 'REMOVED' : 'RESTRICTED' } }); await deleteBotMessage(action.tgChatId, action.telegramMessageId, moderatorToken).catch(() => undefined); await prisma.moderationEvent.create({ data: { communityId: action.communityId, telegramUpdateId: `scheduled:${action.id}`, telegramMessageId: action.telegramMessageId, tgUserId: action.tgUserId, eventType: 'CAPTCHA_TIMEOUT', action: action.actionType === 'CAPTCHA_TIMEOUT_KICK' ? 'KICK' : 'KEEP_RESTRICTED', status: 'PROCESSED' } }); } else await deleteBotMessage(action.tgChatId, action.telegramMessageId, moderatorToken);
      await prisma.scheduledModerationAction.update({ where: { id: action.id }, data: { status: 'COMPLETED', completedAt: new Date(), attempts: { increment: 1 } } });
    } catch (err) {
      if (action.actionType.startsWith('CAPTCHA_TIMEOUT') && action.tgUserId) await prisma.communityMember.updateMany({ where: { communityId: action.communityId, tgUserId: action.tgUserId, captchaStatus: 'TIMEOUT_PROCESSING' }, data: { captchaStatus: 'PENDING', status: 'RESTRICTED' } }).catch(() => undefined);
      const attempts = action.attempts + 1;
      await prisma.scheduledModerationAction.update({ where: { id: action.id }, data: { attempts, status: attempts >= 3 ? 'FAILED' : 'PENDING', lastError: (err as Error).message.slice(0, 500), executeAt: new Date(Date.now() + 60_000) } }).catch(() => undefined);
    }
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function startScheduler(): void {
  const INTERVAL_MS = 60_000; // 1 minute

  console.log(`[scheduler] Started — polling every ${INTERVAL_MS / 1000}s`);

  const sweep = async () => {
    await publishDuePosts().catch(err =>
      console.error('[scheduler] Publish sweep failed:', (err as Error).message)
    );
    await purgeExpiredPublished().catch(err =>
      console.error('[scheduler] Purge sweep failed:', (err as Error).message)
    );
    await purgeModerationSamples().catch(err => console.error('[scheduler] Moderation sample purge failed:', (err as Error).message));
    // Assistant chat screenshots are deleted right after vision extraction;
    // this sweeps any orphaned by a failed request (upload with no send, etc.).
    await purgeOldFiles('chat', 6 * 60 * 60 * 1000).then(n => { if (n) console.log(`[scheduler] purged ${n} orphan chat image(s)`); }).catch(() => undefined);
    await processScheduledModerationActions().catch(err =>
      console.error('[scheduler] Moderation action sweep failed:', (err as Error).message)
    );
  };

  // Initial sweep: catch posts that became due (or expired) while we were down.
  sweep().catch(err => console.error('[scheduler] Startup sweep failed:', (err as Error).message));

  // Recurring sweep
  setInterval(() => {
    cleanupInterventionContext().catch(() => undefined);
    sweep().catch(err => console.error('[scheduler] Sweep failed:', (err as Error).message));
  }, INTERVAL_MS);

  // Pulse analytics: recompute today + yesterday every 30 min. Idempotent by
  // (community, day), so re-runs never double-count and a missed run self-heals;
  // covering yesterday too catches messages that landed around midnight.
  const pulseTick = () => {
    void rollupAllCommunities(2).catch(err => console.error('[pulse] rollup failed:', (err as Error).message));
    void purgePulseClaims().catch(() => undefined);
  };
  setTimeout(pulseTick, 60_000).unref?.();
  setInterval(pulseTick, 30 * 60_000).unref?.();
}
