const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot } = require('./test-env.cjs');

const sourcePath = path.join(sourceRoot, 'src-tauri/src/humble_flight.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const window = {};
const logs = [];
vm.runInNewContext(source, { window, TextDecoder, TextEncoder, Uint8Array, Map, Set, Object, Number, JSON, Error, console: { log: (...args) => logs.push(args) } }, { filename: sourcePath });
const { decode, read } = window.__humbleLibraryFlight;
const json = (id, value) => `${id}:${JSON.stringify(value)}\n`;
const action = value => json('0', { a: value, b: 'SYNTHETIC_BUILD' });
const equivalent = value => JSON.parse(JSON.stringify(value));
const rejectsProtocol = value => assert.throws(() => decode(value), error => error.message === 'protocol');
const report = { fixtureOnly: true, sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), checks: [] };
async function check(name, run) { await run(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }

(async () => {
  await check('A Next action envelope returns only its data result, including empty collections', () => {
    for (const value of [[], {}, null, true, false, 0, 'SYNTHETIC', { list: [{ id: 'SYNTHETIC_ORDER', total: 2, active: true, optional: null }] }]) assert.deepEqual(equivalent(decode(action(value))), value);
    assert(Object.isFrozen(window.__humbleLibraryFlight));
  });
  await check('Promise and outlined references resolve forward, backward and through own object/array paths', () => {
    const input = json('2', { entries: [{ id: 'SYNTHETIC_ORDER' }], count: 1 }) + action('$@1') + json('1', { entries: '$2:entries', id: '$2:entries:0:id', count: '$2:count' });
    assert.deepEqual(equivalent(decode(input)), { entries: [{ id: 'SYNTHETIC_ORDER' }], id: 'SYNTHETIC_ORDER', count: 1 });
    assert.deepEqual(equivalent(decode(action('$@a') + json('a', ['SYNTHETIC_ORDER']))), ['SYNTHETIC_ORDER']);
  });
  await check('Escaped dollar strings remain literal rather than becoming references or special types', () => {
    assert.deepEqual(equivalent(decode(action(['$$@1', '$$undefined', '$$$', '$$D2026-01-01', 'literal $1']))), ['$@1', '$undefined', '$$', '$D2026-01-01', 'literal $1']);
  });
  await check('Undefined fields are omitted and array slots become null without inventing data', () => {
    const result = decode(action({ missing: '$undefined', list: ['$undefined', '$-0'] }));
    assert.equal(Object.hasOwn(result, 'missing'), false); assert.equal(result.list[0], null); assert(Object.is(result.list[1], -0));
    rejectsProtocol(action('$undefined'));
  });
  await check('Length-prefixed T rows use UTF-8 bytes and may contain newlines or apparent row prefixes', () => {
    const text = 'Ж😀\n2:E{"digest":"SYNTHETIC"}\n$@not_a_reference';
    const wire = action('$@1') + `1:T${Buffer.byteLength(text).toString(16)},${text}` + json('2', 1);
    assert.equal(decode(wire), text); assert.equal(decode(new TextEncoder().encode(wire)), text);
  });
  await check('Unrelated renderer rows are not executed or resolved while the action remains data-only', () => {
    const wire = ':HL["SYNTHETIC_ASSET"]\n3:I["SYNTHETIC_MODULE",[],"default"]\n4:HL["SYNTHETIC_ASSET"]\n' + json('0', { a: '$@1', f: '$L3' }) + json('1', { value: 'SYNTHETIC_DATA' });
    assert.deepEqual(equivalent(decode(wire)), { value: 'SYNTHETIC_DATA' });
  });
  await check('ID-less resource hints before and after the action envelope stay inert without hiding invalid row types', () => {
    const before = ':HL["https://example.test/synthetic-before.css","style"]\n';
    const after = ':HC["https://example.test/synthetic-after.invalid"]\n';
    for (const wire of [before + action([]), action([]) + after, before + action('$@1') + after + json('1', { success: true })]) {
      assert.doesNotThrow(() => decode(wire));
    }
    assert.deepEqual(equivalent(decode(before + action('$@1') + after + json('1', { success: true }))), { success: true });
    for (const row of [':E{"digest":"SYNTHETIC_PRIVATE"}\n', ':I[]\n', ':N0\n', ':HL["unterminated"]']) rejectsProtocol(action([]) + row);
  });
  await check('Unrelated exact empty async iterable pairs stay inert and every populated or duplicate variant fails closed', () => {
    for (const wire of [action([]) + '2:X\n2:C\n', '2:X\n' + action([]) + '2:C\n', '2:X\n2:C\n3:X\n3:C\n' + action([])]) assert.deepEqual(equivalent(decode(wire)), []);
    assert.throws(() => decode(action('$2') + '2:X\n2:C\n'), error => error.message === 'protocol' && error.protocolCode === 'flightType');
    for (const stream of ['2:X\n', '2:C\n', '2:X[]\n2:C\n', '2:X\n2:C[]\n', '2:X\n2:{}\n2:C\n', '2:X\n2:X\n2:C\n', '2:X\n2:C\n2:C\n', '2:{}\n2:C\n', '2:X\n2:T1,x2:C\n']) rejectsProtocol(action([]) + stream);
  });
  await check('React Date tokens remain inert Dates while invalid or noncanonical dates fail closed', () => {
    for (const iso of ['2026-11-11T12:13:14.015Z', '0000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z']) {
      assert.deepEqual(equivalent(decode(action({ expiresAt: '$D' + iso }))), { expiresAt: iso });
      const date = decode(action('$@1') + json('1', '$D' + iso));
      assert.equal(Object.prototype.toString.call(date), '[object Date]'); assert.equal(date.toISOString(), iso); assert.notEqual(typeof date, 'string');
      assert.equal(decode(action('$$D' + iso)), '$D' + iso);
    }
    for (const iso of ['', '2026-01-01', '2026-01-01T00:00:00Z', '2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00.000+00:00', '2026-13-01T00:00:00.000Z', '+275761-01-01T00:00:00.000Z', 'SYNTHETIC_PRIVATE_ERROR']) rejectsProtocol(action('$D' + iso));
  });
  await check('Unused Date metadata is accepted but a Date can never become an exported formatted key', () => {
    const itemSource = fs.readFileSync(path.join(sourceRoot, 'src-tauri/src/humble_items.js'), 'utf8');
    const surface = {};
    vm.runInNewContext(itemSource, { window: surface, URL, TextEncoder, Set, Object, Number, JSON, Error });
    const item = { id: 'SYNTHETIC_ITEM', title: 'Synthetic item', metadata: { expiresAt: '$D2026-01-01T00:00:00.000Z' }, entitlements: { keys: [{ id: 'SYNTHETIC_KEY', type: 'steam', redeemable: true, redemptionData: { keyFormatted: 'SYNTHETIC-ONLY' } }], downloads: [] } };
    const good = surface.__humbleLibraryItems.normalize(decode(action(item)));
    assert.equal(good[0].key, 'SYNTHETIC-ONLY');
    item.entitlements.keys[0].redemptionData.keyFormatted = '$D2026-01-01T00:00:00.000Z';
    assert.throws(() => surface.__humbleLibraryItems.normalize(decode(action(item))), error => error.message === 'protocol');
  });
  await check('Protocol diagnostics contain only fixed closed codes without input values or raw exceptions', () => {
    const canary = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_CANARY';
    const cases = [
      ['0:{"a":' + canary + '}\n', 'flightWire'],
      ['0:{}\n', 'flightEnvelope'],
      [action([]) + `1:E{"digest":"${canary}"}\n`, 'flightServerError'],
      [action('$99'), 'flightReference'],
      [action('$Q1') + json('1', []), 'flightScalar'],
      [action('$1') + '1:I[]\n', 'flightType'],
    ];
    for (const [wire, code] of cases) {
      assert.throws(() => decode(wire), error => {
        assert.equal(error.message, 'protocol'); assert.equal(error.protocolCode, code); assert(Object.hasOwn(error, 'protocolCode'));
        assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary), false);
        return true;
      });
    }
  });
  await check('Server error rows and Next hard-navigation envelopes are rejected without exposing digests', () => {
    for (const input of [action([]) + '1:E{"digest":"NEXT_REDIRECT;SYNTHETIC_PRIVATE"}\n', action('$@1') + '1:E{"message":"SYNTHETIC_PRIVATE"}\n', json('0', { a: [], n: '/login' }), json('0', { a: [], n: '$1' }) + json('1', '/login')]) rejectsProtocol(input);
    assert.deepEqual(equivalent(decode(json('0', { a: [], n: '$undefined' }))), []);
  });
  await check('Missing, cyclic and unsafe prototype references fail closed', () => {
    for (const input of [action('$@1'), action('$1') + json('1', '$1'), action('$1') + json('1', '$2') + json('2', '$1'), action('$1:__proto__') + json('1', {}), action('$1:constructor') + json('1', {}), action('$1:missing') + json('1', {}), action('$1:toString') + json('1', {})]) rejectsProtocol(input);
    assert.equal(decode(action('$1:list:length') + json('1', { list: [] })), 0);
    rejectsProtocol('0:{"a":{"__proto__":{"polluted":true}}}\n');
    assert.equal(Object.prototype.polluted, undefined);
  });
  await check('Modules, elements, functions, binary objects and unsupported scalar types never become data', () => {
    for (const token of ['$', '$L1', '$F1', '$h1', '$Ssymbol', '$Q1', '$W1', '$B1', '$K1', '$T1', '$i1', '$n10', '$NaN', '$Infinity', '$-Infinity', '$@no', '$1:', '$UNKNOWN']) rejectsProtocol(action(token) + json('1', []));
    for (const row of ['1:I[]\n', '1:J[]\n', '1:D{}\n', '1:A1,x', '1:o1,x']) rejectsProtocol(action('$1') + row);
    rejectsProtocol('0:{"a":1e400}\n');
  });
  await check('Malformed, duplicate, truncated and invalid UTF-8 rows are rejected', () => {
    for (const input of ['', '[]', '0:{}', '0:{}\n', '0:[]\n', 'z:{}\n', ':{}\n', '20000000000000:{}\n', '0:{"a":}\n', action([]) + action([]), action('$1') + '1:T4,ab', action('$1') + '1:Tz,a', action([]) + '\n']) rejectsProtocol(input);
    const bad = new Uint8Array([...new TextEncoder().encode(action('$1') + '1:T1,'), 255]); rejectsProtocol(bad);
  });
  await check('Deep model data and deep reference chains obey the depth limit', () => {
    let nested = 1; for (let i = 0; i < 110; i++) nested = [nested]; rejectsProtocol(action(nested));
    let wire = action('$1'); for (let i = 1; i <= 101; i++) wire += json(i.toString(16), `$${(i + 1).toString(16)}`); wire += json('66', []); rejectsProtocol(wire);
    let acceptable = 1; for (let i = 0; i < 95; i++) acceptable = [acceptable]; assert(decode(action(acceptable)));
  });
  await check('Node limits cover both large JSON models and exponentially expanded reference DAGs', () => {
    rejectsProtocol(action(Array(100001).fill(1)));
    assert.equal(decode(action(Array(99990).fill(1))).length, 99990);
    let wire = action('$1'); for (let i = 1; i < 18; i++) wire += json(i.toString(16), [`$${(i + 1).toString(16)}`, `$${(i + 1).toString(16)}`]); wire += json('12', 1); rejectsProtocol(wire);
  });
  await check('Direct decoder input has a hard 16 MiB bound', () => {
    rejectsProtocol('x'.repeat(16 * 1024 * 1024 + 1)); rejectsProtocol(new Uint8Array(16 * 1024 * 1024 + 1));
  });
  await check('Streaming read preserves arbitrary network chunks and returns bounded bytes', async () => {
    const wire = action('$@1') + json('1', { value: 'Ж😀' });
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } });
    const result = await read({ body }); assert.deepEqual([...result], [...bytes]); assert.deepEqual(equivalent(decode(result)), { value: 'Ж😀' });
  });
  await check('Oversized streams cancel immediately and do not expose server errors', async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    await assert.rejects(read({ body }), error => error.message === 'protocol'); assert(cancelled);
    const broken = new ReadableStream({ start(controller) { controller.error(Error('SYNTHETIC_PRIVATE_ERROR')); } });
    await assert.rejects(read({ body: broken }), error => error.message === 'network');
    await assert.rejects(read({ body: { getReader() { throw Error('SYNTHETIC_PRIVATE_ERROR'); } } }), error => error.message === 'protocol');
  });
  await check('Abort cancels pending stream reads and preserves only the closed cancellation reason', async () => {
    const before = new AbortController(); before.abort(); await assert.rejects(read({ body: null }, before.signal), error => error.message === 'cancelled');
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const controller = new AbortController(); const pending = read({ body }, controller.signal); controller.abort();
    await assert.rejects(pending, error => error.message === 'cancelled'); assert(cancelled);
  });
  await check('The parser has no network, native IPC or executable-content surface', () => {
    assert.equal(/\beval\s*\(|\bnew\s+Function\b|\.fetch\s*\(|__TAURI_INTERNALS__|import\s*\(/.test(source), false);
    assert.equal(decode(action('console.log("SYNTHETIC")')), 'console.log("SYNTHETIC")'); assert.deepEqual(logs, []);
  });
  report.passed = report.checks.length;
  report.scope = 'Synthetic data-only React Flight action fixtures and in-memory streams. No Humble account, live website, network, credentials or keys.';
  fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'humble-flight-report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS ${report.passed} Flight parser scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
