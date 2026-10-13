import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (!new URL(process.env.DATABASE_URL ?? '').pathname.startsWith('/publium_audit_')) throw new Error('Pulse integration requires an isolated publium_audit_* database');
const require = createRequire(import.meta.url);
const { prisma } = require('../dist/db.js');
const { recordPulseMessage, recordPulseMembership, pulseDayKey, rollupPulseDay } = require('../dist/lib/communityPulse.js');
const { computePulse } = require('../dist/lib/communityPulseMetrics.js');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network access in Pulse integration'); };
let community;
try {
  community = await prisma.community.create({ data: {} });
  const communityId = community.id, at = new Date(Date.now() - 86_400_000), day = pulseDayKey(at);
  const input = { communityId, tgUserId: '101', telegramMessageId: 1, isReply: true, at };
  await Promise.all(Array.from({ length: 8 }, () => recordPulseMessage(input)));
  await recordPulseMessage({ ...input, source: 'manager', replyToUserId: '102' });
  assert.equal(await prisma.pulseMessage.count({ where: { communityId } }), 1);
  assert.equal((await prisma.pulseMessage.findFirst({ where: { communityId } })).replyToUserId, '102');
  assert.equal((await prisma.communityDailyParticipant.findFirst({ where: { communityId } })).messages, 1);
  assert.equal((await prisma.communityDailyStat.findFirst({ where: { communityId } })).hourHistogram.reduce((a, b) => a + b, 0), 1);
  console.log('PASS PostgreSQL concurrent observers, one counter increment, late recipient enrichment');

  const transaction = prisma.$transaction.bind(prisma);
  prisma.$transaction = fn => transaction(tx => fn(new Proxy(tx, { get(target, key) {
    if (key !== 'communityDailyParticipant') return Reflect.get(target, key);
    return { ...target.communityDailyParticipant, upsert: async args => { await target.communityDailyParticipant.upsert(args); throw new Error('Injected failure after participant write'); } };
  } })));
  try { await assert.rejects(recordPulseMessage({ ...input, telegramMessageId: 2 }), /Injected failure/); }
  finally { prisma.$transaction = transaction; }
  assert.equal(await prisma.pulseMessage.count({ where: { communityId } }), 1);
  assert.equal((await prisma.communityDailyParticipant.findFirst({ where: { communityId } })).messages, 1);
  await recordPulseMessage({ ...input, telegramMessageId: 2 });
  assert.equal((await prisma.communityDailyParticipant.findFirst({ where: { communityId } })).messages, 2);
  console.log('PASS PostgreSQL rollback preserves retry after a failure inside the transaction');

  await Promise.all(['service', 'chat_member'].map(source => recordPulseMembership(communityId, 'join', '101', at, source)));
  await recordPulseMembership(communityId, 'leave', '101', new Date(+at + 1000), 'chat_member');
  await recordPulseMembership(communityId, 'join', '101', new Date(+at + 2000), 'chat_member');
  assert.equal(await prisma.pulseMembership.count({ where: { communityId } }), 3);
  assert.equal(await prisma.pulseMembership.count({ where: { communityId, firstJoin: true } }), 1);
  const stat = await prisma.communityDailyStat.findFirst({ where: { communityId } });
  assert.equal(stat.joins, 2); assert.equal(stat.leaves, 1);
  await rollupPulseDay(communityId, day);
  const report = await computePulse(communityId, 30);
  assert.equal(report.headline.messages, 2); assert.equal(report.score, null);
  assert.equal(report.model.status, 'insufficient');
  console.log('PASS PostgreSQL membership deduplication, real rejoin and report with unverified history');
} finally {
  if (community) await prisma.community.delete({ where: { id: community.id } });
  await prisma.$disconnect();
  globalThis.fetch = originalFetch;
}
