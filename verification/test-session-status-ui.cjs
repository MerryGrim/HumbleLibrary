const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {sourceRoot,outputRoot,loadPlaywright,browserLaunchOptions}=require('./test-env.cjs');
const esbuild=require(require.resolve('esbuild',{paths:[sourceRoot]}));
const report={fixtureOnly:true,component:'App.tsx',checks:[],errors:[]};
const check=message=>{report.checks.push(message);console.log(`PASS ${message}`);};
const fixture=`
const options=window.__sessionOptions;
const bundles=[{id:'session-fixture',title:'Synthetic cached purchase',imageUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',items:[]}];
const f=window.__sessionFixture={calls:[],listeners:{},statusResolvers:[],sessionListenerResolvers:[],pendingSync:null};
const subscribe=(name,callback)=>{const listeners=f.listeners[name]??=new Set();listeners.add(callback);return Promise.resolve(()=>listeners.delete(callback));};
const state=()=>({connected:options.connected??false,authState:options.authState??'unknown',bundles:structuredClone(bundles)});
window.__emitSession=value=>{for(const callback of f.listeners.session||[])callback(value);};
window.__emitSessionProgress=()=>{for(const callback of f.listeners.progress||[])callback({completed:13,total:76});};
window.__resolveSessionStatus=()=>{for(const resolve of f.statusResolvers.splice(0))resolve(state());};
window.__finishSessionSync=(ok=true)=>{const pending=f.pendingSync;f.pendingSync=null;ok?pending.resolve({connected:true,authState:'authenticated',bundles:structuredClone(bundles),enumerationComplete:true}):pending.reject(new Error('Synthetic network or protocol failure'));};
window.__completeSessionLogin=()=>{for(const callback of f.listeners.completed||[])callback({attemptId:'11111111-1111-4111-8111-111111111111'});};
window.__enableSessionListener=()=>{for(const enable of f.sessionListenerResolvers.splice(0))enable();};
export const api={preview:false,
status:async()=>options.holdStatus?await new Promise(resolve=>f.statusResolvers.push(resolve)):state(),
sync:async()=>{f.calls.push('sync');return await new Promise((resolve,reject)=>{f.pendingSync={resolve,reject};});},
login:async()=>{f.calls.push('login');return{attemptId:'11111111-1111-4111-8111-111111111111'};},
onSessionStatus:callback=>options.holdSessionListener?new Promise(resolve=>f.sessionListenerResolvers.push(()=>subscribe('session',callback).then(resolve))):subscribe('session',callback),onSyncActivity:async()=>()=>{},onProgress:callback=>subscribe('progress',callback),onWarning:callback=>subscribe('warning',callback),onLoginCompleted:callback=>subscribe('completed',callback),onLoginCancelled:callback=>subscribe('cancelled',callback),onUpdateProgress:callback=>subscribe('update',callback),
updateStatus:async()=>({enabled:false,configured:false,repository:'',currentVersion:'0.1.3',supported:true}),updateReady:async()=>{},setNativeLanguage:async()=>{},copy:async()=>{},cancel:async()=>{},
logout:async()=>{f.calls.push('logout');window.__emitSession({connected:false,authState:'unauthenticated'});},
openExternal:async()=>{throw Error('External navigation forbidden in session fixture');}
};`;
(async()=>{
const bundle=await esbuild.build({stdin:{contents:`import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import App from'./src/App';createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);`,resolveDir:sourceRoot,loader:'tsx'},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'},plugins:[{name:'session-fixture',setup(build){build.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'session-fixture'}));build.onResolve({filter:/^@tauri-apps\/api\/window$/},()=>({path:'window',namespace:'session-fixture'}));build.onLoad({filter:/.*/,namespace:'session-fixture'},args=>({contents:args.path==='api'?fixture:'export const getCurrentWindow=()=>({});',loader:'js'}));}}]});
fs.mkdirSync(outputRoot,{recursive:true});
const browser=await loadPlaywright().chromium.launch(browserLaunchOptions);
try{
const css=['styles.css','Notification.css','BundleSort.css'].map(file=>fs.readFileSync(path.join(sourceRoot,'src',file),'utf8')).join('\n');
async function open(options={}){
 const context=await browser.newContext({viewport:{width:1280,height:800},locale:'ru-RU',reducedMotion:'reduce'});
 await context.route('**/*',route=>route.request().url()==='https://hl-session-fixture.invalid/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="root"></div></body></html>'}):route.abort());
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 await page.goto('https://hl-session-fixture.invalid/');await page.evaluate(options=>{window.__sessionOptions=options;localStorage.setItem('humble-library-language','ru');},options);
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 if(options.holdSessionListener)await page.waitForFunction(()=>window.__sessionFixture?.sessionListenerResolvers.length>0);
 else await page.waitForFunction(()=>window.__sessionFixture?.listeners.session?.size===1);
 return{page,context};
}
const header=page=>page.locator('.account-summary small');
const expectHeader=async(page,text)=>{await page.waitForFunction(text=>document.querySelector('.account-summary small')?.textContent===text,text);assert.equal(await header(page).textContent(),text);};
const emit=async(page,authState)=>page.evaluate(authState=>window.__emitSession({connected:authState==='authenticated',authState}),authState);
const beginSync=async page=>{await page.getByRole('button',{name:'Обновить',exact:true}).click();await page.waitForFunction(()=>!!window.__sessionFixture.pendingSync);};

{const{page,context}=await open({holdStatus:true});assert.notEqual(await header(page).textContent(),'Вход не выполнен');await page.evaluate(()=>window.__resolveSessionStatus());await page.locator('.bundle-tile').waitFor();await expectHeader(page,'Сессия не проверена');assert.equal(await page.evaluate(()=>window.__sessionFixture.calls.length),0);check('Loading and unverified restored sessions do not claim that the user is signed out');await context.close();}

{const{page,context}=await open();await page.locator('.bundle-tile').waitFor();await beginSync(page);await expectHeader(page,'Проверяем сессию…');await emit(page,'authenticated');await page.evaluate(()=>window.__emitSessionProgress());await expectHeader(page,'Аккаунт подключён');assert.equal(await page.locator('.sync-progress progress').getAttribute('value'),'13');assert.equal(await page.locator('.sync-progress progress').getAttribute('max'),'76');assert(await page.evaluate(()=>!!window.__sessionFixture.pendingSync),'Full sync remains unfinished');await page.screenshot({path:path.join(outputRoot,'session-verified-during-13-of-76.png')});await page.evaluate(()=>window.__finishSessionSync());await page.locator('.sync-progress').waitFor({state:'hidden'});await expectHeader(page,'Аккаунт подключён');check('Authoritative order-list proof connects the header at13/76 before full synchronization completes');await context.close();}

{const{page,context}=await open({holdStatus:true});await emit(page,'authenticated');await expectHeader(page,'Аккаунт подключён');await page.evaluate(()=>window.__resolveSessionStatus());await page.locator('.bundle-tile').waitFor();await expectHeader(page,'Аккаунт подключён');check('Late initial cache status cannot overwrite a newer verified session event');await context.close();}

{const{page,context}=await open();await page.locator('.bundle-tile').waitFor();await emit(page,'authenticated');await expectHeader(page,'Аккаунт подключён');await beginSync(page);await page.evaluate(()=>window.__finishSessionSync(false));await page.getByText('Synthetic network or protocol failure',{exact:true}).waitFor();await expectHeader(page,'Аккаунт подключён');check('Network or protocol failure alone does not erase previously verified authentication');await context.close();}

{const{page,context}=await open({connected:true,authState:'authenticated'});await page.locator('.bundle-tile').waitFor();await expectHeader(page,'Аккаунт подключён');await emit(page,'unauthenticated');await expectHeader(page,'Вход не выполнен');assert.equal(await page.locator('.avatar.connected').count(),0);check('Authoritative unauthenticated state clears the connected header and avatar');await context.close();}

{const{page,context}=await open();await page.locator('.bundle-tile').waitFor();await page.locator('.account-trigger').click();await page.getByRole('menuitem',{name:'Войти в Humble',exact:true}).click();await expectHeader(page,'Проверяем сессию…');await page.evaluate(()=>window.__completeSessionLogin());await page.waitForFunction(()=>!!window.__sessionFixture.pendingSync);await expectHeader(page,'Аккаунт подключён');assert.equal(await page.evaluate(()=>window.__sessionFixture.calls.filter(value=>value==='sync').length),1);await page.evaluate(()=>window.__finishSessionSync());check('Matching completed login verifies the header before its automatic full refresh finishes');await context.close();}

{const{page,context}=await open({connected:true,authState:'authenticated'});await page.locator('.bundle-tile').waitFor();await page.locator('.account-trigger').click();await page.getByRole('menuitem',{name:'Выйти из аккаунта',exact:true}).click();await expectHeader(page,'Вход не выполнен');assert.equal(await page.locator('.avatar.connected').count(),0);assert.equal(await page.evaluate(()=>window.__sessionFixture.calls.filter(value=>value==='sync').length),0);check('Explicit logout clears authentication without triggering a synchronization');await context.close();}

{const{page,context}=await open();await page.locator('.bundle-tile').waitFor();for(const value of [null,{}, {connected:true,authState:'unknown'},{connected:false,authState:'authenticated'},{connected:true,authState:'unauthenticated'},{connected:'true',authState:'authenticated'},{connected:false,authState:'invalid'}]){await page.evaluate(value=>window.__emitSession(value),value);await expectHeader(page,'Сессия не проверена');}await emit(page,'authenticated');await expectHeader(page,'Аккаунт подключён');await page.evaluate(()=>window.__emitSession({connected:false,authState:'authenticated'}));await expectHeader(page,'Аккаунт подключён');check('Malformed and inconsistent session payloads cannot invent authentication or erase valid proof');await context.close();}

{const{page,context}=await open({holdSessionListener:true});await page.locator('.bundle-tile').waitFor();await page.getByRole('button',{name:'Обновить',exact:true}).click();await expectHeader(page,'Проверяем сессию…');await page.waitForTimeout(40);assert.equal(await page.evaluate(()=>window.__sessionFixture.calls.filter(value=>value==='sync').length),0,'Sync must wait for early-session event registration');await page.evaluate(()=>window.__enableSessionListener());await page.waitForFunction(()=>window.__sessionFixture.listeners.session.size===1&&!!window.__sessionFixture.pendingSync);await emit(page,'authenticated');await expectHeader(page,'Аккаунт подключён');assert.equal(await page.evaluate(()=>window.__sessionFixture.calls.filter(value=>value==='sync').length),1);await page.evaluate(()=>window.__finishSessionSync());check('Delayed native listener registration gates synchronization so early authentication proof cannot be lost');await context.close();}
assert.deepEqual(report.errors,[]);
}finally{await browser.close();fs.writeFileSync(path.join(outputRoot,'session-status-ui-report.json'),JSON.stringify(report,null,2));}
console.log(`PASS ${report.checks.length} session-status UI scenarios`);
})().catch(error=>{console.error(error);process.exitCode=1;});
