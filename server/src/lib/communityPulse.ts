/**
 * communityPulse.ts — data collection for the community "Пульс" dashboard.
 *
 * Records what actually happened in the group chat, at the ONLY granularity that
 * makes long-period analytics correct: one row per participant per day. Unique
 * actives, DAU/MAU, cohorts, Orbit tiers and concentration cannot be derived by
 * summing daily numbers (a person active 20 days is ONE monthly active, not 20),
 * so month/quarter/year are always computed from these facts.
 *
 * Ingress callers isolate analytics failures from moderator decisions.
 */

import { prisma } from '../db';

const MSK_TZ = 'Europe/Moscow';

/** 'YYYY-MM-DD' in Moscow time — the canonical day key for every Pulse metric. */
export function pulseDayKey(date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: MSK_TZ });
}

/** Hour 0–23 in Moscow time (for the hour × weekday heatmap). */
export function pulseHour(date = new Date()): number {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: MSK_TZ, hour: '2-digit', hourCycle: 'h23' }).format(date));
  return Number.isFinite(h) ? h : 0;
}

type PulseModerationEvent = { eventType: string; action: string | null; decision: string | null; tgUserId: string | null; metadata: unknown };
const pulseMeta = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Weighted harm signal. Spam affects cleanliness; directed harassment affects climate much more. */
export function pulseToxicityWeight(event: PulseModerationEvent): number {
  const meta = pulseMeta(event.metadata), category = String(meta['category'] ?? event.decision ?? 'other'), severity = String(meta['severity'] ?? 'medium');
  if (event.eventType === 'CONVERSATION_EPISODE') {
    if (meta['source'] === 'MESSAGE_MODERATED') return 0;
    const state = String(meta['state'] ?? 'OBSERVING');
    if (state === 'RESOLVED') return 0;
    return category === 'harassment' ? (state === 'ESCALATING' ? 3 : 2) : category === 'conflict' ? (state === 'ESCALATING' ? 2 : 1) : .4;
  }
  if (event.eventType !== 'AI_MODERATION_TRIGGERED' && !['CONTENT_FILTER_TRIGGERED','ANTISPAM_TRIGGERED'].includes(event.eventType)) return 0;
  const severityWeight = severity === 'high' ? 2.5 : severity === 'low' ? .5 : 1;
  const categoryWeight: Record<string, number> = { harassment:2, threat:2.5, hate:2.5, insult:1.3, toxicity:1.2, profanity:.7, spam:.4, promotion:.4, fraud:1.2 };
  return severityWeight * (categoryWeight[category] ?? .7);
}

export function pulseClimateScore(messages: number, toxicityWeight: number): number {
  if (messages <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(100 - (toxicityWeight / messages) * 120)));
}

// chatId → communityId, so we don't hit the DB for every single message.
const communityByChat = new Map<string, { id: string | null; expiresAt: number }>();

/** Resolves the community for a group chat id (cached 5 min; null = not ours). */
export async function communityIdForChat(tgChatId: string): Promise<string | null> {
  const cached = communityByChat.get(tgChatId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.id;
  const community = await prisma.community.findFirst({ where: { moderatorChat: { tgChatId } }, select: { id: true } }).catch(() => null);
  const id = community?.id ?? null;
  communityByChat.set(tgChatId, { id, expiresAt: now + (id ? 300_000 : 60_000) });
  if (communityByChat.size > 2000) for (const [k, v] of communityByChat) if (v.expiresAt <= now) communityByChat.delete(k);
  return id;
}

const emptyHours = (): number[] => Array.from({ length: 24 }, () => 0);

type PulseTelegramUser = { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
type PulseTelegramMember = { status: string; is_member?: boolean; user: PulseTelegramUser };
export type PulseTelegramUpdate = {
  message?: { message_id: number; date?: number; chat: { id: number }; from?: PulseTelegramUser; sender_chat?: unknown; is_automatic_forward?: boolean; text?: string; caption?: string;
    new_chat_members?: PulseTelegramUser[]; left_chat_member?: PulseTelegramUser; reply_to_message?: { message_id: number; from?: PulseTelegramUser } };
  chat_member?: { chat: { id: number }; date: number; old_chat_member: PulseTelegramMember; new_chat_member: PulseTelegramMember };
};
export function pulseMembershipPresent(member: { status: string; is_member?: boolean }): boolean {
  return ['member', 'administrator', 'creator'].includes(member.status) || (member.status === 'restricted' && member.is_member === true);
}
/** Shared ingress for Moderator and Manager; edits and service text never add volume. */
export async function recordPulseTelegramUpdate(update: PulseTelegramUpdate, source: string): Promise<void> {
  const change = update.chat_member, message = update.message;
  const chatId = change?.chat.id ?? message?.chat.id;
  if (!chatId) return;
  const communityId = await communityIdForChat(String(chatId));
  if (!communityId) return;
  if (change) {
    if (!change.new_chat_member.user.is_bot && pulseMembershipPresent(change.old_chat_member) !== pulseMembershipPresent(change.new_chat_member)) await recordPulseMembership(communityId, pulseMembershipPresent(change.new_chat_member) ? 'join' : 'leave', String(change.new_chat_member.user.id), new Date(change.date * 1000), 'chat_member');
    return;
  }
  if (!message) return;
  const at = message.date ? new Date(message.date * 1000) : new Date();
  if (message.new_chat_members?.length) { for (const user of message.new_chat_members.filter(u => !u.is_bot)) await recordPulseMembership(communityId, 'join', String(user.id), at); return; }
  if (message.left_chat_member) { if (!message.left_chat_member.is_bot) await recordPulseMembership(communityId, 'leave', String(message.left_chat_member.id), at); return; }
  if (!message.from || message.from.is_bot || message.sender_chat || message.is_automatic_forward || (!message.text && !message.caption)) return;
  await recordPulseMessage({ communityId, tgUserId: String(message.from.id), telegramMessageId: message.message_id, isReply: Boolean(message.reply_to_message),
    replyToMessageId: message.reply_to_message?.message_id, replyToUserId: message.reply_to_message?.from ? String(message.reply_to_message.from.id) : undefined,
    replyToBot: message.reply_to_message?.from?.is_bot, source, at, identity: { username: message.from.username, firstName: message.from.first_name, lastName: message.from.last_name } });
}

export type PulseParticipantIdentityInput = {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
};

const cleanIdentityPart = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\r\n\t<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return cleaned || null;
};

/** Normalizes only Telegram's public identity fields; phone numbers are never stored. */
export function normalizePulseParticipantIdentity(input?: PulseParticipantIdentityInput): { username: string | null; displayName: string | null } {
  if (!input) return { username: null, displayName: null };
  const usernameCandidate = cleanIdentityPart(input.username, 64)?.replace(/^@/, '') ?? null;
  const username = usernameCandidate && /^[A-Za-z0-9_]{5,32}$/.test(usernameCandidate) ? usernameCandidate : null;
  const explicitName = cleanIdentityPart(input.displayName, 128);
  const firstName = cleanIdentityPart(input.firstName, 80);
  const lastName = cleanIdentityPart(input.lastName, 80);
  const telegramName = [firstName, lastName].filter(Boolean).join(' ') || null;
  return { username, displayName: explicitName ?? telegramName };
}

/** Saves the latest public label without touching any Pulse counters. */
export async function rememberPulseParticipantIdentity(input: { communityId: string; tgUserId: string; identity?: PulseParticipantIdentityInput; at?: Date }): Promise<{ username: string | null; displayName: string | null }> {
  const identity = normalizePulseParticipantIdentity(input.identity);
  if (!identity.username && !identity.displayName) return identity;
  const at = input.at ?? new Date();
  await prisma.communityPulseParticipant.upsert({
    where: { communityId_tgUserId: { communityId: input.communityId, tgUserId: input.tgUserId } },
    create: { communityId: input.communityId, tgUserId: input.tgUserId, username: identity.username, displayName: identity.displayName, lastSeenAt: at },
    update: {
      ...(identity.username ? { username: identity.username } : {}),
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      lastSeenAt: at,
    },
  });
  return identity;
}

/**
 * Records one human message: the participant-day fact + the day's hour bucket.
 * `isReply` feeds the engagement axis; `firstDay` marks a person's first ever
 * message here (lurker → contributor conversion).
 *
 * Three independent sources observe the chat (moderator webhook, CM webhook,
 * GramJS personas) so every call carries `telegramMessageId` and the first
 * writer claims it — otherwise an active chat would count 2–3× per message.
 */
export async function recordPulseMessage(input: { communityId: string; tgUserId: string; telegramMessageId: number; isReply: boolean; replyToMessageId?: number; replyToUserId?: string; replyToBot?: boolean; source?: string; at?: Date; identity?: PulseParticipantIdentityInput }): Promise<void> {
  const at = input.at ?? new Date();
  if (!/^\d+$/.test(input.tgUserId) || !Number.isFinite(at.getTime()) || +at > Date.now() + 60_000 || +at < Date.now() - 760 * 86_400_000) return;
  await rememberPulseParticipantIdentity({ ...input, at }).catch(err => console.error('[pulse/identity]', (err as Error).message));
  const day = pulseDayKey(at);
  // Claim and counters commit together. Durable identities survive delayed retries.
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.communityId}))`;
    const persona = await tx.persona.findFirst({ where: { communityId: input.communityId, tgUserId: input.tgUserId }, select: { id: true } });
    const inserted = await tx.pulseMessage.createMany({ data: [{
      communityId: input.communityId, telegramMessageId: input.telegramMessageId,
      tgUserId: input.tgUserId, sentAt: at, isReply: input.isReply,
      replyToMessageId: input.replyToMessageId, replyToUserId: input.replyToUserId,
      replyToBot: input.replyToBot ?? false, source: input.source ?? 'unknown', actorKind: persona ? 'PERSONA' : 'HUMAN',
    }], skipDuplicates: true });
    // Another observer may know the recipient missing from the first envelope.
    if (!inserted.count) {
      if (input.replyToUserId) await tx.pulseMessage.updateMany({ where: { communityId: input.communityId, telegramMessageId: input.telegramMessageId, replyToUserId: null }, data: { replyToUserId: input.replyToUserId, replyToBot: input.replyToBot ?? false } });
      return;
    }
    const oldClaim = await tx.pulseMessageClaim.findUnique({ where: { communityId_telegramMessageId: { communityId: input.communityId, telegramMessageId: input.telegramMessageId } } });
    if (oldClaim) return;
    const seenBefore = await tx.communityDailyParticipant.findFirst({ where: { communityId: input.communityId, tgUserId: input.tgUserId, day: { lt: day } }, select: { id: true } });
    await tx.communityDailyParticipant.upsert({
      where: { communityId_tgUserId_day: { communityId: input.communityId, tgUserId: input.tgUserId, day } },
      create: { communityId: input.communityId, tgUserId: input.tgUserId, day, messages: 1, replies: input.isReply ? 1 : 0, firstDay: !seenBefore },
      update: { messages: { increment: 1 }, ...(input.isReply ? { replies: { increment: 1 } } : {}) },
    });
    const stat = await tx.communityDailyStat.findUnique({ where: { communityId_day: { communityId: input.communityId, day } }, select: { hourHistogram: true } });
    const hours = Array.isArray(stat?.hourHistogram) ? [...stat.hourHistogram as number[]] : emptyHours();
    const hour = pulseHour(at); hours[hour] = (hours[hour] ?? 0) + 1;
    await tx.communityDailyStat.upsert({ where: { communityId_day: { communityId: input.communityId, day } }, create: { communityId: input.communityId, day, hourHistogram: hours }, update: { hourHistogram: hours } });
  });
}

export async function recordPulseMembership(communityId: string, kind: 'join' | 'leave', tgUserId: string, at = new Date(), source = 'service'): Promise<void> {
  if (!tgUserId || !Number.isFinite(at.getTime())) return;
  const day = pulseDayKey(at);
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${communityId}))`;
    const duplicate = await tx.pulseMembership.findFirst({ where: { communityId, tgUserId, kind, occurredAt: { gte: new Date(+at - 10_000), lte: new Date(+at + 10_000) } } });
    if (duplicate) {
      const opposite = await tx.pulseMembership.findFirst({ where: { communityId, tgUserId, kind: kind === 'join' ? 'leave' : 'join', occurredAt: { gt: new Date(Math.min(+duplicate.occurredAt, +at)), lt: new Date(Math.max(+duplicate.occurredAt, +at)) } } });
      if (+duplicate.occurredAt === +at || (duplicate.source !== source && !opposite)) return;
    }
    const [previous, member] = await Promise.all([
      tx.pulseMembership.findFirst({ where: { communityId, tgUserId }, orderBy: { occurredAt: 'asc' } }),
      tx.communityMember.findUnique({ where: { communityId_tgUserId: { communityId, tgUserId } }, select: { joinedAt: true, joinCount: true } }),
    ]);
    const firstJoin = kind === 'join' && !previous && (!member?.joinedAt || Math.abs(+member.joinedAt - +at) < 60_000) && (member?.joinCount ?? 0) <= 1;
    await tx.pulseMembership.create({ data: { communityId, tgUserId, kind, occurredAt: at, source, firstJoin } });
    await tx.communityDailyStat.upsert({ where: { communityId_day: { communityId, day } }, create: { communityId, day, ...(kind === 'join' ? { joins: 1 } : { leaves: 1 }) }, update: kind === 'join' ? { joins: { increment: 1 } } : { leaves: { increment: 1 } } });
  });
}

// ─── Nightly rollup ───────────────────────────────────────────────────────────

/** Day key N days before `from` (MSK). */
function dayKeyBefore(days: number, from = new Date()): string {
  return pulseDayKey(new Date(from.getTime() - days * 86_400_000));
}

/**
 * Recomputes the day row for one community from the participant facts + the
 * moderation journal. Idempotent by (communityId, day): safe to re-run after a
 * failed night, and safe to run for the last few days to pick up late data.
 * Counters written by the live recorder (joins/leaves/hourHistogram) are NOT
 * touched — they are the only record of those events.
 */
export async function rollupPulseDay(communityId: string, day: string): Promise<void> {
  const facts = await prisma.communityDailyParticipant.findMany({
    where: { communityId, day },
    select: { messages: true, replies: true, firstDay: true },
  });
  const messages = facts.reduce((n, f) => n + f.messages, 0);
  const replies = facts.reduce((n, f) => n + f.replies, 0);
  const activeUsers = facts.length; // one row per person per day → already distinct
  const newSpeakers = facts.filter(f => f.firstDay).length;

  // Moderation signals for the same MSK day.
  const from = new Date(`${day}T00:00:00+03:00`);
  const to = new Date(from.getTime() + 86_400_000);
  const events = await prisma.moderationEvent.findMany({
    where: { communityId, createdAt: { gte: from, lt: to } },
    select: { eventType: true, action: true, decision: true, tgUserId: true, metadata: true },
  }).catch(() => []);
  const blockedMsgs = events.filter(e => (e.action ?? '').includes('DELETE')).length;
  const interventions = events.filter(e => e.eventType === 'AI_INTERVENTION').length;
  const conversationEvents = events.filter(e => ['AI_INTERVENTION','CONVERSATION_EPISODE'].includes(e.eventType));
  const conflictEvents = conversationEvents.filter(e => e.decision === 'conflict').length;
  const harassmentEvents = conversationEvents.filter(e => e.decision === 'harassment').length;
  const culturalRewrites = events.filter(e => e.eventType === 'AI_MODERATION_TRIGGERED' && typeof pulseMeta(e.metadata)['suggestedRewrite'] === 'string').length;
  const affectedUsers = new Set(events.flatMap(e => {
    const meta = pulseMeta(e.metadata), targets = Array.isArray(meta['targetIds']) ? meta['targetIds'].flatMap(v => typeof v === 'string' ? [v] : []) : [];
    return [...targets, ...(e.tgUserId && pulseToxicityWeight(e) > 0 ? [e.tgUserId] : [])];
  })).size;
  const resolvedEpisodes = conversationEvents.filter(e => pulseMeta(e.metadata)['state'] === 'RESOLVED').length;
  const escalatedEpisodes = conversationEvents.filter(e => pulseMeta(e.metadata)['state'] === 'ESCALATING').length;
  const toxicityWeight = Math.round(events.reduce((sum,e)=>sum+pulseToxicityWeight(e),0)*100)/100;
  const climateScore = pulseClimateScore(messages,toxicityWeight);

  await prisma.communityDailyStat.upsert({
    where: { communityId_day: { communityId, day } },
    create: { communityId, day, messages, replies, activeUsers, newSpeakers, blockedMsgs, interventions, conflictEvents, harassmentEvents, culturalRewrites, affectedUsers, resolvedEpisodes, escalatedEpisodes, toxicityWeight, climateScore },
    update: { messages, replies, activeUsers, newSpeakers, blockedMsgs, interventions, conflictEvents, harassmentEvents, culturalRewrites, affectedUsers, resolvedEpisodes, escalatedEpisodes, toxicityWeight, climateScore, computedAt: new Date() },
  });
}

/**
 * Rolls up every community for the last `days` days (default 2 — today plus
 * yesterday, so messages landing either side of midnight are never lost), and
 * snapshots the chat's member count, which percentage metrics need.
 */
/** Retain two yearly comparisons plus lookback; remove obsolete v1 claims. */
export async function purgePulseClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - 760 * 86_400_000);
  await prisma.$transaction([
    prisma.pulseMessage.deleteMany({ where: { sentAt: { lt: cutoff } } }),
    prisma.pulseAssessment.deleteMany({ where: { assessedAt: { lt: cutoff } } }),
    prisma.pulseCoverage.deleteMany({ where: { day: { lt: pulseDayKey(cutoff) } } }),
    prisma.pulseModerationRecord.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
  ]);
  const { count } = await prisma.pulseMessageClaim.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 6 * 3_600_000) } } });
  return count;
}

export async function rollupAllCommunities(days = 2): Promise<number> {
  const communities = await prisma.community.findMany({
    where: { moderatorChat: { isNot: null } },
    select: { id: true, moderatorChat: { select: { tgChatId: true } } },
  }).catch(() => []);
  let rolled = 0;
  for (const community of communities) {
    for (let i = 0; i < days; i++) {
      await rollupPulseDay(community.id, dayKeyBefore(i)).catch(err => console.error('[pulse/rollup]', community.id, (err as Error).message));
      rolled++;
    }
    const chatId = community.moderatorChat?.tgChatId;
    if (chatId) await snapshotMemberCount(community.id, chatId).catch(() => undefined);
  }
  return rolled;
}

/** Stores today's total member count (needed for % of members metrics). */
async function snapshotMemberCount(communityId: string, tgChatId: string): Promise<void> {
  const { getChatMemberCount } = await import('./telegramBot');
  const { moderatorTokenForCommunity } = await import('../moderator/managedBotCrypto');
  const { communityManagerExecutor } = await import('../communityManager/managedBot');
  const candidates = await Promise.all([moderatorTokenForCommunity(communityId).catch(() => null), communityManagerExecutor(communityId).then(e => e.token).catch(() => null)]);
  const { observePulseCoverage } = await import('./pulseCoverage');
  const token = await observePulseCoverage(communityId, tgChatId, candidates.filter((t): t is string => Boolean(t)));
  if (!token) return;
  const count = await getChatMemberCount(tgChatId, token);
  if (count == null) return;
  const day = pulseDayKey();
  await prisma.communityDailyStat.upsert({
    where: { communityId_day: { communityId, day } },
    create: { communityId, day, memberCount: count, memberCountAt: new Date(), memberCountSource: 'telegram:getChatMemberCount' },
    update: { memberCount: count, memberCountAt: new Date(), memberCountSource: 'telegram:getChatMemberCount' },
  });
}

/**
 * One-time seed so the dashboard isn't empty on day one. Raw messages are long
 * gone (they purge within hours), but two things survive and can be replayed:
 * every member's joinedAt, and the per-participant activeDayKeys the CM/persona
 * memory keeps for the last 30 days. That yields real joins-per-day and a
 * coarse "was active that day" history. Skips days that already have facts.
 */
export async function seedPulseHistory(communityId: string): Promise<{ days: number; facts: number }> {
  const members = await prisma.communityMember.findMany({ where: { communityId }, select: { tgUserId: true, joinedAt: true } }).catch(() => []);
  const joinsByDay = new Map<string, number>();
  for (const m of members) if (m.joinedAt) joinsByDay.set(pulseDayKey(m.joinedAt), (joinsByDay.get(pulseDayKey(m.joinedAt)) ?? 0) + 1);

  // Active-day history from whichever memory exists for this community.
  const manager = await prisma.communityManager.findUnique({ where: { communityId }, select: { id: true } }).catch(() => null);
  const participants = manager
    ? await prisma.communityManagerParticipant.findMany({ where: { communityManagerId: manager.id }, select: { tgUserId: true, activeDayKeys: true } }).catch(() => [])
    : [];

  let facts = 0;
  for (const p of participants) {
    const days = Array.isArray(p.activeDayKeys) ? (p.activeDayKeys as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    for (const day of days) {
      const exists = await prisma.communityDailyParticipant.findUnique({ where: { communityId_tgUserId_day: { communityId, tgUserId: p.tgUserId, day } }, select: { id: true } });
      if (exists) continue;
      // Only the active day is known. No synthetic message volume is created.
      await prisma.communityDailyParticipant.create({ data: { communityId, tgUserId: p.tgUserId, day, messages: 0, replies: 0, firstDay: false, estimated: true } }).catch(() => undefined);
      facts++;
    }
  }

  for (const [day, joins] of joinsByDay) {
    await prisma.communityDailyStat.upsert({
      where: { communityId_day: { communityId, day } },
      create: { communityId, day, joins },
      update: {},
    }).catch(() => undefined);
  }
  for (const day of new Set([...joinsByDay.keys(), ...participants.flatMap(p => Array.isArray(p.activeDayKeys) ? (p.activeDayKeys as string[]) : [])])) {
    await rollupPulseDay(communityId, day).catch(() => undefined);
  }
  return { days: joinsByDay.size, facts };
}
