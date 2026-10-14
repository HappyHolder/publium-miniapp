import { GlassCard } from '@/components/ui/GlassCard'
import type { AxisKey, PulseReport as V2Report } from './pulseTypes'

export type PulseTransition = { status: 'unavailable'; primary: 'legacy'; reason: string } | {
  status: 'ready'; primary: 'legacy'; period: { from: string; to: string; days: number }
  model: Pick<V2Report['model'], 'version' | 'status' | 'scoredDays' | 'scoredFrom' | 'scoredTo' | 'availableAxes' | 'bounds' | 'details' | 'population'> & {
    score: number | null; axes: Record<AxisKey, number | null>; scoreDelta: number | null
  }
  historical: null | {
    period: { from: string; to: string; days: number }; axes: Record<AxisKey, number | null>
    metrics: { participation: number | null; repeat: number | null; breadth: number | null; returning: number | null }
    legacy: { score: number; axes: Record<AxisKey, number> }; preliminary: true
  }
  history: { firstRecordedDay: string | null; recordedDays: number; series: { day: string; observed: boolean; messages: number | null }[]; authorTiers: { tier: string; count: number }[] }
}
export const pulseDateLabel = (day: string) => day.split('-').reverse().join('.')
const labels: Record<AxisKey, string> = { activity:'Активность', engagement:'Вовлечённость', climate:'Климат', growth:'Рост', core:'Ядро' }
const keys = Object.keys(labels) as AxisKey[]
const fmt = (n: number | null | undefined, suffix='') => n == null ? '—' : `${Math.round(n*10)/10}${suffix}`

export function PulseTransitionPanel({ transition }: { transition: PulseTransition | undefined }) {
  if (!transition || transition.status === 'unavailable') return <GlassCard><h3 className="text-sm font-semibold text-white">Новая модель · v2</h3><p role="status" className="mt-2 text-xs leading-relaxed text-[#A1A1AA]">{transition?.reason ?? 'Сравнение с новой моделью пока недоступно. Прежний индекс и история сохранены.'}</p></GlassCard>
  const { model, historical, period } = transition
  return <GlassCard>
    <div data-testid="pulse-transition">
      <p className="text-xs font-semibold text-orange-300">Новая модель · v2</p>
      <p className="mt-1 text-xs leading-relaxed text-[#A1A1AA]">{pulseDateLabel(period.from)} — {pulseDateLabel(period.to)} · {period.days} полных дней, Москва. Сегодня не входит.</p>
      {model.score == null ? <p data-testid="pulse-v2-status" className="mt-3 text-base font-semibold text-white">Для общего балла v2 пока недостаточно данных</p> : <>
        <div className="mt-3 flex items-end gap-2"><strong data-testid="pulse-v2-score" className="text-[40px] leading-none tabular-nums text-white">{model.score}</strong><span className="text-xs text-[#A1A1AA]">из 100</span></div>
        <p className="mt-2 text-sm text-white">{model.status==='complete'?'Оценены все пять осей':`Предварительная оценка · ${model.availableAxes.length} из 5 осей`}</p>
      </>}
      <p className="mt-2 text-xs leading-relaxed text-[#A1A1AA]">{model.scoredDays ? `Расчёт по ${model.scoredDays} дн.: ${pulseDateLabel(model.scoredFrom!)} — ${pulseDateLabel(model.scoredTo)}.` : 'Для v2 ещё нет непрерывного интервала полных дней сбора.'} Для индекса нужны минимум 7 дней и три оси, включая активность. Исторические данные сохранены в отчёте ниже.</p>
      <div className="mt-3 divide-y divide-white/[0.08]">{keys.map(key => {
        const value=model.axes[key], detail=model.details[key]
        return <details key={key} data-testid={`pulse-v2-${key}`}>
          <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-xs text-white focus-visible:outline-orange-300"><span>{labels[key]}</span><span className="text-[#C4C4CC]">{value==null?'Недостаточно данных':`${Math.round(value)} / 100${detail.preliminary?' · предварительно':''}`} ＋</span></summary>
          <div className="space-y-2 pb-3 text-xs leading-relaxed text-[#A1A1AA]">{detail.formula&&<p>{detail.formula}</p>}<p>{detail.reason}</p>{detail.metrics.map(m=><div key={m.label} className="rounded-lg bg-white/[0.04] p-2.5"><p className="text-white">{m.label}: <strong>{fmt(m.value,m.unit==='%'?'%':` ${m.unit}`)}</strong></p><p>{m.explanation}</p>{m.numerator!=null&&m.denominator!=null&&<p>Числитель / знаменатель: {fmt(m.numerator)} / {fmt(m.denominator)}</p>}{m.score!=null&&<p className="text-orange-300">По шкале: {fmt(m.score)} / 100</p>}</div>)}</div>
        </details>
      })}</div>
      {historical && <details open={model.score==null} className="mt-3 rounded-xl border border-orange-300/15 bg-orange-300/[0.035] px-3">
        <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold text-orange-200">Что удалось пересчитать из истории</summary>
        <p className="text-xs leading-relaxed text-[#C4C4CC]">{pulseDateLabel(historical.period.from)} — {pulseDateLabel(historical.period.to)} · {historical.period.days} дн. Одинаковые даты в обеих колонках. Оценки v2 здесь предварительные: полнота старого сбора не подтверждена.</p>
        <table className="my-3 w-full text-left text-xs tabular-nums"><caption className="sr-only">Сравнение методик на сохранённой истории</caption><thead className="text-[#A1A1AA]"><tr><th className="pb-2 font-normal">Ось</th><th className="pb-2 text-right font-normal">Прежняя</th><th className="pb-2 text-right font-normal">v2*</th></tr></thead><tbody>{keys.map(key=><tr key={key} className="border-t border-white/[0.06] text-white"><th className="py-2 font-normal">{labels[key]}</th><td className="text-right">{historical.legacy.axes[key]}</td><td className="text-right">{historical.axes[key]==null?'—':Math.round(historical.axes[key]!)}</td></tr>)}</tbody></table>
        <p className="mb-2 text-xs leading-relaxed text-[#A1A1AA]">* Участие в день: {fmt(historical.metrics.participation,'%')}; повторных дней за неделю: {fmt(historical.metrics.repeat)}. Ширина актива: {fmt(historical.metrics.breadth)} / 100; возвращение авторов: {fmt(historical.metrics.returning,'%')}.</p>
        <p className="mb-3 text-xs leading-relaxed text-[#A1A1AA]">В старой истории нет всех адресатов ответов, охвата AI-анализа и надёжного журнала выходов. Прочерк означает неизвестную оценку. Эти две оси не смешиваются со старыми оценками в новый общий балл.</p>
      </details>}
      <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-xs text-orange-300">Как считается v2 и почему баллы отличаются</summary><div className="space-y-2 text-xs leading-relaxed text-[#A1A1AA]">
        <p>Пульс v2 = 100 − √среднего (100 − балл оси)². Слабая ось заметнее влияет на результат. При предварительном расчёте участвуют только доступные оси; их состав указан выше.</p>
        {model.score!=null&&model.availableAxes.length<5&&<p>С учётом неизвестных осей полный индекс мог бы лежать от {fmt(model.bounds[0])} до {fmt(model.bounds[1])}. Это границы возможных значений, не доверительный интервал.</p>}
        <p>Прежний индекс остаётся основным на время проверки перехода. Разница между методиками не означает изменение здоровья чата. Автоматического переключения по числу прошедших дней нет.</p>
        <p>{model.scoreDelta==null?'Динамика v2 появится для двух полных сопоставимых периодов с пятью осями.':`Изменение v2 к предыдущему полному периоду по той же методике: ${model.scoreDelta>0?'+':''}${fmt(model.scoreDelta)} п.`}</p>
        <p>{model.population}</p><p>Шкалы — ориентиры модели Publium, а не универсальные нормы. Контроль сбора проверяет доступность webhook и права бота, но не гарантирует доставку каждого сообщения Telegram.</p>
      </div></details>
    </div>
  </GlassCard>
}
