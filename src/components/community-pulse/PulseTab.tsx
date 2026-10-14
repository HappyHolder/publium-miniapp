import { useEffect, useState } from 'react'
import { Activity, Loader2, RefreshCw } from 'lucide-react'
import { API_BASE } from '@/lib/api'
import { getTelegramInitData, moderatorFetch } from '@/lib/telegram'
import { GlassCard } from '@/components/ui/GlassCard'
import { cn } from '@/lib/utils'
import { ActivityHeatmap, CohortGrid, JoinLeaveChart, PentagonRadar, PULSE_COLORS, RankedBars, Sparkline, StackedBar } from './pulseCharts'
import { TrendLine } from './pulseChartsV2'
import { PulseTransitionPanel, pulseDateLabel, type PulseTransition } from './PulseTransitionPanel'

interface PulseReport {
  period: { from: string; to: string; days: number; daysWithData: number }
  score: number; scoreDelta: number | null
  axes: { activity: number; engagement: number; climate: number; growth: number; core: number }
  headline: {
    memberCount: number | null; dau: number; mau: number; stickiness: number | null; activeRate: number | null
    messages: number; messagesPerDay: number; replyShare: number | null; joins: number; leaves: number; netGrowth: number
    churnRate: number | null; newSpeakers: number; speakerConversion: number | null; concentration: number | null
  }
  moderation: {
    blockedMessages:number; culturalRewrites:number; interventions:number; conflicts:number; harassment:number
    affectedUsers:number; resolvedEpisodes:number; escalatedEpisodes:number; toxicityWeight:number
    temporaryRisks:{tgUserId:string;score:number;level:string;evidenceCount:number;lastEventAt:string;evidence:{category:string;severity:string;text:string;at:string}[]}[]
  }
  series: { day: string; messages: number; activeUsers: number; joins: number; leaves: number }[]
  heatmap: number[][]; orbit: { tier: string; count: number; share: number }[]
  topParticipants: { tgUserId: string; username: string | null; displayName: string | null; messages: number; activeDays: number; share: number }[]
  cohorts: { cohort: string; size: number; retention: number[] }[]; tenure: { bucket: string; count: number }[]
  transition?: PulseTransition
}
const PERIODS = [{days:7,label:'Неделя'},{days:30,label:'Месяц'},{days:90,label:'Квартал'},{days:365,label:'Год'}]
const LABELS: Record<keyof PulseReport['axes'],string> = {activity:'Активность',engagement:'Вовлечённость',climate:'Климат',growth:'Рост',core:'Ядро'}
const fmt=(n:number|null,suffix='')=>n==null?'—':`${Math.round(n*10)/10}${suffix}`
function StatTile({label,value,hint}:{label:string;value:string;hint:string}) {
  return <div className="rounded-[13px] border border-white/[0.06] bg-white/[0.025] p-3"><p className="text-[11px] text-[#A1A1AA]">{label}</p><p className="mt-1 text-[21px] font-semibold tabular-nums text-white">{value}</p><p className="mt-1 text-[11px] leading-relaxed text-[#A1A1AA]">{hint}</p></div>
}
function Section({title,subtitle,children}:{title:string;subtitle?:string;children:React.ReactNode}) {
  return <GlassCard><h3 className="text-sm font-semibold text-white">{title}</h3>{subtitle&&<p className="mt-1 text-xs leading-relaxed text-[#A1A1AA]">{subtitle}</p>}<div className="mt-3">{children}</div></GlassCard>
}
export function PulseTab({communityId}:{communityId:string}) {
  const [days,setDays]=useState(30),[report,setReport]=useState<PulseReport|null>(null)
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[showTable,setShowTable]=useState(false)
  const initData=getTelegramInitData()
  useEffect(()=>{
    const controller=new AbortController();let current=true
    setLoading(true);setError('');setReport(null)
    void(async()=>{
      try {
        if(!initData)throw Error('Откройте Пульс из Telegram для доступа к аналитике.')
        const r=await moderatorFetch(`${API_BASE}/api/moderator/communities/${communityId}/pulse?days=${days}`,{signal:controller.signal})
        const d=await r.json() as {report?:PulseReport;error?:string}
        if(!r.ok||!d.report)throw Error(d.error??'Не удалось загрузить аналитику')
        if(current)setReport(d.report)
      } catch(e) {if(current)setError(e instanceof Error?e.message:'Не удалось загрузить аналитику')}
      finally {if(current)setLoading(false)}
    })()
    return()=>{current=false;controller.abort()}
  },[communityId,days,initData,retry])
  const h=report?.headline
  const axes=report?(Object.keys(LABELS) as (keyof PulseReport['axes'])[]).map(key=>({key,label:LABELS[key],value:report.axes[key]})):[]
  const history=report?.transition?.status==='ready'?report.transition.history:null
  const recorded=new Map(history?.series.map(s=>[s.day,s.messages]))
  return <div data-testid="pulse-report" className="space-y-3 px-4 pb-6 pt-3">
    <div className="flex gap-1 rounded-xl border border-white/[0.06] bg-white/[0.04] p-1" role="tablist" aria-label="Период">
      {PERIODS.map(p=><button key={p.days} role="tab" aria-selected={days===p.days} onClick={()=>setDays(p.days)} className={cn('min-h-11 flex-1 cursor-pointer rounded-[9px] px-1 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300',days===p.days?'bg-[#FF6A00] text-white':'text-[#A1A1AA] hover:text-white')}>{p.label}</button>)}
    </div>
    {loading&&<div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-[#A1A1AA]"><Loader2 size={18} className="animate-spin text-[#FF6A00]"/>Считаем Пульс…</div>}
    {error&&<GlassCard><p role="alert" className="text-sm text-red-300">{error}</p><button onClick={()=>setRetry(n=>n+1)} className="mt-3 flex min-h-11 items-center gap-2 rounded-xl bg-white/10 px-3 text-sm text-white"><RefreshCw size={14}/>Повторить</button></GlassCard>}
    {report&&h&&<>
      <p className="text-xs leading-relaxed text-[#A1A1AA]">{pulseDateLabel(report.period.from)} — {pulseDateLabel(report.period.to)} · Москва. Исторический отчёт включает сегодняшний неполный день.</p>
      <GlassCard strong>
        <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] uppercase tracking-wider text-[#A1A1AA]">Пульс сообщества</p><div className="mt-2 flex items-end gap-2"><span data-testid="pulse-score" className="text-[52px] font-semibold leading-none tabular-nums text-white">{report.score}</span><span className="pb-1 text-xs text-[#A1A1AA]">из 100</span></div></div><div className="pt-2"><Sparkline values={report.series.map(s=>s.messages)}/><p className="mt-1 text-right text-[10px] text-[#A1A1AA]">Сообщения по дням</p></div></div>
        <p className="mt-3 text-xs leading-relaxed text-[#C4C4CC]">По накопленной истории · прежняя методика. Сохраняем её на время проверки v2; новый расчёт — ниже.</p>
        <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-xs text-orange-300">Что означает прежний балл</summary><p className="text-xs leading-relaxed text-[#A1A1AA]">Среднее пяти прежних осей. Эта методика быстро достигает потолка по ответам и концентрации, а показатель роста использовал несопоставимые группы авторов и вступивших. Балл сохранён для преемственности; это не подтверждение идеального состояния чата. Разницу между методиками не показываем как рост или падение здоровья.</p></details>
      </GlassCard>
      <Section title="Пять осей здоровья" subtitle="Прежняя методика. Точные значения — рядом с радаром.">
        <div className="flex items-center gap-1"><div className="w-[42%] shrink-0"><PentagonRadar axes={axes} size={130}/></div><div className="min-w-0 flex-1 space-y-2">{axes.map(a=><div key={a.key} className="flex items-center gap-1.5"><span className="min-w-0 flex-1 text-[11px] text-[#C4C4CC]">{a.label}</span><div className="h-1.5 w-9 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-[#FF6A00]" style={{width:`${a.value}%`}}/></div><span className="w-6 text-right text-xs font-semibold tabular-nums text-white">{a.value}</span></div>)}</div></div>
      </Section>
      <PulseTransitionPanel transition={report.transition}/>
      <p className="text-xs leading-relaxed text-[#A1A1AA]">{history?`${history.recordedDays} из ${days} дней имеют записи или подтверждённое наблюдение.${history.firstRecordedDay?` Первая сохранённая активность: ${pulseDateLabel(history.firstRecordedDay)}.`:''}`:`${report.period.daysWithData} дней с зарегистрированной активностью.`} Отсутствие записей не доказывает тишину. Даты до начала сбора не считаются наблюдавшимися.</p>
      <Section title="Ключевые показатели" subtitle="Зарегистрированные события за выбранный период. Полнота старого сбора не подтверждена; универсальных «норм» здесь нет.">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Авторы в среднем / за период" value={fmt(h.stickiness,'%')} hint={`${fmt(h.dau)} автора в среднем за день с активностью / ${h.mau} за период. Это не DAU/MAU для произвольного периода.`}/>
          <StatTile label="Авторы / состав" value={fmt(h.activeRate,'%')} hint="Среднее авторов за день с активностью / последний известный состав. Историческое приближение."/>
          <StatTile label="Сообщения с reply" value={fmt(h.replyShare,'%')} hint="Доля Telegram-ответов. В старой истории неизвестно, кому отвечали; это не доля вопросов с ответом."/>
          <StatTile label="Зарегистрировано выходов" value={fmt(h.leaves)} hint="0 означает отсутствие записей о выходах. Полнота журнала не подтверждена."/>
          <StatTile label="Впервые замечены авторами" value={fmt(h.newSpeakers)} hint="Первое зарегистрированное сообщение. Эти участники могли вступить задолго до периода."/>
          <StatTile label="Зарегистрировано вступлений" value={fmt(h.joins)} hint="Отдельный счётчик событий. Делить впервые замеченных авторов на него для конверсии нельзя."/>
          <StatTile label="Доля трёх авторов" value={fmt(h.concentration,'%')} hint="Доля сообщений топ-3. Показывает концентрацию разговора, а не его качество."/>
          <StatTile label="Последний состав" value={fmt(h.memberCount)} hint={`${h.mau} известных авторов за период. Чтение сообщений Telegram не раскрывает.`}/>
          <StatTile label="Сообщений учтено" value={fmt(h.messages)} hint={`${fmt(h.messagesPerDay)} в среднем за день с активностью; не за каждый календарный день.`}/>
        </div>
      </Section>
      <Section title="Климат и модерация" subtitle="Сохранённые исторические счётчики. Число действий не равно оценке климата и полноте AI-анализа.">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="События удаления" value={fmt(report.moderation.blockedMessages)} hint={`${report.moderation.culturalRewrites} с перефразом. Результат старых удалений не всегда подтверждён.`}/>
          <StatTile label="Ответы модератора" value={fmt(report.moderation.interventions)} hint="Исторический счётчик вмешательств; ответы могли сопровождаться санкциями."/>
          <StatTile label="События конфликтов" value={fmt(report.moderation.conflicts)} hint="Счётчик за период, не количество незавершённых конфликтов сейчас."/>
          <StatTile label="События травли" value={fmt(report.moderation.harassment)} hint="Без полного охвата анализа 0 не доказывает отсутствие травли."/>
          <StatTile label="Завершения / обострения" value={`${report.moderation.resolvedEpisodes} / ${report.moderation.escalatedEpisodes}`} hint="События по всем категориям эпизодов, поэтому не обязаны совпадать с числом конфликтов."/>
          <StatTile label="Затронуто за дни" value={fmt(report.moderation.affectedUsers)} hint="Сумма дневных значений. Один участник может учитываться в разные дни."/>
          <StatTile label="Исторический вес нарушений" value={fmt(report.moderation.toxicityWeight)} hint="Условная сумма весов тяжести. Не процент, не число людей и не шкала 0–100."/>
        </div>
        {report.moderation.temporaryRisks.length>0&&<details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-white">Текущие сигналы риска · {report.moderation.temporaryRisks.length}</summary><p className="mb-2 text-xs leading-relaxed text-[#A1A1AA]">На сейчас, независимо от периода. Оценка затухает со временем; это не характеристика человека и не автоматическая санкция.</p>{report.moderation.temporaryRisks.map(r=><details key={r.tgUserId} className="border-t border-white/[0.06] py-2"><summary className="min-h-11 cursor-pointer text-xs text-[#D4D4D8]">ID {r.tgUserId.slice(-6)} · {r.score} / 100 · {r.evidenceCount} свидетельств</summary>{r.evidence.map((e,i)=><p key={i} className="mt-2 text-xs leading-relaxed text-[#A1A1AA]">{e.category} · {e.severity}: {e.text}</p>)}</details>)}</details>}
      </Section>
      <Section title="Сообщения по дням" subtitle="Сохранена дневная история. Разрыв означает отсутствие данных; текущий день ещё не завершён."><TrendLine series={(history?.series??report.series).map(s=>({day:s.day,value:s.messages}))} label="Сообщений в день"/></Section>
      <Section title="Когда чат живой" subtitle="Чем ярче клетка, тем больше сообщений. Включена накопленная история; часы Москвы."><ActivityHeatmap matrix={report.heatmap}/></Section>
      <Section title="Приток и отток" subtitle={`Записано ${h.joins} вступлений и ${h.leaves} выходов. Полнота журнала не подтверждена, поэтому чистый прирост не утверждаем.`}><JoinLeaveChart series={report.series}/></Section>
      <Section title={history?'Регулярность авторов':'Группы писавших по рангу'} subtitle={history?'По дням с сообщениями: регулярно — ≥ половины выбранного периода, часто — ≥ четверти, эпизодически — реже, разово — один день. Только писавшие; молчащие участники сюда не входят.':'Прежние ранговые группы авторов, а не весь состав чата. Последняя группа тоже писала; она не является группой молчащих читателей.'}>
        <StackedBar items={(history?.authorTiers??report.orbit.map((o,i)=>({...o,tier:['Верхние 3%','Следующие 12%','Следующие 25%','Остальные авторы'][i]!}))).map((o,i)=>({label:o.tier,value:o.count,color:PULSE_COLORS[i%PULSE_COLORS.length]!}))}/>
      </Section>
      <Section title="Кто говорит" subtitle="Топ по учтённым сообщениям за выбранный период."><RankedBars items={report.topParticipants.map(p=>({key:p.tgUserId,label:p.username?`@${p.username}`:p.displayName||`ID ${p.tgUserId.slice(-6)}`,href:p.username?`https://t.me/${p.username}`:undefined,value:p.messages,hint:`${p.share}%`}))}/></Section>
      <Section title="Удержание когорт" subtitle="Сохранённая история за последние 8 недель, независимо от фильтра выше. Группы по записанной неделе вступления; ячейки показывают долю писавших в календарную неделю. Последняя неделя неполная; охват старого сбора не подтверждён."><CohortGrid cohorts={report.cohorts}/></Section>
      <Section title="Записанный стаж участников" subtitle={`По ${report.tenure.reduce((n,t)=>n+t.count,0)} сохранённым датам вступления, на сегодня. Это не полный список нынешних участников; неизвестные даты не превращаются в нулевой стаж.`}><StackedBar items={report.tenure.map((t,i)=>({label:t.bucket,value:t.count,color:PULSE_COLORS[i%PULSE_COLORS.length]!}))}/></Section>
      <GlassCard><button onClick={()=>setShowTable(v=>!v)} aria-expanded={showTable} className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-left text-sm text-white"><Activity size={15}/><span className="flex-1">Таблица данных</span><span className="text-xs text-[#A1A1AA]">{showTable?'скрыть':'показать'}</span></button>{showTable&&<div className="mt-3 max-h-80 overflow-auto"><table className="w-full text-[11px]"><caption className="pb-2 text-left text-[#A1A1AA]">— нет данных о сообщениях. 0 переходов — не зарегистрировано, полнота неизвестна.</caption><thead className="sticky top-0 bg-[#121214] text-[#A1A1AA]"><tr>{['День','Сообщ.','Авторы','+','−'].map(x=><th key={x} className="py-2 text-right font-normal first:text-left">{x}</th>)}</tr></thead><tbody>{[...report.series].reverse().map(s=><tr key={s.day} className="border-t border-white/[0.05] text-right tabular-nums text-[#D4D4D8]"><td className="py-2 text-left">{s.day.slice(5)}</td><td>{history?fmt(recorded.get(s.day)??null):s.messages}</td><td>{history&&recorded.get(s.day)==null?'—':s.activeUsers}</td><td>{s.joins}</td><td>{s.leaves}</td></tr>)}</tbody></table></div>}</GlassCard>
    </>}
  </div>
}
