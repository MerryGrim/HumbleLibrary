const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { outputRoot, loadTypescript } = require('./test-env.cjs');
const report = { fixtureOnly: true, nativeCallsExecuted: false, checks: [] };
const status = { connected: true, authState: 'authenticated', lastSync: '2026-10-01T00:00:00Z', enumerationComplete: false, bundles: [{ id: 'SYNTHETIC_PARTIAL_BUNDLE', title: 'Synthetic partial bundle', imageUrl: '', items: [] }] };
const calls = [], listeners = new Map(); let disposed = 0;
const { api } = loadTypescript('src/api.ts', {
  '../package.json': { default: { version: '0.0.0-fixture' } },
  '@tauri-apps/api/core': { isTauri: () => true, invoke: async name => { calls.push(name); assert.equal(name, 'humble_sync'); return status; } },
  '@tauri-apps/api/event': { listen: async (name, callback) => { listeners.set(name, callback); return () => { listeners.delete(name); disposed += 1; }; } },
});
const check = name => { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
(async () => {
  const result = await api.sync();
  assert.deepEqual(result, status); assert.equal(result.enumerationComplete, false); assert.equal(Array.isArray(result), false);
  assert.deepEqual(calls, ['humble_sync']);
  check('Sync preserves the authoritative status, partial-enumeration marker and previous success timestamp');
  let received;
  const dispose = await api.onSyncActivity(value => { received = value; });
  const activity = { phase: 'purchasedPage', state: 'waiting', attempt: 2, delayMs: 1500, reason: 'service' };
  assert.equal(listeners.size, 1); listeners.get('humble-sync-activity')({ payload: activity });
  assert.deepEqual(received, activity); dispose(); assert.equal(listeners.size, 0); assert.equal(disposed, 1);
  check('Sync activity uses the dedicated native event and releases its subscription');
  fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'sync-api-report.json'), JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
