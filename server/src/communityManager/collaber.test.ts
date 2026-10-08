import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommunityManagerConfig } from './config';
import { parseCollaber, DEFAULT_COLLABER } from './collaber/config';
import { parseArchive, validateFacts, activeFacts, factsOf, factNeedsConfirmation, rankFacts, preferenceCommand, contactUrl, canAct, possibleIntro, isThirdPartyIntro, type IntroMessage } from './collaber/domain';
import { entryPayload, parseEntry } from './collaber/telegram';
import { matchPresentation } from './collaber/delivery';
import { introQuery } from './collaber/proposals';
import { introPassages, rankProfileEvidence, reviewedIds } from './collaber/matchingContext';
import { appendIntroReferences, groupMessageLink } from './messageLinks';

const message:IntroMessage={id:'17',userId:'42',name:'Анна',username:'annatest',text:'Меня зовут Анна. Разрабатываю приложение для изучения языков. Ищу партнёров для обмена аудиторией.',at:'2026-09-01T00:00:00.000Z'};
test('relay intro is never attributed to the sender when export omits is_bot',()=>{
 const relay='Test Person has joined the chat!\n\n#intro Founder at Example — Telegram application\n\nCurrent role: Founder at Example';
 assert.equal(isThirdPartyIntro(relay),true);assert.equal(possibleIntro(relay),false);
 assert.equal(possibleIntro('#intro Привет, я разработчик приложения и ищу партнёров.'),true);
 assert.equal(possibleIntro('📆 Что обсуждалось вчера 10.07.2024\nМой проект и founder\n#dailysummary'),false);
});
test('untagged team-development intros reach extraction',()=>{
 assert.equal(possibleIntro('Привет!\nCEO Example — с 2020 года разрабатываем приложения для Telegram.'),true);
 assert.equal(possibleIntro('Уверен, что любой CEO знает эту шутку про зарплаты.'),false);
 assert.equal(possibleIntro('Всем привет!\nФаундер Example. Буду рад совместным проектам.'),true);
});
test('historical offers remain searchable but require confirmation and cannot trigger a fresh initiative',()=>{
 const old={...message,at:'2024-06-01T00:00:00.000Z',text:'Предлагаю разработку приложений и маркетинг.'};
 const facts=validateFacts([{kind:'offer',value:old.text,evidence:old.text}],old,90);
 assert.equal(activeFacts(facts,new Date('2026-09-22')).length,0);
 assert.equal(rankFacts('разработка приложений',factsOf(facts)).length,1);
 assert.equal(factNeedsConfirmation(facts[0],90,new Date('2026-09-22')),true);
 const recent=validateFacts([{kind:'offer',value:old.text,evidence:old.text}],{...old,at:'2026-09-21T00:00:00.000Z'},90);
 assert.equal(factNeedsConfirmation(recent[0],90,new Date('2026-09-22')),false);
});
test('old CM configurations keep Collaber disabled and bound new settings',()=>{
 assert.equal(parseCommunityManagerConfig({}).features.collaber.enabled,false);
 const config=parseCollaber({enabled:'true',freshnessDays:-1,maxInitiativesPerDay:100,periodicDays:NaN,imageUrl:'javascript:alert(1)',buttons:{contact:false}});
 assert.equal(config.enabled,false);assert.equal(config.freshnessDays,7);assert.equal(config.maxInitiativesPerDay,5);assert.equal(config.imageUrl,'');assert.equal(config.buttons.contact,false);assert.equal(config.buttons.intro,true);
});
test('archive importer verifies chat identity and preserves stable IDs',()=>{
 const result=parseArchive({id:123,messages:[{id:17,from_id:'user42',from:'Анна',date:message.at,text:['Меня зовут ',{type:'bold',text:'Анна'}]},{id:17,from_id:'user42',date:message.at,text:'duplicate'},{id:18,from:'Анна',date:message.at,text:'No stable identity'},{id:19,from_id:'channel42',date:message.at,text:'channel'}]},'-100123');
 assert.equal(result.messages.length,1);assert.equal(result.messages[0].userId,'42');assert.equal(result.messages[0].text,'Меня зовут Анна');assert.equal(result.skipped,3);
 assert.throws(()=>parseArchive({id:999,messages:[]},'-100123'),/другому чату/);
});
test('forwarded messages and malformed dates are excluded from profile evidence',()=>{
 const result=parseArchive({chatId:'-100123',messages:[{id:1,userId:'42',at:'wrong',text:'x'},{id:2,userId:'42',at:message.at,text:'my project',forwarded_from:'Someone'},{id:3,userId:'42',at:'2999-01-01',text:'future'}]},'-100123');
 assert.equal(result.messages.length,0);assert.equal(result.skipped,3);
});
test('facts require verbatim evidence; unsupported model paraphrases never reach profile',()=>{
 const facts=validateFacts([{kind:'need',value:'Has 100000 users',evidence:'Ищу партнёров для обмена аудиторией.'},{kind:'skill',value:'invented',evidence:'Я эксперт в маркетинге'},{kind:'religion',value:'x',evidence:message.text}],message,7);
 assert.equal(facts.length,1);assert.equal(facts[0].value,'Ищу партнёров для обмена аудиторией.');assert.equal(activeFacts(facts,new Date('2026-09-20')).length,0);
});
test('opt-out language is explicit, not a quote within another message',()=>{
 assert.equal(preferenceCommand('Не предлагай меня!'),'hide');assert.equal(preferenceCommand('не упоминайте меня'),'no_mentions');assert.equal(preferenceCommand('/forget'),'forget');assert.equal(preferenceCommand('Он сказал «не предлагай меня»'),null);
 assert.equal(canAct('42','43'),false);assert.equal(canAct('42','42'),true);
});
test('contact draft is URL encoded and cannot inject another link or send a message',()=>{
 const url=contactUrl('annatest','кросс-промо & интересы');assert.ok(url?.startsWith('https://t.me/annatest?text='));assert.equal(new URL(url!).searchParams.size,1);assert.equal(contactUrl('bad/name','x'),null);assert.equal(contactUrl(null,'x'),null);
});
test('start link is authenticated and expires; changing manager breaks signature',()=>{
 const now=Date.now(),payload=entryPayload('manager1',now);assert.ok(payload.length<=64);assert.equal(parseEntry(payload,now),'manager1');assert.equal(parseEntry(payload.replace('manager1','manager2'),now),null);assert.equal(parseEntry(payload,now+31*86400000),null);
});
test('welcome entry remains valid without granting membership or exposing a profile',()=>{
 const payload=entryPayload('manager1');assert.equal(parseEntry(payload,Date.now()+366*86400000),'manager1');assert.equal(parseEntry(payload.replace('manager1','manager2')),null);
});
test('message respects image and button settings; interpolated text is escaped',()=>{
 const request={id:'c123',query:'кросс-промо',candidates:[{id:'p1',tgUserId:'42',name:'<script>Анна</script>',username:'annatest',description:'Проект <b>test</b>',reason:'Есть совпадение',evidence:'Источник',at:message.at}]};
 const config=parseCollaber({...DEFAULT_COLLABER,imageUrl:'https://example.com/cover.png',introduction:'<script>hello</script>'});
 const result=matchPresentation(request,config);assert.ok(!result.html.includes('<script>'));assert.ok(result.html.includes('&lt;script&gt;'));assert.ok(result.html.includes('cover.png'));
 for(const row of result.keyboard.inline_keyboard)for(const button of row)if(button.callback_data)assert.ok(Buffer.byteLength(button.callback_data)<=64);
 const plain=matchPresentation(request,{...config,showImage:false,buttons:{contact:false,intro:false,introduce:false,refine:false}});assert.ok(!plain.html.includes('cover.png'));assert.deepEqual(plain.keyboard.inline_keyboard,[]);
});
test('no candidates produces a useful empty state rather than invented people',()=>{
 const result=matchPresentation({id:'r',query:'задача',candidates:[]},{...DEFAULT_COLLABER,imageUrl:'https://example.com/cover.png'});assert.match(result.text,/не нашёл/);assert.ok(!result.html.includes('cover.png'));
 assert.deepEqual(result.keyboard.inline_keyboard,[[{text:'Уточнить подбор',callback_data:'cb:r:r:0'}]]);
});

test('new intro can suggest collaboration from an offer, but periodic initiatives require a fresh need',()=>{
 const source={...message,at:new Date().toISOString()};
 const offer=validateFacts([{kind:'offer',value:'x',evidence:'Разрабатываю приложение для изучения языков.'}],source,90);
 assert.match(introQuery(offer,'Обмен опытом',true),/Разрабатываю приложение/);
 assert.equal(introQuery(offer,'Обмен опытом',false),'');
 const need=validateFacts([{kind:'need',value:'x',evidence:'Ищу партнёров для обмена аудиторией.'}],source,90);
 assert.equal(introQuery(need,'Обмен опытом',false),'Ищу партнёров для обмена аудиторией.');
 assert.equal(introQuery([],'Обмен опытом',true),'');
 assert.equal(introQuery(need.map(f=>({...f,expiresAt:'2020-01-01'})),'Обмен опытом',false),'');
});

test('rich result keeps names, description and reason in separate paragraphs',()=>{
 const result=matchPresentation({id:'r',query:'партнёр',candidates:[{name:'Анна',description:'Создаёт приложение',reason:'Предлагает продвижение',at:message.at}]},DEFAULT_COLLABER);
 assert.match(result.html,/<p>1\. Анна<\/p>/);assert.match(result.html,/<p>Создаёт приложение<\/p>/);assert.match(result.html,/<p>Предлагает продвижение<\/p>/);
});

test('group results are short, image-free and have only one intro button per person',()=>{
 const candidate={id:'p',tgUserId:'42',name:'Анна <b>',username:'test',description:'Дополнительно: интеграция',reason:'Причина',evidence:'Предлагаю помощь с интеграцией API. '.repeat(25),at:message.at,introUrl:'https://t.me/c/123/17'};
 const result=matchPresentation({id:'r',chatId:'-100123',query:'интеграция',candidates:[candidate,candidate,candidate]}, {...DEFAULT_COLLABER,imageUrl:'https://example.com/cover.png'});
 assert.ok(!result.html.includes('cover.png'));assert.ok(result.text.length<600);assert.ok(!result.text.includes('Источник:'));
 assert.equal(result.keyboard.inline_keyboard.length,2);
 assert.ok(result.keyboard.inline_keyboard.every(row=>row.length===1&&row[0].text.startsWith('Интро:')));
 assert.ok(result.html.includes('&lt;b&gt;'));
 const empty=matchPresentation({id:'r',chatId:'-100123',query:'задача',candidates:[]},DEFAULT_COLLABER);
 assert.deepEqual(empty.keyboard.inline_keyboard,[]);
});
test('candidate facts distinguish useful offers from irrelevant words',()=>{
 const facts=validateFacts([{kind:'offer',value:'x',evidence:'Разрабатываю приложение для изучения языков.'}],message,90);
 assert.equal(rankFacts('разработка приложения для языков',facts).length,1);assert.equal(rankFacts('сварка металла',facts).length,0);
});

test('retrieval recovers project capabilities omitted by fact extraction',()=>{
 const sourceText='Меня зовут Иван. Я художник.\n\nСоздал Example ID.\n\nExample ID предоставляет верификацию пользователей мини-приложений и защиту от ботов.';
 const facts=validateFacts([{kind:'skill',value:'x',evidence:'Я художник.'}],{...message,text:sourceText},90);
 assert.equal(rankFacts('верификация пользователей',facts).length,0);
 const result=rankProfileEvidence('верификация пользователей',{facts,sourceText,sourceAt:new Date(message.at),sourceMessageId:17});
 assert.ok(result.matches.length);assert.match(result.matches[0].fact.evidence,/верификацию пользователей/);
 assert.ok(sourceText.includes(result.matches[0].fact.evidence));assert.equal(facts.length,1);
 const long='Не относящийся к делу текст. '.repeat(200)+'\n\nСервис верификации пользователей.';
 const passages=introPassages(long,'сервис верификации пользователей');
 assert.ok(passages.join('\n').length<=2400);assert.ok(passages.some(p=>p.includes('Сервис верификации')));
});

test('model failure and invented candidate IDs cannot masquerade as no matches',()=>{
 const allowed=new Set(['a','b']);
 assert.deepEqual(reviewedIds({ids:[]},allowed),[]);
 assert.deepEqual(reviewedIds({ids:['b','b','a']},allowed),['b','a']);
 for(const result of [null,{ids:null},{ids:['invented']},{ids:[42]}])assert.throws(()=>reviewedIds(result,allowed),/корректный список/);
});

test('intro button opens a verified group source and otherwise keeps the profile fallback',()=>{
 const c={id:'p',tgUserId:'42',name:'Анна',username:null,description:'Проект',reason:'Предложение',at:message.at};
 const result=matchPresentation({id:'r',query:'партнёр',candidates:[{...c,introUrl:'https://t.me/c/123/17'},c]},DEFAULT_COLLABER);
 const buttons=result.keyboard.inline_keyboard.flat().filter(b=>b.text.startsWith('Интро:'));
 assert.deepEqual(buttons,[{text:'Интро: Анна',url:'https://t.me/c/123/17'},{text:'Интро: Анна',callback_data:'cb:i:r:1'}]);
});

test('conversational intro references use only actual cited group messages',()=>{
 const source={reference:'msg:17',telegramMessageId:17,kind:'human',text:'#intro Я создал проект.'};
 assert.equal(groupMessageLink('42',17),null);assert.equal(groupMessageLink('-100123',0),null);
 assert.equal(appendIntroReferences('Обсудите интеграцию.',['msg:17'],[source],'-100123',18),'Обсудите интеграцию.\n\nИнтро: https://t.me/c/123/17');
 assert.equal(appendIntroReferences('Привет!',['msg:17'],[source],'-100123',17),'Привет!');
 assert.equal(appendIntroReferences('Ответ',['msg:999'],[source],'-100123',18),'Ответ');
 assert.equal(appendIntroReferences('Ответ',['msg:17'],[source],'42',18),'Ответ');
});
