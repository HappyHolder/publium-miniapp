/** Pure, versioned Pulse v2 model. Rates are percentage points, not fractions. */
export const PULSE_VERSION = 'pulse-v2.0';
export const AXIS_KEYS = ['activity', 'engagement', 'climate', 'growth', 'core'] as const;
export type AxisKey = typeof AXIS_KEYS[number];
export type PulseAxes = Record<AxisKey, number | null>;
export const DAY = 86_400_000;
export const roundPulse = (n: number) => Math.round(n * 10) / 10;
export const meanPulse = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const pulseStart = (day: string) => new Date(`${day}T00:00:00+03:00`).getTime();
export const pulseKey = (at: number) => new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
export const shiftPulseDay = (day: string, n: number) => pulseKey(pulseStart(day) + n * DAY);
export const pulseDays = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = pulseStart(from); t <= pulseStart(to); t += DAY) out.push(pulseKey(t));
  return out;
};

export const PULSE_SCALES = {
  dailyParticipation: [[0,0],[.5,20],[2,40],[5,65],[10,85],[20,100]],
  repeatDays7: [[0,0],[.5,25],[1,50],[2,75],[4,100]],
  replyShare: [[0,0],[10,25],[30,50],[50,75],[75,100]],
  dialogueBreadth: [[0,0],[10,25],[30,50],[60,75],[90,100]],
  reciprocity: [[0,0],[10,25],[30,50],[60,75],[90,100]],
  harmPer1000: [[0,100],[5,90],[15,75],[30,50],[60,25],[120,0]],
  targetShare: [[0,100],[1,90],[3,75],[10,50],[20,25],[40,0]],
  netRate30: [[-10,0],[-5,20],[0,50],[2,65],[5,80],[10,100]],
  activation7: [[0,0],[10,25],[20,50],[40,75],[70,100]],
  return14: [[0,0],[5,25],[15,50],[30,75],[60,100]],
} satisfies Record<string, number[][]>;

export function scalePulse(name: keyof typeof PULSE_SCALES, value: number): number {
  if (!Number.isFinite(value)) throw new Error(`Invalid Pulse ${name}`);
  const max = ['netRate30', 'harmPer1000', 'dailyParticipation'].includes(name) ? Infinity : name === 'repeatDays7' ? 6 : 100;
  if ((name !== 'netRate30' && value < 0) || value > max) throw new Error(`Out-of-range Pulse ${name}`);
  const points = PULSE_SCALES[name];
  if (value <= points[0]![0]!) return points[0]![1]!;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!, [x2, y2] = points[i]!;
    if (value <= x2!) return y1! + (value - x1!) / (x2! - x1!) * (y2! - y1!);
  }
  return points[points.length - 1]![1]!;
}

export function combinePulse(values: number[]): number | null {
  if (!values.length) return null;
  if (values.some(v => !Number.isFinite(v) || v < 0 || v > 100)) throw new Error('Invalid Pulse axis');
  return 100 - Math.sqrt(meanPulse(values.map(x => (100 - x) ** 2)));
}

export function summarizePulse(axes: PulseAxes, preliminary = false) {
  const availableAxes = AXIS_KEYS.filter(k => axes[k] != null);
  const values = availableAxes.map(k => axes[k]!);
  const rawScore = availableAxes.length >= 3 && axes.activity != null ? combinePulse(values) : null;
  return {
    version: PULSE_VERSION, rawScore, score: rawScore == null ? null : Math.round(rawScore),
    status: rawScore == null ? 'insufficient' as const : availableAxes.length < 5 || preliminary ? 'preliminary' as const : 'complete' as const,
    availableAxes,
    bounds: [combinePulse([...values, ...Array(5 - values.length).fill(0)])!, combinePulse([...values, ...Array(5 - values.length).fill(100)])!].map(roundPulse),
  };
}

/** Exact Shapley decomposition; never apply to missing or incomparable axes. */
export function pulseDeltaContributions(previous: PulseAxes, current: PulseAxes): Record<AxisKey, number> {
  if (AXIS_KEYS.some(k => previous[k] == null || current[k] == null)) throw new Error('Incomplete Pulse comparison');
  const sums = Object.fromEntries(AXIS_KEYS.map(k => [k, 0])) as Record<AxisKey, number>;
  let permutations = 0;
  function visit(order: AxisKey[], rest: AxisKey[]) {
    if (rest.length) { for (const k of rest) visit([...order, k], rest.filter(x => x !== k)); return; }
    const state = { ...previous };
    let before = combinePulse(AXIS_KEYS.map(k => state[k]!))!;
    for (const k of order) {
      state[k] = current[k];
      const after = combinePulse(AXIS_KEYS.map(x => state[x]!))!;
      sums[k] += after - before; before = after;
    }
    permutations++;
  }
  visit([], [...AXIS_KEYS]);
  for (const k of AXIS_KEYS) sums[k] /= permutations;
  return sums;
}

export type PulseMessageFact = { telegramMessageId: number; tgUserId: string; sentAt: Date; isReply: boolean; replyToMessageId: number | null; replyToUserId: string | null; replyToBot: boolean };
export type PulseMembershipFact = { tgUserId: string; kind: string; occurredAt: Date; firstJoin: boolean; source: string };
export type PulseCoverageFact = { day: string; firstAt: Date; lastAt: Date; maxGapMs: number; healthy: boolean; membership: boolean };
export type PulseAssessmentFact = { analysisKey: string; assessedAt: Date; messageIds: unknown; evidenceIds: unknown; targetIds: unknown; categories: unknown; category: string; severity: string; confidence: number };
export type PulseMetric = { label: string; value: number | null; unit: string; numerator?: number; denominator?: number; score?: number | null; explanation: string };
export type PulseAxisDetail = { formula: string; reason: string; preliminary: boolean; metrics: PulseMetric[] };
export type PulseScoringInput = {
  from: string; to: string; messages: PulseMessageFact[]; memberships: PulseMembershipFact[];
  coverage: PulseCoverageFact[]; snapshots: { day: string; memberCount: number | null }[];
  assessments: PulseAssessmentFact[]; excludedIds: string[]; invalidAnalysisKeys?: string[];
};

export function isPulseDayObserved(row: PulseCoverageFact | undefined, membership = false): boolean {
  if (!row || !row.healthy || (membership && !row.membership)) return false;
  const start = pulseStart(row.day), tolerance = 45 * 60_000;
  return row.firstAt.getTime() <= start && row.lastAt.getTime() >= start + DAY && row.maxGapMs <= tolerance;
}

/** All derived axes use the SAME continuous suffix; quiet days stay in it. */
export function calculatePulseWindow(input: PulseScoringInput) {
  const coverage = new Map(input.coverage.map(x => [x.day, x]));
  const observed = (day: string, membership = false) => isPulseDayObserved(coverage.get(day), membership);
  const requested = pulseDays(input.from, input.to);
  const suffix: string[] = [];
  for (const day of [...requested].reverse()) { if (!observed(day)) break; suffix.unshift(day); }
  const scoredDays = suffix.length;
  const scoredFrom = suffix[0] ?? null;
  const axes: PulseAxes = { activity: null, engagement: null, climate: null, growth: null, core: null };
  const details = {} as Record<AxisKey, PulseAxisDetail>;
  for (const key of AXIS_KEYS) details[key] = { formula: '', reason: 'Нужно не менее 7 полных дней подтверждённого сбора.', preliminary: true, metrics: [] };
  const empty = () => ({ ...summarizePulse(axes, true), axes, details, scoredFrom, scoredTo: input.to, scoredDays, requestedDays: requested.length, newcomer: null as null | { size: number; activated: number; returned: number } });
  if (scoredDays < 7 || !scoredFrom) return empty();

  const excluded = new Set(input.excludedIds);
  const messages = input.messages.filter(m => !excluded.has(m.tgUserId));
  const fromMs = pulseStart(scoredFrom), endMs = pulseStart(input.to) + DAY;
  const cur = messages.filter(m => +m.sentAt >= fromMs && +m.sentAt < endMs);
  const byId = new Map(messages.map(m => [m.telegramMessageId, m]));
  const snapshots = new Map(input.snapshots.map(s => [s.day, s.memberCount]));
  const daily = new Map<string, PulseMessageFact[]>();
  const byAuthor = new Map<string, PulseMessageFact[]>();
  for (const m of messages) {
    const key = pulseKey(+m.sentAt);
    if (!daily.has(key)) daily.set(key, []); daily.get(key)!.push(m);
    if (!byAuthor.has(m.tgUserId)) byAuthor.set(m.tgUserId, []); byAuthor.get(m.tgUserId)!.push(m);
  }
  const authors = (rows: PulseMessageFact[]) => new Set(rows.map(m => m.tgUserId));
  const curAuthors = authors(cur);
  const memberDays = suffix.every(d => (snapshots.get(d) ?? 0) > 0) ? suffix.reduce((s, d) => s + snapshots.get(d)!, 0) : null;
  const authorDays = suffix.reduce((s, d) => s + authors(daily.get(d) ?? []).size, 0);
  const weekly = suffix.flatMap(end => {
    const days = pulseDays(shiftPulseDay(end, -6), end);
    return days.every(d => observed(d)) ? [{ end, days, rows: days.flatMap(d => daily.get(d) ?? []) }] : [];
  });
  let repeatNumerator = 0, repeatDenominator = 0;
  for (const w of weekly) {
    const unique = authors(w.rows).size;
    repeatNumerator += w.days.reduce((s, d) => s + authors(daily.get(d) ?? []).size, 0) - unique;
    repeatDenominator += unique;
  }
  const repeat = repeatDenominator ? repeatNumerator / repeatDenominator : 0;
  const participation = memberDays ? authorDays / memberDays * 100 : null;
  if (participation != null && weekly.length) axes.activity = meanPulse([scalePulse('dailyParticipation', participation), scalePulse('repeatDays7', repeat)]);
  details.activity = { formula: 'Среднее баллов ежедневного участия и повторных дней общения за неделю.', reason: memberDays ? 'Численность включает весь состав группы; авторы — люди без ботов и личностей Ядра.' : 'Нет ежедневных снимков численности. Последний снимок не подменяет весь период.', preliminary: weekly.length < scoredDays, metrics: [
    { label: 'Участие в день', value: participation, unit: '%', numerator: authorDays, denominator: memberDays ?? undefined, explanation: 'Человеко-дни авторов / сумма ежедневной численности группы.' },
    { label: 'Повторные дни за неделю', value: repeat, unit: 'дн.', numerator: repeatNumerator, denominator: repeatDenominator, explanation: 'Сколько дней после первого автор пишет в скользящем окне 7 дней; окна без полного наблюдения исключены.' },
  ] };

  const recipient = (m: PulseMessageFact) => m.replyToBot ? null : m.replyToUserId ?? (m.replyToMessageId ? byId.get(m.replyToMessageId)?.tgUserId : null) ?? null;
  const peer = (m: PulseMessageFact) => { const id = recipient(m); return id && id !== m.tgUserId && !excluded.has(id) ? id : null; };
  const replies = cur.filter(m => m.isReply), unknownReplies = replies.filter(m => !m.replyToBot && !recipient(m)).length;
  const peerReplies = cur.filter(m => peer(m)).length;
  const replyShare = cur.length ? 100 * peerReplies / cur.length : 0;
  let dialogNumerator = 0, dialogDenominator = 0, mutual = 0, directed = 0;
  for (const w of weekly) {
    const ids = authors(w.rows), involved = new Set<string>(), edges = new Map<string, Set<string>>();
    for (const m of w.rows) { const to = peer(m); if (!to) continue; involved.add(m.tgUserId); if (ids.has(to)) involved.add(to); if (!edges.has(m.tgUserId)) edges.set(m.tgUserId, new Set()); edges.get(m.tgUserId)!.add(to); }
    dialogNumerator += involved.size; dialogDenominator += ids.size;
    for (const [a, targets] of edges) for (const b of targets) { directed++; if (edges.get(b)?.has(a)) mutual++; }
  }
  const breadth = dialogDenominator ? 100 * dialogNumerator / dialogDenominator : 0;
  const reciprocity = directed ? 100 * mutual / directed : 0;
  if ((!replies.length || unknownReplies < replies.length) && weekly.length) axes.engagement = meanPulse([scalePulse('replyShare', replyShare), scalePulse('dialogueBreadth', breadth), scalePulse('reciprocity', reciprocity)]);
  details.engagement = { formula: 'Среднее баллов ответов людям, широты диалога и взаимности за 7 дней.', reason: unknownReplies ? `У ${unknownReplies} ответов неизвестен адресат; они не объявлены диалогом.` : 'Ответы себе, ботам и личностям Ядра исключены из диалога.', preliminary: weekly.length < scoredDays || (replies.length > 0 && unknownReplies / replies.length > .05), metrics: [
    { label: 'Ответы людям', value: axes.engagement == null ? null : replyShare, unit: '%', numerator: peerReplies, denominator: cur.length, explanation: 'Сообщения с известным другим человеком-адресатом / все сообщения людей.' },
    { label: 'Широта диалога', value: breadth, unit: '%', numerator: dialogNumerator, denominator: dialogDenominator, explanation: 'Авторы, отправившие или получившие ответ, среди авторов недельных окон.' },
    { label: 'Взаимность', value: reciprocity, unit: '%', numerator: mutual, denominator: directed, explanation: 'Направленные связи, у которых есть обратный ответ, / все направленные связи за 7 дней.' },
  ] };

  const invalid = new Set(input.invalidAnalysisKeys ?? []), currentIds = new Set(cur.map(m => m.telegramMessageId));
  const evaluated = new Set<number>(), harm = new Map<number, number>(), targets = new Set<string>();
  let unknownTargets = false;
  const numericIds = (x: unknown): number[] => Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n)) : [];
  const required = ['conflict', 'toxicity', 'harassment', 'threat']; // hate is included in harassment by the classifier contract
  for (const a of input.assessments) {
    if (invalid.has(a.analysisKey) || !Array.isArray(a.categories) || !required.every(c => (a.categories as unknown[]).includes(c))) continue;
    const assessedIds = new Set(numericIds(a.messageIds));
    for (const id of assessedIds) if (currentIds.has(id)) evaluated.add(id);
    if (!required.includes(a.category) || a.confidence < .85) continue;
    const evidence = numericIds(a.evidenceIds).filter(id => currentIds.has(id) && assessedIds.has(id));
    const weight = ['harassment', 'threat'].includes(a.category) || a.severity === 'high' ? 1 : a.severity === 'medium' ? .5 : .25;
    for (const id of evidence) harm.set(id, Math.max(harm.get(id) ?? 0, weight));
    if (evidence.length && Array.isArray(a.targetIds)) for (const id of a.targetIds) if (typeof id === 'string' && curAuthors.has(id)) targets.add(id);
    if (evidence.length && ['harassment', 'threat'].includes(a.category) && (!Array.isArray(a.targetIds) || !a.targetIds.length)) unknownTargets = true;
  }
  const climateCoverage = cur.length ? 100 * evaluated.size / cur.length : 0;
  const harmWeight = [...harm.values()].reduce((a, b) => a + b, 0);
  const harmRate = evaluated.size ? 1000 * harmWeight / evaluated.size : null;
  const targetShare = curAuthors.size ? 100 * targets.size / curAuthors.size : null;
  if (climateCoverage >= 50 && harmRate != null && targetShare != null && !unknownTargets) axes.climate = Math.min(scalePulse('harmPer1000', harmRate), scalePulse('targetShare', targetShare));
  details.climate = { formula: 'Минимум баллов тяжести подтверждённых сообщений и доли затронутых авторов.', reason: `Проверено ${evaluated.size} из ${cur.length} сообщений по всем категориям климата. ${unknownTargets ? 'Для части направленных нарушений неизвестны адресаты. ' : ''}Подтверждение означает решение классификатора, а не проверку человеком.`, preliminary: climateCoverage < 90 || unknownTargets, metrics: [
    { label: 'Охват анализа', value: climateCoverage, unit: '%', numerator: evaluated.size, denominator: cur.length, explanation: 'Только завершённые контекстные проверки конфликтов, токсичности, травли (включая ненависть) и угроз.' },
    { label: 'Тяжесть на 1000 проверенных', value: harmRate, unit: '', numerator: harmWeight, denominator: evaluated.size, explanation: 'Вес 1 для угроз, травли, ненависти и высокой тяжести; 0,5 для средней и 0,25 для низкой тяжести конфликтов/токсичности. Повторы не складываются.' },
    { label: 'Затронутые авторы', value: unknownTargets ? null : targetShare, unit: '%', numerator: targets.size, denominator: curAuthors.size, explanation: 'Уникальные адресаты нарушений среди авторов периода; это не сумма дневных значений.' },
  ] };

  const memberships = input.memberships.filter(m => !excluded.has(m.tgUserId));
  const transitions = memberships.filter(m => +m.occurredAt >= fromMs && +m.occurredAt < endMs);
  const joins = transitions.filter(m => m.kind === 'join').length, leaves = transitions.filter(m => m.kind === 'leave').length;
  const membershipComplete = pulseDays(shiftPulseDay(scoredFrom, -14), input.to).every(d => observed(d, true));
  const cohort = memberships.filter(m => m.firstJoin && m.kind === 'join' && +m.occurredAt + 14 * DAY >= fromMs && +m.occurredAt + 14 * DAY < endMs);
  let activated = 0, returned = 0;
  for (const m of cohort) {
    const own = byAuthor.get(m.tgUserId) ?? [];
    const spoke = own.some(x => +x.sentAt >= +m.occurredAt && +x.sentAt < +m.occurredAt + 7 * DAY);
    if (spoke) { activated++; if (own.some(x => +x.sentAt >= +m.occurredAt + 7 * DAY && +x.sentAt < +m.occurredAt + 14 * DAY)) returned++; }
  }
  const netRate = memberDays ? 100 * 30 * (joins - leaves) / memberDays : null;
  const activation = cohort.length ? 100 * activated / cohort.length : null, return14 = cohort.length ? 100 * returned / cohort.length : null;
  if (membershipComplete && netRate != null) axes.growth = cohort.length ? meanPulse([scalePulse('netRate30', netRate), scalePulse('activation7', activation!), scalePulse('return14', return14!)]) : scalePulse('netRate30', netRate);
  details.growth = { formula: cohort.length ? 'Среднее баллов чистого притока, активации за 7 суток и возвращения на второй неделе.' : 'При подтверждённо пустой зрелой когорте — балл чистого притока.', reason: membershipComplete ? `Когорта: ${cohort.length} первых наблюдавшихся вступлений с завершёнными 14 сутками; известные повторные вступления исключены.` : 'Недостаточно подтверждённой истории вступлений и выходов. Отсутствие событий не считается нулевым оттоком.', preliminary: cohort.length > 0 && cohort.length < 20, metrics: [
    { label: 'Чистый приток, на 30 дней', value: membershipComplete ? netRate : null, unit: '%', numerator: joins - leaves, denominator: memberDays ?? undefined, explanation: '100 × 30 × (вступления − выходы) / участнико-дни. Интенсивность, не прогноз.' },
    { label: 'Заговорили за 7 суток', value: membershipComplete ? activation : null, unit: '%', numerator: activated, denominator: cohort.length, explanation: 'Написали после вступления за первые 7 суток / зрелая когорта.' },
    { label: 'Вернулись на второй неделе', value: membershipComplete ? return14 : null, unit: '%', numerator: returned, denominator: cohort.length, explanation: 'Писали и в первые 7, и в следующие 7 суток / та же зрелая когорта.' },
  ] };

  let overlapping = 0, priorTotal = 0;
  const breadthScores: number[] = [];
  let coreComplete = true;
  for (const w of weekly) {
    const previous = pulseDays(shiftPulseDay(w.end, -13), shiftPulseDay(w.end, -7));
    if (!previous.every(d => observed(d)) || !w.days.every(d => (snapshots.get(d) ?? 0) > 0)) { coreComplete = false; continue; }
    const prior = authors(previous.flatMap(d => daily.get(d) ?? [])), current = authors(w.rows);
    priorTotal += prior.size; overlapping += [...prior].filter(id => current.has(id)).length;
    const counts = new Map<string, number>(); for (const m of w.rows) counts.set(m.tgUserId, (counts.get(m.tgUserId) ?? 0) + 1);
    const effective = w.rows.length ? 1 / [...counts.values()].reduce((s, n) => s + (n / w.rows.length) ** 2, 0) : 0;
    const target = Math.min(20, Math.max(3, .02 * meanPulse(w.days.map(d => snapshots.get(d)!))));
    breadthScores.push(100 * Math.min(1, effective / target));
  }
  const effectiveBreadth = breadthScores.length ? meanPulse(breadthScores) : null;
  const returning = priorTotal ? 100 * overlapping / priorTotal : 0;
  if (coreComplete && weekly.length === scoredDays && effectiveBreadth != null) axes.core = meanPulse([effectiveBreadth, returning]);
  details.core = { formula: 'Среднее эффективной ширины актива и доли вернувшихся авторов соседних недель.', reason: axes.core == null ? 'Нужна непрерывная история предыдущих 13 дней и численности для каждого недельного окна.' : priorTotal ? 'Учитываются распределение сообщений и возвращение людей, а не место автора в рейтинге.' : 'В предыдущих неделях не было авторов: устойчивость ядра ещё не доказана.', preliminary: !priorTotal, metrics: [
    { label: 'Эффективная ширина', value: axes.core == null ? null : effectiveBreadth, unit: '/100', explanation: '1 / сумма квадратов долей сообщений; целевая ширина — 2% состава, от 3 до 20 эффективных авторов.' },
    { label: 'Вернувшиеся авторы', value: axes.core == null ? null : returning, unit: '%', numerator: overlapping, denominator: priorTotal, explanation: 'Авторы прошлой недели, писавшие на следующей; суммы по скользящим парам недель.' },
  ] };
  const preliminary = scoredDays < requested.length || AXIS_KEYS.some(k => axes[k] != null && details[k].preliminary);
  const metricScales: Record<AxisKey, (keyof typeof PULSE_SCALES | null)[]> = {
    activity: ['dailyParticipation', 'repeatDays7'], engagement: ['replyShare', 'dialogueBreadth', 'reciprocity'],
    climate: [null, 'harmPer1000', 'targetShare'], growth: ['netRate30', 'activation7', 'return14'], core: [null, null],
  };
  for (const key of AXIS_KEYS) details[key].metrics.forEach((metric, i) => {
    const scale = metricScales[key][i];
    metric.score = metric.value == null ? null : scale ? scalePulse(scale, metric.value) : key === 'core' ? metric.value : null;
  });
  return { ...summarizePulse(axes, preliminary), axes, details, scoredFrom, scoredTo: input.to, scoredDays, requestedDays: requested.length, newcomer: membershipComplete ? { size: cohort.length, activated, returned } : null };
}
