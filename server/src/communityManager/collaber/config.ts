export type CollaberConfig = {
  version: 1; enabled: boolean; communityType: string; goals: string;
  collectIntros: boolean; onDemand: boolean; initiatives: 'off'|'drafts'|'auto';
  periodicDays: number; maxInitiativesPerDay: number; freshnessDays: number;
  imageUrl: string; showImage: boolean; introduction: string;
  buttons: { contact: boolean; intro: boolean; introduce: boolean; refine: boolean };
};
export const DEFAULT_COLLABER: CollaberConfig = {
  version: 1, enabled: false, communityType: 'Профессиональное сообщество',
  goals: 'Совместные проекты, обмен опытом и продвижение', collectIntros: true,
  onDemand: true, initiatives: 'drafts', periodicDays: 7, maxInitiativesPerDay: 1,
  freshnessDays: 90, imageUrl: '', showImage: true,
  introduction: 'Вот с кем можно обсудить сотрудничество:',
  buttons: { contact: true, intro: true, introduce: true, refine: true },
};
export function parseCollaber(raw: unknown): CollaberConfig {
  const r = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
  const text = (v: unknown, fallback: string, max: number) => typeof v === 'string' ? v.trim().slice(0,max) : fallback;
  const integer = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max,Math.max(min,Math.floor(v))) : fallback;
  const image = text(r.imageUrl,'',1000);
  return { version:1, enabled:bool(r.enabled,false), communityType:text(r.communityType,DEFAULT_COLLABER.communityType,160), goals:text(r.goals,DEFAULT_COLLABER.goals,500),
    collectIntros:bool(r.collectIntros,true), onDemand:bool(r.onDemand,true), initiatives:['off','drafts','auto'].includes(r.initiatives)?r.initiatives:'drafts',
    periodicDays:integer(r.periodicDays,7,0,30), maxInitiativesPerDay:integer(r.maxInitiativesPerDay,1,0,5), freshnessDays:integer(r.freshnessDays,90,7,365),
    imageUrl:/^(https:\/\/|\/uploads\/)/.test(image)?image:'', showImage:bool(r.showImage,true), introduction:text(r.introduction,DEFAULT_COLLABER.introduction,300),
    buttons:{contact:bool(r.buttons?.contact,true),intro:bool(r.buttons?.intro,true),introduce:bool(r.buttons?.introduce,true),refine:bool(r.buttons?.refine,true)},
  };
}
