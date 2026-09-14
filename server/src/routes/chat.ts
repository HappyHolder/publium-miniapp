import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { TIER_LIMITS, getEffectiveSubscription, reserveSubscriptionQuota, refundSubscriptionQuota } from '../lib/subscriptionLimits';
import type { PlanTier } from '@prisma/client';
import multer from 'multer';
import { webSearch } from '../lib/webSearch';
import { terraText, terraJson, type TerraEffort } from '../lib/assistantModel';
import { generateContentPlan, type ContentPlanDTO, MAX_POSTS_PER_DAY, MAX_DAYS } from '../lib/contentPlanner';
import { extractImageContentFromUrl } from '../lib/visionExtractor';
import { transcribeAudio } from '../lib/voiceTranscriber';
import { putObject, deleteObject } from '../lib/storage';
import {
  routeAssistantAction, matchChannel,
  toolListScheduled, toolChannelStats, toolModerationSummary, toolSchedulePost,
  type AssistantRoute,
} from '../lib/assistantTools';
import { runOpenAiChat, type OaiTool, type ToolOutcome } from '../lib/openaiChat';

const router = Router();

const uploadMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const HISTORY_LIMIT = 100; // messages fed to the model as context
const STORE_LIMIT   = 300; // messages kept per session in DB

/** Validates initData and resolves the DB user. Throws with a message on failure. */
async function authChatUser(initData: unknown): Promise<{ id: string; name: string | null }> {
  if (typeof initData !== 'string' || !initData.trim()) throw new Error('initData required');
  const parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  const dbUser = await prisma.user.findUnique({ where: { telegramId: String(parsed.user.id) }, select: { id: true, name: true } });
  if (!dbUser) throw new Error('User not found');
  return dbUser;
}

const sessionTitleFrom = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 60);

/** One-time lazy migration: wraps a user's legacy session-less messages into a single session. */
async function adoptLegacyMessages(userId: string): Promise<void> {
  const orphan = await prisma.chatMessage.findFirst({ where: { userId, sessionId: null }, select: { id: true } });
  if (!orphan) return;
  const firstUserMsg = await prisma.chatMessage.findFirst({ where: { userId, sessionId: null, role: 'user' }, orderBy: { createdAt: 'asc' }, select: { content: true } });
  const session = await prisma.chatSession.create({ data: { userId, title: firstUserMsg ? sessionTitleFrom(firstUserMsg.content) : 'Прежний диалог' } });
  await prisma.chatMessage.updateMany({ where: { userId, sessionId: null }, data: { sessionId: session.id } });
}

/** Retitles sessions still carrying a placeholder name from their first user message. */
async function retitlePlaceholderSessions(userId: string): Promise<void> {
  const placeholders = await prisma.chatSession.findMany({ where: { userId, title: { in: ['Прежний диалог', 'Новый чат'] } }, select: { id: true } });
  for (const s of placeholders) {
    const firstUserMsg = await prisma.chatMessage.findFirst({ where: { sessionId: s.id, role: 'user' }, orderBy: { createdAt: 'asc' }, select: { content: true } });
    if (firstUserMsg) await prisma.chatSession.update({ where: { id: s.id }, data: { title: sessionTitleFrom(firstUserMsg.content) } }).catch(() => undefined);
  }
}

// ─── Chat sessions ────────────────────────────────────────────────────────────

router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  let user;
  try { user = await authChatUser((req.query as { initData?: string }).initData); }
  catch (err) { res.status(401).json({ error: (err as Error).message }); return; }
  await adoptLegacyMessages(user.id).catch(() => undefined);
  await retitlePlaceholderSessions(user.id).catch(() => undefined);
  const sessions = await prisma.chatSession.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true, title: true, channelId: true, updatedAt: true },
  });
  res.json({ sessions });
});

router.post('/sessions', async (req: Request, res: Response): Promise<void> => {
  const { initData, channelId } = req.body as { initData?: unknown; channelId?: unknown };
  let user;
  try { user = await authChatUser(initData); }
  catch (err) { res.status(401).json({ error: (err as Error).message }); return; }
  const session = await prisma.chatSession.create({
    data: { userId: user.id, channelId: typeof channelId === 'string' && channelId ? channelId : null },
    select: { id: true, title: true, channelId: true, updatedAt: true },
  });
  res.status(201).json({ session });
});

router.delete('/sessions/:sessionId', async (req: Request, res: Response): Promise<void> => {
  let user;
  try { user = await authChatUser((req.query as { initData?: string }).initData ?? (req.body as { initData?: unknown })?.initData); }
  catch (err) { res.status(401).json({ error: (err as Error).message }); return; }
  const session = await prisma.chatSession.findFirst({ where: { id: req.params['sessionId'], userId: user.id }, select: { id: true } });
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  await prisma.chatSession.delete({ where: { id: session.id } }); // messages cascade
  res.json({ ok: true });
});

/**
 * Search decision: a cheap low-effort Terra call decides whether answering
 * needs a fresh web search, and with what query. Replaces the old behavior of
 * force-searching EVERY message (cost + latency on "спасибо"-grade replies).
 * On classifier failure falls back to searching the user's literal words —
 * over-searching is safer than hallucinating.
 */
async function decideSearchBlock(message: string, history: { role: string; content: string }[], currentYear: number): Promise<string> {
  const trimmed = message.trim();
  if (trimmed.length < 6) return '';
  const recent = history.slice(-4).map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.slice(0, 300)}`).join('\n');
  const decision = await terraJson({
    system:
      `Decide if answering the user's LATEST message needs a fresh web search (recent events, news, prices, stats, "latest", current facts, anything after the model's training cutoff). ` +
      `Chit-chat, editing requests, rewrites of earlier text, brainstorming on evergreen topics need NO search. ` +
      `If search is needed, build ONE focused query preserving the user's specifics (names, places), using the year ${currentYear} when time-relevant. ` +
      `Return ONLY JSON: {"query":"<query, or empty string when no search needed>"}`,
    prompt: (recent ? `Conversation so far:\n${recent}\n\n` : '') + `LATEST user message: ${trimmed.slice(0, 600)}`,
    maxTokens: 120,
    effort: 'low',
    timeoutMs: 30_000,
  });
  let query: string | null = null;
  if (decision) {
    query = typeof decision['query'] === 'string' && decision['query'].trim() ? decision['query'].trim().slice(0, 400) : '';
  } else {
    query = trimmed.slice(0, 400); // classifier down → literal search, as before
  }
  if (!query) return '';
  const results = await webSearch(query);
  if (results) return `\n\nWEB SEARCH RESULTS (current facts fetched for you — base any recent/real-world answer ONLY on these, cite briefly):\n${results}\n`;
  return '';
}

/**
 * Deterministic content-plan intent detector — a cheap Terra JSON classifier
 * over the conversation (models narrate "building the plan" instead of acting,
 * so the server decides). Only fires `ready` when the user is clearly asking to
 * BUILD a multi-post series AND topic + postsPerDay + days + startDate + times
 * are all known. Returns null when not ready or on error.
 */
interface PlanIntent {
  topic: string; postsPerDay: number; days: number; startDate: string;
  source: 'web' | 'uploads' | 'both'; rubricHint?: string; times: string[];
}
async function detectPlanIntent(
  history: { role: string; content: string }[],
  message: string,
  todayISO: string,
): Promise<PlanIntent | null> {
  const transcript = [...history.slice(-12), { role: 'user', content: message }]
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n');

  const system =
    `Today is ${todayISO}. You decide whether the user is confirming that they want to BUILD a SERIES of multiple posts ` +
    `(a mini-course / multi-day content plan) to be scheduled — and whether enough is known to build it right now.\n` +
    `Return ONLY JSON: {"ready":bool,"topic":str,"postsPerDay":int,"days":int,"startDate":"YYYY-MM-DD","times":["HH:MM"],"source":"web|uploads|both","rubricHint":str}.\n` +
    `Set ready=true ONLY if ALL of these are known from the conversation: the topic, how many posts per day, over how many days (derive days from a total like "7 posts, 1/day" = 7 days), a start date, AND the publish time(s) of day. Resolve relative dates ("с 13 июля", "послезавтра") against today into an absolute YYYY-MM-DD.\n` +
    `"times": the daily publish times the user asked for, as "HH:MM" 24h (e.g. ["10:00"] or ["10:00","18:00"] for 2/day). If the user has NOT specified a posting time yet, set ready=false — the assistant must ask for it first. Interpret "утром"≈09:00, "днём"≈13:00, "вечером"≈19:00.\n` +
    `Set ready=false if the user is still asking questions, brainstorming, wants a single post, or any of topic/postsPerDay/days/startDate/times is missing. When ready=false the other fields are ignored.\n` +
    `IMPORTANT: only use parameters the user has given for the CURRENT request. If the latest request is a NEW series and the user hasn't restated the start date / time / cadence for it, set ready=false and let the assistant ask — do NOT silently reuse details from an earlier, already-built plan in the history.\n` +
    `source: "web" for internet research, "uploads" for the user's own documents, "both". Default "web". rubricHint: a category name if the user named one, else "".`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = await terraJson({ system, prompt: transcript, maxTokens: 250, effort: 'low', timeoutMs: 30_000 }) as any;
    if (!p || p.ready !== true) return null;
    const topic = typeof p.topic === 'string' ? p.topic.trim() : '';
    const postsPerDay = Number(p.postsPerDay);
    const days = Number(p.days);
    const startDate = typeof p.startDate === 'string' ? p.startDate : '';
    const times = Array.isArray(p.times)
      ? p.times.filter((t: unknown): t is string => typeof t === 'string' && /^\d{1,2}(:\d{1,2})?$/.test(t.trim())).map((t: string) => t.trim())
      : [];
    // Time is required — without it we won't build (the assistant should ask).
    if (!topic || !Number.isFinite(postsPerDay) || !Number.isFinite(days)
      || !/^\d{4}-\d{2}-\d{2}/.test(startDate) || times.length === 0) return null;
    return {
      topic, postsPerDay, days, startDate, times,
      source: p.source === 'uploads' || p.source === 'both' ? p.source : 'web',
      rubricHint: typeof p.rubricHint === 'string' && p.rubricHint.trim() ? p.rubricHint.trim() : undefined,
    };
  } catch {
    return null;
  }
}

// ─── OpenAI agent: tool definitions + executor (native function calling) ──────
interface AgentCtx {
  userId: string;
  channelId: string;
  activeChannel: { id: string; handle: string | null; name: string };
  allChannels: { id: string; handle: string | null; name: string }[];
  canSearch: boolean;
  canPlan: boolean;
  todayISO: string;
}

/** Builds the tool schemas + executor the OpenAI model drives itself. */
function buildAssistantAgent(ctx: AgentCtx): { tools: OaiTool[]; execute: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome> } {
  const activeLabel = ctx.activeChannel.handle ? `@${ctx.activeChannel.handle}` : ctx.activeChannel.name;
  const tools: OaiTool[] = [];
  const str = (o: Record<string, unknown>, k: string) => typeof o[k] === 'string' ? (o[k] as string) : '';

  if (ctx.canSearch) tools.push({ name: 'web_search', description: 'Search the web for current or factual information (news, prices, recent events, stats). Returns a summary and top results with source, date, url.', parameters: { type: 'object', properties: { query: { type: 'string', description: "Focused query in the user's language; include the current year for time-sensitive topics" } }, required: ['query'] } });
  tools.push({ name: 'list_scheduled', description: "List the channel's upcoming scheduled posts (Отложка).", parameters: { type: 'object', properties: {}, required: [] } });
  tools.push({ name: 'channel_stats', description: "The channel's Publium stats: drafts, scheduled, published counts, next scheduled post.", parameters: { type: 'object', properties: {}, required: [] } });
  tools.push({ name: 'moderation_summary', description: "Summary of the connected group chat's moderation events (deletions, warns, joins, raids).", parameters: { type: 'object', properties: { sinceHours: { type: 'integer', description: 'Look-back window in hours (default 24)' } }, required: [] } });
  tools.push({ name: 'switch_channel', description: "Switch the app's active channel to another of the user's channels.", parameters: { type: 'object', properties: { channelQuery: { type: 'string', description: 'Name or @handle of the channel to switch to' } }, required: ['channelQuery'] } });
  tools.push({ name: 'create_post', description: 'Open the Create screen prefilled to generate ONE post on a topic. Use when the user asks to make/generate/draft a single post.', parameters: { type: 'object', properties: { input: { type: 'string', description: 'What the post should be about, in the channel language' }, generateVisual: { type: 'boolean', description: 'Whether to also generate a cover image (default true)' } }, required: ['input'] } });
  if (ctx.canPlan) {
    tools.push({ name: 'schedule_post', description: "Put the channel's most recent draft into the schedule (Отложка) at a given time.", parameters: { type: 'object', properties: { when: { type: 'string', description: 'Absolute local time "YYYY-MM-DDTHH:MM" (Moscow)' } }, required: ['when'] } });
    tools.push({ name: 'create_content_plan', description: 'Build a DRAFT multi-day SERIES of posts (mini-course / content plan). Only call once topic, postsPerDay, days, startDate and times are all known — ask the user first otherwise.', parameters: { type: 'object', properties: { topic: { type: 'string' }, postsPerDay: { type: 'integer' }, days: { type: 'integer' }, startDate: { type: 'string', description: 'YYYY-MM-DD' }, times: { type: 'array', items: { type: 'string' }, description: '["HH:MM"] per post/day' }, source: { type: 'string', enum: ['web', 'uploads', 'both'] }, rubricHint: { type: 'string' } }, required: ['topic', 'postsPerDay', 'days', 'startDate', 'times'] } });
  }

  const execute = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    switch (name) {
      case 'web_search': {
        const q = str(args, 'query').slice(0, 400);
        const r = q ? await webSearch(q) : null;
        return { result: r || 'No results found.' };
      }
      case 'list_scheduled':
        return { result: await toolListScheduled(ctx.userId, ctx.channelId).catch(() => 'SCHEDULED_POSTS: could not load.') };
      case 'channel_stats':
        return { result: await toolChannelStats(ctx.userId, ctx.channelId, activeLabel).catch(() => 'CHANNEL_STATS: could not load.') };
      case 'moderation_summary': {
        const h = Number.isFinite(Number(args['sinceHours'])) ? Math.max(1, Math.min(168, Number(args['sinceHours']))) : 24;
        return { result: await toolModerationSummary(ctx.userId, ctx.channelId, h).catch(() => 'MODERATION: could not load.') };
      }
      case 'switch_channel': {
        const targetId = matchChannel(str(args, 'channelQuery'), ctx.allChannels);
        if (targetId && targetId !== ctx.activeChannel.id) {
          const target = ctx.allChannels.find(c => c.id === targetId)!;
          const label = target.handle ? '@' + target.handle : target.name;
          return { result: `Switched to ${label}.`, action: { action: 'switch_channel', channelId: targetId } };
        }
        if (targetId) return { result: `Already on ${activeLabel}.` };
        return { result: `No such channel. Available: ${ctx.allChannels.map(c => c.handle ? '@' + c.handle : c.name).join(', ')}.` };
      }
      case 'create_post': {
        const input = str(args, 'input').slice(0, 2000);
        if (!input) return { result: 'Missing topic — ask the user what the post is about.' };
        return { result: 'Create is opening prefilled with this topic; the user reviews the draft there.', action: { action: 'create_post', input, generateVisual: args['generateVisual'] !== false } };
      }
      case 'schedule_post':
        return { result: await toolSchedulePost(ctx.userId, ctx.channelId, str(args, 'when')).catch(() => 'SCHEDULE_RESULT: failed, ask the user to try from the Отложка.') };
      case 'create_content_plan': {
        if (!ctx.canPlan) return { result: 'Content plans require the Creator plan or higher.' };
        try {
          const times = Array.isArray(args['times']) ? (args['times'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
          const plan = await generateContentPlan({
            channelId: ctx.channelId,
            topic: str(args, 'topic'),
            postsPerDay: Number(args['postsPerDay']) || 1,
            days: Number(args['days']) || 1,
            startDate: new Date(str(args, 'startDate') || ctx.todayISO),
            source: args['source'] === 'uploads' || args['source'] === 'both' ? args['source'] as 'uploads' | 'both' : 'web',
            rubricHint: str(args, 'rubricHint') || undefined,
            times,
          });
          return { result: `Plan draft created: ${plan.totalPosts} posts on "${plan.topic}". A card with a «Приступить» button is now shown — confirm in one short sentence, do not list the posts.`, plan };
        } catch (err) {
          return { result: `Failed to build the plan: ${(err as Error).message}. Apologize and suggest retrying.` };
        }
      }
      default:
        return { result: `Unknown tool ${name}.` };
    }
  };

  return { tools, execute };
}

// ─── GET /api/chat/history ────────────────────────────────────────────────────
// Returns the user's full chat history (oldest → newest).
// Query: { initData }

router.get('/history', async (req: Request, res: Response): Promise<void> => {
  const { initData, sessionId, channelId } = req.query as { initData?: string; sessionId?: string; channelId?: string };
  let user;
  try { user = await authChatUser(initData); }
  catch (err) { res.status(401).json({ error: (err as Error).message }); return; }

  await adoptLegacyMessages(user.id).catch(() => undefined);

  // Resolve which session to show: explicit id → that one; otherwise the most
  // recently used session (preferring the active channel's), if any.
  let session = null;
  if (sessionId?.trim()) {
    session = await prisma.chatSession.findFirst({ where: { id: sessionId, userId: user.id }, select: { id: true } });
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  } else {
    if (channelId?.trim()) session = await prisma.chatSession.findFirst({ where: { userId: user.id, channelId }, orderBy: { updatedAt: 'desc' }, select: { id: true } });
    if (!session) session = await prisma.chatSession.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' }, select: { id: true } });
  }
  if (!session) { res.json({ sessionId: null, messages: [] }); return; }

  // Newest STORE_LIMIT messages, returned oldest → newest.
  const history = (await prisma.chatMessage.findMany({
    where:   { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take:    STORE_LIMIT,
    select:  { role: true, content: true },
  })).reverse();

  res.json({ sessionId: session.id, messages: history });
});

// ─── POST /api/chat ───────────────────────────────────────────────────────────
// Sends the latest user message to the unified primary AI model using full DB history as context.
// Saves both the user message and the AI reply to DB.
// Request body: { initData, channelId, message: string }
// Response 200: { reply: string }

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { initData, channelId, message, sessionId, stream, imageUrl } = req.body as {
    initData?:  unknown;
    channelId?: unknown;
    message?:   unknown;
    sessionId?: unknown;
    stream?:    unknown;
    imageUrl?:  unknown;
  };
  const hasImage = typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl);

  // SSE mode: `stream: true` switches the response to text/event-stream with
  // {type:'chunk'|'done'|'error'} events. Pre-generation errors (auth, quota)
  // still return plain JSON — the client checks the content type.
  const wantStream = stream === true;
  let sseStarted = false;
  const sseSend = (payload: Record<string, unknown>) => {
    if (!sseStarted) {
      sseStarted = true;
      res.writeHead(200, {
        'Content-Type':      'text/event-stream; charset=utf-8',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (typeof channelId !== 'string' || !channelId.trim()) { res.status(400).json({ error: 'channelId required' }); return; }
  if (typeof message !== 'string' || (!message.trim() && !hasImage)) { res.status(400).json({ error: 'message required' }); return; }
  // With an image and no text, give the model a default instruction.
  const userMessage = message.trim() || (hasImage ? 'Разбери это изображение.' : '');

  let dbUser;
  try { dbUser = await authChatUser(initData); }
  catch (err) { res.status(401).json({ error: (err as Error).message }); return; }

  // Resolve the target session: an owned existing one, or a fresh session
  // titled after the first message.
  let session = typeof sessionId === 'string' && sessionId.trim()
    ? await prisma.chatSession.findFirst({ where: { id: sessionId, userId: dbUser.id }, select: { id: true, title: true } })
    : null;
  if (!session) {
    session = await prisma.chatSession.create({
      data: { userId: dbUser.id, channelId, title: (userMessage || 'Изображение').replace(/\s+/g, ' ').slice(0, 60) },
      select: { id: true, title: true },
    });
  }

  const subscription = await getEffectiveSubscription(dbUser.id);
  const tier = subscription.tier;
  const plan = TIER_LIMITS[tier];
  const canPlan = plan.canUseContentManager;
  if (!env.OPENAI_API_KEY) { res.status(503).json({ error: 'AI not configured' }); return; }

  const assistantQuota = await reserveSubscriptionQuota(dbUser.id, 'assistant');
  if (!assistantQuota.ok) {
    res.status(429).json({ error: `Месячный лимит AI Assistant исчерпан (${assistantQuota.limit}).`, code: 'CHAT_LIMIT', used: assistantQuota.used, limit: assistantQuota.limit });
    return;
  }
  let assistantReserved = true;

  const effort: TerraEffort = tier === 'STUDIO_PRO' ? 'high' : tier === 'CREATOR' ? 'medium' : 'low';
  const [activeChannel, allChannels] = await Promise.all([
    prisma.channel.findUnique({
      where:  { id: channelId },
      select: { id: true, handle: true, name: true, userId: true },
    }).catch(() => null),
    prisma.channel.findMany({
      where:   { userId: dbUser.id },
      orderBy: { createdAt: 'asc' },
      select:  {
        id: true, handle: true, name: true,
        brandKit: { select: { channelAbout: true, voiceProfile: true, postRules: true, visualKit: true } },
      },
    }).catch(() => []),
  ]);

  if (!activeChannel || activeChannel.userId !== dbUser.id) {
    res.status(403).json({ error: 'Channel not found or access denied' }); return;
  }

  // Model context: the newest HISTORY_LIMIT messages of THIS session, oldest → newest.
  const history = (await prisma.chatMessage.findMany({
    where:   { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take:    HISTORY_LIMIT,
    select:  { role: true, content: true },
  })).reverse();

  // Build system prompt
  const userName    = dbUser.name?.trim() || null;
  const activeLabel = activeChannel.handle ? `@${activeChannel.handle}` : activeChannel.name;

  function brandKitLines(bk: typeof allChannels[number]['brandKit']): string[] {
    const lines: string[] = [];
    if (bk?.channelAbout && typeof bk.channelAbout === 'object') {
      const a = bk.channelAbout as Record<string, unknown>;
      if (typeof a['topic']          === 'string' && a['topic'])          lines.push(`  Topic: ${a['topic']}`);
      if (typeof a['targetAudience'] === 'string' && a['targetAudience']) lines.push(`  Audience: ${a['targetAudience']}`);
      if (typeof a['contentGoal']    === 'string' && a['contentGoal'])    lines.push(`  Goal: ${a['contentGoal']}`);
    }
    if (bk?.voiceProfile && typeof bk.voiceProfile === 'object') {
      const vp = bk.voiceProfile as Record<string, unknown>;
      if (typeof vp['tone']       === 'string' && vp['tone'])       lines.push(`  Tone: ${vp['tone']}`);
      if (typeof vp['language']   === 'string' && vp['language'])   lines.push(`  Language: ${vp['language']}`);
      if (typeof vp['authorRole'] === 'string' && vp['authorRole']) lines.push(`  Author role: ${vp['authorRole']}`);
      if (typeof vp['postLength'] === 'string' && vp['postLength']) lines.push(`  Post length: ${vp['postLength']}`);
    }
    if (bk?.voiceProfile && typeof bk.voiceProfile === 'object') {
      const vp = bk.voiceProfile as Record<string, unknown>;
      if (typeof vp['customNote'] === 'string' && vp['customNote'].trim())
        lines.push(`  Owner guidance (text): ${vp['customNote'].trim()}`);
    }
    if (bk?.postRules && typeof bk.postRules === 'object') {
      const pr = bk.postRules as Record<string, unknown>;
      if (typeof pr['defaultStructure'] === 'string' && pr['defaultStructure'])
        lines.push(`  Structure: ${pr['defaultStructure']}`);
      if (typeof pr['customNote'] === 'string' && pr['customNote'].trim())
        lines.push(`  Owner guidance (format): ${pr['customNote'].trim()}`);
    }
    if (bk?.visualKit && typeof bk.visualKit === 'object') {
      const vk = bk.visualKit as Record<string, unknown>;
      if (typeof vk['coverBgStyle'] === 'string' && vk['coverBgStyle'] !== 'auto')
        lines.push('  Required image style: ' + vk['coverBgStyle']);
      if (typeof vk['coverBgDetail'] === 'string')
        lines.push('  Image detail: ' + vk['coverBgDetail']);
      if (typeof vk['visualCoverStyle'] === 'string' && vk['visualCoverStyle'].trim())
        lines.push('  Visual style guide: ' + vk['visualCoverStyle'].trim().replace(/\s+/g, ' ').slice(0, 600));
      if (Array.isArray(vk['brandColors'])) {
        const colors = (vk['brandColors'] as unknown[]).slice(0, 5).flatMap(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const color = item as Record<string, unknown>;
          const hex = typeof color['hex'] === 'string' ? color['hex'] : '';
          if (!/^#[0-9a-f]{6}$/i.test(hex)) return [];
          const name = typeof color['name'] === 'string' ? color['name'].trim().slice(0, 50) : '';
          return [(name ? name + ' ' : '') + hex];
        });
        if (colors.length) lines.push('  Brand colors: ' + colors.join(', '));
      }
      if (Array.isArray(vk['references'])) {
        const refs = (vk['references'] as unknown[]).slice(0, 5).flatMap(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const description = (item as Record<string, unknown>)['description'];
          return typeof description === 'string' && description.trim()
            ? [description.trim().replace(/\s+/g, ' ').slice(0, 240)]
            : [];
        });
        if (refs.length) lines.push('  Visual references: ' + refs.join(' | '));
      }
      if (Array.isArray(vk['avoidList'])) {
        const avoid = (vk['avoidList'] as unknown[])
          .flatMap(item => typeof item === 'string' && item.trim() ? [item.trim().slice(0, 100)] : [])
          .slice(0, 12);
        if (avoid.length) lines.push('  Avoid in images: ' + avoid.join(', '));
      }
    }
    return lines;
  }

  const channelsSummary = allChannels.map(ch => {
    const label = ch.handle ? `@${ch.handle}` : ch.name;
    const isActive = ch.id === channelId;
    const lines = brandKitLines(ch.brandKit);
    return `${isActive ? '▶ ' : '  '}${label}${isActive ? ' (currently active)' : ''}\n` +
           (lines.length > 0 ? lines.join('\n') : '  (no BrandKit configured)');
  }).join('\n\n');

  const canSearch = !!env.TAVILY_API_KEY;

  // Anchor the model to the real current date. Without this it falls back to its
  // training cutoff and gets the year/month wrong — and builds web_search queries
  // for the wrong year (e.g. returning last edition of a tournament).
  const now = new Date();
  const MSK_TZ = 'Europe/Moscow';
  const todayLine = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: MSK_TZ,
  });
  const currentYear = Number(now.toLocaleDateString('en-US', { year: 'numeric', timeZone: MSK_TZ }));

  const systemPrompt =
    `You are a personal AI content assistant inside the "Publium" Telegram Mini App.\n` +
    (userName ? `You are talking with ${userName}.\n` : '') +
    `\nCURRENT DATE: today is ${todayLine} (Moscow time, MSK). The current year is ${currentYear}. ` +
    `This is the single source of truth for the date — use it for anything about "today", "now", "current", "this year", or "this season". ` +
    `Do NOT rely on your own memory for the date; your training data is older than today.\n` +
    `\nThe user manages ${allChannels.length} Telegram channel(s). Currently active: ${activeLabel}.\n` +
    `\nAll connected channels and their styles:\n${channelsSummary}\n` +
    `\nYou help with: content ideas, post drafts, image prompts, content strategy, audience engagement, post editing.\n` +
    `\nPANORAMA PROMPTS: When the user asks for a prompt for Publium image slicing, determine one of three existing gallery options: horizontal swipe carousel, vertical stack, or 4x4 modular composition. For horizontal or vertical mode, determine the segment count (2-8) and ask briefly if required information is missing. Return one ready-to-paste image prompt in English, while any explanation stays in the user's language. Horizontal and vertical prompts must describe ONE seamless continuous scene, never a collage or separate panels: use a left-to-right journey for horizontal and a top-to-bottom journey for vertical; state the segment count, put a meaningful focal detail in every segment, keep faces, hands, and key objects away from cut lines, and bridge seams with background, light, paths, or motion. For 4x4 mode, write only the visual request for ONE square source image containing exactly four complete synchronized variants side by side. Never mention a grid, 4x4 matrix, sixteen tiles, slicing, cut lines, connectors, coordinates, guides, technical bands, or body-part modules inside the ready-to-paste image prompt because the image model may draw them. Never assume a fixed subject type: the four variants may be environments, seasons, interfaces, products, objects, outfits, living subjects, abstract scenes, or anything else. Infer the intended difference between the variants, while requiring identical camera, crop, perspective, scale, layout, major geometry, horizon, visual anchors, and spatial relationships. Require useful content throughout the full canvas height and no excessive empty space. If the user explicitly requests labels, include only those exact labels once above or near the corresponding variants; otherwise prohibit all text. Always prohibit visible separators, borders, gutters, technical annotations, pseudo-text, logos, and watermarks. In every mode require the active channel BrandKit art direction, palette, detail, and mood.\n` +
    `Tailor all advice to the active channel's BrandKit style and audience.\n` +
    `If the user asks about a different channel, switch context accordingly.\n` +
    `Always respond in the same language the user writes in.\n` +
    `CRITICAL ANTI-HALLUCINATION RULE: never invent or guess facts, news, events, dates, places, names, quotes, numbers, or outcomes. ` +
    `For any question about real-world or recent events, rely ONLY on a "WEB SEARCH RESULTS" block. ` +
    `If there is no such block, or it does not actually contain the answer, say plainly that you can't confirm it (and offer to look it up) — do NOT fabricate a plausible-sounding answer.\n` +
    (canSearch
      ? `If a "WEB SEARCH RESULTS" block appears in the conversation, it holds current information fetched for you — base any time-sensitive or factual answer ONLY on it and briefly mention the sources, building reasoning around the year ${currentYear}. If no such block is present and the question depends on very recent events, say you can't confirm and offer to look it up — never guess.\n` +
        `SOURCE QUALITY: prefer and lead with reputable primary and international outlets (Reuters, AP, Bloomberg, BBC, The Guardian, Financial Times, and established agencies like ТАСС, Интерфакс, РБК, Коммерсантъ). Do NOT lead with or lean on content aggregators, SEO farms or portals (mail.ru, dzen, rambler, msn) — mention them only if nothing better is available, and say so. Always name the outlet you're citing, not just "источник".\n`
      : '') +
    (canPlan
      ? `\nCONTENT MANAGER: The system can build a whole SERIES of posts (a mini-course, a themed multi-day plan) and drop them into the user's Отложка (scheduler). When the user asks for a series/mini-course/content-plan of MULTIPLE posts, do NOT write the posts yourself in chat. ` +
        `Your only job is to collect the missing details — ask brief CLARIFYING questions in one message: from which day to start the schedule (so they have time to review before posts go out), **at what time of day to publish** (e.g. 10:00, or 10:00 and 18:00 for two a day), how many posts per day and over how many days (max ${MAX_POSTS_PER_DAY}/day, ${MAX_DAYS} days), the sources (web research / uploaded project docs / both), and a preferred rubric if any. Do NOT invent a posting time — ask the user. ` +
        `Once every detail is known, the system builds the plan AUTOMATICALLY and shows the user a plan card with a «Приступить» button — you never list the posts yourself.\n`
      : '') +
    `\nPOST MATERIAL MARKER: If and ONLY if the main body of your reply is ready-to-publish post material for the channel (a complete draft post, a rewritten/edited post text, a caption) — something the user could publish after light editing — begin the reply with the exact token [[POST]] and then the content. NEVER use the token for advice, analysis, idea lists, strategies, questions, plans, greetings, or conversation. The token is machine-read and hidden from the user.\n` +
    `Be concise, practical, and creative. Give actionable advice.`;

  try {
    let reply = '';
    let pendingPlan: ContentPlanDTO | null = null; // set when a content-series plan is built
    let actionEnvelope: Record<string, unknown> | null = null; // create_post / switch_channel → client executes
    let toolContext = ''; // read-tool DATA block Terra phrases instead of a free answer
    const todayMskISO = now.toLocaleDateString('en-CA', { timeZone: MSK_TZ }); // YYYY-MM-DD (MSK)

    // ── Vision: fold an attached image's content into the model message ───────
    // The screenshot is only needed for this extraction — it is never stored in
    // chat history, so delete it from disk right after (it would be pure garbage).
    let modelMessage = userMessage;
    if (hasImage) {
      const visionText = await extractImageContentFromUrl(imageUrl as string).catch(() => null);
      if (visionText) modelMessage = `${userMessage}\n\n[Содержимое прикреплённого изображения]:\n${visionText}`;
      if ((imageUrl as string).includes('/chat/')) deleteObject(imageUrl as string).catch(() => undefined);
    }

    let streamedAny = false;
    let createWorthy = false;
    let usedOpenAi = false;

    // ── Primary path: native tool calling ─────────────────────────────────────
    // The model itself reasons and calls tools (search / create_post / schedule
    // / stats / …) in one loop — no separate classifiers. This used to be gated
    // behind ASSISTANT_PROVIDER='openai'; the flag is gone because a missing env
    // var silently downgraded the assistant to the legacy classifier path.
    // On failure we still fall through to that path below (also OpenAI now).
    if (env.OPENAI_API_KEY) {
      const { tools, execute } = buildAssistantAgent({
        userId: dbUser.id, channelId, activeChannel: { id: activeChannel.id, handle: activeChannel.handle, name: activeChannel.name },
        allChannels: allChannels.map(c => ({ id: c.id, handle: c.handle, name: c.name })),
        canSearch, canPlan, todayISO: todayMskISO,
      });
      const toolDirective =
        `\n\nTOOLS: You can call these tools yourself, repeatedly, in one turn. ` +
        `If web_search returns weak, off-topic or aggregator-only results, DO NOT stop and ask the user to search or list queries for them — refine the query yourself and call web_search AGAIN (try English, add the current date, and site: filters for reputable outlets like reuters.com, bloomberg.com, apnews.com, ft.com, coindesk.com, theblock.co), up to ~4 attempts, until you have solid material or have genuinely exhausted reasonable options. Only then answer, citing the outlets. NEVER tell the user to run a search — you run it. Same for the other tools: act, don't ask the user to do it.`;
      const oa = await runOpenAiChat({
        system: systemPrompt + toolDirective, history, userMessage: modelMessage, tools, execute,
        effort: tier === 'STUDIO_PRO' ? 'medium' : 'low',
        onDelta: (t) => { if (wantStream && t) { streamedAny = true; sseSend({ type: 'chunk', text: t }); } },
        maxTokens: 3000, timeoutMs: 150_000,
      }).catch(() => null);
      if (oa?.ok) {
        usedOpenAi = true;
        reply = oa.text || (oa.action || oa.plan ? 'Готово.' : '');
        createWorthy = oa.createWorthy;
        if (oa.action) actionEnvelope = oa.action;
        if (oa.plan) pendingPlan = oa.plan as ContentPlanDTO;
      }
    }

    // Plan-intent and the agent router are independent classifiers over the
    // same message — run them concurrently so we add one wave of latency, not
    // two, before the streamed answer begins.
    const routerChannels = usedOpenAi ? [] : allChannels.map(c => ({ id: c.id, label: c.handle ? `@${c.handle}` : c.name }));
    const [planIntent, agentRoute] = usedOpenAi ? [null, null] : await Promise.all([
      canPlan ? detectPlanIntent(history, modelMessage, todayMskISO).catch(() => null) : Promise.resolve(null),
      routeAssistantAction(history, modelMessage, routerChannels, todayMskISO, canPlan).catch(() => null),
    ]);

    // ── Deterministic content-plan path (CREATOR+) ────────────────────────────
    // Decided server-side with a cheap Terra classifier — models narrate
    // "building the plan" instead of acting, so the server acts itself.
    if (!usedOpenAi && canPlan) {
      const intent = planIntent;
      if (intent) {
        try {
          pendingPlan = await generateContentPlan({
            channelId,
            topic:       intent.topic,
            postsPerDay: intent.postsPerDay,
            days:        intent.days,
            startDate:   new Date(intent.startDate),
            source:      intent.source,
            rubricHint:  intent.rubricHint,
            times:       intent.times,
          });
          reply = `Готово — собрал план на ${pendingPlan.totalPosts} ${pendingPlan.totalPosts === 1 ? 'пост' : 'постов'} по теме «${pendingPlan.topic}». Проверь карточку ниже и нажми «Приступить» — я разложу их в Отложку.`;
        } catch (err) {
          console.error('[chat] plan build failed:', (err as Error).message);
          // Fall through to the normal reply (the assistant keeps clarifying).
        }
      }
    }

    // ── Agent router (Stage 3) ────────────────────────────────────────────────
    // A cheap Terra classifier decides whether this message is an app action.
    // Read tools run here → toolContext (Terra phrases it). Write/UI actions →
    // actionEnvelope (client executes its tested flow). Skipped once a plan or
    // reply already exists. Never fatal: a routing miss falls through to answer.
    if (!usedOpenAi && !reply && !pendingPlan) {
      const route: AssistantRoute | null = agentRoute;
      const activeLabelText = activeChannel.handle ? `@${activeChannel.handle}` : activeChannel.name;
      if (route && route.action !== 'answer') {
        console.log(`[chat] action=${route.action}`);
        if (route.action === 'create_post') {
          const topic = (route.input ?? modelMessage).slice(0, 2000);
          actionEnvelope = { action: 'create_post', input: topic, generateVisual: route.generateVisual !== false };
          reply = 'Готовлю пост — открываю Create с этой темой. Пробегись по черновику и правь, если нужно.';
        } else if (route.action === 'switch_channel') {
          const targetId = matchChannel(route.channelQuery, allChannels);
          if (targetId && targetId !== activeChannel.id) {
            const target = allChannels.find(c => c.id === targetId)!;
            actionEnvelope = { action: 'switch_channel', channelId: targetId };
            reply = `Переключаюсь на ${target.handle ? '@' + target.handle : target.name}.`;
          } else if (targetId) {
            reply = `Ты уже в ${activeLabelText}.`;
          } else {
            reply = `Не нашёл такой канал среди твоих. Доступны: ${allChannels.map(c => c.handle ? '@' + c.handle : c.name).join(', ')}.`;
          }
        } else if (route.action === 'schedule_post') {
          toolContext = await toolSchedulePost(dbUser.id, channelId, route.when).catch(() => 'SCHEDULE_RESULT: failed, ask the user to try from the Отложка.');
        } else if (route.action === 'list_scheduled') {
          toolContext = await toolListScheduled(dbUser.id, channelId).catch(() => 'SCHEDULED_POSTS: could not load.');
        } else if (route.action === 'channel_stats') {
          toolContext = await toolChannelStats(dbUser.id, channelId, activeLabelText).catch(() => 'CHANNEL_STATS: could not load.');
        } else if (route.action === 'moderation_summary') {
          toolContext = await toolModerationSummary(dbUser.id, channelId, route.sinceHours ?? 24).catch(() => 'MODERATION: could not load.');
        }
      }
    }

    // ── Terra reply ───────────────────────────────────────────────────────────
    // Search is decided (not forced), results are injected into the flattened
    // conversation, and one Terra call produces the answer. terraText falls
    // returns a provider error if the primary model is unavailable.
    // maxTokens is generous because GPT-5.6-style models spend part of the
    // completion budget on hidden reasoning.
    const POST_MARKER = '[[POST]]';
    if (!usedOpenAi && !reply) {
      // Read-tool results are phrased (never searched); normal turns may search.
      const searchBlock = (!toolContext && canSearch) ? await decideSearchBlock(modelMessage, history, currentYear).catch(() => '') : '';
      const convo = history.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');
      const dataBlock = toolContext
        ? `\n\nAPP DATA (fetched from the user's Publium account — answer ONLY from this, in the user's language, concise and friendly; format times/dates naturally; do not invent anything beyond it):\n${toolContext}\n`
        : '';
      const prompt = `${convo ? convo + '\n\n' : ''}${searchBlock}${dataBlock}User: ${modelMessage}\n\nAssistant:`;

      // Non-streaming on purpose: the streaming transport was Replicate-only and
      // is gone, and the [[POST]] marker gate it needed went with it. This path
      // is a rare fallback; SSE still delivers the whole reply in one chunk
      // below (`if (!streamedAny)`), so only the typing effect is lost. The
      // marker is stripped from the finished text instead of mid-stream.
      const out = await terraText({ system: systemPrompt, prompt, maxTokens: 2048, effort, timeoutMs: 120_000 });
      if (out) {
        createWorthy = createWorthy || /^\s*\[\[POST\]\]/.test(out);
        reply = out.replace(/^\s*\[\[POST\]\]\s*/, '');
      }
    }

    if (!reply) reply = 'Не удалось получить ответ. Попробуй переформулировать.';
    console.log(`[chat] mode=${wantStream ? 'sse' : 'json'} streamed=${streamedAny} post=${createWorthy} len=${reply.length} effort=${effort}`);

    // Save user + final assistant reply to DB (non-fatal). Intermediate tool
    // turns are not persisted — history stays a clean {role, content} log.
    const sessionRef = session;
    const storedUserContent = hasImage ? `${userMessage}\n[изображение]` : userMessage;
    prisma.chatMessage.createMany({
      data: [
        { userId: dbUser.id, sessionId: sessionRef.id, role: 'user',      content: storedUserContent },
        { userId: dbUser.id, sessionId: sessionRef.id, role: 'assistant', content: reply   },
      ],
    }).then(() =>
      prisma.chatSession.update({ where: { id: sessionRef.id }, data: { channelId } }).catch(() => undefined),
    ).catch(err => console.error('[chat] DB save failed:', (err as Error).message));

    // Trim: keep the newest STORE_LIMIT messages of the session, drop the oldest.
    prisma.chatMessage.findMany({
      where:   { sessionId: sessionRef.id },
      orderBy: { createdAt: 'desc' },
      skip:    STORE_LIMIT,
      select:  { id: true },
    }).then(old => {
      if (old.length > 0) {
        prisma.chatMessage.deleteMany({ where: { id: { in: old.map(m => m.id) } } }).catch(() => {});
      }
    }).catch(() => {});

    if (wantStream) {
      // Plan replies and fallback texts were never streamed — emit them whole.
      if (!streamedAny) sseSend({ type: 'chunk', text: reply });
      sseSend({ type: 'done', sessionId: sessionRef.id, createWorthy, ...(pendingPlan ? { plan: pendingPlan } : {}), ...(actionEnvelope ? { action: actionEnvelope } : {}) });
      res.end();
    } else {
      res.json({ reply, sessionId: sessionRef.id, createWorthy, ...(pendingPlan ? { plan: pendingPlan } : {}), ...(actionEnvelope ? { action: actionEnvelope } : {}) });
    }

  } catch (err) {
    if (assistantReserved) { await refundSubscriptionQuota(dbUser.id, 'assistant'); assistantReserved = false; }
    console.error('[chat] Error:', (err as Error).message);
    if (sseStarted) {
      try { sseSend({ type: 'error', error: 'AI request failed' }); res.end(); } catch { /* connection gone */ }
    } else {
      res.status(502).json({ error: 'AI request failed' });
    }
  }
});

// ─── POST /api/chat/upload-image ──────────────────────────────────────────────
// Uploads an image the user attached in the assistant composer; returns its URL
// to send back with the chat message (server extracts its content via vision).
router.post('/upload-image', uploadMedia.single('image'), async (req: Request, res: Response): Promise<void> => {
  const initData = req.body['initData'] as unknown;
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'image is required' }); return; }
  let user;
  try { user = await authChatUser(initData); }
  catch (err) { res.status(401).json({ error: (err as Error).message }); return; }
  if (!/^image\//.test(file.mimetype)) { res.status(400).json({ error: 'file must be an image' }); return; }
  try {
    const ext = (file.originalname.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
    const obj = await putObject(`chat/${user.id}-${Date.now()}.${ext}`, file.buffer, { contentType: file.mimetype });
    res.json({ url: obj.url });
  } catch (err) {
    console.error('[chat/upload-image] failed:', (err as Error).message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── POST /api/chat/transcribe ────────────────────────────────────────────────
// Transcribes a recorded voice note (Whisper on Replicate). Returns { text } for
// the client to place in the input field — the user reviews before sending.
router.post('/transcribe', uploadMedia.single('audio'), async (req: Request, res: Response): Promise<void> => {
  const initData = req.body['initData'] as unknown;
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'audio is required' }); return; }
  let user;
  try { user = await authChatUser(initData); }
  catch (err) { res.status(401).json({ error: (err as Error).message }); return; }
  // Cheap guard against transcription-quota abuse: charge one assistant unit.
  const quota = await reserveSubscriptionQuota(user.id, 'assistant');
  if (!quota.ok) { res.status(429).json({ error: `Месячный лимит AI Assistant исчерпан (${quota.limit}).`, code: 'CHAT_LIMIT' }); return; }
  try {
    const dataUri = `data:${file.mimetype || 'audio/webm'};base64,${file.buffer.toString('base64')}`;
    const text = await transcribeAudio(dataUri);
    if (!text) { await refundSubscriptionQuota(user.id, 'assistant'); res.status(502).json({ error: 'Не удалось распознать речь' }); return; }
    res.json({ text });
  } catch (err) {
    await refundSubscriptionQuota(user.id, 'assistant').catch(() => undefined);
    console.error('[chat/transcribe] failed:', (err as Error).message);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

export default router;
