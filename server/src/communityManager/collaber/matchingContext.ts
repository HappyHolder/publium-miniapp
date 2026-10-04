import { rankFacts, terms, type Fact } from './domain';

/** Retrieval excerpts, not new profile facts. Semantic review must still check what is offered. */
export function introPassages(text:string,query:string,limit=2400):string[] {
  const words=new Set(terms(query));
  const chunks=text.slice(0,12000).split(/\n\s*\n/).flatMap(p=>p.match(/[\s\S]{1,700}(?:\s|$)|[\s\S]{1,700}/g)??[]).map(p=>p.trim()).filter(Boolean);
  const ranked=chunks.map((text,index)=>({text,index,score:terms(text).filter(t=>words.has(t)).length})).sort((a,b)=>b.score-a.score||a.index-b.index);
  const selected:typeof ranked=[];let remaining=limit;
  for(const chunk of ranked){if(remaining<80)break;const text=chunk.text.slice(0,remaining);selected.push({...chunk,text});remaining-=text.length+2}
  return selected.sort((a,b)=>a.index-b.index).map(p=>p.text);
}

export function rankProfileEvidence(query:string,profile:{facts:Fact[];sourceText:string;sourceAt:Date|null;sourceMessageId:number|null}) {
  const matches=rankFacts(query,profile.facts);
  const passages=introPassages(profile.sourceText,query);
  // Use quotes from the original intro when extraction omitted the relevant sentence.
  // These temporary values are never written into the profile's classified facts.
  const excerpts:Fact[]=profile.sourceAt?passages.map(evidence=>({kind:'project',value:evidence,evidence,at:profile.sourceAt!.toISOString(),expiresAt:null,sourceMessageId:String(profile.sourceMessageId??'')})):[];
  return {matches:[...matches,...rankFacts(query,excerpts)].sort((a,b)=>b.score-a.score),passages};
}

export function reviewedIds(value:unknown,allowed:Set<string>):string[] {
  const ids=(value as {ids?:unknown}|null)?.ids;
  if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!allowed.has(id)))throw new Error('Модель не вернула корректный список кандидатов. Подбор будет повторён.');
  return [...new Set(ids as string[])].slice(0,3);
}
