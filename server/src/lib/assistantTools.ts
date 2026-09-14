/**
 * assistantTools.ts
 *
 * The assistant's "agent" layer. GPT-5.6 Terra has no native tool-calling on
 * Replicate, so a single cheap Terra JSON call ROUTES the user's latest message
 * to an app action (or plain "answer"). Read-only tools run here and return a
 * compact data block that chat.ts hands back to Terra to phrase (streamed).
 * Write/UI actions (create_post, switch_channel) are returned as envelopes for
 * the client to execute against its already-tested flows. Nothing here ever
 * publishes: create_post makes a draft, schedule_post fills the reviewable
 * Отложка. Never throws — a routing failure degrades to a normal answer.
 */

import { prisma } from '../db';
import { terraJson } from './assistantModel';

export type AssistantAction =
  | 'answer' | 'create_post' | 'schedule_post'
  | 'list_scheduled' | 'channel_stats' | 'moderation_summary' | 'switch_channel';

export interface AssistantRoute {
  action: AssistantAction;
  input?: string;        // create_post: what the post is about
  generateVisual?: boolean;
  when?: string;         // schedule_post: resolved ISO datetime (MSK)
  channelQuery?: string; // switch_channel: raw channel name/handle the user named
  sinceHours?: number;   // moderation_summary window
}

interface RouterChannel { id: string; label: string }

const MSK_TZ = 'Europe/Moscow';
const fmtMsk = (d: Date) => d.toLocaleString('ru-RU', { timeZone: MSK_TZ, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/**
 * Decides whether the user's latest message is an app action. Conservative:
 * defaults to "answer" unless the intent is clear. Returns null on failure so
 * the caller proceeds with a normal reply.
 */
export async function routeAssistantAction(
  history: { role: string; content: string }[],
  message: string,
  channels: RouterChannel[],
  todayISO: string,
  canPlan: boolean,
): Promise<AssistantRoute | null> {
  const transcript = [...history.slice(-6), { role: 'user', content: message }]
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.slice(0, 400)}`)
    .join('\n');
  const channelList = channels.map((c, i) => `${i + 1}. ${c.label}`).join('\n') || '(none)';

  const system =
    `Today is ${todayISO} (Moscow). You route the user's LATEST message in a Telegram content-assistant to ONE action. ` +
    `Default to "answer" for anything that is a question, discussion, idea request, advice, or writing help — most messages are "answer". ` +
    `Only pick an app action when the user clearly COMMANDS it.\n` +
    `Actions:\n` +
    `- "answer": normal reply (default).\n` +
    `- "create_post": user asks to CREATE/generate/draft a concrete post now (e.g. "сделай пост про X", "сгенерируй пост"). params: input (what the post is about, in the channel language), generateVisual (true unless they say no image).\n` +
    (canPlan ? '' : '') +
    `- "schedule_post": user asks to put their most recent draft into the schedule at a time (e.g. "поставь на завтра 10:00", "запланируй на пятницу вечером"). params: when (resolve to absolute "YYYY-MM-DDTHH:MM" Moscow time; interpret утром≈09:00, днём≈13:00, вечером≈19:00).\n` +
    `- "list_scheduled": user asks what is scheduled / in Отложка / upcoming posts.\n` +
    `- "channel_stats": user asks about their channel's stats/numbers/how the channel is doing (owned data).\n` +
    `- "moderation_summary": user asks what happened in the group chat / moderation / who was warned. params: sinceHours (default 24).\n` +
    `- "switch_channel": user asks to switch to another of their channels. params: channelQuery (the name/handle they said). Their channels:\n${channelList}\n` +
    `Return ONLY JSON: {"action":"...","input":"","generateVisual":true,"when":"","channelQuery":"","sinceHours":24}. Omit params you don't need.`;

  const p = await terraJson({ system, prompt: transcript, maxTokens: 220, effort: 'low', timeoutMs: 30_000 });
  if (!p || typeof p['action'] !== 'string') return null;
  const action = p['action'] as string;
  const valid: AssistantAction[] = ['answer', 'create_post', 'schedule_post', 'list_scheduled', 'channel_stats', 'moderation_summary', 'switch_channel'];
  if (!valid.includes(action as AssistantAction)) return { action: 'answer' };
  if (action === 'schedule_post' && !canPlan) return { action: 'answer' };
  return {
    action: action as AssistantAction,
    input: typeof p['input'] === 'string' ? p['input'].slice(0, 2000) : undefined,
    generateVisual: p['generateVisual'] !== false,
    when: typeof p['when'] === 'string' ? p['when'] : undefined,
    channelQuery: typeof p['channelQuery'] === 'string' ? p['channelQuery'].slice(0, 120) : undefined,
    sinceHours: Number.isFinite(Number(p['sinceHours'])) ? Math.max(1, Math.min(168, Number(p['sinceHours']))) : 24,
  };
}

/** Resolves a free-text channel name/handle to one of the user's channels. */
export function matchChannel(query: string | undefined, channels: { id: string; handle: string | null; name: string }[]): string | null {
  if (!query) return null;
  const q = query.trim().toLowerCase().replace(/^@/, '');
  if (!q) return null;
  const exact = channels.find(c => (c.handle ?? '').toLowerCase() === q || c.name.toLowerCase() === q);
  if (exact) return exact.id;
  const partial = channels.find(c => (c.handle ?? '').toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
  return partial?.id ?? null;
}

// ─── Read-only tools: return a compact DATA block for Terra to phrase ─────────

export async function toolListScheduled(userId: string, channelId: string): Promise<string> {
  const posts = await prisma.generatedPost.findMany({
    where: { channelId, channel: { userId }, status: 'SCHEDULED', scheduledAt: { not: null } },
    orderBy: { scheduledAt: 'asc' },
    take: 20,
    select: { scheduledAt: true, variants: { where: { isSelected: true }, take: 1, select: { text: true } } },
  }).catch(() => []);
  if (!posts.length) return 'SCHEDULED_POSTS: none. The schedule (Отложка) is empty for this channel.';
  const lines = posts.map(p => {
    const title = (p.variants[0]?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'без текста';
    return `- ${p.scheduledAt ? fmtMsk(p.scheduledAt) : '?'}: ${title}`;
  });
  return `SCHEDULED_POSTS (${posts.length}, Moscow time):\n${lines.join('\n')}`;
}

export async function toolChannelStats(userId: string, channelId: string, channelLabel: string): Promise<string> {
  const [drafts, scheduled, published, nextPost] = await Promise.all([
    prisma.generatedPost.count({ where: { channelId, channel: { userId }, status: 'NEW' } }),
    prisma.generatedPost.count({ where: { channelId, channel: { userId }, status: 'SCHEDULED' } }),
    prisma.publicationRecord.count({ where: { channelId, userId, status: 'PUBLISHED' } }),
    prisma.generatedPost.findFirst({ where: { channelId, channel: { userId }, status: 'SCHEDULED', scheduledAt: { not: null } }, orderBy: { scheduledAt: 'asc' }, select: { scheduledAt: true } }),
  ]).catch(() => [0, 0, 0, null] as const);
  const last7 = await prisma.publicationRecord.count({ where: { channelId, userId, status: 'PUBLISHED', publishedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }).catch(() => 0);
  return `CHANNEL_STATS for ${channelLabel} (Publium-owned data only, not Telegram subscriber counts):\n` +
    `- drafts (черновики): ${drafts}\n- scheduled (в Отложке): ${scheduled}\n- published via Publium (всего): ${published}\n` +
    `- published in last 7 days: ${last7}\n- next scheduled: ${nextPost?.scheduledAt ? fmtMsk(nextPost.scheduledAt) : 'none'}`;
}

export async function toolModerationSummary(userId: string, channelId: string, sinceHours: number): Promise<string> {
  const community = await prisma.community.findFirst({ where: { channelId, channel: { userId } }, select: { id: true } }).catch(() => null);
  if (!community) return 'MODERATION: this channel has no connected group chat / Moderator, so there is nothing to report.';
  const since = new Date(Date.now() - sinceHours * 3_600_000);
  const events = await prisma.moderationEvent.groupBy({
    by: ['eventType'],
    where: { communityId: community.id, createdAt: { gte: since } },
    _count: { _all: true },
  }).catch(() => [] as { eventType: string; _count: { _all: number } }[]);
  if (!events.length) return `MODERATION_SUMMARY (last ${sinceHours}h): no moderation events — quiet chat.`;
  const label: Record<string, string> = {
    AI_INTERVENTION: 'вмешательства AI', MANUAL_COMMAND: 'ручные команды', ANTISPAM_TRIGGERED: 'антиспам',
    CONTENT_FILTER_TRIGGERED: 'фильтр контента', PROBATION_TRIGGERED: 'режим новичка', RAID_GUARD_TRIGGERED: 'защита от рейда',
    RAID_DETECTED: 'обнаружен рейд', GLOBAL_BLACKLIST: 'чёрный список', CAPTCHA_PASSED: 'капча пройдена',
    CAPTCHA_TIMEOUT: 'капча не пройдена', MEMBER_JOINED: 'новые участники', APPEAL: 'апелляции',
  };
  const lines = events.map(e => `- ${label[e.eventType] ?? e.eventType}: ${e._count._all}`);
  return `MODERATION_SUMMARY (last ${sinceHours}h):\n${lines.join('\n')}`;
}

/** Schedules the channel's most recent editable draft to `whenISO` (MSK). */
export async function toolSchedulePost(userId: string, channelId: string, whenISO: string | undefined): Promise<string> {
  const when = whenISO ? new Date(whenISO.length <= 16 ? whenISO + ':00+03:00' : whenISO) : null;
  if (!when || isNaN(when.getTime())) return 'SCHEDULE_RESULT: could not understand the date/time. Ask the user for a specific day and time.';
  if (when.getTime() < Date.now() + 60_000) return 'SCHEDULE_RESULT: that time is in the past. Ask the user for a future time.';
  const draft = await prisma.generatedPost.findFirst({
    where: { channelId, channel: { userId }, status: 'NEW' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, variants: { where: { isSelected: true }, take: 1, select: { text: true } } },
  }).catch(() => null);
  if (!draft) return 'SCHEDULE_RESULT: no draft to schedule. Tell the user to create a post first, then ask to schedule it.';
  await prisma.generatedPost.update({ where: { id: draft.id }, data: { status: 'SCHEDULED', scheduledAt: when } });
  const title = (draft.variants[0]?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'пост';
  return `SCHEDULE_RESULT: scheduled the latest draft ("${title}") for ${fmtMsk(when)} (Moscow). It is now in the Отложка and can be reviewed there.`;
}
