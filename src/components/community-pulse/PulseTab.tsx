import { useEffect, useState } from 'react'
import { Activity, Loader2, RefreshCw } from 'lucide-react'
import { API_BASE } from '@/lib/api'
import { getTelegramInitData, moderatorFetch } from '@/lib/telegram'
import { GlassCard } from '@/components/ui/GlassCard'
import { cn } from '@/lib/utils'
import { ActivityHeatmap, CohortGrid, JoinLeaveChart, PentagonRadar, PULSE_COLORS, RankedBars, Sparkline, StackedBar } from './pulseCharts'
import { TrendLine } from './pulseChartsV2'
import type { PulseTransition } from './PulseTransitionPanel'

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
const pulseDateLabel=(day:string)=>day.split('-').reverse().join('.')
function StatTile({label,value,hint}:{label:string;value:string;hint?:string}) {
  return <div data-testid="pulse-stat" className="rounded-[13px] border border-white/[0.06] bg-white/[0.025] p-3"><p className="text-xs text-[#A1A1AA]">{label}</p><p className="mt-1 text-[21px] font-semibold tabular-nums text-white">{value}</p>{hint&&<p className="mt-1 text-[11px] leading-relaxed text-[#A1A1AA]">{hint}</p>}</div>
}
function Explanation({title,children}:{title:string;children:React.ReactNode}) {
  return <details className="mt-2"><summary className="min-h-11 cursor-pointer rounded py-3 text-xs text-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300">{title}</summary><div className="space-y-2 pb-1 text-xs leading-relaxed text-[#A1A1AA]">{children}</div></details>
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
      <p className="text-xs leading-relaxed text-[#A1A1AA]">{pulseDateLabel(report.period.from)} — {pulseDateLabel(report.period.to)} · МСК<br/>Сегодня — неполный день</p>
      <GlassCard strong>
        <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] uppercase tracking-wider text-[#A1A1AA]">Пульс сообщества</p><div className="mt-2 flex items-end gap-2"><span data-testid="pulse-score" className="text-[52px] font-semibold leading-none tabular-nums text-white">{report.score}</span><span className="pb-1 text-xs text-[#A1A1AA]">из 100</span></div></div><div className="pt-2"><Sparkline values={report.series.map(s=>s.messages)}/><p className="mt-1 text-right text-[10px] text-[#A1A1AA]">Сообщения по дням</p></div></div>
        <p className="mt-3 text-xs text-[#A1A1AA]">Ориентировочная оценка за период</p>
        <Explanation title="Как считается Пульс">
          <p>Балл — округлённое среднее пяти осей: ({axes.map(a=>a.value).join(' + ')}) / 5 = {report.score}. Это индекс по данным чата, а не процент его здоровья.</p>
          <p>Неполные данные и выбранные шкалы влияют на результат. Высокий балл не гарантирует отсутствия проблем: смотрите также на отдельные оси и события.</p>
          <p>История доступна с {history?.firstRecordedDay?pulseDateLabel(history.firstRecordedDay):'первой сохранённой активности'}. Дни без записей не обязательно были тихими.</p>
        </Explanation>
      </GlassCard>
      <Section title="Пять осей здоровья">
        <div className="flex items-center gap-1"><div className="w-[42%] shrink-0"><PentagonRadar axes={axes} size={130}/></div><div className="min-w-0 flex-1 space-y-2">{axes.map(a=><div key={a.key} className="flex items-center gap-1.5"><span className="min-w-0 flex-1 text-[11px] text-[#C4C4CC]">{a.label}</span><div className="h-1.5 w-9 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-[#FF6A00]" style={{width:`${a.value}%`}}/></div><span className="w-6 text-right text-xs font-semibold tabular-nums text-white">{a.value}</span></div>)}</div></div>
        <Explanation title="Что означают оси">
          <p><strong className="text-[#D4D4D8]">Активность</strong> — частота участия авторов. Среднее двух шкал: среднее число авторов в день / авторы периода, с ориентиром 40%; среднее число авторов в день / состав, с ориентиром 10%.</p>
          <p><strong className="text-[#D4D4D8]">Вовлечённость</strong> — доля сообщений-ответов. При 30% и выше ось достигает 100; это не означает, что ответили на все вопросы.</p>
          <p><strong className="text-[#D4D4D8]">Климат</strong> — 100 − 120 × вес нарушений / число сообщений. Без полного анализа высокий балл не подтверждает отсутствие нарушений.</p>
          <p><strong className="text-[#D4D4D8]">Рост</strong> — среднее оценок выходов и соотношения впервые писавших к вступлениям. Выходы до 5% и соотношение от 20% дают максимумы. Эти группы могут не совпадать, а журнал выходов может быть неполным: оценка роста ограниченно надёжна.</p>
          <p><strong className="text-[#D4D4D8]">Ядро</strong> — распределение сообщений между авторами. Доля топ-3 до 40% даёт 100 баллов, от 90% — 0; между ними шкала линейная.</p>
          <p>Каждая шкала ограничена диапазоном 0–100. Пороги — настройки расчёта, а не универсальные нормы для сообществ.</p>
        </Explanation>
      </Section>
      <Section title="Ключевые показатели">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Участники" value={fmt(h.memberCount)} hint="Последний известный состав"/>
          <StatTile label="Писали в чате" value={fmt(h.mau)} hint="За выбранный период"/>
          <StatTile label="Сообщения" value={fmt(h.messages)}/>
          <StatTile label="Доля ответов" value={fmt(h.replyShare,'%')} hint="Среди сообщений"/>
          <StatTile label="Вступления" value={fmt(h.joins)} hint="По журналу событий"/>
          <StatTile label="Выходы" value={fmt(h.leaves)} hint="Данные могут быть неполными"/>
        </div>
        <Explanation title="О показателях">
          <p>«Писали в чате» — уникальные авторы сообщений за период. Telegram не сообщает, сколько участников только читают.</p>
          <p>«Доля ответов» — сообщения, отправленные через функцию «Ответить» в Telegram. Это не доля вопросов, на которые ответили.</p>
          <p>Вступления и выходы — записанные события. Ноль выходов означает, что записи о них отсутствуют; он не гарантирует нулевой отток.</p>
          <p>В среднем за день с активностью: {fmt(h.dau)} автора и {fmt(h.messagesPerDay)} сообщения. Дни без записей в это среднее не входят.</p>
          <p>Доля сообщений трёх самых активных авторов — {fmt(h.concentration,'%')}. Впервые записали сообщение {h.newSpeakers} авторов; они могли вступить в чат раньше.</p>
          <p>Отношение среднего числа авторов за активный день ко всем авторам периода — {fmt(h.stickiness,'%')}, к последнему составу — {fmt(h.activeRate,'%')}.</p>
        </Explanation>
      </Section>
      <Section title="Модерация" subtitle="По зарегистрированным событиям">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Попытки удаления" value={fmt(report.moderation.blockedMessages)} hint={`${report.moderation.culturalRewrites} с перефразом`}/>
          <StatTile label="Ответы модератора" value={fmt(report.moderation.interventions)}/>
          <StatTile label="Сигналы конфликтов" value={fmt(report.moderation.conflicts)}/>
          <StatTile label="Сигналы травли" value={fmt(report.moderation.harassment)}/>
        </div>
        <Explanation title="Подробнее о модерации">
          <p>Счётчики показывают зарегистрированные события за период. Ноль сигналов не гарантирует отсутствия нарушений: часть сообщений могла не проходить анализ.</p>
          <p>Результат удаления не всегда подтверждён. Ответы модератора могли сопровождаться санкциями.</p>
          <p>Завершений эпизодов — {report.moderation.resolvedEpisodes}, обострений — {report.moderation.escalatedEpisodes}. Они относятся ко всем категориям, а не только к конфликтам.</p>
          <p>Затронуто за дни — {report.moderation.affectedUsers}: это сумма дневных значений, один человек может учитываться повторно.</p>
          <p>Вес нарушений — {fmt(report.moderation.toxicityWeight)} условных единиц с учётом тяжести. Это не процент и не число людей.</p>
        </Explanation>
        {report.moderation.temporaryRisks.length>0&&<details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-white">Текущие сигналы риска · {report.moderation.temporaryRisks.length}</summary><p className="mb-2 text-xs leading-relaxed text-[#A1A1AA]">На сейчас, независимо от периода. Оценка затухает со временем; это не характеристика человека и не автоматическая санкция.</p>{report.moderation.temporaryRisks.map(r=><details key={r.tgUserId} className="border-t border-white/[0.06] py-2"><summary className="min-h-11 cursor-pointer text-xs text-[#D4D4D8]">ID {r.tgUserId.slice(-6)} · {r.score} / 100 · {r.evidenceCount} свидетельств</summary>{r.evidence.map((e,i)=><p key={i} className="mt-2 text-xs leading-relaxed text-[#A1A1AA]">{e.category} · {e.severity}: {e.text}</p>)}</details>)}</details>}
      </Section>
      <Section title="Сообщения по дням" subtitle="Разрыв линии — нет данных"><TrendLine series={report.series.map(s=>({day:s.day,value:recorded.has(s.day)?recorded.get(s.day)!:s.messages>0?s.messages:history?null:s.messages}))} label="Сообщений в день"/></Section>
      <Section title="Когда чат живой" subtitle="Чем ярче клетка, тем больше сообщений"><ActivityHeatmap matrix={report.heatmap}/></Section>
      <Section title="Приток и отток" subtitle="По журналу событий · данные могут быть неполными"><JoinLeaveChart series={report.series}/></Section>
      <Section title={history?'Как часто пишут':'Группы авторов'} subtitle="Среди тех, кто писал за период">
        <StackedBar items={(history?.authorTiers??report.orbit.map((o,i)=>({...o,tier:['Верхние 3%','Следующие 12%','Следующие 25%','Остальные авторы'][i]!}))).map((o,i)=>({label:o.tier,value:o.count,color:PULSE_COLORS[i%PULSE_COLORS.length]!}))}/>
        <Explanation title="Как определяются группы"><p>{history?'Регулярно — писали не менее половины дней периода, часто — не менее четверти, эпизодически — реже, разово — только один день.':'Авторы отсортированы по числу сообщений и разделены на ранговые группы.'} Участники без сообщений сюда не входят.</p></Explanation>
      </Section>
      <Section title="Кто говорит" subtitle="По числу сообщений за период"><RankedBars items={report.topParticipants.map(p=>({key:p.tgUserId,label:p.username?`@${p.username}`:p.displayName||`ID ${p.tgUserId.slice(-6)}`,href:p.username?`https://t.me/${p.username}`:undefined,value:p.messages,hint:`${p.share}%`}))}/></Section>
      <Section title="Возвращение новичков" subtitle="Последние 8 недель · независимо от фильтра">
        <CohortGrid cohorts={report.cohorts}/>
        <Explanation title="Как читать таблицу"><p>Каждая строка — группа вступивших на одной неделе. Числа показывают процент участников, которые писали: Н0 — неделя вступления, Н1 — следующая и так далее.</p><p>Последняя неделя ещё не завершена. Учитываются только сохранённые вступления и сообщения.</p></Explanation>
      </Section>
      <Section title="Стаж участников" subtitle={`Известны даты ${report.tenure.reduce((n,t)=>n+t.count,0)} вступлений`}>
        <StackedBar items={report.tenure.map((t,i)=>({label:t.bucket,value:t.count,color:PULSE_COLORS[i%PULSE_COLORS.length]!}))}/>
        <Explanation title="Какие участники учтены"><p>Стаж рассчитан на сегодня по сохранённым датам вступления. Это не полный список нынешних участников; неизвестные даты не учитываются.</p></Explanation>
      </Section>
      <GlassCard><button onClick={()=>setShowTable(v=>!v)} aria-expanded={showTable} className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-left text-sm text-white"><Activity size={15}/><span className="flex-1">Таблица данных</span><span className="text-xs text-[#A1A1AA]">{showTable?'скрыть':'показать'}</span></button>{showTable&&<div className="mt-3 max-h-80 overflow-auto"><table className="w-full text-[11px]"><caption className="pb-2 text-left text-[#A1A1AA]">— нет данных о сообщениях. 0 переходов — не зарегистрировано, полнота неизвестна.</caption><thead className="sticky top-0 bg-[#121214] text-[#A1A1AA]"><tr>{['День','Сообщ.','Авторы','+','−'].map(x=><th key={x} className="py-2 text-right font-normal first:text-left">{x}</th>)}</tr></thead><tbody>{[...report.series].reverse().map(s=><tr key={s.day} className="border-t border-white/[0.05] text-right tabular-nums text-[#D4D4D8]"><td className="py-2 text-left">{s.day.slice(5)}</td><td>{history?fmt(recorded.get(s.day)??null):s.messages}</td><td>{history&&recorded.get(s.day)==null?'—':s.activeUsers}</td><td>{s.joins}</td><td>{s.leaves}</td></tr>)}</tbody></table></div>}</GlassCard>
    </>}
  </div>
}
