import { tonCheckout } from '@/lib/tonCheckout'
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Image, Loader2, MessageCircle, ShieldCheck, Sparkles, Ticket, Users, WandSparkles } from 'lucide-react'
import { useTonConnectUI } from '@tonconnect/ui-react'
import { useApp } from '@/context/AppContext'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { GramMark } from '@/components/icons/GramMark'
import { getTelegramInitData } from '@/lib/telegram'
import { API_BASE } from '@/lib/api'
import { PLAN_PRICING, tierToServer } from '@/lib/payments'
import { PLAN_NAMES, SUBSCRIPTION_LIMITS } from '@/lib/subscriptionCatalog'
import type { PlanTier, Subscription } from '@/types'

interface PlansScreenProps { onBack: () => void }
type PaidTier = Exclude<PlanTier, 'free'>
type ServerSubscription = { tier: string; expiresAt: string | null; quotaResetAt: string | null; usage: Subscription['usage']; limits: Subscription['limits'] }

const TIERS: PlanTier[] = ['free', 'starter', 'creator', 'studio_pro']
const TIER_COPY: Record<PlanTier, { eyebrow: string; description: string }> = {
  free: { eyebrow: 'Начать бесплатно', description: 'Редактор, отложка и базовый AI для одного проекта.' },
  starter: { eyebrow: 'Для автора', description: 'Полный визуальный контент и управление двумя сообществами.' },
  creator: { eyebrow: 'Для бизнеса', description: 'Пять проектов, больше генераций и сильное ядро сообщества.' },
  studio_pro: { eyebrow: 'Для команды', description: 'Максимальные лимиты для студии, агентства или сети каналов.' },
}

const format = (value: number) => new Intl.NumberFormat('ru-RU').format(value)
const formatUsd = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
}).format(value)

function featureRows(tier: PlanTier) {
  const l = SUBSCRIPTION_LIMITS[tier]
  return [
    { icon: WandSparkles, text: `${format(l.textGenerationsLimit)} AI-генераций текста в месяц` },
    { icon: Image, text: l.visualGenerationsLimit ? `${format(l.visualGenerationsLimit)} AI-визуалов в месяц` : 'AI-визуалы не включены' },
    { icon: Sparkles, text: 'Ручной редактор и отложенные посты без ограничений' },
    { icon: MessageCircle, text: `${l.channelLimit} ${l.channelLimit === 1 ? 'канал' : 'каналов'} · ${l.communityChatLimit} ${l.communityChatLimit === 1 ? 'чат' : 'чатов'}` },
    { icon: Users, text: `AI-ассистент: ${format(l.assistantMessagesLimit)} сообщений · Content Manager: ${format(l.contentManagerPostsLimit)} постов` },
    { icon: ShieldCheck, text: l.canUseAiModerator ? `AI-модератор: ${format(l.aiModeratorChecksLimit)} проверок` : 'Обычный модератор без AI' },
    { icon: Users, text: l.canUseCommunityManager ? `Community Manager: ${format(l.communityManagerActionsLimit)} действий` : 'Community Manager не включён' },
    { icon: Users, text: l.communityCorePersonaLimit ? `Community Core: ${l.communityCorePersonaLimit} личностей` : 'Community Core не включён' },
    { icon: ShieldCheck, text: l.customBotChatLimit ? `Персональные боты: ${l.customBotChatLimit} чатов` : 'Персональные боты не включены' },
  ]
}

export function PlansScreen({ onBack }: PlansScreenProps) {
  const { state, showToast, applyServerSubscription } = useApp()
  const currentTier = state.user.subscription.planTier
  const [tonConnectUI] = useTonConnectUI()
  const [promo, setPromo] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [payTier, setPayTier] = useState<PaidTier | null>(null)
  const [paying, setPaying] = useState(false)

  const payWithTon = async (tier: PaidTier) => {
    if (paying) return
    const initData = getTelegramInitData()
    if (!initData) { showToast('Оплата доступна внутри Telegram.', 'error'); return }
    if (!tonConnectUI.account) { await tonConnectUI.openModal().catch(() => undefined); showToast('Подключите кошелёк и нажмите оплатить ещё раз'); return }
    setPaying(true)
    try {
      const data = await tonCheckout(tonConnectUI, 'subscription', tierToServer(tier))
      applyServerSubscription(data.subscription)
      setPayTier(null)
      showToast('Подписка активирована')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка оплаты'
      if (!/reject|cancel|abort|declin/i.test(message)) showToast(message, 'error')
    } finally { setPaying(false) }
  }

  const redeemPromo = async () => {
    const initData = getTelegramInitData()
    if (!initData || !promo.trim() || redeeming) return
    setRedeeming(true)
    try {
      const response = await fetch(`${API_BASE}/api/promo/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, code: promo.trim() }) })
      const data = await response.json().catch(() => ({})) as { subscription?: ServerSubscription; error?: string }
      if (!response.ok || !data.subscription) throw new Error(data.error ?? 'Промокод не принят')
      applyServerSubscription(data.subscription)
      setPromo('')
      showToast('Промокод применён')
    } catch (error) { showToast(error instanceof Error ? error.message : 'Ошибка промокода', 'error') }
    finally { setRedeeming(false) }
  }

  const usage = state.user.subscription.usage

  return <div className="pb-8">
    <PageHeader title="Подписки" subtitle="Один набор сильных AI-моделей. Тариф определяет только объём и доступные инструменты." onBack={onBack} />
    <div className="px-4 space-y-3">
      <section className="rounded-[22px] border border-[#FF6A00]/20 bg-gradient-to-br from-[#FF6A00]/[0.12] via-white/[0.035] to-transparent p-4" aria-label="Использование текущего тарифа">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#FF8A38]">Текущий тариф</p><h2 className="mt-1 text-xl font-bold text-white">{PLAN_NAMES[currentTier]}</h2></div>
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">Активен</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Usage label="AI-тексты" used={usage.text.used} limit={usage.text.limit} />
          <Usage label="AI-визуалы" used={usage.visuals.used} limit={usage.visuals.limit} />
          <Usage label="Ассистент" used={usage.assistant.used} limit={usage.assistant.limit} />
          <Usage label="Content Manager" used={usage.contentManagerPosts.used} limit={usage.contentManagerPosts.limit} />
        </div>
      </section>

      <section className="rounded-[18px] border border-white/[0.08] bg-white/[0.035] p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-white"><Ticket size={15} className="text-[#FF6A00]" /> Есть промокод?</div>
        <div className="flex gap-2"><input value={promo} onChange={event => setPromo(event.target.value.toUpperCase())} onKeyDown={event => { if (event.key === 'Enter') void redeemPromo() }} placeholder="PUBLIUM-XXXX" aria-label="Промокод" className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/[0.09] bg-black/20 px-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#FF6A00]/60 focus:ring-2 focus:ring-[#FF6A00]/20" /><Button onClick={() => void redeemPromo()} disabled={!promo.trim() || redeeming}>{redeeming ? <Loader2 size={16} className="animate-spin" /> : 'Применить'}</Button></div>
      </section>

      <div className="space-y-3">
        {TIERS.map((tier, index) => {
          const current = tier === currentTier
          const paid = tier !== 'free'
          const price = paid ? PLAN_PRICING[tier] : null
          return <motion.article key={tier} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }} className={`relative overflow-hidden rounded-[24px] border p-4 ${current ? 'border-[#FF6A00]/50 bg-[#FF6A00]/[0.09] shadow-[0_0_34px_rgba(255,106,0,0.08)]' : 'border-white/[0.08] bg-white/[0.032]'}`}>
            {tier === 'creator' && !current && <span className="absolute right-4 top-4 rounded-full bg-[#FF6A00] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">Оптимальный</span>}
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8C8C96]">{TIER_COPY[tier].eyebrow}</p>
            <div className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-1">
              <h3 className="text-[24px] font-bold text-white">{PLAN_NAMES[tier]}</h3>
              <p className="pb-1 text-[13px] font-semibold text-[#D6D6DC]">{formatUsd(price?.usd ?? 0)} <span className="font-normal text-[#777780]">/ 30 дней</span></p>
            </div>
            <p className="mt-1 max-w-[34rem] text-[13px] leading-5 text-[#92929C]">{TIER_COPY[tier].description}</p>
            <div className="mt-4 space-y-2.5">{featureRows(tier).map(({ icon: Icon, text }) => <div key={text} className="flex items-start gap-2.5"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.055]"><Icon size={12} className={text.includes('не включ') ? 'text-[#55555D]' : 'text-[#FF7A1A]'} /></span><span className={`text-[12px] leading-[18px] ${text.includes('не включ') ? 'text-[#5E5E67]' : 'text-[#C5C5CC]'}`}>{text}</span></div>)}</div>
            <div className="mt-5">{current ? <div className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#FF6A00]/25 bg-[#FF6A00]/10 text-[13px] font-semibold text-[#FF8A38]"><Check size={16} /> Ваш тариф</div> : paid ? <Button variant="primary" size="lg" fullWidth onClick={() => setPayTier(tier)}>Выбрать {PLAN_NAMES[tier]}</Button> : <div className="min-h-11 text-center text-[12px] leading-5 text-[#66666E]">Free включается автоматически после окончания платной подписки.</div>}</div>
          </motion.article>
        })}
      </div>
    </div>

    <Sheet open={payTier !== null} onClose={() => !paying && setPayTier(null)} title={payTier ? `Оплата ${PLAN_NAMES[payTier]}` : 'Оплата'}>
      {payTier && <div className="space-y-3">
        <div className="rounded-2xl border border-[#FF6A00]/20 bg-gradient-to-br from-[#FF6A00]/[0.11] to-white/[0.025] p-4">
          <div className="flex items-end justify-between gap-3">
            <div><p className="text-xs font-medium text-[#A1A1AA]">Стоимость тарифа</p><p className="mt-1 text-[26px] font-bold leading-none text-white">{formatUsd(PLAN_PRICING[payTier].usd)}</p></div>
            <span className="rounded-full border border-white/[0.09] bg-black/20 px-2.5 py-1 text-[11px] font-medium text-[#B8B8C0]">30 дней</span>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#777780]">Оплата производится в TON. Лимиты обновляются ежемесячно, а оставшиеся оплаченные дни сохраняются при продлении.</p>
        </div>
        <button disabled={paying} onClick={() => void payWithTon(payTier)} className="flex min-h-[54px] w-full items-center justify-between rounded-2xl border border-[#0098EA]/20 bg-[#0098EA]/[0.08] px-4 text-white transition-colors hover:bg-[#0098EA]/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0098EA] disabled:opacity-50"><span className="flex items-center gap-2 font-semibold"><GramMark size={18} /> TON</span><span className="font-bold">{PLAN_PRICING[payTier].ton} TON</span></button>
        {paying && <div className="flex items-center justify-center gap-2 py-2 text-xs text-[#8C8C96]"><Loader2 size={15} className="animate-spin" /> Проверяем оплату…</div>}
      </div>}
    </Sheet>
  </div>
}

function Usage({ label, used, limit }: { label: string; used: number; limit: number }) {
  const progress = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return <div className="rounded-xl border border-white/[0.06] bg-black/15 p-2.5"><div className="flex items-center justify-between gap-2"><span className="text-[11px] text-[#8A8A93]">{label}</span><span className="text-[11px] font-semibold text-white">{format(used)} / {format(limit)}</span></div><div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-[#FF6A00]" style={{ width: `${progress}%` }} /></div></div>
}