import { useEffect, useState } from 'react'
import { LayoutTemplate, Loader2 } from 'lucide-react'
import { StyleDetailSheet } from '@/components/styles/StyleDetailSheet'
import { useApp } from '@/context/AppContext'
import { fetchStyles, isStyleOwned } from '@/lib/styles'
import type { MarketStyle } from '@/types'

/**
 * Styles tab — the cover-style market. Cards show a static demo preview; tapping
 * one opens a near-fullscreen detail sheet to buy (TON) or apply.
 */
export function StylesScreen() {
  const { language, t } = useApp()
  const isRu = language === 'ru'

  const [styles, setStyles] = useState<MarketStyle[]>([])
  const [owned, setOwned]   = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(false)
  const [selected, setSelected] = useState<MarketStyle | null>(null)

  useEffect(() => {
    let alive = true
    fetchStyles()
      .then(({ styles, owned }) => { if (alive) { setStyles(styles); setOwned(owned) } })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const handlePurchased = (styleId: string) => {
    setOwned(prev => prev.includes(styleId) ? prev : [...prev, styleId])
  }

  return (
    <div className="pb-8 pt-3">

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20">
          <Loader2 size={22} className="animate-spin text-[#FF6A00]" />
        </div>
      ) : error ? (
        <p className="px-4 mt-8 text-center text-[13px] text-[#55555D]">{t('styles.loadError')}</p>
      ) : styles.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 px-8 text-center">
          <div className="w-14 h-14 rounded-[18px] bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
            <LayoutTemplate size={24} className="text-[#3A3A42]" />
          </div>
          <p className="text-[13px] text-[#55555D]">{t('styles.empty')}</p>
        </div>
      ) : (
        <div className="px-4 mt-2 grid grid-cols-2 gap-3">
          {styles.map(style => {
            const preview = style.heroPreview ?? style.previews[0] ?? null
            const name = isRu ? style.nameRu : style.nameEn
            const ownedNow = isStyleOwned(style, owned)
            const priceLabel = style.priceKind === 'FREE'
              ? t('styles.free')
              : `${style.priceGram} TON`
            return (
              <button
                key={style.id}
                onClick={() => setSelected(style)}
                className="group relative text-left rounded-[18px] overflow-hidden bg-white/[0.04] border border-white/[0.07] hover:border-white/20 transition-colors"
              >
                {/* Preview */}
                <div className="aspect-[16/10] bg-[#0B0B0C] overflow-hidden flex items-center justify-center">
                  {preview
                    ? <img src={preview} alt={name} className="w-full h-full object-cover" />
                    : <LayoutTemplate size={24} className="text-[#3A3A42]" />}
                </div>
                {style.hidden ? (
                  <span className="absolute top-2 right-2 rounded-full bg-black/70 border border-white/20 px-2 py-0.5 text-[10px] font-semibold text-white/85">
                    скрыт
                  </span>
                ) : style.showcaseOnly && (
                  <span className="absolute top-2 right-2 rounded-full bg-black/70 border border-[rgba(255,106,0,0.4)] px-2 py-0.5 text-[10px] font-semibold text-[#FF6A00]">
                    витрина
                  </span>
                )}
                {/* Info */}
                <div className="p-2.5">
                  <p className="text-[13px] font-semibold text-white truncate">{name}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-[#A1A1AA]">{priceLabel}</span>
                    {ownedNow && (
                      <span className="text-[10px] font-semibold text-[#FF6A00]">{t('styles.owned')}</span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      <StyleDetailSheet
        style={selected}
        owned={owned}
        onClose={() => setSelected(null)}
        onPurchased={handlePurchased}
      />
    </div>
  )
}
