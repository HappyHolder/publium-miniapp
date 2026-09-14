import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { verifyModeratorSession } from '../lib/moderatorSession';
import { terraText } from '../lib/assistantModel';
import { DEFAULT_PERSONA_CONFIG, parsePersonaConfig } from '../communityCore/personaConfig';
import { encryptPersonaSession } from '../communityCore/personaCrypto';
import { startLogin, confirmCode, confirmPassword, withPersonaClient, updateProfile, joinChat, communityCoreEnabled } from '../communityCore/accountService';
import { decryptPersonaSession } from '../communityCore/personaCrypto';
import { startPersona, stopPersona, reloadPersona } from '../communityCore/engine';
import { participantPublic } from '../communityCore/personaParticipant';
import { getEffectiveSubscription, TIER_LIMITS } from '../lib/subscriptionLimits';

const router = Router();

async function auth(req: Request) {
  const session = verifyModeratorSession(req.headers.authorization);
  const user = await prisma.user.findUnique({ where: { telegramId: session.tgUserId }, select: { id: true } });
  if (!user) throw new Error('USER_NOT_FOUND');
  return { user };
}
function fail(res: Response, e: unknown) {
  const message = e instanceof Error ? e.message : '';
  const status = message === 'NOT_FOUND' ? 404 : message === 'PLAN_REQUIRED' ? 403 : 401;
  const error = message === 'PLAN_REQUIRED'
    ? 'Community Core доступен со Starter'
    : message === 'SESSION_EXPIRED'
      ? 'Сессия истекла. Переоткройте Publium.'
      : 'Недействительная авторизация';
  res.status(status).json({ error });
}
async function ownedPersona(req: Request, id: string) {
  const a = await auth(req);
  const persona = await prisma.persona.findFirst({ where: { id, ownerUserId: a.user.id }, include: { community: { include: { moderatorChat: true, chat: true, channel: true } } } });
  if (!persona) throw new Error('NOT_FOUND');
  const subscription = await getEffectiveSubscription(a.user.id);
  if (!TIER_LIMITS[subscription.tier].canUseCommunityCore) throw new Error('PLAN_REQUIRED');
  return { ...a, persona, subscription };
}
const publicPersona = (p: any) => ({ id: p.id, status: p.status, enabled: p.enabled, username: p.username, tgUserId: p.tgUserId, lastError: p.lastError, lastActionAt: p.lastActionAt, connected: Boolean(p.sessionCipher), config: parsePersonaConfig(p.draftConfig), published: Boolean(p.publishedConfig) });

// List personas for a channel's community.
router.get('/channels/:channelId', async (req, res) => {
  let a; try { a = await auth(req); } catch (e) { return fail(res, e); }
  const community = await prisma.community.findFirst({ where: { channelId: req.params.channelId, channel: { userId: a.user.id } }, include: { moderatorChat: true, personas: { orderBy: { createdAt: 'asc' } } } });
  if (!community) { res.json({ enabled: communityCoreEnabled(), communityId: null, chat: null, personas: [] }); return; }
  res.json({ enabled: communityCoreEnabled(), communityId: community.id, chat: community.moderatorChat ? { title: community.moderatorChat.title, tgChatId: community.moderatorChat.tgChatId } : null, personas: community.personas.map(publicPersona) });
});

router.get('/chats/:chatId', async (req, res) => {
  let a; try { a = await auth(req); } catch (e) { return fail(res, e); }
  const community = await prisma.community.findFirst({ where: { chatId: req.params.chatId, chat: { userId: a.user.id } }, include: { moderatorChat: true, personas: { orderBy: { createdAt: 'asc' } } } });
  if (!community) { res.json({ enabled: communityCoreEnabled(), communityId: null, chat: null, personas: [] }); return; }
  res.json({ enabled: communityCoreEnabled(), communityId: community.id, chat: community.moderatorChat ? { title: community.moderatorChat.title, tgChatId: community.moderatorChat.tgChatId } : null, personas: community.personas.map(publicPersona) });
});

// Create a persona (draft, no account yet).
router.post('/channels/:channelId/personas', async (req, res) => {
  let a; try { a = await auth(req); } catch (e) { return fail(res, e); }
  const subscription = await getEffectiveSubscription(a.user.id);
  const personaLimit = TIER_LIMITS[subscription.tier].communityCorePersonaLimit;
  if (personaLimit <= 0) { res.status(403).json({ error: 'Community Core доступен со Starter', limit: 0 }); return; }
  const used = await prisma.persona.count({ where: { ownerUserId: a.user.id } });
  if (used >= personaLimit) { res.status(403).json({ error: 'Лимит личностей исчерпан', limit: personaLimit, used }); return; }
  const community = await prisma.community.findFirst({ where: { channelId: req.params.channelId, channel: { userId: a.user.id } }, select: { id: true } });
  if (!community) { res.status(404).json({ error: 'Сначала подключите группу через Moderator' }); return; }
  const persona = await prisma.persona.create({ data: { communityId: community.id, ownerUserId: a.user.id, draftConfig: DEFAULT_PERSONA_CONFIG as any, status: 'DRAFT' } });
  res.json({ persona: publicPersona(persona) });
});

router.post('/chats/:chatId/personas', async (req, res) => {
  let a; try { a = await auth(req); } catch (e) { return fail(res, e); }
  const subscription = await getEffectiveSubscription(a.user.id), personaLimit = TIER_LIMITS[subscription.tier].communityCorePersonaLimit;
  if (personaLimit <= 0) { res.status(403).json({ error: 'Community Core доступен со Starter', limit: 0 }); return; }
  const used = await prisma.persona.count({ where: { ownerUserId: a.user.id } });
  if (used >= personaLimit) { res.status(403).json({ error: 'Лимит личностей исчерпан', limit: personaLimit, used }); return; }
  const community = await prisma.community.findFirst({ where: { chatId: req.params.chatId, chat: { userId: a.user.id } }, select: { id: true } });
  if (!community) { res.status(404).json({ error: 'Сначала подключите чат через Moderator' }); return; }
  const persona = await prisma.persona.create({ data: { communityId: community.id, ownerUserId: a.user.id, draftConfig: DEFAULT_PERSONA_CONFIG as any, status: 'DRAFT' } });
  res.json({ persona: publicPersona(persona) });
});

// ── Account login: phone → code → (password) ────────────────────────────────
router.post('/:id/login/start', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    const phone = String((req.body as { phone?: unknown }).phone ?? '').replace(/[\s()\-]/g, '');
    if (!/^\+?\d{7,15}$/.test(phone)) { res.status(400).json({ error: 'Введите номер в международном формате' }); return; }
    const start = await startLogin(phone);
    await prisma.persona.update({ where: { id: persona.id }, data: { phone, loginPhoneCodeHash: start.phoneCodeHash, loginTempSession: start.tempSession, loginExpiresAt: new Date(Date.now() + 10 * 60_000) } });
    res.json({ status: 'CODE_SENT' });
  } catch (e) { if (e instanceof Error && (e.message === 'NOT_FOUND' || e.message === 'SESSION_EXPIRED')) return fail(res, e); res.status(502).json({ error: 'Не удалось отправить код. Проверьте номер.' }); }
});

router.post('/:id/login/code', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    if (!persona.loginTempSession || !persona.loginPhoneCodeHash || !persona.phone) { res.status(400).json({ error: 'Сначала запросите код' }); return; }
    const code = String((req.body as { code?: unknown }).code ?? '').replace(/\D/g, '');
    if (!code) { res.status(400).json({ error: 'Введите код' }); return; }
    const result = await confirmCode(persona.loginTempSession, persona.phone, persona.loginPhoneCodeHash, code);
    if (result.status === 'PASSWORD_NEEDED') {
      await prisma.persona.update({ where: { id: persona.id }, data: { loginTempSession: result.tempSession } });
      res.json({ status: 'PASSWORD_NEEDED', hint: result.hint });
      return;
    }
    await storeSession(persona.id, persona.communityId, result);
    res.json({ status: 'CONNECTED', username: result.username });
  } catch (e) { if (e instanceof Error && (e.message === 'NOT_FOUND' || e.message === 'SESSION_EXPIRED')) return fail(res, e); res.status(400).json({ error: 'Неверный или просроченный код.' }); }
});

router.post('/:id/login/password', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    if (!persona.loginTempSession) { res.status(400).json({ error: 'Сначала введите код' }); return; }
    const password = String((req.body as { password?: unknown }).password ?? '');
    if (!password) { res.status(400).json({ error: 'Введите пароль' }); return; }
    const result = await confirmPassword(persona.loginTempSession, password);
    if (result.status !== 'DONE') { res.status(400).json({ error: 'Не удалось войти' }); return; }
    await storeSession(persona.id, persona.communityId, result);
    res.json({ status: 'CONNECTED', username: result.username });
  } catch (e) { if (e instanceof Error && (e.message === 'NOT_FOUND' || e.message === 'SESSION_EXPIRED')) return fail(res, e); res.status(400).json({ error: 'Неверный пароль.' }); }
});

async function storeSession(personaId: string, communityId: string, result: { session: string; tgUserId: string; username: string | null }) {
  const enc = encryptPersonaSession(result.session, communityId);
  await prisma.persona.update({ where: { id: personaId }, data: { ...enc, tgUserId: result.tgUserId, username: result.username, status: 'CONNECTED', loginPhoneCodeHash: null, loginTempSession: null, loginExpiresAt: null } });
}

// AI draft: turn a short brief into a full persona config the owner then edits.
router.post('/:id/generate-canon', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    const brief = String((req.body as { brief?: unknown }).brief ?? '').trim().slice(0, 400);
    if (brief.length < 4) { res.status(400).json({ error: 'Опишите личность в двух словах' }); return; }
    const raw = await terraText({
      system: 'Ты создаёшь досье живого участника Telegram-чата по короткому описанию. Верни ТОЛЬКО JSON вида {"identity":{"displayName","gender":"male|female|unspecified","age","city","occupation","about"},"role","interests":["..."],"canon":["факт о себе","..."],"voice":{"messageExamples":["как он реально пишет, коротко","..."],"speechStyle","emojiUse":"none|rare|normal|heavy"},"behavior":{"expertTopics":["..."]}}. Пиши по-русски, живо и конкретно, как настоящий человек, а не бренд. 4–5 примеров реплик и 4–6 канон-фактов.',
      prompt: 'Описание: ' + brief,
      maxTokens: 900, timeoutMs: 45_000, effort: 'low',
    });
    const match = raw?.match(/\{[\s\S]*\}/);
    const parsedRaw = match ? (() => { try { return JSON.parse(match[0]); } catch { return {}; } })() : {};
    const config = parsePersonaConfig({ ...(persona.draftConfig as object), ...parsedRaw });
    await prisma.persona.update({ where: { id: persona.id }, data: { draftConfig: config as any } });
    res.json({ config });
  } catch (e) { if (e instanceof Error && (e.message === 'NOT_FOUND' || e.message === 'SESSION_EXPIRED')) return fail(res, e); res.status(502).json({ error: 'Не удалось сгенерировать. Попробуйте ещё раз.' }); }
});

// Save personality draft.
router.patch('/:id/draft', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    const config = parsePersonaConfig((req.body as { config?: unknown }).config);
    await prisma.persona.update({ where: { id: persona.id }, data: { draftConfig: config as any } });
    res.json({ ok: true, config });
  } catch (e) { fail(res, e); }
});

// Apply personality (publish + push profile to the account).
router.post('/:id/apply', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    const config = parsePersonaConfig(persona.draftConfig);
    await prisma.persona.update({ where: { id: persona.id }, data: { publishedConfig: config as any } });
    if (persona.sessionCipher) {
      const session = decryptPersonaSession(persona);
      const [firstName, ...rest] = config.identity.displayName.split(' ');
      const about = (config.identity.about || config.role) + ' · AI-личность Publium';
      try { await withPersonaClient(session, c => updateProfile(c, { firstName, lastName: rest.join(' ') || undefined, about })); } catch { /* profile update best-effort */ }
    }
    // Reload a running persona so the new texts take effect immediately.
    await reloadPersona(persona.id).catch(() => undefined);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Start / pause.
router.post('/:id/start', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    if (!persona.sessionCipher) { res.status(400).json({ error: 'Сначала подключите Telegram-аккаунт' }); return; }
    if (!persona.publishedConfig) { res.status(400).json({ error: 'Сначала примените личность' }); return; }
    const chat = persona.community.moderatorChat?.tgChatId;
    if (chat) { const session = decryptPersonaSession(persona); try { await withPersonaClient(session, c => joinChat(c, chat)); } catch { /* may already be a member */ } }
    await prisma.persona.update({ where: { id: persona.id }, data: { enabled: true } });
    await startPersona(persona.id);
    res.json({ ok: true });
  } catch (e) { if (e instanceof Error && (e.message === 'NOT_FOUND' || e.message === 'SESSION_EXPIRED')) return fail(res, e); res.status(500).json({ error: 'Не удалось запустить личность' }); }
});

router.post('/:id/pause', async (req, res) => {
  try { const { persona } = await ownedPersona(req, req.params.id); await stopPersona(persona.id); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});

// People the persona remembers.
router.get('/:id/participants', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    const rows = await prisma.personaParticipant.findMany({ where: { personaId: persona.id }, orderBy: { lastSeenAt: 'desc' }, take: 50 });
    res.json({ participants: rows.map(participantPublic) });
  } catch (e) { fail(res, e); }
});

// Decision log.
router.get('/:id/log', async (req, res) => {
  try {
    const { persona } = await ownedPersona(req, req.params.id);
    const actions = await prisma.personaAction.findMany({ where: { personaId: persona.id }, orderBy: { createdAt: 'desc' }, take: 40 });
    res.json({ actions });
  } catch (e) { fail(res, e); }
});

// Delete persona (also stops it; session ciphertext removed with the row).
router.delete('/:id', async (req, res) => {
  try { const { persona } = await ownedPersona(req, req.params.id); await stopPersona(persona.id).catch(() => {}); await prisma.persona.delete({ where: { id: persona.id } }); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});

export default router;
