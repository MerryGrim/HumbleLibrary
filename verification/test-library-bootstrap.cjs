const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

// The production adapter runs with the real browser DOMParser/Response streams,
// but every fetch is synthetic. The page stays about:blank; no Humble URL opens.
const sourcePath = path.join(sourceRoot, 'src-tauri/src/humble_bridge.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const nonce = '0123456789abcdef0123456789abcdef';
const bootstrap = gamekeys => `<script id="user-home-json-data" type="application/json">${JSON.stringify({ gamekeys })}</script>`;
const report = { fixtureOnly: true, sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), checks: [] };

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  const network = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => { network.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    async function run(config = {}) {
      return page.evaluate(async ({ source, nonce, config }) => {
        const sent = [], requests = [], logs = [];
        let streamCancelled = false;
        const origin = config.origin || 'https://www.humblebundle.com';
        const response = (body, status, url, redirected = false) => {
          const value = new Response(body, { status });
          Object.defineProperties(value, { url: { value: url }, redirected: { value: redirected } });
          return value;
        };
        const bridgeWindow = {
          fetch: async (path, options) => {
            requests.push({ path, method: options.method || 'GET', credentials: options.credentials, cache: options.cache, headers: options.headers, body: options.body });
            if (path === '/api/auth/session-status') return response('{}', 404, `${origin}${path}`);
            if (path === '/api/v1/user/order') {
              if (config.oldNetworkError) throw new Error('SYNTHETIC-PRIVATE-ERROR');
              return response(config.oldInvalidJson ? '{' : JSON.stringify(config.oldValue ?? []), config.oldStatus ?? 404, `${origin}${path}`);
            }
            if (path === '/home/library') {
              if (config.libraryNetworkError) throw new Error('SYNTHETIC-PRIVATE-ERROR');
              let body = config.html ?? '<script id="user-home-json-data">{"gamekeys":[]}</script>';
              if (config.oversizeStream) {
                body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { streamCancelled = true; } });
              } else if (config.splitUtf8) {
                const bytes = new TextEncoder().encode(body), middle = bytes.indexOf(0xd0) + 1;
                body = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, middle)); controller.enqueue(bytes.slice(middle)); controller.close(); } });
              }
              return response(body, config.libraryStatus ?? 200, config.finalUrl || `${origin}/home/library`, config.redirected || false);
            }
            if (/^\/api\/v1\/order\/[a-zA-Z0-9_-]+\?all_tpkds=true$/.test(path)) {
              const value = { product: { human_name: 'Synthetic purchase' }, tpkd_dict: { all_tpks: [] } };
              return response(JSON.stringify(value), 200, `${origin}${path}`);
            }
            throw new Error('Unexpected synthetic path');
          },
          __TAURI_INTERNALS__: { invoke: async (name, args) => { if (name !== 'humble_bridge_result' || args.nonce !== nonce) throw new Error('Unexpected synthetic IPC'); sent.push(JSON.parse(JSON.stringify(args.payload))); } },
        };
        bridgeWindow.top = bridgeWindow;
        const accountDocument = {};
        Object.defineProperty(accountDocument, 'cookie', { get() { throw Error('Read-only library proof cannot inspect cookies'); } });
        const fakeConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) => logs.push({ name, args })]));
        new Function('window', 'location', 'document', 'console', source)(bridgeWindow, { origin }, accountDocument, fakeConsole);
        await bridgeWindow.__humbleLibraryRequest({ nonce, operation: config.operation || 'auth' });
        return { sent, requests, logs, streamCancelled, scriptRan: window.__bootstrapScriptRan === true, state: bridgeWindow.__humbleLibraryBridgeState() };
      }, { source, nonce, config });
    }
    function readOnly(result, paths = ['/api/v1/user/order', '/home/library']) {
      assert.deepEqual(result.requests.filter(request => request.path !== '/api/auth/session-status').map(request => request.path), paths);
      for (const request of result.requests) {
        assert.equal(request.method, 'GET'); assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store'); assert.equal(request.body, undefined);
        assert.equal(request.headers.Accept, request.path === '/home/library' ? 'text/html' : 'application/json');
      }
      assert.deepEqual(result.logs, []); assert.equal(result.state, 'ready');
      assert.equal(JSON.stringify(result.sent).includes('SYNTHETIC-PRIVATE-ERROR'), false);
    }
    async function check(name, action) { await action(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    await check('HTTP404 falls back to a fresh protected library bootstrap and sends only boolean auth proof', async () => {
      const result = await run({ html: bootstrap(['SYNTHETIC_PRIVATE_ORDER_1', 'SYNTHETIC_PRIVATE_ORDER_2']) });
      assert.deepEqual(result.sent, [{ kind: 'result', ok: true, authenticated: true }]); readOnly(result);
      assert.equal(JSON.stringify(result.sent).includes('SYNTHETIC_PRIVATE_ORDER'), false);
    });
    await check('An empty bootstrap is a valid account and exact canonical store origins both work', async () => {
      for (const origin of ['https://www.humblebundle.com', 'https://humblebundle.com']) {
        const finalOrigin = origin.includes('www.') ? 'https://humblebundle.com' : 'https://www.humblebundle.com';
        const result = await run({ origin, finalUrl: `${finalOrigin}/home/library/`, redirected: true, html: bootstrap([]) });
        assert.deepEqual(result.sent, [{ kind: 'result', ok: true, authenticated: true }]); readOnly(result);
      }
    });
    await check('Existing valid list API semantics remain unchanged without a fallback request', async () => {
      for (const oldValue of [[], ['SYNTHETIC_ORDER'], [{ gamekey: 'SYNTHETIC_ORDER' }]]) {
        const result = await run({ oldStatus: 200, oldValue });
        assert.deepEqual(result.sent, [{ kind: 'result', ok: true, authenticated: true }]); readOnly(result, ['/api/v1/user/order']);
      }
    });
    await check('Only HTTP404 triggers fallback; malformed success, auth failures, rate limits and transport failures stay closed', async () => {
      for (const [config, reason] of [[{ oldStatus: 200, oldValue: {} }, 'protocol'], [{ oldStatus: 200, oldInvalidJson: true }, 'protocol'], [{ oldStatus: 401 }, 'auth'], [{ oldStatus: 403 }, 'auth'], [{ oldStatus: 429 }, 'rateLimited'], [{ oldStatus: 500 }, 'service'], [{ oldNetworkError: true }, 'network']]) {
        const result = await run(config); assert.equal(result.sent.at(-1).reason, reason); assert.equal(result.sent.at(-1).ok, false); readOnly(result, ['/api/v1/user/order']);
      }
    });
    await check('Login, auth domain, foreign, non-HTTPS, credentialed, port and UUID redirects never prove a session', async () => {
      for (const finalUrl of ['https://www.humblebundle.com/login', 'https://www.humblebundle.com/signin', 'https://auth.humblebundle.com/login', 'https://humblebundle.com.evil.invalid/home/library', 'http://www.humblebundle.com/home/library', 'https://humblebundle.com:444/home/library', 'https://user:pass@www.humblebundle.com/home/library', 'https://www.humblebundle.com/home/library/SYNTHETIC_UUID', 'https://www.humblebundle.com/home/purchases', 'not a URL']) {
        const result = await run({ finalUrl, redirected: true, html: bootstrap(['SYNTHETIC_ORDER']) });
        assert.equal(result.sent.at(-1).ok, false); assert.equal(result.sent.at(-1).authenticated, undefined); readOnly(result);
      }
    });
    await check('Final response URL is checked even when a fetch reports no redirect', async () => {
      for (const finalUrl of ['https://auth.humblebundle.com/home/library', 'https://www.humblebundle.com/', 'https://example.test/home/library']) {
        const result = await run({ finalUrl, html: bootstrap([]) });
        assert.deepEqual(result.sent, [{ kind: 'result', ok: false, reason: 'auth', httpStatus: 200 }]); readOnly(result);
      }
    });
    await check('Missing, wrong-element, duplicate and unrelated JSON blocks cannot become partial library proof', async () => {
      for (const html of ['', '<a href="/home/library/SYNTHETIC_ORDER">Purchase</a>', '<script>{"gamekeys":["SYNTHETIC_ORDER"]}</script>', '<div id="user-home-json-data">{"gamekeys":[]}</div>', bootstrap([]) + bootstrap(['SYNTHETIC_ORDER']), '<script id="user-home-json-data">{</script>']) {
        const result = await run({ html }); assert.equal(result.sent.at(-1).reason, 'protocol'); assert.equal(result.sent.at(-1).ok, false); readOnly(result);
      }
    });
    await check('Every bootstrap entry must pass the full order-ID schema; invalid entries are never skipped', async () => {
      for (const value of [null, [], 4, {}, { gamekeys: null }, { gamekeys: 'SYNTHETIC_ORDER' }, { gamekeys: ['VALID_ORDER', null] }, { gamekeys: ['VALID_ORDER', '../bad'] }, { gamekeys: Array(10001).fill('VALID_ORDER') }]) {
        const result = await run({ html: `<script id="user-home-json-data">${JSON.stringify(value)}</script>` });
        assert.equal(result.sent.at(-1).reason, 'protocol'); assert.equal(result.sent.at(-1).ok, false); readOnly(result);
      }
    });
    await check('Oversized library streams stop at the byte limit and cancel without parsing', async () => {
      const result = await run({ oversizeStream: true });
      assert.deepEqual(result.sent, [{ kind: 'result', ok: false, reason: 'protocol', httpStatus: 200 }]); assert.equal(result.streamCancelled, true); readOnly(result);
    });
    await check('UTF-8 streaming preserves a split character and downloaded markup remains inert', async () => {
      const result = await run({ splitUtf8: true, html: `<p>Ж</p>${bootstrap([])}<script>window.__bootstrapScriptRan=true</script><img src="https://example.test/synthetic-image">` });
      assert.deepEqual(result.sent, [{ kind: 'result', ok: true, authenticated: true }]); assert.equal(result.scriptRan, false); readOnly(result); assert.deepEqual(network, []);
    });
    await check('Library HTTP and transport errors report only closed reasons and normalized HTTP status', async () => {
      for (const [config, expected] of [[{ libraryStatus: 401 }, { reason: 'auth', httpStatus: 401 }], [{ libraryStatus: 403 }, { reason: 'auth', httpStatus: 403 }], [{ libraryStatus: 404 }, { reason: 'service', httpStatus: 404 }], [{ libraryStatus: 429 }, { reason: 'rateLimited', httpStatus: 429 }], [{ libraryNetworkError: true }, { reason: 'network' }]]) {
        const result = await run(config); assert.deepEqual(result.sent, [{ kind: 'result', ok: false, ...expected }]); readOnly(result);
      }
    });
    await check('Sync consumes all bootstrap IDs in order, deduplicates and preserves existing detail API', async () => {
      const result = await run({ operation: 'sync', html: bootstrap(['SYNTHETIC_B', 'SYNTHETIC_A', 'SYNTHETIC_B']) });
      assert.deepEqual(result.sent[0], { kind: 'session', authenticated: true });
      assert.equal(result.sent.at(-1).ok, true); assert.deepEqual(result.sent.at(-1).bundles.map(bundle => bundle.id), ['SYNTHETIC_B', 'SYNTHETIC_A']);
      readOnly(result, ['/api/v1/user/order', '/home/library', '/api/v1/order/SYNTHETIC_B?all_tpkds=true', '/api/v1/order/SYNTHETIC_A?all_tpkds=true']);
    });
    await check('Malformed fallback sync sends neither partial bundles nor an authenticated session', async () => {
      const result = await run({ operation: 'sync', html: bootstrap(['SYNTHETIC_ORDER', 'bad/id']) });
      assert.deepEqual(result.sent, [{ kind: 'result', ok: false, reason: 'protocol' }]); readOnly(result);
    });
    assert.deepEqual(network, []);
    report.passed = report.checks.length;
    report.scope = 'Offline synthetic HTTP/IPC only, with a real inert browser DOMParser and bounded Response streams; live Humble compatibility is not established.';
    fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'library-bootstrap-report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS ${report.passed} library bootstrap scenarios`);
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
