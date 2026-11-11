const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {sourceRoot,outputRoot,loadPlaywright,browserLaunchOptions}=require('./test-env.cjs');
const esbuild=require(require.resolve('esbuild',{paths:[sourceRoot]}));
const report={fixtureOnly:true,component:'App.tsx',checks:[],errors:[]};
const check=message=>{report.checks.push(message);console.log(`PASS ${message}`);};
const apiFixture=`
const options=window.__coverOptions;
const image='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
const initial=options.empty?[]:[{id:'a',title:'Synthetic purchase A',imageUrl:options.complete?image:'',items:[]},{id:'b',title:'Synthetic purchase B',imageUrl:image,items:[]}];
const refreshed=initial.map(bundle=>({...bundle,imageUrl:image}));
const f=window.__coverFixture={calls:[],statusResolvers:[],listeners:{},pendingSync:null};
const state=()=>({connected:true,bundles:structuredClone(initial)});
const subscribe=(name,callback)=>{const entries=f.listeners[name]??=new Set();entries.add(callback);return Promise.resolve(()=>entries.delete(callback));};
window.__resolveStatus=()=>{const resolvers=f.statusResolvers.splice(0);for(const resolve of resolvers)resolve(state());};
window.__finishCoverSync=()=>{const resolve=f.pendingSync;f.pendingSync=null;resolve({connected:true,authState:'authenticated',bundles:structuredClone(refreshed),enumerationComplete:true});};
window.__cancelCoverLogin=()=>{for(const callback of f.listeners.cancelled||[])callback({attemptId:'11111111-1111-4111-8111-111111111111'});};
export const api={preview:false,
status:async()=>options.holdStatus?await new Promise(resolve=>f.statusResolvers.push(resolve)):state(),
sync:async()=>{f.calls.push('sync');if(options.syncReject)throw new Error('Synthetic cover refresh failed');if(options.holdSync)return await new Promise(resolve=>{f.pendingSync=resolve;});return {connected:true,authState:'authenticated',bundles:structuredClone(refreshed),enumerationComplete:true};},
login:async()=>{f.calls.push('login');return{attemptId:'11111111-1111-4111-8111-111111111111'};},
onLoginCompleted:callback=>subscribe('completed',callback),onLoginCancelled:callback=>subscribe('cancelled',callback),
onSessionStatus:callback=>subscribe('session',callback),
onSyncActivity:async()=>()=>{},onProgress:callback=>subscribe('progress',callback),onWarning:callback=>subscribe('warning',callback),onUpdateProgress:callback=>subscribe('updates',callback),
setNativeLanguage:async()=>{},updateReady:async()=>{},updateStatus:async()=>({enabled:false,repository:'',configured:false,currentVersion:'0.1.2',supported:true}),
copy:async()=>{},cancel:async()=>{},logout:async()=>{},openExternal:async()=>{throw Error('External navigation forbidden');}
};`;
(async()=>{
const built=await esbuild.build({stdin:{contents:`import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import App from'./src/App';createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);`,resolveDir:sourceRoot,loader:'tsx'},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'},plugins:[{name:'cover-fixture',setup(build){build.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'cover-fixture'}));build.onResolve({filter:/^@tauri-apps\/api\/window$/},()=>({path:'window',namespace:'cover-fixture'}));build.onLoad({filter:/.*/,namespace:'cover-fixture'},args=>({contents:args.path==='api'?apiFixture:'export const getCurrentWindow=()=>({});',loader:'js'}));}}]});
fs.mkdirSync(outputRoot,{recursive:true});
const browser=await loadPlaywright().chromium.launch(browserLaunchOptions);
try{
 const css=['styles.css','Notification.css','BundleSort.css'].map(file=>fs.readFileSync(path.join(sourceRoot,'src',file),'utf8')).join('\n');
 async function open(options={}){
  const context=await browser.newContext({viewport:{width:1280,height:800},locale:'ru-RU',reducedMotion:'reduce'});
  await context.route('**/*',route=>route.request().url()==='https://hl-covers-fixture.invalid/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="root"></div></body></html>'}):route.abort());
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto('https://hl-covers-fixture.invalid/');await page.evaluate(options=>{window.__coverOptions=options;localStorage.setItem('humble-library-language','ru');},options);
  await page.addScriptTag({content:built.outputFiles[0].text});
  await page.waitForFunction(()=>!!window.__coverFixture);
  return{page,context};
 }
 const syncs=page=>page.evaluate(()=>window.__coverFixture.calls.filter(name=>'sync'===name).length);
 {const{page,context}=await open();await page.locator('.bundle-tile').first().waitFor();await page.waitForTimeout(80);assert.equal(await syncs(page),0);assert.equal(await page.locator('.bundle-tile img').count(),0);assert.equal(await page.locator('.bundle-tile .cover-fallback').count(),2);await page.locator('.theme-button').click();await page.waitForTimeout(60);assert.equal(await syncs(page),0);check('Missing covers stay as placeholders without triggering startup synchronization');await context.close();}
 {const{page,context}=await open({complete:true});await page.locator('.bundle-tile').first().waitFor();await page.waitForTimeout(60);assert.equal(await syncs(page),0);assert.equal(await page.locator('.bundle-tile img').count(),0);await page.locator('.bundle-tile').first().click();assert.equal(await page.locator('.bundle-summary .cover-fallback').count(),1);assert.equal(await page.locator('.bundle-summary img').count(),0);check('Previously cached cover URLs stay stored but render placeholders in tiles and bundle details');await context.close();}
 {const{page,context}=await open({empty:true});await page.getByRole('heading',{name:'Библиотека пока пуста',exact:true}).waitFor();await page.waitForTimeout(60);assert.equal(await syncs(page),0);check('An empty cache causes no automatic cover refresh');await context.close();}
 {const{page,context}=await open();await page.locator('.bundle-tile').first().waitFor();await page.getByRole('button',{name:'Обновить',exact:true}).click();await page.waitForFunction(()=>window.__coverFixture.calls.filter(name=>name==='sync').length===1);await page.locator('.sync-progress').waitFor({state:'hidden'});await page.waitForTimeout(60);assert.equal(await syncs(page),1);assert.equal(await page.locator('.bundle-tile img').count(),0);check('Manual library refresh remains available and does not reactivate banner loading');await context.close();}
 {const{page,context}=await open({holdStatus:true});await page.locator('.account-trigger').click();await page.getByRole('menuitem',{name:'Войти в Humble',exact:true}).click();await page.waitForFunction(()=>window.__coverFixture.calls.includes('login'));await page.evaluate(()=>{window.__cancelCoverLogin();window.__resolveStatus();});await page.locator('.bundle-tile').first().waitFor();await page.waitForTimeout(60);assert.equal(await syncs(page),0);assert.equal(await page.evaluate(()=>window.__coverFixture.calls.filter(name=>name==='login').length),1);check('Cancelling login still avoids background synchronization and reopening');await context.close();}
 {const{page,context}=await open({syncReject:true});await page.locator('.bundle-tile').first().waitFor();await page.getByRole('button',{name:'Обновить',exact:true}).click();await page.getByText('Synthetic cover refresh failed',{exact:true}).waitFor();await page.locator('.theme-button').click();await page.waitForTimeout(100);assert.equal(await syncs(page),1);assert.equal(await page.locator('.bundle-tile').count(),2);check('Failed manual refresh preserves cached bundles without a cover retry');await context.close();}
 {const{page,context}=await open({holdSync:true});await page.locator('.bundle-tile').first().waitFor();await page.getByRole('button',{name:'Обновить',exact:true}).click();await page.waitForFunction(()=>!!window.__coverFixture.pendingSync);assert.equal(await syncs(page),1);assert.equal(await page.getByRole('button',{name:'Обновляем…',exact:true}).isDisabled(),true);await page.locator('.theme-button').click();await page.waitForTimeout(60);assert.equal(await syncs(page),1);await page.evaluate(()=>window.__finishCoverSync());await page.locator('.sync-progress').waitFor({state:'hidden'});await page.waitForTimeout(60);assert.equal(await syncs(page),1);check('Busy manual refresh stays serialized with no queued banner refresh');await context.close();}
 assert.deepEqual(report.errors,[]);
}finally{await browser.close();fs.writeFileSync(path.join(outputRoot,'startup-covers-report.json'),JSON.stringify(report,null,2));}
console.log(`PASS ${report.checks.length} startup cover scenarios`);
})().catch(error=>{console.error(error);process.exitCode=1;});
