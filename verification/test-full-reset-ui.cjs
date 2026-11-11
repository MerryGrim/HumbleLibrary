const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const esbuild = require(require.resolve('esbuild', { paths: [sourceRoot] }));
const body = 'Будут удалены локальная библиотека, сохранённые ключи, кэш и сессия Humble. Для новой синхронизации потребуется войти заново.';
const notice = 'Данные Humble очищены. Войдите заново для чистой синхронизации.';
const failure = 'Не удалось полностью очистить данные Humble. Перезапустите приложение и повторите.';
const report = { fixtureOnly: true, accountDataRead: false, nativeResetExecuted: false, checks: [], errors: [], remoteRequests: [] };
const check = name => { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
const apiSource = `
const seed=[{id:'SYNTHETIC_BUNDLE',title:'Synthetic wipe fixture',imageUrl:'',items:[{id:'SYNTHETIC_KEY',title:'Synthetic retained asset',platform:'Steam',key:'SYNTHETIC-RESET-ONLY',status:'revealed'}]}];
let connected=localStorage.getItem('synthetic-reset-empty')!=='1';let bundles=connected?structuredClone(seed):[];
const empty=()=>({connected:false,authState:'unauthenticated',lastSync:null,bundles:[]});
const f=window.__resetFixture={calls:[],listeners:{},holdInitial:!!window.__resetConfig?.holdInitial,enumerationComplete:window.__resetConfig?.enumerationComplete??true,holdReset:false,failReset:false,holdSync:false,finishInitial:null,rejectInitial:null,finishReset:null,finishSync:null,exports:['SYNTHETIC_EXPORTED_FILE'],copies:[]};
const subscribe=(name,callback)=>{const listeners=f.listeners[name]??=new Set();listeners.add(callback);return Promise.resolve(()=>listeners.delete(callback));};
window.__resetEmit=(name,value)=>{for(const callback of f.listeners[name]||[])callback(value);};
const noop=async()=>{};
export const api={preview:false,
 status:async()=>{f.calls.push('status');const snapshot={connected,authState:connected?'authenticated':'unauthenticated',lastSync:connected?'2026-01-01T00:00:00Z':null,bundles:structuredClone(bundles),enumerationComplete:f.enumerationComplete,...(f.holdInitial?{warning:'SYNTHETIC_STALE_WARNING'}:{})};if(f.holdInitial)return await new Promise((resolve,reject)=>{f.finishInitial=()=>resolve(snapshot);f.rejectInitial=reject;});return snapshot;},
 resetAll:async()=>{f.calls.push('resetAll');if(f.failReset)throw Error(${JSON.stringify(failure)});if(f.holdReset)await new Promise(resolve=>{f.finishReset=resolve;});connected=false;bundles=[];localStorage.setItem('synthetic-reset-empty','1');return empty();},
 clearCache:async()=>{f.calls.push('clearCache');},resetLogin:async()=>{f.calls.push('resetLogin');connected=false;},
 login:async()=>{f.calls.push('login');return{attemptId:'synthetic-login-attempt'};},
 sync:async()=>{f.calls.push('sync');if(f.holdSync)await new Promise(resolve=>{f.finishSync=resolve;});return {connected,authState:connected?'authenticated':'unauthenticated',bundles:structuredClone(bundles),enumerationComplete:true};},
 copy:async value=>{f.copies.push(value);},exportKeys:async()=>{throw Error('No export action expected');},openExternal:async()=>{throw Error('External navigation forbidden');},reveal:async()=>{throw Error('Reveal forbidden');},logout:noop,cancel:noop,
 onLoginCompleted:callback=>subscribe('completed',callback),onLoginCancelled:callback=>subscribe('cancelled',callback),onSessionStatus:callback=>subscribe('session',callback),onSyncActivity:callback=>subscribe('activity',callback),onProgress:callback=>subscribe('progress',callback),onWarning:callback=>subscribe('warning',callback),onUpdateProgress:callback=>subscribe('update',callback),
 setNativeLanguage:noop,updateReady:noop,updateStatus:async()=>({enabled:false,repository:'',configured:false,currentVersion:'0.1.0',mode:'portable',supported:true}),checkUpdates:async()=>({status:'disabled',release:null})
};`;

(async () => {
  const ui = await esbuild.build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import App from './src/App';flushSync(()=>createRoot(document.getElementById('root')).render(<App/>));`, resolveDir: sourceRoot, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, plugins: [{ name: 'full-reset-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'full-reset-fixture' }));
    build.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({ path: 'window', namespace: 'full-reset-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'full-reset-fixture' }, args => ({ contents: args.path === 'api' ? apiSource : `export const getCurrentWindow=()=>({minimize:async()=>{},toggleMaximize:async()=>{},close:async()=>{}});`, loader: 'js' }));
  } }] });
  const css = ['styles.css', 'Notification.css'].map(file => fs.readFileSync(path.join(sourceRoot, 'src', file), 'utf8')).join('\n');
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  try {
    async function open(config = {}) {
      const context = await browser.newContext({ viewport: { width: 960, height: 640 }, locale: 'ru-RU', reducedMotion: 'reduce' });
      await context.route('**/*', route => {
        if (route.request().url() === 'https://hl-full-reset.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div id="root"></div></body></html>' });
        report.remoteRequests.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
      await page.goto('https://hl-full-reset.invalid/');
      await page.evaluate(config => { window.__resetConfig = config; localStorage.setItem('humble-library-language', 'ru'); localStorage.setItem('humble-library-theme', 'light'); localStorage.setItem('synthetic-export-kept', 'SYNTHETIC_EXPORTED_FILE'); }, config);
      await page.addScriptTag({ content: ui.outputFiles[0].text });
      if (config.holdInitial) await page.waitForFunction(() => !!window.__resetFixture?.finishInitial);
      else await page.locator('.bundle-tile').waitFor();
      await page.locator('.settings-button').click();
      return { page, context, settings: page.locator('.settings-dialog') };
    }
    const calls = (page, name) => page.evaluate(name => window.__resetFixture.calls.filter(value => value === name).length, name);
    const openConfirm = async page => { await page.getByRole('button', { name: 'Очистить все данные Humble', exact: true }).click(); const dialog = page.getByRole('alertdialog'); await dialog.getByText(body, { exact: true }).waitFor(); return dialog; };

    { const { page, context, settings } = await open({ enumerationComplete: false });
      assert.equal(await page.locator('.library-incomplete').count(), 1);
      let confirm = await openConfirm(page);
      assert.equal(await calls(page, 'resetAll'), 0);
      assert.equal(await confirm.getByRole('button', { name: 'Отмена', exact: true }).first().evaluate(node => node === document.activeElement), false);
      assert.equal(await confirm.locator('.dialog-actions').getByRole('button', { name: 'Отмена', exact: true }).evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Escape'); assert.equal(await page.getByRole('alertdialog').count(), 0);
      confirm = await openConfirm(page); await confirm.locator('.dialog-actions').getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal(await calls(page, 'resetAll'), 0);
      await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click(); await page.locator('.bundle-tile').click();
      await page.getByRole('button', { name: 'Скопировать ключ: Synthetic retained asset', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__resetFixture.copies), ['SYNTHETIC-RESET-ONLY']);
      assert.deepEqual(await page.evaluate(() => window.__resetFixture.exports), ['SYNTHETIC_EXPORTED_FILE']);
      check('Cancel and Escape make zero reset calls and leave saved keys and exports available');

      await page.locator('.settings-button').click(); await page.evaluate(() => { window.__resetFixture.holdReset = true; });
      confirm = await openConfirm(page); await confirm.getByRole('button', { name: 'Удалить локальные данные', exact: true }).click();
      await page.waitForFunction(() => !!window.__resetFixture.finishReset);
      assert.equal(await calls(page, 'resetAll'), 1); assert.equal(await page.locator('.key-value').count(), 1);
      assert.equal(await confirm.locator('.dialog-actions button').last().isDisabled(), true); assert.equal(await confirm.locator('.dialog-actions button').first().isDisabled(), true);
      await page.keyboard.press('Escape'); assert.equal(await confirm.isVisible(), true);
      await confirm.locator('.dialog-actions button').last().evaluate(button => button.click()); assert.equal(await calls(page, 'resetAll'), 1);
      await page.evaluate(() => window.__resetFixture.finishReset()); await settings.getByText(notice, { exact: true }).waitFor();
      assert.equal(await page.locator('.bundle-tile,.key-value').count(), 0); assert.equal(await page.locator('.last-sync').innerText(), '');
      assert((await page.locator('.account-summary').innerText()).includes('Вход не выполнен'));
      assert.equal(await calls(page, 'status'), 1); assert.equal(await calls(page, 'sync'), 0); assert.equal(await calls(page, 'login'), 0);
      await page.evaluate(() => window.__resetEmit('completed', { attemptId: 'synthetic-old-attempt' }));
      await page.evaluate(() => window.__resetEmit('activity', { phase: 'purchasedPage', state: 'waiting', attempt: 2, delayMs: 1500, reason: 'service' }));
      await page.waitForTimeout(30); assert.equal(await calls(page, 'sync'), 0);
      assert.equal(await page.locator('.library-incomplete,.sync-progress').count(), 0); assert.equal(await page.getByText(/Загрузка продолжится через/).count(), 0);
      assert.deepEqual(await page.evaluate(() => ({ language: localStorage.getItem('humble-library-language'), theme: localStorage.getItem('humble-library-theme'), exported: localStorage.getItem('synthetic-export-kept'), exports: window.__resetFixture.exports })), { language: 'ru', theme: 'light', exported: 'SYNTHETIC_EXPORTED_FILE', exports: ['SYNTHETIC_EXPORTED_FILE'] });
      check('Confirmation is single-flight; success immediately clears library, selection, session and progress without rereading or reopening');
      await page.reload(); await page.addScriptTag({ content: ui.outputFiles[0].text }); await page.getByRole('button', { name: 'Войти в Humble', exact: true }).waitFor();
      assert.equal(await page.locator('.bundle-tile,.key-value').count(), 0); assert.equal(await calls(page, 'sync'), 0); assert.equal(await calls(page, 'login'), 0);
      check('Reload reads the cleared backend state while interface preferences and exports stay preserved');
      await context.close();
    }
    { const { page, context, settings } = await open({ holdInitial: true });
      assert.equal(await settings.getByRole('button', { name: 'Очистить кэш сайта', exact: true }).isDisabled(), true);
      assert.equal(await settings.getByRole('button', { name: 'Сбросить вход Humble', exact: true }).isDisabled(), true);
      assert.equal(await settings.getByRole('button', { name: 'Очистить все данные Humble', exact: true }).isEnabled(), true);
      const confirm = await openConfirm(page); await confirm.getByRole('button', { name: 'Удалить локальные данные', exact: true }).click();
      await settings.getByText(notice, { exact: true }).waitFor();
      await page.evaluate(() => window.__resetFixture.finishInitial()); await page.waitForTimeout(40);
      assert.equal(await page.locator('.bundle-tile,.key-value,.loading-state').count(), 0);
      assert.equal(await page.getByText('SYNTHETIC_STALE_WARNING', { exact: true }).count(), 0); assert.equal(await page.locator('.last-sync').innerText(), '');
      assert((await page.locator('.account-summary').innerText()).includes('Вход не выполнен')); assert.equal(await calls(page, 'resetAll'), 1);
      check('A late initial status cannot resurrect deleted bundles, timestamps or warnings after the explicit reset');
      await context.close();
    }
    { const { page, context, settings } = await open();
      await page.evaluate(() => { window.__resetFixture.failReset = true; });
      const confirm = await openConfirm(page); await confirm.getByRole('button', { name: 'Удалить локальные данные', exact: true }).click();
      await confirm.getByText(failure, { exact: true }).waitFor(); assert.equal(await page.locator('.bundle-tile').count(), 1);
      assert.equal(await page.getByText(notice, { exact: true }).count(), 0);
      await page.keyboard.press('Escape'); await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
      await page.locator('.bundle-tile').click(); assert.equal(await page.locator('.key-value').innerText(), 'SYNTHETIC-RESET-ONLY');
      check('A failed native reset reports the exact error and does not falsely erase the displayed library');
      await context.close();
    }
    { const { page, context, settings } = await open({ holdInitial: true });
      await page.evaluate(() => { window.__resetFixture.holdReset = true; });
      const confirm = await openConfirm(page); await confirm.getByRole('button', { name: 'Удалить локальные данные', exact: true }).click();
      await page.waitForFunction(() => !!window.__resetFixture.finishReset);
      await page.evaluate(() => window.__resetFixture.rejectInitial(Error('SYNTHETIC_OLD_READ_FAILURE')));
      await page.waitForTimeout(30);
      await page.evaluate(() => window.__resetFixture.finishReset()); await settings.getByText(notice, { exact: true }).waitFor();
      await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
      assert.equal(await page.getByText('Не удалось прочитать локальную библиотеку. Попробуйте обновить её.', { exact: true }).count(), 0);
      assert.equal(await page.locator('.bundle-tile,.key-value').count(), 0); assert.equal(await calls(page, 'resetAll'), 1);
      check('A startup read failure arriving during reset cannot survive the later successful deletion');
      await context.close();
    }
    { const { page, context, settings } = await open();
      await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click(); await page.locator('.account-trigger').click(); await page.getByRole('menuitem', { name: 'Открыть аккаунт Humble', exact: true }).click(); await page.locator('.settings-button').click();
      assert.equal(await settings.getByRole('button', { name: 'Очистить все данные Humble', exact: true }).isDisabled(), true);
      await page.evaluate(() => window.__resetEmit('cancelled', { attemptId: 'synthetic-login-attempt' }));
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('.settings-data-row button')).at(-1).disabled);
      for (const locale of ['ru', 'en', 'de', 'it', 'es', 'fr', 'zh', 'ja', 'ko']) {
        await settings.locator('#interface-language').selectOption(locale);
        const catalog = locale === 'ru' ? null : JSON.parse(fs.readFileSync(path.join(sourceRoot, 'src/locales', locale + '.json'), 'utf8'));
        const tr = value => catalog?.[value] || value;
        await settings.getByRole('button', { name: tr('Очистить все данные Humble'), exact: true }).click();
        const confirm = page.getByRole('alertdialog'); assert((await confirm.innerText()).includes(tr(body))); assert.equal(await confirm.getByRole('button', { name: tr('Удалить локальные данные'), exact: true }).count(), 1);
        const size = await confirm.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, viewport: innerWidth, document: document.documentElement.scrollWidth }));
        assert(size.scroll <= size.width + 1 && size.document <= size.viewport + 1, locale + ' confirmation overflows');
        await page.keyboard.press('Escape');
      }
      assert.equal(await calls(page, 'resetAll'), 0);
      check('Sign-in guards remain active and all nine readable confirmations cancel without deleting anything');
      await context.close();
    }
    const previewBundle = await esbuild.build({ stdin: { contents: `import{api}from'./src/api';window.__realPreviewApi=api;`, resolveDir: sourceRoot, loader: 'ts' }, bundle: true, write: false, plugins: [{ name: 'preview-native-stub', setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/api\// }, args => ({ path: args.path, namespace: 'preview-native-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'preview-native-stub' }, () => ({ contents: 'export const isTauri=()=>false;export const invoke=()=>{throw Error("Native invocation forbidden");};export const listen=async()=>()=>{};', loader: 'js' }));
    } }] });
    { const context = await browser.newContext(); await context.route('**/*', route => route.request().url() === 'https://hl-reset-preview.invalid/?preview=1' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }) : route.abort());
      const page = await context.newPage(); await page.goto('https://hl-reset-preview.invalid/?preview=1'); await page.evaluate(() => { localStorage.setItem('humble-library-language', 'de'); localStorage.setItem('humble-library-theme', 'light'); localStorage.setItem('synthetic-export-kept', 'kept'); }); await page.addScriptTag({ content: previewBundle.outputFiles[0].text });
      const result = await page.evaluate(async () => { const before = await window.__realPreviewApi.status(); const cleared = await window.__realPreviewApi.resetAll(); const after = await window.__realPreviewApi.status(); let rejected = false; try { await window.__realPreviewApi.sync(); } catch { rejected = true; } return { beforeCount: before.bundles.length, cleared, after, rejected }; });
      assert(result.beforeCount > 0); assert.deepEqual(result.cleared, { connected: false, authState: 'unauthenticated', lastSync: null, bundles: [] }); assert.deepEqual(result.after, result.cleared); assert.equal(result.rejected, true);
      await page.reload(); await page.addScriptTag({ content: previewBundle.outputFiles[0].text }); assert.deepEqual(await page.evaluate(() => window.__realPreviewApi.status()), result.cleared);
      assert.deepEqual(await page.evaluate(() => [localStorage.getItem('humble-library-language'), localStorage.getItem('humble-library-theme'), localStorage.getItem('synthetic-export-kept')]), ['de', 'light', 'kept']);
      const restored = await page.evaluate(async () => { await window.__realPreviewApi.login(); return await window.__realPreviewApi.sync(); }); assert(restored.bundles.length > 0);
      check('The real preview API keeps reset state across status and reload and requires explicit sign-in before a new sync');
      await context.close();
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.remoteRequests, []);
  } finally { await browser.close(); fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'full-reset-ui-report.json'), JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
