import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db';
import { env } from '../env';
import fs from 'fs';
import path from 'path';
import { sendBotMessage, sendBotPhoto, sendBotPhotoFile, answerInlinePostQuery, answerPreCheckoutQuery, getBotIdFromToken, answerBotCallback, telegramAction, TelegramWebAppKeyboard } from '../lib/telegramBot';
import { resolveInlineShare } from '../lib/inlineShare';
import { createDraftPostForChannel, type DraftPost } from '../lib/draftGenerator';
import { getEffectiveSubscription, reserveSubscriptionQuota, refundSubscriptionQuota, TIER_LIMITS } from '../lib/subscriptionLimits';
import { fetchArticle } from '../lib/urlContentExtractor';
import { extractImageContent } from '../lib/visionExtractor';
import { runWebhookBackgroundTask } from '../lib/webhookBackground';
import { completeManagedBot, type ManagedBotUpdate } from '../moderator/managedBotService';
import { completeManagedCommunityBot } from '../communityManager/managedBot';
import { botChannelLabel, buildChannelPickerKeyboard, buildQuickActionsKeyboard, isChannelButtonText, isOpenAppButtonText, parseChannelCallback, versionedMiniAppUrl, type BotChannelSummary } from '../lib/botQuickActions';

const MINI_APP_RELEASE_URL=versionedMiniAppUrl(env.MINI_APP_URL,Date.now().toString(36));

// ─── /start welcome ─────────────────────────────────────────────────────────
const WELCOME_TEXT =
  '👋 Publium — AI-команда для контента, публикаций и комьюнити.\n\n' +
  'Кидаешь идею или пересылаешь пост с другого канала → получаешь 3 варианта ' +
  'оригинального поста с обложкой → публикуешь в канал в пару тапов.\n\nНачнём?';

// Welcome image bundled in the repo. Drop welcome.png (or .jpg) into assets/
// and it just works — no hosting/URL needed (sent as a direct file upload).
const WELCOME_IMAGE_CANDIDATES = ['welcome.png', 'welcome.jpg', 'welcome.jpeg'];

// Search several base dirs so it resolves regardless of the runtime cwd:
//  - __dirname is dist/routes (prod) or src/routes (tsx dev) → ../../assets = server/assets
//  - process.cwd() may be server/ or the repo root depending on the host
const WELCOME_IMAGE_BASES = [
  path.resolve(__dirname, '../../assets'),       // server/assets from dist|src/routes
  path.resolve(process.cwd(), 'assets'),         // cwd = server/
  path.resolve(process.cwd(), 'server/assets'),  // cwd = repo root
];

function findWelcomeImage(): string | null {
  for (const base of WELCOME_IMAGE_BASES) {
    for (const name of WELCOME_IMAGE_CANDIDATES) {
      const p = path.join(base, name);
      if (fs.existsSync(p)) return p;
    }
  }
  console.warn('[bot/webhook] welcome image not found. Checked bases:', WELCOME_IMAGE_BASES.join(' | '));
  return null;
}

/**
 * Sends the /start welcome: the bundled image (if present) + caption + an
 * persistent channel/app keyboard. Falls back to a plain text message if no image file.
 */
async function sendWelcome(chatId: number, activeChannel: BotChannelSummary | null): Promise<void> {
  const keyboard = buildQuickActionsKeyboard(activeChannel, MINI_APP_RELEASE_URL);
  try {
    const imagePath = findWelcomeImage();
    if (imagePath) {
      const bytes = await fs.promises.readFile(imagePath);
      await sendBotPhotoFile(chatId, bytes, path.basename(imagePath), WELCOME_TEXT, env.TELEGRAM_BOT_TOKEN, keyboard);
    } else {
      await sendBotMessage(chatId, WELCOME_TEXT, env.TELEGRAM_BOT_TOKEN, keyboard);
    }
  } catch (err) {
    console.error('[bot/webhook] sendWelcome failed:', (err as Error).message);
  }
}

const router = Router();

// ─── Telegram Update types (only the fields we use) ──────────────────────────

interface TgMessageEntity {
  type: string;   // 'url', 'text_link', 'mention', etc.
  offset: number;
  length: number;
  url?: string;   // present when type === 'text_link'
}

interface TgMessage {
  message_id: number;
  from?: {
    id: number;
    first_name: string;
    username?: string;
    is_bot?: boolean;
  };
  // 'private' is a one-to-one DM with the bot; groups are 'group'/'supergroup'
  // regardless of whether they are public or invite-only.
  chat: { id: number; type?: string };
  // text-only messages
  text?: string;
  entities?: TgMessageEntity[];
  // photo / video / document captions
  caption?: string;
  caption_entities?: TgMessageEntity[];
  // attached photo sizes (ascending order; last element is the largest)
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
  // forwarded messages carry a forward_date field
  forward_date?: number;
  // Telegram Stars payment confirmation
  successful_payment?: {
    currency: string;
    total_amount: number;
    invoice_payload: string;
    telegram_payment_charge_id?: string;
  };
}

interface TgPreCheckoutQuery {
  id: string;
  from?: { id: number };
  currency: string;
  total_amount: number;
  invoice_payload: string;
}

interface TgInlineQuery {
  id: string;
  from: { id: number };
  query: string;
}

interface TgCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

/**
 * ChatMemberUpdated (my_chat_member): fired when THIS bot's membership/rights in a
 * chat change — e.g. a channel admin promotes the bot. `from` is the user who made
 * the change (the channel owner), `new_chat_member` carries the bot's new role.
 */
interface TgChatMemberUpdated {
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number };
  new_chat_member: {
    status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
    user?: { id: number; is_bot?: boolean };
    can_post_messages?: boolean;
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TgMessage;
  pre_checkout_query?: TgPreCheckoutQuery;
  inline_query?: TgInlineQuery;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
  managed_bot?: ManagedBotUpdate;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the first URL from a message.
 * Checks entities (type 'url' → slice from text; type 'text_link' → entity.url)
 * then falls back to a simple regex on the text itself.
 */
function extractFirstUrl(text: string, entities?: TgMessageEntity[]): string | null {
  if (entities) {
    for (const entity of entities) {
      if (entity.type === 'text_link' && entity.url) {
        return entity.url;
      }
      if (entity.type === 'url') {
        return text.slice(entity.offset, entity.offset + entity.length);
      }
    }
  }
  // Fallback: plain text starts with http(s)
  const match = /https?:\/\/\S+/i.exec(text);
  return match ? match[0] : null;
}

/**
 * Returns true if the message should be classified as SourceType URL.
 */
function isUrlSource(text: string, entities?: TgMessageEntity[]): boolean {
  if (entities?.some(e => e.type === 'url' || e.type === 'text_link')) return true;
  return /^https?:\/\//i.test(text.trim());
}

/**
 * Silently attempts to send a bot reply.
 * Logs a safe error string on failure — never logs the token or initData.
 */
async function trySendReply(chatId: number, text: string): Promise<void> {
  try {
    await sendBotMessage(chatId, text, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    console.error('[bot/webhook] sendMessage failed:', (err as Error).message);
  }
}

interface BotChannelContext {
  userId: string;
  activeChannelId: string | null;
  channels: BotChannelSummary[];
  activeChannel: BotChannelSummary | null;
}

async function loadBotChannelContext(telegramId: string): Promise<BotChannelContext | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, activeChannelId: true },
  });
  if (!user) return null;
  const channels = await prisma.channel.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, handle: true },
  });
  const activeChannel = channels.find(channel => channel.id === user.activeChannelId) ?? channels.at(-1) ?? null;
  return { userId: user.id, activeChannelId: user.activeChannelId, channels, activeChannel };
}

async function sendChannelPicker(chatId: number, telegramId: string): Promise<void> {
  try {
    const context = await loadBotChannelContext(telegramId);
    if (!context) {
      await sendBotMessage(chatId, 'Сначала открой Publium, чтобы подключить аккаунт.', env.TELEGRAM_BOT_TOKEN, buildQuickActionsKeyboard(null, MINI_APP_RELEASE_URL));
      return;
    }
    if (!context.activeChannel) {
      await sendBotMessage(chatId, 'Сначала подключи Telegram-канал в Publium.', env.TELEGRAM_BOT_TOKEN, buildQuickActionsKeyboard(null, MINI_APP_RELEASE_URL));
      return;
    }
    const activeLabel = botChannelLabel(context.activeChannel);
    if (context.channels.length === 1) {
      await sendBotMessage(chatId, `Активный канал: ${activeLabel}. Других подключённых каналов пока нет.`, env.TELEGRAM_BOT_TOKEN, buildQuickActionsKeyboard(context.activeChannel, MINI_APP_RELEASE_URL));
      return;
    }
    await sendBotMessage(
      chatId,
      `Выбери канал для следующих материалов.\n\nСейчас выбран: ${activeLabel}`,
      env.TELEGRAM_BOT_TOKEN,
      buildChannelPickerKeyboard(context.channels, context.activeChannel.id),
    );
  } catch (error) {
    console.error('[bot/webhook] channel picker failed:', (error as Error).message);
    await trySendReply(chatId, 'Не удалось загрузить каналы. Попробуй ещё раз.');
  }
}

async function handleChannelCallback(query: TgCallbackQuery): Promise<void> {
  const channelId = parseChannelCallback(query.data);
  if (!channelId) {
    await answerBotCallback(query.id, '', env.TELEGRAM_BOT_TOKEN).catch(() => undefined);
    return;
  }
  const telegramId = String(query.from.id);
  const chatId = query.message?.chat.id ?? query.from.id;
  try {
    const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    const channel = user
      ? await prisma.channel.findFirst({ where: { id: channelId, userId: user.id }, select: { id: true, name: true, handle: true } })
      : null;
    if (!user || !channel) {
      await telegramAction('answerCallbackQuery', { callback_query_id: query.id, text: 'Канал недоступен.', show_alert: true }, env.TELEGRAM_BOT_TOKEN);
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { activeChannelId: channel.id } });
    const label = botChannelLabel(channel);
    await answerBotCallback(query.id, `Канал: ${label}`, env.TELEGRAM_BOT_TOKEN);
    if (query.message) {
      await telegramAction('deleteMessage', { chat_id: query.message.chat.id, message_id: query.message.message_id }, env.TELEGRAM_BOT_TOKEN).catch(() => undefined);
    }
    await sendBotMessage(
      chatId,
      `Активный канал: ${label}. Следующий материал будет обработан для него.`,
      env.TELEGRAM_BOT_TOKEN,
      buildQuickActionsKeyboard(channel, MINI_APP_RELEASE_URL),
    );
  } catch (error) {
    console.error('[bot/webhook] channel switch failed:', (error as Error).message);
    await telegramAction('answerCallbackQuery', { callback_query_id: query.id, text: 'Не удалось сменить канал. Попробуй ещё раз.', show_alert: true }, env.TELEGRAM_BOT_TOKEN).catch(() => undefined);
  }
}

/** An "Open the app" Web App button, or undefined when MINI_APP_URL is unset. */
function openAppKeyboard(label = '🚀 Открыть приложение'): TelegramWebAppKeyboard | undefined {
  return MINI_APP_RELEASE_URL
    ? { inline_keyboard: [[{ text: label, web_app: { url: MINI_APP_RELEASE_URL } }]] }
    : undefined;
}

/**
 * Rich "draft ready" notification: sends the generated cover as a preview image
 * (when available) with a localized caption and an "Open & review" button, so
 * the user jumps straight into the Mini App. Falls back to a text message when
 * there's no cover, and to a "generate manually" note when generation failed.
 */
async function sendDraftNotification(chatId: number, draft: DraftPost | null): Promise<void> {
  const keyboard = openAppKeyboard('🚀 Открыть и проверить');
  try {
    if (!draft) {
      await sendBotMessage(
        chatId,
        '✅ Источник сохранён, но черновик не сгенерировался. Открой приложение и сгенерируй вручную.',
        env.TELEGRAM_BOT_TOKEN,
        keyboard,
      );
      return;
    }

    const rawTitle = draft.title?.trim();
    const title    = rawTitle ? `«${rawTitle.length > 80 ? rawTitle.slice(0, 79) + '…' : rawTitle}»` : 'новый пост';
    const caption  = `✅ Черновик готов: ${title}\n\nОткрой приложение, чтобы проверить и опубликовать.`;
    const cover    = draft.variants?.find(v => v.bannerUrl)?.bannerUrl ?? null;

    if (cover) {
      await sendBotPhoto(chatId, cover, caption, env.TELEGRAM_BOT_TOKEN, keyboard);
    } else {
      await sendBotMessage(chatId, caption, env.TELEGRAM_BOT_TOKEN, keyboard);
    }
  } catch (err) {
    console.error('[bot/webhook] sendDraftNotification failed:', (err as Error).message);
  }
}

/**
 * Auto-connects a channel when this bot is promoted to admin in it.
 *
 * This is the ONLY way to attach a *private* channel: private channels have no
 * @username, so the username-based /api/channels/connect flow can't reach them.
 * When a channel admin adds @Publiumbot as admin, Telegram delivers a
 * `my_chat_member` update carrying the channel's numeric chat id and the user who
 * made the change — enough to bind the channel to that user's account with no
 * typing. Works for public channels too (they just also have a @handle).
 *
 * Guards:
 *   • Only `channel` chats — groups/supergroups belong to the moderator bot.
 *   • Only the change concerning OUR bot, promoted to admin with post rights.
 *   • The promoting user (`from`) must be a registered Publium user; only they —
 *     an admin who could add the bot — can bind the channel.
 *   • Never hijacks a channel already owned by another account.
 *   • Never auto-deletes on demotion/removal (that would cascade-delete the
 *     channel's posts, brand kit and plans). Removal is simply ignored.
 */
async function autoConnectChannelFromMembership(evt: TgChatMemberUpdated): Promise<void> {
  const { chat } = evt;
  if (chat.type !== 'channel') return;

  const member = evt.new_chat_member;
  const botId = getBotIdFromToken(env.TELEGRAM_BOT_TOKEN);
  if (member.user?.id !== botId) return;

  const isAdmin = member.status === 'administrator' || member.status === 'creator';
  if (!isAdmin || member.can_post_messages === false) return;

  const adderTgId = evt.from?.id;
  if (!adderTgId) return;

  const dbUser = await prisma.user
    .findUnique({ where: { telegramId: String(adderTgId) }, select: { id: true } })
    .catch(() => null);
  if (!dbUser) return; // whoever added the bot hasn't onboarded into Publium yet

  const tgChatId = String(chat.id);
  const title    = chat.title ?? chat.username ?? 'Channel';
  const handle   = chat.username ? chat.username.toLowerCase() : null;

  // Already known? Refresh it (idempotent for Telegram's retries), but never
  // steal a channel bound to a different account.
  const existing = await prisma.channel
    .findFirst({
      where: { OR: [{ tgChatId }, ...(handle ? [{ handle }] : [])] },
      select: { id: true, userId: true },
    })
    .catch(() => null);

  if (existing) {
    if (existing.userId !== dbUser.id) return;
    await prisma.channel
      .update({ where: { id: existing.id }, data: { name: title, tgChatId, ...(handle ? { handle } : {}) } })
      .catch(err => console.error('[bot/webhook] channel refresh failed:', (err as Error).message));
    return;
  }

  // Enforce the subscription tier's channel limit.
  const sub = await getEffectiveSubscription(dbUser.id);
  const tier = sub.tier;
  const channelLimit = TIER_LIMITS[tier].channelLimit;
  const channelCount = await prisma.channel.count({ where: { userId: dbUser.id, kind: 'CHANNEL' } }).catch(() => 0);
  if (channelCount >= channelLimit) {
    await trySendReply(
      adderTgId,
      `⚠️ Бот добавлен в «${title}», но ваш тариф ${tier} позволяет подключить до ${channelLimit} канал(ов). Повысьте тариф в приложении, чтобы подключить этот канал.`,
    );
    return;
  }

  const channel = await prisma.channel
    .create({ data: { name: title, handle, tgChatId, kind: 'CHANNEL', userId: dbUser.id }, select: { id: true } })
    .catch(err => { console.error('[bot/webhook] channel auto-connect failed:', (err as Error).message); return null; });
  if (!channel) return;

  await prisma.brandKit
    .upsert({ where: { channelId: channel.id }, update: {}, create: { channelId: channel.id } })
    .catch(err => console.error('[bot/webhook] brandKit create failed:', (err as Error).message));

  // Best-effort confirmation DM (fails silently if the user never messaged the bot).
  try {
    await sendBotMessage(
      adderTgId,
      `✅ Канал «${title}» подключён к Publium. Откройте приложение, чтобы публиковать в него.`,
      env.TELEGRAM_BOT_TOKEN,
      openAppKeyboard(),
    );
  } catch (err) {
    console.error('[bot/webhook] connect confirmation failed:', (err as Error).message);
  }
}

// ─── POST /api/bot/webhook ────────────────────────────────────────────────────
//
// Receives Telegram Update objects sent by Telegram's servers.
//
// Auth:    X-Telegram-Bot-Api-Secret-Token header (set via setWebhook secret_token).
//          Returns 401 if missing or wrong — the only non-200 response allowed
//          (Telegram stops retrying a 401).
//
// All valid bot-update paths return 200 so Telegram does not retry.
// User-facing errors are communicated via bot replies, not HTTP status codes.
//
// Happy path:
//   1. Validate secret token header.
//   2. Parse Update — ignore non-message, missing from, empty source text.
//   3. Resolve User by message.from.id (telegramId).
//   4. Resolve user's first Channel (ordered by createdAt asc).
//   5. Classify SourceType (URL or TEXT), extract URL if present.
//   6. Persist SourceInput.
//   7. Auto-generate draft via the primary AI model + Channel Style (non-fatal).
//   8. Reply to user and return 200.

router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  // ── 1. Authenticate the request ──────────────────────────────────────────
  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
  const secretOk =
    typeof incomingSecret === 'string' &&
    incomingSecret.length === expectedSecret.length &&
    crypto.timingSafeEqual(Buffer.from(incomingSecret), Buffer.from(expectedSecret));
  if (!secretOk) {
    // 401 tells Telegram this endpoint rejected the delivery → no endless retry.
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // ── 2. Parse the Update ──────────────────────────────────────────────────
  const update = req.body as TelegramUpdate;

  // ── Stars payments: pre-checkout must be answered within 10s ─────────────
  if (update.inline_query) {
    const inline = update.inline_query;
    const result = resolveInlineShare(inline.query, inline.from.id);
    try {
      await answerInlinePostQuery(inline.id, result, env.TELEGRAM_BOT_TOKEN);
    } catch (err) {
      console.error('[bot/webhook] answerInlineQuery failed:', (err as Error).message);
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (update.managed_bot) {
    try {
      const moderatorBot = await completeManagedBot(update.managed_bot);
      const communityBot = moderatorBot ? null : await completeManagedCommunityBot(update.managed_bot);
      const completed = moderatorBot ?? communityBot;
      if (completed) {
        const product = communityBot ? 'Community Manager' : 'AI Moderator';
        await sendBotMessage(
          completed.ownerTgId,
          `Персональный ${product} @${completed.username ?? 'bot'} создан. Вернитесь в Publium, добавьте его в группу и завершите подключение.`,
          env.TELEGRAM_BOT_TOKEN,
        ).catch(() => undefined);
      }
    } catch (error) {
      console.error('[bot/webhook] managed bot setup failed:', (error as Error).message);
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (update.pre_checkout_query) {
    await answerPreCheckoutQuery(update.pre_checkout_query.id, false, env.TELEGRAM_BOT_TOKEN, 'Оплата Stars отключена. Откройте приложение и выберите TON.');
    res.status(200).json({ ok: true });
    return;
  }

  // Preserve late historical payment notices for reconciliation; no Stars grants or new sales.
  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    if (!payment.telegram_payment_charge_id) { res.status(400).json({ error: 'Missing charge id' }); return; }
    await prisma.legacyPaymentNotice.upsert({ where: { chargeId: payment.telegram_payment_charge_id }, create: { chargeId: payment.telegram_payment_charge_id, payload: JSON.parse(JSON.stringify(payment)) }, update: {} });
    res.status(200).json({ ok: true });
    return;
  }

  // ── Bot promoted to admin in a channel → auto-connect it (incl. private) ──
  if (update.my_chat_member) {
    try {
      await autoConnectChannelFromMembership(update.my_chat_member);
    } catch (err) {
      console.error('[bot/webhook] auto-connect handler failed:', (err as Error).message);
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (update.callback_query) {
    await handleChannelCallback(update.callback_query);
    res.status(200).json({ ok: true });
    return;
  }

  // Ignore non-message updates (channel_post, etc.)
  if (!update.message) {
    res.status(200).json({ ok: true });
    return;
  }

  const message = update.message;
  const chatId  = message.chat.id;

  // The main bot is a DM tool: you send it text/links/photos and it drafts a post.
  // In groups it must stay completely silent — otherwise it replies to random
  // chatter ("Пришли текст, ссылку или фото…") and, worse, turns a member's group
  // message into a post that burns the owner's AI quota. 'private' is the
  // one-to-one chat with the bot; every group (public or invite-only) is
  // 'group'/'supergroup', so this single check covers them all. Moderator, CM and
  // Community Core run on their own bots/routers and are unaffected.
  if (message.chat.type && message.chat.type !== 'private') {
    res.status(200).json({ ok: true });
    return;
  }

  // Ignore messages with no sender (e.g. anonymous channel posts forwarded to a group)
  if (!message.from) {
    res.status(200).json({ ok: true });
    return;
  }

  // Accept both plain text messages and photo/video/document captions.
  const sourceText     = message.text ?? message.caption ?? '';
  const sourceEntities = message.entities ?? message.caption_entities ?? [];
  // Largest available size of an attached photo (if any).
  const photoFileId    = message.photo && message.photo.length > 0
    ? message.photo[message.photo.length - 1]!.file_id
    : null;

  if (!sourceText.trim() && !photoFileId) {
    await trySendReply(chatId, 'Пришли текст, ссылку или фото — сделаю пост.');
    res.status(200).json({ ok: true });
    return;
  }

  const telegramId = String(message.from.id);

  // ── /start → welcome message with persistent quick actions ──────────────
  if (sourceText.trim().toLowerCase().startsWith('/start')) {
    const context = await loadBotChannelContext(telegramId).catch(() => null);
    await sendWelcome(chatId, context?.activeChannel ?? null);
    res.status(200).json({ ok: true });
    return;
  }

  if (isChannelButtonText(sourceText)) {
    await sendChannelPicker(chatId, telegramId);
    res.status(200).json({ ok: true });
    return;
  }

  if (isOpenAppButtonText(sourceText)) {
    await sendBotMessage(
      chatId,
      'Открой Publium кнопкой ниже.',
      env.TELEGRAM_BOT_TOKEN,
      openAppKeyboard('Открыть Publium'),
    );
    res.status(200).json({ ok: true });
    return;
  }

  // ── 3. Resolve authenticated user ────────────────────────────────────────
  let dbUser: { id: string; activeChannelId: string | null } | null = null;
  try {
    dbUser = await prisma.user.findUnique({
      where:  { telegramId },
      select: { id: true, activeChannelId: true },
    });
  } catch (err) {
    console.error('[bot/webhook] User lookup failed:', (err as Error).message);
    // DB error — return 200 so Telegram doesn't retry; no reply to user
    res.status(200).json({ ok: true });
    return;
  }

  if (!dbUser) {
    await trySendReply(chatId, 'Open the Mini App first to connect your account.');
    res.status(200).json({ ok: true });
    return;
  }

  // ── 4. Resolve user's channels ───────────────────────────────────────────
  let channels: { id: string; name: string; handle: string | null }[] = [];
  try {
    channels = await prisma.channel.findMany({
      where:   { userId: dbUser.id },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, name: true, handle: true },
    });
  } catch (err) {
    console.error('[bot/webhook] Channel lookup failed:', (err as Error).message);
    res.status(200).json({ ok: true });
    return;
  }

  if (channels.length === 0) {
    await trySendReply(chatId, 'Connect a Telegram channel in the Mini App first.');
    res.status(200).json({ ok: true });
    return;
  }

  // Priority: activeChannelId from DB → channel with most recent post → most recently created channel
  let targetChannel = dbUser.activeChannelId
    ? channels.find(c => c.id === dbUser!.activeChannelId)
    : undefined;

  if (!targetChannel) {
    // Find channel with the most recently created post
    try {
      const recentPost = await prisma.generatedPost.findFirst({
        where:   { channel: { userId: dbUser.id } },
        orderBy: { createdAt: 'desc' },
        select:  { channelId: true },
      });
      if (recentPost) {
        targetChannel = channels.find(c => c.id === recentPost.channelId);
      }
    } catch { /* non-fatal */ }
  }

  // Last resort: most recently created channel
  if (!targetChannel) {
    targetChannel = channels[channels.length - 1]!;
  }

  console.log(`[bot/webhook] activeChannelId=${dbUser.activeChannelId ?? 'null'} allChannels=${channels.map(c => c.handle ?? c.name).join(',')} → using=${targetChannel.handle ?? targetChannel.name}`);

  // ── 5. Classify source and extract URL ───────────────────────────────────
  const sourceIsUrl  = isUrlSource(sourceText, sourceEntities);
  const extractedUrl = sourceIsUrl ? extractFirstUrl(sourceText, sourceEntities) : null;

  // ── 6. Persist SourceInput (idempotent via telegramMessageId) ───────────
  // Check for duplicate before inserting to handle Telegram retries.
  let alreadyProcessed = false;
  try {
    const existing = await prisma.sourceInput.findFirst({
      where: {
        userId: dbUser.id,
        metadata: { path: ['telegramMessageId'], equals: message.message_id },
      },
      select: { id: true },
    });
    if (existing) {
      alreadyProcessed = true;
    } else {
      await prisma.sourceInput.create({
        data: {
          userId:  dbUser.id,
          type:    photoFileId ? 'PROMPT' : (sourceIsUrl ? 'URL' : 'TEXT'),
          content: sourceText || (photoFileId ? '[photo]' : ''),
          url:     extractedUrl ?? null,
          metadata: {
            telegramMessageId: message.message_id,
            telegramChatId:    chatId,
            source:            'telegram_bot',
            channelId:         targetChannel.id,
            hasCaption:        message.caption !== undefined,
            hasPhoto:          !!photoFileId,
            isForwarded:       message.forward_date !== undefined,
          },
        },
      });
    }
  } catch (err) {
    console.error('[bot/webhook] SourceInput create failed:', (err as Error).message);
    res.status(200).json({ ok: true });
    return;
  }

  if (alreadyProcessed) {
    res.status(200).json({ ok: true });
    return;
  }

  // ── 7. Return 200 immediately so Telegram doesn't retry ─────────────────
  // Draft generation runs in the background after the response.
  res.status(200).json({ ok: true });

  // ── 8. Generate draft and notify user asynchronously ─────────────────────
  runWebhookBackgroundTask(async () => {
    const targetLabel = botChannelLabel(targetChannel);
    await sendBotMessage(
      chatId,
      `Принял. Готовлю пост для ${targetLabel}.`,
      env.TELEGRAM_BOT_TOKEN,
      buildQuickActionsKeyboard(targetChannel, MINI_APP_RELEASE_URL),
    ).catch(error => console.error('[bot/webhook] source acknowledgement failed:', (error as Error).message));

    const subscription = await getEffectiveSubscription(dbUser.id);
    const limits = TIER_LIMITS[subscription.tier];
    const textQuota = await reserveSubscriptionQuota(dbUser.id, 'text');
    if (!textQuota.ok) {
      await sendBotMessage(chatId, `⚠️ Месячный лимит AI-текста исчерпан (${textQuota.limit}).`, env.TELEGRAM_BOT_TOKEN, openAppKeyboard('⭐ Тарифы')).catch(() => undefined);
      return;
    }
    let reservedVisual = false;
    if (limits.canUseAiVisuals) {
      const visualQuota = await reserveSubscriptionQuota(dbUser.id, 'visual');
      if (!visualQuota.ok) {
        await refundSubscriptionQuota(dbUser.id, 'text');
        await sendBotMessage(chatId, `⚠️ Визуальные генерации закончились (${visualQuota.limit}). Создай текстовый пост в приложении без обложки.`, env.TELEGRAM_BOT_TOKEN, openAppKeyboard('⭐ Тарифы')).catch(() => undefined);
        return;
      }
      reservedVisual = true;
    }

    let genInput = sourceText;
    if (photoFileId) {
      try {
        const extracted = await extractImageContent(photoFileId);
        if (extracted) genInput = sourceText.trim() ? `${sourceText.trim()}\n\n${extracted}` : extracted;
      } catch (error) { console.error('[bot/webhook] Image extraction failed:', (error as Error).message); }
    } else if (extractedUrl) {
      try {
        const article = await fetchArticle(extractedUrl);
        if (article?.text) {
          const commentary = sourceText.replace(extractedUrl, '').trim();
          genInput = commentary ? `${commentary}\n\n${article.text}` : article.text;
        }
      } catch (error) { console.error('[bot/webhook] Article extraction failed:', (error as Error).message); }
    }

    if (!genInput.trim()) {
      if (reservedVisual) await refundSubscriptionQuota(dbUser.id, 'visual');
      await refundSubscriptionQuota(dbUser.id, 'text');
      await sendDraftNotification(chatId, null);
      return;
    }

    let draft: DraftPost | null = null;
    try {
      draft = await createDraftPostForChannel({
        channelId: targetChannel.id,
        input: genInput,
        sourceType: photoFileId ? 'photo' : extractedUrl ? 'link' : 'prompt',
        sourceUrl: extractedUrl ?? null,
        allowHtmlCovers: limits.canUseHtmlCovers,
        generateVisual: limits.canUseAiVisuals,
      });
    } catch (error) {
      if (reservedVisual) await refundSubscriptionQuota(dbUser.id, 'visual');
      await refundSubscriptionQuota(dbUser.id, 'text');
      console.error('[bot/webhook] Draft generation failed:', (error as Error).message);
    }
    await sendDraftNotification(chatId, draft);
  }, error => {
    console.error('[bot/webhook] background task failed:', (error as Error).message);
  });
});

export default router;
