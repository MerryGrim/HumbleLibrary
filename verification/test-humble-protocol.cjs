const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot } = require('./test-env.cjs');

// All HTTP, IPC and DOM surfaces below are synthetic. The actual production
// adapter is executed verbatim; no real account, cookies or network are used.
const sourcePath = path.join(sourceRoot, 'src-tauri/src/humble_bridge.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const cases = [];
const response = (data, extra = {}) => ({ status: 200, ok: true, redirected: false, json: async () => data, ...extra });
const clone = value => JSON.parse(JSON.stringify(value));
const nonce = '0123456789abcdef0123456789abcdef';
function environment(fetcher, origin = 'https://www.humblebundle.com', topLevel = true) {
  const sent = [];
  const window = {
    fetch: fetcher,
    __TAURI_INTERNALS__: { invoke: async (name, args) => {
      assert.equal(name, 'humble_bridge_result');
      assert.equal(args.nonce, nonce);
      sent.push(clone(args.payload));
    } },
  };
  window.top = topLevel ? window : {};
  const context = {
    window, location: { origin }, URL, URLSearchParams, TextEncoder, AbortController,
    document: { cookie: 'csrf_cookie=SYNTHETIC-CSRF-ONLY' },
    DOMParser: class {
      parseFromString(value) {
        return { body: { textContent: value.replace(/<[^>]+>/g, '') }, querySelectorAll: () => [] };
      }
    },
    setTimeout: action => setTimeout(action, 0), Map, Set, Date,
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return { window, sent, request: args => window.__humbleLibraryRequest({ nonce, ...args }) };
}
const order = () => ({
  product: { human_name: 'Synthetic mixed-platform bundle' }, created: '2026-10-25',
  tpkd_dict: { all_tpks: [
    { machine_name: 'game', human_name: 'Synthetic Game', keyindex: 0, key_type: 'steam' },
    { machine_name: 'license', human_name: 'Synthetic License', keyindex: 1, key_type: 'custom_vendor', redeemed_key_val: { license: 'SYNTHETIC-ONLY', account: 'fixture' } },
    { machine_name: 'expired', human_name: 'Synthetic Old Game', keyindex: 2, key_type: 'gog', is_expired: true },
    { machine_name: 'direct', human_name: 'Synthetic Direct License', keyindex: 3, key_type: 'unity', direct_redeem: true },
  ] },
});
async function check(name, action) {
  await action();
  cases.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
async function main() {
  await check('Authenticated session metadata arrives before slow order details or covers complete', async () => {
    let releaseDetail, markStarted;
    const detail = new Promise(resolve => { releaseDetail = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    const env = environment(async url => {
      if (url === '/api/v1/user/order') return response([{ gamekey: 'bundle_A' }]);
      markStarted(); return detail;
    });
    const running = env.request({ operation: 'sync' });
    await started;
    assert.deepEqual(env.sent, [{ kind: 'session', authenticated: true }]);
    releaseDetail(response(order())); await running;
    assert.equal(env.sent.at(-1).ok, true);
    assert.equal(env.sent.filter(payload => payload.kind === 'session').length, 1);
  });
  await check('Empty authenticated libraries report session proof without account or purchase data', async () => {
    const calls=[]; const env=environment(async url => { calls.push(url); return response([]); });
    await env.request({operation:'sync'});
    assert.deepEqual(calls,['/api/v1/user/order']); assert.deepEqual(env.sent[0],{kind:'session',authenticated:true});
    assert.equal(env.sent.at(-1).ok,true); assert.deepEqual(env.sent.at(-1).bundles,[]);
  });
  await check('Rejected or malformed order lists never publish an authenticated session', async () => {
    for (const value of [null,{},['bundle_A',null],[{gamekey:'bundle_A'},{other:'invalid'}],['../unsafe'],Array(10001).fill('bundle_A')]) {
      const env=environment(async()=>response(value)); await env.request({operation:'sync'});
      assert.equal(env.sent.some(payload=>payload.kind==='session'),false); assert.equal(env.sent.at(-1).reason,'protocol');
    }
    for (const status of [401,403]) {
      const env=environment(async()=>response(null,{status,ok:false})); await env.request({operation:'sync'});
      assert.equal(env.sent.some(payload=>payload.kind==='session'),false); assert.equal(env.sent.at(-1).reason,'auth');
    }
  });
  await check('A later authoritative authentication failure follows early proof with a closed refusal', async () => {
    const env=environment(async url=>url==='/api/v1/user/order'?response(['bundle_A']):response(null,{status:401,ok:false}));
    await env.request({operation:'sync'});
    assert.deepEqual(env.sent,[{kind:'session',authenticated:true},{kind:'result',ok:false,reason:'auth'}]);
  });
  await check('Adapter attaches only to exact storefront HTTPS origins and top-level frames', async () => {
    for (const [origin, top] of [
      ['https://www.humblebundle.com.evil.test', true], ['http://www.humblebundle.com', true],
      ['https://auth.humblebundle.com', true], ['http://humblebundle.com', true],
      ['https://www.humblebundle.com:444', true], ['https://humblebundle.com:444', true],
      ['https://www.humblebundle.com', false], ['https://humblebundle.com', false],
    ]) {
      const env = environment(async () => { throw new Error('Unexpected HTTP'); }, origin, top);
      assert.equal(env.window.__humbleLibraryRequest, undefined);
    }
  });
  await check('Both canonical storefront origins synchronize the same validated bundle format', async () => {
    for (const origin of ['https://www.humblebundle.com', 'https://humblebundle.com']) {
      const calls = [];
      const env = environment(async url => { calls.push(url); return url === '/api/v1/user/order' ? response(['bundle_A']) : response(order()); }, origin);
      await env.request({ operation: 'sync' });
      assert.deepEqual(calls, ['/api/v1/user/order', '/api/v1/order/bundle_A?all_tpkds=true']);
      assert.equal(env.sent.at(-1).ok, true);
      assert.equal(env.sent.at(-1).bundles[0].id, 'bundle_A');
      assert.deepEqual(env.sent[0], { kind: 'session', authenticated: true });
    }
  });
  await check('Sync preserves mixed purchases, source states and an empty image without a fake homepage', async () => {
    const env = environment(async url => url === '/api/v1/user/order' ? response([{ gamekey: 'bundle_A' }, 'bundle_B']) : response(url.includes('bundle_B') ? { product: { human_name: 'Purchase without keys' } } : order()));
    await env.request({ operation: 'sync' });
    const result = env.sent.at(-1);
    assert.equal(result.ok, true);
    assert.equal(result.bundles.length, 2);
    assert.equal(result.bundles[0].imageUrl, '');
    assert.equal(result.bundles[0].items[0].redeemUrl, null);
    assert.deepEqual(result.bundles[0].items.map(item => item.status), ['hidden', 'revealed', 'unavailable', 'external']);
    assert.equal(result.bundles[1].items.length, 0);
    assert(env.sent.some(item => item.kind === 'progress' && item.completed === 2 && item.total === 2));
  });
  await check('Unknown vendor names and non-Steam platforms remain visible', async () => {
    const value = order();
    value.tpkd_dict.all_tpks = ['steam', 'gog', 'fab', 'unity', 'publisher_xyz'].map((key_type, keyindex) => ({ machine_name: `item${keyindex}`, human_name: `Item ${keyindex}`, keyindex, key_type }));
    const env = environment(async url => response(url === '/api/v1/user/order' ? ['bundle_A'] : value));
    await env.request({ operation: 'sync' });
    assert.deepEqual(env.sent.at(-1).bundles[0].items.map(item => item.platform), ['Steam', 'GOG', 'Fab', 'Unity Asset Store', 'publisher_xyz']);
  });
  await check('Structured source key records retain their exact compact JSON content', async () => {
    const env = environment(async url => response(url === '/api/v1/user/order' ? ['bundle_A'] : order()));
    await env.request({ operation: 'sync' });
    assert.equal(env.sent.at(-1).bundles[0].items[1].key, '{"license":"SYNTHETIC-ONLY","account":"fixture"}');
  });
  await check('Canonical numeric-string key indices are accepted without changing identity', async () => {
    const value = order(); value.tpkd_dict.all_tpks[0].keyindex = '0';
    let posts = 0;
    const env = environment(async (_, options) => {
      if (options.method === 'POST') {
        posts += 1; const body = new URLSearchParams(options.body);
        assert.equal(body.get('keyindex'), '0'); assert.equal(body.get('keytype'), 'game'); assert.equal(body.get('key'), 'bundle_A');
        assert.equal(options.headers['CSRF-Prevention-Token'], 'SYNTHETIC-CSRF-ONLY');
        assert.equal(options.headers.Accept, 'application/json');
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
        assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
        return response({ success: true, key: 'SYNTHETIC-KEY' });
      }
      return response(clone(value));
    });
    await env.request({ operation: 'reveal', bundleId: 'bundle_A', itemId: 'game:0:steam' });
    assert.equal(posts, 1); assert.equal(env.sent.at(-1).item.id, 'game:0:steam');
  });
  await check('Reveal preserves source case, Unicode and whitespace exactly', async () => {
    const key = '  MiXeD-ключ-Fixture\t\n'; let posts = 0;
    const env = environment(async (_, options) => options.method === 'POST' ? (posts++, response({ success: true, key })) : response(order()));
    await env.request({ operation: 'reveal', bundleId: 'bundle_A', itemId: 'game:0:steam' });
    assert.equal(posts, 1); assert.equal(env.sent.at(-1).item.key, key);
  });
  await check('A key already present in the authoritative order is returned without a mutation', async () => {
    let posts = 0; const env = environment(async (_, options) => { if (options.method === 'POST') posts++; return response(order()); });
    await env.request({ operation: 'reveal', bundleId: 'bundle_A', itemId: 'license:1:custom_vendor' });
    assert.equal(posts, 0); assert.equal(env.sent.at(-1).item.status, 'revealed');
  });
  await check('An authoritative expired or sold-out preflight returns unavailable without a mutation', async () => {
    let posts = 0; const env = environment(async (_, options) => { if (options.method === 'POST') posts++; return response(order()); });
    await env.request({ operation: 'reveal', bundleId: 'bundle_A', itemId: 'expired:2:gog' });
    assert.equal(posts, 0); assert.equal(env.sent.at(-1).item.status, 'unavailable');
  });
  await check('Direct vendor activation does not generate an invented code or reveal POST', async () => {
    let posts = 0; const env = environment(async (_, options) => { if (options.method === 'POST') posts++; return response(order()); });
    await env.request({ operation: 'reveal', bundleId: 'bundle_A', itemId: 'direct:3:unity' });
    assert.equal(posts, 0); assert.equal(env.sent.at(-1).reason, 'external');
  });
  await check('A refused POST is resolved by a read and typed stock status without retrying the mutation', async () => {
    let gets = 0, posts = 0;
    const env = environment(async (_, options) => {
      if (options.method === 'POST') { posts++; return response({ success: false, redeem_retryable: false, error_msg: 'PRIVATE-SERVER-MESSAGE' }); }
      gets++; const value = order(); if (gets > 1) value.tpkd_dict.all_tpks[0].sold_out = true; return response(value);
    });
    await env.request({ operation: 'reveal', bundleId: 'bundle_A', itemId: 'game:0:steam' });
    assert.equal(posts, 1); assert.equal(gets, 2); assert.equal(env.sent.at(-1).item.status, 'unavailable');
    assert.equal(JSON.stringify(env.sent).includes('PRIVATE-SERVER-MESSAGE'), false);
  });
  await check('A failed transport never retries a reveal or leaks a server exception to IPC', async () => {
    let posts = 0;
    const env = environment(async (_, options) => { if (options.method === 'POST') { posts++; throw new Error('PRIVATE-RAW-RESPONSE'); } return response(order()); });
    await env.request({ operation: 'reveal', bundleId: 'bundle_A', itemId: 'game:0:steam' });
    assert.equal(posts, 1); assert.equal(env.sent.at(-1).reason, 'network'); assert.equal(JSON.stringify(env.sent).includes('PRIVATE-RAW-RESPONSE'), false);
  });
  await check('Authentication and throttling responses return closed reason categories', async () => {
    for (const [status, reason] of [[401, 'auth'], [403, 'auth'], [429, 'rateLimited']]) {
      const env = environment(async () => response(null, { status, ok: false }));
      await env.request({ operation: 'sync' }); assert.equal(env.sent.at(-1).reason, reason);
    }
  });
  await check('Unsupported key controls and oversize values are rejected without silent modification', async () => {
    for (const key of ['x'.repeat(262145), 'SYNTHETIC\0CONTROL', 'SYNTHETIC\u0001CONTROL']) {
      const value = order(); value.tpkd_dict.all_tpks[0].redeemed_key_val = key;
      const env = environment(async url => response(url === '/api/v1/user/order' ? ['bundle_A'] : value));
      await env.request({ operation: 'sync' }); assert.equal(env.sent.at(-1).reason, 'protocol');
    }
  });
  const report = {
    passed: cases.length, failed: 0, cases,
    sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    scope: 'Synthetic protocol fixtures only; no real account, network, cookies, keys or reveal. Native nonce/window validation is covered by Rust tests. DOMParser is a minimal text fixture.',
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  const reportPath = path.join(outputRoot, 'humble-protocol-tests.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS ${cases.length} Humble protocol checks; report ${reportPath}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
