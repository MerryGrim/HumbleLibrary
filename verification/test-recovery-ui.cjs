const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot, loadTypescript, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const esbuild = require(require.resolve('esbuild', { paths: [sourceRoot] }));

// The real App and Settings render only invented purchase groups and licenses.
// Native dialogs, profiles, account requests and output files are replaced.
const mockSource = `
const item=(id,title,platform,key)=>({id,title,platform,key,status:'revealed'});
const modern=[
 {id:'bundle-SYNTHETIC_PARENT_A',title:'Synthetic shared purchase',imageUrl:'',purchasedAt:'2026-11-10',items:[item('shared-entitlement','Synthetic modern Steam','Steam','SYNTHETIC-MODERN-A'),{id:'modern-hidden',title:'Synthetic modern hidden',platform:'GOG',key:null,status:'hidden'}]},
 {id:'bundle-SYNTHETIC_PARENT_B',title:'Synthetic modern second purchase',imageUrl:'',purchasedAt:'2026-11-09',items:[item('modern-second','Synthetic modern Fab','Fab','SYNTHETIC-MODERN-B')]}
];
const old=[
 {id:'recovered-SYNTHETIC_ORDER_A',title:'Synthetic shared purchase',imageUrl:'',purchasedAt:'2025-01-01',recovered:true,items:[item('shared-entitlement','Synthetic saved Steam','Steam','  SYNTHETIC-OLD-STEAM-A  '),item('old-gog','Synthetic saved GOG','GOG','SYNTHETIC-OLD-GOG-A')]},
 {id:'recovered-SYNTHETIC_ORDER_B',title:'Synthetic shared purchase',imageUrl:'',purchasedAt:'2024-01-01',recovered:true,items:[item('shared-entitlement','Synthetic saved Steam','Steam','SYNTHETIC-OLD-STEAM-B'),item('old-fab','Synthetic saved Fab','Fab','SYNTHETIC-OLD-FAB-B')]}
];
const options=window.__recoveryOptions||{};
const f=window.__recoveryFixture={rows:structuredClone(options.initialRecovered?[...modern,...old]:modern),mode:'cancel',calls:[],copies:[],exports:[],reveals:[],finish:null,injectHidden:false};
const status=()=>({connected:true,authState:'authenticated',lastSync:'2026-11-10T00:00:00Z',enumerationComplete:true,bundles:structuredClone(f.rows)});
const restored=()=>{f.rows=structuredClone([...modern,...old]);if(f.injectHidden)f.rows[2].items.push({id:'unexpected-hidden',title:'Synthetic recovered hidden metadata',platform:'Other',key:null,status:'hidden'});return status();};
const noop=async()=>{};const listen=async()=>()=>{};
export const api={preview:options.preview===true,status:async()=>status(),
 importLegacy:async()=>{f.calls.push('import');if(f.mode==='cancel')return null;if(f.mode==='error')throw new Error('Не удалось восстановить сохранённые покупки.');if(f.mode==='pending')return await new Promise(resolve=>{f.finish=()=>{f.finish=null;resolve(restored());};});return restored();},
 copy:async text=>{f.copies.push(text);},exportKeys:async(contents,name)=>{f.exports.push({contents,name});return 'SYNTHETIC_EXPORT.txt';},
 reveal:async(bundleId,itemId)=>{f.reveals.push({bundleId,itemId});throw new Error('Synthetic reveal forbidden');},
 onProgress:listen,onSyncActivity:listen,onWarning:listen,onSessionStatus:listen,onUpdateProgress:listen,onLoginCompleted:listen,onLoginCancelled:listen,
 setNativeLanguage:noop,updateReady:noop,updateStatus:async()=>({enabled:false,configured:false,repository:'',currentVersion:'0.3.4',supported:true}),
 clearCache:noop,resetLogin:noop,resetAll:async()=>status(),login:async()=>({attemptId:'SYNTHETIC_LOGIN'}),logout:noop,cancel:noop,openExternal:noop
};`;
const summary = 'Ключи из прежней библиотеки сохранены в исходной покупке. Их можно копировать и экспортировать.';
const success = 'Сохранённые покупки восстановлены.';
const failure = 'Не удалось восстановить сохранённые покупки.';
const report = { fixtureOnly: true, realDataRead: false, checks: [], visuals: [], errors: [], network: [], sourceSha256: {} };
for (const name of ['App.tsx', 'SettingsDialog.tsx', 'api.ts', 'styles.css']) report.sourceSha256[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, 'src', name))).digest('hex');
const check = name => { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };

(async () => {
  const calls = [];
  const { api } = loadTypescript('src/api.ts', {
    '@tauri-apps/api/core': { isTauri: () => true, invoke: async (command, args) => { calls.push({ command, args }); return null; } },
    '@tauri-apps/api/event': { listen: async () => () => {} }, '../package.json': { default: { version: '0.3.4' } },
  });
  assert.equal(calls.length, 0); assert.equal(await api.importLegacy(), null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ command: 'humble_import_legacy', args: { allowUnbound: true } }]);
  check('Import IPC is explicit, allows the user-selected unbound copy, and preserves native picker cancellation');

  const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App';createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: sourceRoot, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, plugins: [{ name: 'recovery-ui-fixture', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'recovery-ui-fixture' }));
    build.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({ path: 'window', namespace: 'recovery-ui-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'recovery-ui-fixture' }, args => ({ contents: args.path === 'api' ? mockSource : 'export const getCurrentWindow=()=>({minimize:async()=>{},toggleMaximize:async()=>{},close:async()=>{}});', loader: 'js' }));
  } }] });
  const css = ['styles.css', 'Notification.css', 'BundleSort.css'].map(name => fs.readFileSync(path.join(sourceRoot, 'src', name), 'utf8')).join('\n');
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  try {
    async function open(width = 1280, theme = 'dark', options = {}) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, locale: 'ru-RU', reducedMotion: 'reduce' });
      await context.route('**/*', route => {
        if (route.request().url() === 'https://hl-recovery-fixture.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div id="root"></div></body></html>' });
        report.network.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
      await page.goto('https://hl-recovery-fixture.invalid/');
      await page.evaluate(({ theme, options }) => { localStorage.setItem('humble-library-language', 'ru'); localStorage.setItem('humble-library-theme', theme); window.__recoveryOptions = options; }, { theme, options });
      await page.addScriptTag({ content: bundle.outputFiles[0].text }); await page.locator('.bundle-tile').first().waitFor();
      return { context, page };
    }
    async function settings(page) { await page.getByRole('button', { name: 'Настройки', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true }); await dialog.waitFor(); return dialog; }
    async function closeSettings(page) { await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click(); }
    async function snapshot(page) { return { count: await page.locator('.bundle-tile').count(), tiles: await page.locator('.bundle-tile').allTextContents(), lastSync: await page.locator('.last-sync').innerText() }; }
    async function visual(page, width, theme, preview = false) {
      const search = page.getByRole('textbox', { name: 'Поиск бандлов', exact: true }); await search.focus();
      const geometry = await page.evaluate(() => {
        const modern = document.querySelector('.bundle-tile:not(:has(.recovered-label))'), recovered = document.querySelector('.bundle-tile:has(.recovered-label)'), cover = recovered.querySelector('.bundle-cover'), label = recovered.querySelector('.recovered-label');
        const b = node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        const m = b(modern), r = b(recovered), c = b(cover), l = b(label), caption = b(cover.querySelector('.cover-fallback>span')), s = b(document.querySelector('.search')), viewport = b(document.querySelector('.workspace-content')), style = getComputedStyle(document.querySelector('.search'));
        return { modern: m, recovered: r, labelInsideCover: l.left >= c.left && l.right <= c.right && l.top >= c.top && l.bottom <= c.bottom, labelClearOfCaption: l.right <= caption.left || l.left >= caption.right || l.bottom <= caption.top || l.top >= caption.bottom, searchClearance: s.top - Number.parseFloat(style.outlineWidth) - Number.parseFloat(style.outlineOffset) - viewport.top, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth };
      });
      assert(Math.abs(geometry.modern.width - geometry.recovered.width) < 0.1); assert(Math.abs(geometry.modern.height - geometry.recovered.height) < 0.1);
      assert(geometry.labelInsideCover && geometry.labelClearOfCaption && geometry.noHorizontalOverflow && geometry.searchClearance >= 1);
      assert.equal(await page.locator('.recovered-label').count(), 2); assert.equal(await page.locator('.bundle-tile').count(), 4);
      const screenshot = `recovery-ui-${width}-${theme}${preview ? '-preview' : ''}.png`; await page.screenshot({ path: path.join(outputRoot, screenshot) });
      report.visuals.push({ width, theme, preview, passed: true, geometry, screenshot });
    }
    const { context, page } = await open();
    const before = await snapshot(page); assert.equal(await page.evaluate(() => window.__recoveryFixture.calls.length), 0);
    let dialog = await settings(page); await dialog.getByRole('button', { name: 'Выбрать копию', exact: true }).click();
    await page.waitForFunction(() => window.__recoveryFixture.calls.length === 1);
    assert.equal(await dialog.getByText(success, { exact: true }).count(), 0); assert.equal(await dialog.locator('.notification').count(), 0);
    await closeSettings(page); assert.deepEqual(await snapshot(page), before);
    check('Cancelling the selected-copy picker leaves the library and timestamp unchanged and reports no false success');

    await page.evaluate(() => { window.__recoveryFixture.mode = 'error'; }); dialog = await settings(page);
    await dialog.getByRole('button', { name: 'Выбрать копию', exact: true }).click(); await dialog.getByText(failure, { exact: true }).waitFor();
    assert.equal(await dialog.getByText(success, { exact: true }).count(), 0); await closeSettings(page); assert.deepEqual(await snapshot(page), before);
    check('Import failure uses the existing error notification and cannot replace the current purchase groups');

    await page.evaluate(() => { window.__recoveryFixture.mode = 'pending'; }); dialog = await settings(page);
    await dialog.getByRole('button', { name: 'Выбрать копию', exact: true }).click(); await page.waitForFunction(() => !!window.__recoveryFixture.finish);
    assert.equal(await dialog.getByRole('button', { name: 'Восстанавливаем покупки…', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Восстанавливаем покупки…', exact: true }).evaluate(node => node.click()); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__recoveryFixture.calls.length), 3); assert(await dialog.isVisible());
    await page.evaluate(() => window.__recoveryFixture.finish()); await dialog.getByText(success, { exact: true }).waitFor();
    assert.equal(await dialog.getByText(success, { exact: true }).count(), 1); await closeSettings(page);
    assert.equal(await page.locator('.bundle-tile').count(), 4); assert.equal(await page.locator('.recovered-label').count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Открыть бандл Synthetic shared purchase', exact: true }).count(), 3);
    assert.equal((await snapshot(page)).lastSync, before.lastSync);
    await visual(page, 1280, 'dark');
    check('Recovery is single-flight and keeps separate modern and original old purchase groups even when their titles match');

    const recovered = page.locator('.bundle-tile').filter({ has: page.locator('.recovered-label') });
    await recovered.nth(0).click(); assert.equal(await page.getByText(summary, { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Раскрыть', exact: true }).count(), 0); assert(await page.getByRole('button', { name: 'Раскрыть все', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Скопировать ключ: Synthetic saved Steam', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__recoveryFixture.copies), ['  SYNTHETIC-OLD-STEAM-A  ']);
    await page.getByRole('button', { name: 'Экспортировать', exact: true }).click(); let exportDialog = page.getByRole('dialog', { name: 'Экспорт ключей', exact: true });
    assert.equal(await exportDialog.getByRole('button', { name: 'Раскрыть и экспортировать', exact: true }).count(), 0);
    await exportDialog.getByRole('button', { name: 'Сохранить TXT', exact: true }).click(); await exportDialog.waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => window.__recoveryFixture.exports))[0].contents, 'SYNTHETIC-OLD-STEAM-A\r\nSYNTHETIC-OLD-GOG-A\r\n');
    await page.screenshot({ path: path.join(outputRoot, 'recovery-ui-selected-1280-dark.png') });
    await page.getByRole('button', { name: 'Назад к бандлам', exact: true }).click(); await recovered.nth(1).click();
    await page.getByRole('button', { name: 'Скопировать ключ: Synthetic saved Steam', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__recoveryFixture.copies), ['  SYNTHETIC-OLD-STEAM-A  ', 'SYNTHETIC-OLD-STEAM-B']);
    assert.equal(await page.getByText('SYNTHETIC-MODERN-A', { exact: true }).count(), 0);
    check('Recovered groups explain their provenance, keep copy bytes exact, and export only that selected purchase without reveal actions');

    await page.getByRole('button', { name: 'Назад к бандлам', exact: true }).click(); await page.evaluate(() => { window.__recoveryFixture.mode = 'success'; window.__recoveryFixture.injectHidden = true; });
    dialog = await settings(page); await dialog.getByRole('button', { name: 'Выбрать копию', exact: true }).click(); await dialog.getByText(success, { exact: true }).waitFor(); await closeSettings(page);
    await recovered.nth(0).click(); assert(await page.getByRole('button', { name: 'Раскрыть', exact: true }).isDisabled()); assert(await page.getByRole('button', { name: 'Раскрыть все', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Экспортировать', exact: true }).click(); exportDialog = page.getByRole('dialog', { name: 'Экспорт ключей', exact: true });
    assert.equal(await exportDialog.getByRole('button', { name: 'Раскрыть и экспортировать', exact: true }).count(), 0);
    await exportDialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__recoveryFixture.reveals), []);
    await page.getByRole('button', { name: 'Назад к бандлам', exact: true }).click(); await page.locator('.bundle-tile:not(:has(.recovered-label))').first().click();
    assert.equal(await page.getByRole('button', { name: 'Раскрыть', exact: true }).isDisabled(), false);
    check('Even unexpected hidden metadata in a local copy cannot invoke reveal; normal modern purchases retain their reveal control');
    await context.close();

    for (const config of [{ width: 1280, theme: 'light' }, { width: 940, theme: 'dark' }, { width: 640, theme: 'light', preview: true }]) {
      const surface = await open(config.width, config.theme, { initialRecovered: true, preview: config.preview });
      await visual(surface.page, config.width, config.theme, config.preview);
      const settingsDialog = await settings(surface.page); await settingsDialog.getByRole('heading', { name: 'Восстановить сохранённые покупки', exact: true }).scrollIntoViewIfNeeded();
      assert(await settingsDialog.getByRole('button', { name: 'Выбрать копию', exact: true }).isVisible());
      const fits = await settingsDialog.evaluate(node => node.scrollWidth <= node.clientWidth); assert(fits);
      assert.equal(await surface.page.evaluate(() => window.__recoveryFixture.calls.length), 0);
      await surface.context.close();
    }
    check('Local-copy badges and Settings remain readable in both themes at desktop and narrow preview sizes without changing tiles or clipping search focus');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.network, []);
  } finally { await browser.close(); fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'recovery-ui-report.json'), JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
