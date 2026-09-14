import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Refuse to run against production, even if the operator accidentally passes its URL.
if (!new URL(process.env.DATABASE_URL ?? '').pathname.startsWith('/publium_audit_')) throw new Error('Integration tests require a publium_audit_* database');
const require = createRequire(import.meta.url);
const { prisma } = require('../dist/db.js');
const { env } = require('../dist/env.js');
const { confirmPlan, cancelPlan } = require('../dist/lib/contentPlanQuota.js');
const { publishPost } = require('../dist/lib/publication.js');
const { assertStyleAccess } = require('../dist/lib/styleAccess.js');
const { putObject, deleteObject } = require('../dist/lib/storage.js');
const { storageOwner } = require('../dist/lib/storageContext.js');
const { assertMediaAccess } = require('../dist/lib/mediaAccess.js');
const { Prisma } = require('@prisma/client');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'publium-audit-'));
env.STORAGE_DIR = temp;
const tag = randomUUID(); let user, stranger, style, httpServer;
const originalFetch = globalThis.fetch;
try {
  user = await prisma.user.create({ data: { telegramId: String(Date.now()), subscription: { create: { tier: 'STARTER', expiresAt: new Date(Date.now() + 86400000), quotaResetAt: new Date(Date.now() + 86400000) } } } });
  stranger = await prisma.user.create({ data: { telegramId: `other-${tag}` } });
  const channel = await prisma.channel.create({ data: { userId: user.id, name: 'Integration test', tgChatId: '-100000000001' } });
  const plan = await prisma.contentPlan.create({ data: { channelId: channel.id, topic: 'Test', postsPerDay: 1, days: 1, startDate: new Date(), items: { create: [{ orderIndex: 0, scheduledAt: new Date(), workingTitle: 'Test', angle: '', searchQuery: 'Test' }] } } });
  const confirmations = await Promise.allSettled([confirmPlan(plan.id, user.id), confirmPlan(plan.id, user.id)]);
  assert.equal(confirmations.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await prisma.subscription.findUnique({ where: { userId: user.id } })).contentManagerPostsUsed, 1);

  let started, finish;
  const generationStarted = new Promise(r => started = r);
  const generationFinish = new Promise(r => finish = r);
  require('../dist/lib/researchEngine.js').research = async () => ({ text: 'Test' });
  require('../dist/lib/draftGenerator.js').createDraftPostForChannel = async () => { started(); await generationFinish; return prisma.generatedPost.create({ data: { channelId: channel.id, title: 'Cancelled generation', variants: { create: { text: 'Test' } } } }); };
  const running = require('../dist/lib/contentWorker.js').runContentPlan(plan.id);
  await generationStarted;
  await Promise.all([cancelPlan(plan.id, user.id), cancelPlan(plan.id, user.id)]);
  finish(); await running;
  assert.equal(await prisma.generatedPost.count({ where: { channelId: channel.id, status: 'SCHEDULED' } }), 0);
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  assert.equal(sub.contentManagerPostsUsed, 0); assert.equal(sub.visualGenerationsUsed, 0);
  console.log('PASS concurrent confirmation, cancellation during generation and one-time refunds');

  let sends = 0;
  globalThis.fetch = async url => { assert.match(String(url), /^https:\/\/api\.telegram\.org\//); sends++; return new Response(JSON.stringify({ ok: true, result: { message_id: 777, chat: { id: -100000000001 } } }), { headers: { 'content-type': 'application/json' } }); };
  const post = await prisma.generatedPost.create({ data: { channelId: channel.id, title: 'Publish once', variants: { create: { text: 'Publish once' } } } });
  const publications = await Promise.allSettled([publishPost(post.id), publishPost(post.id)]);
  assert.equal(publications.filter(r => r.status === 'fulfilled').length, 1); assert.equal(sends, 1);
  await prisma.generatedPost.delete({ where: { id: post.id } });
  assert.equal(await prisma.publicationRecord.count({ where: { postId: post.id, status: 'PUBLISHED' } }), 1);
  const cancelled = await prisma.generatedPost.create({ data: { channelId: channel.id, title: 'No longer scheduled', status: 'NEW', variants: { create: { text: 'Never send' } } } });
  await assert.rejects(publishPost(cancelled.id, true)); assert.equal(sends, 1);
  console.log('PASS concurrent publication, cancelled schedule and durable publication history');

  const object = await storageOwner.run(user.id, () => putObject('test.png', Buffer.from('test')));
  await assert.rejects(assertMediaAccess({ url: object.url }, stranger.id), /другому/);
  await deleteObject(object.url, stranger.id); assert.equal((await fs.readFile(path.join(temp, object.pathname))).toString(), 'test');
  await prisma.brandKit.create({ data: { channelId: channel.id, visualKit: { logoUrl: object.url } } });
  await deleteObject(object.url, user.id); await fs.access(path.join(temp, object.pathname));
  await prisma.brandKit.update({ where: { channelId: channel.id }, data: { visualKit: Prisma.DbNull } });
  await deleteObject(object.url, user.id); await assert.rejects(fs.access(path.join(temp, object.pathname)));
  console.log('PASS owner-scoped file access and shared-reference retention');

  style = await prisma.style.create({ data: { slug: tag, nameRu: 'Test', nameEn: 'Test', priceKind: 'PAID', priceGram: 1, published: true, templates: [{ name: 'Test', url: 'https://example.com/protected.html' }] } });
  await assert.rejects(assertStyleAccess(user.id, { templateUrl: 'https://example.com/protected.html' }), /приобретите/);
  await prisma.stylePurchase.create({ data: { userId: user.id, styleId: style.id, via: 'TON' } });
  await assertStyleAccess(user.id, { templateUrl: 'https://example.com/protected.html' });
  await prisma.style.update({ where: { id: style.id }, data: { showcaseOnly: true } });
  await assert.rejects(assertStyleAccess(user.id, { templateUrl: 'https://example.com/protected.html' }));
  console.log('PASS paid-style and showcase authorization');

  const hash = tag.replaceAll('-', '').repeat(2);
  await prisma.paymentLedger.create({ data: { txHash: hash, userId: user.id, kind: 'subscription' } });
  await assert.rejects(prisma.paymentLedger.create({ data: { txHash: hash, userId: user.id, kind: 'style' } }));
  console.log('PASS cross-product TON replay constraint');

  // Exercise the real authenticated HTTP checkout and transaction boundary.
  globalThis.fetch = originalFetch;
  env.TON_RECEIVING_WALLET = '0:' + 'a'.repeat(64); env.TONCENTER_API_KEY = 'test';
  const verification = require('../dist/lib/tonVerification.js');
  let verifiedHash = 'b'.repeat(64);
  verification.verifyTonDeposit = async () => ({ ok: true, txHash: verifiedHash });
  const express = require('express'); const app = express();
  app.use(express.json()); app.use('/payments', require('../dist/routes/payments.js').default);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  httpServer = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(user.telegramId), first_name: 'Audit' }) });
  const secret = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].map(([k, v]) => `${k}=${v}`).sort().join('\n')).digest('hex'));
  const request = (route, body = {}) => fetch(`http://127.0.0.1:${httpServer.address().port}/payments${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: params.toString(), ...body }) });
  assert.equal((await request('/stars/create-invoice')).status, 410);
  const orderResponse = await request('/ton/orders', { kind: 'subscription', productId: 'CREATOR', amountTon: 0.001 });
  assert.equal(orderResponse.status, 200); const order = await orderResponse.json();
  assert.equal(order.amountNano, '40000000000');
  const [first, second] = await Promise.all([request(`/ton/orders/${order.orderId}/verify`, { senderWallet: 'test' }), request(`/ton/orders/${order.orderId}/verify`, { senderWallet: 'test' })]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(await prisma.paymentLedger.count({ where: { orderId: order.orderId } }), 1);
  assert.equal((await prisma.subscription.findUnique({ where: { userId: user.id } })).tier, 'CREATOR');
  await prisma.stylePurchase.deleteMany({ where: { userId: user.id, styleId: style.id } });
  await prisma.style.update({ where: { id: style.id }, data: { showcaseOnly: false } });
  const styleOrder = await (await request('/ton/orders', { kind: 'style', productId: style.id })).json();
  assert.equal((await request(`/ton/orders/${styleOrder.orderId}/verify`, { senderWallet: 'test' })).status, 409);
  assert.equal((await prisma.paymentOrder.findUnique({ where: { id: styleOrder.orderId } })).paidAt, null);
  verifiedHash = 'c'.repeat(64);
  assert.equal((await request(`/ton/orders/${styleOrder.orderId}/verify`, { senderWallet: 'test' })).status, 200);
  assert.equal(await prisma.stylePurchase.count({ where: { userId: user.id, styleId: style.id } }), 1);
  console.log('PASS authenticated TON orders, server pricing, concurrent grant, replay rollback, style purchase and disabled Stars');
} finally {
  globalThis.fetch = originalFetch;
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  if (style) await prisma.style.delete({ where: { id: style.id } });
  if (user) {
    await prisma.publicationRecord.deleteMany({ where: { userId: user.id } });
    await prisma.paymentLedger.deleteMany({ where: { userId: user.id } });
    await prisma.paymentOrder.deleteMany({ where: { userId: user.id } });
    await prisma.storedAsset.deleteMany({ where: { ownerUserId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  if (stranger) await prisma.user.delete({ where: { id: stranger.id } });
  await prisma.$disconnect();
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'publium-audit-')) throw new Error('Unsafe cleanup path');
  await fs.rm(temp, { recursive: true, force: true });
}
