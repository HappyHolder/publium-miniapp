import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../db';
import { pulseMembershipPresent, recordPulseMessage, recordPulseMembership } from './communityPulse';

test('membership transitions distinguish restriction from leaving', () => {
  assert.equal(pulseMembershipPresent({ status: 'restricted', is_member: true }), true);
  assert.equal(pulseMembershipPresent({ status: 'restricted', is_member: false }), false);
  for (const status of ['left', 'kicked']) assert.equal(pulseMembershipPresent({ status }), false);
  for (const status of ['member', 'administrator', 'creator']) assert.equal(pulseMembershipPresent({ status }), true);
});

test('message claim and facts share a transaction, retries survive failure and late observers enrich recipients', async t => {
  let rows: Record<string, unknown>[] = [], counters = 0, fail = true, locks = 0;
  const original = prisma.$transaction;
  const transaction = async (fn: (tx: unknown) => Promise<void>) => {
    const before = structuredClone(rows), oldCounters = counters;
    const tx = {
      $executeRaw: async () => { locks++; },
      persona: { findFirst: async () => null },
      pulseMessage: {
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => { if (rows.some(r => r['telegramMessageId'] === data[0]!['telegramMessageId'])) return { count: 0 }; rows.push(data[0]!); return { count: 1 }; },
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(rows[0]!, data); },
      },
      pulseMessageClaim: { findUnique: async () => null },
      communityDailyParticipant: { findFirst: async () => null, upsert: async () => { if (fail) throw new Error('counter write failed'); counters++; } },
      communityDailyStat: { findUnique: async () => null, upsert: async () => undefined },
    };
    try { await fn(tx); } catch (e) { rows = before; counters = oldCounters; throw e; }
  };
  prisma.$transaction = transaction as typeof prisma.$transaction;
  t.after(() => { prisma.$transaction = original; });
  const input = { communityId: 'fixture', tgUserId: '1', telegramMessageId: 12, isReply: true, at: new Date(Date.now() - 7 * 3_600_000) };
  await assert.rejects(recordPulseMessage(input), /counter write failed/);
  assert.equal(rows.length, 0); assert.equal(counters, 0);
  fail = false;
  await recordPulseMessage(input);
  await recordPulseMessage({ ...input, replyToUserId: '2', source: 'manager' });
  assert.equal(counters, 1); assert.equal(rows.length, 1); assert.equal(rows[0]!['replyToUserId'], '2'); assert.equal(locks, 3);
});

test('service and chat_member duplicates merge, but a fast real rejoin survives', async t => {
  type Membership = { tgUserId: string; kind: string; occurredAt: Date; source: string; firstJoin: boolean };
  const rows: Membership[] = []; let increments = 0;
  const original = prisma.$transaction;
  prisma.$transaction = (async (fn: (tx: unknown) => Promise<void>) => fn({
    $executeRaw: async () => undefined,
    pulseMembership: {
      findFirst: async ({ where }: { where: { kind?: string; occurredAt?: { gt?: Date; lt?: Date; gte?: Date; lte?: Date } } }) => rows.find(r => (!where.kind || r.kind === where.kind) && (!where.occurredAt?.gt || +r.occurredAt > +where.occurredAt.gt) && (!where.occurredAt?.lt || +r.occurredAt < +where.occurredAt.lt) && (!where.occurredAt?.gte || +r.occurredAt >= +where.occurredAt.gte) && (!where.occurredAt?.lte || +r.occurredAt <= +where.occurredAt.lte)) ?? null,
      create: async ({ data }: { data: Membership }) => { rows.push(data); },
    },
    communityMember: { findUnique: async () => null },
    communityDailyStat: { upsert: async () => { increments++; } },
  })) as typeof prisma.$transaction;
  t.after(() => { prisma.$transaction = original; });
  const at = new Date();
  await recordPulseMembership('fixture', 'join', '1', at, 'service');
  await recordPulseMembership('fixture', 'join', '1', at, 'chat_member');
  await recordPulseMembership('fixture', 'leave', '1', new Date(+at + 1000), 'chat_member');
  await recordPulseMembership('fixture', 'join', '1', new Date(+at + 2000), 'chat_member');
  assert.equal(rows.length, 3); assert.equal(increments, 3);
  assert.equal(rows[0]!.firstJoin, true); assert.equal(rows[2]!.firstJoin, false);
});
