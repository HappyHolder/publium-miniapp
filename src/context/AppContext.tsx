import { enqueueSave } from '@/lib/saveQueue'
import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import type { AppState, GeneratedPost, Channel, Chat, ChatStyle, BrandKit, Subscription, PlanTier } from '@/types'
import { mockInitialState } from '@/data/mockData'
import { postService } from '@/services/postService'
import { brandKitService } from '@/services/brandKitService'
import { channelService } from '@/services/channelService'
import {
  type Language,
  type TranslationKey,
  getInitialLanguage,
  setStoredLanguage,
  createTranslator,
} from '@/i18n'
import { getTelegramInitData, isTelegramMockModeAllowed, notifyTelegramReady, waitForTelegramInitData } from '@/lib/telegram'
import { API_BASE } from '@/lib/api'
import { normalizePostBlocks } from '@/lib/postBlockNormalizer'

// ─── Auth status ─────────────────────────────────────────────────────────────
// 'mock'          — dev/browser mode (no initData); mock data shown immediately
// 'checking'      — Telegram mode, POST /api/auth/telegram in-flight; blank shell rendered
// 'authenticated' — auth succeeded; real user/channels/posts in state
// 'failed'        — auth or network error; minimal error screen shown, app stable
export type AuthStatus = 'mock' | 'checking' | 'authenticated' | 'failed'
interface ServerSubscription {
  tier: string
  expiresAt: string | null
  quotaResetAt: string | null
  usage: Subscription['usage']
  limits: Subscription['limits']
}

function fromServerSubscription(sub: ServerSubscription): Subscription {
  const planTier = sub.tier.toLowerCase() as PlanTier
  const planName = planTier === 'studio_pro' ? 'Studio Pro' : planTier === 'creator' ? 'Creator' : planTier === 'starter' ? 'Starter' : 'Free'
  return { planTier, planName, billingPeriod: 'monthly', status: 'active', expiresAt: sub.expiresAt, quotaResetAt: sub.quotaResetAt, usage: sub.usage, limits: sub.limits }
}

// ─── Default BrandKit factory ─────────────────────────────────────────────────
// The server stores BrandKit sections as nullable JSON blobs. The frontend
// interface requires non-null shaped objects. This factory fills sensible
// defaults so Channel Style forms render correctly for a freshly connected channel.
function createDefaultBrandKit(channelId: string): BrandKit {
  return {
    channelId,
    channelAbout: undefined,
    voiceProfile: {
      language:     'RU',
      addressStyle: 'ты',
      tone:         'expert',
      postLength:   'medium',
      examplePosts:   [],
      favoriteWords:  [],
      forbiddenWords: [],
    },
    linkKit: { links: [] },
    visualKit: {
      primaryColor:    '#FF6A00',
      secondaryColor:  '#1A0A00',
      backgroundStyle: 'dark',
      cardStyle:       'branded',
      watermark:       false,
      bannerTemplate:  'dark_glass',
      aspectRatio:     '16:9',
      textOnCover:     true,
      logoUsage:       'when_relevant',
      references:      [],
      avoidList:       [],
    },
    signature: {
      text:  '',
      usage: 'when_relevant',
    },
    postRules: {
      defaultStructure:      '',
      neverCopySource:       true,
      avoidClickbait:        true,
      shortParagraphs:       true,
      addCtaIfRelevant:      false,
      useLinkKitWhenRelevant:false,
      paragraphStyle:        'short',
      listUsage:             'when_relevant',
      ctaUsage:              'when_relevant',
      thingsToAvoid:         [],
    },
  }
}

function createDefaultChatStyle(chatId: string): ChatStyle {
  return { chatId, channelAbout: undefined, voiceProfile: { language: 'RU', addressStyle: 'ты', tone: 'expert', postLength: 'medium', examplePosts: [], favoriteWords: [], forbiddenWords: [] } }
}

interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
}

interface AppContextValue {
  state: AppState
  authStatus: AuthStatus
  activeChannel: Channel | undefined
  canSchedulePosts: boolean
  canUseAiAssistant: boolean
  canGenerate: boolean
  createsRemaining: number | null  // null = unlimited
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey) => string
  addPost: (post: GeneratedPost) => void
  updatePost: (id: string, updates: Partial<GeneratedPost>) => void
  publishPost: (id: string) => void
  schedulePost: (id: string, at: Date) => void
  cancelSchedule: (id: string) => void
  selectVariant: (postId: string, variantId: string) => void
  updateVariantText: (postId: string, variantId: string, text: string) => void
  updateVariantBannerUrl: (postId: string, variantId: string, bannerUrl: string) => void
  deletePost: (postId: string) => void
  setActiveChannel: (id: string) => void
  connectChannel: (channel: Channel) => void
  disconnectChannel: (channelId: string) => void
  connectChat: (chat: Chat) => void
  disconnectChat: (chatId: string) => void
  setChatLinkedChannel: (chatId: string, channel: Channel | null) => void
  updateBrandKit: (channelId: string, kit: Partial<BrandKit>) => Promise<boolean>
  updateChatStyle: (chatId: string, style: Partial<ChatStyle>) => Promise<boolean>
  applyServerSubscription: (sub: ServerSubscription) => void
  toasts: Toast[]
  showToast: (message: string, type?: Toast['type']) => void
}

// ─── API post shape ───────────────────────────────────────────────────────────
// Defined at module level so both the auth effect and the visibilitychange
// refresh effect can share the type and mapping without duplication.

interface ListApiPost {
  id:                string
  title:             string
  sourceType:        string
  editorMode:        'rich' | 'legacy'
  sourceUrl:         string | null
  sourceSummary:     string
  channelId:         string
  channelUsername:   string
  variants:          { id: string; label: string; text: string; isSelected: boolean; bannerUrl: string | null; blocks?: import('@/types').PostBlock[] | null }[]
  selectedVariantId: string | null
  linkButtons:       unknown[]
  status:            'new' | 'scheduled' | 'published'
  createdAt:         string
  scheduledAt:       string | null
  publishedAt:       string | null
  textRegensUsed:    number
  imageRegensUsed:   number
  coverMode:         'ai' | 'html' | 'ai_html' | null
  coverAspectRatio:  '1:1' | '16:9' | '4:5' | '9:16' | null
  rubricId?:         string | null
  rubricName?:       string | null
}

function mapListPost(p: ListApiPost): GeneratedPost {
  return {
    id:                p.id,
    title:             p.title,
    sourceType:        p.sourceType as GeneratedPost['sourceType'],
    editorMode:        p.editorMode,
    sourceUrl:         p.sourceUrl         ?? undefined,
    sourceSummary:     p.sourceSummary,
    channelId:         p.channelId,
    channelUsername:   p.channelUsername,
    variants:          p.variants.map(variant => ({ ...variant, blocks: normalizePostBlocks(variant.blocks) })),
    selectedVariantId: p.selectedVariantId  ?? undefined,
    linkButtons:       p.linkButtons        as GeneratedPost['linkButtons'],
    status:            p.status,
    createdAt:         new Date(p.createdAt),
    scheduledAt:       p.scheduledAt != null ? new Date(p.scheduledAt) : undefined,
    publishedAt:       p.publishedAt != null ? new Date(p.publishedAt) : undefined,
    textRegensUsed:    p.textRegensUsed,
    imageRegensUsed:   p.imageRegensUsed,
    coverMode:         p.coverMode ?? undefined,
    coverAspectRatio:  p.coverAspectRatio ?? undefined,
    rubricId:          p.rubricId ?? null,
    rubricName:        p.rubricName ?? null,
  }
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const mockModeAllowed = isTelegramMockModeAllowed()
  const initialInitData = getTelegramInitData()

  // Production starts behind an auth gate even when Telegram is still
  // initialising. Mock data is available only in explicit local development.
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() =>
    initialInitData ? 'checking' : mockModeAllowed ? 'mock' : 'checking'
  )

  const [state, setState] = useState<AppState>(() => {
    if (initialInitData || !mockModeAllowed) {
      // Telegram mode — start with an empty shell so no mock data is ever
      // rendered while POST /api/auth/telegram is in-flight.
      postService.init([])
      brandKitService.init([])
      channelService.init([])
      return {
        ...mockInitialState,   // preserves subscription shape / user placeholder
        channels:        [],
        chats:           [],
        brandKits:       [],
        chatStyles:      [],
        posts:           [],
        activeChannelId: '',
      }
    }
    // Explicit local development mode.
    postService.init(mockInitialState.posts)
    brandKitService.init(mockInitialState.brandKits)
    channelService.init(mockInitialState.channels)
    return mockInitialState
  })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [language, setLanguageState] = useState<Language>(getInitialLanguage)

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang)
    setStoredLanguage(lang)
  }, [])

  const t = useMemo(() => createTranslator(language), [language])

  const showToast = useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = `t-${Date.now()}`
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000)
  }, [])

  // ── Telegram auth + persisted posts bootstrap ────────────────────────────
  // Fires once at mount. Calls ready() so Telegram shows the app immediately.
  //
  // Local mock mode (no initData):
  //   → authStatus stays 'mock'; mock state shown immediately; no fetch.
  //
  // Telegram mode (initData present), auth succeeds:
  //   → POST /api/auth/telegram → real user / channels / brandKits
  //   → POST /api/posts/list   → persisted GeneratedPosts (non-fatal; [] on failure)
  //   → authStatus → 'authenticated'; real UI renders with posts surviving reload.
  //
  // Telegram mode, auth fails (network error / 401 / unexpected shape):
  //   → authStatus → 'failed'; minimal error screen shown; app stays stable.
  useEffect(() => {
    notifyTelegramReady()
    let cancelled = false
    if (mockModeAllowed && !getTelegramInitData()) return

    interface TelegramAuthResponse {
      user: {
        id:              string
        name:            string | null
        telegramId:      string
        username:        string | null
        activeChannelId: string | null
        isAdmin?:        boolean
      }
      channels: Channel[]
      chats?: Chat[]
      chatStyles?: { chatId: string; channelAbout: unknown; voiceProfile: unknown }[]
      // brandKits is optional so older backend versions stay compatible
      brandKits?: {
        channelId:    string
        channelAbout: unknown
        voiceProfile: unknown
        linkKit:      unknown
        visualKit:    unknown
        signature:    unknown
        postRules:    unknown
      }[]
      subscription: ServerSubscription | null
    }

    // Async IIFE — lets us await auth then posts sequentially while keeping
    // the useEffect callback itself synchronous (React requirement).
    ;(async () => {
      const initData = await waitForTelegramInitData()
      if (cancelled) return
      if (!initData) {
        setAuthStatus('failed')
        return
      }

      // ── Step 1: Telegram auth ─────────────────────────────────────────
      let authData: TelegramAuthResponse | null = null
      try {
        const res = await fetch(`${API_BASE}/api/auth/telegram`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ initData }),
        })
        authData = res.ok ? (await res.json() as TelegramAuthResponse) : null
      } catch {
        setAuthStatus('failed')   // network error
        return
      }

      if (!authData?.user) {
        setAuthStatus('failed')   // non-ok response or unexpected shape
        return
      }

      const realChannels: Channel[] = authData.channels ?? []
      const realChats: Chat[] = authData.chats ?? []

      // Build shaped BrandKits: start from defaults, then overwrite with
      // any non-null sections returned from the DB (saved by the user previously).
      // Null/missing sections keep the default shape so forms always render correctly.
      const dbBrandKits = authData.brandKits ?? []
      const realBrandKits = realChannels.map(ch => {
        const kit = createDefaultBrandKit(ch.id)
        const dbKit = dbBrandKits.find(k => k.channelId === ch.id)
        if (!dbKit) return kit
        // Overwrite defaults with saved sections. Casting via `as any` because
        // Prisma Json? columns arrive as `unknown` but were written from the
        // same frontend interfaces — the shapes are guaranteed to match.
        const SECTIONS = [
          'channelAbout', 'voiceProfile',
          'linkKit', 'visualKit', 'signature', 'postRules',
        ] as const
        for (const key of SECTIONS) {
          if (dbKit[key] != null) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(kit as any)[key] = dbKit[key]
          }
        }
        return kit
      })
      const realChatStyles = realChats.map(chat => {
        const style = createDefaultChatStyle(chat.id), saved = authData!.chatStyles?.find(item => item.chatId === chat.id)
        if (saved?.channelAbout != null) style.channelAbout = saved.channelAbout as ChatStyle['channelAbout']
        if (saved?.voiceProfile != null) style.voiceProfile = saved.voiceProfile as ChatStyle['voiceProfile']
        return style
      })

      // Re-initialise in-memory channel / brandKit services
      channelService.init(realChannels)
      brandKitService.init(realBrandKits)

      // ── Step 2: Load persisted posts (non-fatal) ───────────────────────
      // If this fetch fails for any reason, auth still succeeds with posts = [].
      // The try/catch boundary means posts errors can never set authStatus 'failed'.
      let loadedPosts: GeneratedPost[] = []
      try {
        const postsRes = await fetch(`${API_BASE}/api/posts/list`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ initData }),
        })
        if (postsRes.ok) {
          const postsData = await postsRes.json() as { posts: ListApiPost[] }
          const rawPosts = Array.isArray(postsData.posts) ? postsData.posts : []
          loadedPosts = rawPosts.map(mapListPost)
        }
      } catch {
        // Non-fatal — keep loadedPosts = []; auth still succeeds below
      }

      // ── Step 3: Commit state and mark authenticated ────────────────────
      postService.init(loadedPosts)

      // Resolve active channel: DB → localStorage → first channel
      const publicationChannels = realChannels
      const resolvedActiveChannelId = (() => {
        const fromDb = authData!.user.activeChannelId
        if (fromDb && publicationChannels.some(c => c.id === fromDb)) return fromDb
        try {
          const saved = localStorage.getItem('activeChannelId')
          if (saved && publicationChannels.some(c => c.id === saved)) return saved
        } catch {}
        return publicationChannels[0]?.id ?? ''
      })()

      // Sync to DB if the resolved value differs from what DB has (e.g. first load,
      // or user had a channel saved in localStorage but DB was null).
      if (
        resolvedActiveChannelId &&
        resolvedActiveChannelId !== authData!.user.activeChannelId
      ) {
        fetch(`${API_BASE}/api/auth/active-channel`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ initData, channelId: resolvedActiveChannelId }),
        }).catch(() => {})
      }

      const serverSub = authData!.subscription
      setState(prev => ({
        ...prev,
        user: {
          ...prev.user,
          id:       authData!.user.id,
          name:     authData!.user.name     ?? prev.user.name,
          username: authData!.user.username ?? prev.user.username,
          isAdmin:  authData!.user.isAdmin ?? false,
          subscription: serverSub ? fromServerSubscription(serverSub) : prev.user.subscription,
        },
        channels:        realChannels,
        chats:           realChats,
        brandKits:       realBrandKits,
        chatStyles:      realChatStyles,
        posts:           loadedPosts,
        activeChannelId: resolvedActiveChannelId,
      }))
      setAuthStatus('authenticated')
    })()
    return () => { cancelled = true }
  }, [mockModeAllowed]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Visibility-change refresh ─────────────────────────────────────────────
  // When the Telegram Mini App panel is reopened after being hidden, re-fetch
  // the posts list so scheduler-published posts move from Scheduled → Published
  // without requiring a full app restart.
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    const initData = getTelegramInitData()
    if (!initData) return

    function onVisible() {
      if (document.visibilityState !== 'visible') return
      fetch(`${API_BASE}/api/posts/list`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ initData }),
      })
        .then(r => r.ok ? (r.json() as Promise<{ posts: ListApiPost[] }>) : null)
        .then(data => {
          if (!data?.posts) return
          const incoming = (Array.isArray(data.posts) ? data.posts : []).map(mapListPost)
          // Preserve any bannerUrl already held in memory for a variant that
          // the DB hasn't caught up with yet (narrow race: post created, image
          // generation in-flight, visibility-change fires before DB write).
          const existing = postService.getAll()
          const merged = incoming.map(p => {
            const prev = existing.find(e => e.id === p.id)
            if (!prev) return p
            return {
              ...p,
              variants: p.variants.map(v => {
                const prevV = prev.variants.find(ev => ev.id === v.id)
                return v.bannerUrl ? v : { ...v, bannerUrl: prevV?.bannerUrl ?? null }
              }),
            }
          })
          postService.init(merged)
          setState(prev => ({ ...prev, posts: merged }))
        })
        .catch(() => {})
    }

    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [authStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPosts = useCallback(() => {
    setState(prev => ({ ...prev, posts: postService.getAll() }))
  }, [])

  const addPost = useCallback((post: GeneratedPost) => {
    postService.add(post)
    refreshPosts()
  }, [refreshPosts])

  const updatePost = useCallback((id: string, updates: Partial<GeneratedPost>) => {
    postService.update(id, updates)
    refreshPosts()
  }, [refreshPosts])

  const publishPost = useCallback((id: string) => {
    postService.publish(id)
    refreshPosts()
    showToast('Post published successfully')
  }, [refreshPosts, showToast])

  const schedulePost = useCallback((id: string, at: Date) => {
    postService.schedule(id, at)
    refreshPosts()
    showToast(t('schedule.scheduledSuccess'))
  }, [refreshPosts, showToast, t])

  const cancelSchedule = useCallback((id: string) => {
    postService.cancelSchedule(id)
    refreshPosts()
    showToast(t('schedule.cancelledSuccess'))
  }, [refreshPosts, showToast, t])

  const selectVariant = useCallback((postId: string, variantId: string) => {
    // Immediate local update — UI responds instantly
    postService.selectVariant(postId, variantId)
    refreshPosts()

    // Persist to DB so scheduler and manual publish use the right variant text
    if (authStatus === 'authenticated') {
      const initData = getTelegramInitData()
      if (initData) {
        fetch(`${API_BASE}/api/posts/select-variant`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ initData, postId, variantId }),
        }).then(async res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json() as { blocks?: import('@/types').PostBlock[] | null }
          const current = postService.getById(postId)
          if (!current) return
          postService.update(postId, {
            variants: current.variants.map(variant => variant.id === variantId
              ? { ...variant, blocks: normalizePostBlocks(data.blocks) }
              : variant),
          })
          refreshPosts()
        }).catch(err => {
          console.error('[selectVariant] Backend save failed:', (err as Error).message)
        })
      }
    }
  }, [refreshPosts, authStatus])

  const updateVariantText = useCallback((postId: string, variantId: string, text: string) => {
    postService.updateVariantText(postId, variantId, text)
    refreshPosts()
  }, [refreshPosts])

  const deletePost = useCallback((postId: string) => {
    postService.remove(postId)
    refreshPosts()
  }, [refreshPosts])

  const updateVariantBannerUrl = useCallback((postId: string, variantId: string, bannerUrl: string) => {
    setState(prev => ({
      ...prev,
      posts: prev.posts.map(p =>
        p.id !== postId ? p : {
          ...p,
          variants: p.variants.map(v =>
            v.id !== variantId ? v : { ...v, bannerUrl }
          ),
        }
      ),
    }))
  }, [])

  const applyServerSubscription = useCallback((sub: ServerSubscription) => {
    setState(prev => ({ ...prev, user: { ...prev.user, subscription: fromServerSubscription(sub) } }))
  }, [])

  const setActiveChannel = useCallback((id: string) => {
    setState(prev => ({ ...prev, activeChannelId: id }))
    try { localStorage.setItem('activeChannelId', id) } catch {}
    // Persist to DB so the bot webhook uses the same active channel
    const initData = getTelegramInitData()
    if (initData) {
      fetch(`${API_BASE}/api/auth/active-channel`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ initData, channelId: id }),
      }).catch(() => {})
    }
  }, [])

  const connectChannel = useCallback((channel: Channel) => {
    const newBrandKit = createDefaultBrandKit(channel.id)
    brandKitService.upsert(newBrandKit)

    setState(prev => {
      const alreadyExists = prev.channels.some(c => c.id === channel.id)

      const updatedChannels = alreadyExists
        // Re-connect of existing channel: refresh data, don't duplicate
        ? prev.channels.map(c => c.id === channel.id ? channel : c)
        // New channel: append
        : [...prev.channels, channel]

      const updatedBrandKits = alreadyExists
        ? prev.brandKits.map(k => k.channelId === channel.id ? newBrandKit : k)
        : [...prev.brandKits, newBrandKit]

      // Sync in-memory service to match new channels array
      channelService.init(updatedChannels)

      return {
        ...prev,
        channels:        updatedChannels,
        brandKits:       updatedBrandKits,
        activeChannelId: channel.id,
      }
    })
  }, [])

  // Removes a channel from local state after the server has deleted it (and its
  // posts / brand kit / plans via cascade). Mirrors connectChannel: keeps the
  // in-memory services in sync and repoints the active channel if it was the one
  // removed, so no screen ever targets a deleted channel.
  const disconnectChannel = useCallback((channelId: string) => {
    setState(prev => {
      const remainingChannels  = prev.channels.filter(c => c.id !== channelId)
      const remainingBrandKits = prev.brandKits.filter(k => k.channelId !== channelId)
      const remainingPosts     = prev.posts.filter(p => p.channelId !== channelId)

      const wasActive        = prev.activeChannelId === channelId
      const nextActiveId      = wasActive ? (remainingChannels[0]?.id ?? '') : prev.activeChannelId

      // Sync in-memory services to match the trimmed state.
      channelService.init(remainingChannels)
      brandKitService.init(remainingBrandKits)
      postService.init(remainingPosts)

      if (wasActive) {
        try {
          if (nextActiveId) localStorage.setItem('activeChannelId', nextActiveId)
          else localStorage.removeItem('activeChannelId')
        } catch {}
      }

      return {
        ...prev,
        channels:        remainingChannels,
        brandKits:       remainingBrandKits,
        posts:           remainingPosts,
        activeChannelId: nextActiveId,
      }
    })
  }, [])

  const connectChat = useCallback((chat: Chat) => {
    setState(prev => ({
      ...prev,
      chats: prev.chats.some(item => item.id === chat.id) ? prev.chats.map(item => item.id === chat.id ? chat : item) : [...prev.chats, chat],
      chatStyles: prev.chatStyles.some(item => item.chatId === chat.id) ? prev.chatStyles : [...prev.chatStyles, createDefaultChatStyle(chat.id)],
    }))
  }, [])

  const disconnectChat = useCallback((chatId: string) => {
    setState(prev => ({ ...prev, chats: prev.chats.filter(chat => chat.id !== chatId), chatStyles: prev.chatStyles.filter(style => style.chatId !== chatId) }))
  }, [])

  const setChatLinkedChannel = useCallback((chatId: string, channel: Channel | null) => {
    const linkedChannel = channel ? { id: channel.id, title: channel.title, username: channel.username } : null
    setState(prev => ({ ...prev, chats: prev.chats.map(chat => chat.id === chatId ? { ...chat, linkedChannel } : chat) }))
  }, [])

  const saveSections = useCallback(async (path: string, sections: unknown): Promise<void> => {
    if (authStatus !== 'authenticated') return
    const initData = getTelegramInitData()
    if (!initData) throw new Error('Сессия истекла. Откройте приложение заново.')
    const response = await fetch(`${API_BASE}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, sections }) })
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? 'Не удалось сохранить изменения.') }
  }, [authStatus])

  const updateChatStyle = useCallback((chatId: string, updates: Partial<ChatStyle>): Promise<boolean> => enqueueSave(`chat:${chatId}`, async () => {
    try {
      await saveSections(`/api/chats/${chatId}/style`, updates)
      setState(prev => ({ ...prev, chatStyles: prev.chatStyles.map(style => style.chatId === chatId ? { ...style, ...updates, chatId } : style) }))
      showToast(t('channelStyle.saved')); return true
    } catch (error) { showToast(error instanceof Error ? error.message : 'Изменения не сохранены. Повторите попытку.', 'error'); return false }
  }), [saveSections, showToast, t])

  const updateBrandKit = useCallback((channelId: string, updates: Partial<BrandKit>): Promise<boolean> => enqueueSave(`channel:${channelId}`, async () => {
    try {
      await saveSections(`/api/brandkits/${channelId}`, updates)
      brandKitService.update(channelId, updates)
      setState(prev => ({ ...prev, brandKits: brandKitService.getAll() }))
      showToast(t('channelStyle.saved')); return true
    } catch (error) { showToast(error instanceof Error ? error.message : 'Изменения не сохранены. Повторите попытку.', 'error'); return false }
  }), [saveSections, showToast, t])

  const activeChannel = state.channels.find(c => c.id === state.activeChannelId)

  const subscription = state.user.subscription
  const canSchedulePosts = subscription.limits.canSchedule
  const canUseAiAssistant = subscription.limits.canUseAiAssistant
  const canGenerate = subscription.usage.text.used < subscription.usage.text.limit
  const createsRemaining = Math.max(0, subscription.usage.text.limit - subscription.usage.text.used)

  return (
    <AppContext.Provider value={{
      state,
      authStatus,
      activeChannel,
      canSchedulePosts,
      canUseAiAssistant,
      canGenerate,
      createsRemaining,
      language,
      setLanguage,
      t,
      addPost,
      updatePost,
      publishPost,
      schedulePost,
      cancelSchedule,
      selectVariant,
      updateVariantText,
      deletePost,
      updateVariantBannerUrl,
      setActiveChannel,
      connectChannel,
      disconnectChannel,
      connectChat,
      disconnectChat,
      setChatLinkedChannel,
      updateBrandKit,
      updateChatStyle,
      applyServerSubscription,
      toasts,
      showToast,
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
