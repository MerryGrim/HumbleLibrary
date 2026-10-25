const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const esbuild = require(require.resolve('esbuild', { paths: [sourceRoot] }));
const report = { fixtureOnly: true, component: 'Notification.tsx', checks: [], errors: [] };
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };

(async () => {
  const built = await esbuild.build({
    stdin: { contents: `import React, {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import Notification from './src/Notification';
import {tr,setLanguagePreference} from './src/i18n';
const root=createRoot(document.getElementById('root'));
window.__closed=[];window.__copyCalls=[];window.__copyMode='ok';window.__pendingCopy=null;
window.__show=(message,duration,kind='info')=>flushSync(()=>root.render(<StrictMode><Notification message={message} duration={duration} kind={kind} onClose={()=>{window.__closed.push(performance.now());flushSync(()=>root.render(null));}}/></StrictMode>));
window.__unmount=()=>flushSync(()=>root.render(null));
window.__reset=()=>{window.__unmount();window.__closed=[];window.__copyCalls=[];window.__copyMode='ok';};
window.__translate=(language,source)=>{setLanguagePreference(language);return tr(source);};
window.__ready=true;`, resolveDir: sourceRoot, loader: 'tsx' },
    bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' },
    plugins: [{ name: 'notification-copy-fixture', setup(build) {
      build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'notification-copy-fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'notification-copy-fixture' }, () => ({ contents: `export const api={copy:async(text)=>{window.__copyCalls.push(text);if(window.__copyMode==='fail')throw Error('Synthetic clipboard failure');if(window.__copyMode==='pending')await new Promise((resolve,reject)=>{window.__pendingCopy={resolve,reject};});}};`, loader: 'js' }));
    } }],
  });
  fs.mkdirSync(outputRoot, { recursive: true });
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 960, height: 640 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-25T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-25T12:00:01Z'));
    const css = fs.readFileSync(path.join(sourceRoot, 'src/Notification.css'), 'utf8');
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>:root{font-family:Segoe UI;--accent:#8abaff;--selected:#243b56;--selected-border:#344e6c;--text:#edf2f8;--hover:#2a3442;--ok:#83d8b0;background:#101318;color:var(--text)}body{margin:0;padding-top:50px}button{font:inherit;display:inline-flex;align-items:center;gap:6px;border:1px solid #344e6c;border-radius:8px;color:var(--text);background:#202731;padding:8px}#outside{position:absolute;top:4px;left:4px}</style><style>'+css+'</style></head><body><button id="outside">Outside fixture focus</button><div id="root"></div></body></html>');
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.waitForFunction(() => window.__ready);
    const notification = page.locator('.notification');
    const show = async (message, duration, kind) => { await page.evaluate(({message,duration,kind}) => window.__show(message,duration,kind), {message,duration,kind}); };
    const reset = async () => { await page.locator('#outside').focus(); await page.mouse.move(2, 2); await page.evaluate(() => window.__reset()); };
    const countClosed = () => page.evaluate(() => window.__closed.length);
    const tick = milliseconds => page.clock.runFor(milliseconds);

    await show('Synthetic short notification', 200);
    await tick(199); assert.equal(await notification.count(), 1); assert.equal(await countClosed(), 0);
    await tick(1); assert.equal(await notification.count(), 0); assert.equal(await countClosed(), 1);
    await tick(1000); assert.equal(await countClosed(), 1);
    check('Short-duration notification expires once under React StrictMode without a stale duplicate timer');

    await reset(); await show('Synthetic hover pause', 300); await tick(100);
    const box = await notification.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await tick(1000); assert.equal(await notification.count(), 1);
    await page.mouse.move(2, 2); await tick(199); assert.equal(await notification.count(), 1);
    await tick(1); assert.equal(await notification.count(), 0); assert.equal(await countClosed(), 1);
    check('Pointer hover pauses expiration and pointer leave resumes the remaining time');

    await reset(); await show('Synthetic focus pause', 300); await tick(100);
    await page.locator('.notification__copy').focus(); await tick(500);
    await page.locator('.notification__close').focus(); await tick(500);
    assert.equal(await notification.count(), 1, 'Moving focus within the notification must keep it paused');
    await page.locator('#outside').focus(); await tick(199); assert.equal(await notification.count(), 1);
    await tick(1); assert.equal(await notification.count(), 0);
    check('Focus within pauses across internal focus changes and outside focus resumes the remaining time');

    await reset(); await show('Synthetic old message', 300); await tick(150);
    await show('Synthetic replacement message', 300); await tick(299);
    assert.equal(await notification.count(), 1); assert.equal(await countClosed(), 0);
    await tick(1); assert.equal(await countClosed(), 1);
    await reset(); await show('Synthetic stable message', 300); await tick(100);
    await show('Synthetic stable message', 300); await tick(200);
    assert.equal(await notification.count(), 0, 'An ordinary callback rerender must not reset lifetime');
    check('A new message resets lifetime; rerendering an unchanged message does not extend it');

    await reset();
    const visible = await page.evaluate(() => window.__translate('en','Очередь остановлена. Полученные ключи остаются в списке.'));
    await show(visible, 2000, 'warning');
    assert.equal(await notification.getAttribute('role'), 'alert');
    await page.locator('.notification__copy').evaluate(button => button.click());
    await page.getByRole('button', { name: 'Text copied', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__copyCalls), [visible]);
    assert.equal(await notification.count(), 1); assert.equal(await countClosed(), 0);
    await page.screenshot({ path: path.join(outputRoot, 'notification-copy-960x640.png') });
    await page.locator('.notification__close').evaluate(button => button.click());
    assert.equal(await notification.count(), 0); assert.equal(await countClosed(), 1);
    check('Copy uses the exact localized visible message, changes only its local acknowledgement, and X dismisses it');

    await reset(); await page.evaluate(() => { window.__copyMode='fail'; });
    await show('Synthetic copy failure', 2000, 'error');
    await page.locator('.notification__copy').evaluate(button => button.click());
    await page.getByText('Could not copy the text.', { exact: true }).waitFor();
    assert.equal(await notification.count(), 1); assert.equal(await countClosed(), 0);
    assert.deepEqual(await page.evaluate(() => window.__copyCalls), ['Synthetic copy failure']);
    check('Clipboard failure stays inline without creating recursive notifications');

    await reset(); await show('Synthetic unmount cleanup', 200); await tick(100);
    await page.evaluate(() => window.__unmount()); await tick(1000);
    assert.equal(await countClosed(), 0);
    await reset(); await page.evaluate(() => { window.__copyMode='pending'; });
    await show('Synthetic pending copy', 200);
    await page.locator('.notification__copy').evaluate(button => { button.click(); button.click(); });
    assert.equal(await page.evaluate(() => window.__copyCalls.length), 1);
    await page.evaluate(() => { window.__unmount();window.__pendingCopy.reject(new Error('Synthetic delayed clipboard failure')); });
    await tick(1000); assert.equal(await countClosed(), 0); assert.equal(await notification.count(), 0);
    check('Unmount clears timers and late clipboard completion; synchronous double clicks issue one copy');

    await reset(); await show('Synthetic default duration');
    await tick(7999); assert.equal(await notification.count(), 1);
    await tick(1); assert.equal(await notification.count(), 0); assert.equal(await countClosed(), 1);
    check('The default notification lifetime is eight seconds');
    assert.deepEqual(report.errors, []);
    await context.close();
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(outputRoot, 'notification-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(`PASS ${report.checks.length} notification scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
