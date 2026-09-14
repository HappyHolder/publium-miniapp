import { tonCheckout } from '@/lib/tonCheckout'
import { useState } from 'react'
import { Check, Loader2, Sparkles } from 'lucide-react'
import { useTonConnectUI } from '@tonconnect/ui-react'
import { GramMark } from '@/components/icons/GramMark'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useApp } from '@/context/AppContext'
import { channelLabel } from '@/lib/utils'
import {
  fetchStyles, isStyleOwned, applyStyleToVisualKit,
} from '@/lib/styles'
import type { MarketStyle, VisualKit } from '@/types'

interface StyleDetailSheetProps {
  style: MarketStyle | null
  owned: string[]
  onClose: () => void
  /** Called after a successful purchase so the parent can mark the style owned. */
  onPurchased: (styleId: string) => void
}

const EMPTY_VISUAL_KIT: VisualKit = {
  primaryColor: '', backgroundStyle: 'dark', cardStyle: 'minimal',
  watermark: false, bannerTemplate: 'minimal',
}

export function StyleDetailSheet({ style, owned, onClose, onPurchased }: StyleDetailSheetProps) {
  const { state, activeChannel, updateBrandKit, showToast, language, t } = useApp()
  const [tonConnectUI] = useTonConnectUI()
  const [busy, setBusy] = useState<null | 'gram' | 'apply'>(null)

  const isRu = language === 'ru'
  if (!style) return null

  const ownedNow = isStyleOwned(style, owned)
  // Showcase-only packs (internal Publium / Stepan Logos) are visible to all but
  // only an admin can apply them — everyone else sees a disabled shop-window CTA.
  const isAdmin = state.user?.isAdmin ?? false
  const showcaseLocked = !!style.showcaseOnly && !isAdmin
  const name = isRu ? style.nameRu : style.nameEn
  const desc = isRu ? style.descRu : style.descEn
  const gallery = style.heroPreview
    ? [style.heroPreview, ...style.previews.filter(p => p !== style.heroPreview)]
    : style.previews

  const tplCount = style.templates.length
  const tplWord = tplCount === 1 ? t('styles.templatesOne') : t('styles.templatesMany')
  const modeLabel = style.recommendedMode === 'ai' ? t('styles.modeAi')
    : style.recommendedMode === 'ai_html' ? t('styles.modeAiHtml')
    : t('styles.modeHtml')

  // ── Apply ──────────────────────────────────────────────────────────────────
  const handleApply = async () => {
    if (!activeChannel) { showToast(t('styles.needChannel'), 'error'); return }
    setBusy('apply')
    try {
      const fresh = (await fetchStyles()).styles.find(item => item.id === style.id) ?? style
      const current = state.brandKits.find(k => k.channelId === activeChannel.id)?.visualKit ?? EMPTY_VISUAL_KIT
      const saved = await updateBrandKit(activeChannel.id, { visualKit: applyStyleToVisualKit(fresh, current) })
      if (!saved) return
      showToast(t('styles.applyDone'))
      onClose()
    } catch (error) { showToast(error instanceof Error ? error.message : 'Не удалось применить стиль', 'error') } finally {
      setBusy(null)
    }
  }

  // ── Buy with Gram (TON) ──────────────────────────────────────────────────────
  const handleBuyGram = async () => {
    if (busy) return
    if (!tonConnectUI.account) {
      try { await tonConnectUI.openModal() } catch { /* ignore */ }
      showToast(t('plans.connectWalletFirst'))
      return
    }
    setBusy('gram')
    try {
      await tonCheckout(tonConnectUI, 'style', style.id)
      onPurchased(style.id)
      showToast(t('styles.purchaseDone'))
    } catch (err) {
      const msg = (err as Error)?.message || ''
      if (/reject|cancel|abort|declin|user.*close/i.test(msg)) showToast(t('plans.payCancelled'))
      else showToast(msg || t('plans.payFailed'), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet open={!!style} onClose={() => { if (!busy) onClose() }} height="full" title={name}>
      <div className="space-y-5 pb-2">
        {/* Gallery */}
        {gallery.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto no-scrollbar pb-1">
            {gallery.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={`${name} ${i + 1}`}
                className="h-44 rounded-[14px] border border-white/[0.08] object-cover shrink-0"
              />
            ))}
          </div>
        )}

        {/* Tags + adaptivity */}
        <div className="flex flex-wrap gap-1.5">
          {style.tags.map(tag => (
            <span key={tag} className="px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[11px] text-[#A1A1AA]">
              {tag}
            </span>
          ))}
          <span className="px-2.5 py-0.5 rounded-full bg-[rgba(255,106,0,0.10)] border border-[rgba(255,106,0,0.22)] text-[11px] text-[#FF6A00]">
            {style.brandAdaptive ? t('styles.brandAdaptive') : t('styles.fixedPalette')}
          </span>
        </div>

        {/* Description */}
        {desc && <p className="text-[13px] text-[#A1A1AA] leading-relaxed">{desc}</p>}

        {/* What's included */}
        <div className="rounded-[14px] bg-white/[0.03] border border-white/[0.06] p-4 space-y-2">
          <p className="text-xs font-semibold text-[#55555D] uppercase tracking-wider">{t('styles.included')}</p>
          <div className="flex items-center gap-2 text-[13px] text-white">
            <Check size={13} className="text-[#FF6A00]" /> {tplCount} {tplWord}
          </div>
          <div className="flex items-center gap-2 text-[13px] text-white">
            <Check size={13} className="text-[#FF6A00]" /> {modeLabel}
          </div>
          {style.carouselTemplate && (
            <div className="flex items-center gap-2 text-[13px] text-white">
              <Check size={13} className="text-[#FF6A00]" /> {isRu ? 'Карусель · универсальный слайд' : 'Carousel · universal slide'}
            </div>
          )}
          {style.visualCoverStyle && (
            <div className="flex items-center gap-2 text-[13px] text-white">
              <Check size={13} className="text-[#FF6A00]" /> {t('styles.aiStyleNote')}
            </div>
          )}
        </div>

        {/* Carousel — full sequence (cover → items → outro), separate from rubric covers */}
        {style.carouselTemplate?.previews && style.carouselTemplate.previews.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-[#55555D] uppercase tracking-wider mb-2">{isRu ? 'Карусель · последовательность' : 'Carousel · sequence'}</p>
            <div className="-mx-1 flex gap-2 overflow-x-auto no-scrollbar pb-1">
              {style.carouselTemplate.previews.map((src, i) => (
                <img key={i} src={src} alt={`carousel ${i + 1}`} className="h-44 rounded-[14px] border border-white/[0.08] object-cover shrink-0" />
              ))}
            </div>
          </div>
        )}

        {/* Palette */}
        {style.palette.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-[#55555D] uppercase tracking-wider mb-2">{t('styles.colors')}</p>
            <div className="flex flex-wrap gap-2">
              {style.palette.map((c, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-[10px] bg-white/[0.03] border border-white/[0.06]">
                  <span className="w-5 h-5 rounded-[6px] border border-white/10" style={{ background: c.hex }} />
                  <span className="text-[12px] text-[#A1A1AA]">{c.name || c.hex}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── CTA ──────────────────────────────────────────────────────────────── */}
      <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-1 bg-gradient-to-t from-[#0E0E10] via-[#0E0E10] to-transparent space-y-2">
        {showcaseLocked ? (
          <>
            <div className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-[14px] bg-white/[0.03] border border-white/[0.07] text-[13px] font-medium text-[#8A8A92] cursor-not-allowed select-none">
              <Sparkles size={14} className="text-[#55555D]" />
              {isRu ? 'Витрина — стиль недоступен для применения' : 'Showcase — this style can’t be applied'}
            </div>
            <p className="text-center text-[11px] text-[#55555D] pt-0.5">
              {isRu ? 'Фирменный пак Publium — только для витрины' : 'Publium signature pack — display only'}
            </p>
          </>
        ) : ownedNow ? (
          <Button variant="primary" size="md" fullWidth onClick={handleApply} disabled={busy === 'apply'}>
            {busy === 'apply'
              ? <><Loader2 size={14} className="animate-spin" /> {t('styles.applying')}</>
              : t('styles.apply')}
            {activeChannel && busy !== 'apply' && (
              <span className="opacity-70 ml-1">· {channelLabel(activeChannel)}</span>
            )}
          </Button>
        ) : (
          <>
            {style.priceGram != null && style.priceGram > 0 && (
              <button
                onClick={handleBuyGram}
                disabled={!!busy}
                className="w-full flex items-center justify-between px-4 py-3.5 rounded-[14px] bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.07] transition-colors disabled:opacity-50"
              >
                <span className="flex items-center gap-2.5">
                  {busy === 'gram' ? <Loader2 size={18} className="text-[#FF6A00] animate-spin" /> : <GramMark size={18} />}
                  <span className="text-[14px] font-medium text-white">TON</span>
                </span>
                <span className="text-[14px] font-bold text-white">{style.priceGram} TON</span>
              </button>
            )}
            <p className="text-center text-[11px] text-[#55555D] pt-0.5 flex items-center justify-center gap-1">
              <Sparkles size={11} className="text-[#55555D]" /> {isRu ? 'Разовая покупка — навсегда' : 'One-time purchase — yours forever'}
            </p>
          </>
        )}
      </div>
    </Sheet>
  )
}
