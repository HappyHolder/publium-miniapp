import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { prisma } from '../db';
import { computePulse } from './communityPulseMetricsV2';
import { DAY, pulseDays, pulseKey, pulseStart } from './pulseScoring';

test('report integrates score, full-day calendar, author universe and unknown history', async t => {
  const days = pulseDays('2026-07-01', '2026-10-10');
  let id = 0;
  const messages = days.flatMap(day => Array.from({ length: 16 }, (_, n) => ({
    telegramMessageId: ++id, tgUserId: String(n + 1), sentAt: new Date(pulseStart(day) + (n + 1) * 3_600_000),
    isReply: true, replyToMessageId: null, replyToUserId: String(n % 2 ? n : n + 2), replyToBot: false, actorKind: n === 1 ? 'PERSONA' : 'HUMAN',
  })));
  const facts = messages.filter(m => +m.sentAt >= pulseStart('2026-09-11')).map(m => ({ tgUserId: m.tgUserId, day: pulseKey(+m.sentAt), messages: 1, replies: 1, estimated: false }));
  const coverage = days.map(day => ({ day, firstAt: new Date(pulseStart(day)), lastAt: new Date(pulseStart(day) + DAY), maxGapMs: 0, healthy: true, membership: true }));
  const delegates: [object, unknown[]][] = [
    [prisma.communityDailyParticipant, facts], [prisma.communityDailyStat, days.map(day => ({ day, memberCount: 1000 }))],
    [prisma.pulseMessage, messages], [prisma.pulseMembership, []], [prisma.pulseCoverage, coverage],
    [prisma.pulseAssessment, [{ analysisKey: 'all', assessedAt: new Date('2026-10-11'), messageIds: messages.map(m => m.telegramMessageId), evidenceIds: [], targetIds: [], categories: ['conflict','toxicity','harassment','threat'], category: 'none', severity: 'low', confidence: 1 }]],
    [prisma.persona, [{tgUserId:'1'}]], [prisma.moderationEvent, []], [prisma.communityMember, []], [prisma.communityPulseParticipant, []],
    [prisma.moderatorParticipantRisk, []], [prisma.pulseModerationRecord, []],
  ];
  for (const [delegate, rows] of delegates) {
    const target = delegate as { findMany: (...args: unknown[]) => unknown };
    const original = target.findMany;
    target.findMany = async () => rows;
    t.after(() => { target.findMany = original; });
  }
  const report = await computePulse('test', 30, new Date('2026-10-11T12:00:00+03:00'));
  assert.equal(report.period.from, '2026-09-11'); assert.equal(report.period.to, '2026-10-10');
  assert.equal(report.headline.mau, 16); assert.equal(report.headline.dau, 16); assert.equal(report.headline.messages, 480);
  assert.match(report.model.population, /60 из 480 сообщений/);
  assert.equal(report.orbit.reduce((n, x) => n + x.count, 0), 16);
  assert.equal(report.orbit.find(x => x.tier === 'Разово')!.count, 0);
  assert.equal(report.model.status, 'complete'); assert.equal(typeof report.score, 'number');
  assert.equal(report.scoreDelta, 0); assert.equal(report.quality.unknownTenure, 1000);
  assert.ok(report.series.every(s => s.observed && s.messages === 16));
  if (process.env['PULSE_FIXTURE_OUTPUT']) writeFileSync(process.env['PULSE_FIXTURE_OUTPUT'], JSON.stringify(report, null, 2));
  coverage.length = 0;
  const legacy = await computePulse('test', 30, new Date('2026-10-11T12:00:00+03:00'));
  assert.equal(legacy.score, null); assert.equal(legacy.scoreDelta, null);
  assert.equal(legacy.headline.messages, 480); assert.equal(legacy.headline.dau, null);
  assert.equal(legacy.headline.speakerConversion, null); assert.equal(legacy.headline.netGrowth, null);
  assert.equal(legacy.quality.legacy, true);
});
