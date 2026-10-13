/**
 * PulseTab.tsx — the «Пульс» tab: community chat analytics.
 *
 * Telegram gives group chats no analytics at all, so every number here comes
 * from our own collection. Layout follows the dataviz method: a hero figure for
 * the one number the dashboard leads with, a radar for the five-axis overview
 * (always paired with exact numbers, because a radar cannot be read precisely),
 * then a form chosen per data job — trend line, heatmap grid, diverging bars,
 * part-to-whole stack, ranked bars, cohort grid — plus a table view for
 * accessibility.
 */

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, Loader2, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { API_BASE } from '@/lib/api'
import { getTelegramInitData, moderatorFetch } from '@/lib/telegram'
import { GlassCard } from '@/components/ui/GlassCard'
import { cn } from '@/lib/utils'
import { ActivityHeatmap, CohortGrid, JoinLeaveChart, PentagonRadar, PULSE_COLORS, RankedBars, Sparkline, StackedBar, TrendLine } from './pulseCharts'

interface PulseReport {
  period: { from: string; to: string; days: number; daysWithData: number }
  score: number
  scoreDelta: number | null
  axes: { activity: number; engagement: number; climate: number; growth: number; core: number }
  headline: {
    memberCount: number | null
    dau: number; mau: number; stickiness: number | null; activeRate: number | null
    messages: number; messagesPerDay: number; replyShare: number | null
    joins: number; leaves: number; netGrowth: number; churnRate: number | null
    newSpeakers: number; speakerConversion: number | null; concentration: number | null
  }
  moderation: {
    blockedMessages:number; culturalRewrites:number; interventions:number; conflicts:number; harassment:number
    affectedUsers:number; resolvedEpisodes:number; escalatedEpisodes:number; toxicityWeight:number
    temporaryRisks:{tgUserId:string;score:number;level:string;evidenceCount:number;lastEventAt:string;evidence:{category:string;severity:string;text:string;at:string}[]}[]
  }
  series: { day: string; messages: number; activeUsers: number; joins: number; leaves: number }[]
  heatmap: number[][]
  orbit: { tier: string; count: number; share: number }[]
  topParticipants: { tgUserId: string; username: string | null; displayName: string | null; messages: number; activeDays: number; share: number }[]
  cohorts: { cohort: string; size: number; retention: number[] }[]
  tenure: { bucket: string; count: number }[]
}
type Benchmark = { good: number; warn: number; unit: '%' | 'n' }

const PERIODS = [
  { days: 7, label: 'Неделя' },
  { days: 30, label: 'Месяц' },
  { days: 90, label: 'Квартал' },
  { days: 365, label: 'Год' },
]

const AXIS_LABELS: Record<keyof PulseReport['axes'], string> = {
  activity: 'Активность', engagement: 'Вовлечённость', climate: 'Климат', growth: 'Рост', core: 'Ядро',
}

/** Verdict against an industry benchmark — a number alone tells the owner nothing. */
function verdict(value: number | null, bench: Benchmark | undefined, lowerIsBetter = false): { text: string; tone: string } | null {
  if (value == null || !bench) return null
  const good = lowerIsBetter ? value <= bench.good : value >= bench.good
  const bad = lowerIsBetter ? value > bench.warn : value < bench.warn
  if (good) return { text: 'норма', tone: 'text-emerald-400' }
  if (bad) return { text: 'низко', tone: 'text-amber-400' }
  return { text: 'средне', tone: 'text-[#A1A1AA]' }
}

const fmt = (v: number | null, suffix = '') => (v == null ? '—' : `${v}${suffix}`)

function StatTile({ label, value, hint, verdictInfo }: {
  label: string; value: string; hint?: string; verdictInfo?: { text: string; tone: string } | null
}) {
  return (
    <div className="rounded-[13px] border border-white/[0.06] bg-white/[0.025] p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-[#66666E]">{label}</p>
      <p className="mt-1 text-[17px] font-semibold tabular-nums text-white">{value}</p>
      <div className="mt-0.5 flex items-center gap-1.5">
        {verdictInfo && <span className={cn('text-[10px] font-medium', verdictInfo.tone)}>{verdictInfo.text}</span>}
        {hint && <span className="text-[10px] text-[#55555D]">{hint}</span>}
      </div>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <GlassCard>
      <h3 className="text-[13px] font-semibold text-white">{title}</h3>
      {subtitle && <p className="mt-0.5 mb-3 text-[11px] leading-relaxed text-[#66666E]">{subtitle}</p>}
      <div className={subtitle ? '' : 'mt-3'}>{children}</div>
    </GlassCard>
  )
}

/** Reserved-height skeleton so the page doesn't jump when data lands. */
function Skeleton() {
  return (
    <div className="space-y-3 px-4 pt-3">
      <div className="h-[132px] animate-pulse rounded-[18px] bg-white/[0.04]" />
      <div className="h-[300px] animate-pulse rounded-[18px] bg-white/[0.04]" />
      <div className="h-[180px] animate-pulse rounded-[18px] bg-white/[0.04]" />
    </div>
  )
}

export function PulseTab({ communityId }: { communityId: string }) {
  const [days, setDays] = useState(30)
  const [report, setReport] = useState<PulseReport | null>(null)
  const [benchmarks, setBenchmarks] = useState<Record<string, Benchmark>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showTable, setShowTable] = useState(false)
  const initData = getTelegramInitData()

  const load = useCallback(async (period: number) => {
    if (!initData) { setLoading(false); return }
    setLoading(true); setError('')
    try {
      const r = await moderatorFetch(`${API_BASE}/api/moderator/communities/${communityId}/pulse?days=${period}`)
      const d = await r.json() as { report?: PulseReport; benchmarks?: Record<string, Benchmark>; error?: string }
      if (!r.ok) throw new Error(d.error ?? 'Не удалось загрузить аналитику')
      setReport(d.report ?? null)
      setBenchmarks(d.benchmarks ?? {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить аналитику')
    } finally { setLoading(false) }
  }, [communityId, initData])

  useEffect(() => { void load(days) }, [days, load])

  if (loading && !report) return <Skeleton />

  if (error && !report) {
    return (
      <div className="px-4 pt-3">
        <GlassCard>
          <p className="text-[12px] text-red-300">{error}</p>
          <button onClick={() => void load(days)} className="mt-3 flex min-h-11 items-center gap-1.5 rounded-[11px] bg-white/[0.06] px-3 text-[12px] text-white">
            <RefreshCw size={14} /> Повторить
          </button>
        </GlassCard>
      </div>
    )
  }
  if (!report) return null

  const h = report.headline
  const thin = report.period.daysWithData < Math.min(7, report.period.days)
  const axes = (Object.keys(AXIS_LABELS) as (keyof PulseReport['axes'])[]).map(key => ({
    key, label: AXIS_LABELS[key], value: report.axes[key],
  }))

  return (
    <div className="space-y-3 px-4 pt-3">
      {/* Period filter — one row above the charts, 44px touch targets */}
      <div className="flex gap-1 rounded-[12px] border border-white/[0.06] bg-white/[0.04] p-1" role="tablist" aria-label="Период">
        {PERIODS.map(p => (
          <button
            key={p.days}
            role="tab"
            aria-selected={days === p.days}
            onClick={() => setDays(p.days)}
            className={cn(
              'min-h-11 flex-1 cursor-pointer rounded-[9px] px-1 text-[12px] font-semibold transition-colors',
              days === p.days ? 'bg-[#FF6A00] text-white' : 'text-[#A1A1AA] hover:text-white',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {thin && (
        <div className="flex items-start gap-2 rounded-[13px] border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-[11px] leading-relaxed text-amber-200/90">
            Данных пока мало — {report.period.daysWithData} дн. с активностью. Сбор идёт с момента подключения, выводы станут точнее через несколько дней.
          </p>
        </div>
      )}

      {/* Hero figure — the one number the dashboard leads with */}
      <GlassCard strong>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-[#66666E]">Пульс сообщества</p>
            <div className="mt-1 flex items-end gap-2.5">
              <span data-testid="pulse-score" className="text-[48px] font-semibold leading-none tabular-nums text-white">{report.score}</span>
              {report.scoreDelta != null && report.scoreDelta !== 0 && (
                <span className={cn('mb-1.5 flex items-center gap-0.5 text-[12px] font-medium',
                  report.scoreDelta > 0 ? 'text-emerald-400' : 'text-amber-400')}>
                  {report.scoreDelta > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  {report.scoreDelta > 0 ? '+' : ''}{report.scoreDelta}
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-[#55555D]">из 100 · за период</p>
          </div>
          <div className="pt-2">
            <Sparkline values={report.series.map(s => s.messages)} />
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[#A1A1AA]">По накопленной истории · прежняя методика. Новые показатели собираются параллельно; история продолжает учитываться.</p>
      </GlassCard>

      {/* Radar — overview only; exact numbers sit right beside it */}
      <Section title="Пять осей здоровья" subtitle="Радар даёт общий взгляд, точные значения — справа.">
        <div className="flex items-center gap-1">
          <div className="shrink-0">
            <PentagonRadar axes={axes} size={150} />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            {axes.map(a => (
              <div key={a.key} className="flex items-center gap-2">
                <span className="w-[74px] shrink-0 text-[11px] text-[#A1A1AA]">{a.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                  <div className="h-full rounded-full" style={{ width: `${a.value}%`, background: PULSE_COLORS[0] }} />
                </div>
                <span className="w-6 shrink-0 text-right text-[11px] font-semibold tabular-nums text-white">{a.value}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Headline KPIs with benchmarks */}
      <Section title="Ключевые показатели" subtitle="Ориентиры прежней модели Publium; не универсальная норма для всех чатов.">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Липкость DAU/MAU" value={fmt(h.stickiness, '%')} hint="норма >40%" verdictInfo={verdict(h.stickiness, benchmarks['stickiness'])} />
          <StatTile label="Активны в день" value={fmt(h.activeRate, '%')} hint="норма 5–10%" verdictInfo={verdict(h.activeRate, benchmarks['activeRate'])} />
          <StatTile label="Доля ответов" value={fmt(h.replyShare, '%')} hint="норма >30%" verdictInfo={verdict(h.replyShare, benchmarks['replyShare'])} />
          <StatTile label="Отток" value={fmt(h.churnRate, '%')} hint="норма <5%" verdictInfo={verdict(h.churnRate, benchmarks['churnRate'], true)} />
          <StatTile label="Заговорили" value={fmt(h.speakerConversion, '%')} hint="норма >20%" verdictInfo={verdict(h.speakerConversion, benchmarks['speakerConversion'])} />
          <StatTile label="Топ-3 говорят" value={fmt(h.concentration, '%')} hint="меньше — лучше" />
          <StatTile label="Участников" value={h.memberCount != null ? String(h.memberCount) : '—'} hint={`${h.mau} писали`} />
          <StatTile label="Сообщений" value={String(h.messages)} hint={`${h.messagesPerDay}/день`} />
        </div>
      </Section>

      <Section title="Климат и модерация" subtitle="Pulse только показывает агрегаты. Он не удаляет сообщения и не назначает санкции.">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Удалено" value={String(report.moderation.blockedMessages)} hint={`${report.moderation.culturalRewrites} с перефразом`} />
          <StatTile label="Мягких ответов" value={String(report.moderation.interventions)} hint="без warn и mute" />
          <StatTile label="Конфликтов" value={String(report.moderation.conflicts)} hint={`${report.moderation.resolvedEpisodes} завершено`} />
          <StatTile label="Травля" value={String(report.moderation.harassment)} hint={`${report.moderation.escalatedEpisodes} эскалаций`} />
          <StatTile label="Затронуто" value={String(report.moderation.affectedUsers)} hint="участников за дни" />
          <StatTile label="Вес токсичности" value={String(report.moderation.toxicityWeight)} hint="учитывает тяжесть" />
        </div>
        {report.moderation.temporaryRisks.length>0&&<div className="mt-3 rounded-[13px] border border-white/[0.06] bg-white/[0.025] p-3"><p className="text-[11px] font-semibold text-white">Временный риск по эпизодам</p><p className="mt-0.5 text-[10px] leading-relaxed text-[#777780]">Это не постоянный ярлык и не основание для автоматической санкции: оценка уменьшается со временем.</p><div className="mt-2 space-y-2">{report.moderation.temporaryRisks.slice(0,5).map(r=><details key={r.tgUserId} className="rounded-[10px] border border-white/[0.05] px-2.5 py-2"><summary className="flex min-h-8 cursor-pointer list-none items-center gap-2"><span className="w-[82px] truncate text-[11px] text-[#A1A1AA]">ID {r.tgUserId.slice(-6)}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]"><div className={cn('h-full rounded-full',r.level==='high'?'bg-red-400':r.level==='medium'?'bg-amber-400':'bg-cyan-300')} style={{width:`${r.score}%`}}/></div><span className="w-6 text-right text-[11px] tabular-nums text-white">{r.score}</span></summary>{r.evidence.length>0&&<div className="mt-2 space-y-1.5 border-t border-white/[0.05] pt-2">{r.evidence.map((e,i)=><p key={`${e.at}-${i}`} className="text-[10px] leading-relaxed text-[#A1A1AA]"><span className="text-[#D4D4D8]">{e.category} · {e.severity}:</span> {e.text}</p>)}</div>}</details>)}</div></div>}
      </Section>

      <Section title="Сообщения по дням">
        <TrendLine series={report.series.map(s => ({ day: s.day, value: s.messages }))} label="Сообщений в день" />
      </Section>

      <Section title="Когда чат живой" subtitle="Час × день недели: где темнее — там разговор.">
        <ActivityHeatmap matrix={report.heatmap} />
      </Section>

      <Section title="Приток и отток" subtitle={`Нетто за период: ${h.netGrowth > 0 ? '+' : ''}${h.netGrowth}`}>
        <JoinLeaveChart series={report.series.map(s => ({ day: s.day, joins: s.joins, leaves: s.leaves }))} />
      </Section>

      <Section title="Круги вовлечённости" subtitle="Ядро несёт разговор, наблюдатели молчат — так устроено любое сообщество.">
        <StackedBar items={report.orbit.map((o, i) => ({ label: o.tier, value: o.count, color: PULSE_COLORS[i % PULSE_COLORS.length]! }))} />
      </Section>

      <Section title="Кто говорит" subtitle="Топ по числу сообщений за период.">
        <RankedBars items={report.topParticipants.map(p => ({
          key: p.tgUserId,
          label: p.username ? `@${p.username}` : p.displayName || `ID ${p.tgUserId.slice(-6)}`,
          href: p.username ? `https://t.me/${p.username}` : undefined,
          value: p.messages,
          hint: `${p.share}%`,
        }))} />
      </Section>

      <Section title="Удержание когорт" subtitle="Из вступивших на неделе — сколько ещё пишут.">
        <CohortGrid cohorts={report.cohorts} />
      </Section>

      <Section title="Стаж участников">
        <StackedBar items={report.tenure.map((t, i) => ({ label: t.bucket, value: t.count, color: PULSE_COLORS[i % PULSE_COLORS.length]! }))} />
      </Section>

      {/* Table view — accessibility requirement for every chart page */}
      <GlassCard>
        <button onClick={() => setShowTable(v => !v)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-left">
          <Activity size={15} className="text-[#66666E]" />
          <span className="flex-1 text-[13px] font-semibold text-white">Таблица данных</span>
          <span className="text-[11px] text-[#66666E]">{showTable ? 'скрыть' : 'показать'}</span>
        </button>
        {showTable && (
          <div className="mt-3 max-h-[320px] overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-[#121214]">
                <tr className="text-left text-[#66666E]">
                  <th className="py-1 font-normal">День</th>
                  <th className="py-1 text-right font-normal">Сообщ.</th>
                  <th className="py-1 text-right font-normal">Активных</th>
                  <th className="py-1 text-right font-normal">+</th>
                  <th className="py-1 text-right font-normal">−</th>
                </tr>
              </thead>
              <tbody>
                {[...report.series].reverse().map(s => (
                  <tr key={s.day} className="border-t border-white/[0.05]">
                    <td className="py-1 text-[#A1A1AA]">{s.day.slice(5)}</td>
                    <td className="py-1 text-right tabular-nums text-white">{s.messages}</td>
                    <td className="py-1 text-right tabular-nums text-[#A1A1AA]">{s.activeUsers}</td>
                    <td className="py-1 text-right tabular-nums text-emerald-400">{s.joins || ''}</td>
                    <td className="py-1 text-right tabular-nums text-amber-400">{s.leaves || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {loading && (
        <div className="flex justify-center py-2">
          <Loader2 size={16} className="animate-spin text-[#FF6A00]" />
        </div>
      )}
    </div>
  )
}
