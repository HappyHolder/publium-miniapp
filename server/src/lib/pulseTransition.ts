import { prisma } from '../db';
import { computePulse } from './communityPulseMetrics';
import { previewPulseHistory } from './pulseHistoryPreview';
import { pulseModerationFacts, type PulseModerationFacts } from './pulseModeration';
import { calculatePulseWindow, DAY, isPulseDayObserved, pulseDays, pulseDeltaContributions, pulseKey, pulseStart, roundPulse, shiftPulseDay } from './pulseScoring';

/** Additive migration contract: never replace a historical report with an empty v2. */
export async function computeCompatiblePulse(communityId: string, days = 30, now = new Date()) {
  if (![7, 30, 90, 365].includes(days)) throw Error('Unsupported Pulse period');
  const legacy = await computePulse(communityId, days, now);
  try {
    const transition = await computePulseTransition(communityId, days, now);
    return { ...legacy, transition };
  } catch (error) {
    // Log no participant payload or database error details. Failure of the preview
    // cannot make the historical dashboard disappear.
    console.warn('[pulse] transition unavailable', error instanceof Error ? error.name : 'UnknownError');
    return { ...legacy, transition: { status: 'unavailable' as const, primary: 'legacy' as const, reason: 'Новый расчёт временно недоступен. Прежний индекс и накопленная история сохранены.' } };
  }
}

export async function computePulseTransition(communityId: string, days: number, now: Date) {
  const today = pulseKey(+now), to = shiftPulseDay(today, -1), from = shiftPulseDay(to, 1-days);
  const prevTo = shiftPulseDay(from, -1), prevFrom = shiftPulseDay(from, -days);
  const lookback = shiftPulseDay(prevFrom, -27), startAt = new Date(pulseStart(lookback));
  const endAt = new Date(pulseStart(to) + DAY);
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const where = { communityId };
    const [facts, stats, messages, memberships, coverage, assessments, events, archived, firstFact, personas] = await Promise.all([
      tx.communityDailyParticipant.findMany({where:{...where,day:{gte:lookback,lte:today}},select:{day:true,tgUserId:true,messages:true,replies:true,estimated:true}}),
      tx.communityDailyStat.findMany({where:{...where,day:{gte:lookback,lte:today}},orderBy:{day:'asc'}}),
      tx.pulseMessage.findMany({where:{...where,sentAt:{gte:startAt,lt:endAt}}}),
      tx.pulseMembership.findMany({where:{...where,occurredAt:{gte:startAt,lt:endAt}}}),
      tx.pulseCoverage.findMany({where:{...where,day:{gte:lookback,lte:today}}}),
      tx.pulseAssessment.findMany({where:{...where,assessedAt:{gte:startAt}}}),
      tx.moderationEvent.findMany({where:{...where,createdAt:{gte:startAt}}}),
      tx.pulseModerationRecord.findMany({where:{...where,occurredAt:{gte:startAt}}}),
      tx.communityDailyParticipant.findFirst({where:{...where,messages:{gt:0}},orderBy:{day:'asc'},select:{day:true}}),
      tx.persona.findMany({where,select:{tgUserId:true}}),
    ]);
    // Fresh feedback overrides archived projections without writing during GET.
    const classifications = new Map(archived.map(e=>[e.id,e.facts as unknown as PulseModerationFacts]));
    for (const e of events) classifications.set(e.id,pulseModerationFacts(e));
    const invalidAnalysisKeys = [...classifications.values()].filter(f=>f.invalid).map(f=>f.analysisKey);
    const common = { messages,memberships,coverage,assessments,snapshots:stats,excludedIds:[] as string[],invalidAnalysisKeys };
    const model = calculatePulseWindow({...common,from,to});
    const previous = calculatePulseWindow({...common,from:prevFrom,to:prevTo});
    const comparable = model.status==='complete' && previous.status==='complete';
    const firstHistorical = firstFact ? shiftPulseDay(firstFact.day,13) : null;
    const historicalFrom = firstHistorical && firstHistorical>from ? firstHistorical : from;
    const historical = firstFact && historicalFrom<=to && pulseDays(historicalFrom,to).length>=7
      ? previewPulseHistory({from:historicalFrom,to,facts,stats}) : null;
    const personaIds = new Set([...personas.flatMap(p=>p.tgUserId?[p.tgUserId]:[]),...messages.filter(m=>m.actorKind==='PERSONA').map(m=>m.tgUserId)]);
    const scoreFacts = facts.filter(f=>f.day>=from && f.day<=to);
    const totalMessages = scoreFacts.reduce((n,f)=>n+f.messages,0);
    const personaMessages = scoreFacts.filter(f=>personaIds.has(f.tgUserId)).reduce((n,f)=>n+f.messages,0);
    const legacyFrom = shiftPulseDay(today,1-days), dailyStats = new Map(stats.map(s=>[s.day,s]));
    const observedByDay = new Map(coverage.map(c=>[c.day,isPulseDayObserved(c)]));
    const dailyFacts = new Map<string,typeof facts>();
    for (const f of facts) { if(!dailyFacts.has(f.day))dailyFacts.set(f.day,[]);dailyFacts.get(f.day)!.push(f); }
    const series = pulseDays(legacyFrom,today).map(day=>{
      const rows = dailyFacts.get(day)??[], stat = dailyStats.get(day), observed = observedByDay.get(day)??false;
      const recorded = rows.length>0 || (stat?.messages??0)>0;
      return {day,observed,messages:recorded||observed ? rows.length ? rows.reduce((n,f)=>n+f.messages,0) : stat?.messages??0 : null};
    });
    const activeDays = new Map<string,Set<string>>();
    for(const f of facts.filter(f=>f.day>=legacyFrom && f.day<=today && f.messages>0 && !f.estimated)) {
      if(!activeDays.has(f.tgUserId))activeDays.set(f.tgUserId,new Set());activeDays.get(f.tgUserId)!.add(f.day);
    }
    const tierCounts=[0,0,0,0];
    for(const ds of activeDays.values())tierCounts[ds.size===1?3:ds.size/days>=.5?0:ds.size/days>=.25?1:2]!++;
    return {
      status:'ready' as const,primary:'legacy' as const,period:{from,to,days},
      model:{...model,scoreDelta:comparable?roundPulse(model.rawScore!-previous.rawScore!):null,
        deltaContributions:comparable?pulseDeltaContributions(previous.axes,model.axes):null,
        population:`Общая аудитория включает аккаунты Ядра: ${personaMessages} из ${totalMessages} учтённых сообщений за полный период. Старые неразмеченные аккаунты могут быть не распознаны.`,
      },
      historical:historical?{period:historical.period,axes:historical.historical.axes,metrics:historical.historical.metrics,legacy:historical.legacy,preliminary:true as const}:null,
      history:{firstRecordedDay:firstFact?.day??null,recordedDays:series.filter(s=>s.messages!=null).length,series,
        authorTiers:['Регулярно','Часто','Эпизодически','Разово'].map((tier,i)=>({tier,count:tierCounts[i]!})),
      },
    };
  },{isolationLevel:'RepeatableRead',timeout:20_000});
}
export type PulseTransition = Awaited<ReturnType<typeof computeCompatiblePulse>>['transition'];
