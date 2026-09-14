import { Router } from '../lib/asyncRouter';
import type { Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { verifyTonDeposit } from '../lib/tonVerification';
import { pricingFor, isPaidTier, grantSubscription, serializeSub } from '../lib/payments';
import { getEffectiveSubscription } from '../lib/subscriptionLimits';
const router = Router();
async function resolveUser(initData: unknown, res: Response) {
  if (typeof initData !== 'string') { res.status(401).json({ error: 'Откройте приложение в Telegram.' }); return null; }
  let telegramId: string;
  try { telegramId = String(validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN).user.id); }
  catch { res.status(401).json({ error: 'Сессия истекла. Откройте приложение заново.' }); return null; }
  const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
  if (!user) res.status(401).json({ error: 'User not found' });
  return user;
}
router.post('/subscription', async (req, res) => {
  const user = await resolveUser(req.body?.initData, res); if (!user) return;
  res.json({ subscription: serializeSub(await getEffectiveSubscription(user.id)) });
});
// Old clients cannot create invoices or use the user-id-only TON matching flow.
router.post(['/stars/create-invoice', '/stars/create-style-invoice', '/ton/verify', '/ton/verify-style'], (_req, res) => {
  res.status(410).json({ error: 'Обновите приложение. Оплата доступна только через TON.' });
});
router.post('/ton/orders', async (req, res) => {
  const user = await resolveUser(req.body?.initData, res); if (!user) return;
  if (!env.TON_RECEIVING_WALLET || !env.TONCENTER_API_KEY) { res.status(503).json({ error: 'TON payments are not configured' }); return; }
  const { kind, productId } = req.body;
  let amountTon: number;
  if (kind === 'subscription' && isPaidTier(productId)) amountTon = pricingFor(productId).ton;
  else if (kind === 'style' && typeof productId === 'string') {
    const style = await prisma.style.findUnique({ where: { id: productId } });
    if (!style?.published || style.showcaseOnly || style.priceKind !== 'PAID' || !style.priceGram || style.priceGram <= 0) { res.status(400).json({ error: 'Стиль недоступен для покупки.' }); return; }
    if (await prisma.stylePurchase.findUnique({ where: { userId_styleId: { userId: user.id, styleId: productId } } })) { res.status(409).json({ error: 'Стиль уже приобретён.' }); return; }
    amountTon = style.priceGram;
  } else { res.status(400).json({ error: 'Invalid product' }); return; }
  const order = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    const pending = await tx.paymentOrder.findFirst({ where: { userId: user.id, kind, productId, paidAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    return pending ?? tx.paymentOrder.create({ data: { userId: user.id, kind, productId, amountTon, receivingWallet: env.TON_RECEIVING_WALLET, expiresAt: new Date(Date.now() + 30 * 60_000) } });
  });
  res.json({ orderId: order.id, address: order.receivingWallet, amountNano: BigInt(Math.round(order.amountTon * 1e9)).toString(), comment: `publium:${order.id}`, expiresAt: order.expiresAt.toISOString() });
});
router.post('/ton/orders/:id/verify', async (req, res) => {
  const user = await resolveUser(req.body?.initData, res); if (!user) return;
  const order = await prisma.paymentOrder.findFirst({ where: { id: req.params.id, userId: user.id } });
  if (!order) { res.status(404).json({ error: 'Заказ не найден.' }); return; }
  const resultBody = async () => order.kind === 'subscription' ? { subscription: serializeSub(await getEffectiveSubscription(user.id)) } : { owned: true, styleId: order.productId };
  if (order.paidAt) { res.json(await resultBody()); return; }
  const senderWallet = req.body.senderWallet;
  if (typeof senderWallet !== 'string' || !senderWallet.trim()) { res.status(400).json({ error: 'Кошелёк не указан.' }); return; }
  const result = await verifyTonDeposit({ expectedTon: order.amountTon, senderWallet, receivingWallet: order.receivingWallet, apiKey: env.TONCENTER_API_KEY, expectedComment: `publium:${order.id}`, fromDate: order.createdAt, untilDate: order.expiresAt, isHashUsed: async txHash => Boolean(await prisma.paymentLedger.findUnique({ where: { txHash } })) });
  if (!result.ok || !result.txHash) {
    if (result.error === 'transaction_not_found' && Date.now() > order.expiresAt.getTime() + 10 * 60_000) { res.status(410).json({ error: 'Срок заказа истёк, перевод не найден. Если деньги отправлены, сохраните идентификатор заказа и обратитесь в поддержку: ' + order.id, code: 'ORDER_EXPIRED' }); return; }
    res.status(402).json({ error: 'Платёж пока не найден. Повторите проверку без нового перевода.', code: result.error }); return; }
  try {
    await prisma.$transaction(async tx => {
      const claimed = await tx.paymentOrder.updateMany({ where: { id: order.id, paidAt: null }, data: { paidAt: new Date() } });
      if (!claimed.count) return;
      await tx.paymentLedger.create({ data: { txHash: result.txHash!, orderId: order.id, userId: user.id, kind: order.kind } });
      if (order.kind === 'subscription' && isPaidTier(order.productId)) {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
        await grantSubscription(user.id, order.productId, undefined, tx);
      } else if (order.kind === 'style') {
        await tx.stylePurchase.upsert({ where: { userId_styleId: { userId: user.id, styleId: order.productId } }, create: { userId: user.id, styleId: order.productId, via: 'TON', txHash: result.txHash }, update: {} });
      } else throw new Error('Invalid stored product');
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') { res.status(409).json({ error: 'Этот перевод уже использован.' }); return; }
    throw error;
  }
  res.json(await resultBody());
});
export default router;
