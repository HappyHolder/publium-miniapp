import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDecisions,selectedDecisions,roleDescription} from './collaber/review';

const sources=[
 {id:'provider',intro:['Создал Example ID. Сервис верификации пользователей приложений.'],facts:[]},
 {id:'integrator',intro:['Могу подключить проверку пользователей и настроить API.'],facts:[]},
 {id:'seeker',intro:['Ищу сервис проверки пользователей для своего проекта.'],facts:[]},
];
const decisions=[
 {id:'integrator',role:'integrator',fit:'supporting',evidence:sources[1].intro[0],reasonCode:'adjacent_help'},
 {id:'seeker',role:'seeker',fit:'none',evidence:'',reasonCode:'same_need'},
 {id:'provider',role:'provider',fit:'direct',evidence:'Сервис верификации пользователей приложений.',reasonCode:'relevant_capability'},
];
test('providers precede supporting integrators; same need is not a recommendation',()=>{
 const result=selectedDecisions(reviewDecisions({decisions},sources));
 assert.deepEqual(result.map(d=>d.id),['provider','integrator']);
 assert.match(roleDescription(result[1]),/Дополнительно.*интеграцией/);
 assert.equal(result[0].evidence,'Сервис верификации пользователей приложений.');
});
test('every shortlisted candidate needs a decision; fabricated or cross-profile quotes fail closed',()=>{
 for(const bad of [null,{decisions:decisions.slice(1)},{decisions:[decisions[0],decisions[0],decisions[2]]},
  {decisions:decisions.map(d=>d.id==='provider'?{...d,evidence:sources[1].intro[0]}:d)},
  {decisions:decisions.map(d=>d.id==='provider'?{...d,evidence:'Гарантированная защита от ботов.'}:d)},
  {decisions:decisions.map(d=>d.id==='seeker'?{...d,fit:'direct',evidence:sources[2].intro[0]}:d)}]){
  assert.throws(()=>reviewDecisions(bad,sources),/корректный список/);
 }
});
test('empty but complete semantic evaluation is valid and never fills three arbitrary slots',()=>{
 const none=decisions.map(d=>({...d,fit:'none',evidence:'',reasonCode:'insufficient_evidence'}));
 assert.deepEqual(selectedDecisions(reviewDecisions({decisions:none},sources)),[]);
});
