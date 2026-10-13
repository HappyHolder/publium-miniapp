/**
 * pulseCharts.tsx — hand-rolled SVG chart primitives for the «Пульс» tab.
 *
 * No chart library: the mini app loads inside Telegram where bundle weight
 * matters, and the forms we need (pentagon radar, hour×weekday heatmap, cohort
 * triangle) either don't exist in libraries or come out wrong.
 *
 * Palette is NOT eyeballed — both sets were run through the dataviz validator
 * against this app's dark surface (#121214):
 *   categorical  → lightness band, chroma floor, CVD separation, contrast: PASS
 *   sequential   → monotone lightness, step gaps, light-end contrast: PASS
 * Changing a colour means re-running the validator, not guessing.
 */

import { useState } from 'react'

/** Categorical hues, assigned in FIXED order — never cycled, never generated. */
export const PULSE_COLORS = ['#E36207', '#2B86D9', '#0F9E6E', '#8C5FD9', '#B8891A'] as const
/** Sequential ramp (one hue, light→dark) for magnitude grids. */
export const PULSE_RAMP = ['#6B3D12', '#96500B', '#C05F04', '#E8802B', '#FFA968'] as const

const INK = '#EDEDEF'
const INK_MUTED = '#8A8A92'
const INK_FAINT = '#55555D'
const GRID = 'rgba(255,255,255,0.07)'

/** Picks a ramp step for a 0..1 intensity (0 = empty cell, drawn as surface). */
export function rampStep(t: number): string {
  if (t <= 0) return 'rgba(255,255,255,0.04)'
  const idx = Math.min(PULSE_RAMP.length - 1, Math.floor(t * PULSE_RAMP.length))
  return PULSE_RAMP[idx]!
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

export function Sparkline({ values, width = 96, height = 28, color = PULSE_COLORS[0] }: {
  values: number[]; width?: number; height?: number; color?: string
}) {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const step = width / (values.length - 1)
  const y = (v: number) => height - 2 - (v / max) * (height - 4)
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="overflow-visible">
      <path d={area} fill={color} opacity={0.14} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ─── Pentagon radar ───────────────────────────────────────────────────────────

export interface RadarAxis { key: string; label: string; value: number }

/**
 * A radar is a fast "where is it weak" read, but it CANNOT be read precisely —
 * so every axis also carries its exact number next to the shape (see PulseTab).
 *
 * Axis captions are OFF by default: on a 375px screen they overflow the SVG box
 * and collide with the numbers beside it, and they'd only repeat what that list
 * already says. `showLabels` is there for a wide layout.
 */
export function PentagonRadar({ axes, size = 240, showLabels = false }: { axes: RadarAxis[]; size?: number; showLabels?: boolean }) {
  const cx = size / 2, cy = size / 2, r = size * (showLabels ? 0.3 : 0.4)
  const n = axes.length || 5
  const point = (i: number, radius: number) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius] as const
  }
  const ring = (radius: number) => Array.from({ length: n }, (_, i) => point(i, radius).join(',')).join(' ')
  const shape = axes.map((a, i) => point(i, (Math.max(0, Math.min(100, a.value)) / 100) * r).join(',')).join(' ')

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Радар по пяти осям">
      {[0.25, 0.5, 0.75, 1].map(k => (
        <polygon key={k} points={ring(r * k)} fill="none" stroke={GRID} strokeWidth={1} />
      ))}
      {axes.map((_, i) => {
        const [x, y] = point(i, r)
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={GRID} strokeWidth={1} />
      })}
      <polygon points={shape} fill={PULSE_COLORS[0]} fillOpacity={0.22} stroke={PULSE_COLORS[0]} strokeWidth={2} strokeLinejoin="round" />
      {axes.map((a, i) => {
        const [x, y] = point(i, (Math.max(0, Math.min(100, a.value)) / 100) * r)
        return <circle key={a.key} cx={x} cy={y} r={3.5} fill={PULSE_COLORS[0]} stroke="#121214" strokeWidth={2} />
      })}
      {showLabels && axes.map((a, i) => {
        const [x, y] = point(i, r + 16)
        const anchor = Math.abs(x - cx) < 6 ? 'middle' : x > cx ? 'start' : 'end'
        return (
          <text key={a.key} x={x} y={y} textAnchor={anchor} dominantBaseline="middle" fontSize={10.5} fill={INK_MUTED}>
            {a.label}
          </text>
        )
      })}
    </svg>
  )
}

// ─── Hour × weekday heatmap ───────────────────────────────────────────────────

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

export function ActivityHeatmap({ matrix }: { matrix: number[][] }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null)
  const max = Math.max(1, ...matrix.flat())
  const cell = 11, gap = 2, labelW = 22, topH = 12

  return (
    <div className="relative">
      <svg
        width="100%"
        viewBox={`0 0 ${labelW + 24 * (cell + gap)} ${topH + 7 * (cell + gap)}`}
        role="img"
        aria-label="Активность по часам и дням недели"
        className="overflow-visible"
      >
        {[0, 6, 12, 18, 23].map(h => (
          <text key={h} x={labelW + h * (cell + gap) + cell / 2} y={8} textAnchor="middle" fontSize={7.5} fill={INK_FAINT}>{h}</text>
        ))}
        {WEEKDAYS.map((wd, d) => (
          <text key={wd} x={0} y={topH + d * (cell + gap) + cell * 0.8} fontSize={7.5} fill={INK_FAINT}>{wd}</text>
        ))}
        {matrix.map((row, d) =>
          row.map((v, h) => (
            <rect
              key={`${d}-${h}`}
              x={labelW + h * (cell + gap)}
              y={topH + d * (cell + gap)}
              width={cell}
              height={cell}
              rx={2.5}
              fill={rampStep(v / max)}
              stroke={hover?.d === d && hover?.h === h ? INK : 'transparent'}
              strokeWidth={1.5}
              onMouseEnter={() => setHover({ d, h })}
              onMouseLeave={() => setHover(null)}
              onTouchStart={() => setHover({ d, h })}
              className="cursor-pointer"
            />
          )),
        )}
      </svg>
      <div className="mt-1.5 flex items-center justify-between">
        <p className="text-[10px] text-[#55555D]" aria-live="polite">
          {hover
            ? `${WEEKDAYS[hover.d]}, ${hover.h}:00 — ${matrix[hover.d]?.[hover.h] ?? 0} сообщ.`
            : 'Часы по Москве'}
        </p>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-[#55555D]">меньше</span>
          {PULSE_RAMP.map(c => <span key={c} className="h-2 w-2.5 rounded-[2px]" style={{ background: c }} />)}
          <span className="text-[9px] text-[#55555D]">больше</span>
        </div>
      </div>
    </div>
  )
}

// ─── Horizontal stacked bar (part-to-whole) ───────────────────────────────────

export function StackedBar({ items }: { items: { label: string; value: number; color: string }[] }) {
  const total = items.reduce((n, i) => n + i.value, 0)
  if (!total) return <p className="text-[12px] text-[#55555D]">Нет данных</p>
  return (
    <div>
      {/* 2px surface gaps between segments keep adjacent fills readable */}
      <div className="flex h-3.5 w-full gap-[2px] overflow-hidden rounded-full">
        {items.filter(i => i.value > 0).map(i => (
          <div key={i.label} style={{ width: `${(i.value / total) * 100}%`, background: i.color }} className="h-full first:rounded-l-full last:rounded-r-full" />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {items.map(i => (
          <span key={i.label} className="flex items-center gap-1.5 text-[11px] text-[#A1A1AA]">
            <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
            {i.label}
            <span className="tabular-nums text-[#EDEDEF]">{i.value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Diverging bars (joins up / leaves down from a zero baseline) ─────────────

export function JoinLeaveChart({ series }: { series: { day: string; joins: number; leaves: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (!series.length) return null
  const max = Math.max(1, ...series.map(s => Math.max(s.joins, s.leaves)))
  const h = 74, mid = h / 2
  const barW = Math.max(2, Math.min(10, 320 / series.length - 2))
  const width = series.length * (barW + 2)

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${width} ${h}`} role="img" aria-label="Приток и отток участников" className="overflow-visible">
        <line x1={0} y1={mid} x2={width} y2={mid} stroke={GRID} strokeWidth={1} />
        {series.map((s, i) => {
          const x = i * (barW + 2)
          const up = (s.joins / max) * (mid - 4)
          const down = (s.leaves / max) * (mid - 4)
          return (
            <g key={s.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)} className="cursor-pointer">
              {/* invisible wide hit area — bigger than the mark, per interaction spec */}
              <rect x={x - 1} y={0} width={barW + 3} height={h} fill="transparent" />
              {s.joins > 0 && <rect x={x} y={mid - up} width={barW} height={up} rx={2} fill={PULSE_COLORS[2]} opacity={hover === null || hover === i ? 1 : 0.45} />}
              {s.leaves > 0 && <rect x={x} y={mid} width={barW} height={down} rx={2} fill={PULSE_COLORS[3]} opacity={hover === null || hover === i ? 1 : 0.45} />}
            </g>
          )
        })}
      </svg>
      <div className="mt-1.5 flex items-center justify-between">
        <p className="text-[10px] text-[#55555D]" aria-live="polite">
          {hover != null && series[hover]
            ? `${series[hover]!.day.slice(5)} — +${series[hover]!.joins} / −${series[hover]!.leaves}`
            : 'Вверх — вступили, вниз — вышли'}
        </p>
        <div className="flex gap-3">
          <span className="flex items-center gap-1 text-[10px] text-[#A1A1AA]"><span className="h-2 w-2 rounded-full" style={{ background: PULSE_COLORS[2] }} />вступили</span>
          <span className="flex items-center gap-1 text-[10px] text-[#A1A1AA]"><span className="h-2 w-2 rounded-full" style={{ background: PULSE_COLORS[3] }} />вышли</span>
        </div>
      </div>
    </div>
  )
}

// ─── Line chart for a single series (messages per day) ────────────────────────

export function TrendLine({ series, label }: { series: { day: string; value: number }[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  if (series.length < 2) return null
  const w = 320, h = 80, pad = 4
  const max = Math.max(1, ...series.map(s => s.value))
  const x = (i: number) => (i / (series.length - 1)) * w
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2)
  const line = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ')

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="overflow-visible"
        onMouseLeave={() => setHover(null)}>
        <path d={`${line} L${w},${h} L0,${h} Z`} fill={PULSE_COLORS[0]} opacity={0.12} />
        <path d={line} fill="none" stroke={PULSE_COLORS[0]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hover != null && series[hover] && (
          <g>
            <line x1={x(hover)} y1={0} x2={x(hover)} y2={h} stroke={GRID} strokeWidth={1} />
            <circle cx={x(hover)} cy={y(series[hover]!.value)} r={4} fill={PULSE_COLORS[0]} stroke="#121214" strokeWidth={2} />
          </g>
        )}
        {series.map((_, i) => (
          <rect key={i} x={x(i) - w / series.length / 2} y={0} width={w / series.length} height={h} fill="transparent"
            onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} className="cursor-pointer" />
        ))}
      </svg>
      <p className="mt-1 text-[10px] text-[#55555D]" aria-live="polite">
        {hover != null && series[hover] ? `${series[hover]!.day.slice(5)} — ${series[hover]!.value}` : label}
      </p>
    </div>
  )
}

// ─── Ranked horizontal bars (top participants) ────────────────────────────────

export function RankedBars({ items }: { items: { key?: string; label: string; value: number; hint?: string; href?: string }[] }) {
  if (!items.length) return <p className="text-[12px] text-[#55555D]">Нет данных</p>
  const max = Math.max(...items.map(i => i.value), 1)
  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div key={item.key ?? item.label} className="flex min-h-11 items-center gap-2">
          <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-[#55555D]">{i + 1}</span>
          {item.href ? (
            <a href={item.href} target="_blank" rel="noopener noreferrer" title={item.label} aria-label={`Открыть ${item.label} в Telegram`} className="flex min-h-11 w-[100px] shrink-0 items-center truncate rounded-sm text-[11px] font-medium text-[#D4D4D8] underline decoration-white/20 underline-offset-2 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6A00]">
              {item.label}
            </a>
          ) : (
            <span title={item.label} className="w-[100px] shrink-0 truncate text-[11px] text-[#A1A1AA]">{item.label}</span>
          )}
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/[0.04]">
            <div className="h-full rounded-full" style={{ width: `${(item.value / max) * 100}%`, background: i === 0 ? PULSE_COLORS[0] : 'rgba(227,98,7,0.55)' }} />
          </div>
          <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-[#EDEDEF]">{item.value}</span>
          {item.hint && <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-[#55555D]">{item.hint}</span>}
        </div>
      ))}
    </div>
  )
}

// ─── Cohort retention grid ────────────────────────────────────────────────────

export function CohortGrid({ cohorts }: { cohorts: { cohort: string; size: number; retention: number[] }[] }) {
  if (!cohorts.length) return <p className="text-[12px] text-[#55555D]">Пока нет когорт — нужны данные хотя бы за неделю</p>
  const weeks = Math.max(...cohorts.map(c => c.retention.length))
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-[2px] text-[10px]">
        <thead>
          <tr>
            <th className="text-left font-normal text-[#55555D]">Неделя</th>
            <th className="font-normal text-[#55555D]">Чел.</th>
            {Array.from({ length: weeks }, (_, w) => <th key={w} className="font-normal text-[#55555D]">Н{w}</th>)}
          </tr>
        </thead>
        <tbody>
          {cohorts.map(c => (
            <tr key={c.cohort}>
              <td className="whitespace-nowrap text-[#A1A1AA]">{c.cohort.slice(5)}</td>
              <td className="text-center tabular-nums text-[#A1A1AA]">{c.size}</td>
              {Array.from({ length: weeks }, (_, w) => {
                const v = c.retention[w]
                return (
                  <td key={w} className="h-6 min-w-[26px] rounded-[3px] text-center tabular-nums"
                    style={{ background: v == null ? 'transparent' : rampStep(v / 100), color: v != null && v > 50 ? '#121214' : INK_MUTED }}>
                    {v == null ? '' : `${Math.round(v)}`}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-[#55555D]">% участников когорты, писавших в эту неделю</p>
    </div>
  )
}
