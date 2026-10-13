import { prisma } from '../db';
import { pulseDayKey } from './communityPulse';
import { archivePulseModeration, summarizePulseModeration, type PulseModerationFacts } from './pulseModeration';
import { DAY, calculatePulseWindow, isPulseDayObserved, pulseDays, pulseDeltaContributions, pulseKey, pulseStart, roundPulse, shiftPulseDay } from './pulseScoring';

// Kept in the endpoint envelope for older clients; there are no universal norms.
export const PULSE_BENCHMARKS = {};
const pct = (n: number, d: number) => d > 0 ? roundPulse(100 * n / d) : null;
const weekKey = (day: string) => shiftPulseDay(day, -((new Date(pulseStart(day) + 12 * 3_600_000).getUTCDay() + 6) % 7));

export async function computePulse(communityId: string, days = 30, now = new Date()) {
  if (![7, 30, 90, 365].includes(days)) throw new Error('Unsupported Pulse period');
  // Comparable full Moscow days. Today's partial traffic never depresses a score.
  const to = shiftPulseDay(pulseDayKey(now), -1), from = shiftPulseDay(to, 1 - days);
  const prevTo = shiftPulseDay(from, -1), prevFrom = shiftPulseDay(from, -days);
  const lookback = shiftPulseDay(prevFrom, -27), startAt = new Date(pulseStart(lookback));
  const endAt = new Date(pulseStart(to) + DAY);
  const [facts, stats, messages, memberships, coverage, assessments, personas, events, memberRows, identities, riskRows] = await Promise.all([
    prisma.communityDailyParticipant.findMany({ where: { communityId, day: { gte: from, lte: to } } }),
    prisma.communityDailyStat.findMany({ where: { communityId, day: { gte: lookback } }, orderBy: { day: 'asc' } }),
    prisma.pulseMessage.findMany({ where: { communityId, sentAt: { gte: startAt, lt: endAt } } }),
    prisma.pulseMembership.findMany({ where: { communityId, occurredAt: { gte: startAt, lt: endAt } }, orderBy: { occurredAt: 'asc' } }),
    prisma.pulseCoverage.findMany({ where: { communityId, day: { gte: lookback, lte: to } } }),
    prisma.pulseAssessment.findMany({ where: { communityId, assessedAt: { gte: startAt } } }),
    prisma.persona.findMany({ where: { communityId }, select: { tgUserId: true } }),
    prisma.moderationEvent.findMany({ where: { communityId, createdAt: { gte: startAt } } }),
    prisma.communityMember.findMany({ where: { communityId, joinedAt: { not: null } }, select: { tgUserId: true, joinedAt: true, status: true } }),
    prisma.communityPulseParticipant.findMany({ where: { communityId }, select: { tgUserId: true, username: true, displayName: true } }),
    prisma.moderatorParticipantRisk.findMany({ where: { communityId, expiresAt: { gt: now } }, select: { tgUserId: true, score: true, evidenceCount: true, lastEventAt: true, events: { orderBy: { createdAt: 'desc' }, take: 3, select: { category: true, severity: true, evidence: true, createdAt: true } } } }),
  ]);
  await archivePulseModeration(events);
  const archived = await prisma.pulseModerationRecord.findMany({ where: { communityId, occurredAt: { gte: startAt } } });
  const invalidAnalysisKeys = archived.flatMap(e => { const f = e.facts as unknown as PulseModerationFacts; return f.invalid ? [f.analysisKey] : []; });
  const excludedIds = [...new Set([...personas.flatMap(p => p.tgUserId ? [p.tgUserId] : []), ...messages.filter(m => m.actorKind === 'PERSONA').map(m => m.tgUserId)])], excluded = new Set(excludedIds);
  const common = { messages, memberships, coverage, snapshots: stats, assessments, excludedIds, invalidAnalysisKeys };
  const model = calculatePulseWindow({ ...common, from, to });
  const previous = calculatePulseWindow({ ...common, from: prevFrom, to: prevTo });
  const comparable = model.status === 'complete' && previous.status === 'complete';
  const scoreDelta = comparable ? roundPulse(model.rawScore! - previous.rawScore!) : null;
  const deltaContributions = comparable ? pulseDeltaContributions(previous.axes, model.axes) : null;
  const scoreSeries: { day: string; value: number | null }[] = [];
  const step = Math.max(1, Math.ceil(days / 12));
  for (let offset = days - 1; offset >= 0; offset -= step) {
    const end = shiftPulseDay(to, -offset);
    const point = calculatePulseWindow({ ...common, from: shiftPulseDay(end, 1 - days), to: end });
    scoreSeries.push({ day: end, value: point.status === 'complete' ? point.score : null });
  }
  if (scoreSeries[scoreSeries.length - 1]?.day !== to) scoreSeries.push({ day: to, value: model.status === 'complete' ? model.score : null });

  const coverageByDay = new Map(coverage.map(c => [c.day, c]));
  const humanFacts = facts.filter(f => !excluded.has(f.tgUserId));
  const perUser = new Map<string, { tgUserId: string; messages: number; activeDays: number }>();
  for (const f of humanFacts) {
    const u = perUser.get(f.tgUserId) ?? { tgUserId: f.tgUserId, messages: 0, activeDays: 0 };
    u.messages += f.messages; u.activeDays++; perUser.set(f.tgUserId, u);
  }
  const users = [...perUser.values()].sort((a, b) => b.messages - a.messages);
  const totalMessages = users.reduce((s, u) => s + u.messages, 0), totalAuthorDays = users.reduce((s, u) => s + u.activeDays, 0);
  const fullObserved = pulseDays(from, to).every(d => isPulseDayObserved(coverageByDay.get(d)));
  const latestSnapshot = [...stats].reverse().find(s => s.memberCount != null);
  const memberCount = latestSnapshot?.memberCount ?? null;
  const dau = fullObserved ? totalAuthorDays / days : null;
  const curMessages = messages.filter(m => !excluded.has(m.tgUserId) && +m.sentAt >= pulseStart(from));
  const curMemberships = memberships.filter(m => !excluded.has(m.tgUserId) && +m.occurredAt >= pulseStart(from));
  const membershipComplete = pulseDays(from, to).every(d => isPulseDayObserved(coverageByDay.get(d), true));
  const byDay = new Map(stats.map(s => [s.day, s]));
  const series = pulseDays(from, to).map(day => {
    const rows = humanFacts.filter(f => f.day === day), observed = isPulseDayObserved(coverageByDay.get(day));
    const transitions = curMemberships.filter(m => pulseKey(+m.occurredAt) === day);
    const memberObserved = isPulseDayObserved(coverageByDay.get(day), true);
    const legacy = byDay.get(day);
    return { day, observed, messages: rows.length || observed ? rows.reduce((s, f) => s + f.messages, 0) : null,
      activeUsers: rows.length || observed ? rows.length : null,
      joins: memberObserved ? transitions.filter(m => m.kind === 'join').length : (legacy?.joins ?? 0) > 0 ? legacy!.joins : transitions.some(m => m.kind === 'join') ? transitions.filter(m => m.kind === 'join').length : null,
      leaves: memberObserved ? transitions.filter(m => m.kind === 'leave').length : (legacy?.leaves ?? 0) > 0 ? legacy!.leaves : transitions.some(m => m.kind === 'leave') ? transitions.filter(m => m.kind === 'leave').length : null,
    };
  });
  const identityByUser = new Map(identities.map(p => [p.tgUserId, p]));
  const topParticipants = users.slice(0, 10).map(u => ({ ...u, username: identityByUser.get(u.tgUserId)?.username ?? null, displayName: identityByUser.get(u.tgUserId)?.displayName ?? null, share: pct(u.messages, totalMessages) ?? 0 }));
  const tiers = ['Регулярно', 'Часто', 'Эпизодически', 'Разово'];
  const tierCounts = [0, 0, 0, 0];
  for (const u of users) { const i = u.activeDays === 1 ? 3 : u.activeDays / days >= .5 ? 0 : u.activeDays / days >= .25 ? 1 : 2; tierCounts[i]++; }
  const orbit = tiers.map((tier, i) => ({ tier, count: tierCounts[i]!, share: pct(tierCounts[i]!, users.length) ?? 0 }));
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const m of curMessages) { const local = new Date(+m.sentAt + 3 * 3_600_000); const wd = (local.getUTCDay() + 6) % 7; heatmap[wd]![local.getUTCHours()]!++; }

  const cohortMap = new Map<string, typeof memberships>();
  const messagesByAuthor = new Map<string, typeof messages>();
  for (const m of messages) { if (!messagesByAuthor.has(m.tgUserId)) messagesByAuthor.set(m.tgUserId, []); messagesByAuthor.get(m.tgUserId)!.push(m); }
  for (const m of memberships.filter(m => m.firstJoin && !excluded.has(m.tgUserId) && +m.occurredAt >= pulseStart(from))) {
    const key = weekKey(pulseKey(+m.occurredAt)); cohortMap.set(key, [...(cohortMap.get(key) ?? []), m]);
  }
  const cohorts = [...cohortMap].sort(([a], [b]) => a.localeCompare(b)).map(([cohort, members]) => {
    const retention: (number | null)[] = [], counts: (number | null)[] = [];
    for (let w = 0; w < 8; w++) {
      const mature = members.every(m => +m.occurredAt + (w + 1) * 7 * DAY <= +endAt);
      if (!mature) { retention.push(null); counts.push(null); continue; }
      const seen = members.every(m => pulseDays(pulseKey(+m.occurredAt + w * 7 * DAY), pulseKey(+m.occurredAt + (w + 1) * 7 * DAY - 1)).every(d => isPulseDayObserved(coverageByDay.get(d))));
      if (!seen) { retention.push(null); counts.push(null); continue; }
      const active = members.filter(m => (messagesByAuthor.get(m.tgUserId) ?? []).some(x => +x.sentAt >= +m.occurredAt + w * 7 * DAY && +x.sentAt < +m.occurredAt + (w + 1) * 7 * DAY)).length;
      counts.push(active); retention.push(pct(active, members.length));
    }
    return { cohort, size: members.length, retention, counts };
  });
  const latestMembership = new Map(memberships.map(m => [m.tgUserId, m.kind]));
  const tenure = [{ bucket: '< 1 нед', count: 0 }, { bucket: '1–4 нед', count: 0 }, { bucket: '1–3 мес', count: 0 }, { bucket: '3–12 мес', count: 0 }, { bucket: '> года', count: 0 }];
  for (const m of memberRows) {
    if (!m.joinedAt || excluded.has(m.tgUserId) || ['BANNED', 'REMOVED', 'LEFT'].includes(m.status) || latestMembership.get(m.tgUserId) === 'leave') continue;
    const age = (+now - +m.joinedAt) / DAY;
    tenure[age < 7 ? 0 : age < 28 ? 1 : age < 90 ? 2 : age < 365 ? 3 : 4]!.count++;
  }
  const knownTenure = tenure.reduce((s, t) => s + t.count, 0);
  const temporaryRisks = riskRows.map(r => {
    const score = Math.round(r.score * Math.pow(.5, Math.max(0, +now - +r.lastEventAt) / DAY));
    const identity = identityByUser.get(r.tgUserId);
    return { tgUserId: r.tgUserId, label: identity?.username ? '@' + identity.username : identity?.displayName ?? 'ID ' + r.tgUserId,
      score, level: score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low', evidenceCount: r.evidenceCount,
      lastEventAt: r.lastEventAt.toISOString(), evidence: r.events.map(e => ({ category: e.category, severity: e.severity, text: e.evidence, at: e.createdAt.toISOString() })) };
  }).filter(r => r.score >= 3).sort((a, b) => b.score - a.score).slice(0, 10);
  const moderationRows = archived.filter(e => +e.occurredAt >= pulseStart(from) && +e.occurredAt < +endAt).map(e => ({ ...e, facts: e.facts as unknown as PulseModerationFacts }));
  const moderation = summarizePulseModeration(moderationRows);
  const observedDays = coverage.filter(c => c.day >= from && isPulseDayObserved(c)).length;
  const joins = curMemberships.filter(m => m.kind === 'join').length, leaves = curMemberships.filter(m => m.kind === 'leave').length;
  const activityMetric = model.details.activity.metrics[0], replyMetric = model.details.engagement.metrics[0];
  return {
    period: { from, to, days, daysWithData: new Set(humanFacts.map(f => f.day)).size, observedDays },
    score: model.score, scoreDelta, axes: model.axes, model: { ...model, deltaContributions,
      comparisonReason: comparable ? 'Предыдущий равный период, та же модель и все пять осей.' : 'Дельта появится при двух полных сопоставимых периодах с пятью оценёнными осями.',
      population: 'Текст и подписи людей; боты, сообщения от имени каналов и известные личности Ядра исключены.',
      coverageNote: 'Полнота проверяется каждые 30 минут по доступности webhook и правам бота. Это контроль сбора, а не гарантия доставки Telegram.',
    }, scoreSeries,
    headline: {
      memberCount, memberCountAt: latestSnapshot?.memberCountAt?.toISOString() ?? null, dau: dau == null ? null : roundPulse(dau), mau: users.length,
      stickiness: dau != null ? pct(dau, users.length) : null,
      activeRate: model.scoredDays === days ? activityMetric?.value == null ? null : roundPulse(activityMetric.value) : null,
      messages: totalMessages, messagesPerDay: fullObserved ? roundPulse(totalMessages / days) : null,
      replyShare: model.scoredDays === days ? replyMetric?.value == null ? null : roundPulse(replyMetric.value) : null,
      joins: series.some(s => s.joins != null) ? series.reduce((n, s) => n + (s.joins ?? 0), 0) : null,
      leaves: series.some(s => s.leaves != null) ? series.reduce((n, s) => n + (s.leaves ?? 0), 0) : null,
      netGrowth: membershipComplete ? joins - leaves : null, churnRate: null,
      newSpeakers: model.newcomer?.activated ?? null, speakerConversion: model.newcomer ? pct(model.newcomer.activated, model.newcomer.size) : null,
      newcomerCount: model.newcomer?.size ?? null, concentration: pct(users.slice(0, 3).reduce((s, u) => s + u.messages, 0), totalMessages),
    },
    quality: { fullObserved, membershipComplete, legacy: humanFacts.some(f => !coverageByDay.has(f.day)), estimatedFacts: humanFacts.filter(f => f.estimated).length,
      knownTenure, unknownTenure: memberCount == null ? null : Math.max(0, memberCount - knownTenure),
      moderationFrom: archived.length ? pulseKey(archived.reduce((n, e) => Math.min(n, +e.occurredAt), Infinity)) : null },
    moderation: { ...moderation, temporaryRisks }, series, heatmap, orbit, topParticipants, cohorts, tenure,
  };
}
export type PulseReport = Awaited<ReturnType<typeof computePulse>>;
