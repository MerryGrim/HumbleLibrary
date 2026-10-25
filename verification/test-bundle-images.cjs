const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const sourcePath = path.join(sourceRoot, 'src-tauri/src/humble_bundle_images.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const ICON = 'https://cdn.example.test/bundle-icon.png';
const BANNER = 'https://cdn.example.test/mega-unreal-banner.png';
const order = () => ({ product: { human_name: 'Mega Unreal Engine Bundle', icon: ICON } });
const report = { fixtureOnly: true, cases: [], errors: [], scope: 'Actual browser inert DOM and bounded response fixtures only. No real Humble account, cookies, purchase HTML, keys, network or reveal.' };

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  const network = [];
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.pathname === '/fixture' && ['www.humblebundle.com', 'example.test'].includes(target.hostname)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' });
      network.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto('https://www.humblebundle.com/fixture');
    async function install(fixture = {}) {
      await page.evaluate(({ source, fixture }) => {
        window.__imageCalls = [];
        window.__imageScriptRan = false;
        window.fetch = async (url, options) => {
          window.__imageCalls.push({ url, method: options.method, credentials: options.credentials, cache: options.cache, hasSignal: !!options.signal });
          if (fixture.error) throw new Error('SYNTHETIC-PRIVATE-ERROR');
          if (fixture.awaitAbort) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
          return new Response(fixture.html || '', { status: fixture.status || 200, headers: { 'content-type': fixture.type || 'text/html; charset=utf-8', ...(fixture.length === undefined ? {} : { 'content-length': String(fixture.length) }) } });
        };
        (0, eval)(source);
      }, { source, fixture });
    }
    async function image(value, id = 'order_fixture', aborted = false) {
      return page.evaluate(async ({ value, id, aborted }) => {
        const controller = new AbortController(); if (aborted) controller.abort();
        try { return { image: await window.__humbleLibraryBundleImage(value, id, controller.signal), calls: window.__imageCalls, scriptRan: window.__imageScriptRan }; }
        catch (error) { return { reason: error.message, calls: window.__imageCalls }; }
      }, { value, id, aborted });
    }
    async function check(name, action) { await action(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`); }

    await check('Helper initializes only on the exact official HTTPS top-level page', async () => {
      const other = await context.newPage(); await other.goto('https://example.test/fixture');
      assert.equal(await other.evaluate(source => { (0, eval)(source); return typeof window.__humbleLibraryBundleImage; }, source), 'undefined'); await other.close();
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.srcdoc = '<!doctype html><p>fixture</p>'; document.body.append(frame); });
      const frame = page.frames().find(value => value !== page.mainFrame()); await frame.waitForLoadState();
      assert.equal(await frame.evaluate(source => { (0, eval)(source); return typeof window.__humbleLibraryBundleImage; }, source), 'undefined');
      await page.evaluate(() => document.querySelector('iframe').remove());
    });
    await check('Authoritative product logo wins over an icon and skips purchase-page fetching', async () => {
      await install(); const value = order(); value.product.logo = BANNER;
      const result = await image(value); assert.equal(result.image, BANNER); assert.equal(result.calls.length, 0);
    });
    await check('Order banner metadata and object URLs are supported before icon fallback', async () => {
      await install(); const value = order(); value.banner_url = { url: BANNER };
      assert.equal((await image(value)).image, BANNER); assert.equal((await image(value)).calls.length, 0);
    });
    await check('Authenticated HTML fallback extracts purchase logo, excludes navigation/footer brand and remains inert', async () => {
      await install({ html: `<nav><img class="logo" src="https://cdn.example.test/humble-logo.svg" alt="Humble Bundle"></nav><div class="logo-holder"><img src="${BANNER}" alt="Mega Unreal Engine Bundle"></div><footer><img class="logo" src="https://cdn.example.test/footer.svg"></footer><script>window.__imageScriptRan=true;window.__syntheticPrivate='SYNTHETIC-PRIVATE-KEY'</script><iframe src="https://example.test/unexpected"></iframe>` });
      const result = await image(order()); assert.equal(result.image, BANNER); assert.equal(result.scriptRan, false);
      assert.deepEqual(result.calls, [{ url: '/downloads?key=order_fixture', method: 'GET', credentials: 'same-origin', cache: 'no-store', hasSignal: true }]);
      assert.equal(JSON.stringify(result).includes('SYNTHETIC-PRIVATE-KEY'), false);
      assert.equal((await image(order())).calls.length, 1, 'Found purchase banner should be cached');
    });
    await check('Title-matching wide header is selected while unrelated wide artwork is ignored', async () => {
      await install({ html: `<header><img width="1200" height="350" alt="Different publication" src="https://cdn.example.test/unrelated.png"><img width="1200" height="350" alt="Mega Unreal Engine Bundle" src="${BANNER}"></header><main><img width="1200" height="350" alt="Mega Unreal Engine Bundle" src="https://cdn.example.test/product-preview.png"></main>` });
      assert.equal((await image(order())).image, BANNER);
    });
    await check('Logo wrapper variants use bundle images rather than a generic site brand', async () => {
      for (const html of [`<div class="logo"><img src="${BANNER}"></div>`, `<div class="main-logo"><img src="${BANNER}"></div>`, `<img class="main-logo" src="${BANNER}">`]) {
        await install({ html }); assert.equal((await image(order())).image, BANNER);
      }
    });
    await check('Observed purchase a#logo markup works without class, alt, dimensions or order icon and decodes ampersands', async () => {
      const expected = 'https://cdn.example.test/synthetic-purchase-banner.png?auto=compress,format&s=synthetic';
      await install({ html: '<a id="logo" href="/software/synthetic-scifi-assets"><img src="https://cdn.example.test/synthetic-purchase-banner.png?auto=compress,format&amp;s=synthetic" alt=""></a>' });
      const result = await image({ product: { human_name: 'Synthetic SciFi Game Dev Assets' } });
      assert.equal(result.image, expected); assert.equal(result.calls.length, 1);
    });
    await check('Purchase ID logo cannot select navbar, global-header or homepage branding', async () => {
      for (const html of [
        `<nav><a id="logo" href="/software/synthetic-scifi-assets"><img src="${BANNER}" alt=""></a></nav>`,
        `<header class="global-header"><a id="logo" href="/software/synthetic-scifi-assets"><img src="${BANNER}" alt=""></a></header>`,
        '<a id="logo" href="/"><img class="logo" src="https://cdn.example.test/site-brand-hash.svg" alt=""></a>',
        `<a id="logo" href="/?hmb_source=navbar"><img src="${BANNER}" alt=""></a>`,
        `<a id="logo" href="https://other.example.test/software/synthetic"><img src="${BANNER}" alt=""></a>`,
      ]) { await install({ html }); assert.equal((await image(order())).image, ICON); }
    });
    await check('Missing header keeps the existing icon and manual refresh can retry discovery', async () => {
      await install({ html: '<nav><img class="logo" alt="Humble Bundle" src="https://cdn.example.test/humble-logo.svg"></nav><main><img src="https://cdn.example.test/random-product.png"></main>' });
      assert.equal((await image(order())).image, ICON); const second = await image(order()); assert.equal(second.image, ICON); assert.equal(second.calls.length, 2);
    });
    await check('Generic Humble branding is rejected even in a plain logo wrapper', async () => {
      await install({ html: '<div class="logo"><img alt="Humble Bundle" title="Humble Bundle" src="https://cdn.example.test/hash.svg"><img src="https://cdn.example.test/humble_bundle_logo.svg"></div>' });
      assert.equal((await image(order())).image, ICON);
    });
    await check('Unsafe image schemes and credentials are rejected; safe relative header URLs resolve to HTTPS', async () => {
      await install({ html: '<div class="logo-holder"><img src="http://cdn.example.test/no.png"><img src="javascript:alert(1)"><img src="https://user:pass@cdn.example.test/no.png"><img src="/safe-purchase-logo.png"></div>' });
      const value = order(); value.product.logo = 'https://user:pass@cdn.example.test/no.png';
      assert.equal((await image(value)).image, 'https://www.humblebundle.com/safe-purchase-logo.png');
    });
    await check('Invalid purchase IDs cannot construct arbitrary authenticated paths', async () => {
      await install({ html: `<img class="logo" src="${BANNER}">` });
      for (const id of ['../account', 'id?x=y', 'id/other', 'x'.repeat(257), '']) { const result = await image(order(), id); assert.equal(result.image, ICON); assert.equal(result.calls.length, 0); }
    });
    await check('Network and HTTP failures use the icon without retry or raw error exposure', async () => {
      for (const fixture of [{ error: true }, { status: 401 }, { status: 429 }]) {
        await install(fixture); const result = await image(order()); assert.equal(result.image, ICON); assert.equal(result.calls.length, 1); assert.equal(JSON.stringify(result).includes('SYNTHETIC-PRIVATE-ERROR'), false); assert.equal((await image(order())).calls.length, 2);
      }
    });
    await check('Declared oversized HTML is rejected before parsing', async () => {
      await install({ length: 2 * 1024 * 1024 + 1, html: `<img class="logo" src="${BANNER}">` });
      assert.equal((await image(order())).image, ICON);
    });
    await check('Streamed HTML exceeding 2 MiB is rejected even without Content-Length', async () => {
      await install({ html: ' '.repeat(2 * 1024 * 1024 + 1) + `<img class="logo" src="${BANNER}">` });
      assert.equal((await image(order())).image, ICON);
    });
    await check('Pre-aborted and mid-fetch cancellation propagate cancelled instead of caching failure', async () => {
      await install({ awaitAbort: true }); const before = await image(order(), 'before_abort', true); assert.equal(before.reason, 'cancelled'); assert.equal(before.calls.length, 0);
      const during = await page.evaluate(async value => { const controller = new AbortController(); const pending = window.__humbleLibraryBundleImage(value, 'during_abort', controller.signal); controller.abort(); try { await pending; return 'not-cancelled'; } catch (error) { return error.message; } }, order());
      assert.equal(during, 'cancelled');
    });
    await check('Initialization captures fetch before later site code can replace it', async () => {
      await install({ html: `<div class="product-logo"><img src="${BANNER}"></div>` });
      await page.evaluate(() => { window.fetch = async () => { throw new Error('REPLACEMENT-MUST-NOT-RUN'); }; });
      assert.equal((await image(order())).image, BANNER);
    });
    await check('Image cache stays bounded and evicts old IDs after 10,000 entries', async () => {
      await install({ html: '' });
      const result = await page.evaluate(async ({ icon, banner }) => {
        for (let index = 0; index <= 10000; index++) await window.__humbleLibraryBundleImage({ product: { logo: banner } }, `cache_${index}`);
        const image = await window.__humbleLibraryBundleImage({ product: { icon } }, 'cache_0'); return { image, requests: window.__imageCalls.length };
      }, { icon: ICON, banner: BANNER });
      assert.equal(result.image, ICON); assert.equal(result.requests, 1);
    });
    await page.waitForTimeout(100);
    assert.deepEqual(network, [], 'Inert purchase DOM must not load scripts, images, frames or other resources');
    assert.deepEqual(report.errors, []);
    report.sourceSha256 = crypto.createHash('sha256').update(source).digest('hex'); report.passed = report.cases.length; report.failed = 0;
    const directory = path.join(outputRoot, `bundle-images-${new Date().toISOString().replace(/[:.]/g, '-')}`); fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'report.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(`PASS ${report.passed} purchase-image checks; ${target}`);
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
