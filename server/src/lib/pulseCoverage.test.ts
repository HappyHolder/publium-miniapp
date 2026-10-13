import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../db';
import { observePulseCoverage } from './pulseCoverage';
import { isPulseDayObserved, pulseStart, DAY, type PulseCoverageFact } from './pulseScoring';

test('heartbeat closes a day once, separates the connection day and detects an outage', async t => {
  const rows = new Map<string, PulseCoverageFact>();
  const transaction = prisma.$transaction, fetchOriginal = globalThis.fetch;
  let webhookSubscribed = true;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const result = url.includes('getWebhookInfo') ? { url: 'https://example.test/api/moderator/webhook', pending_update_count: 0, allowed_updates: webhookSubscribed ? ['message', 'chat_member'] : ['message'] } : { status: 'administrator', user: { id: 1, is_bot: true } };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  prisma.$transaction = (async (fn: (tx: unknown) => Promise<void>) => fn({
    $executeRaw: async () => undefined,
    pulseCoverage: {
      findUnique: async ({ where }: { where: { communityId_day: { day: string } } }) => rows.get(where.communityId_day.day) ?? null,
      upsert: async ({ where, create, update }: { where: { communityId_day: { day: string } }; create: PulseCoverageFact; update: Partial<PulseCoverageFact> }) => {
        const key = where.communityId_day.day, previous = rows.get(key);
        rows.set(key, previous ? { ...previous, ...update } : { ...create, maxGapMs: create.maxGapMs ?? 0 });
      },
    },
  })) as typeof prisma.$transaction;
  t.after(() => { prisma.$transaction = transaction; globalThis.fetch = fetchOriginal; });
  const start = pulseStart('2026-10-01');
  // Connected at noon: that first day is incomplete. The next day is observed in full.
  for (let at = start + DAY / 2; at <= start + 2 * DAY + DAY / 2; at += 30 * 60_000) await observePulseCoverage('c', '-1001', ['1:fixture'], new Date(at));
  assert.equal(isPulseDayObserved(rows.get('2026-10-01')), false);
  assert.equal(isPulseDayObserved(rows.get('2026-10-02')), true);
  assert.equal(rows.get('2026-10-02')!.maxGapMs, 30 * 60_000, 'later checks must not reopen yesterday and inflate its gap');
  await observePulseCoverage('c', '-1001', ['1:fixture'], new Date(start + 2 * DAY + 15 * 3_600_000));
  assert.ok(rows.get('2026-10-03')!.maxGapMs > 45 * 60_000);
  webhookSubscribed = false;
  await observePulseCoverage('c', '-1001', ['1:fixture'], new Date(start + 2 * DAY + 15.5 * 3_600_000));
  assert.equal(rows.get('2026-10-03')!.membership, false);
});
