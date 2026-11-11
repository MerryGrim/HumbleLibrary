const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot } = require('./test-env.cjs');

// Requirement-driven bundle coordinator tests: no browser, account, network,
// mutation adapter or persistent cache. Every value below is invented.
const sourcePath = path.join(sourceRoot, 'src-tauri/src/humble_sync.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const logs = [], network = [], surface = {};
vm.runInNewContext(source, { window: surface, AbortController, Error, Date, Map, Set, Promise,
  setTimeout, clearTimeout, performance: { now: () => Date.now() },
  fetch: (...args) => { network.push(args); throw Error('Forbidden network'); },
  console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(name => [name, (...args) => logs.push({ name, args })])),
}, { filename: sourcePath, timeout: 2000 });
const runEngine = surface.__humbleLibrarySync.run;
const report = { syntheticOnly: true, noBrowser: true, noAccountData: true, projection: 'bundles-v1', sourcePath,
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), checks: [] };
const failure = (reason, extra = {}) => Object.assign(Error(reason), extra);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settleWithin = async (promise, ms = 150) => {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), ms); })]); }
  finally { clearTimeout(timer); }
};
function fixture(config = {}) {
  const root = { owner: 'SYNTHETIC_OWNER', bundleItems: config.sources ?? ['a', 'b'].map(token => ({ token, read: true })) };
  const ctx = { clock: 0, calls: [], events: [], waits: [], failed: [], forbidden: [], active: 0, maxActive: 0, root };
  const record = async (kind, value, signal, task, actualRead = true) => {
    ctx.calls.push({ kind, value, time: ctx.clock, actualRead }); assert.equal(typeof signal?.aborted, 'boolean');
    ctx.active++; ctx.maxActive = Math.max(ctx.maxActive, ctx.active);
    try { return await task(); } finally { ctx.active--; }
  };
  const forbidden = name => { ctx.forbidden.push(name); throw failure('protocol', { privateBody: 'SYNTHETIC_PRIVATE_FLAT_PRODUCTS' }); };
  const adapter = {
    now: () => ctx.clock,
    wait: async (ms, signal) => { ctx.waits.push(ms); ctx.clock += ms; if (config.wait) await config.wait(ctx, ms, signal); if (signal.aborted) throw failure('cancelled'); },
    index: signal => record('index', null, signal, () => config.index ? config.index(ctx, signal) : root),
    plan: (...args) => { assert.equal(args.length, 1); assert.equal(args[0], root); return config.plan ? config.plan(ctx) : root.bundleItems; },
    detail: (value, signal) => record('detail', value.token, signal, () => config.detail ? config.detail(ctx, value, signal)
      : { id: `bundle-${value.token}`, items: [{ id: `key-${value.token}`, key: `SYNTHETIC-CODE-${value.token}` }] }, value.read !== false),
    failed: async (value, error) => { ctx.failed.push({ token: value.token, reason: error.message }); return { id: `bundle-${value.token}`, items: [], detailsFailed: true }; },
    verify: (value, signal) => record('verify', null, signal, () => { assert.equal(value, root); if (config.verify) return config.verify(ctx, signal); }),
    emit: async event => { ctx.events.push(JSON.parse(JSON.stringify(event))); if (config.emit) await config.emit(ctx, event); },
    discover: () => forbidden('discover'), page: () => forbidden('page'), signature: () => forbidden('signature'),
  };
  const options = { intervalMs: 1000, timeoutMs: 1000, maxAttempts: 4, retryDelays: [2000, 5000, 15000], maxDurationMs: 1_000_000, ...config.options };
  return { ctx, run: extra => runEngine(adapter, { ...options, ...extra }) };
}
function clean(ctx) {
  assert.deepEqual(logs, []); assert.deepEqual(network, []); assert.deepEqual(ctx.forbidden, []);
  for (const event of ctx.events) {
    assert(!JSON.stringify(event).includes('SYNTHETIC_PRIVATE'));
    if (event.kind === 'syncActivity') {
      assert(['libraryPage', 'detailPage'].includes(event.phase)); assert(['reading', 'waiting'].includes(event.state));
      assert(event.attempt >= 1 && event.attempt <= 4); assert(Number.isFinite(event.delayMs) && event.delayMs >= 0 && event.delayMs <= 60000);
    } else if (event.kind === 'syncWarning') {
      assert(Object.keys(event).every(key => ['kind', 'phase', 'reason', 'protocolCode', 'httpStatus', 'requestedPage'].includes(key)));
    } else { assert.equal(event.kind, 'progress'); assert.equal(event.stage, 'keys'); assert(event.completed >= 0 && event.completed <= event.total); }
  }
}
async function check(name, task) { await task(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }

(async () => {
  await check('Only authoritative bundle parents produce tiles and key progress', async () => {
    const env = fixture(); const result = await env.run(); clean(env.ctx);
    assert.equal(result.enumerationComplete, true); assert.deepEqual(Array.from(result.bundles, bundle => bundle.id), ['bundle-a', 'bundle-b']);
    assert.deepEqual(env.ctx.calls.map(call => call.kind), ['index', 'detail', 'detail', 'verify']);
    assert.deepEqual(env.ctx.events.filter(event => event.kind === 'progress'), [
      { kind: 'progress', completed: 0, total: 2, stage: 'keys' },
      { kind: 'progress', completed: 1, total: 2, stage: 'keys' }, { kind: 'progress', completed: 2, total: 2, stage: 'keys' },
    ]); assert.equal(env.ctx.maxActive, 1); assert(Number.isFinite(Date.parse(result.syncedAt)));
  });
  await check('An empty parent index completes without discovering or enumerating flat purchases', async () => {
    const env = fixture({ sources: [] }); const result = await env.run(); clean(env.ctx);
    assert.equal(result.enumerationComplete, true); assert.equal(result.bundles.length, 0); assert.deepEqual(env.ctx.calls.map(call => call.kind), ['index', 'verify']);
  });
  await check('Healthy details use 200ms gaps while root and final verification retain one second', async () => {
    const sources = Array.from({ length: 20 }, (_, index) => ({ token: String(index), read: true }));
    const fast = fixture({ sources }), slow = fixture({ sources, options: { detailIntervalMs: 1000 } });
    assert.deepEqual((await fast.run()).bundles, (await slow.run()).bundles); clean(fast.ctx); clean(slow.ctx);
    const reads = fast.ctx.calls.filter(call => call.kind === 'detail'), conservative = slow.ctx.calls.filter(call => call.kind === 'detail');
    assert.equal(fast.ctx.maxActive, 1); assert.equal(reads[0].time, 1000);
    assert(reads.slice(1).every((call, index) => call.time - reads[index].time === 200));
    assert.equal(conservative.at(-1).time - conservative[0].time, 5 * (reads.at(-1).time - reads[0].time));
    assert(fast.ctx.calls.at(-1).time - reads.at(-1).time >= 1000);
  });
  await check('Adaptive detail pacing caps at five seconds while backoff and Retry-After retain precedence', async () => {
    const attempts = new Map(); const env = fixture({ sources: ['first', 'second', 'third'].map(token => ({ token })), detail: (ctx, value) => {
      const attempt = (attempts.get(value.token) || 0) + 1; attempts.set(value.token, attempt);
      if (value.token === 'first' && attempt <= 3) throw failure(attempt === 2 ? 'network' : 'service', { retryable: true, ...(attempt === 1 ? { retryAfterMs: 7000 } : {}) });
      if (value.token === 'second' && attempt === 1) throw failure('network', { retryable: true }); return { id: value.token, items: [] };
    } }); assert.equal((await env.run()).bundles.length, 3); clean(env.ctx);
    const reads = env.ctx.calls.filter(call => call.kind === 'detail');
    assert.deepEqual(reads.slice(1).map((call, index) => call.time - reads[index].time), [7000, 5000, 15000, 4000, 5000, 5000]);
    assert.deepEqual(env.ctx.events.filter(event => event.kind === 'syncActivity' && event.state === 'waiting').map(event => event.delayMs), [7000, 5000, 15000, 5000]);
  });
  await check('Each five healthy real detail reads recover the interval toward its 200ms floor', async () => {
    let attempts = 0; const env = fixture({ sources: ['flaky', ...Array.from({ length: 15 }, (_, index) => `healthy-${index}`)].map(token => ({ token })), options: { retryDelays: [0, 0, 0] }, detail: (ctx, value) => {
      if (value.token === 'flaky' && ++attempts === 1) throw failure('network', { retryable: true }); return { id: value.token, items: [] };
    } }); await env.run(); clean(env.ctx); const reads = env.ctx.calls.filter(call => call.kind === 'detail').slice(1);
    assert.deepEqual(reads.slice(1).map((call, index) => call.time - reads[index].time), [...Array(4).fill(1000), ...Array(5).fill(500), ...Array(5).fill(250), 200]);
  });
  await check('A failed parent detail remains one flagged tile beside the complete healthy parent', async () => {
    const env = fixture({ detail: (ctx, value) => { if (value.token === 'b') throw failure('protocol'); return { id: 'bundle-a', items: [{ key: 'SYNTHETIC-A' }, { key: 'SYNTHETIC-B' }] }; } });
    const result = await env.run(); clean(env.ctx); assert.equal(result.enumerationComplete, true); assert.equal(result.bundles.length, 2);
    assert.equal(result.bundles[0].items.length, 2); assert.equal(result.bundles[1].detailsFailed, true); assert.equal(env.ctx.failed.length, 1);
  });
  await check('Metadata projections neither increment nor reset recovery batches or the transient failure circuit', async () => {
    let attempts = 0; const sources = [{ token: 'flaky' }, ...Array.from({ length: 6 }, (_, index) => ({ token: `meta-${index}`, read: false })),
      { token: 'healthy-1' }, { token: 'healthy-2' }, { token: 'meta-between', read: false }, ...Array.from({ length: 3 }, (_, index) => ({ token: `healthy-${index + 3}` }))];
    const env = fixture({ sources, options: { retryDelays: [0, 0, 0] }, detail: (ctx, value) => {
      if (value.token === 'flaky' && ++attempts === 1) throw failure('network', { retryable: true }); return { id: value.token, items: [] };
    } }); await env.run(); clean(env.ctx); const reads = env.ctx.calls.filter(call => call.kind === 'detail' && call.actualRead).slice(1);
    assert.deepEqual(reads.slice(1).map((call, index) => call.time - reads[index].time), [1000, 1000, 1000, 1000, 500]);
    const circuit = fixture({ sources: [{ token: 'a' }, { token: 'meta-a', read: false }, { token: 'b' }, { token: 'meta-b', read: false }, { token: 'c' }, { token: 'd' }],
      options: { maxAttempts: 1, retryDelays: [] }, detail: (ctx, value) => { if (value.read !== false) throw failure('network', { retryable: true }); return { id: value.token, items: [] }; } });
    assert.equal((await circuit.run()).bundles.length, 6); clean(circuit.ctx); assert.equal(circuit.ctx.calls.filter(call => call.kind === 'detail' && call.actualRead).length, 3);
  });
  await check('Unreadable or unauthenticated parent indexes cannot produce snapshots', async () => {
    for (const reason of ['auth', 'network', 'protocol']) {
      const env = fixture({ index: () => { throw failure(reason, { retryable: reason === 'network' }); } });
      await assert.rejects(env.run(), error => error.message === reason); clean(env.ctx);
      assert(!env.ctx.calls.some(call => call.kind !== 'index')); assert.equal(env.ctx.calls.length, reason === 'network' ? 4 : 1);
    }
  });
  await check('Only reliable failures retry and private backend bodies never enter progress', async () => {
    let attempt = 0; const env = fixture({ detail: (ctx, value) => {
      if (value.token === 'a' && ++attempt === 1) throw failure('service', { retryable: true, retryAfterMs: 8000, privateBody: 'SYNTHETIC_PRIVATE_BODY' }); return { id: value.token, items: [] };
    } }); await env.run(); clean(env.ctx); assert.equal(attempt, 2); assert(env.ctx.events.some(event => event.state === 'waiting' && event.delayMs >= 8000));
    const noRetry = fixture({ detail: () => { throw failure('service'); } }); await noRetry.run(); clean(noRetry.ctx); assert.equal(noRetry.ctx.calls.filter(call => call.kind === 'detail').length, 2);
  });
  await check('Cancellation before start and during backoff prevents further bundle reads or verification', async () => {
    const already = new AbortController(); already.abort(); const empty = fixture();
    await assert.rejects(empty.run({ signal: already.signal }), error => error.message === 'cancelled'); assert.equal(empty.ctx.calls.length, 0);
    const controller = new AbortController(); const env = fixture({ detail: () => { throw failure('network', { retryable: true }); }, wait: (ctx, ms) => { if (ms >= 2000) controller.abort(); } });
    await assert.rejects(env.run({ signal: controller.signal }), error => error.message === 'cancelled'); clean(env.ctx);
    assert.equal(env.ctx.calls.filter(call => call.kind === 'detail').length, 1); assert(!env.ctx.calls.some(call => call.kind === 'verify'));
  });
  await check('A cancelled uncooperative detail cannot block a fresh run or publish late progress', async () => {
    const controller = new AbortController(), started = deferred(), late = deferred(); const env = fixture({ detail: () => { started.resolve(); return late.promise; } });
    const old = env.run({ signal: controller.signal }).then(value => ({ value }), error => ({ error })); await started.promise; controller.abort();
    const early = await settleWithin(old); if (early.stalled) { late.resolve({ id: 'old', items: [] }); await old; assert.fail('Cancelled read blocked'); }
    assert.equal(early.error?.message, 'cancelled'); const eventCount = env.ctx.events.length; const fresh = fixture(); assert.equal((await fresh.run()).bundles.length, 2);
    late.resolve({ id: 'old', items: [] }); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(env.ctx.events.length, eventCount); clean(env.ctx); clean(fresh.ctx);
  });
  await check('Timeout settles an uncooperative detail and retries only that parent', async () => {
    let calls = 0; const env = fixture({ options: { timeoutMs: 15, maxAttempts: 2, retryDelays: [1] }, detail: (ctx, value) => {
      if (value.token === 'a' && ++calls === 1) return new Promise(() => {}); return { id: value.token, items: [] };
    } }); const result = await settleWithin(env.run().then(value => ({ value })), 250); assert(!result.stalled); assert.equal(result.value.bundles.length, 2);
    assert.equal(calls, 2); assert.equal(env.ctx.calls.filter(call => call.kind === 'index').length, 1); clean(env.ctx);
  });
  await check('Account changes during details or final verification are fatal before snapshot return', async () => {
    for (const stage of ['detail', 'verify']) { const env = fixture({ [stage]: () => { throw failure('auth', { retryable: true }); } });
      await assert.rejects(env.run(), error => error.message === 'auth'); clean(env.ctx); assert.equal(env.ctx.calls.filter(call => call.kind === stage).length, 1); }
  });
  await check('Exhausted failures open the circuit while every indexed parent remains visible', async () => {
    const env = fixture({ sources: ['a', 'b', 'c', 'd'].map(token => ({ token })), options: { maxAttempts: 2, retryDelays: [1] }, detail: () => { throw failure('network', { retryable: true }); } });
    const result = await env.run(); clean(env.ctx); assert.equal(result.bundles.length, 4); assert(result.bundles.every(bundle => bundle.detailsFailed));
    assert.equal(env.ctx.calls.filter(call => call.kind === 'detail').length, 6); assert(!env.ctx.calls.some(call => call.value === 'd'));
  });
  await check('Protocol outliers do not trip the transient circuit and healthy reads reset exhaustion', async () => {
    for (const transient of [false, true]) { const env = fixture({ sources: ['a', 'b', 'c', 'd', 'e', 'f'].map(token => ({ token })), options: { maxAttempts: 1, retryDelays: [] }, detail: (ctx, value) => {
      if (transient ? ['a', 'b', 'd', 'e'].includes(value.token) : value.token !== 'f') throw failure(transient ? 'network' : 'protocol', transient ? { retryable: true } : {}); return { id: value.token, items: [] };
    } }); assert.equal((await env.run()).bundles.length, 6); clean(env.ctx); assert.equal(env.ctx.calls.filter(call => call.kind === 'detail').length, 6); }
  });
  await check('Malformed plans and invalid limits stop without purchase enumeration or unsafe reads', async () => {
    for (const plan of [null, {}, Array.from({ length: 10001 }, () => ({ token: 'x' }))]) { const env = fixture({ plan: () => plan }); await assert.rejects(env.run(), error => error.message === 'protocol'); clean(env.ctx); assert.equal(env.ctx.calls.length, 1); }
    for (const options of [{ maxAttempts: 0 }, { maxAttempts: 5 }, { timeoutMs: 0 }, { intervalMs: -1 }, { detailIntervalMs: -1 }, { detailIntervalMs: Infinity }, { retryDelays: [Infinity, 1, 2] }]) {
      const env = fixture(); await assert.rejects(env.run(options), error => error.message === 'protocol'); assert.equal(env.ctx.calls.length, 0);
    }
  });
  report.passed = report.checks.length; fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'sync-engine-report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS ${report.passed} authoritative bundle coordinator scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
