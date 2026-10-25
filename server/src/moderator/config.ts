export type WelcomeButton = { id: string; label: string; url: string };
export type WelcomeBlock = { id: string; type: 'welcome'; enabled: boolean; text: string; returnText?: string; imageUrl?: string; buttons?: WelcomeButton[]; autoDeleteSeconds?: number; deleteJoinMessage?: boolean; firstJoinOnly?: boolean; skipBots?: boolean; skipAdmins?: boolean };
export type CaptchaBlock = { id: string; type: 'captcha'; enabled: boolean; text: string; buttonText: string; timeoutSeconds: number; failureAction: 'kick' | 'restrict'; deleteOnSuccess: boolean; skipBots: boolean; skipAdmins: boolean; skipTrusted: boolean };
export type AntiSpamBlock = { id: string; type: 'antispam'; enabled: boolean; floodEnabled: boolean; maxMessages: number; windowSeconds: number; duplicateEnabled: boolean; maxDuplicates: number; duplicateWindowSeconds: number; linksMode: 'allow' | 'block_all' | 'allowlist'; allowedDomains: string[]; telegramBotsMode: 'allow' | 'block_all' | 'allowlist'; allowedBotUsernames: string[]; action: 'delete' | 'delete_warn'; skipBots: boolean; skipAdmins: boolean; skipTrusted: boolean; raidEnabled: boolean; raidJoinThreshold: number; raidWindowSeconds: number; raidDurationMinutes: number; blacklistEnabled: boolean; blacklistThreshold: number; blacklistAction: 'observe' | 'restrict' | 'kick' };
export type ProbationBlock = { id: string; type: 'probation'; enabled: boolean; durationHours: number; messageThreshold: number; blockLinks: boolean; blockForwards: boolean; blockMedia: boolean; action: 'delete' | 'delete_warn' };
export type TextFilterCategory = { id: string; name: string; enabled: boolean; severity: 'standard' | 'serious' | 'critical'; terms: string[]; action: 'delete' | 'delete_warn'; responseMode: 'none' | 'custom'; responseText: string; autoDeleteSeconds: number };
export type ContentFiltersBlock = { id: string; type: 'content_filters'; enabled: boolean; stopWords: string[]; textCategories: TextFilterCategory[]; regexPatterns: string[]; blacklistedDomains: string[]; maxMentions: number; capsEnabled: boolean; capsPercent: number; capsMinLetters: number; emojiEnabled: boolean; maxEmoji: number; blockForwarded: boolean; blockedMedia: Array<'photo' | 'video' | 'document' | 'audio' | 'voice' | 'video_note' | 'sticker' | 'animation' | 'poll' | 'contact' | 'location'>; action: 'delete' | 'delete_warn'; skipBots: boolean; skipAdmins: boolean; skipTrusted: boolean };
export type ModeratorPersonality = { archetype:'calm'|'strict'|'insider'|'ironic'|'security'; character:string[]; manner:string[]; strictness:0|1|2|3; humor:0|1|2; slang:boolean; customInstructions:string };
export type AiModerationAction = 'review' | 'delete' | 'delete_warn' | 'delete_rewrite' | 'delete_rewrite_warn';
export type ConversationCategory = 'conflict' | 'toxicity' | 'harassment' | 'threat' | 'fraud' | 'semantic_spam' | 'off_topic';
export type AiSanctionPolicy = { warningExpiryDays:number; muteAfterWarnings:number; muteDurationSeconds:number; banAfterWarnings:number };
export type MessageModerationConfig = { enabled:boolean; action:AiModerationAction; confidenceThreshold:number; minLength:number; customRule:string; skipBots:boolean; skipAdmins:boolean; skipTrusted:boolean; allowedWords:string[]; noticeText:string };
export type ConversationAnalysisConfig = { enabled:boolean; categories:ConversationCategory[]; reaction:'observe'|'respond'|'sanctions'; customRules:string; responseAutoDeleteSeconds:number; personality:ModeratorPersonality; minMessages:number; confidenceThreshold:number; sanctions:AiSanctionPolicy };
export type AiModerationBlock = { id:string; type:'ai_moderation'; enabled:boolean; messageModeration:MessageModerationConfig; conversationAnalysis:ConversationAnalysisConfig };
export type AiModeratorSection = 'messageModeration' | 'conversationAnalysis';
export function isAiModeratorSection(value: unknown): value is AiModeratorSection {
  return value === 'messageModeration' || value === 'conversationAnalysis';
}
export function mergeAiModeratorSection(base: AiModerationBlock, incoming: AiModerationBlock, section: AiModeratorSection): AiModerationBlock {
  const next = { ...base, [section]: incoming[section] };
  return { ...next, enabled: next.messageModeration.enabled || next.conversationAnalysis.enabled };
}
export type WarningPolicyBlock = { id: string; type: 'warning_policy'; enabled: boolean; warningExpiryDays: number; muteAfterWarnings: number; muteDurationSeconds: number; banAfterWarnings: number; deleteCommandMessages: boolean; notifyUser: boolean; skipAdmins: boolean };
export type TriggerButton = { id: string; label: string; url: string };
export type TriggerReply = { id: string; name: string; enabled: boolean; phrases: string[]; matchMode: 'exact' | 'prefix' | 'contains'; text: string; imageUrl?: string; buttons: TriggerButton[]; access: 'all' | 'admins'; cooldownSeconds: number; autoDeleteSeconds: number; deleteTriggerMessage: boolean; useAsAiKnowledge: boolean };
export type TriggersBlock = { id: string; type: 'triggers'; enabled: boolean; skipBots: boolean; triggers: TriggerReply[] };
export type ModeratorBlock = WelcomeBlock | CaptchaBlock | AntiSpamBlock | ContentFiltersBlock | WarningPolicyBlock | AiModerationBlock | TriggersBlock | ProbationBlock;

export const DEFAULT_BLOCKS: ModeratorBlock[] = [
  { id: 'welcome-default', type: 'welcome', enabled: false, text: 'Добро пожаловать, **{name}**! Перед общением познакомьтесь с правилами {group}.', buttons: [], autoDeleteSeconds: 0, deleteJoinMessage: false, firstJoinOnly: false, skipBots: true, skipAdmins: true },
  { id: 'captcha-default', type: 'captcha', enabled: false, text: '**{name}**, подтвердите, что вы человек.', buttonText: 'Я человек', timeoutSeconds: 300, failureAction: 'kick', deleteOnSuccess: true, skipBots: true, skipAdmins: true, skipTrusted: true },
  { id: 'content-filters-default', type: 'content_filters', enabled: false, stopWords: [], textCategories: [], regexPatterns: [], blacklistedDomains: [], maxMentions: 0, capsEnabled: false, capsPercent: 80, capsMinLetters: 10, emojiEnabled: false, maxEmoji: 10, blockForwarded: false, blockedMedia: [], action: 'delete', skipBots: true, skipAdmins: true, skipTrusted: true },
  { id:'ai-moderation-default', type:'ai_moderation', enabled:false, messageModeration:{enabled:false,action:'review',confidenceThreshold:0.85,minLength:1,customRule:'',skipBots:true,skipAdmins:true,skipTrusted:true,allowedWords:[],noticeText:'Пиши без мата.'}, conversationAnalysis:{enabled:false,categories:['conflict','toxicity','harassment','threat','fraud','semantic_spam'],reaction:'observe',customRules:'',responseAutoDeleteSeconds:600,minMessages:3,confidenceThreshold:.9,sanctions:{warningExpiryDays:30,muteAfterWarnings:3,muteDurationSeconds:3600,banAfterWarnings:0},personality:{archetype:'calm',character:['спокойный','справедливый'],manner:['коротко','по делу'],strictness:2,humor:0,slang:false,customInstructions:''}} },
  { id: 'warning-policy-default', type: 'warning_policy', enabled: true, warningExpiryDays: 30, muteAfterWarnings: 3, muteDurationSeconds: 3600, banAfterWarnings: 5, deleteCommandMessages: true, notifyUser: true, skipAdmins: true },
  { id: 'antispam-default', type: 'antispam', enabled: false, floodEnabled: true, maxMessages: 6, windowSeconds: 10, duplicateEnabled: true, maxDuplicates: 3, duplicateWindowSeconds: 60, linksMode: 'allow', allowedDomains: [], telegramBotsMode: 'allow', allowedBotUsernames: [], action: 'delete', skipBots: true, skipAdmins: true, skipTrusted: true, raidEnabled: false, raidJoinThreshold: 10, raidWindowSeconds: 60, raidDurationMinutes: 30, blacklistEnabled: false, blacklistThreshold: 2, blacklistAction: 'observe' },
  { id: 'probation-default', type: 'probation', enabled: false, durationHours: 24, messageThreshold: 5, blockLinks: true, blockForwards: true, blockMedia: false, action: 'delete_warn' },
  { id: 'triggers-default', type: 'triggers', enabled: false, skipBots: true, triggers: [] },
];

const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
const integer = (v: unknown, fallback: number, min: number, max: number) => Math.max(min, Math.min(Number.isInteger(v) ? Number(v) : fallback, max));
const normalizeDomains = (raw: unknown) => [...new Set((Array.isArray(raw) ? raw : []).flatMap(v => typeof v === 'string' ? [v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? ''] : []).filter(Boolean))].slice(0, 100);
const MEDIA_TYPES = new Set(['photo','video','document','audio','voice','video_note','sticker','animation','poll','contact','location']);
const safeRegexPatterns = (raw: unknown): string[] => (Array.isArray(raw) ? raw : []).slice(0, 20).map((v, i) => { const pattern = typeof v === 'string' ? v.trim() : ''; if (!pattern) return ''; const unbounded = (pattern.match(/[*+]/g)?.length ?? 0) + (pattern.match(/\{\d+,\}/g)?.length ?? 0); const oversizedRange = [...pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].some(m => Number(m[1]) > 100 || (m[2] && Number(m[2]) > 100)); if (pattern.length > 120 || /\\[1-9]/.test(pattern) || /\(\?[=!<]/.test(pattern) || /\([^)]*[*+?{][^)]*\)[*+?{]/.test(pattern) || /\([^)]*\|[^)]*\)[*+?{]/.test(pattern) || unbounded > 1 || oversizedRange) throw new Error(`Небезопасное regex-выражение в строке ${i + 1}`); try { new RegExp(pattern, 'iu'); } catch { throw new Error(`Некорректное regex-выражение в строке ${i + 1}`); } return pattern; }).filter(Boolean);
const idAndEnabled = (b: Record<string, unknown>, index: number) => { if (typeof b['id'] !== 'string' || !b['id']) throw new Error(`blocks[${index}].id is required`); if (typeof b['enabled'] !== 'boolean') throw new Error(`blocks[${index}].enabled must be boolean`); return { id: b['id'], enabled: b['enabled'] }; };
const textList=(value:unknown,fallback:string[],max=5)=>Array.isArray(value)?[...new Set(value.flatMap(item=>typeof item==='string'&&item.trim()?[item.trim().slice(0,60)]:[]))].slice(0,max):fallback;
export const normalizeAllowedWords = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : []).flatMap(item =>
  typeof item === 'string' ? item.split(/[\n,;]+/).map(word => word.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim()) : [],
).filter(word => /^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u.test(word) && word.length <= 60))].slice(0, 100);
const moderatorPersonality=(value:unknown):ModeratorPersonality=>{
  const p=value&&typeof value==='object'?value as Record<string,unknown>:{},archetype=['calm','strict','insider','ironic','security'].includes(String(p['archetype']))?String(p['archetype']) as ModeratorPersonality['archetype']:'calm';
  return {archetype,character:textList(p['character'],['спокойный','справедливый']),manner:textList(p['manner'],['коротко','по делу']),strictness:integer(p['strictness'],2,0,3) as 0|1|2|3,humor:integer(p['humor'],0,0,2) as 0|1|2,slang:bool(p['slang'],false),customInstructions:typeof p['customInstructions']==='string'?p['customInstructions'].trim().slice(0,600):''};
};


export function parseBlocks(value: unknown): ModeratorBlock[] {
  if (!Array.isArray(value)) throw new Error('blocks must be an array');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`blocks[${index}] must be an object`);
    const b = raw as Record<string, unknown>; const base = idAndEnabled(b, index);
    if (b['type'] === 'triggers') {
      const triggers = (Array.isArray(b['triggers']) ? b['triggers'] : []).slice(0, 50).flatMap((rawTrigger, triggerIndex): TriggerReply[] => {
        if (!rawTrigger || typeof rawTrigger !== 'object') return [];
        const t = rawTrigger as Record<string, unknown>;
        const phrases = [...new Set((Array.isArray(t['phrases']) ? t['phrases'] : []).flatMap(v => typeof v === 'string' ? [v.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ')] : []).filter(Boolean))].slice(0, 10).map(v => v.slice(0, 100));
        const text = typeof t['text'] === 'string' ? t['text'].trim().slice(0, 3500) : '';
        if (!phrases.length || !text) return [];
        const buttons = (Array.isArray(t['buttons']) ? t['buttons'] : []).slice(0, 3).flatMap((rawButton, buttonIndex): TriggerButton[] => {
          if (!rawButton || typeof rawButton !== 'object') return [];
          const q = rawButton as Record<string, unknown>, label = typeof q['label'] === 'string' ? q['label'].trim().slice(0, 64) : '', url = typeof q['url'] === 'string' ? q['url'].trim().slice(0, 2000) : '';
          return label && /^(https?:\/\/|tg:\/\/|@)/i.test(url) ? [{ id: typeof q['id'] === 'string' ? q['id'] : 'trigger-button-' + triggerIndex + '-' + buttonIndex, label, url }] : [];
        });
        return [{ id: typeof t['id'] === 'string' && t['id'] ? t['id'].slice(0, 100) : 'trigger-' + triggerIndex, name: (typeof t['name'] === 'string' && t['name'].trim() ? t['name'].trim() : phrases[0]!).slice(0, 80), enabled: bool(t['enabled'], true), phrases, matchMode: t['matchMode'] === 'prefix' || t['matchMode'] === 'contains' ? t['matchMode'] : 'exact', text, ...(typeof t['imageUrl'] === 'string' && /^https?:\/\//i.test(t['imageUrl']) ? { imageUrl: t['imageUrl'].slice(0, 2000) } : {}), buttons, access: t['access'] === 'admins' ? 'admins' : 'all', cooldownSeconds: integer(t['cooldownSeconds'], 30, 0, 3600), autoDeleteSeconds: integer(t['autoDeleteSeconds'], 0, 0, 172800), deleteTriggerMessage: bool(t['deleteTriggerMessage'], false), useAsAiKnowledge: bool(t['useAsAiKnowledge'], false) }];
      });
      return { ...base, type: 'triggers', skipBots: bool(b['skipBots'], true), triggers };
    }
    if (b['type'] === 'ai_moderation') {
      const messageRaw = b['messageModeration'] && typeof b['messageModeration'] === 'object' && !Array.isArray(b['messageModeration']) ? b['messageModeration'] as Record<string,unknown> : null;
      const conversationRaw = b['conversationAnalysis'] && typeof b['conversationAnalysis'] === 'object' && !Array.isArray(b['conversationAnalysis']) ? b['conversationAnalysis'] as Record<string,unknown> : null;
      const legacyAction = ['delete','delete_warn','delete_rewrite','delete_rewrite_warn'].includes(String(b['action'])) ? b['action'] as AiModerationAction : 'review';
      const messageAction = ['delete','delete_warn','delete_rewrite','delete_rewrite_warn'].includes(String(messageRaw?.['action'])) ? messageRaw?.['action'] as AiModerationAction : messageRaw?.['action'] === 'review' ? 'review' : legacyAction;
      const categoryValues = new Set<ConversationCategory>(['conflict','toxicity','harassment','threat','fraud','semantic_spam','off_topic']);
      const categories = [...new Set((Array.isArray(conversationRaw?.['categories']) ? conversationRaw['categories'] : ['conflict','toxicity','harassment','threat','fraud','semantic_spam']).flatMap(value => typeof value === 'string' && categoryValues.has(value as ConversationCategory) ? [value as ConversationCategory] : []))];
      const legacyRules = typeof b['rules'] === 'string' ? b['rules'].trim().slice(0,3000) : '';
      let reaction: ConversationAnalysisConfig['reaction'] = conversationRaw?.['reaction'] === 'respond' || conversationRaw?.['reaction'] === 'sanctions'
        ? conversationRaw['reaction']
        : b['interventionMode'] === 'respond' || b['interventionMode'] === 'respond_warn' ? 'respond' : 'observe';
      const legacyWarningPolicy = value.find(raw => raw && typeof raw === 'object' && raw.type === 'warning_policy');
      // Older installations used the shared switch. Migration must not silently enable punishment.
      if (reaction === 'sanctions' && !conversationRaw?.['sanctions'] && legacyWarningPolicy?.enabled === false) reaction = 'respond';
      const messageModeration:MessageModerationConfig = {
        enabled:bool(messageRaw?.['enabled'],bool(b['enabled'],false)),
        action:messageAction,
        confidenceThreshold:Math.max(0.5,Math.min(typeof messageRaw?.['confidenceThreshold']==='number'?messageRaw['confidenceThreshold']:typeof b['confidenceThreshold']==='number'?b['confidenceThreshold']:0.85,0.99)),
        minLength:integer(messageRaw?.['minLength']??b['minLength'],1,1,500),
        customRule:(typeof messageRaw?.['customRule'] === 'string' ? messageRaw['customRule'].trim() : '').slice(0,1000),
        skipBots:bool(messageRaw?.['skipBots'],bool(b['skipBots'],true)),
        skipAdmins:bool(messageRaw?.['skipAdmins'],bool(b['skipAdmins'],true)),
        skipTrusted:bool(messageRaw?.['skipTrusted'],bool(b['skipTrusted'],true)),
        allowedWords:normalizeAllowedWords(messageRaw?.['allowedWords']),
        noticeText:typeof messageRaw?.['noticeText']==='string'&&messageRaw['noticeText'].trim()?messageRaw['noticeText'].trim().slice(0,300):'Пиши без мата.',
      };
      const conversationAnalysis:ConversationAnalysisConfig = {
        enabled:bool(conversationRaw?.['enabled'],bool(b['interventionsEnabled'],false)),
        categories,
        reaction,
        customRules:(typeof conversationRaw?.['customRules'] === 'string' ? conversationRaw['customRules'].trim() : legacyRules).slice(0,3000),
        responseAutoDeleteSeconds:integer(conversationRaw?.['responseAutoDeleteSeconds'] ?? b['responseAutoDeleteSeconds'],600,0,86400),
        personality:moderatorPersonality(conversationRaw?.['personality'] ?? b['personality']),
        minMessages:integer(conversationRaw?.['minMessages'],3,2,8),
        confidenceThreshold:Math.max(.85,Math.min(typeof conversationRaw?.['confidenceThreshold']==='number'?conversationRaw['confidenceThreshold']:.9,.99)),
        sanctions:parseAiSanctionPolicy(conversationRaw?.['sanctions'], value.find(raw => raw && typeof raw === 'object' && raw.type === 'warning_policy')),
      };
      return { ...base, type:'ai_moderation', enabled:messageModeration.enabled||conversationAnalysis.enabled, messageModeration, conversationAnalysis };
    }
    if (b['type'] === 'warning_policy') return { ...base, type: 'warning_policy', warningExpiryDays: integer(b['warningExpiryDays'], 30, 0, 365), muteAfterWarnings: integer(b['muteAfterWarnings'], 3, 0, 20), muteDurationSeconds: integer(b['muteDurationSeconds'], 3600, 60, 2592000), banAfterWarnings: integer(b['banAfterWarnings'], 5, 0, 50), deleteCommandMessages: bool(b['deleteCommandMessages'], true), notifyUser: bool(b['notifyUser'], true), skipAdmins: bool(b['skipAdmins'], true) };
    if (b['type'] === 'captcha') { const text = typeof b['text'] === 'string' ? b['text'].trim() : ''; if (!text) throw new Error(`blocks[${index}].text is required`); return { ...base, type: 'captcha', text: text.slice(0, 1000), buttonText: (typeof b['buttonText'] === 'string' && b['buttonText'].trim() ? b['buttonText'].trim() : 'Я человек').slice(0, 64), timeoutSeconds: integer(b['timeoutSeconds'], 300, 60, 1800), failureAction: b['failureAction'] === 'restrict' ? 'restrict' : 'kick', deleteOnSuccess: bool(b['deleteOnSuccess'], true), skipBots: bool(b['skipBots'], true), skipAdmins: bool(b['skipAdmins'], true), skipTrusted: bool(b['skipTrusted'], true) }; }
    if (b['type'] === 'content_filters') { const stopWords = [...new Set((Array.isArray(b['stopWords']) ? b['stopWords'] : []).flatMap(v => typeof v === 'string' ? v.split(/[\n,;\t]+/).map(item => item.trim().toLowerCase().replace(/\s+/g, ' ')) : []).filter(Boolean))].slice(0, 1000).map(v => v.slice(0, 64)); const textCategories = (Array.isArray(b['textCategories']) ? b['textCategories'] : []).slice(0, 20).flatMap((rawCategory, categoryIndex): TextFilterCategory[] => { if (!rawCategory || typeof rawCategory !== 'object') return []; const c = rawCategory as Record<string, unknown>; const terms = [...new Set((Array.isArray(c['terms']) ? c['terms'] : []).flatMap(v => typeof v === 'string' ? v.split(/[\n,;\t]+/).map(item => item.trim().toLowerCase().replace(/\s+/g, ' ')) : []).filter(Boolean))].slice(0, 1000).map(v => v.slice(0, 100)); if (!terms.length) return []; return [{ id: typeof c['id'] === 'string' && c['id'] ? c['id'].slice(0, 100) : 'filter-category-' + categoryIndex, name: (typeof c['name'] === 'string' && c['name'].trim() ? c['name'].trim() : 'Категория').slice(0, 80), enabled: bool(c['enabled'], true), severity: c['severity'] === 'serious' || c['severity'] === 'critical' ? c['severity'] : 'standard', terms, action: c['action'] === 'delete_warn' ? 'delete_warn' : 'delete', responseMode: c['responseMode'] === 'custom' ? 'custom' : 'none', responseText: (typeof c['responseText'] === 'string' ? c['responseText'].trim() : '').slice(0, 500), autoDeleteSeconds: integer(c['autoDeleteSeconds'], 0, 0, 86400) }]; }); const blockedMedia = [...new Set((Array.isArray(b['blockedMedia']) ? b['blockedMedia'] : []).flatMap(v => typeof v === 'string' && MEDIA_TYPES.has(v) ? [v] : []))] as ContentFiltersBlock['blockedMedia']; return { ...base, type: 'content_filters', stopWords, textCategories, regexPatterns: safeRegexPatterns(b['regexPatterns']), blacklistedDomains: normalizeDomains(b['blacklistedDomains']), maxMentions: integer(b['maxMentions'], 0, 0, 20), capsEnabled: bool(b['capsEnabled'], false), capsPercent: integer(b['capsPercent'], 80, 50, 100), capsMinLetters: integer(b['capsMinLetters'], 10, 5, 100), emojiEnabled: bool(b['emojiEnabled'], false), maxEmoji: integer(b['maxEmoji'], 10, 3, 50), blockForwarded: bool(b['blockForwarded'], false), blockedMedia, action: b['action'] === 'delete_warn' ? 'delete_warn' : 'delete', skipBots: bool(b['skipBots'], true), skipAdmins: bool(b['skipAdmins'], true), skipTrusted: bool(b['skipTrusted'], true) }; }
    if (b['type'] === 'antispam') {
      const rawDomains = Array.isArray(b['allowedDomains']) ? b['allowedDomains'] : [];
      const allowedDomains = [...new Set(rawDomains.flatMap(v => typeof v === 'string' ? [v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? ''] : []).filter(Boolean))].slice(0, 100);
      const rawBotUsernames = Array.isArray(b['allowedBotUsernames']) ? b['allowedBotUsernames'] : [];
      const allowedBotUsernames = [...new Set(rawBotUsernames.flatMap(value => {
        if (typeof value !== 'string') return [];
        const username = value.trim().toLowerCase().replace(/^@/, '').replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//, '').split(/[/?#]/)[0] ?? '';
        return /^[a-z0-9_]{2,29}bot$/.test(username) ? [username] : [];
      }))].slice(0, 100);
      return {
        ...base,
        type: 'antispam',
        floodEnabled: bool(b['floodEnabled'], true),
        maxMessages: integer(b['maxMessages'], 6, 3, 20),
        windowSeconds: integer(b['windowSeconds'], 10, 5, 60),
        duplicateEnabled: bool(b['duplicateEnabled'], true),
        maxDuplicates: integer(b['maxDuplicates'], 3, 2, 10),
        duplicateWindowSeconds: integer(b['duplicateWindowSeconds'], 60, 10, 300),
        linksMode: b['linksMode'] === 'block_all' || b['linksMode'] === 'allowlist' ? b['linksMode'] : 'allow',
        allowedDomains,
        telegramBotsMode: b['telegramBotsMode'] === 'block_all' || b['telegramBotsMode'] === 'allowlist' ? b['telegramBotsMode'] : 'allow',
        allowedBotUsernames,
        action: b['action'] === 'delete_warn' ? 'delete_warn' : 'delete',
        skipBots: bool(b['skipBots'], true),
        skipAdmins: bool(b['skipAdmins'], true),
        skipTrusted: bool(b['skipTrusted'], true),
        raidEnabled: bool(b['raidEnabled'], false),
        raidJoinThreshold: integer(b['raidJoinThreshold'], 10, 3, 100),
        raidWindowSeconds: integer(b['raidWindowSeconds'], 60, 20, 600),
        raidDurationMinutes: integer(b['raidDurationMinutes'], 30, 5, 360),
        blacklistEnabled: bool(b['blacklistEnabled'], false),
        blacklistThreshold: integer(b['blacklistThreshold'], 2, 1, 10),
        blacklistAction: b['blacklistAction'] === 'restrict' || b['blacklistAction'] === 'kick' ? b['blacklistAction'] : 'observe',
      };
    }
    if (b['type'] === 'probation') return { ...base, type: 'probation', durationHours: integer(b['durationHours'], 24, 1, 720), messageThreshold: integer(b['messageThreshold'], 5, 0, 100), blockLinks: bool(b['blockLinks'], true), blockForwards: bool(b['blockForwards'], true), blockMedia: bool(b['blockMedia'], false), action: b['action'] === 'delete' ? 'delete' : 'delete_warn' };
    if (b['type'] !== 'welcome') throw new Error(`Unsupported block type: ${String(b['type'])}`);
    const text = typeof b['text'] === 'string' ? b['text'].trim() : ''; if (!text) throw new Error(`blocks[${index}].text is required`);
    const buttons = Array.isArray(b['buttons']) ? b['buttons'].slice(0, 3).flatMap((x, i) => { if (!x || typeof x !== 'object') return []; const q = x as Record<string, unknown>, label = typeof q['label'] === 'string' ? q['label'].trim().slice(0, 64) : '', url = typeof q['url'] === 'string' ? q['url'].trim().slice(0, 2000) : ''; return label && /^(https?:\/\/|@)/i.test(url) ? [{ id: typeof q['id'] === 'string' ? q['id'] : `welcome-btn-${i}`, label, url }] : []; }) : [];
    return { ...base, type: 'welcome', text: text.slice(0, 3500), ...(typeof b['returnText'] === 'string' && b['returnText'].trim() ? { returnText: b['returnText'].trim().slice(0, 3500) } : {}), ...(typeof b['imageUrl'] === 'string' && /^https?:\/\//i.test(b['imageUrl']) ? { imageUrl: b['imageUrl'].slice(0, 2000) } : {}), buttons, autoDeleteSeconds: integer(b['autoDeleteSeconds'], 0, 0, 172800), deleteJoinMessage: bool(b['deleteJoinMessage'], false), firstJoinOnly: bool(b['firstJoinOnly'], false), skipBots: bool(b['skipBots'], true), skipAdmins: bool(b['skipAdmins'], true) };
  });
}

/** Old installations keep their published thresholds; new conflict policies never ban by default. */
function parseAiSanctionPolicy(value: unknown, legacy?: unknown): AiSanctionPolicy {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> :
    legacy && typeof legacy === 'object' ? legacy as Record<string, unknown> : {};
  return {
    warningExpiryDays:integer(raw['warningExpiryDays'],30,0,365),
    muteAfterWarnings:integer(raw['muteAfterWarnings'],3,0,20),
    muteDurationSeconds:integer(raw['muteDurationSeconds'],3600,60,2592000),
    banAfterWarnings:integer(raw['banAfterWarnings'],0,0,50),
  };
}

export function requiredRightsFor(blocks: ModeratorBlock[]) {
  const welcome = blocks.find(b => b.type === 'welcome' && b.enabled) as WelcomeBlock | undefined;
  const captcha = blocks.find(b => b.type === 'captcha' && b.enabled);
  const antiSpam = blocks.find(b => b.type === 'antispam' && b.enabled);
  const filters = blocks.find(b => b.type === 'content_filters' && b.enabled);
  const aiModeration = blocks.find(b => b.type === 'ai_moderation') as AiModerationBlock | undefined;
  const warningPolicy = blocks.find(b => b.type === 'warning_policy' && b.enabled);
  const triggers = blocks.find(b => b.type === 'triggers' && b.enabled) as TriggersBlock | undefined;
  const probation = blocks.find(b => b.type === 'probation' && b.enabled);
  const antiSpamBlock = antiSpam as AntiSpamBlock | undefined;
  const raidOrBlacklist = Boolean(antiSpamBlock && (antiSpamBlock.raidEnabled || (antiSpamBlock.blacklistEnabled && antiSpamBlock.blacklistAction !== 'observe')));
  const triggerDeletes = triggers?.triggers.some(t => t.enabled && (t.deleteTriggerMessage || t.autoDeleteSeconds));
  const aiDeletes = Boolean(aiModeration?.messageModeration.enabled && aiModeration.messageModeration.action !== 'review');
  const aiDeletesResponse = Boolean(aiModeration?.conversationAnalysis.enabled && aiModeration.conversationAnalysis.reaction !== 'observe' && aiModeration.conversationAnalysis.responseAutoDeleteSeconds > 0);
  const aiSanctions = Boolean(aiModeration?.conversationAnalysis.enabled && aiModeration.conversationAnalysis.reaction === 'sanctions');
  return { can_delete_messages: Boolean((welcome && (welcome.deleteJoinMessage || welcome.autoDeleteSeconds)) || captcha || antiSpam || filters || warningPolicy || aiDeletes || aiDeletesResponse || triggerDeletes || probation), can_restrict_members: Boolean(captcha || warningPolicy || raidOrBlacklist || aiSanctions) };
}
