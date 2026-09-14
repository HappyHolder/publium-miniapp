export type PostStatus = 'new' | 'scheduled' | 'published'
export type SourceType = 'bot' | 'link' | 'prompt' | 'text' | 'photo' | 'forwarded_post' | 'manual'
// 'any' = "no preference" — the form shows a "Не важно" pill and the AI is left
// free on that dimension (the server skips 'any' when building the style prompt).
export type Tone = 'expert' | 'calm' | 'founder' | 'crypto' | 'bold' | 'meme' | 'any'
export type PostLength = 'short' | 'medium' | 'long' | 'any'
export type AddressStyle = 'ты' | 'вы' | 'any'
export type Language = 'RU' | 'EN' | 'BI'
export type LinkUsage = 'inline' | 'button' | 'signature' | 'when_relevant' | 'always'
export type BannerTemplate = 'dark_glass' | 'minimal' | 'branded' | 'news'

// New types for redesigned channel style profile
export type AuthorRole = 'founder' | 'expert' | 'media' | 'team' | 'personal' | 'any'
export type ParagraphStyle = 'short' | 'medium' | 'long'
export type ListUsage = 'never' | 'when_relevant' | 'always'
export type CoverAspectRatio = '16:9' | '4:5' | '1:1' | '9:16'
export type LogoUsage = 'always' | 'when_relevant' | 'never'
export type CoverLanguage = 'auto' | 'ru' | 'en'

export interface ChannelAbout {
  topic: string
  targetAudience: string
  contentGoal: string
}

export type PlanTier = 'free' | 'starter' | 'creator' | 'studio_pro'

export interface SubscriptionTierLimits {
  textGenerationsLimit: number
  visualGenerationsLimit: number
  channelLimit: number
  communityChatLimit: number
  assistantMessagesLimit: number
  contentManagerPostsLimit: number
  aiModeratorChecksLimit: number
  communityManagerActionsLimit: number
  communityCorePersonaLimit: number
  customBotChatLimit: number
  canSchedule: boolean
  canUseAiAssistant: boolean
  canUseContentManager: boolean
  canUseAiVisuals: boolean
  canUseHtmlCovers: boolean
  canUseAiModerator: boolean
  canUseCommunityManager: boolean
  canUseCommunityCore: boolean
}

export interface Subscription {
  planTier: PlanTier
  planName: string
  billingPeriod: 'monthly'
  status: 'active'
  expiresAt: string | null
  quotaResetAt: string | null
  usage: {
    text: { used: number; limit: number }
    visuals: { used: number; included: number; bonus: number; limit: number }
    assistant: { used: number; limit: number }
    contentManagerPosts: { used: number; limit: number }
    communityManagerActions: { used: number; limit: number }
  }
  limits: SubscriptionTierLimits
}
export interface Plan {
  tier: PlanTier
  name: string
  price: string
  priceDetail: string
  features: string[]
}

export interface User {
  id: string
  name: string
  username: string
  avatarUrl?: string
  subscription: Subscription
  isAdmin?: boolean
}

export interface Channel {
  id: string
  username: string
  title: string
  avatarUrl?: string
  subscribersCount: number | null
  isDefault: boolean
  isConnected: boolean
  linkedChat?: { id: string; title: string; username: string } | null
}

export interface Chat {
  id: string
  telegramId: string
  username: string
  title: string
  type: string
  membersCount: number | null
  isConnected: boolean
  communityId: string | null
  linkedChannel?: { id: string; title: string; username: string } | null
}

export interface ChatStyle {
  chatId: string
  channelAbout?: ChannelAbout
  voiceProfile: VoiceProfile
}

export interface VoiceProfile {
  language: Language
  addressStyle: AddressStyle
  authorRole?: AuthorRole
  tone: Tone
  postLength: PostLength
  examplePosts: string[]
  // How many of examplePosts to feed the model as few-shot voice samples (5 or 10).
  exampleCount?: number
  favoriteWords: string[]
  forbiddenWords: string[]
  // Free-text style guidance written by the channel owner. Injected verbatim
  // into the AI prompt as a hard rule. Optional / may be empty.
  customNote?: string
}


export type ButtonKind = 'url' | 'copy'
export type ButtonStyle = 'primary' | 'success' | 'danger'

export interface LinkItem {
  id: string
  label: string
  url: string
  anchorText: string
  buttonLabel: string
  usage: LinkUsage
  // Inline-keyboard extras (post buttons). Absent = plain URL button, no style,
  // own row — keeps older stored buttons working unchanged.
  kind?: ButtonKind
  copyText?: string       // used when kind === 'copy'
  style?: ButtonStyle     // primary | success | danger (recolor); absent = default
  sameRow?: boolean       // true = join the previous button's row (grid)
}

export interface LinkKit {
  links: LinkItem[]
}

export interface ReferenceItem {
  url: string
  description?: string
}

export interface BrandColor {
  name:   string
  hex:    string
  usage?: string
}

export interface VisualKit {
  logoUrl?: string
  primaryColor: string
  backgroundStyle: 'dark' | 'glass' | 'gradient'
  cardStyle: 'minimal' | 'branded' | 'bold'
  watermark: boolean
  bannerTemplate: BannerTemplate
  // New cover fields
  secondaryColor?: string
  aspectRatio?: CoverAspectRatio
  textOnCover?: boolean
  logoUsage?: LogoUsage
  references?: ReferenceItem[]
  avoidList?: string[]
  // Named color tokens replacing primaryColor/secondaryColor swatch UI
  brandColors?: BrandColor[]
  // Visual font guidance for image generation (not app UI)
  visualFontPreset?: 'default' | 'serif' | 'sans' | 'mono' | 'display' | 'handwritten'
  visualFontRules?: string
  // Master visual style for all covers — used as base of every image prompt
  visualCoverStyle?: string
  // Named HTML cover templates — one per channel rubric/content type.
  // AI picks the best match for each post; falls back to Satori if none fit.
  // Legacy: superseded by `rubrics` (kept in sync for backward compatibility).
  htmlTemplates?: HtmlTemplateItem[]
  // Content-type rubrics. When present, each post is classified into a rubric
  // whose `mode` + template decide the cover — replacing the channel coverMode
  // toggle. Absent → legacy coverMode + htmlTemplates path (unchanged).
  rubrics?: Rubric[]
  // Slide templates for post carousels, copied from an applied style pack.
  // Absent → the channel never gets a carousel (there is no default design).
  carouselTemplate?: CarouselTemplate
  // Cover generation mode:
  //   'ai'      — Flux neural image
  //   'html'    — user HTML templates / Sonnet structured cover
  //   'ai_html' — hybrid: Flux themed background + Sonnet overlay on top
  coverMode?: 'ai' | 'html' | 'ai_html'
  // Language of the text on covers: 'auto' = follow the post language
  coverLanguage?: CoverLanguage
  // How the neural background image is generated (AI mode; hybrid reuses it).
  // Detail level — how busy/rich the scene is. Default 'balanced'.
  coverBgDetail?: CoverBgDetail
  // Visual style of the generated background. 'auto' = no forced style (current
  // behaviour). Default 'auto'.
  coverBgStyle?: CoverBgStyle
}

export type CoverBgDetail = 'minimal' | 'balanced' | 'detailed'
export type CoverBgStyle =
  | 'auto'
  | 'hyperreal'
  | 'cinematic'
  | '3d'
  | 'cartoon'
  | 'anime'
  | 'clay'
  | 'pixel'
  | 'scifi'
  | 'cyberpunk'
  | 'vaporwave'
  | 'isometric'
  | 'minimal'
  | 'lowpoly'
  | 'glitch'
  | 'blueprint'
  | 'watercolor'
  | 'oil'

export interface HtmlTemplateItem {
  name: string       // rubric label shown in UI, used by AI for matching
  url:  string       // public URL of the stored .html file
  rubricName?: string
  rubricDescription?: string
  rubricMode?: CoverMode
  hybridPrompt?: string
  // Demo slot→value map used only to render the static market preview for this
  // template (e.g. { TITLE_WHITE: 'Bitcoin', TAG: 'crypto' }). Not used at
  // real cover-generation time (AI fills slots then).
  demoSlots?: Record<string, string>
  preview?: string     // first rendered slide (fallback / thumbnail)
  previews?: string[]  // full carousel sample sequence (cover + item slides) for the style card
}

// A content-type rubric for a channel. The AI classifies each post into one,
// and the rubric's `mode` + optional `template` decide how the cover is built —
// replacing the channel-wide coverMode toggle. Without a template only 'ai' is
// available; with a template the user picks 'html' or 'ai_html' too.
export interface Rubric {
  id:           string
  name:         string
  description?: string
  mode:         CoverMode
  templateUrl?: string   // the rubric's HTML cover template (html / ai_html modes)
  templateName?: string  // original filename, for display only
  hybridPrompt?: string  // ai_html-only: how the AI background should fit this template
}

export type CoverMode = 'ai' | 'html' | 'ai_html'

// A carousel is a SET of slide templates: cover (intro) → item (repeated per
// point) → outro (ending). Stored separately from the per-rubric cover templates.
export interface CarouselTemplate {
  cover?:    string      // url of the intro/cover slide template
  item?:     string      // url of the repeated item slide template
  outro?:    string      // url of the ending slide template
  previews?: string[]    // rendered sample sequence (cover + items + outro) for the style card
}

// A purchasable cover-style PACK from the Styles market (mirrors the server
// Style model's public shape, see server/src/lib/styles.ts serializeStyle).
export interface MarketStyle {
  id:               string
  slug:             string
  nameRu:           string
  nameEn:           string
  descRu:           string
  descEn:           string
  tags:             string[]
  priceKind:        'FREE' | 'PAID'
  priceGram:        number | null
  brandAdaptive:    boolean
  recommendedMode:  'html' | 'ai' | 'ai_html'
  palette:          BrandColor[]
  visualCoverStyle: string
  bgStyle:          string | null
  bgDetail:         string | null
  fontPreset:       string | null
  logoUsage:        string | null
  templates:        HtmlTemplateItem[]
  carouselTemplate?: CarouselTemplate | null  // carousel slide set (cover/item/outro)
  previews:         string[]
  heroPreview:      string | null
  sortOrder:        number
  // Showcase-only: visible in the market to everyone, but only an admin can
  // apply it (a shop window for the internal Publium / Stepan Logos packs).
  showcaseOnly?:    boolean
  // Admin-only fields (present on /api/admin/styles/list responses).
  published?:       boolean
  // Set by /api/styles/list for admins on unpublished (internal) styles.
  hidden?:          boolean
}

export interface Signature {
  text: string
  cta?: string
  usage: 'always' | 'when_relevant' | 'never'
}

export interface PostRules {
  defaultStructure: string
  neverCopySource: boolean
  avoidClickbait: boolean
  shortParagraphs: boolean
  addCtaIfRelevant: boolean
  useLinkKitWhenRelevant: boolean
  // New format fields
  paragraphStyle?: ParagraphStyle
  listUsage?: ListUsage
  ctaUsage?: 'never' | 'when_relevant' | 'always'
  thingsToAvoid?: string[]
  // Free-text formatting guidance written by the channel owner. Injected verbatim
  // into the AI prompt as a hard rule. Optional / may be empty.
  customNote?: string
}

export interface BrandKit {
  channelId: string
  channelAbout?: ChannelAbout
  voiceProfile: VoiceProfile
  linkKit: LinkKit
  visualKit: VisualKit
  signature: Signature
  postRules: PostRules
}

// ─── Formatted post (Telegram Rich Messages) — mirrors server/src/lib/richPost.ts ──
export interface Run {
  t:        string
  b?:       boolean
  i?:       boolean
  u?:       boolean
  s?:       boolean
  code?:    boolean
  spoiler?: boolean
  mark?:    boolean   // highlighted (Telegram "marked" style)
  link?:    string
}

// A list item: a line of runs plus an optional nested numbered sub-list.
export interface ListItem { runs: Run[]; sub?: Run[][] }

export type PostBlock =
  | { type: 'heading';   text: string; link?: string }
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'list';      ordered?: boolean; items: ListItem[] }
  | { type: 'quote';     runs: Run[]; expandable?: boolean }
  | { type: 'table';     headers: string[]; rows: string[][] }
  | { type: 'image';     url: string; prompt?: string } // prompt set = AI-generated (regeneratable)
  | { type: 'video';     url: string; poster?: string }
  | { type: 'document';  url: string; name: string; mime?: string; size?: number }
  | {
      type: 'gallery'
      layout: 'slideshow' | 'collage' | 'stack'
      urls: string[]
      matrix4?: string[][]
      panorama?: {
        sourceUrl: string
        method: 'ai' | 'upload'
        orientation: 'horizontal' | 'vertical' | 'grid4'
        count: number
      }
    }
  | { type: 'linkbox';   text: string; url: string }  // framed CTA box with a centered link
  | { type: 'checklist'; items: { text: string; checked: boolean }[] }
  | { type: 'details';   summary: string; body: string }  // collapsible section with a header
  | { type: 'code';      text: string; language?: string }
  | { type: 'divider' }

export interface PostVariant {
  id: string
  label: string
  text: string
  isSelected: boolean
  bannerUrl?: string | null
  // Structured formatted-post layout (null/absent = legacy plain post).
  blocks?: PostBlock[] | null
}

export interface Banner {
  id: string
  templateId: BannerTemplate
  title: string
  subtitle?: string
  accentColor: string
  logoUrl?: string
  watermark: boolean
}

export interface GeneratedPost {
  id: string
  title: string
  sourceType: SourceType
  editorMode?: 'rich' | 'legacy'
  sourceUrl?: string
  sourceSummary?: string
  channelId: string
  channelUsername: string
  variants: PostVariant[]
  selectedVariantId?: string
  banner?: Banner
  linkButtons: LinkItem[]
  status: PostStatus
  createdAt: Date
  scheduledAt?: Date
  publishedAt?: Date
  textRegensUsed?: number
  imageRegensUsed?: number
  coverMode?: 'ai' | 'html' | 'ai_html'
  coverAspectRatio?: CoverAspectRatio
  rubricId?: string | null      // rubric the post was classified into (null = legacy / none)
  rubricName?: string | null    // denormalized rubric name for the post chip
}

// Represents a bot-saved source input returned by POST /api/sources.
// type mirrors the DB SourceType enum values that the bot webhook creates.
export interface BotSource {
  id: string
  type: 'URL' | 'TEXT'
  content: string
  url: string | null      // extracted URL if type === 'URL', otherwise null
  channelId: string | null // from SourceInput.metadata.channelId
  createdAt: string        // ISO 8601 string from the API
}

export interface AppState {
  user: User
  channels: Channel[]
  chats: Chat[]
  brandKits: BrandKit[]
  chatStyles: ChatStyle[]
  posts: GeneratedPost[]
  activeChannelId: string
}
