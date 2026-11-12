const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot } = require('./test-env.cjs');

// Regression for the observed native ACL denial: registering an invoke handler
// is insufficient unless AppManifest generates its command permission and the
// correct local capability grants that permission.
const nativeRoot = path.join(sourceRoot, 'src-tauri');
const inputs = {
  handlers: path.join(nativeRoot, 'src/lib.rs'),
  humble: path.join(nativeRoot, 'src/humble.rs'),
  locale: path.join(nativeRoot, 'src/locale.rs'),
  updates: path.join(nativeRoot, 'src/app_updates.rs'),
  build: path.join(nativeRoot, 'build.rs'),
  main: path.join(nativeRoot, 'capabilities/main.json'),
  remote: path.join(nativeRoot, 'capabilities/humble.json'),
  generatedAcl: path.join(nativeRoot, 'gen/schemas/acl-manifests.json'),
};
const texts = Object.fromEntries(Object.entries(inputs).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]));
const main = JSON.parse(texts.main);
const remote = JSON.parse(texts.remote);
const generatedAcl = JSON.parse(texts.generatedAcl);
const sorted = values => [...values].sort();
const cases = [];
const check = (name, action) => { action(); cases.push({ name, passed: true }); console.log(`PASS ${name}`); };
const handlerBlock = texts.handlers.match(/tauri::generate_handler!\s*\[([\s\S]*?)\]/)?.[1];
const manifestBlock = texts.build.match(/AppManifest::new\(\)\s*\.commands\s*\(\s*&\s*\[([\s\S]*?)\]/)?.[1];
assert(handlerBlock, 'Cannot locate generate_handler command list');
assert(manifestBlock, 'Cannot locate AppManifest command list');
const handlers = handlerBlock.split(',').map(value => value.trim()).filter(Boolean).map(value => value.split('::').at(-1));
const manifest = Array.from(manifestBlock.matchAll(/"([a-z][a-z0-9_]*)"/g), match => match[1]);
const definitions = Array.from(['handlers', 'humble', 'locale', 'updates'].map(key => texts[key]).join('\n').matchAll(/#\[tauri::command(?:\([^)]*\))?\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z][a-z0-9_]*)/g), match => match[1]);
const callback = 'humble_bridge_result';
const permission = command => `allow-${command.replaceAll('_', '-')}`;
const mainCommands = handlers.filter(command => command !== callback);
const corePermissions = [
  'core:window:allow-minimize', 'core:window:allow-toggle-maximize',
  'core:window:allow-close', 'core:window:allow-start-dragging',
  'core:event:allow-listen', 'core:event:allow-unlisten',
];

check('Every native command definition is registered once in generate_handler', () => {
  assert.equal(new Set(handlers).size, handlers.length);
  assert.equal(new Set(definitions).size, definitions.length);
  assert.deepEqual(sorted(handlers), sorted(definitions));
  for (const required of ['humble_status', 'humble_login', 'humble_sync', 'humble_reveal', 'humble_cancel', 'humble_logout', 'humble_clear_cache', 'humble_reset_login', 'humble_reset_all', 'humble_import_legacy', 'humble_bridge_result', 'export_keys', 'copy_text', 'open_external', 'set_ui_language', 'updates_get', 'updates_set', 'updates_check', 'updates_download', 'updates_apply', 'updates_ready']) assert(handlers.includes(required), `Missing required command ${required}`);
});
check('Humble login and logout remain async to avoid Windows WebView2 IPC constructor deadlock', () => {
  for (const name of ['humble_login', 'humble_logout', 'humble_clear_cache', 'humble_reset_login', 'humble_reset_all']) assert(new RegExp(`pub\\s+async\\s+fn\\s+${name}\\s*\\(`).test(texts.humble), `${name} must dispatch its WebView2 constructor off the synchronous IPC thread`);
});
check('AppManifest covers the exact registered native command set', () => {
  assert.equal(new Set(manifest).size, manifest.length);
  assert.deepEqual(sorted(manifest), sorted(handlers));
});
check('Main capability is local and restricted to the main window', () => {
  assert.deepEqual(main.windows, ['main']);
  assert.equal(main.remote, undefined);
  assert.notEqual(main.local, false);
  assert.equal(main.webviews, undefined);
});
check('Main capability grants all main commands and excludes the remote callback', () => {
  const granted = main.permissions.filter(value => typeof value === 'string' && value.startsWith('allow-'));
  assert.deepEqual(sorted(granted), sorted(mainCommands.map(permission)));
  assert.equal(main.permissions.includes(permission(callback)), false);
});
check('Main core permissions are a closed set without broad defaults or plugins', () => {
  assert.deepEqual(sorted(main.permissions), sorted([...corePermissions, ...mainCommands.map(permission)]));
  assert(main.permissions.every(value => typeof value === 'string' && !value.includes('*') && !/(?:^|:)default$/.test(value)));
});
check('Remote callback capability matches the two exact Humble storefront HTTPS origins and account window', () => {
  assert.deepEqual(remote.windows, ['humble-account']);
  assert.deepEqual(remote.remote, { urls: ['https://www.humblebundle.com/*', 'https://humblebundle.com/*'] });
  assert.equal(remote.local, false);
  assert.equal(remote.webviews, undefined);
});
check('Remote window receives callback permission only, with no local application or plugin powers', () => {
  assert.deepEqual(remote.permissions, [permission(callback)]);
  for (const command of mainCommands) assert.equal(remote.permissions.includes(permission(command)), false);
  assert(remote.permissions.every(value => typeof value === 'string' && !value.includes(':') && !value.includes('*') && !value.includes('default')));
});
check('No additional capability file silently grants broader window or remote access', () => {
  const files = fs.readdirSync(path.join(nativeRoot, 'capabilities')).filter(file => file.endsWith('.json'));
  assert.deepEqual(sorted(files), ['humble.json', 'main.json']);
});
check('Build-generated app ACL contains the exact allow permission for every command', () => {
  const applicationAcl = generatedAcl['__app-acl__'];
  assert(applicationAcl, 'Native build must generate the application ACL manifest');
  assert.equal(applicationAcl.default_permission, null);
  assert.deepEqual(applicationAcl.permission_sets, {});
  const generatedAllow = Object.keys(applicationAcl.permissions).filter(id => id.startsWith('allow-'));
  assert.deepEqual(sorted(generatedAllow), sorted(handlers.map(permission)));
  for (const command of handlers) {
    const grant = applicationAcl.permissions[permission(command)];
    assert.deepEqual(grant.commands, { allow: [command], deny: [] });
  }
});

const report = {
  passed: cases.length, failed: 0, cases,
  registeredCommands: sorted(handlers), mainCommands: sorted(mainCommands), remoteCommands: [callback],
  files: Object.fromEntries(Object.entries(inputs).map(([key, file]) => [key, { path: file, sha256: crypto.createHash('sha256').update(texts[key]).digest('hex') }])),
  scope: 'Static source and build-generated Tauri ACL regression checks. This does not establish live Humble authentication, endpoint compatibility, key reveal or physical GPU use.',
};
fs.mkdirSync(outputRoot, { recursive: true });
const reportPath = path.join(outputRoot, 'native-config-tests.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`PASS ${cases.length} native configuration checks; report ${reportPath}`);
