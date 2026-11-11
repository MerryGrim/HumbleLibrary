const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

// Authoritative bundle-index integration tests. All identities, purchase rows,
// entitlements and codes are invented. Every fetch is owned by a fake window;
// the real browser only opens an intercepted synthetic HTTPS document.
const sourceNames = ['humble_flight.js', 'humble_page.js', 'humble_items.js', 'humble_sync.js', 'humble_bridge.js'];
const sources = sourceNames.map(name => fs.readFileSync(path.join(sourceRoot, 'src-tauri/src', name), 'utf8'));
const nonce = '0123456789abcdef0123456789abcdef';
const scriptPath = '/_next/static/chunks/SYNTHETIC_FLAT_PRODUCTS_ACTION.js';
const user = { id: 'SYNTHETIC_PRIVATE_ACCOUNT', email: 'fixture@example.test' };
const otherUser = { id: 'SYNTHETIC_PRIVATE_OTHER_ACCOUNT', email: 'other@example.test' };
const parents = [
  { id: 'purchase-row-a', productEntitlementId: 'bundle-a', title: 'Synthetic Bundle Alpha', itemType: 'entitlement-group', type: 'bundle', purchasedAt: '2026-11-09T00:00:00.000Z' },
  { id: 'bundle-b', productEntitlementId: null, title: 'Synthetic Bundle Beta', itemType: 'content-entitlement', type: 'software' },
];
const key = (id, type, extra = {}) => ({ id, title: `Synthetic ${id}`, type, keyIntegrationId: 'generic', redeemable: true, redemptionData: {}, ...extra });
const retainedCode = '  SYNTHETIC-ÜNICODE-CODE-A  ';
const alphaSteam = key('shared-license', 'steam', { redemptionData: { keyFormatted: retainedCode }, gameKey: 'SYNTHETIC_PRIVATE_GIFT_TOKEN' });
const alphaParts = [
  { userLibraryItem: { id: 'shared-product', title: 'Synthetic Alpha first product', purchasedAt: '2020-01-01T00:00:00.000Z', entitlements: {
    keys: [alphaSteam, key('alpha-fab-hidden', 'fab')], downloads: [{ id: 'alpha-book', title: 'Synthetic ebook', type: 'ebook', instructionsHtml: '<p>Download from the official page.</p>' }],
  } }, productEntitlementId: 'SYNTHETIC_PRIVATE_UNRELATED_ZIP_CONTEXT' },
  { userLibraryItem: { entitlements: { keys: [
    key('alpha-gog', 'gog', { redemptionData: { keyFormatted: 'SYNTHETIC-GOG-CODE-A' } }),
    key('alpha-url', 'url', { redeemable: false, customCtaUrl: 'https://example.test/official-provider' }),
  ] } } },
];
const betaParts = [
  { userLibraryItem: { id: 'shared-product', title: 'Synthetic Beta first product', purchasedAt: '2026-11-08T00:00:00.000Z', entitlements: { keys: [
    key('shared-license', 'steam', { redemptionData: { keyFormatted: 'SYNTHETIC-STEAM-CODE-B' } }),
    key('beta-fab', 'fab', { redemptionData: { keyFormatted: 'SYNTHETIC-FAB-CODE-B' } }),
  ] } } },
  { userLibraryItem: { entitlements: { keys: [key('beta-choice', 'synthetic_other_platform')], downloads: [{ id: 'beta-download', title: 'Synthetic asset archive', type: 'software' }],
    redemptionGroups: [{ options: [{ entitlementId: 'beta-choice', eligible: true }] }],
  } } },
];
function pageHtml(component, props, owner = user, asyncModule = false, scripts = []) {
  const children = (Array.isArray(props) ? props : [props]).map((value, index) => ['$', '$L2', String(index), value]);
  const wire = '1:I[101,[],"AuthProvider"]\n'
    + `2:I[102,[],${JSON.stringify(component)}${asyncModule ? ',1' : ''}]\n`
    + `3:${JSON.stringify(['$', '$L1', null, { user: owner, children }])}\n`;
  return `<!doctype html><html><head>${scripts.map(src => `<script src="${src}"></script>`).join('')}</head><body><script>self.__next_f.push(${JSON.stringify([1, wire])})</script><script>window.__forbiddenDownloadedScript=true</script></body></html>`;
}
const flatCanary = Array.from({ length: 471 }, (_, index) => ({ id: `SYNTHETIC_FLAT_PRODUCT_${index}`, title: 'Synthetic individual product', entitlements: { keys: [key(`flat-key-${index}`, 'steam')] } }));
const vaultCanary = { id: 'SYNTHETIC_VAULT_CANARY', title: 'Synthetic unrelated Vault row', entitlements: { downloads: [{ id: 'SYNTHETIC_VAULT_DOWNLOAD', title: 'Synthetic Vault download' }] } };
const rootHtml = (bundleItems = parents, owner = user, extra = {}) => pageHtml('UserLibrary', { bundleItems, vaultItems: [vaultCanary], purchased: flatCanary, ...extra }, owner, false, [scriptPath]);
const alphaHtml = pageHtml('ProductKeysDownloads', alphaParts, user, true);
const betaHtml = pageHtml('ProductKeysDownloads', betaParts, user, true);
const variants = {
  empty: pageHtml('ProductKeysDownloads', [{ userLibraryItem: {} }]),
  opaque: pageHtml('ProductKeysDownloads', betaParts.map(part => ({ ...part, productEntitlementId: 'SYNTHETIC_PRIVATE_DIFFERENT_ZIP', userLibraryItem: { ...part.userLibraryItem, id: 'SYNTHETIC_PRIVATE_OPAQUE_CHILD' } }))),
  missing: pageHtml('UnrelatedComponent', { unused: true }),
  malformedAsync: pageHtml('ProductKeysDownloads', [{ userLibraryItem: null }], user, true),
  malformedKey: pageHtml('ProductKeysDownloads', [{ userLibraryItem: { entitlements: { keys: [key('invalid-consumed-key', 'steam', { redemptionData: { keyFormatted: {} } })] } } }]),
  conflict: pageHtml('ProductKeysDownloads', [...betaParts, { userLibraryItem: { entitlements: { keys: [key('shared-license', 'steam', { redemptionData: { keyFormatted: 'SYNTHETIC-CONFLICTING-CODE' } })] } } }]),
  integrationConflict: pageHtml('ProductKeysDownloads', [...betaParts, { userLibraryItem: { entitlements: { keys: [key('shared-license', 'steam', { keyIntegrationId: 'other', redemptionData: { keyFormatted: 'SYNTHETIC-STEAM-CODE-B' } })] } } }]),
  duplicate: pageHtml('ProductKeysDownloads', [...betaParts, betaParts[0]], user, true),
  presentation: pageHtml('ProductKeysDownloads', [...betaParts, { userLibraryItem: { entitlements: { keys: [key('shared-license', 'steam', { title: 'Synthetic alternate label', instructionsHtml: '<p>Alternate instructions.</p>', redemptionData: { keyFormatted: 'SYNTHETIC-STEAM-CODE-B' } })] } } }]),
  anonymous: pageHtml('ProductKeysDownloads', betaParts, null),
  otherAccount: pageHtml('ProductKeysDownloads', betaParts, otherUser),
};
const report = { fixtureOnly: true, projection: 'bundles-v1', noLiveAccount: true, checks: [],
  sourceSha256: Object.fromEntries(sourceNames.map((name, index) => [name, crypto.createHash('sha256').update(sources[index]).digest('hex')])) };

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions), network = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' }), syntheticUrl = 'https://sync-fixture.invalid/';
    await context.route('**/*', route => { if (route.request().url() === syntheticUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }); network.push(route.request().url()); return route.abort(); });
    const page = await context.newPage(); await page.goto(syntheticUrl);
    async function run(config = {}) {
      let bundleItems = config.empty ? [] : config.aliases ? [...parents, { ...parents[0], id: 'alias-row-a', purchasedAt: '2020-01-01T00:00:00.000Z' }] : parents;
      const detailPages = { '/home/library/bundle-a': alphaHtml, '/home/library/bundle-b': betaHtml };
      if (config.standalone) {
        bundleItems = [...parents, { id: 'standalone-purchase', title: 'Synthetic standalone purchase', type: 'game' }];
        detailPages['/home/library/standalone-purchase'] = pageHtml('ProductKeysDownloads', [{ userLibraryItem: { entitlements: { keys: [key('standalone-steam', 'steam'), key('standalone-gog', 'gog')] } } }]);
      }
      let html = rootHtml(bundleItems);
      if (config.anonymousRoot) html = rootHtml(bundleItems, null);
      if (config.missingIdentity) html = rootHtml(bundleItems, { email: user.email });
      if (config.badRoot === 'bundleContainer') html = rootHtml({}, user);
      if (config.badRoot === 'bundleEntry') html = rootHtml([null], user);
      if (config.noScript) html = html.replace(`<script src="${scriptPath}"></script>`, '');
      if (config.variant) detailPages['/home/library/bundle-b'] = variants[config.variant];
      return page.evaluate(async ({ sources, nonce, config, html, changedRoot, detailPages }) => {
        const requests = [], sent = [], logs = [], forbidden = [], attempts = {};
        let rootReads = 0, virtualNow = 0, bridgeWindow;
        const origin = 'https://www.humblebundle.com';
        const response = (body, route, status = 200, finalUrl, type = 'text/html', headers = {}) => {
          const result = new Response(body, { status, headers: { 'content-type': type, ...headers } });
          Object.defineProperty(result, 'url', { value: finalUrl || `${origin}${route}` }); return result;
        };
        bridgeWindow = {
          fetch: async (route, options = {}) => {
            route = String(route); requests.push({ route, method: options.method || 'GET', credentials: options.credentials, cache: options.cache });
            if (route === '/api/auth/session-status') return response('{"status":"authenticated"}', route, 200, undefined, 'application/json');
            if (options.method && options.method !== 'GET' || route.includes('_next/') || route.includes('/content/') || route.includes('/group/') || route.includes('?') || route.includes('/api/')) {
              forbidden.push(route); throw Error('SYNTHETIC_PRIVATE_FORBIDDEN_FLAT_OR_MUTATION_ENDPOINT');
            }
            if (route === '/home/library') {
              rootReads++;
              if (config.cancelRoot) { bridgeWindow.__humbleLibraryCancel(nonce); throw new DOMException('Cancelled', 'AbortError'); }
              return response(config.finalMismatch && rootReads > 1 ? changedRoot : html, route, config.rootStatus || 200, config.rootRedirect);
            }
            if (Object.hasOwn(detailPages, route)) {
              const attempt = attempts[route] = (attempts[route] || 0) + 1;
              if (config.cancelDetail && route.endsWith('bundle-b')) { bridgeWindow.__humbleLibraryCancel(nonce); throw new DOMException('Cancelled', 'AbortError'); }
              if (route.endsWith('bundle-b')) {
                if (config.networkFailure && (config.networkFailure === 'persistent' || attempt === 1)) throw Error('SYNTHETIC_PRIVATE_TRANSPORT_BODY');
                if (config.detailStatus && (config.persistentStatus || attempt === 1)) return response('SYNTHETIC_PRIVATE_BACKEND_BODY', route, config.detailStatus, undefined, 'text/html', config.detailStatus === 429 ? { 'retry-after': '7' } : {});
              }
              return response(detailPages[route], route, 200, config.wrongDetailUrl && route.endsWith('bundle-b') ? `${origin}/home/library/SYNTHETIC_OTHER_PARENT` : undefined);
            }
            forbidden.push(route); throw Error('SYNTHETIC_PRIVATE_UNEXPECTED_ROUTE');
          },
          __TAURI_INTERNALS__: { invoke: async (command, args) => { if (command !== 'humble_bridge_result' || args.nonce !== nonce) throw Error('Unexpected IPC'); sent.push(JSON.parse(JSON.stringify(args.payload))); } },
        };
        bridgeWindow.top = bridgeWindow;
        const doc = {}; Object.defineProperty(doc, 'cookie', { get() { throw Error('Read-only sync cannot inspect cookies'); } });
        const fakeConsole = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(name => [name, (...args) => logs.push({ name, args })]));
        for (const source of sources) new Function('window', 'location', 'document', 'console', source)(bridgeWindow, { origin }, doc, fakeConsole);
        const actualRun = bridgeWindow.__humbleLibrarySync.run;
        bridgeWindow.__humbleLibrarySync = { run: (adapter, options) => actualRun({ ...adapter, now: () => virtualNow,
          wait: async (ms, signal) => { virtualNow += ms; if (signal?.aborted) throw Error('cancelled'); await Promise.resolve(); },
        }, options) };
        await bridgeWindow.__humbleLibraryRequest({ nonce, operation: 'auth' });
        if (config.authOnly) return { requests, sent, logs, forbidden, state: bridgeWindow.__humbleLibraryBridgeState() };
        requests.length = 0; sent.length = 0;
        await bridgeWindow.__humbleLibraryRequest({ nonce, operation: 'sync' });
        return { requests, sent, logs, forbidden, state: bridgeWindow.__humbleLibraryBridgeState(), downloadedScriptRan: window.__forbiddenDownloadedScript === true };
      }, { sources, nonce, config, html, changedRoot: rootHtml(bundleItems, otherUser), detailPages });
    }
    const final = result => result.sent.findLast(frame => frame.kind === 'result');
    const codes = complete => complete.bundles.flatMap(bundle => bundle.items).filter(item => item.key).map(item => item.key).sort();
    function clean(result) {
      assert.deepEqual(result.forbidden, []); assert.deepEqual(result.logs, []); assert.equal(result.state, 'ready');
      assert.equal(result.downloadedScriptRan, result.requests.some(request => request.route === '/home/library') ? false : undefined);
      assert(!JSON.stringify(result.sent).includes('SYNTHETIC_PRIVATE')); assert(!JSON.stringify(result.sent).includes('@example.test'));
      assert(result.requests.every(request => request.method === 'GET' && request.credentials === 'same-origin' && request.cache === 'no-store'));
      assert(!result.sent.some(frame => frame.kind === 'progress' && frame.stage === 'purchases'));
    }
    function complete(result, count = 2) {
      clean(result); const value = final(result); assert.equal(value?.ok, true); assert.equal(value.enumerationComplete, true);
      assert.equal(value.sourceProtocol, 'modern'); assert.equal(value.sourceProjection, 'bundles-v1'); assert.equal(value.parentIndexComplete, true);
      assert(/^[a-f0-9]{64}$/.test(value.accountKey)); assert.equal(value.bundles.length, count); return value;
    }
    function warning(frame) {
      assert.equal(frame.kind, 'syncWarning'); assert(!Object.hasOwn(frame, 'ok'));
      assert(Object.keys(frame).every(name => ['kind', 'reason', 'phase', 'httpStatus', 'protocolCode', 'detailComponentsCount', 'completedDetails', 'totalDetails'].includes(name)));
      assert(['detailPage', 'detailSchema', 'keySchema'].includes(frame.phase)); assert(['protocol', 'network', 'service', 'rateLimited'].includes(frame.reason));
      assert(!JSON.stringify(frame).includes('SYNTHETIC')); assert(!JSON.stringify(frame).includes('https://'));
      for (const name of ['detailComponentsCount', 'completedDetails', 'totalDetails']) if (Object.hasOwn(frame, name)) assert(Number.isInteger(frame[name]) && frame[name] >= 0 && frame[name] <= 10000);
    }
    function partial(result, protocolCode, reason = 'protocol') {
      const value = complete(result); const failed = value.bundles.filter(bundle => bundle.detailsFailed);
      assert.equal(failed.length, 1); assert.equal(failed[0].id, 'bundle-bundle-b'); assert.deepEqual(failed[0].items, []);
      assert.equal(failed[0].sourceUrl, 'https://www.humblebundle.com/home/library/bundle-b');
      assert.deepEqual(codes(value), [retainedCode, 'SYNTHETIC-GOG-CODE-A'].sort());
      const warnings = result.sent.filter(frame => frame.kind === 'syncWarning'); assert.equal(warnings.length, 1); warning(warnings[0]);
      assert.equal(warnings[0].reason, reason); if (protocolCode) assert.equal(warnings[0].protocolCode, protocolCode); return warnings[0];
    }
    function fatal(result, reason) { clean(result); assert.equal(final(result)?.ok, false); assert.equal(final(result).reason, reason); assert(!result.sent.some(frame => Object.hasOwn(frame, 'bundles'))); }
    const check = async (name, task) => { await task(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };

    await check('Authorization remains a boolean session proof and does not read bundle keys', async () => {
      const result = await run({ authOnly: true }); clean(result); assert.deepEqual(result.sent, [{ kind: 'result', ok: true, authenticated: true }]);
      assert.deepEqual(result.requests.map(request => request.route), ['/api/auth/session-status']);
    });
    await check('Two authoritative parents produce two tiles with every mixed-platform child key and download inside', async () => {
      const result = await run(), value = complete(result);
      assert.deepEqual(value.bundles.map(bundle => bundle.id), ['bundle-bundle-a', 'bundle-bundle-b']);
      assert.deepEqual(value.bundles.map(bundle => bundle.items.length), [5, 4]);
      assert.deepEqual(codes(value), [retainedCode, 'SYNTHETIC-GOG-CODE-A', 'SYNTHETIC-STEAM-CODE-B', 'SYNTHETIC-FAB-CODE-B'].sort());
      assert.deepEqual(result.requests.map(request => request.route), ['/home/library', '/home/library/bundle-a', '/home/library/bundle-b', '/home/library']);
      assert.equal(value.bundles[0].title, parents[0].title); assert.equal(value.bundles[1].title, parents[1].title);
      assert.deepEqual(result.sent.filter(frame => frame.kind === 'progress'), [0, 1, 2].map(completed => ({ kind: 'progress', completed, total: 2, stage: 'keys' })));
      const items = value.bundles.flatMap(bundle => bundle.items); assert(items.some(item => item.platform === 'Fab')); assert(items.some(item => item.platform === 'GOG'));
      assert.equal(items.find(item => item.id === 'alpha-fab-hidden').status, 'hidden'); assert.equal(items.find(item => item.id === 'alpha-book').status, 'external');
      assert.equal(items.find(item => item.id === 'beta-choice').status, 'external'); assert.equal(items.find(item => item.id === 'beta-choice').platform, 'synthetic_other_platform');
      for (const bundle of value.bundles) for (const item of bundle.items) if (item.id !== 'alpha-url') assert.equal(item.redeemUrl, bundle.sourceUrl);
    });
    await check('Flat product and Vault canaries never create tiles or trigger action discovery and pagination', async () => {
      const result = await run({ noScript: true }), value = complete(result);
      assert(!JSON.stringify(value).includes('SYNTHETIC_FLAT_PRODUCT')); assert(!JSON.stringify(value).includes('SYNTHETIC_VAULT'));
      assert(!result.requests.some(request => request.route.includes('_next/') || request.route.includes('?')));
    });
    await check('An empty bundle index stays empty even when flat purchases and unrelated Vault downloads exist', async () => {
      const result = await run({ empty: true }); complete(result, 0); assert.deepEqual(result.requests.map(request => request.route), ['/home/library', '/home/library']);
      assert.deepEqual(result.sent.filter(frame => frame.kind === 'progress'), [{ kind: 'progress', completed: 0, total: 0, stage: 'keys' }]);
    });
    await check('Canonical parent aliases deduplicate one detail read while purchase dates stay authoritative', async () => {
      const result = await run({ aliases: true }), value = complete(result);
      assert.equal(result.requests.filter(request => request.route === '/home/library/bundle-a').length, 1);
      assert.equal(value.bundles[0].purchasedAt, '2026-11-09T00:00:00.000Z'); assert.equal(value.bundles[1].purchasedAt, '2026-11-08T00:00:00.000Z');
    });
    await check('Only an actual root purchase may create a standalone container with all its platform entitlements', async () => {
      const result = await run({ standalone: true }), value = complete(result, 3); const item = value.bundles.find(bundle => bundle.id === 'bundle-standalone-purchase');
      assert(item); assert.equal(item.items.length, 2); assert.deepEqual(item.items.map(key => key.platform), ['Steam', 'GOG']);
      assert(result.requests.some(request => request.route === '/home/library/standalone-purchase')); assert(!result.requests.some(request => request.route.includes('/content/')));
    });
    await check('The same product or entitlement ID in separate purchased parents is never globally deduplicated', async () => {
      const value = complete(await run()); const shared = value.bundles.map(bundle => bundle.items.find(item => item.id === 'shared-license'));
      assert.deepEqual(shared.map(item => item.key), [retainedCode, 'SYNTHETIC-STEAM-CODE-B']);
    });
    await check('Opaque child IDs and download context cannot hide valid bundle entitlements', async () => {
      const value = complete(await run({ variant: 'opaque' })); assert.equal(value.bundles[1].items.length, 4); assert.equal(codes(value).length, 4);
    });
    await check('Legitimate empty child components remain a visible empty purchased parent', async () => {
      const value = complete(await run({ variant: 'empty' })); assert.deepEqual(value.bundles[1].items, []); assert(!value.bundles[1].detailsFailed);
    });
    await check('Repeated child components and alternate labels retain each actual entitlement once', async () => {
      for (const variant of ['duplicate', 'presentation']) { const result = await run({ variant }), value = complete(result); assert.equal(value.bundles[1].items.length, 4); assert.equal(codes(value).length, 4); assert(!result.sent.some(frame => frame.kind === 'syncWarning')); }
    });
    await check('Conflicting actual licenses or integrations flag their parent without losing the other bundle', async () => {
      for (const variant of ['conflict', 'integrationConflict']) partial(await run({ variant }), 'detailIdentity');
    });
    await check('Malformed consumed key fields and async components cannot turn products into fallback tiles', async () => {
      for (const variant of ['malformedKey', 'malformedAsync']) partial(await run({ variant }), 'detailEntry');
      const missing = partial(await run({ variant: 'missing' }), 'detailComponents'); assert.equal(missing.detailComponentsCount, 0); assert.equal(missing.totalDetails, 2);
    });
    await check('A missing bundle page remains a flagged parent beside all healthy bundle keys', async () => {
      const result = await run({ detailStatus: 404, persistentStatus: true }), frame = partial(result, undefined, 'service');
      assert.equal(frame.httpStatus, 404); assert.equal(result.requests.filter(request => request.route === '/home/library/bundle-b').length, 1);
    });
    await check('Transient network or server detail failures retry only the affected parent', async () => {
      for (const config of [{ networkFailure: 'transient' }, { detailStatus: 503 }]) { const result = await run(config), value = complete(result);
        assert.equal(codes(value).length, 4); assert.equal(result.requests.filter(request => request.route === '/home/library/bundle-a').length, 1);
        assert.equal(result.requests.filter(request => request.route === '/home/library/bundle-b').length, 2); assert(!result.sent.some(frame => frame.kind === 'syncWarning')); }
    });
    await check('Exhausted network and rate limits preserve both parent tiles with a closed partial warning', async () => {
      for (const config of [{ networkFailure: 'persistent' }, { detailStatus: 429, persistentStatus: true }]) {
        const result = await run(config); const frame = partial(result, undefined, config.networkFailure ? 'network' : 'rateLimited');
        assert.equal(result.requests.filter(request => request.route === '/home/library/bundle-b').length, 4); if (config.detailStatus) assert.equal(frame.httpStatus, 429);
      }
    });
    await check('Root, detail and final account identity failures abort before any bundle snapshot crosses accounts', async () => {
      for (const config of [{ anonymousRoot: true }, { missingIdentity: true }, { variant: 'anonymous' }, { variant: 'otherAccount' }, { finalMismatch: true }]) fatal(await run(config), 'auth');
      const first = complete(await run({ empty: true }), 0), second = complete(await run({ empty: true }), 0); assert.equal(first.accountKey, second.accountKey);
    });
    await check('Canonical redirect and login status failures cannot be accepted as bundle pages', async () => {
      for (const config of [{ rootRedirect: 'https://auth.humblebundle.com/login' }, { rootStatus: 401 }, { wrongDetailUrl: true }]) fatal(await run(config), 'auth');
    });
    await check('Malformed authoritative parent collections abort instead of fabricating children or an empty success', async () => {
      for (const badRoot of ['bundleContainer', 'bundleEntry']) { const result = await run({ badRoot }); fatal(result, 'protocol'); assert.equal(result.requests.length, 1); }
    });
    await check('Cancelling root or bundle reads yields no partial success or background purchase enumeration', async () => {
      for (const config of [{ cancelRoot: true }, { cancelDetail: true }]) fatal(await run(config), 'cancelled');
    });
    assert.deepEqual(network, []); report.passed = report.checks.length; fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'modern-sync-report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS ${report.passed} authoritative bundle integration scenarios`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
