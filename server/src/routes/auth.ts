import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { getEffectiveSubscription, serializeSubscription } from '../lib/subscriptionLimits';
import { issueModeratorSession } from '../lib/moderatorSession';
import { sendBotMessage } from '../lib/telegramBot';
import { botChannelLabel, buildQuickActionsKeyboard, versionedMiniAppUrl } from '../lib/botQuickActions';
import { refreshChannelMemberCounts, refreshChatMemberCounts, type CountableChannel, type CountableChat } from '../lib/channelMemberCount';

const router = Router();
const MINI_APP_RELEASE_URL = versionedMiniAppUrl(env.MINI_APP_URL, Date.now().toString(36));

// ─── POST /api/auth/telegram ──────────────────────────────────────────────────
// Validates Telegram Mini App initData, upserts User by telegramId.
//
// Request body:  { initData: string }
// Response 200:  { user: { id, name, telegramId, username }, channels: Channel[], brandKits: BrandKit[], subscription: null }
// Response 400:  { error: string }  — missing / malformed body
// Response 401:  { error: string }  — invalid or expired initData
// Response 500:  { error: string }  — DB failure

router.post('/telegram', async (req: Request, res: Response): Promise<void> => {
  const { initData } = req.body as { initData?: unknown };

  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required and must be a string' });
    return;
  }

  // ── Validate Telegram signature ───────────────────────────────────────────
  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid initData',
    });
    return;
  }

  const { user: tgUser } = parsed;

  // ── Build fields to persist ───────────────────────────────────────────────
  // telegramId is stored as a string (Telegram IDs can exceed JS safe int)
  const telegramId = String(tgUser.id);

  // Combine first + last name; both fields may be absent in future Telegram versions
  const nameParts = [tgUser.first_name, tgUser.last_name].filter(Boolean);
  const name = nameParts.length > 0 ? nameParts.join(' ') : null;

  // NOTE: username is NOT in the current Prisma User schema.
  // It is returned in the response from parsed initData but not persisted.
  // Add a migration with `username String? @unique` before storing it.

  // ── Upsert User ───────────────────────────────────────────────────────────
  let dbUser;
  try {
    dbUser = await prisma.user.upsert({
      where:  { telegramId },
      update: { name },         // refresh name on every auth (Telegram name may change)
      create: { telegramId, name },
    });
  } catch (err) {
    console.error('[auth/telegram] DB upsert failed:', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  // ── Fetch this user's connected channels ──────────────────────────────────
  let dbChannels: (CountableChannel & {
    name: string;
    chatLinks: { chat: { id: string; title: string } }[];
  })[] = [];
  try {
    dbChannels = await prisma.channel.findMany({
      where:   { userId: dbUser.id, kind: 'CHANNEL' },
      orderBy: { createdAt: 'asc' },
      select:  {
        id: true, name: true, handle: true, kind: true, tgChatId: true,
        telegramMemberCount: true, memberCountUpdatedAt: true,
        community: { select: { id: true } },
        chatLinks: { where: { isPrimary: true }, take: 1, select: { chat: { select: { id: true, title: true } } } },
      },
    });
    dbChannels = await refreshChannelMemberCounts(dbChannels);
  } catch (err) {
    console.error('[auth/telegram] Channel fetch failed (non-fatal):', err);
    // Non-fatal: return empty channels rather than failing the whole auth
  }

  let dbChats: (CountableChat & {
    title: string;
    type: string;
    channelLinks: { channel: { id: string; name: string; handle: string | null } }[];
  })[] = [];
  try {
    dbChats = await prisma.chat.findMany({
      where: { userId: dbUser.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, tgChatId: true, title: true, username: true, type: true,
        telegramMemberCount: true, memberCountUpdatedAt: true,
        community: { select: { id: true } },
        channelLinks: {
          where: { isPrimary: true }, take: 1,
          select: { channel: { select: { id: true, name: true, handle: true } } },
        },
      },
    });
    dbChats = await refreshChatMemberCounts(dbChats);
  } catch (err) {
    console.error('[auth/telegram] Chat fetch failed (non-fatal):', err);
  }

  // ── Fetch saved BrandKit sections for all channels ────────────────────────
  // Returned as-is to the frontend. The frontend merges non-null sections over
  // createDefaultBrandKit() defaults so forms always receive shaped objects.
  let dbBrandKits: {
    channelId:    string;
    channelAbout: unknown;
    voiceProfile: unknown;
    linkKit:      unknown;
    visualKit:    unknown;
    signature:    unknown;
    postRules:    unknown;
  }[] = [];
  if (dbChannels.length > 0) {
    try {
      dbBrandKits = await prisma.brandKit.findMany({
        where:  { channelId: { in: dbChannels.map(ch => ch.id) } },
        select: {
          channelId:    true,
          channelAbout: true,
          voiceProfile: true,
          linkKit:      true,
          visualKit:    true,
          signature:    true,
          postRules:    true,
        },
      });
    } catch (err) {
      console.error('[auth/telegram] BrandKit fetch failed (non-fatal):', err);
      // Non-fatal: frontend falls back to shaped defaults for all sections
    }
  }


  let dbChatStyles: { chatId: string; channelAbout: unknown; voiceProfile: unknown }[] = [];
  if (dbChats.length > 0) {
    dbChatStyles = await prisma.chatStyle.findMany({
      where: { chatId: { in: dbChats.map(chat => chat.id) } },
      select: { chatId: true, channelAbout: true, voiceProfile: true },
    }).catch(err => {
      console.error('[auth/telegram] ChatStyle fetch failed (non-fatal):', err);
      return [];
    });
  }

  // ── Upsert Subscription (create on first login, keep existing if present) ──
  let dbSubscription;
  try {
    dbSubscription = await getEffectiveSubscription(dbUser.id);
  } catch (err) {
    console.error('[auth/telegram] Subscription resolve failed:', err);
    res.status(500).json({ error: 'Could not load subscription' });
    return;
  }
  res.json({
    user: {
      id:              dbUser.id,
      name:            dbUser.name,
      telegramId:      dbUser.telegramId,
      username:        tgUser.username ?? null,
      activeChannelId: dbUser.activeChannelId ?? null,
      isAdmin:         env.ADMIN_TELEGRAM_IDS.includes(telegramId),
    },
    channels: dbChannels.map((ch, i) => ({
      id:               ch.id,
      username:         ch.handle ?? '',
      title:            ch.name,
      subscribersCount: ch.telegramMemberCount,
      isDefault:        i === 0,
      isConnected:      true,
      linkedChat:       ch.chatLinks[0]?.chat ?? null,
    })),
    chats: dbChats.map(chat => ({
      id: chat.id,
      telegramId: chat.tgChatId,
      username: chat.username ?? '',
      title: chat.title,
      type: chat.type,
      membersCount: chat.telegramMemberCount,
      isConnected: true,
      communityId: chat.community?.id ?? null,
      linkedChannel: chat.channelLinks[0]?.channel ?? null,
    })),
    brandKits: dbBrandKits,
    chatStyles: dbChatStyles,
    subscription: serializeSubscription(dbSubscription),
  });
});

// ─── POST /api/auth/active-channel ───────────────────────────────────────────
// Persists the user's active channel selection to the DB so the bot webhook
// can use the same channel when generating drafts.
//
// Request body: { initData, channelId }
// Response 200: { ok: true }

router.post('/active-channel', async (req: Request, res: Response): Promise<void> => {
  const { initData, channelId } = req.body as { initData?: unknown; channelId?: unknown };

  if (typeof initData   !== 'string' || !initData.trim())   { res.status(400).json({ error: 'initData required' });   return; }
  if (typeof channelId  !== 'string' || !channelId.trim())  { res.status(400).json({ error: 'channelId required' });  return; }

  let parsed;
  try { parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN); }
  catch (err) { res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' }); return; }

  const telegramId = String(parsed.user.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } }).catch(() => null);
  if (!dbUser) { res.status(401).json({ error: 'User not found' }); return; }

  // Verify the channel belongs to this user
  const channel = await prisma.channel.findUnique({
    where:  { id: channelId },
    select: { id: true, userId: true, name: true, handle: true, kind: true },
  }).catch(() => null);
  if (!channel || channel.userId !== dbUser.id || channel.kind !== 'CHANNEL') {
    res.status(403).json({ error: 'Channel not found or access denied' }); return;
  }

  await prisma.user.update({ where: { id: dbUser.id }, data: { activeChannelId: channelId } });
  await sendBotMessage(
    telegramId,
    `Активный канал: ${botChannelLabel(channel)}.`,
    env.TELEGRAM_BOT_TOKEN,
    buildQuickActionsKeyboard(channel, MINI_APP_RELEASE_URL),
  ).catch(error => {
    console.error('[auth/active-channel] keyboard refresh failed:', error instanceof Error ? error.message : String(error));
  });
  res.json({ ok: true });
});

// Exchanges fresh Telegram credentials for a short-lived bearer used only by Moderator.
// initData is never accepted in Moderator query strings or mutation bodies.
router.post('/moderator-session', async (req: Request, res: Response): Promise<void> => {
  const { initData } = req.body as { initData?: unknown };
  if (typeof initData !== 'string' || !initData.trim()) { res.status(400).json({ error: 'initData is required' }); return; }
  let parsed;
  try {
    // Keep this exchange aligned with the 24-hour Telegram credential window
    // used by the rest of Publium. A 10-minute window made an otherwise valid
    // Mini App session fail as soon as the user opened Community later on.
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, { maxAgeSeconds: 24 * 60 * 60, maxFutureSkewSeconds: 30 });
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid initData' }); return;
  }
  const telegramId = String(parsed.user.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } }).catch(() => null);
  if (!user) { res.status(401).json({ error: 'User not found. Re-open Publium.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json(issueModeratorSession(telegramId));
});
export default router;
