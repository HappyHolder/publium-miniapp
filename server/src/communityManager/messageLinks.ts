export function groupMessageLink(chatId:string,messageId:number):string|null {
  const group=chatId.match(/^-100(\d+)$/);
  return group&&Number.isSafeInteger(messageId)&&messageId>0?'https://t.me/c/'+group[1]+'/'+messageId:null;
}

type Source={reference:string;telegramMessageId:number|null;kind:string;text:string};
/** Only cite actual source messages returned by the scoped conversation tools. */
export function appendIntroReferences(text:string,references:string[],sources:Source[],chatId:string,currentMessageId?:number):string {
  const links=[...new Set(sources.filter(s=>references.includes(s.reference)&&s.kind==='human'&&s.telegramMessageId!==currentMessageId&&/(?:#intro\b|#интро(?=\s|$))/iu.test(s.text)).flatMap(s=>{const url=groupMessageLink(chatId,s.telegramMessageId??0);return url&&!text.includes(url)?[url]:[]}))].slice(0,2);
  if(!links.length)return text;
  const suffix='\n\nИнтро: '+links.join('\n');
  return text.slice(0,1400-suffix.length).trimEnd()+suffix;
}
