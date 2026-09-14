import { Router } from '../lib/asyncRouter';
import { type Request, type Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';

const router = Router();

async function owner(req: Request, res: Response): Promise<{ id: string } | null> {
  const initData = req.body?.initData;
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' });
    return null;
  }
  let telegramId: string;
  try {
    telegramId = String(validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN).user.id);
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid initData' });
    return null;
  }
  const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
  if (!user) res.status(401).json({ error: 'User not found. Re-open Publium.' });
  return user;
}

const STYLE_KEYS = ['channelAbout', 'voiceProfile'] as const;

router.patch('/:chatId/style', async (req, res) => {
  const user = await owner(req, res); if (!user) return;
  const chat = await prisma.chat.findFirst({ where: { id: req.params.chatId, userId: user.id }, select: { id: true } });
  if (!chat) { res.status(404).json({ error: 'Chat not found' }); return; }
  const raw = req.body?.sections;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { res.status(400).json({ error: 'sections must be an object' }); return; }
  const data: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) if (key in raw) data[key] = raw[key];
  if (!Object.keys(data).length) { res.status(400).json({ error: 'No valid chat style sections' }); return; }
  const style = await prisma.chatStyle.upsert({
    where: { chatId: chat.id },
    update: data,
    create: { chatId: chat.id, ...data },
    select: { chatId: true, channelAbout: true, voiceProfile: true },
  });
  res.json({ ok: true, style });
});

router.post('/:chatId/link-channel', async (req, res) => {
  const user = await owner(req, res); if (!user) return;
  const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : '';
  const [chat, channel] = await Promise.all([
    prisma.chat.findFirst({ where: { id: req.params.chatId, userId: user.id }, select: { id: true } }),
    prisma.channel.findFirst({ where: { id: channelId, userId: user.id, kind: 'CHANNEL' }, select: { id: true } }),
  ]);
  if (!chat || !channel) { res.status(404).json({ error: 'Chat or channel not found' }); return; }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    await tx.channelChatLink.updateMany({ where: { OR: [{ channelId: channel.id }, { chatId: chat.id }], isPrimary: true }, data: { isPrimary: false } });
    await tx.channelChatLink.upsert({
      where: { channelId_chatId: { channelId: channel.id, chatId: chat.id } },
      create: { channelId: channel.id, chatId: chat.id, relationType: 'MANUAL', isPrimary: true },
      update: { relationType: 'MANUAL', isPrimary: true },
    });
  });
  res.json({ ok: true });
});

router.post('/:chatId/unlink-channel', async (req, res) => {
  const user = await owner(req, res); if (!user) return;
  const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : '';
  const deleted = await prisma.channelChatLink.deleteMany({
    where: { chatId: req.params.chatId, channelId, chat: { userId: user.id }, channel: { userId: user.id } },
  });
  res.status(deleted.count ? 200 : 404).json(deleted.count ? { ok: true } : { error: 'Link not found' });
});

router.post('/:chatId/disconnect', async (req, res) => {
  const user = await owner(req, res); if (!user) return;
  const deleted = await prisma.chat.deleteMany({ where: { id: req.params.chatId, userId: user.id } });
  res.status(deleted.count ? 200 : 404).json(deleted.count ? { ok: true } : { error: 'Chat not found' });
});

export default router;
