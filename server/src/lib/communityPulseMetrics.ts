/**
 * communityPulseMetrics.ts — computes the «Пульс» report for any period.
 *
 * Everything that is NOT additive (unique actives, DAU/MAU, Orbit tiers,
 * concentration, cohorts) is derived from the per-participant-day fact table,
 * never by summing daily numbers — that would count a person active 20 days as
 * 20 monthly actives. Additive counters (messages, joins, leaves, hour buckets)
 * come from the pre-aggregated day rows.
 *
 * Benchmarks come from established community analytics practice and are returned
 * with the numbers so the UI can say "42% — норма >40%" instead of a bare figure.
 */

import { prisma } from '../db';
import { pulseDayKey } from './communityPulse';

export interface PulseBenchmark { good: number; warn: number; unit: '%' | 'n' }

export interface PulseReport {
  period: { from: string; to: string; days: number; daysWithData: number };
  score: number;                 // 0–100 composite
  scoreDelta: number | null;     // vs the previous equal-length period
  axes: { activity: number; engagement: number; climate: number; growth: number; core: number };
  headline: {
    memberCount: number | null;
    dau: number; mau: number; stickiness: number | null;   // DAU/MAU %
    activeRate: number | null;                             // % of members active per day
    messages: number; messagesPerDay: number;
    replyShare: number | null;                             // % of messages that are replies
    joins: number; leaves: number; netGrowth: number; churnRate: number | null;
    newSpeakers: number; speakerConversion: number | null; // joined → actually wrote, %
    concentration: number | null;                          // top-3 share of messages, %
  };
  moderation: { blockedMessages:number; culturalRewrites:number; interventions:number; conflicts:number; harassment:number; affectedUsers:number; resolvedEpisodes:number; escalatedEpisodes:number; toxicityWeight:number; temporaryRisks:{tgUserId:string;score:number;level:string;evidenceCount:number;lastEventAt:string;evidence:{category:string;severity:string;text:string;at:string}[]}[] };
  series: { day: string; messages: number; activeUsers: number; joins: number; leaves: number }[];
  heatmap: number[][];           // [weekday 0=Mon..6=Sun][hour 0..23]
  orbit: { tier: string; count: number; share: number }[];
  topParticipants: { tgUserId: string; username: string | null; displayName: string | null; messages: number; activeDays: number; share: number }[];
  cohorts: { cohort: string; size: number; retention: number[] }[]; // % active in week 0..N
  tenure: { bucket: string; count: number }[];
}

/** Benchmarks the UI shows next to each number. */
export const PULSE_BENCHMARKS: Record<string, PulseBenchmark> = {
  stickiness:        { good: 40, warn: 20, unit: '%' },  // DAU/MAU
  activeRate:        { good: 10, warn: 2,  unit: '%' },  // daily active share; <2% = dead
  churnRate:         { good: 5,  warn: 10, unit: '%' },  // lower is better
  speakerConversion: { good: 20, warn: 10, unit: '%' },  // lurker → contributor
  replyShare:        { good: 30, warn: 15, unit: '%' },
};

const DAY_MS = 86_400_000;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
/** Scores a value against a benchmark on a 0–100 scale (higher value = better). */
const scoreUp = (value: number | null, good: number, floor = 0) =>
  value == null ? 0 : clamp(((value - floor) / (good - floor)) * 100);
/** Same, but lower value = better (churn, concentration). */
const scoreDown = (value: number | null, good: number, ceiling: number) =>
  value == null ? 0 : clamp(100 - ((value - good) / (ceiling - good)) * 100);

const dayKeysBetween = (from: Date, to: Date): string[] => {
  const days: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) days.push(pulseDayKey(new Date(t)));
  return days;
};
/** Monday-based weekday index for a 'YYYY-MM-DD' key. */
const weekdayOf = (day: string): number => {
  const js = new Date(`${day}T12:00:00+03:00`).getDay(); // 0=Sun
  return (js + 6) % 7; // 0=Mon
};
const weekKeyOf = (day: string): string => {
  const d = new Date(`${day}T12:00:00+03:00`);
  const monday = new Date(d.getTime() - weekdayOf(day) * DAY_MS);
  return pulseDayKey(monday);
};

/** Orbit-model tiers by share of the period's message volume. */
function orbitTiers(perUser: { tgUserId: string; messages: number }[]): { tier: string; count: number; share: number }[] {
  const total = perUser.length;
  if (!total) return [];
  const sorted = [...perUser].sort((a, b) => b.messages - a.messages);
  const cut = (from: number, to: number) => sorted.slice(Math.floor(total * from), Math.floor(total * to)).length;
  const tiers = [
    { tier: 'Ядро', count: Math.max(sorted.length ? 1 : 0, cut(0, 0.03)) },
    { tier: 'Активные', count: cut(0.03, 0.15) },
    { tier: 'Участники', count: cut(0.15, 0.40) },
    { tier: 'Наблюдатели', count: cut(0.40, 1) },
  ];
  return tiers.map(t => ({ ...t, share: Math.round((t.count / total) * 1000) / 10 }));
}

/** Aggregates one period into the numbers the report needs. */
async function periodAggregate(communityId: string, from: string, to: string) {
  const [perUser, stats] = await Promise.all([
    prisma.communityDailyParticipant.groupBy({
      by: ['tgUserId'],
      where: { communityId, day: { gte: from, lte: to } },
      _sum: { messages: true, replies: true },
      _count: { _all: true },
    }),
    prisma.communityDailyStat.findMany({
      where: { communityId, day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
    }),
  ]);
  const users = perUser.map(u => ({
    tgUserId: u.tgUserId,
    messages: u._sum.messages ?? 0,
    replies: u._sum.replies ?? 0,
    activeDays: u._count._all,
  }));
  const messages = users.reduce((n, u) => n + u.messages, 0);
  const replies = users.reduce((n, u) => n + u.replies, 0);
  const joins = stats.reduce((n, s) => n + s.joins, 0);
  const leaves = stats.reduce((n, s) => n + s.leaves, 0);
  const newSpeakers = stats.reduce((n, s) => n + s.newSpeakers, 0);
  const conflicts = stats.reduce((n, s) => n + s.conflictEvents, 0);
  const harassment = stats.reduce((n, s) => n + s.harassmentEvents, 0);
  const toxicityWeight = stats.reduce((n, s) => n + s.toxicityWeight, 0);
  const moderation = {
    blockedMessages:stats.reduce((n,s)=>n+s.blockedMsgs,0), culturalRewrites:stats.reduce((n,s)=>n+s.culturalRewrites,0),
    interventions:stats.reduce((n,s)=>n+s.interventions,0), conflicts, harassment,
    affectedUsers:stats.reduce((n,s)=>n+s.affectedUsers,0), resolvedEpisodes:stats.reduce((n,s)=>n+s.resolvedEpisodes,0),
    escalatedEpisodes:stats.reduce((n,s)=>n+s.escalatedEpisodes,0), toxicityWeight:Math.round(toxicityWeight*100)/100,
  };
  const daysWithData = stats.filter(s => s.messages > 0 || s.joins > 0 || s.leaves > 0).length;
  const activeSum = stats.reduce((n, s) => n + s.activeUsers, 0);
  const dau = daysWithData ? Math.round((activeSum / daysWithData) * 10) / 10 : 0;
  const memberCount = [...stats].reverse().find(s => s.memberCount != null)?.memberCount ?? null;
  return { users, stats, messages, replies, joins, leaves, newSpeakers, conflicts, toxicityWeight, moderation, daysWithData, dau, mau: users.length, memberCount };
}

/** Composite 0–100 score from the five axes. */
function compositeScore(axes: PulseReport['axes']): number {
  const { activity, engagement, climate, growth, core } = axes;
  return Math.round((activity + engagement + climate + growth + core) / 5);
}

/**
 * Builds the full report for the last `days` days (inclusive of today).
 * `days` = 30 / 90 / 365 gives month / quarter / year — all computed from the
 * same fact table, so the numbers are correct for any window.
 */
export async function computePulse(communityId: string, days = 30): Promise<PulseReport> {
  const now = new Date();
  const to = pulseDayKey(now);
  const from = pulseDayKey(new Date(now.getTime() - (days - 1) * DAY_MS));
  const prevTo = pulseDayKey(new Date(now.getTime() - days * DAY_MS));
  const prevFrom = pulseDayKey(new Date(now.getTime() - (days * 2 - 1) * DAY_MS));

  const cur = await periodAggregate(communityId, from, to);
  const riskRows = await prisma.moderatorParticipantRisk.findMany({ where:{communityId,expiresAt:{gt:now}}, orderBy:{score:'desc'}, take:10, select:{tgUserId:true,score:true,level:true,evidenceCount:true,lastEventAt:true,events:{orderBy:{createdAt:'desc'},take:3,select:{category:true,severity:true,evidence:true,createdAt:true}}} }).catch(()=>[]);
  const temporaryRisks = riskRows.flatMap(r=>{const score=Math.round(r.score*Math.pow(.5,Math.max(0,now.getTime()-r.lastEventAt.getTime())/DAY_MS));return score>=3?[{tgUserId:r.tgUserId,score,level:score>=60?'high':score>=25?'medium':'low',evidenceCount:r.evidenceCount,lastEventAt:r.lastEventAt.toISOString(),evidence:r.events.map(e=>({category:e.category,severity:e.severity,text:e.evidence,at:e.createdAt.toISOString()}))}]:[]});

  // ── Headline numbers ────────────────────────────────────────────────────────
  const stickiness = cur.mau > 0 ? Math.round((cur.dau / cur.mau) * 1000) / 10 : null;
  const activeRate = cur.memberCount ? Math.round((cur.dau / cur.memberCount) * 1000) / 10 : null;
  const replyShare = pct(cur.replies, cur.messages);
  const churnRate = cur.memberCount ? pct(cur.leaves, cur.memberCount) : null;
  const speakerConversion = pct(cur.newSpeakers, cur.joins);
  const sortedByMsg = [...cur.users].sort((a, b) => b.messages - a.messages);
  const top3 = sortedByMsg.slice(0, 3).reduce((n, u) => n + u.messages, 0);
  const concentration = pct(top3, cur.messages);

  // ── Axes (0–100) ────────────────────────────────────────────────────────────
  const axes = {
    activity: Math.round((scoreUp(stickiness, PULSE_BENCHMARKS['stickiness']!.good) + scoreUp(activeRate, PULSE_BENCHMARKS['activeRate']!.good)) / 2),
    engagement: Math.round(scoreUp(replyShare, PULSE_BENCHMARKS['replyShare']!.good)),
    // Climate includes deleted one-message violations and weighted episodes.
    climate: Math.round(cur.messages > 0 ? clamp(100 - (cur.toxicityWeight / cur.messages) * 120) : 100),
    growth: Math.round((scoreDown(churnRate, PULSE_BENCHMARKS['churnRate']!.good, 25) + scoreUp(speakerConversion, PULSE_BENCHMARKS['speakerConversion']!.good)) / 2),
    // Core health: less concentration = healthier (3 people carrying the chat is bad).
    core: Math.round(scoreDown(concentration, 40, 90)),
  };
  const score = compositeScore(axes);

  // Previous period → delta (only when the past window actually has data).
  let scoreDelta: number | null = null;
  const prev = await periodAggregate(communityId, prevFrom, prevTo);
  if (prev.daysWithData > 0) {
    const prevStickiness = prev.mau > 0 ? (prev.dau / prev.mau) * 100 : null;
    const prevActiveRate = prev.memberCount ? (prev.dau / prev.memberCount) * 100 : null;
    const prevReply = pct(prev.replies, prev.messages);
    const prevChurn = prev.memberCount ? pct(prev.leaves, prev.memberCount) : null;
    const prevConv = pct(prev.newSpeakers, prev.joins);
    const prevTop3 = [...prev.users].sort((a, b) => b.messages - a.messages).slice(0, 3).reduce((n, u) => n + u.messages, 0);
    const prevConc = pct(prevTop3, prev.messages);
    const prevAxes = {
      activity: Math.round((scoreUp(prevStickiness, 40) + scoreUp(prevActiveRate, 10)) / 2),
      engagement: Math.round(scoreUp(prevReply, 30)),
      climate: Math.round(prev.messages > 0 ? clamp(100 - (prev.toxicityWeight / prev.messages) * 120) : 100),
      growth: Math.round((scoreDown(prevChurn, 5, 25) + scoreUp(prevConv, 20)) / 2),
      core: Math.round(scoreDown(prevConc, 40, 90)),
    };
    scoreDelta = score - compositeScore(prevAxes);
  }

  // ── Series + heatmap ────────────────────────────────────────────────────────
  const byDay = new Map(cur.stats.map(s => [s.day, s]));
  const series = dayKeysBetween(new Date(`${from}T12:00:00+03:00`), new Date(`${to}T12:00:00+03:00`)).map(day => {
    const s = byDay.get(day);
    return { day, messages: s?.messages ?? 0, activeUsers: s?.activeUsers ?? 0, joins: s?.joins ?? 0, leaves: s?.leaves ?? 0 };
  });
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const s of cur.stats) {
    const hours = Array.isArray(s.hourHistogram) ? (s.hourHistogram as number[]) : null;
    if (!hours) continue;
    const wd = weekdayOf(s.day);
    for (let h = 0; h < 24; h++) heatmap[wd]![h] = (heatmap[wd]![h] ?? 0) + (hours[h] ?? 0);
  }

  // ── Orbit, top participants ─────────────────────────────────────────────────
  const orbit = orbitTiers(cur.users);
  const topParticipantIds = sortedByMsg.slice(0, 10).map(u => u.tgUserId);
  const participantIdentities = topParticipantIds.length ? await prisma.communityPulseParticipant.findMany({
    where: { communityId, tgUserId: { in: topParticipantIds } },
    select: { tgUserId: true, username: true, displayName: true },
  }).catch(() => []) : [];
  const identityByUser = new Map(participantIdentities.map(identity => [identity.tgUserId, identity]));
  const topParticipants = sortedByMsg.slice(0, 10).map(u => ({
    tgUserId: u.tgUserId,
    username: identityByUser.get(u.tgUserId)?.username ?? null,
    displayName: identityByUser.get(u.tgUserId)?.displayName ?? null,
    messages: u.messages, activeDays: u.activeDays,
    share: cur.messages > 0 ? Math.round((u.messages / cur.messages) * 1000) / 10 : 0,
  }));

  // ── Cohorts: of those who joined in week W, how many were still active later ─
  const members = await prisma.communityMember.findMany({
    where: { communityId, joinedAt: { not: null, gte: new Date(now.getTime() - 8 * 7 * DAY_MS) } },
    select: { tgUserId: true, joinedAt: true },
  }).catch(() => []);
  const activeWeeks = new Map<string, Set<string>>(); // tgUserId → set of week keys
  const factRows = await prisma.communityDailyParticipant.findMany({
    where: { communityId, day: { gte: pulseDayKey(new Date(now.getTime() - 8 * 7 * DAY_MS)) } },
    select: { tgUserId: true, day: true },
  }).catch(() => []);
  for (const f of factRows) {
    if (!activeWeeks.has(f.tgUserId)) activeWeeks.set(f.tgUserId, new Set());
    activeWeeks.get(f.tgUserId)!.add(weekKeyOf(f.day));
  }
  const cohortMap = new Map<string, string[]>();
  for (const m of members) {
    if (!m.joinedAt) continue;
    const key = weekKeyOf(pulseDayKey(m.joinedAt));
    if (!cohortMap.has(key)) cohortMap.set(key, []);
    cohortMap.get(key)!.push(m.tgUserId);
  }
  const cohorts = [...cohortMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cohort, ids]) => {
    const start = new Date(`${cohort}T12:00:00+03:00`).getTime();
    const weeksSince = Math.floor((now.getTime() - start) / (7 * DAY_MS));
    const retention: number[] = [];
    for (let w = 0; w <= Math.min(weeksSince, 7); w++) {
      const weekKey = pulseDayKey(new Date(start + w * 7 * DAY_MS));
      const alive = ids.filter(id => activeWeeks.get(id)?.has(weekKey)).length;
      retention.push(ids.length ? Math.round((alive / ids.length) * 1000) / 10 : 0);
    }
    return { cohort, size: ids.length, retention };
  });

  // ── Tenure distribution ─────────────────────────────────────────────────────
  const allMembers = await prisma.communityMember.findMany({ where: { communityId, joinedAt: { not: null } }, select: { joinedAt: true } }).catch(() => []);
  const buckets = [
    { bucket: '< 1 нед', max: 7 }, { bucket: '1–4 нед', max: 28 },
    { bucket: '1–3 мес', max: 90 }, { bucket: '3–12 мес', max: 365 }, { bucket: '> года', max: Infinity },
  ];
  const tenure = buckets.map(b => ({ bucket: b.bucket, count: 0 }));
  for (const m of allMembers) {
    if (!m.joinedAt) continue;
    const ageDays = (now.getTime() - m.joinedAt.getTime()) / DAY_MS;
    const idx = buckets.findIndex(b => ageDays < b.max);
    if (idx >= 0) tenure[idx]!.count++;
  }

  return {
    period: { from, to, days, daysWithData: cur.daysWithData },
    score, scoreDelta, axes,
    headline: {
      memberCount: cur.memberCount,
      dau: cur.dau, mau: cur.mau, stickiness, activeRate,
      messages: cur.messages,
      messagesPerDay: cur.daysWithData ? Math.round((cur.messages / cur.daysWithData) * 10) / 10 : 0,
      replyShare,
      joins: cur.joins, leaves: cur.leaves, netGrowth: cur.joins - cur.leaves, churnRate,
      newSpeakers: cur.newSpeakers, speakerConversion, concentration,
    },
    moderation:{...cur.moderation,temporaryRisks}, series, heatmap, orbit, topParticipants, cohorts, tenure,
  };
}
