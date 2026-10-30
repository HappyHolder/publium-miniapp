import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const require=createRequire(import.meta.url),{chromium}=require('../server/node_modules/playwright'),puppeteer=require('../node_modules/puppeteer');
mkdirSync('output/playwright',{recursive:true});
writeFileSync("output/playwright/collaber-direct-fixture.html","<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/output/playwright/collaber-direct-fixture.tsx\"></script></body></html>\n");
writeFileSync("output/playwright/collaber-direct-fixture.tsx","import React,{useState} from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {CollaberPanel,DEFAULT_COLLABER} from '/src/components/community-manager/CollaberPanel';\nimport '/src/styles/globals.css';\nwindow.Telegram={WebApp:{initData:'fixture'}};\nwindow.__mutations=[];\nconst profiles=(name='Анна')=>[{id:'p1',tgUserId:'42',searchable:true,publicMentions:true,forgotten:false,sourceText:'Создаю приложение для изучения языков. Ищу партнёров для обмена аудиторией.',sourceAt:'2026-10-15',membership:'MEMBER',participant:{displayName:name,username:'synthetic'},facts:[{kind:'project',value:'Приложение для изучения языков'},{kind:'need',value:'Ищу партнёров для обмена аудиторией'}]}];\nwindow.fetch=async(input,options={})=>{\n const url=String(input),parsed=new URL(url,location.origin);\n if(url.includes('/api/auth/moderator-session'))return Response.json({token:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString()});\n if(url.includes('/collaber')){\n  if(options.method==='POST'||options.method==='PATCH'){\n   window.__mutations.push({url,body:JSON.parse(options.body??'{}')});await new Promise(r=>setTimeout(r,300));\n   return Response.json({ok:true});\n  }\n  const q=parsed.searchParams.get('q');if(q)await new Promise(r=>setTimeout(r,q==='Анна'?1000:50));\n  return Response.json({profiles:profiles(url.includes('/manager2/')?'Другой клуб':q||'Анна'),total:1,stats:{searchable:1,publicProfiles:1,sent:3,matched:2,useful:1,introduced:0},readiness:{published:true,enabled:true,featureEnabled:true,executor:true,collecting:true},health:{pending:1,failed:1,uncertain:1},requests:[],drafts:[{id:'draft',status:'DRAFT',query:'Ищу партнёра',initiative:true,createdAt:'2026-10-15',candidates:[{name:'Анна',reason:'Предлагает обмен аудиторией'}]}],entryUrl:'https://t.me/examplebot?start=fixture'});\n }\n throw new Error('Unexpected fixture request: '+url);\n};\nfunction App(){const[value,setValue]=useState({...DEFAULT_COLLABER,enabled:true}),[manager,setManager]=useState('manager');window.__setManager=setManager;return <main style={{padding:16}}><CollaberPanel key={manager} managerId={manager} value={value} onChange={setValue} managerEnabled memoryEnabled/></main>}\ncreateRoot(document.getElementById('root')).render(<App/>);");
const port=5191,base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:await puppeteer.executablePath(),headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/output/playwright/collaber-direct-fixture.html');await page.getByText('Профилей для поиска:',{exact:false}).waitFor();
 await page.evaluate(()=>{for(const el of [document.documentElement,document.body,document.querySelector('#root')]){el.style.height='auto';el.style.overflow='visible';}});
 await page.getByRole('tab',{name:'Участники',exact:true}).click();
 const search=page.getByPlaceholder('Имя участника');await search.fill('Анна');await page.waitForTimeout(350);await search.fill('Борис');await page.waitForTimeout(1400);
 assert.equal(await search.inputValue(),'Борис');assert.match(await page.locator('article').innerText(),/Борис/);assert.doesNotMatch(await page.locator('article').innerText(),/Анна/);
 await page.getByRole('switch',{name:'Разрешены публичные рекомендации',exact:true}).click();await page.getByRole('switch',{name:'Разрешены публичные рекомендации',exact:true}).click();await page.waitForTimeout(450);
 assert.equal((await page.evaluate(()=>window.__mutations)).length,1);assert.match(await page.locator('article').innerText(),/Борис/);
 await search.fill('Анна');await page.waitForTimeout(300);await page.evaluate(()=>window.__setManager('manager2'));await page.waitForTimeout(1400);await page.getByRole('tab',{name:'Участники',exact:true}).click();assert.match(await page.locator('article').innerText(),/Другой клуб/);assert.equal(await search.inputValue(),'');
 await page.getByRole('tab',{name:'Подборы',exact:true}).click();
 await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(await page.getByRole('button',{name:'Знакомства',exact:true}).count(),0);
 await page.getByRole('button',{name:'Черновики',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'output/playwright/collaber-direct-drafts-320.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'Настройки',exact:true}).click();await page.screenshot({path:'output/playwright/collaber-direct-settings-390.png',fullPage:true});
 assert.equal(await page.getByRole('switch',{name:'Помочь познакомиться',exact:true}).count(),0);
 assert.equal(await page.getByText('Взаимных согласий на знакомство:',{exact:false}).count(),0);
 await page.getByRole('switch',{name:'Написать участнику',exact:true}).waitFor();
 await page.getByRole('switch',{name:'Посмотреть интро',exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: search ordering, mutation lock, refresh uses current query, community switch isolation, absence of invitation controls, 320px layout and no runtime errors');
}finally{await browser?.close();server.kill();}
