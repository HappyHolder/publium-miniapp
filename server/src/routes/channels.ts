import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import {
  getChat,
  getChatMember,
  getChatMemberCount,
  getBotIdFromToken,
  TelegramApiError,
} from '../lib/telegramBot';
import { TIER_LIMITS, getEffectiveSubscription } from '../lib/subscriptionLimits';

const router = Router();

// ─── Username normalisation ───────────────────────────────────────────────────
// Accepts: "@mychannel", "mychannel", "t.me/mychannel", "https://t.me/mychannel"
// Rejects: private invite links (t.me/+…), joinchat URLs, empty/numeric handles

function normalizeUsername(raw: string): string | null {
  let s = raw.trim();

  // Strip URL prefixes
  s = s.replace(/^https?:\/\/t\.me\//i, '');
  s = s.replace(/^t\.me\//i, '');

  // Strip leading @
  s = s.replace(/^@+/, '');

  // Reject private invite links and empty results
  if (!s || s.startsWith('+') || s.toLowerCase().startsWith('joinchat')) {
    return null;
  }

  // Telegram usernames: letters, digits, underscores, min 3 chars
  // (Telegram enforces 5–32; we let Telegram reject anything shorter)
  if (!/^[a-zA-Z0-9_]{3,}$/.test(s)) {
    return null;
  }

  // Lowercase for consistent DB storage (Telegram usernames are case-insensitive)
  return s.toLowerCase();
}

// ─── POST /api/channels/connect ───────────────────────────────────────────────
//
// Request body:  { initData: string, username: string }
// Response 200:  { channel: { id, username, title, subscribersCount, isDefault, isConnected } }
// Response 400:  { error }  — missing/invalid input or not a channel
// Response 401:  { error }  — invalid initData or user not found
// Response 403:  { error }  — bot not admin / missing post permission
// Response 404:  { error }  — channel not found on Telegram
// Response 409:  { error }  — channel already owned by another user
// Response 500:  { error }  — DB or Telegram API failure

router.post('/connect', async (req: Request, res: Response): Promise<void> => {
  const { initData, username: rawUsername } = req.body as {
    initData?: unknown;
    username?: unknown;
  };

  // ── 1. Basic input validation ─────────────────────────────────────────────
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' });
    return;
  }
  if (typeof rawUsername !== 'string' || !rawUsername.trim()) {
    res.status(400).json({ error: 'username is required' });
    return;
  }

  // ── 2. Validate Telegram initData ────────────────────────────────────────
  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid initData',
    });
    return;
  }

  // ── 3. Find the authenticated user in DB ─────────────────────────────────
  const telegramId = String(parsed.user.id);
  let dbUser: { id: string } | null = null;
  try {
    dbUser = await prisma.user.findUnique({
      where: { telegramId },
      select: { id: true },
    });
  } catch (err) {
    console.error('[channels/connect] User lookup failed:', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
  if (!dbUser) {
    res.status(401).json({ error: 'User not found. Please re-open the app.' });
    return;
  }

  // ── 4. Normalize username ────────────────────────────────────────────────
  const handle = normalizeUsername(rawUsername);
  if (!handle) {
    res.status(400).json({ error: 'Invalid channel username. Enter @channelname or t.me/channelname.' });
    return;
  }

  // ── 5. Verify channel exists on Telegram (getChat) ───────────────────────
  let tgChat;
  try {
    tgChat = await getChat(`@${handle}`, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    if (err instanceof TelegramApiError) {
      res.status(404).json({ error: `Channel @${handle} not found on Telegram.` });
      return;
    }
    console.error('[channels/connect] getChat failed:', err);
    res.status(500).json({ error: 'Could not reach Telegram. Try again.' });
    return;
  }

  // Channels and chats are independent resources. Groups are connected only
  // through the dedicated chat flow where Moderator can verify group rights.
  if (tgChat.type !== 'channel') {
    res.status(400).json({
      error: 'Это Telegram-группа. Подключите её во вкладке «Чаты».',
    });
    return;
  }

  // ── 7. Verify bot is admin (getChatMember) ────────────────────────────────
  const botId = getBotIdFromToken(env.TELEGRAM_BOT_TOKEN);
  let member;
  try {
    member = await getChatMember(`@${handle}`, botId, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    if (err instanceof TelegramApiError) {
      res.status(403).json({
        error: `Bot is not an admin in @${handle}. Add @Publiumbot as a channel admin first.`,
      });
      return;
    }
    console.error('[channels/connect] getChatMember failed:', err);
    res.status(500).json({ error: 'Could not reach Telegram. Try again.' });
    return;
  }

  if (member.status !== 'administrator' && member.status !== 'creator') {
    res.status(403).json({
      error: `Bot is not an admin in @${handle}. Add @Publiumbot as a channel admin first.`,
    });
    return;
  }

  // For channels (not supergroups), can_post_messages must be explicitly true.
  // For supergroups the field is absent — we skip the check.
  if (tgChat.type === 'channel' && member.can_post_messages === false) {
    res.status(403).json({
      error: 'The bot needs "Post messages" permission. Edit admin rights in your channel settings.',
    });
    return;
  }

  // ── 7b. Verify the REQUESTING USER is an admin/creator of the channel ──────
  // Without this, the bot-admin check alone lets anyone who knows the @handle
  // connect a channel the bot was added to (and then publish/spam to it). Only a
  // real channel administrator may bind a channel to their account.
  let userMember;
  try {
    userMember = await getChatMember(`@${handle}`, parsed.user.id, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    if (err instanceof TelegramApiError) {
      res.status(403).json({ error: 'You must be an administrator of this channel to connect it.' });
      return;
    }
    console.error('[channels/connect] user getChatMember failed:', err);
    res.status(500).json({ error: 'Could not reach Telegram. Try again.' });
    return;
  }
  if (userMember.status !== 'administrator' && userMember.status !== 'creator') {
    res.status(403).json({ error: 'Only an administrator of this channel can connect it.' });
    return;
  }

  // ── 8. Enforce the effective plan limit server-side ───────────────────────
  try {
    const subscription = await getEffectiveSubscription(dbUser.id);
    const channelLimit = TIER_LIMITS[subscription.tier].channelLimit;
    const channelCount = await prisma.channel.count({ where: { userId: dbUser.id, kind: 'CHANNEL' } });
    if (tgChat.type === 'channel' && channelCount >= channelLimit) {
      res.status(403).json({ error: `Тариф ${subscription.tier} позволяет подключить до ${channelLimit} каналов.`, code: 'CHANNEL_LIMIT_REACHED', limit: channelLimit });
      return;
    }
  } catch (err) {
    console.error('[channels/connect] Subscription check failed:', err);
    res.status(503).json({ error: 'Не удалось проверить лимит тарифа. Попробуйте ещё раз.' });
    return;
  }
  // ── 9. Duplicate-ownership check ─────────────────────────────────────────
  let existingChannel: { id: string; userId: string } | null = null;
  try {
    existingChannel = await prisma.channel.findFirst({
      where: { handle },
      select: { id: true, userId: true },
    });
  } catch (err) {
    console.error('[channels/connect] Channel lookup failed:', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (existingChannel && existingChannel.userId !== dbUser.id) {
    res.status(409).json({
      error: 'This channel is already connected by another account.',
    });
    return;
  }

  // ── 10. Upsert Channel in DB ──────────────────────────────────────────────
  const title = tgChat.title ?? handle;
  const tgChatId = tgChat.id != null ? String(tgChat.id) : null;
  const measuredCount = await getChatMemberCount(tgChatId ?? `@${handle}`, env.TELEGRAM_BOT_TOKEN);
  const subscribersCount = measuredCount ?? tgChat.member_count ?? null;
  const memberCountUpdatedAt = subscribersCount == null ? null : new Date();

  let channel: { id: string; name: string; handle: string | null; kind: string; telegramMemberCount: number | null };
  try {
    channel = await prisma.channel.upsert({
      where: { handle },
      update: { name: title, kind: 'CHANNEL', ...(subscribersCount == null ? {} : { telegramMemberCount: subscribersCount, memberCountUpdatedAt }), ...(tgChatId ? { tgChatId } : {}) },
      create: { name: title, handle, kind: 'CHANNEL', userId: dbUser.id, telegramMemberCount: subscribersCount, memberCountUpdatedAt, ...(tgChatId ? { tgChatId } : {}) },
      select: { id: true, name: true, handle: true, kind: true, telegramMemberCount: true },
    });
  } catch (err) {
    console.error('[channels/connect] Channel upsert failed:', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  // ── 10. Create empty BrandKit if not present ──────────────────────────────
  try {
    await prisma.brandKit.upsert({
      where:  { channelId: channel.id },
      update: {},
      create: { channelId: channel.id },
    });
  } catch (err) {
    // Non-fatal: channel was saved; BrandKit creation can be retried on next open
    console.error('[channels/connect] BrandKit upsert failed:', err);
  }

  // ── 11. Determine isDefault (true only if this is the user's sole channel) ─
  let channelCount = 0;
  try {
    channelCount = await prisma.channel.count({ where: { userId: dbUser.id, kind: 'CHANNEL' } });
  } catch {
    // non-fatal — default to false if count fails
  }

  res.json({
    channel: {
      id:               channel.id,
      username:         channel.handle ?? handle,
      title:            channel.name,
      subscribersCount: channel.telegramMemberCount,
      isDefault:        channel.kind === 'CHANNEL' && channelCount === 1,
      isConnected:      true,
    },
  });
});

// ─── POST /api/channels/disconnect ────────────────────────────────────────────
//
// Removes a connected channel from the user's account. Deleting the Channel row
// cascades (schema onDelete: Cascade) to its BrandKit, GeneratedPosts (+ variants),
// ProjectDocs and ContentPlans (+ items), so nothing dangling is left behind.
//
// The bot's admin rights in the Telegram channel are NOT touched — Publium simply
// stops managing the channel. The user can re-connect it later (a fresh row).
//
// If the disconnected channel was the user's activeChannelId, it is repointed to
// any remaining channel (or cleared) so the app never targets a deleted channel.
//
// Request body: { initData, channelId }
// Response 200: { ok: true, activeChannelId: string | null }
// Response 400: missing / invalid fields
// Response 401: invalid initData / user not found
// Response 403: channel belongs to another user
// Response 404: channel not found
// Response 500: DB error

router.post('/disconnect', async (req: Request, res: Response): Promise<void> => {
  const { initData, channelId } = req.body as { initData?: unknown; channelId?: unknown };

  // ── 1. Input validation ───────────────────────────────────────────────────
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' }); return;
  }
  if (typeof channelId !== 'string' || !channelId.trim()) {
    res.status(400).json({ error: 'channelId is required' }); return;
  }

  // ── 2. Validate Telegram initData ────────────────────────────────────────
  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' }); return;
  }

  // ── 3. Resolve authenticated user ────────────────────────────────────────
  const telegramId = String(parsed.user.id);
  let dbUser: { id: string; activeChannelId: string | null } | null = null;
  try {
    dbUser = await prisma.user.findUnique({
      where:  { telegramId },
      select: { id: true, activeChannelId: true },
    });
  } catch (err) {
    console.error('[channels/disconnect] User lookup failed:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' }); return;
  }
  if (!dbUser) {
    res.status(401).json({ error: 'User not found. Please re-open the app.' }); return;
  }

  // ── 4. Load channel + verify ownership ────────────────────────────────────
  let channel: { id: string; userId: string } | null = null;
  try {
    channel = await prisma.channel.findUnique({
      where:  { id: channelId },
      select: { id: true, userId: true },
    });
  } catch (err) {
    console.error('[channels/disconnect] Channel lookup failed:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' }); return;
  }
  if (!channel) {
    res.status(404).json({ error: 'Channel not found.' }); return;
  }
  if (channel.userId !== dbUser.id) {
    res.status(403).json({ error: 'This channel does not belong to your account.' }); return;
  }

  // ── 5. Delete the channel (cascade removes brandKit / posts / docs / plans) ─
  try {
    await prisma.channel.delete({ where: { id: channelId } });
  } catch (err) {
    console.error('[channels/disconnect] Delete failed:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' }); return;
  }

  // ── 6. Repoint activeChannelId if it was the deleted channel ───────────────
  // activeChannelId is a plain String (not an FK), so it would otherwise dangle.
  let nextActiveChannelId: string | null = dbUser.activeChannelId;
  if (dbUser.activeChannelId === channelId) {
    const remaining = await prisma.channel
      .findFirst({ where: { userId: dbUser.id, kind: 'CHANNEL' }, orderBy: { createdAt: 'asc' }, select: { id: true } })
      .catch(() => null);
    nextActiveChannelId = remaining?.id ?? null;
    await prisma.user
      .update({ where: { id: dbUser.id }, data: { activeChannelId: nextActiveChannelId } })
      .catch(err => console.error('[channels/disconnect] activeChannel repoint failed:', (err as Error).message));
  }

  res.json({ ok: true, activeChannelId: nextActiveChannelId });
});

export default router;
