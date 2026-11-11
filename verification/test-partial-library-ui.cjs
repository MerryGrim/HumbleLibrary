const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const esbuild = require(require.resolve('esbuild', { paths: [sourceRoot] }));

// Only invented purchases and keys; all remote navigation and account access
// are replaced before mounting the production App component.
const apiSource = `
const retained={id:'cached-key',title:'Synthetic saved key',platform:'Steam',key:'SYNTHETIC-RETAINED-ONLY',status:'revealed'};
const hidden={id:'cached-hidden',title:'Synthetic saved hidden key',platform:'GOG',key:null,status:'hidden'};
const fixtures=[
 {id:'failed-empty',title:'Synthetic incomplete empty',imageUrl:'',detailsFailed:true,sourceUrl:'https://www.humblebundle.com/home/library/SYNTHETIC_EMPTY',items:[]},
 {id:'failed-cached',title:'Synthetic incomplete cached',imageUrl:'',detailsFailed:true,sourceUrl:'https://www.humblebundle.com/home/library/SYNTHETIC_CACHED',items:[retained,hidden]},
 {id:'legacy-ready',title:'Synthetic ready legacy',imageUrl:'',items:[{...retained,id:'ready-key'},{...hidden,id:'ready-hidden',title:'Synthetic ready hidden key'}]}
];
const f=window.__partialFixture={result:fixtures,calls:[],reveals:[],copies:[],exports:[],links:[],holdSync:false,finishSync:null,finishInitial:null,loginCompleted:null,progress:null,activity:null,enumerationComplete:window.__partialOptions?.enumerationComplete??true,lastSync:'2026-10-01T00:00:00Z',warning:window.__partialOptions?.warning};
const state=()=>({connected:true,authState:'authenticated',lastSync:f.lastSync,bundles:structuredClone(f.result),enumerationComplete:f.enumerationComplete,warning:f.warning});
const noop=async()=>{};
const subscribe=async()=>()=>{};
export const api={preview:false,
 status:async()=>{const captured=state();if(window.__partialOptions?.holdInitial)return await new Promise(resolve=>{f.finishInitial=()=>{f.finishInitial=null;resolve(captured);};});return captured;},
 sync:async()=>{f.calls.push('sync');if(f.holdSync)return await new Promise(resolve=>{f.finishSync=()=>{f.finishSync=null;resolve(state());};});return state();},
 reveal:async(bundleId,itemId)=>{f.reveals.push({bundleId,itemId});const bundle=f.result.find(row=>row.id===bundleId);if(bundle.detailsFailed)throw Error('Failed bundle mutation forbidden');const item=bundle.items.find(row=>row.id===itemId);item.key='SYNTHETIC-READY-NEW';item.status='revealed';return structuredClone(item);},
 copy:async value=>{f.copies.push(value);},
 exportKeys:async(contents,name)=>{f.exports.push({contents,name});return 'SYNTHETIC_EXPORT.txt';},
 openExternal:async url=>{f.links.push(url);},
 login:async()=>({attemptId:'synthetic-login'}),logout:noop,cancel:noop,
 onLoginCompleted:async callback=>{f.loginCompleted=callback;return()=>{f.loginCompleted=null;};},onLoginCancelled:subscribe,onSessionStatus:subscribe,onProgress:async callback=>{f.progress=callback;return()=>{f.progress=null;};},onSyncActivity:async callback=>{f.activity=callback;return()=>{f.activity=null;};},onWarning:subscribe,onUpdateProgress:subscribe,
 setNativeLanguage:noop,updateReady:noop,updateStatus:async()=>({enabled:false,repository:'',configured:false,currentVersion:'0.1.0',mode:'portable',supported:true}),
 checkUpdates:async()=>({status:'disabled',release:null}),clearCache:noop,resetLogin:noop
};`;
const warning = 'Не все бандлы удалось обновить. Ранее сохранённые ключи оставлены в библиотеке.';
const explanation = 'Ключи этого бандла пока не загружены полностью.';
const incomplete = 'Список покупок загружен не полностью. Доступные бандлы сохранены; обновите библиотеку, чтобы продолжить.';
const report = { fixtureOnly: true, component: 'App.tsx', checks: [], errors: [], remoteRequests: [] };
const check = name => { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };

(async () => {
  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import App from './src/App';const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<App/>));`, resolveDir: sourceRoot, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, plugins: [{ name: 'partial-library-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'partial-library-fixture' }));
    build.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({ path: 'window', namespace: 'partial-library-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'partial-library-fixture' }, args => ({ contents: args.path === 'api' ? apiSource : `export const getCurrentWindow=()=>({minimize:async()=>{},toggleMaximize:async()=>{},close:async()=>{}});`, loader: 'js' }));
  } }] });
  const css = ['styles.css', 'Notification.css'].map(file => fs.readFileSync(path.join(sourceRoot, 'src', file), 'utf8')).join('\n');
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  try {
    async function open(language = 'ru', options = {}) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', reducedMotion: 'reduce' });
      await context.route('**/*', route => {
        if (route.request().url() === 'https://hl-partial-fixture.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div id="root"></div></body></html>' });
        report.remoteRequests.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto('https://hl-partial-fixture.invalid/');
      await page.evaluate(({ language, options }) => { localStorage.setItem('humble-library-language', language); window.__partialOptions = options; }, { language, options });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      if (options.holdInitial) await page.waitForFunction(() => !!window.__partialFixture.finishInitial && !!window.__partialFixture.loginCompleted);
      else if (language === 'ru') await page.getByRole('button', { name: 'Открыть бандл Synthetic incomplete empty', exact: true }).waitFor();
      else await page.locator('.bundle-tile').first().waitFor();
      return { context, page };
    }
    const { context, page } = await open();
    const emptyTile = page.getByRole('button', { name: 'Открыть бандл Synthetic incomplete empty', exact: true });
    const cachedTile = page.getByRole('button', { name: 'Открыть бандл Synthetic incomplete cached', exact: true });
    assert((await emptyTile.innerText()).includes('Ключи не обновлены'));
    assert(!(await emptyTile.innerText()).includes('0 позиций')); assert(!(await emptyTile.innerText()).includes('Не раскрыт'));
    assert((await cachedTile.innerText()).includes('Ключи не обновлены'));
    assert.equal(await page.getByText(warning, { exact: true }).count(), 1);
    assert.equal(await page.locator('.notification--warning').count(), 1);
    check('Incomplete tiles and restored state show an honest warning instead of an empty or unrevealed purchase');

    await emptyTile.click();
    assert.equal(await page.locator('.workspace-heading p').innerText(), 'Ключи не обновлены');
    assert.equal(await page.getByText(explanation, { exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'Ничего не найдено', exact: true }).count(), 0);
    assert.equal(await page.getByRole('textbox', { name: 'Поиск по названию товара', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Раскрыть все', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Экспортировать', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'На Humble', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__partialFixture.links), ['https://www.humblebundle.com/home/library/SYNTHETIC_EMPTY']);
    await page.getByRole('button', { name: 'Обновить библиотеку', exact: true }).click();
    await page.waitForFunction(() => window.__partialFixture.calls.length === 1);
    await page.getByText(warning, { exact: true }).waitFor();
    assert.equal(await page.locator('.notification--success').count(), 0);
    check('An incomplete empty bundle has recovery actions and partial refresh never reports a complete success');

    await page.getByRole('button', { name: 'Назад к бандлам', exact: true }).click();
    await cachedTile.click();
    assert.equal(await page.locator('.key-table tbody tr').count(), 2);
    assert.equal(await page.getByText(explanation, { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Раскрыть все', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.key-table tbody tr').filter({ hasText: 'Synthetic saved hidden key' }).getByRole('button', { name: 'Раскрыть', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Скопировать ключ: Synthetic saved key', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__partialFixture.copies), ['SYNTHETIC-RETAINED-ONLY']);
    await page.getByRole('button', { name: 'Экспортировать', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Экспорт ключей', exact: true });
    assert.equal(await dialog.getByRole('button', { name: 'Раскрыть и экспортировать', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Сохранить TXT', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.__partialFixture.exports.map(value => value.contents)), ['SYNTHETIC-RETAINED-ONLY\r\n']);
    assert.equal(await page.evaluate(() => window.__partialFixture.reveals.length), 0);
    check('Cached keys remain copyable and exportable while every reveal path is disabled for an incomplete bundle');

    await page.getByRole('button', { name: 'Назад к бандлам', exact: true }).click();
    await page.getByRole('button', { name: 'Открыть бандл Synthetic ready legacy', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Раскрыть все', exact: true }).isDisabled(), false);
    await page.locator('.key-table tbody tr').filter({ hasText: 'Synthetic ready hidden key' }).getByRole('button', { name: 'Раскрыть', exact: true }).click();
    await page.getByText('SYNTHETIC-READY-NEW', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__partialFixture.reveals.length), 1);
    await page.getByRole('button', { name: 'Назад к бандлам', exact: true }).click();
    await page.evaluate(() => { window.__partialFixture.holdSync = true; });
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.waitForFunction(() => !!window.__partialFixture.finishSync);
    await page.evaluate(() => window.__partialFixture.progress({ completed: 98, total: 98, stage: 'purchases' }));
    await page.getByText('Загружаем список покупок', { exact: false }).waitFor();
    assert.equal(await page.getByText('Загружено покупок: 98 из 98', { exact: true }).count(), 1);
    await page.evaluate(() => window.__partialFixture.activity({ phase: 'purchasedPage', state: 'waiting', attempt: 2, delayMs: 1500, reason: 'service' }));
    await page.getByText('Загрузка продолжится через 2 сек. · попытка 2', { exact: true }).waitFor();
    await page.evaluate(() => window.__partialFixture.activity({ phase: 'purchasedPage', state: 'reading', attempt: 2, delayMs: 0 }));
    await page.getByText('Загрузка продолжится через 2 сек. · попытка 2', { exact: true }).waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__partialFixture.activity({ phase: 'purchasedPage', state: 'waiting', attempt: 5, delayMs: 1000, reason: 'service' }));
    assert.equal(await page.getByText(/Загрузка продолжится через/).count(), 0);
    await page.evaluate(() => window.__partialFixture.activity({ phase: 'unknownFixturePhase', state: 'waiting', attempt: 2, delayMs: 1000, reason: 'service' }));
    assert.equal(await page.getByText(/Загрузка продолжится через/).count(), 0);
    await page.evaluate(() => window.__partialFixture.activity({ phase: 'purchasedPage', state: 'waiting', attempt: 3, delayMs: 2500, reason: 'rateLimited' }));
    await page.getByText('Загрузка продолжится через 3 сек. · попытка 3', { exact: true }).waitFor();
    await page.evaluate(() => window.__partialFixture.progress({ completed: 0, total: 3, stage: 'keys' }));
    await page.getByText('Загружаем ключи', { exact: false }).waitFor();
    assert.equal(await page.getByText('Бандлы: 0 из 3', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Загружено покупок: 98 из 98', { exact: true }).count(), 0);
    assert.equal(await page.getByText(/Загрузка продолжится через/).count(), 0);
    assert.equal(await page.getByText(/^Библиотека обновлена/).count(), 0);
    await page.evaluate(() => { window.__partialFixture.holdSync = false; window.__partialFixture.finishSync(); });
    await page.getByText(warning, { exact: true }).waitFor();
    await page.evaluate(() => window.__partialFixture.activity({ phase: 'purchasedPage', state: 'waiting', attempt: 4, delayMs: 60000, reason: 'network' }));
    assert.equal(await page.locator('.sync-progress').count(), 0);
    assert.equal(await page.getByText(/Загрузка продолжится через/).count(), 0);
    check('Progress distinguishes the completed purchase list from ongoing key loading and counts processed bundles neutrally');
    const previousSync = await page.locator('.last-sync').innerText();
    await page.evaluate(() => { window.__partialFixture.result = window.__partialFixture.result.map(bundle => ({ ...bundle, detailsFailed: false })); window.__partialFixture.enumerationComplete = false; });
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.locator('.library-incomplete').getByText(incomplete, { exact: true }).waitFor();
    assert.equal(await page.locator('.bundle-tile').count(), 3); assert.equal(await page.locator('.last-sync').innerText(), previousSync);
    assert.equal(await page.getByText(/^Библиотека обновлена/).count(), 0);
    assert.equal(await page.getByText('Ключи не обновлены', { exact: true }).count(), 0);
    check('Incomplete enumeration remains visibly partial even when available bundles succeeded and never advances the success timestamp');
    await page.evaluate(() => { window.__partialFixture.enumerationComplete = true; window.__partialFixture.lastSync = '2026-11-01T00:00:00Z'; });
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.getByText('Библиотека обновлена · 3 бандлов', { exact: true }).waitFor();
    assert.equal(await page.getByText(warning, { exact: true }).count(), 0);
    assert.equal(await page.getByText('Ключи не обновлены', { exact: true }).count(), 0);
    assert.equal(await page.locator('.library-incomplete').count(), 0); assert.notEqual(await page.locator('.last-sync').innerText(), previousSync);
    check('Legacy bundles without flags retain reveal behavior and a later complete refresh clears partial status');
    await context.close();

    const persisted = await open('ru', { enumerationComplete: false });
    assert.equal(await persisted.page.locator('.library-incomplete').getByText(incomplete, { exact: true }).count(), 1);
    assert.equal(await persisted.page.getByText(/^Библиотека обновлена/).count(), 0);
    check('The cached enumeration marker restores the persistent partial-library status at startup');
    await persisted.context.close();

    const bootstrap = await open('ru', { holdInitial: true, warning: 'Synthetic stale cache warning' });
    await bootstrap.page.locator('.account-trigger').click();
    await bootstrap.page.getByRole('menuitem', { name: 'Войти в Humble', exact: true }).click();
    await bootstrap.page.getByText('Завершите вход в отдельном окне. Библиотека обновится автоматически.', { exact: true }).waitFor();
    await bootstrap.page.evaluate(() => {
      const f = window.__partialFixture;
      f.result = [{ id: 'fresh-sync', title: 'Synthetic fresh sync', imageUrl: '', items: [] }];
      f.enumerationComplete = false; f.lastSync = '2026-11-05T00:00:00Z'; f.warning = undefined;
      f.loginCompleted({ attemptId: 'synthetic-login' });
    });
    await bootstrap.page.getByRole('button', { name: 'Открыть бандл Synthetic fresh sync', exact: true }).waitFor();
    assert.equal(await bootstrap.page.locator('.loading-state').count(), 0);
    assert.equal(await bootstrap.page.locator('.library-incomplete').getByText(incomplete, { exact: true }).count(), 1);
    const freshTimestamp = await bootstrap.page.locator('.last-sync').innerText();
    await bootstrap.page.evaluate(() => window.__partialFixture.finishInitial());
    await bootstrap.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await bootstrap.page.locator('.bundle-tile').count(), 1);
    assert.equal(await bootstrap.page.getByRole('button', { name: 'Открыть бандл Synthetic fresh sync', exact: true }).count(), 1);
    assert.equal(await bootstrap.page.locator('.library-incomplete').getByText(incomplete, { exact: true }).count(), 1);
    assert.equal(await bootstrap.page.locator('.last-sync').innerText(), freshTimestamp);
    assert.equal(await bootstrap.page.getByText('Synthetic stale cache warning', { exact: true }).count(), 0);
    assert.equal(await bootstrap.page.getByText('Аккаунт подключён', { exact: true }).count(), 1);
    check('A fresh sync during initial cache loading owns bundles, partial metadata, timestamp, and warning state after the old cache response arrives');
    await bootstrap.context.close();

    const english = await open('en');
    assert((await english.page.locator('.bundle-tile').first().innerText()).includes('Keys not updated'));
    assert.equal(await english.page.getByText('Not all bundles could be updated. Previously saved keys remain in your library.', { exact: true }).count(), 1);
    await english.page.locator('.bundle-tile').first().click();
    assert.equal(await english.page.getByText('The keys for this bundle have not been fully loaded yet.', { exact: true }).count(), 1);
    check('Partial status and recovery text use the selected application language');
    await english.context.close();
    assert.deepEqual(report.errors, []); assert.deepEqual(report.remoteRequests, []);
  } finally { await browser.close(); fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'partial-library-ui-report.json'), JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
