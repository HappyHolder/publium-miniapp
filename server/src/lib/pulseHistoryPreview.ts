import { combinePulse, meanPulse, pulseDays, scalePulse, shiftPulseDay, type PulseAxes } from './pulseScoring';

export type HistoryParticipantDay = { day: string; tgUserId: string; messages: number; replies: number; estimated: boolean };
export type HistoryStatDay = { day: string; messages: number; activeUsers: number; memberCount: number | null; joins: number; leaves: number; newSpeakers: number; toxicityWeight: number };
const sum = <T>(rows: T[], value: (row: T) => number) => rows.reduce((n, row) => n + value(row), 0);
const pct = (a: number, b: number) => b > 0 ? Math.round(a / b * 1000) / 10 : null;
const clamp = (n: number) => Math.max(0, Math.min(100, n));

/**
 * Read-only migration diagnostic. Daily history can recover the arithmetic of A/K,
 * but cannot retroactively prove collection completeness, peer replies or AI coverage.
 * This is deliberately NOT a replacement for the public report or a full v2 score.
 * No per-person data is returned. Callers keep source rows on the database host.
 */
export function previewPulseHistory(input: {
  from: string; to: string; facts: HistoryParticipantDay[]; stats: HistoryStatDay[];
  excludedIds?: string[];
}) {
  const { from, to } = input;
  const days = pulseDays(from, to), excluded = new Set(input.excludedIds ?? []);
  const allDaily = new Map<string, HistoryParticipantDay[]>();
  const stats = new Map(input.stats.map(s => [s.day, s]));
  const keys = new Set<string>();
  for (const f of input.facts) {
    if (!Number.isInteger(f.messages) || f.messages < 0 || !Number.isInteger(f.replies) || f.replies < 0 || f.replies > f.messages) throw Error('Invalid historical counter');
    const key = JSON.stringify([f.day, f.tgUserId]);
    if (keys.has(key)) throw Error('Duplicate historical participant-day');
    keys.add(key);
    if (!allDaily.has(f.day)) allDaily.set(f.day, []);
    allDaily.get(f.day)!.push(f);
  }
  const rows = (day: string) => (allDaily.get(day) ?? []).filter(f => !f.estimated && f.messages > 0 && !excluded.has(f.tgUserId));
  // A positive reconciled counter proves recorded activity, not complete observation.
  // Missing/empty legacy days must not silently become observed quiet days.
  const recorded = (day: string) => {
    const st = stats.get(day), fs = allDaily.get(day) ?? [];
    return !!st && st.messages > 0 && !fs.some(f => f.estimated) && sum(fs, f => f.messages) === st.messages;
  };
  const hasPopulation = (day: string) => Number.isFinite(stats.get(day)?.memberCount) && (stats.get(day)?.memberCount ?? 0) > 0;
  const unique = (fs: HistoryParticipantDay[]) => new Set(fs.map(f => f.tgUserId));
  const window = (end: string, startOffset: number, endOffset = 0) => pulseDays(shiftPulseDay(end, startOffset), shiftPulseDay(end, endOffset));
  const weekly = days.map(end => ({ end, days: window(end, -6) }));
  const missingRecordedDays = days.filter(d => !recorded(d));
  const missingPopulationDays = days.filter(d => !hasPopulation(d));
  const periodRows = days.flatMap(rows);
  const authorDays = sum(days, d => rows(d).length);
  const memberDays = missingPopulationDays.length ? null : sum(days, d => stats.get(d)!.memberCount!);
  let repeatNumerator = 0, repeatDenominator = 0, overlapping = 0, previousAuthors = 0;
  const breadthScores: number[] = [], effectiveAuthors: number[] = [];
  const missingWeeklyWindows: string[] = [], missingCoreWindows: string[] = [];
  for (const w of weekly) {
    if (!w.days.every(recorded)) missingWeeklyWindows.push(w.end);
    else {
      const fs = w.days.flatMap(rows), count = unique(fs).size;
      repeatNumerator += fs.length - count;
      repeatDenominator += count;
    }
    const priorDays = window(w.end, -13, -7);
    if (!w.days.every(recorded) || !priorDays.every(recorded) || !w.days.every(hasPopulation)) { missingCoreWindows.push(w.end); continue; }
    const fs = w.days.flatMap(rows), current = unique(fs), prior = unique(priorDays.flatMap(rows));
    previousAuthors += prior.size;
    overlapping += [...prior].filter(id => current.has(id)).length;
    const counts = new Map<string, number>();
    for (const f of fs) counts.set(f.tgUserId, (counts.get(f.tgUserId) ?? 0) + f.messages);
    const messages = sum(fs, f => f.messages);
    const effective = messages ? 1 / sum([...counts.values()], n => (n / messages) ** 2) : 0;
    const target = Math.min(20, Math.max(3, .02 * meanPulse(w.days.map(d => stats.get(d)!.memberCount!))));
    effectiveAuthors.push(effective);
    breadthScores.push(100 * Math.min(1, effective / target));
  }
  const activityReady = days.length >= 7 && !missingRecordedDays.length && !missingPopulationDays.length && !missingWeeklyWindows.length;
  const coreReady = days.length >= 7 && !missingCoreWindows.length;
  const participation = memberDays && !missingRecordedDays.length ? 100 * authorDays / memberDays : null;
  const repeat = !missingWeeklyWindows.length ? (repeatDenominator ? repeatNumerator / repeatDenominator : 0) : null;
  const returning = coreReady ? (previousAuthors ? 100 * overlapping / previousAuthors : 0) : null;
  const breadth = coreReady ? meanPulse(breadthScores) : null;
  const axes: PulseAxes = {
    activity: activityReady ? meanPulse([scalePulse('dailyParticipation', participation!), scalePulse('repeatDays7', repeat!)]) : null,
    engagement: null, climate: null, growth: null,
    core: coreReady ? meanPulse([breadth!, returning!]) : null,
  };

  // Reproduce the shipped legacy arithmetic over the EXACT SAME date window.
  const legacyRows = input.facts.filter(f => f.day >= from && f.day <= to);
  const legacyStats = input.stats.filter(s => s.day >= from && s.day <= to).sort((a,b) => a.day.localeCompare(b.day));
  const users = new Map<string, number>();
  for (const f of legacyRows) users.set(f.tgUserId, (users.get(f.tgUserId) ?? 0) + f.messages);
  const messages = sum(legacyRows, f => f.messages), replies = sum(legacyRows, f => f.replies);
  const activeDays = legacyStats.filter(s => s.messages > 0 || s.joins > 0 || s.leaves > 0).length;
  const dau = activeDays ? Math.round(sum(legacyStats, s => s.activeUsers) / activeDays * 10) / 10 : 0;
  const population = [...legacyStats].reverse().find(s => s.memberCount != null)?.memberCount ?? 0;
  const joins = sum(legacyStats, s => s.joins), leaves = sum(legacyStats, s => s.leaves), newSpeakers = sum(legacyStats, s => s.newSpeakers);
  const stickiness = pct(dau, users.size), activeRate = pct(dau, population), replyShare = pct(replies, messages), churn = pct(leaves, population), conversion = pct(newSpeakers, joins);
  const concentration = pct([...users.values()].sort((a,b) => b-a).slice(0,3).reduce((a,b) => a+b,0), messages);
  const up = (value: number | null, good: number) => value == null ? 0 : clamp(value / good * 100);
  const down = (value: number | null, good: number, ceiling: number) => value == null ? 0 : clamp(100 - (value - good) / (ceiling - good) * 100);
  const legacyAxes = {
    activity: Math.round(meanPulse([up(stickiness,40),up(activeRate,10)])), engagement: Math.round(up(replyShare,30)),
    climate: Math.round(messages ? clamp(100 - sum(legacyStats,s=>s.toxicityWeight) / messages * 120) : 100),
    growth: Math.round(meanPulse([down(churn,5,25),up(conversion,20)])), core: Math.round(down(concentration,40,90)),
  };
  return {
    version: 'pulse-history-audit-v1', period: { from, to, days: days.length },
    legacy: { score: Math.round(meanPulse(Object.values(legacyAxes))), axes: legacyAxes, metrics: { messages, authors:users.size, replies, dau, population, stickiness, activeRate, replyShare, joins, leaves, newSpeakers, conversion, concentration } },
    arithmeticOnlyExperiment: { score: Math.round(combinePulse(Object.values(legacyAxes))!), description: 'Only the combiner changes; legacy axis defects remain. Not a v2 score.' },
    historical: { score: null, axes, status: 'diagnostic-only', metrics: { messages:sum(periodRows,f=>f.messages), authors:unique(periodRows).size, authorDays, memberDays, participation, repeat, breadth, effectiveAuthors:coreReady?meanPulse(effectiveAuthors):null, returning, replyShare:pct(sum(periodRows,f=>f.replies),sum(periodRows,f=>f.messages)) },
      missingRecordedDays, missingPopulationDays, missingWeeklyWindows, missingCoreWindows,
      limitations: ['Historical collection completeness is unverified; daily population snapshots lack original capture provenance.', 'Boolean replies cannot recover peer dialogue, breadth or reciprocity.', 'Legacy harm counters do not identify assessed messages or their coverage.', 'Legacy joins/leaves do not establish complete membership tracking or exact newcomer cohorts.'],
    },
  };
}
