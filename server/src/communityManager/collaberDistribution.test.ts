import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLABER_PAGE_SIZE, distributeDecisions, emptyExposureHistory } from './collaber/distribution';
import type { ReviewDecision } from './collaber/review';
import { continuationPayload, parseContinuation } from './collaber/telegram';
import { matchPresentation } from './collaber/delivery';
import { DEFAULT_COLLABER } from './collaber/config';

const decision=(id:string,patch:Partial<ReviewDecision>={}):ReviewDecision=>({id,role:'provider',fit:'direct',matchQuality:'exact',evidence:'Продвигаю приложения Telegram.',reasonCode:'relevant_capability',...patch});
test('five is the page ceiling in groups and private chats, with paired contact buttons',()=>{
 const candidates=Array.from({length:25},(_,i)=>({id:'p'+i,tgUserId:String(100+i),name:'Маркетолог '+i,username:'example_'+i,description:'Маркетинг',reason:'Подходит по задаче',evidence:'Продвигаю приложения Telegram.',at:new Date().toISOString(),introUrl:'https://t.me/c/123/'+i}));
 for(const chatId of ['-100123','43']){
  const result=matchPresentation({id:'request',chatId,query:'маркетолог',candidates,pageVersion:7,hasMore:true,hasPrevious:true,privateUrl:'https://t.me/example_bot?start=cs_fixture'},DEFAULT_COLLABER);
  assert.equal(result.keyboard.inline_keyboard.filter(row=>row.some(b=>b.text.startsWith('Написать'))).length,COLLABER_PAGE_SIZE);
  assert.ok(result.keyboard.inline_keyboard.slice(0,5).every(row=>row.length===2&&row[1].text==='Интро'));
  assert.ok(result.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='cb:more:request:7'));
  assert.ok(result.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='cb:prev:request:7'));
  assert.equal(result.keyboard.inline_keyboard.flat().some(b=>b.text==='Продолжить в личке'),chatId.startsWith('-'));
  assert.ok(!result.text.includes('Маркетолог 5'));
 }
});
test('relevance precedes exposure rotation; comparable unseen profiles get a turn',()=>{
 const history=emptyExposureHistory();history.counts.set('shown',10);history.last.set('shown',Date.now());history.seen.add('seen-by-requester');
 const result=distributeDecisions([decision('shown'),decision('seen-by-requester'),decision('new'),decision('general',{matchQuality:'general'}),decision('support',{fit:'supporting'})],history);
 // A candidate seen by this requester follows unviewed candidates of the same relevance.
 assert.deepEqual(result.map(d=>d.id),['new','shown','seen-by-requester','general','support']);
});
test('older last exposure wins when comparable counts and requester history are equal',()=>{
 const history=emptyExposureHistory();history.counts.set('recent',2);history.counts.set('old',2);history.last.set('recent',200);history.last.set('old',100);
 assert.deepEqual(distributeDecisions([decision('recent'),decision('old')],history).map(d=>d.id),['old','recent']);
});
test('private continuation links bind the search identifier and reject tampering',()=>{
 const payload=continuationPayload('request1');assert.ok(payload.length<=64);assert.equal(parseContinuation(payload),'request1');assert.equal(parseContinuation(payload.replace('request1','request2')),null);assert.equal(parseContinuation('cs_request1_invalid'),null);
});
