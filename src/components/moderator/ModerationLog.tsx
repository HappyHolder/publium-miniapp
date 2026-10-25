import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, History, Loader2, RefreshCw, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react'
import { API_BASE } from '@/lib/api'
import { getTelegramInitData, moderatorFetch } from '@/lib/telegram'
import { GlassCard } from '@/components/ui/GlassCard'
import { ModeratorHelpSheet, ModeratorInfoButton } from './ModeratorHelpSheet'

type Person = { username?: string|null; displayName?: string|null }
type Event = { id: string; label: string; categoryLabel: string; reason: string; actionLabel: string; statusLabel: string; confidence: number|null; createdAt: string; feedback: string|null; reversedAt: string|null; actors: Person[]; messages: { messageId: number|null; author: Person; text: string; excerpt: string|null }[]; response: string|null; suggestedRewrite: string|null; deliveryError: string|null; canRate: boolean; canReverse: boolean }
type Filter = 'important'|'profanity'|'conversation'|'errors'|'all'
const filters: [Filter,string][] = [['important','Важное'],['profanity','Мат'],['conversation','Конфликты'],['errors','Ошибки'],['all','Все']]
const name = (p: Person) => p.displayName ? p.displayName + (p.username ? ' · @' + p.username.replace(/^@/, '') : '') : p.username ? '@' + p.username.replace(/^@/, '') : 'Участник'
const button = 'flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[11px] border border-white/[0.07] px-3 text-[11px] text-[#A1A1AA] hover:bg-white/[0.04] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6A00]/50'

export function ModerationLog({ communityId }: { communityId: string }) {
  const [events, setEvents] = useState<Event[]>([]), [cursor, setCursor] = useState<string|null>(null), [filter, setFilter] = useState<Filter>('important')
  const [loading, setLoading] = useState(false), [collapsed, setCollapsed] = useState(true), [busyId, setBusyId] = useState<string|null>(null), [error, setError] = useState(''), [helpOpen, setHelpOpen] = useState(false)
  const request = useRef(0), initData = getTelegramInitData()
  const load = useCallback(async (before?: string) => {
    if (!initData) return
    const seq = ++request.current
    setLoading(true); setError('')
    if (!before) { setEvents([]); setCursor(null) }
    try {
      const q = new URLSearchParams({ kind: filter }); if (before) q.set('before', before)
      const r = await moderatorFetch(`${API_BASE}/api/moderator/communities/${communityId}/events?${q}`), d = await r.json() as { events?: Event[]; nextCursor?: string|null; error?: string }
      if (!r.ok) throw new Error(d.error ?? 'Не удалось загрузить журнал')
      if (seq === request.current) { setEvents(prev => before ? [...prev, ...(d.events ?? []).filter(e => !prev.some(p => p.id === e.id))] : d.events ?? []); setCursor(d.nextCursor ?? null) }
    } catch (e) { if (seq === request.current) setError(e instanceof Error ? e.message : 'Не удалось загрузить журнал') } finally { if (seq === request.current) setLoading(false) }
  }, [communityId, filter, initData])
  useEffect(() => { if (!collapsed) void load(); return () => { request.current++ } }, [collapsed, load])
  const mutate = async (event: Event, action: 'reverse'|'feedback', value?: string) => {
    if (!initData || busyId) return
    setBusyId(event.id); setError('')
    try {
      const r = await moderatorFetch(`${API_BASE}/api/moderator/communities/${communityId}/events/${event.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value ? { value } : {}) })
      const d = await r.json() as { error?: string }
      if (!r.ok) throw new Error(d.error ?? 'Не удалось сохранить действие')
      if (action === 'reverse') await load()
      else setEvents(prev => prev.map(e => e.id === event.id ? { ...e, feedback: value ?? null } : e))
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить действие') } finally { setBusyId(null) }
  }
  return <GlassCard>
    <div className="flex items-center gap-1"><button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-[14px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6A00]"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-white/[0.05] text-[#8A8A93]"><History size={18}/></span><span className="min-w-0 flex-1"><span className="text-[14px] font-semibold text-white">Журнал модерации</span><span className="mt-0.5 block text-[11px] text-[#777780]">Сообщения, причины и результат действий</span></span><ChevronDown size={18} className={`shrink-0 text-[#66666E] transition-transform ${collapsed ? '-rotate-90' : ''}`}/></button><ModeratorInfoButton onClick={() => setHelpOpen(true)} label="Справка: Журнал модерации"/></div>
    {!collapsed && <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-1.5">{filters.map(([key,label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={`${button} ${filter === key ? 'border-[#FF6A00]/30 bg-[#FF6A00]/10 text-[#FF6A00]' : ''}`}>{label}</button>)}<button type="button" onClick={() => void load()} disabled={loading} aria-label="Обновить журнал" className={button}><RefreshCw size={15} className={loading ? 'animate-spin' : ''}/></button></div>
      {error && <p role="alert" className="rounded-[11px] bg-red-400/10 px-3 py-3 text-[12px] text-red-300">{error}<button type="button" onClick={() => void load()} className="ml-2 min-h-11 underline">Повторить</button></p>}
      {!loading && !error && events.length === 0 && <p className="rounded-[13px] border border-dashed border-white/[0.08] px-4 py-8 text-center text-[12px] text-[#777780]">В этом разделе пока нет событий</p>}
      {events.map(event => <article key={event.id} className="min-w-0 space-y-3 rounded-[14px] border border-white/[0.07] bg-white/[0.025] p-3">
        <div className="flex flex-wrap items-center gap-1.5"><h4 className="text-[12px] font-semibold text-white">{event.label}</h4><span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-[#A1A1AA]">{event.categoryLabel}</span>{event.reversedAt && <span className="text-[10px] text-[#8A8A93]">Санкция отменена</span>}{event.feedback && <span className={`text-[10px] ${event.feedback === 'CONFIRMED' ? 'text-emerald-300' : 'text-amber-300'}`}>{event.feedback === 'CONFIRMED' ? 'Верное решение' : 'Ошибка AI'}</span>}</div>
        {event.messages.length > 0 ? event.messages.map((m,i) => <div key={i} className="min-w-0"><p className="break-words text-[12px] font-medium text-[#D4D4D8]">{name(m.author)}</p><blockquote className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-[#FF6A00]/40 bg-[#0B0B0D]/50 py-2 pl-3 pr-2 text-[12px] leading-relaxed text-[#A1A1AA]">{m.text}</blockquote></div>) : <div>{event.actors.length > 0 && <p className="break-words text-[12px] text-[#D4D4D8]">{event.actors.map(name).join(', ')}</p>}<p className="mt-1 text-[11px] text-[#777780]">Текст исходного сообщения не сохранился.</p></div>}
        {event.reason && <p className="break-words text-[12px] leading-relaxed text-[#A1A1AA]">{event.reason}</p>}
        <div className="text-[11px] leading-relaxed text-[#8A8A93]"><p>{event.actionLabel}</p><p>{event.statusLabel}</p>{event.deliveryError && <p className="text-amber-300">{event.deliveryError}</p>}</div>
        {(event.response || event.suggestedRewrite) && <details className="text-[11px] text-[#8A8A93]"><summary className="flex min-h-11 cursor-pointer items-center">Ответ бота и исправление</summary>{event.response && <p className="whitespace-pre-wrap break-words py-2">{event.response}</p>}{event.suggestedRewrite && <blockquote className="whitespace-pre-wrap break-words border-l border-white/10 pl-3">{event.suggestedRewrite}</blockquote>}</details>}
        <p className="text-[10px] text-[#777780]">{new Date(event.createdAt).toLocaleString('ru-RU')}{event.confidence != null && ` · уверенность ${Math.round(event.confidence * 100)}%`}</p>
        {(event.canRate || event.canReverse) && <div className="flex flex-wrap gap-2">
          {event.canRate && <><button type="button" aria-label="Решение верное" aria-pressed={event.feedback === 'CONFIRMED'} disabled={busyId !== null} onClick={() => void mutate(event,'feedback','CONFIRMED')} className={`${button} ${event.feedback === 'CONFIRMED' ? 'text-emerald-300' : ''}`}><ThumbsUp size={14}/></button><button type="button" aria-label="Решение ошибочное" aria-pressed={event.feedback === 'FALSE_POSITIVE'} disabled={busyId !== null} onClick={() => void mutate(event,'feedback','FALSE_POSITIVE')} className={`${button} ${event.feedback === 'FALSE_POSITIVE' ? 'text-amber-300' : ''}`}><ThumbsDown size={14}/></button></>}
          {event.canReverse && <button type="button" disabled={busyId !== null} onClick={() => void mutate(event,'reverse')} className={button}>{busyId === event.id ? <Loader2 size={14} className="animate-spin"/> : <RotateCcw size={14}/>}Отменить санкцию</button>}
        </div>}
      </article>)}
      {loading && <div role="status" className="flex justify-center py-4 text-[#8A8A93]"><Loader2 size={18} className="animate-spin"/><span className="sr-only">Загрузка событий</span></div>}
      {cursor && !loading && <button type="button" onClick={() => void load(cursor)} className={`${button} w-full`}>Загрузить ещё</button>}
    </div>}
    <ModeratorHelpSheet kind="log" open={helpOpen} onClose={() => setHelpOpen(false)}/>
  </GlassCard>
}
