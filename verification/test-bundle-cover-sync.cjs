const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

// Production bridge integration with banner discovery paused. The retained
// image helper is installed but must never be called. Network is synthetic.
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
  scope: 'Production bridge with retained image helper deliberately forbidden during sync. All network is mocked/aborted. Rust camelCase DTO contract is checked statically; native deserialization is not executed by this JavaScript test.',
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
        window.__coverHelperCalls = 0;
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
        window.__humbleLibraryBundleImage = async () => { window.__coverHelperCalls += 1; throw new Error("Banner discovery must stay paused"); };
      }, { scripts: names.map(name => sources[name]), html, orders, status, nonce });
    }
    async function sync() {
      return page.evaluate(async nonce => {
        await window.__humbleLibraryRequest({ nonce, operation: 'sync' });
        return { payload: window.__coverSyncPayloads.at(-1), calls: window.__coverSyncCalls, allPayloads: window.__coverSyncPayloads, scriptRan: window.__coverSyncScriptRan, helperCalls: window.__coverHelperCalls };
      }, nonce);
    }
    async function check(name, action) { await action(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`); }

    await check('Paused banners add no purchase HTML or image requests during sync', async () => {
      await install(); const result = await sync();
      assert.equal(result.payload.ok, true); assert.equal(result.helperCalls, 0);
      assert.equal(result.payload.bundles[0].imageUrl, '');
      assert.deepEqual(result.calls.map(call => call.url), ['/api/v1/user/order', '/api/v1/order/synthetic_order_0?all_tpkds=true']);
      assert(result.calls.every(call => call.method === 'GET' && call.credentials === 'same-origin'));
    });
    await check('Existing image metadata remains in the DTO without loading the image', async () => {
      await install({ orders: [order({ icon })] }); const result = await sync();
      assert.equal(result.payload.bundles[0].imageUrl, icon); assert.equal(result.helperCalls, 0);
      assert.equal(result.calls.length, 2);
    });
    await check('Multiple purchases load only the list and each required order', async () => {
      await install({ orders: [order({ icon }), order({ logo: banner })] }); const result = await sync();
      assert.equal(result.payload.bundles.length, 2); assert.equal(result.calls.length, 3);
      assert.equal(result.helperCalls, 0); assert(!result.calls.some(call => call.url.startsWith('/downloads')));
    });
    await check('Repeated syncs and reversed helper registration do not reactivate banners', async () => {
      await install({ reverse: true }); await sync(); const result = await sync();
      assert.equal(result.helperCalls, 0); assert.equal(result.calls.length, 4);
      assert.equal(result.allPayloads.filter(payload => payload.kind === 'result').length, 2);
    });
    await check('Final image metadata retains the Rust camelCase DTO contract', async () => {
      assert(/#\[serde\(rename_all\s*=\s*"camelCase"\)\]\s*pub struct Bundle\s*\{[\s\S]*?pub image_url:\s*String/.test(rustSource));
      await install({ orders: [order({ icon })] }); const bundle = (await sync()).payload.bundles[0];
      assert.equal(bundle.imageUrl, icon); assert.equal(Object.hasOwn(bundle, 'image_url'), false);
    });
    await check('Unused purchase HTML is neither fetched nor evaluated', async () => {
      await install({ html: anchor + '<script>window.__coverSyncScriptRan=true</script>' }); const result = await sync();
      assert.equal(result.scriptRan, false); assert.equal(result.helperCalls, 0);
      assert.deepEqual(unexpectedRequests, []); assert.deepEqual(pageErrors, []);
    });
    report.passed = report.cases.length; report.failed = 0;
    report.sources = Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, crypto.createHash('sha256').update(value).digest('hex')]));
    report.rustDtoSourceSha256 = crypto.createHash('sha256').update(rustSource).digest('hex');
    const directory = path.join(outputRoot, `bundle-cover-sync-${new Date().toISOString().replace(/[:.]/g, '-')}`); fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'report.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`PASS ${report.passed} cover-sync integration checks; ${target}`);
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
