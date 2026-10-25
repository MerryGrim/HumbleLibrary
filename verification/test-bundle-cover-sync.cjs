const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

// Integration of BOTH production initialization scripts with the real inert
// browser DOM parser and a synthetic IPC sink. No actual site request, account,
// browser profile, cookies, product keys or page contents are read.
const nativeRoot = path.join(sourceRoot, 'src-tauri/src');
const rustPath = path.join(nativeRoot, 'humble.rs');
const rustSource = fs.readFileSync(rustPath, 'utf8');
const initializationNames = Array.from(rustSource.matchAll(/\.initialization_script\(include_str!\("([^"]+)"\)\)/g), match => match[1]);
const helperName = 'humble_bundle_images.js';
const bridgeName = 'humble_bridge.js';
assert(initializationNames.includes(helperName), 'Production WebView must initialize the cover helper');
assert(initializationNames.includes(bridgeName), 'Production WebView must initialize the Humble bridge');
const sources = Object.fromEntries([helperName, bridgeName].map(name => [name, fs.readFileSync(path.join(nativeRoot, name), 'utf8')]));
const nonce = '0123456789abcdef0123456789abcdef';
const banner = 'https://hb.imgix.net/synthetic-cover-only.png?auto=compress,format&s=synthetic';
const icon = 'https://cdn.example.test/synthetic-fallback-icon.png';
const anchor = '<a id="logo" href="/software/scifi-game-dev-assets-synty-software"><img src="https://hb.imgix.net/synthetic-cover-only.png?auto=compress,format&amp;s=synthetic" alt=""></a>';
const order = extra => ({ product: { human_name: 'Sci-fi Game Dev Assets Synty', ...extra }, created: '2026-10-25', tpkd_dict: { all_tpks: [] } });
const report = {
  cases: [], fixtureOnly: true,
  scope: 'Actual production helper + bridge through synthetic IPC wire DTO in an isolated browser. All network is mocked/aborted. Rust camelCase DTO contract is checked statically; native deserialization is not executed by this JavaScript test.',
};

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  const unexpectedRequests = [], pageErrors = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://www.humblebundle.com' && url.pathname === '/synthetic-cover-sync-fixture') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' });
      unexpectedRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('https://www.humblebundle.com/synthetic-cover-sync-fixture');

    async function install({ html = anchor, orders = [order()], status = 200, reverse = false } = {}) {
      const names = reverse ? [...initializationNames].reverse() : initializationNames;
      await page.evaluate(({ scripts, html, orders, status, nonce }) => {
        window.__coverSyncCalls = [];
        window.__coverSyncPayloads = [];
        window.__coverSyncScriptRan = false;
        const ids = orders.map((_, index) => `synthetic_order_${index}`);
        window.fetch = async (value, options = {}) => {
          const url = String(value);
          window.__coverSyncCalls.push({ url, method: options.method || 'GET', credentials: options.credentials });
          if (url === '/api/v1/user/order') return new Response(JSON.stringify(ids.map(gamekey => ({ gamekey }))), { headers: { 'content-type': 'application/json' } });
          const detail = url.match(/^\/api\/v1\/order\/(synthetic_order_[0-9]+)\?all_tpkds=true$/);
          if (detail) return new Response(JSON.stringify(orders[ids.indexOf(detail[1])]), { headers: { 'content-type': 'application/json' } });
          if (/^\/downloads\?key=synthetic_order_[0-9]+$/.test(url)) return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
          throw new Error('Unexpected synthetic fetch path');
        };
        window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
          if (command !== 'humble_bridge_result' || args.nonce !== nonce) throw new Error('Unexpected synthetic IPC call');
          // Emulate the serialized JSON boundary, without substituting the
          // production DTO construction or image-discovery implementations.
          window.__coverSyncPayloads.push(JSON.parse(JSON.stringify(args.payload)));
        } };
        for (const script of scripts) (0, eval)(script);
      }, { scripts: names.map(name => sources[name]), html, orders, status, nonce });
    }
    async function sync() {
      return page.evaluate(async nonce => {
        await window.__humbleLibraryRequest({ nonce, operation: 'sync' });
        return { payload: window.__coverSyncPayloads.at(-1), calls: window.__coverSyncCalls, allPayloads: window.__coverSyncPayloads, scriptRan: window.__coverSyncScriptRan };
      }, nonce);
    }
    async function check(name, action) { await action(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`); }

    await check('Production-declared initialization modules carry the supplied a#logo banner into final sync DTO', async () => {
      await install(); const result = await sync();
      assert.equal(result.payload.kind, 'result'); assert.equal(result.payload.ok, true);
      assert.equal(result.payload.bundles.length, 1); assert.equal(result.payload.bundles[0].imageUrl, banner);
      assert.deepEqual(result.payload.bundles[0].items, []);
      assert.deepEqual(result.calls.map(call => call.url), ['/api/v1/user/order', '/api/v1/order/synthetic_order_0?all_tpkds=true', '/downloads?key=synthetic_order_0']);
      assert(result.calls.every(call => call.method === 'GET' && call.credentials === 'same-origin'));
    });
    await check('HTML entity decoding survives bridge JSON serialization without amp pollution', async () => {
      await install(); const result = await sync(); const value = result.payload.bundles[0].imageUrl;
      assert.equal(new URL(value).searchParams.get('s'), 'synthetic');
      assert.equal(new URL(value).searchParams.has('amp;s'), false);
      assert.equal(JSON.parse(JSON.stringify(result.payload)).bundles[0].imageUrl, banner);
    });
    await check('Purchase banner wins over API icon through the complete helper/bridge path', async () => {
      await install({ orders: [order({ icon })] }); const result = await sync();
      assert.equal(result.payload.bundles[0].imageUrl, banner); assert.notEqual(result.payload.bundles[0].imageUrl, icon);
    });
    await check('Plain and bundle-specific headers do not trigger global-navigation exclusion', async () => {
      for (const html of [`<header>${anchor}</header>`, `<header class="bundle-header">${anchor}</header>`, `<div class="purchase-header">${anchor}</div>`]) {
        await install({ html }); assert.equal((await sync()).payload.bundles[0].imageUrl, banner);
      }
    });
    await check('A global navigation homepage logo cannot replace the actual purchase banner', async () => {
      await install({ html: `<nav><a id="logo" href="/"><img src="https://cdn.example.test/brand.png" alt=""></a></nav><main>${anchor}</main>` });
      assert.equal((await sync()).payload.bundles[0].imageUrl, banner);
    });
    await check('Helper lookup during sync works regardless of initialization registration order', async () => {
      await install({ reverse: true }); assert.equal((await sync()).payload.bundles[0].imageUrl, banner);
    });
    await check('Successful purchase-cover cache retains the URL on a subsequent full sync', async () => {
      await install(); await sync(); const result = await sync();
      assert.equal(result.payload.bundles[0].imageUrl, banner);
      assert.equal(result.calls.filter(call => call.url.startsWith('/downloads?')).length, 1);
      assert.equal(result.allPayloads.filter(payload => payload.kind === 'result').length, 2);
    });
    await check('A failed purchase HTML read preserves sync success without invented cover or mutation', async () => {
      await install({ status: 403 }); const result = await sync();
      assert.equal(result.payload.ok, true); assert.equal(result.payload.bundles[0].imageUrl, '');
      assert.equal(result.calls.length, 3); assert(result.calls.every(call => call.method === 'GET'));
    });
    await check('Final wire imageUrl matches the real Rust serde camelCase Bundle contract', async () => {
      assert(/#\[serde\(rename_all\s*=\s*"camelCase"\)\]\s*pub struct Bundle\s*\{[\s\S]*?pub image_url:\s*String/.test(rustSource));
      await install(); const bundle = (await sync()).payload.bundles[0];
      assert.equal(Object.hasOwn(bundle, 'imageUrl'), true); assert.equal(Object.hasOwn(bundle, 'image_url'), false);
      assert.equal(typeof bundle.imageUrl, 'string'); assert.equal(bundle.imageUrl, banner);
    });
    await check('Downloaded HTML remains inert throughout sync and no image/script network is emitted', async () => {
      await install({ html: `${anchor}<script>window.__coverSyncScriptRan=true</script><iframe src="https://example.test/unexpected"></iframe>` });
      const result = await sync(); assert.equal(result.scriptRan, false); assert.equal(result.payload.bundles[0].imageUrl, banner);
      await page.waitForTimeout(50); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(pageErrors, []);
    });

    // Characterize the potential wrapper issue without weakening exclusions or
    // assuming an ancestor that the user's supplied fragment did not contain.
    await install({ html: `<header class="site-header">${anchor}</header>` });
    report.complementaryFinding = {
      globalHeaderAncestorExcludesPurchaseAnchor: (await sync()).payload.bundles[0].imageUrl === '',
      note: 'Plain header/bundle-header/purchase-header are supported. A site-header/global-header/humble-header ancestor excludes its subtree; the supplied fragment alone does not establish whether such an ancestor exists.',
    };
    report.passed = report.cases.length; report.failed = 0;
    report.sources = Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, crypto.createHash('sha256').update(value).digest('hex')]));
    report.rustDtoSourceSha256 = crypto.createHash('sha256').update(rustSource).digest('hex');
    const directory = path.join(outputRoot, `bundle-cover-sync-${new Date().toISOString().replace(/[:.]/g, '-')}`); fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'report.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`PASS ${report.passed} cover-sync integration checks; ${target}`);
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
