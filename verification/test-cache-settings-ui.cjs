const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const esbuild = require(require.resolve('esbuild', { paths: [sourceRoot] }));
const report = { fixtureOnly: true, checks: [], errors: [] };
const apiSource = `
const f=window.__cacheFixture={calls:[],listeners:{},holdClear:false,pendingClear:null,failClear:false,failReset:false};
let connected=true;
const bundles=[{id:'synthetic-cache-bundle',title:'Synthetic retained bundle',imageUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',items:[{id:'synthetic-key',title:'Synthetic asset',platform:'Fab',key:'SYNTHETIC-KEY-ONLY',status:'revealed'}]}];
const subscribe=(name,callback)=>{const listeners=f.listeners[name]??=new Set();listeners.add(callback);return Promise.resolve(()=>listeners.delete(callback));};
window.__cacheEmit=(name,value)=>{for(const callback of f.listeners[name]||[])callback(value);};
window.__finishClear=()=>{const resolve=f.pendingClear;f.pendingClear=null;resolve();};
export const api={preview:false,
 status:async()=>({connected,authState:connected?'authenticated':'unauthenticated',bundles:structuredClone(bundles)}),
 login:async()=>{f.calls.push('login');return {attemptId:'synthetic-login-attempt'};},
 clearCache:async()=>{f.calls.push('clear');if(f.failClear)throw Error('Не удалось очистить кэш сайта.');if(f.holdClear)await new Promise(resolve=>f.pendingClear=resolve);},
 resetLogin:async()=>{f.calls.push('reset');if(f.failReset)throw Error('Не удалось сбросить вход Humble.');connected=false;window.__cacheEmit('session',{connected:false,authState:'unauthenticated'});},
 sync:async()=>{f.calls.push('sync');return structuredClone(bundles);},
 copy:async text=>{f.copied=text;},
 onLoginCompleted:callback=>subscribe('completed',callback),onLoginCancelled:callback=>subscribe('cancelled',callback),onSessionStatus:callback=>subscribe('session',callback),
 onProgress:callback=>subscribe('progress',callback),onWarning:callback=>subscribe('warning',callback),onUpdateProgress:callback=>subscribe('update',callback),
 updateStatus:async()=>({enabled:false,repository:'',configured:false,currentVersion:'0.2.3',mode:'portable',supported:true}),
 setNativeLanguage:async()=>{},updateReady:async()=>{},checkUpdates:async()=>({status:'disabled',release:null}),
 logout:async()=>{throw Error('Logout must not implement reset');},cancel:async()=>{},openExternal:async()=>{throw Error('External access forbidden');},reveal:async()=>{throw Error('Reveal forbidden');},exportKeys:async()=>{throw Error('Export forbidden');}
};`;

async function buildApp() {
  const result = await esbuild.build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import App from'./src/App';createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: sourceRoot, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', loader: { '.css': 'empty' }, plugins: [{ name: 'cache-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'cache-fixture' }));
    build.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({ path: 'window', namespace: 'cache-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'cache-fixture' }, args => ({ contents: args.path === 'api' ? apiSource : 'export const getCurrentWindow=()=>({});', loader: 'js' }));
  } }] });
  return result.outputFiles[0].text;
}
const check = name => { report.checks.push(name); console.log('PASS '+name); };
(async () => {
  const code=await buildApp(), browser=await loadPlaywright().chromium.launch(browserLaunchOptions);
  fs.mkdirSync(outputRoot,{recursive:true});
  try {
    const context=await browser.newContext({viewport:{width:960,height:640},locale:'ru-RU',reducedMotion:'reduce'});
    const css=['styles.css','Notification.css'].map(name=>fs.readFileSync(path.join(sourceRoot,'src',name),'utf8')).join('\n');
    await context.route('**/*',route=>route.request().url()==='https://cache-fixture.invalid/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="root"></div></body></html>'}):route.abort());
    const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
    await page.goto('https://cache-fixture.invalid/');await page.evaluate(()=>localStorage.setItem('humble-library-language','ru'));await page.addScriptTag({content:code});
    await page.locator('.bundle-tile').waitFor();await page.locator('.settings-button').click();
    const dialog=page.locator('.settings-dialog'), clear=dialog.locator('.settings-data-row').first().locator('button'), reset=dialog.locator('.settings-data-row').last().locator('button');
    await page.evaluate(()=>window.__cacheFixture.holdClear=true);await clear.click();
    await page.waitForFunction(()=>window.__cacheFixture.pendingClear!==null);
    assert(await clear.isDisabled());assert(await reset.isDisabled());
    assert(await dialog.locator('.dialog-head button').isDisabled());await page.keyboard.press('Escape');assert(await dialog.isVisible());
    await clear.evaluate(button=>button.click());assert.equal(await page.evaluate(()=>window.__cacheFixture.calls.filter(name=>name==='clear').length),1);
    await page.evaluate(()=>window.__finishClear());await dialog.getByText('Кэш сайта очищен.',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Скопировать текст',exact:true}).click();assert.equal(await page.evaluate(()=>window.__cacheFixture.copied),'Кэш сайта очищен.');
    assert.equal(await page.locator('.bundle-tile').count(),1);assert((await page.locator('.account-summary').innerText()).includes('Аккаунт подключён'));
    check('Cache clear is single-flight, keeps the dialog open while pending, and preserves account/library');

    await reset.click();assert(await page.getByRole('alertdialog').isVisible());assert.equal(await page.evaluate(()=>window.__cacheFixture.calls.includes('reset')),false);
    assert.equal(await dialog.locator('.dialog-actions button').first().evaluate(button=>button===document.activeElement),true);
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('alertdialog').count(),0);assert(await dialog.isVisible());
    await reset.click();await dialog.locator('.dialog-actions button').last().click();await dialog.getByText('Вход Humble сброшен. Войдите заново.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__cacheFixture.calls.filter(name=>name==='reset').length),1);
    assert((await page.locator('.account-summary').innerText()).includes('Вход не выполнен'));assert.equal(await page.locator('.bundle-tile').count(),1);
    assert.equal(await page.evaluate(()=>window.__cacheFixture.calls.includes('sync')),false);
    await dialog.locator('.dialog-head button').click();await page.locator('.bundle-tile').click();assert.equal(await page.locator('.key-value').innerText(),'SYNTHETIC-KEY-ONLY');
    check('Reset requires confirmation, Escape only cancels confirmation, and retained keys remain visible without auto-sync');

    await page.locator('.settings-button').click();await page.evaluate(()=>{window.__cacheFixture.holdClear=false;window.__cacheFixture.failClear=true;});await clear.click();
    await dialog.getByText('Не удалось очистить кэш сайта.',{exact:true}).waitFor();assert(await reset.isEnabled());
    await page.evaluate(()=>{window.__cacheFixture.failReset=true;});await reset.click();await dialog.locator('.dialog-actions button').last().click();
    await dialog.getByText('Не удалось сбросить вход Humble.',{exact:true}).waitFor();await page.keyboard.press('Escape');assert(await dialog.isVisible());
    check('Native errors use dismissible/copyable notification and release the controls for retry');

    await dialog.locator('.dialog-head button').click();await page.locator('.account-trigger').click();await page.getByRole('menuitem',{name:'Войти в Humble',exact:true}).click();await page.locator('.settings-button').click();
    assert(await clear.isDisabled());assert(await reset.isDisabled());assert((await dialog.innerText()).includes('Завершите текущую операцию или закройте окно входа.'));
    await page.evaluate(()=>window.__cacheEmit('cancelled',{attemptId:'synthetic-login-attempt'}));await page.waitForFunction(()=>!document.querySelector('.settings-data-row button').disabled);
    check('Cache/reset stay disabled for the entire sign-in attempt and unlock after cancellation');

    for(const locale of ['ru','en','de','it','es','fr','zh','ja','ko']) {
      await dialog.locator('#interface-language').selectOption(locale);
      const catalog=locale==='ru'?null:JSON.parse(fs.readFileSync(path.join(sourceRoot,'src/locales',locale+'.json'),'utf8'));
      const tr=source=>catalog?.[source]||source;
      assert.equal((await clear.innerText()).trim(),tr('Очистить кэш сайта'));assert.equal((await reset.innerText()).trim(),tr('Сбросить вход Humble'));
      await reset.click();assert.equal((await dialog.locator('h2').innerText()).trim(),tr('Сбросить вход Humble?'));assert((await dialog.innerText()).includes(tr('Потребуется войти в Humble заново. Бандлы, ключи и настройки приложения сохранятся.')));await page.keyboard.press('Escape');
      const dimensions=await dialog.evaluate(element=>({width:element.clientWidth,scrollWidth:element.scrollWidth,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}));
      assert(dimensions.scrollWidth<=dimensions.width+1&&dimensions.documentWidth<=dimensions.viewportWidth+1,locale+' no horizontal overflow');
      if(['ru','de'].includes(locale))await page.screenshot({path:path.join(outputRoot,'cache-settings-960x640-'+locale+'.png')});
    }
    check('All nine languages translate actions and confirmation with no horizontal overflow at 960x640');
    assert.deepEqual(report.errors,[]);await context.close();

    const apiBundle=await esbuild.build({stdin:{contents:`import{api}from'./src/api';window.__realPreviewApi=api;`,resolveDir:sourceRoot,loader:'ts'},bundle:true,write:false,plugins:[{name:'preview-native-stub',setup(build){build.onResolve({filter:/^@tauri-apps\/api\//},args=>({path:args.path,namespace:'preview-native-stub'}));build.onLoad({filter:/.*/,namespace:'preview-native-stub'},()=>({contents:'export const isTauri=()=>false;export const invoke=()=>{throw Error("Native invocation forbidden");};export const listen=async()=>()=>{};',loader:'js'}));}}]});
    const preview=await browser.newContext();await preview.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));const apiPage=await preview.newPage();await apiPage.goto('https://preview-fixture.invalid/?preview=1');await apiPage.addScriptTag({content:apiBundle.outputFiles[0].text});
    const retained=await apiPage.evaluate(async()=>{const before=await window.__realPreviewApi.status();await window.__realPreviewApi.resetLogin();const after=await window.__realPreviewApi.status();await window.__realPreviewApi.logout();const loggedOut=await window.__realPreviewApi.status();return{before,after,loggedOut};});
    assert.equal(retained.after.connected,false);assert.deepEqual(retained.after.bundles,retained.before.bundles);assert.deepEqual(retained.loggedOut.bundles,[]);await preview.close();
    check('Real preview API distinguishes reset-login retention from explicit logout');
  } finally {await browser.close();fs.writeFileSync(path.join(outputRoot,'cache-settings-ui-report.json'),JSON.stringify(report,null,2));}
  console.log(`PASS ${report.checks.length} cache/settings scenarios`);
})().catch(error=>{console.error(error);process.exitCode=1;});
