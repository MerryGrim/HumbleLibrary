const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

// Every identifier, account and license here is synthetic. No live page opens.
const sources = ['humble_flight.js', 'humble_page.js', 'humble_items.js', 'humble_bridge.js']
  .map(name => fs.readFileSync(path.join(sourceRoot, 'src-tauri/src', name), 'utf8'));
const nonce = '0123456789abcdef0123456789abcdef';
const detailPath = '/home/library/purchase-a';
const scriptPath = '/_next/static/chunks/synthetic-reveal.js';
const report = { fixtureOnly: true, checks: [], scope: 'Synthetic modern reveal/preflight using actual helpers on about:blank. All network blocked.' };

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  const network = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => { network.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    await page.goto('about:blank');
    const run = config => page.evaluate(async ({ sources, nonce, detailPath, scriptPath, config }) => {
      const action = config.action || '7000000000000000000000000000000000000000';
      const requests = [], sent = [], logs = [];
      const origin = 'https://www.humblebundle.com';
      const key = { id: 'key-a', title: 'Synthetic entitlement', type: 'fab', keyIntegrationId: 'generic', redeemable: true, redemptionData: {}, ...config.key };
      const source = { id: config.opaqueDetail ? 'SYNTHETIC_OPAQUE_CHILD' : 'purchase-a', title: 'Synthetic purchase', itemType: 'content-entitlement', type: 'bundle', productEntitlementId: 'SYNTHETIC_ZIP_CONTEXT', entitlements: { keys: config.missingTarget ? [] : [key], downloads: [], ...(config.choice ? { redemptionGroups: [{ maxRedemptions: 1, state: 'AVAILABLE', options: [{ entitlementId: 'key-a', eligible: true }] }] } : {}) } };
      if (config.missingId) delete source.id;
      if (config.missingTitle) delete source.title;
      if (config.emptyEntitlements) delete source.entitlements;
      if (config.malformedConsumed) source.entitlements.keys[0].redemptionData = { keyFormatted: { invalid: 'object' } };
      const parts = config.multipleParts ? [
        { userLibraryItem: { id: 'SYNTHETIC_UNRELATED_CHILD', entitlements: { keys: [{ ...key, id: 'other-key', keyIntegrationId: 'other-provider' }] } }, productEntitlementId: 'SYNTHETIC_OTHER_ZIP_CONTEXT' },
        { userLibraryItem: source, productEntitlementId: 'SYNTHETIC_UNRELATED_ZIP_CONTEXT' },
        { userLibraryItem: { ...source, id: 'SYNTHETIC_DUPLICATE_CHILD' }, productEntitlementId: null },
        { userLibraryItem: {}, productEntitlementId: null },
      ] : [{ userLibraryItem: source, productEntitlementId: 'SYNTHETIC_UNRELATED_ZIP_CONTEXT' }];
      if (config.conflictingKey || config.conflictingIntegration) parts.push({ userLibraryItem: {
        entitlements: { keys: [{ ...key, ...(config.conflictingKey ? { redemptionData: { keyFormatted: 'SYNTHETIC-CONFLICTING-CODE' } } : { keyIntegrationId: 'different-provider' }) }] },
      } });
      if (config.presentationAliases) parts.push({ userLibraryItem: { entitlements: { keys: [{
        ...key, title: 'Synthetic alternate display label', instructionsHtml: '<p>Alternate display instructions.</p>', customCtaUrl: 'https://example.test/alternate-provider-page',
      }] } } });
      const wire = '1:I["fixture",[],"AuthProvider"]\n' + `2:I["fixture",[],"ProductKeysDownloads"${config.asyncModule ? ',1' : ''}]\n`
        + `3:${JSON.stringify(['$', '$L1', null, {
          user: config.anonymous ? null : { id: 'SYNTHETIC_USER', email: 'fixture@example.test' },
          children: config.missingComponent ? [] : parts.map((props, index) => ['$', '$L2', String(index), props]),
        }])}\n`;
      const html = `<script src="${scriptPath}"></script><script>self.__next_f.push(${JSON.stringify([1, wire])})</script><script>window.__unexpectedDownloadedScript=true</script>`;
      const response = (body, type, route, status = 200, url) => {
        const result = new Response(body, { status, headers: { 'content-type': type } });
        Object.defineProperties(result, { url: { value: url || `${origin}${route}` }, redirected: { value: false } });
        return result;
      };
      const windowMock = {
        fetch: async (route, options = {}) => {
          const method = options.method || 'GET';
          requests.push({ route, method, body: options.body, headers: Object.fromEntries(new Headers(options.headers).entries()), credentials: options.credentials, cache: options.cache });
          if (route === detailPath && method === 'GET') return response(html, 'text/html', route, 200,
            config.wrongGetUrl ? `${origin}/home/library/SYNTHETIC_OTHER_ROUTE` : undefined);
          if (route === scriptPath) return response(config.missingAction ? '/* no mutation reference */' : `let fn=(0,r.createServerReference)("${action}",r.callServer,void 0,r.findSourceMapURL,"redeemEntitlementAction");`, 'application/javascript', route);
          if (route === detailPath && method === 'POST') {
            if (config.transportFailure) throw new Error('SYNTHETIC_PRIVATE_TRANSPORT_MESSAGE');
            if (config.timeout) throw new DOMException('Synthetic timeout', 'AbortError');
            if (config.cancel) { windowMock.__humbleLibraryCancel(nonce); throw new DOMException('Synthetic cancellation', 'AbortError'); }
            const value = config.result === undefined ? { success: true, key: 'SYNTHETIC-REVEALED-CODE' } : config.result;
            return response(config.malformed ? 'not-flight' : `0:${JSON.stringify({ a: value })}\n`, config.wrongContentType ? 'text/html' : 'text/x-component', route, config.postStatus || 200, config.wrongPostUrl ? `${origin}/home/library/other-purchase` : undefined);
          }
          throw new Error('Unexpected synthetic route');
        },
        __TAURI_INTERNALS__: { invoke: async (command, args) => { if (command !== 'humble_bridge_result' || args.nonce !== nonce) throw new Error('Unexpected synthetic IPC'); sent.push(JSON.parse(JSON.stringify(args.payload))); } },
      };
      windowMock.top = windowMock;
      const documentMock = {};
      Object.defineProperty(documentMock, 'cookie', { get() { throw new Error('Modern reveal must not inspect cookies'); } });
      const consoleMock = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) => logs.push({ name, args })]));
      for (const source of sources) new Function('window', 'location', 'document', 'console', source)(windowMock, { origin }, documentMock, consoleMock);
      await windowMock.__humbleLibraryRequest({ nonce, operation: 'reveal', bundleId: 'bundle-purchase-a', itemId: 'key-a' });
      return { requests, sent, logs, action, state: windowMock.__humbleLibraryBridgeState(), downloadedScriptRan: window.__unexpectedDownloadedScript === true };
    }, { sources, nonce, detailPath, scriptPath, config });
    const outcome = result => result.sent.findLast(value => value.kind === 'result');
    const posts = result => result.requests.filter(request => request.method === 'POST');
    function clean(result) {
      assert.deepEqual(result.logs, []); assert.equal(result.state, 'ready'); assert.equal(result.downloadedScriptRan, false);
      assert(!JSON.stringify(result.sent).includes('SYNTHETIC_PRIVATE_TRANSPORT_MESSAGE'));
      assert.equal(result.sent.filter(value => value.kind === 'result').length, 1);
      for (const request of result.requests) { assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store'); }
    }
    const check = async (name, action) => { await action(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };

    await check('Discovers the current mutation reference and posts exact typed arguments once', async () => {
      for (const action of ['7000000000000000000000000000000000000000', '7abcdefabcdefabcdefabcdefabcdefabcdefabcd']) {
        const result = await run({ action }); clean(result);
        assert.equal(outcome(result).ok, true); assert.equal(outcome(result).item.key, 'SYNTHETIC-REVEALED-CODE'); assert.equal(outcome(result).item.status, 'revealed');
        assert.equal(posts(result).length, 1);
        assert.deepEqual(result.requests.map(request => request.route), [detailPath, scriptPath, detailPath]);
        assert.equal(posts(result)[0].headers['next-action'], action);
        assert.equal(posts(result)[0].headers['content-type'], 'text/plain;charset=UTF-8');
        assert.deepEqual(JSON.parse(posts(result)[0].body), ['key-a', 'generic', '$undefined']);
      }
    });
    await check('Freshly revealed and unavailable entries never submit a mutation', async () => {
      for (const config of [{ key: { redemptionData: { keyFormatted: 'SYNTHETIC-EXISTING-CODE' } } }, { key: { expired: true } }, { key: { outOfStock: true } }, { key: { preOrdered: true } }]) {
        const result = await run(config); clean(result); assert.equal(outcome(result).ok, true); assert.equal(posts(result).length, 0); assert.equal(result.requests.length, 1);
      }
    });
    await check('Direct activation, keyless providers and exclusive choices remain external without POST', async () => {
      for (const config of [{ key: { directRedeem: true } }, { key: { keyIntegrationId: 'gog_keyless' } }, { key: { keyIntegrationId: 'uplay' } }, { key: { giftStatus: 'gifted' } }, { choice: true }]) {
        const result = await run(config); clean(result); assert.equal(outcome(result).ok, false); assert.equal(outcome(result).reason, 'external'); assert.equal(posts(result).length, 0);
      }
    });
    await check('Canonical authenticated details accept opaque DTO identities and unrelated ZIP contexts', async () => {
      for (const config of [{ opaqueDetail: true }, { opaqueDetail: true, missingId: true, missingTitle: true }]) {
        const result = await run(config); clean(result);
        assert.equal(outcome(result).ok, true); assert.equal(posts(result).length, 1);
        assert.deepEqual(JSON.parse(posts(result)[0].body), ['key-a', 'generic', '$undefined']);
      }
    });
    await check('Reveal finds the exact entitlement across async detail parts and deduplicates identical copies', async () => {
      const result = await run({ multipleParts: true, missingId: true, missingTitle: true, asyncModule: true }); clean(result);
      assert.equal(outcome(result).ok, true); assert.equal(outcome(result).item.id, 'key-a');
      assert.equal(outcome(result).item.key, 'SYNTHETIC-REVEALED-CODE');
      assert.equal(posts(result).length, 1); assert.deepEqual(JSON.parse(posts(result)[0].body), ['key-a', 'generic', '$undefined']);
    });
    await check('Presentation-only aliases retain one unambiguous entitlement mutation', async () => {
      const result = await run({ multipleParts: true, presentationAliases: true }); clean(result);
      assert.equal(outcome(result).ok, true); assert.equal(outcome(result).item.id, 'key-a');
      assert.equal(outcome(result).item.key, 'SYNTHETIC-REVEALED-CODE');
      assert.equal(posts(result).length, 1); assert.deepEqual(JSON.parse(posts(result)[0].body), ['key-a', 'generic', '$undefined']);
    });
    await check('Missing entitlement, integration or action prevents mutation', async () => {
      for (const config of [{ missingTarget: true }, { missingTarget: true, multipleParts: true }, { emptyEntitlements: true }, { key: { keyIntegrationId: null } }, { missingAction: true }]) {
        const result = await run(config); clean(result); assert.equal(outcome(result).ok, false); assert.equal(posts(result).length, 0);
      }
    });
    await check('Wrong detail response paths, anonymous pages and missing components prevent mutation', async () => {
      for (const config of [{ wrongGetUrl: true }, { anonymous: true }, { missingComponent: true }]) {
        const result = await run(config); clean(result); assert.equal(outcome(result).ok, false); assert.equal(posts(result).length, 0);
      }
    });
    await check('Conflicting entitlement identities and malformed consumed key data fail before mutation', async () => {
      for (const config of [{ conflictingKey: true }, { conflictingIntegration: true }, { malformedConsumed: true }]) {
        const result = await run(config); clean(result); assert.equal(outcome(result).ok, false); assert.equal(posts(result).length, 0);
        assert.equal(outcome(result).reason, 'protocol');
      }
    });
    await check('Transport loss, timeout and cancellation never replay the mutation', async () => {
      for (const config of [{ transportFailure: true }, { timeout: true }, { cancel: true }]) {
        const result = await run(config); clean(result); assert.equal(outcome(result).ok, false); assert.equal(outcome(result).reason, 'uncertain'); assert.equal(posts(result).length, 1);
      }
    });
    await check('Malformed or misplaced responses remain uncertain after exactly one POST', async () => {
      for (const config of [{ malformed: true }, { wrongContentType: true }, { wrongPostUrl: true }, { result: { success: true, key: { invalid: 'object' } } }, { result: {} }]) {
        const result = await run(config); clean(result); assert.equal(outcome(result).ok, false); assert.equal(outcome(result).reason, 'uncertain'); assert.equal(posts(result).length, 1);
      }
    });
    await check('Declared rejection and provider grant outcomes retain distinct states', async () => {
      const rejected = await run({ result: { success: false, errorKind: 'generic' } }); clean(rejected);
      assert.equal(outcome(rejected).reason, 'service'); assert.equal(posts(rejected).length, 1);
      const granted = await run({ result: { success: true, orderStatus: 'GRANT_PENDING' } }); clean(granted);
      assert.equal(outcome(granted).ok, true); assert.equal(outcome(granted).item.key, null); assert.equal(outcome(granted).item.status, 'external'); assert.equal(posts(granted).length, 1);
    });
    assert.deepEqual(network, []); report.passed = report.checks.length;
    fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'modern-reveal-report.json'), JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
