import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRouteGroupSearch, parseCollaborationRoute } from './collaber/routing';

test('group routing requires direct address, enabled feature and autopilot',()=>{
 const eligible={enabled:true,onDemand:true,autopilot:true,addressedToManager:true,addressedToOtherHuman:false,userId:'42',text:'Есть проекты с проверкой человечности?'};
 assert.equal(canRouteGroupSearch(eligible),true);
 for(const key of ['enabled','onDemand','autopilot','addressedToManager'])assert.equal(canRouteGroupSearch({...eligible,[key]:false}),false);
 assert.equal(canRouteGroupSearch({...eligible,addressedToOtherHuman:true}),false);
 assert.equal(canRouteGroupSearch({...eligible,userId:null}),false);
 assert.equal(canRouteGroupSearch({...eligible,text:'#intro Я разрабатываю приложения и ищу партнёров'}),false);
 assert.equal(canRouteGroupSearch({...eligible,text:'Привет! #интро Мой проект ищет разработчика'}),false);
});

test('invalid routing cannot silently fall back to a conversational answer',()=>{
 assert.deepEqual(parseCollaborationRoute({kind:'SEARCH',query:' Сервис верификации пользователей '}),{kind:'SEARCH',query:'Сервис верификации пользователей'});
 assert.deepEqual(parseCollaborationRoute({kind:'NONE',query:'ignored'}),{kind:'NONE',query:''});
 assert.deepEqual(parseCollaborationRoute({kind:'CLARIFY',query:''}),{kind:'CLARIFY',query:''});
 for(const raw of [null,{}, {kind:'OTHER',query:''},{kind:'SEARCH',query:''},{kind:'SEARCH',query:'x'.repeat(501)}])assert.throws(()=>parseCollaborationRoute(raw));
});
