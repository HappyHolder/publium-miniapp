import test from 'node:test';
import assert from 'node:assert/strict';
import { AXIS_KEYS, DAY, PULSE_SCALES, calculatePulseWindow, combinePulse, isPulseDayObserved, pulseDays, pulseDeltaContributions, pulseKey, pulseStart, scalePulse, shiftPulseDay, summarizePulse, type PulseAxes, type PulseScoringInput } from './pulseScoring';

function fixture(): PulseScoringInput {
  const days = pulseDays('2026-08-01', '2026-10-10');
  let id = 0;
  const messages = days.flatMap(day => Array.from({ length: 16 }, (_, user) => ({
    telegramMessageId: ++id, tgUserId: String(user + 1), sentAt: new Date(pulseStart(day) + (user + 1) * 3_600_000),
    isReply: true, replyToMessageId: null, replyToUserId: String(user % 2 ? user : user + 2), replyToBot: false,
  })));
  return { from: '2026-09-11', to: '2026-10-10', messages, memberships: [], excludedIds: [],
    coverage: days.map(day => ({ day, firstAt: new Date(pulseStart(day)), lastAt: new Date(pulseStart(day) + DAY), maxGapMs: 30 * 60_000, healthy: true, membership: true })),
    snapshots: days.map(day => ({ day, memberCount: 1000 })),
    assessments: [{ analysisKey: 'all', assessedAt: new Date('2026-10-11'), messageIds: messages.map(m => m.telegramMessageId), evidenceIds: [], targetIds: [], categories: ['conflict', 'toxicity', 'harassment', 'threat'], category: 'none', severity: 'low', confidence: 1 }],
  };
}
test('MSK date boundaries do not depend on the host timezone', () => {
  assert.equal(pulseKey(Date.parse('2026-10-10T21:00:00Z')), '2026-10-11');
  assert.equal(shiftPulseDay('2026-03-01', -1), '2026-02-28');
});
test('all normalization anchors match the versioned model', () => {
  for (const name of Object.keys(PULSE_SCALES) as (keyof typeof PULSE_SCALES)[]) for (const [x, y] of PULSE_SCALES[name]) assert.equal(scalePulse(name, x!), y);
});
test('weak axis cannot be hidden by four perfect axes', () => {
  assert.equal(Math.round(combinePulse([22, 100, 98, 100, 100])!), 65);
  assert.equal(combinePulse([60, 60, 60, 60, 60]), 60);
  assert.equal(combinePulse([0, 0, 0, 0, 0]), 0);
});
test('unknown axes stay unknown, with a bounded preliminary total', () => {
  const r = summarizePulse({ activity: 70, engagement: 75, climate: null, growth: 72, core: 80 });
  assert.equal(r.status, 'preliminary'); assert.equal(r.availableAxes.length, 4);
  assert.ok(r.bounds[0]! < r.score! && r.bounds[1]! > r.score!);
  assert.equal(summarizePulse({ activity: null, engagement: 80, climate: 90, growth: 80, core: 80 }).score, null);
});
test('nonlinear delta contributions exactly reconcile', () => {
  const old: PulseAxes = { activity: 20, engagement: 40, climate: 100, growth: 50, core: 80 };
  const cur: PulseAxes = { activity: 50, engagement: 70, climate: 80, growth: 40, core: 90 };
  const sum = Object.values(pulseDeltaContributions(old, cur)).reduce((a,b) => a+b, 0);
  const delta = combinePulse(AXIS_KEYS.map(k => cur[k]!))! - combinePulse(AXIS_KEYS.map(k => old[k]!))!;
  assert.ok(Math.abs(sum - delta) < 1e-9);
});
test('healthy fixture produces all five axes; no newcomers means neutral growth, not 100', () => {
  const r = calculatePulseWindow(fixture());
  assert.equal(r.status, 'complete'); assert.equal(r.axes.growth, 50); assert.equal(r.axes.climate, 100);
  assert.equal(r.details.engagement.metrics[2]!.value, 100);
});
test('a quiet observed day remains in the daily denominator', () => {
  const input = fixture(); input.messages = input.messages.filter(m => pulseKey(+m.sentAt) !== input.to);
  const r = calculatePulseWindow(input), metric = r.details.activity.metrics[0]!;
  assert.equal(metric.denominator, 30_000); assert.equal(metric.numerator, 29 * 16);
});
test('unknown day does not become zero; all axes share the same suffix', () => {
  const input = fixture(); input.coverage = input.coverage.filter(d => d.day !== '2026-09-30');
  const r = calculatePulseWindow(input);
  assert.equal(r.scoredFrom, '2026-10-01'); assert.equal(r.scoredDays, 10); assert.notEqual(r.status, 'complete');
});
test('unobserved latest day cannot select convenient earlier active days', () => {
  const input = fixture(); input.coverage = input.coverage.filter(d => d.day !== input.to);
  assert.equal(calculatePulseWindow(input).score, null);
});
test('heartbeat outages and missing membership subscription remain distinguishable', () => {
  const day = fixture().coverage[0]!;
  assert.equal(isPulseDayObserved({ ...day, maxGapMs: 46 * 60_000 }), false);
  assert.equal(isPulseDayObserved({ ...day, membership: false }), true);
  assert.equal(isPulseDayObserved({ ...day, membership: false }, true), false);
});
test('no daily population snapshot means unavailable activity, not latest-count substitution', () => {
  const input = fixture(); input.snapshots = input.snapshots.filter(s => s.day !== input.from);
  assert.equal(calculatePulseWindow(input).axes.activity, null);
});
test('self replies and bot replies are not human dialogue', () => {
  const input = fixture(); input.messages = input.messages.map((m,i) => ({ ...m, replyToUserId: m.tgUserId, replyToBot: i % 2 === 0 }));
  assert.equal(calculatePulseWindow(input).axes.engagement, 0);
});
test('boolean replies without recipient metadata cannot create a dialogue score', () => {
  const input = fixture(); input.messages = input.messages.map(m => ({ ...m, replyToUserId: null }));
  assert.equal(calculatePulseWindow(input).axes.engagement, null);
});
test('personas are excluded from author-days and reply graph', () => {
  const input = fixture(); input.excludedIds = ['1', '2'];
  assert.equal(calculatePulseWindow(input).details.activity.metrics[0]!.numerator, 30 * 14);
});
test('disabled analysis is not excellent climate', () => {
  const input = fixture(); input.assessments = [];
  assert.equal(calculatePulseWindow(input).axes.climate, null);
});
test('incomplete analysis categories cannot certify climate', () => {
  const input = fixture(); input.assessments[0]!.categories = ['toxicity'];
  assert.equal(calculatePulseWindow(input).axes.climate, null);
});
test('repeated harm evidence takes maximum severity and targets stay unique', () => {
  const input = fixture(); const message = input.messages.find(m => pulseKey(+m.sentAt) === input.from)!;
  const event = { ...input.assessments[0]!, category: 'harassment', severity: 'high', evidenceIds: [message.telegramMessageId], targetIds: ['2'] };
  input.assessments.push(event, { ...event, analysisKey: 'duplicate' });
  const metrics = calculatePulseWindow(input).details.climate.metrics;
  assert.equal(metrics[1]!.numerator, 1); assert.equal(metrics[2]!.numerator, 1);
});
test('false-positive feedback removes that assessment, not unrelated evidence', () => {
  const input = fixture(); const message = input.messages.find(m => pulseKey(+m.sentAt) === input.from)!;
  input.assessments.push({ ...input.assessments[0]!, analysisKey: 'bad', category: 'threat', severity: 'high', evidenceIds: [message.telegramMessageId], targetIds: ['2'] });
  input.invalidAnalysisKeys = ['bad'];
  assert.equal(calculatePulseWindow(input).axes.climate, 100);
});
test('known empty conversation yields zero activity, engagement and core; climate unavailable', () => {
  const input = fixture(); input.messages = [];
  const r = calculatePulseWindow(input);
  assert.equal(r.axes.activity, 0); assert.equal(r.axes.engagement, 0); assert.equal(r.axes.core, 0); assert.equal(r.axes.climate, null);
});
test('cohort numerator uses exact post-join time, same people and mature 14-day window', () => {
  const input = fixture(); const join = new Date(pulseStart('2026-09-20') + 12 * 3_600_000);
  input.memberships = [{ tgUserId: 'new', kind: 'join', occurredAt: join, firstJoin: true, source: 'chat_member' }];
  const template = input.messages[0]!;
  input.messages.push({ ...template, telegramMessageId: 10001, tgUserId: 'new', sentAt: new Date(+join - 1) });
  assert.deepEqual(calculatePulseWindow(input).newcomer, { size: 1, activated: 0, returned: 0 });
  input.messages.push({ ...template, telegramMessageId: 10002, tgUserId: 'new', sentAt: new Date(+join + 1) }, { ...template, telegramMessageId: 10003, tgUserId: 'new', sentAt: new Date(+join + 7 * DAY) });
  const r = calculatePulseWindow(input);
  assert.deepEqual(r.newcomer, { size: 1, activated: 1, returned: 1 });
  assert.equal(r.status, 'preliminary');
  assert.equal(r.details.growth.metrics[1]!.value, 100);
});
test('immature and known repeat joins do not enter newcomer conversion', () => {
  const input = fixture(); input.memberships = [
    { tgUserId: '1', kind: 'join', occurredAt: new Date(pulseStart('2026-10-05')), firstJoin: true, source: 'chat_member' },
    { tgUserId: '2', kind: 'join', occurredAt: new Date(pulseStart('2026-09-20')), firstJoin: false, source: 'chat_member' },
  ];
  assert.equal(calculatePulseWindow(input).newcomer!.size, 0);
});
test('missing membership observation cannot report zero outflow or perfect growth', () => {
  const input = fixture(); input.coverage = input.coverage.map(d => ({ ...d, membership: false }));
  assert.equal(calculatePulseWindow(input).axes.growth, null);
});
test('unknown targets of a directed violation cannot certify climate', () => {
  const input = fixture(); const m = input.messages.find(m => pulseKey(+m.sentAt) === input.from)!;
  input.assessments.push({ ...input.assessments[0]!, analysisKey: 'directed', category: 'harassment', evidenceIds: [m.telegramMessageId], targetIds: [] });
  assert.equal(calculatePulseWindow(input).axes.climate, null);
});
test('a partially observed first or last day is not a full day', () => {
  const row = fixture().coverage[0]!;
  assert.equal(isPulseDayObserved({ ...row, firstAt: new Date(+row.firstAt + 1000) }), false);
  assert.equal(isPulseDayObserved({ ...row, lastAt: new Date(+row.lastAt - 1000) }), false);
});
