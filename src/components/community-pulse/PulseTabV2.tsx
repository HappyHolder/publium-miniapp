import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { API_BASE } from '@/lib/api'
import { getTelegramInitData, moderatorFetch } from '@/lib/telegram'
import { GlassCard } from '@/components/ui/GlassCard'
import { cn } from '@/lib/utils'
import { ActivityHeatmap, CohortGrid, JoinLeaveChart, PentagonRadar, PULSE_COLORS, RankedBars, StackedBar, TrendLine } from './pulseChartsV2'
import type { AxisKey, PulseReport } from './pulseTypes'

const PERIODS = [{ days: 7, label: 'Неделя' }, { days: 30, label: 'Месяц' }, { days: 90, label: 'Квартал' }, { days: 365, label: 'Год' }]
const AXIS_LABELS: Record<AxisKey, string> = { activity: 'Активность', engagement: 'Вовлечённость', climate: 'Климат', growth: 'Рост', core: 'Ядро' }
const fmt = (v: number | null | undefined, suffix = '') => v == null ? '—' : `${Number.isInteger(v) ? v : Math.round(v * 10) / 10}${suffix}`
const dateLabel = (day: string) => day.split('-').reverse().join('.')
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <GlassCard><h3 className="text-[14px] font-semibold text-white">{title}</h3>{subtitle && <p className="mt-1 text-[12px] leading-relaxed text-[#A1A1AA]">{subtitle}</p>}<div className="mt-3">{children}</div></GlassCard>
}
function StatTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="rounded-[13px] border border-white/[0.06] bg-white/[0.025] p-3"><p className="text-[11px] text-[#A1A1AA]">{label}</p><p className="mt-1 text-[21px] font-semibold tabular-nums text-white">{value}</p><p className="mt-1 text-[11px] leading-relaxed text-[#A1A1AA]">{hint}</p></div>
}
export function PulseTabV2({ communityId }: { communityId: string }) {
  const [days, setDays] = useState(30)
  const [report, setReport] = useState<PulseReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [showTable, setShowTable] = useState(false)
  const initData = getTelegramInitData()
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    setLoading(true); setError(''); setReport(null)
    void (async () => {
      try {
        if (!initData) throw new Error('Откройте Пульс из Telegram для доступа к аналитике.')
        const response = await moderatorFetch(`${API_BASE}/api/moderator/communities/${communityId}/pulse?days=${days}`, { signal: controller.signal })
        const data = await response.json() as { report?: PulseReport; error?: string }
        if (!response.ok || !data.report) throw new Error(data.error ?? 'Не удалось загрузить аналитику')
        if (current) setReport(data.report)
      } catch (e) { if (current) setError(e instanceof Error ? e.message : 'Не удалось загрузить аналитику') }
      finally { if (current) setLoading(false) }
    })()
    return () => { current = false; controller.abort() }
  }, [communityId, days, initData, retry])
  const h = report?.headline
  const axes = report ? (Object.keys(AXIS_LABELS) as AxisKey[]).map(key => ({ key, label: AXIS_LABELS[key], value: report.axes[key] })) : []
  const weakness = axes.filter(a => a.value != null).sort((a, b) => a.value! - b.value!)[0]
  return <div data-testid="pulse-report" className="space-y-3 px-4 pb-6 pt-3">
    <div className="flex gap-1 rounded-[12px] border border-white/[0.06] bg-white/[0.04] p-1" role="tablist" aria-label="Период">
      {PERIODS.map(p => <button key={p.days} role="tab" aria-selected={days === p.days} onClick={() => setDays(p.days)} className={cn('min-h-11 flex-1 rounded-[9px] px-1 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300', days === p.days ? 'bg-[#FF6A00] text-white' : 'text-[#A1A1AA] hover:text-white')}>{p.label}</button>)}
    </div>
    {loading && <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-[13px] text-[#A1A1AA]"><Loader2 size={18} className="animate-spin text-[#FF6A00]" />Считаем Пульс…</div>}
    {error && <GlassCard><p role="alert" className="text-[13px] text-red-300">{error}</p><button onClick={() => setRetry(n => n + 1)} className="mt-3 flex min-h-11 items-center gap-2 rounded-xl bg-white/10 px-3 text-sm text-white"><RefreshCw size={14} />Повторить</button></GlassCard>}
    {report && h && <>
      <p className="text-[11px] leading-relaxed text-[#A1A1AA]">{dateLabel(report.period.from)} — {dateLabel(report.period.to)} · {days} полных дней, Москва. Сегодня в оценку не входит.</p>
      <GlassCard strong>
        <p className="text-[11px] uppercase tracking-wider text-[#A1A1AA]">Пульс сообщества <span className="ml-1 normal-case text-orange-300">v2</span></p>
        <div className="mt-2 flex items-end gap-3"><span data-testid="pulse-score" className="text-[56px] font-semibold leading-none tabular-nums text-white">{fmt(report.score)}</span><span className="pb-1 text-[12px] text-[#A1A1AA]">из 100</span>{report.scoreDelta != null && <span className={cn('pb-1 text-[15px] tabular-nums', report.scoreDelta < 0 ? 'text-amber-300' : 'text-emerald-300')}>{signed(report.scoreDelta)} п.</span>}</div>
        <p className="mt-3 text-[13px] font-medium text-white">{report.model.status === 'complete' ? 'Оценены все пять осей' : report.model.status === 'preliminary' ? `Предварительный Пульс · ${report.model.availableAxes.length} из 5 осей` : 'Накапливаем данные для оценки'}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-[#A1A1AA]">{report.model.scoredDays < days ? `Непрерывное наблюдение: ${report.model.scoredDays} из ${days} дней. Для числа нужны минимум 7 дней и три оси, включая активность.` : weakness ? `Больше всего ограничивает оценку: ${weakness.label.toLowerCase()} (${Math.round(weakness.value!)} из 100).` : 'Данных для осей пока недостаточно.'}</p>
        {axes.some(a => a.value == null) && <p className="mt-2 text-[11px] text-amber-200">Пока не оценены: {axes.filter(a => a.value == null).map(a => a.label.toLowerCase()).join(', ')}.</p>}
        <details className="mt-3 border-t border-white/[0.08] pt-2"><summary className="min-h-8 cursor-pointer text-[12px] text-orange-300">Как получился балл</summary><div className="mt-2 space-y-2 text-[12px] leading-relaxed text-[#B7B7C0]">
          <p>Пульс = 100 − √среднего (100 − балл оси)². Все пять осей равноправны; слабая ось заметно влияет на итог. Ориентиры — стартовая модель Publium, а не универсальные нормы для чатов.</p>
          {report.score != null && report.model.availableAxes.length < 5 && <p>При разных значениях неизвестных осей полный индекс мог бы быть от {fmt(report.model.bounds[0])} до {fmt(report.model.bounds[1])}. Это границы по неизвестным составляющим, не доверительный интервал.</p>}
          <p>{report.model.comparisonReason}</p>
          {report.model.deltaContributions && <ul className="space-y-1">{(Object.keys(AXIS_LABELS) as AxisKey[]).map(key => <li key={key}>{AXIS_LABELS[key]}: {signed(report.model.deltaContributions![key])} п. изменения</li>)}</ul>}
          <p>{report.model.population}</p><p>{report.model.coverageNote}</p>
        </div></details>
      </GlassCard>
      <Section title="Пять осей здоровья" subtitle="Нажмите на ось ниже: исходные числа, формула и ограничения.">
        <div className="flex items-center gap-1"><div className="w-[42%] shrink-0"><PentagonRadar axes={axes} size={130} /></div><div className="min-w-0 flex-1 space-y-2">{axes.map(a => <div key={a.key} className="flex items-center gap-1.5"><span className="min-w-0 flex-1 text-[11px] text-[#C4C4CC]">{a.label}</span><div className="h-1.5 w-9 overflow-hidden rounded-full bg-white/[0.08]">{a.value != null && <div className="h-full rounded-full bg-[#FF6A00]" style={{ width: `${a.value}%` }} />}</div><span className="w-6 text-right text-[12px] font-semibold tabular-nums text-white">{a.value == null ? '—' : Math.round(a.value)}</span></div>)}</div></div>
        <div className="mt-3 divide-y divide-white/[0.06]">{axes.map(a => {
          const detail = report.model.details[a.key]
          return <details key={a.key}><summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-[12px] text-white"><span>{a.label}</span><span className="text-[#A1A1AA]">{a.value == null ? 'нет оценки' : `${Math.round(a.value)} / 100${detail.preliminary ? ' · предварительно' : ''}`} ＋</span></summary><div className="space-y-3 pb-4 text-[12px] leading-relaxed text-[#A1A1AA]"><p>{detail.formula}</p><p className={a.value == null ? 'text-amber-200' : ''}>{detail.reason}</p>{detail.metrics.map(m => <div key={m.label} className="rounded-lg bg-white/[0.035] p-2.5"><p className="flex items-baseline justify-between gap-2 text-white"><span>{m.label}</span><strong className="shrink-0 tabular-nums">{fmt(m.value, m.unit === '%' ? '%' : ` ${m.unit}`)}</strong></p>{m.numerator != null && m.denominator != null && <p className="mt-1 tabular-nums">Расчёт: {fmt(m.numerator)} / {fmt(m.denominator)}</p>}<p className="mt-1">{m.explanation}</p>{m.score != null && <p className="mt-1 text-orange-300">По шкале модели: {fmt(m.score)} / 100</p>}</div>)}</div></details>
        })}</div>
      </Section>
      {!report.quality.fullObserved && <div className="flex items-start gap-2 rounded-[13px] border border-amber-400/20 bg-amber-400/[0.07] p-3"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" /><p className="text-[12px] leading-relaxed text-amber-100">Подтверждено {report.period.observedDays} из {days} дней. Ниже — зарегистрированная активность; объём может быть неполным. Старая история не содержит всех связей между ответами и вступлениями.</p></div>}
      <Section title="Ключевые показатели" subtitle="За выбранный период. — означает, что для такого расчёта данных недостаточно."><div className="grid grid-cols-2 gap-2">
        <StatTile label="Авторы в день / за период" value={fmt(h.stickiness, '%')} hint={`${fmt(h.dau)} в среднем за день / ${h.mau} за ${days} дней. Это активность письма, не чтения.`} />
        <StatTile label="Пишут ежедневно" value={fmt(h.activeRate, '%')} hint="Авторо-дни / участнико-дни; тихие дни тоже входят." />
        <StatTile label="Ответы другим людям" value={fmt(h.replyShare, '%')} hint="Доля сообщений с известным собеседником." />
        <StatTile label="Вступили / вышли" value={`${fmt(h.joins)} / ${fmt(h.leaves)}`} hint={report.quality.membershipComplete ? 'Переходы членства за период; повторные доставки исключены.' : 'Только зарегистрированные переходы. Полнота не подтверждена.'} />
        <StatTile label="Новички заговорили" value={fmt(h.speakerConversion, '%')} hint={h.newcomerCount == null ? 'Нужна зрелая когорта с 14 сутками наблюдения.' : `${h.newSpeakers} из ${h.newcomerCount} за первые 7 суток. ${report.model.scoredDays < days ? 'За доступную часть периода.' : ''}`} />
        <StatTile label="Доля трёх авторов" value={fmt(h.concentration, '%')} hint="Топ-3 по сообщениям. Это концентрация разговора, не оценка качества." />
        <StatTile label="Последний состав" value={fmt(h.memberCount)} hint={`${h.mau} известных авторов за период. Снимок Telegram: ${h.memberCountAt ? new Date(h.memberCountAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК' : 'время неизвестно'}.`} />
        <StatTile label="Сообщений учтено" value={fmt(h.messages)} hint={h.messagesPerDay == null ? 'Среднее не показано: наблюдение периода неполное.' : `${fmt(h.messagesPerDay)} в день, включая тихие дни.`} />
      </div></Section>
      {report.scoreSeries.filter(s => s.value != null).length > 1 && <Section title="Динамика Пульса" subtitle={`Полные оценки за скользящие ${days} дней.`}><TrendLine series={report.scoreSeries} label="Пульс, баллы · шкала 0–100" maxValue={100} /></Section>}
      <Section title="Климат и модерация" subtitle={`События доступного журнала за период${report.quality.moderationFrom ? `; первое доступное событие ${dateLabel(report.quality.moderationFrom)}` : ''}. Счётчики действий отдельно от оценки климата.`}><div className="grid grid-cols-2 gap-2">
        <StatTile label="Подтверждённые удаления" value={fmt(report.moderation.blockedMessages)} hint={`${report.moderation.pendingDeletions} без подтверждения повторной попытки; ${report.moderation.unconfirmedDeletions} со старым неизвестным результатом. ${report.moderation.culturalRewrites} с перефразом.`} />
        <StatTile label="Мягкие ответы" value={fmt(report.moderation.interventions)} hint={`${report.moderation.sanctionedResponses} ответов сопровождались санкцией и сюда не входят.`} />
        <StatTile label="Эпизоды конфликта" value={fmt(report.moderation.conflicts)} hint="Уникальные эпизоды, а не число событий в журнале." />
        <StatTile label="Эпизоды травли" value={fmt(report.moderation.harassment)} hint="Отдельная категория эпизодов." />
        <StatTile label="Адресаты нарушений" value={fmt(report.moderation.affectedUsers)} hint="Уникальные люди по журналу за период." />
        <StatTile label="Завершено / обострялось" value={`${report.moderation.resolvedEpisodes} / ${report.moderation.escalatedEpisodes}`} hint="По всем категориям эпизодов; группы могут пересекаться." />
      </div>{report.moderation.temporaryRisks.length > 0 && <details className="mt-3"><summary className="min-h-11 cursor-pointer text-[12px] text-white">Текущие сигналы риска · {report.moderation.temporaryRisks.length}</summary><p className="mb-2 text-[11px] leading-relaxed text-[#A1A1AA]">На сейчас, независимо от периода. Оценка затухает со временем; это не характеристика человека и не автоматическая санкция.</p>{report.moderation.temporaryRisks.map(r => <details key={r.tgUserId} className="border-t border-white/[0.06] py-2"><summary className="min-h-8 cursor-pointer text-[12px] text-[#D4D4D8]">{r.label} · {r.score} / 100 · {r.evidenceCount} свидетельств</summary>{r.evidence.map((e, i) => <p key={i} className="mt-2 text-[11px] leading-relaxed text-[#A1A1AA]">{e.category} · {e.severity}: {e.text}</p>)}</details>)}</details>}</Section>
      <Section title="Сообщения по дням" subtitle="Разрывы — нет данных. При неполном наблюдении числа показывают только учтённые сообщения."><TrendLine series={report.series.map(s => ({ day: s.day, value: s.messages }))} label="Сообщений в день" /></Section>
      <Section title="Когда чат живой" subtitle="Чем ярче клетка, тем больше сообщений. Только метаданные v2, часы Москвы."><ActivityHeatmap matrix={report.heatmap} /></Section>
      <Section title="Приток и отток" subtitle={h.netGrowth == null ? 'Полнота переходов не подтверждена: чистый прирост не вычислен.' : `Чистый прирост за период: ${signed(h.netGrowth)}`}><JoinLeaveChart series={report.series} /></Section>
      <Section title="Регулярность авторов" subtitle="Только писавшие люди: регулярно — ≥ половины дней, часто — ≥ четверти, эпизодически — реже, разово — один день. Молчащие участники по сообщениям не определяются."><StackedBar items={report.orbit.map((o, i) => ({ label: o.tier, value: o.count, color: PULSE_COLORS[i]! }))} /></Section>
      <Section title="Кто говорит" subtitle="Топ по зарегистрированным сообщениям людей за период."><RankedBars items={report.topParticipants.map(p => ({ key: p.tgUserId, label: p.username ? `@${p.username}` : p.displayName ?? `ID ${p.tgUserId}`, href: p.username ? `https://t.me/${p.username}` : undefined, value: p.messages, hint: `${p.share}%` }))} /></Section>
      <Section title="Удержание новичков" subtitle="Первые наблюдавшиеся вступления в выбранном периоде. Доля писавших в личные 7-дневные окна после вступления. Малые когорты не прогнозируют будущих новичков."><CohortGrid cohorts={report.cohorts} /></Section>
      <Section title="Известный стаж" subtitle={`Дата вступления известна для ${report.quality.knownTenure} участников${report.quality.unknownTenure == null ? '' : `; для ${report.quality.unknownTenure} нет надёжной даты`}. Список может быть неполным.`}><StackedBar items={report.tenure.map((t, i) => ({ label: t.bucket, value: t.count, color: PULSE_COLORS[i]! }))} /></Section>
      <GlassCard><button onClick={() => setShowTable(v => !v)} aria-expanded={showTable} className="flex min-h-11 w-full items-center gap-2 text-left text-[13px] text-white"><Activity size={16} /><span className="flex-1">Таблица данных</span><span className="text-[#A1A1AA]">{showTable ? 'скрыть' : 'показать'}</span></button>{showTable && <div className="mt-2 max-h-80 overflow-auto"><table className="w-full text-[11px]"><caption className="pb-2 text-left text-[#A1A1AA]">* — неполное наблюдение; — нет данных.</caption><thead className="sticky top-0 bg-[#121214] text-[#A1A1AA]"><tr>{['День', 'Сообщ.', 'Авторы', '+', '−'].map(x => <th key={x} className="py-2 text-right first:text-left">{x}</th>)}</tr></thead><tbody>{[...report.series].reverse().map(s => <tr key={s.day} className="border-t border-white/[0.05] text-right tabular-nums text-[#D4D4D8]"><td className="py-2 text-left">{s.day.slice(5)}{s.observed ? '' : '*'}</td><td>{fmt(s.messages)}</td><td>{fmt(s.activeUsers)}</td><td>{fmt(s.joins)}</td><td>{fmt(s.leaves)}</td></tr>)}</tbody></table></div>}</GlassCard>
    </>}
  </div>
}
