import type { ReviewDecision } from './review';

export const COLLABER_PAGE_SIZE=5;
export const COLLABER_BATCH_SIZE=30;
export type ExposureHistory={counts:Map<string,number>;last:Map<string,number>;seen:Set<string>};
export const emptyExposureHistory=():ExposureHistory=>({counts:new Map(),last:new Map(),seen:new Set()});

/** Relevance classes take precedence; exposure history only orders comparable matches. */
export function distributeDecisions<T extends Pick<ReviewDecision,'id'|'fit'|'matchQuality'>>(decisions:T[],history:ExposureHistory):T[]{
 const index=new Map(decisions.map((d,i)=>[d.id,i]));
 const quality=(d:Pick<ReviewDecision,'fit'|'matchQuality'>)=>(d.fit==='direct'?0:2)+(d.matchQuality==='exact'?0:1);
 return [...decisions].sort((a,b)=>quality(a)-quality(b)
  ||Number(history.seen.has(a.id))-Number(history.seen.has(b.id))
  ||(history.counts.get(a.id)??0)-(history.counts.get(b.id)??0)
  ||(history.last.get(a.id)??0)-(history.last.get(b.id)??0)
  ||index.get(a.id)!-index.get(b.id)!);
}
