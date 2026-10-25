const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const esbuild = require(require.resolve('esbuild', { paths: [sourceRoot] }));
const report = { fixtureOnly: true, component: 'App.tsx', checks: [], errors: [] };
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const apiSource = `
const f=window.__authFixture={calls:[],listeners:{},sequence:0,loginMode:'immediate',syncMode:'immediate',pendingLogin:null,pendingSync:[]};
const bundles=[{id:'fixture-bundle',title:'Synthetic retained purchase',imageUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',items:[]}];
const record=name=>f.calls.push(name);
const subscribe=(name,callback)=>{const listeners=f.listeners[name]??=new Set();listeners.add(callback);return Promise.resolve(()=>listeners.delete(callback));};
window.__emitAuth=(name,attemptId)=>{for(const callback of f.listeners[name]||[])callback({attemptId});};
window.__finishLogin=()=>{const pending=f.pendingLogin;f.pendingLogin=null;pending.resolve({attemptId:pending.attemptId});};
window.__finishSync=()=>{const pending=f.pendingSync.shift();pending.resolve(structuredClone(bundles));};
export const api={preview:false,
 status:async()=>({connected:false,bundles:[]}),
 login:async()=>{record('login');const attemptId='11111111-1111-4111-8111-'+String(++f.sequence).padStart(12,'0');f.latestAttempt=attemptId;if(f.loginMode==='hold')return await new Promise(resolve=>{f.pendingLogin={attemptId,resolve};});return {attemptId};},
 sync:async()=>{record('sync');if(f.syncMode==='hold')return await new Promise(resolve=>f.pendingSync.push({resolve}));return structuredClone(bundles);},
 onLoginCompleted:callback=>subscribe('completed',callback),onLoginCancelled:callback=>subscribe('cancelled',callback),
 onSessionStatus:callback=>subscribe('session',callback),
 onLoginClosed:callback=>subscribe('closed',callback),
 onProgress:callback=>subscribe('progress',callback),onWarning:callback=>subscribe('warning',callback),onUpdateProgress:callback=>subscribe('update',callback),
 updateStatus:async()=>({enabled:false,repository:'',configured:false,currentVersion:'0.1.0',mode:'portable',supported:true}),
 setNativeLanguage:async()=>{},updateReady:async()=>{},checkUpdates:async()=>({status:'disabled',release:null}),
 logout:async()=>{record('logout');},cancel:async()=>{record('cancel');},copy:async()=>{},
 openExternal:async()=>{throw Error('External navigation forbidden in fixture');},
 reveal:async()=>{throw Error('Reveal forbidden in authentication fixture');},
 exportKeys:async()=>{throw Error('Export forbidden in authentication fixture');}
};`;

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React,{StrictMode} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import App from './src/App';const root=createRoot(document.getElementById('root'));window.__unmountAuth=()=>flushSync(()=>root.render(null));flushSync(()=>root.render(<StrictMode><App/></StrictMode>));`, resolveDir: sourceRoot, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, plugins: [{ name: 'authentication-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'authentication-fixture' }));
    build.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({ path: 'window', namespace: 'authentication-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'authentication-fixture' }, args => ({ contents: args.path === 'api' ? apiSource : `export const getCurrentWindow=()=>({minimize:async()=>{},toggleMaximize:async()=>{},close:async()=>{}});`, loader: 'js' }));
  } }] });
  fs.mkdirSync(outputRoot, { recursive: true });
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  try {
    const css = ['styles.css','Notification.css'].map(file => fs.readFileSync(path.join(sourceRoot,'src',file),'utf8')).join('\n');
    async function open() {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', reducedMotion: 'reduce' });
      await context.route('**/*', route => route.request().url()==='https://hl-auth-fixture.invalid/' ? route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="root"></div></body></html>'}) : route.abort());
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto('https://hl-auth-fixture.invalid/');
      await page.evaluate(() => {localStorage.setItem('humble-library-language','ru');});
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByRole('button',{name:'Войти в Humble',exact:true}).waitFor();
      await page.waitForFunction(() => window.__authFixture.listeners.completed?.size === 1 && window.__authFixture.listeners.cancelled?.size === 1);
      return {page,context};
    }
    const calls = (page,name) => page.evaluate(name=>window.__authFixture.calls.filter(value=>value===name).length,name);
    const emit = (page,name,attempt) => page.evaluate(({name,attempt})=>window.__emitAuth(name,attempt),{name,attempt});
    async function startLogin(page) {
      const empty = page.getByRole('button',{name:'Войти в Humble',exact:true});
      if(await empty.count()) await empty.click();
      else {await page.locator('.account-trigger').click();await page.getByRole('menuitem',{name:'Открыть аккаунт Humble',exact:true}).click();}
      await page.waitForFunction(() => window.__authFixture.sequence > 0);
      return page.evaluate(()=>window.__authFixture.latestAttempt);
    }

    { const {page,context}=await open();
      assert.equal(await calls(page,'sync'),0);
      assert.equal(await page.evaluate(()=>window.__authFixture.listeners.closed?.size||0),0,'Legacy close event must not trigger synchronization');
      const attempt=await startLogin(page);
      await emit(page,'cancelled',attempt);await emit(page,'closed',attempt);
      await page.waitForTimeout(50);
      assert.equal(await calls(page,'sync'),0);assert.equal(await calls(page,'login'),1);
      await emit(page,'completed',attempt);await page.waitForTimeout(50);
      assert.equal(await calls(page,'sync'),0,'Late success after manual cancellation is ignored');
      check('Manual close/cancel and legacy close events neither synchronize nor reopen login; late cancelled success is ignored');
      await context.close(); }

    { const {page,context}=await open();
      const attempt=await startLogin(page);
      await emit(page,'completed','99999999-9999-4999-8999-999999999999');await page.waitForTimeout(30);
      assert.equal(await calls(page,'sync'),0);
      await emit(page,'completed',attempt);await emit(page,'completed',attempt);
      await page.locator('.bundle-tile').waitFor();
      assert.equal((await page.locator('.bundle-tile strong').innerText()).trim(),'Synthetic retained purchase','Supplier title remains exact');
      assert.equal(await calls(page,'sync'),1);assert.equal(await calls(page,'login'),1);
      await emit(page,'completed',attempt);await page.waitForTimeout(50);
      assert.equal(await calls(page,'sync'),1);
      check('Only the active successful attempt synchronizes exactly once; stale and duplicate completion events are ignored');
      await context.close(); }

    { const {page,context}=await open();
      await page.evaluate(()=>{window.__authFixture.loginMode='hold';});
      const attempt=await startLogin(page);
      await page.waitForFunction(()=>!!window.__authFixture.pendingLogin);
      await emit(page,'completed',attempt);assert.equal(await calls(page,'sync'),0);
      await page.evaluate(()=>window.__finishLogin());
      await page.locator('.bundle-tile').waitFor();
      assert.equal(await calls(page,'sync'),1);
      await emit(page,'completed',attempt);assert.equal(await calls(page,'sync'),1);
      check('Completion racing the login IPC response is retained and processed once after the response');
      await context.close(); }

    { const {page,context}=await open();
      await page.evaluate(()=>{window.__authFixture.loginMode='hold';});
      const attempt=await startLogin(page);
      await page.waitForFunction(()=>!!window.__authFixture.pendingLogin);
      await emit(page,'cancelled',attempt);await page.evaluate(()=>window.__finishLogin());
      await page.waitForTimeout(50);
      assert.equal(await calls(page,'sync'),0);assert.equal(await calls(page,'login'),1);
      await emit(page,'completed',attempt);await page.waitForTimeout(50);
      assert.equal(await calls(page,'sync'),0);
      check('Cancellation racing the login IPC response prevents both automatic sync and late completion');
      await context.close(); }

    { const {page,context}=await open();
      const attempt=await startLogin(page);
      await page.evaluate(()=>{window.__authFixture.syncMode='hold';});
      await page.getByRole('button',{name:'Обновить',exact:true}).click();
      await page.waitForFunction(()=>window.__authFixture.pendingSync.length===1);
      await emit(page,'completed',attempt);await emit(page,'completed',attempt);
      assert.equal(await calls(page,'sync'),1,'Completion while busy must wait');
      await page.evaluate(()=>window.__finishSync());
      await page.waitForFunction(()=>window.__authFixture.calls.filter(value=>value==='sync').length===2);
      assert.equal(await page.evaluate(()=>window.__authFixture.pendingSync.length),1);
      await page.evaluate(()=>window.__finishSync());await page.locator('.sync-progress').waitFor({state:'hidden'});
      await page.waitForTimeout(50);assert.equal(await calls(page,'sync'),2);
      check('Successful login queues one automatic synchronization after current work and deduplicates busy-time completion');
      await context.close(); }

    { const {page,context}=await open();
      const attempt=await startLogin(page);
      await page.evaluate(()=>window.__unmountAuth());
      assert.equal(await page.evaluate(()=>[...Object.values(window.__authFixture.listeners)].every(set=>set.size===0)),true);
      await emit(page,'completed',attempt);assert.equal(await calls(page,'sync'),0);
      check('StrictMode leaves one active subscription per event and unmount removes every callback');
      await context.close(); }
    assert.deepEqual(report.errors,[]);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(outputRoot,'auth-lifecycle-ui-report.json'),JSON.stringify(report,null,2));
  }
  console.log(`PASS ${report.checks.length} authentication lifecycle scenarios`);
})().catch(error=>{console.error(error);process.exitCode=1;});
