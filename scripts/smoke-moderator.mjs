import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { DEFAULT_BLOCKS } = require('../server/dist/moderator/config.js');
const out = 'output/moderator-implementation-2026-10-25';
mkdirSync(out,{recursive:true});
const initial = structuredClone(DEFAULT_BLOCKS.find(b=>b.type==='ai_moderation'));
initial.messageModeration.enabled = true; initial.messageModeration.action = 'delete_rewrite';
initial.conversationAnalysis.enabled = true; initial.conversationAnalysis.reaction = 'respond';
let draft=structuredClone(initial), published=structuredClone(initial), requests=[], errorMode=false;
const event=(id,text='Ты опять перешёл на личности')=>({ id,label:'Замечание в разговоре',categoryLabel:'Личный конфликт',reason:'Личный выпад в адрес участника',actionLabel:'Отправлено замечание',statusLabel:'Обработано',confidence:.97,createdAt:new Date().toISOString(),feedback:null,reversedAt:null,actors:[{displayName:'Миша',username:'misha_dev'}],messages:[{messageId:130192,author:{displayName:'Миша',username:'misha_dev'},text,excerpt:'перешёл на личности'}],response:'Остановите личные выпады.',suggestedRewrite:null,deliveryError:null,canRate:true,canReverse:false });
writeFileSync(out+'/ui-harness.html', `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#0B0B0D"><div id="root" style="max-width:600px;margin:0 auto;padding:16px"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {ModeratorAiEditor} from '/src/components/moderator/ModeratorAiEditor.tsx';import {ModerationLog} from '/src/components/moderator/ModerationLog.tsx';import '/src/styles/globals.css';window.Telegram={WebApp:{initData:'moderator-fixture'}};createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(ModeratorAiEditor,{moderatorId:'fixture'}),React.createElement('div',{style:{marginTop:12}},React.createElement(ModerationLog,{communityId:'fixture'}))));</script></body></html>`);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4182','--strictPort'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let browser;
try {
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4182')).ok)break}catch{}await sleep(100)}
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:390,height:844});
  await page.setRequestInterception(true);
  page.on('request',r=>{void(async()=>{
    const url=new URL(r.url()), send=(data,status=200)=>r.respond({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/auth/moderator-session')return send({token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString()});
    if(url.pathname.includes('/api/moderator-config/')){
      const body=r.postData()?JSON.parse(r.postData()):null;
      requests.push({path:url.pathname,method:r.method(),body});
      if(r.method()==='PATCH'){ assert.ok(body.aiSection); draft[body.aiSection]=body.settings; return send({draft:{blocks:[draft]}}) }
      if(url.pathname.endsWith('/publish')){published[body.aiSection]=structuredClone(draft[body.aiSection]);return send({published:{blocks:[published]}})}
      return send({draft:{blocks:[draft]},published:{blocks:[published]}});
    }
    if(url.pathname.includes('/events')){
      if(errorMode)return send({error:'Проверка ошибки журнала'},503);
      if(url.pathname.endsWith('/feedback'))return send({event:{feedback:JSON.parse(r.postData()).value}});
      if(url.searchParams.get('kind')==='errors')return send({events:[],nextCursor:null});
      const more=url.searchParams.has('before');
      return send({events:[event(more?'second':'first',more?'Второе исходное сообщение':'Миша: личный выпад в живом разговоре')],nextCursor:more?null:'page-two'});
    }
    if(url.pathname.startsWith('/api/'))throw Error('Unexpected API '+url.pathname);
    return r.continue();
  })().catch(e=>{errors.push(String(e));if(!r.isInterceptResolutionHandled())void r.abort()})});
  await page.goto('http://127.0.0.1:4182/'+out+'/ui-harness.html',{waitUntil:'networkidle0'});
  await page.addStyleTag({content:'html,body,#root{height:auto!important;overflow:visible!important}'});
  const clickText=(selector,text)=>page.evaluate((selector,text)=>{const key=s=>s.replace(/\s+/g,'');const els=[...document.querySelectorAll(selector)];const el=els.find(e=>key(e.textContent)===key(text))??els.find(e=>key(e.textContent).startsWith(key(text)));if(!el)throw Error('Missing '+text+': '+document.body.innerText);el.click()},selector,text);
  await clickText('button','Матприменено');
  await page.waitForSelector('input[aria-label="Новое разрешённое слово"]');
  await page.type('input[aria-label="Новое разрешённое слово"]','ХЕР, херня');
  await page.click('button[aria-label="Добавить разрешённое слово"]');
  assert.equal(await page.$$('button[aria-label^="Удалить разрешённое слово"]').then(x=>x.length),2);
  const edit=async(selector,value)=>{const el=await page.$(selector);await el.click();await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await el.type(value)};
  await edit('textarea','Пиши без мата, пожалуйста.');
  const conversationBefore=structuredClone(published.conversationAnalysis);
  await clickText('button','Применить');
  await page.waitForFunction(()=>document.body.innerText.includes('Этот раздел применён'));
  assert.deepEqual(published.conversationAnalysis,conversationBefore);
  assert.deepEqual(published.messageModeration.allowedWords,['хер','херня']);
  assert.equal(published.messageModeration.noticeText,'Пиши без мата, пожалуйста.');
  assert.ok(requests.filter(r=>r.method==='PATCH').every(r=>r.body.aiSection==='messageModeration'&&!r.body.blocks));
  await clickText('button','Конфликты и травляприменено');
  const reaction=await page.$('select option[value="sanctions"]');
  const reactionHandle=await reaction.evaluateHandle(el=>el.parentElement);
  await reactionHandle.asElement().select('sanctions');
  await page.waitForFunction(()=>document.body.innerText.includes('Санкции только за конфликты'));
  await page.evaluate(()=>[...document.querySelectorAll('button')].filter(e=>e.textContent.trim()==='Применить')[1].click());
  await page.waitForFunction(()=>document.querySelectorAll('[role="status"]').length===2);
  assert.equal(published.conversationAnalysis.reaction,'sanctions'); assert.equal(published.messageModeration.action,'delete_rewrite');
  for(const width of [320,390,768]){await page.setViewport({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'overflow '+width)}
  await page.setViewport({width:390,height:844});
  await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>document.querySelectorAll('fieldset')[1].closest('.glass-card').scrollIntoView());
  await sleep(150);
  await page.screenshot({path:out+'/conflicts.png'});
  await page.evaluate(()=>scrollTo(0,0));
  await sleep(150);
  await page.screenshot({path:out+'/settings.png',fullPage:true});
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Журнал модерации')).click());
  await page.waitForSelector('article');
  assert.ok(await page.evaluate(()=>document.querySelector('article').innerText.includes('Миша · @misha_dev')));
  assert.ok(await page.evaluate(()=>document.querySelector('blockquote').innerText.includes('личный выпад')));
  assert.ok(!await page.evaluate(()=>document.querySelector('article').innerText.includes('130192')));
  await clickText('button','Загрузить ещё'); await page.waitForFunction(()=>document.querySelectorAll('article').length===2);
  await page.click('button[aria-label="Решение ошибочное"]'); await page.waitForFunction(()=>document.querySelector('article').innerText.includes('Ошибка AI'));
  await clickText('button','Ошибки');await page.waitForFunction(()=>document.body.innerText.includes('В этом разделе пока нет событий'));
  errorMode=true;await clickText('button','Конфликты');await page.waitForSelector('[role="alert"]');
  errorMode=false;await clickText('button','Повторить');await page.waitForSelector('article');
  await page.evaluate(()=>document.querySelector('article').scrollIntoView());
  await page.screenshot({path:out+'/journal.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS Moderator UI: independent save/publish, allowlist, editable notice, conflict sanctions, readable source, feedback, pagination, retry, 320/390/768px.');
} catch(error) { const page=(await browser?.pages())?.at(-1); if(page){writeFileSync(out+'/ui-error.txt',await page.evaluate(()=>document.body.innerText));await page.screenshot({path:out+'/ui-error.png',fullPage:true})}writeFileSync(out+'/ui-requests.json',JSON.stringify(requests,null,2));throw error }
finally {await browser?.close();server.kill()}
