const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

const flightSource = fs.readFileSync(path.join(sourceRoot, 'src-tauri/src/humble_flight.js'), 'utf8');
const itemSource = fs.readFileSync(path.join(sourceRoot, 'src-tauri/src/humble_items.js'), 'utf8');
const sourcePath = path.join(sourceRoot, 'src-tauri/src/humble_page.js');
const pageSource = fs.readFileSync(sourcePath, 'utf8');
const user = { id: 'SYNTHETIC_PRIVATE_USER', email: 'fixture@example.test', createdAt: '$D2026-01-01T00:00:00.000Z' };
const entitlement = () => ({ id: 'SYNTHETIC_ENTITLEMENT', title: 'Synthetic item', type: 'steam', redemptionData: {}, redeemable: true });
const item = () => ({ id: 'SYNTHETIC_PURCHASE', title: 'Synthetic bundle', itemType: 'content-entitlement', type: 'bundle', userId: user.id, productEntitlementId: 'SYNTHETIC_PURCHASE', entitlements: { keys: [entitlement()], downloads: [] } });
const row = (id, value, tag = '') => `${id}:${tag}${JSON.stringify(value)}\n`;
function html({ items = [item()], vaultItems = [], omitVault = false, libraryProps = {}, authenticated = true, detail = false, detailParts, asyncModules = false, extendedElement = false, extra = '', library = true, malformed = false } = {}) {
  const module = name => ['fixture', [], name, ...(asyncModules ? [1] : [])];
  const element = (type, props, key = null) => ['$', type, key, props, ...(extendedElement ? ['SYNTHETIC_ELEMENT_METADATA'] : [])];
  let wire = ':HL["https://example.test/synthetic-preload"]\n' + row('1', module('AuthProvider'), 'I') + row('2', module(detail ? 'ProductKeysDownloads' : 'UserLibrary'), 'I');
  const props = detail ? { userLibraryItem: items[0], productEntitlementId: items[0]?.id, showDisclaimer: true } : { bundleItems: items, ...(omitVault ? {} : { vaultItems }), products: null, ...libraryProps };
  const children = library ? detail && detailParts ? detailParts.map((part, index) => element('$L2', part, String(index))) : element('$L2', props) : null;
  wire += row('3', element('$L1', { user: authenticated ? user : null, children })) + extra;
  if (malformed) wire += 'z:bad\n';
  const encoded = JSON.stringify([1, wire]).replace(/</g, '\\u003c');
  return `<script>self.__next_f.push([0]);self.__next_f.push([2,null]);self.__next_f.push(${encoded})</script>`;
}
const report = { fixtureOnly: true, sourcePath, sourceSha256: crypto.createHash('sha256').update(pageSource).digest('hex'), checks: [] };
(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  const network = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => { network.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    await page.evaluate(({ flightSource, pageSource, itemSource }) => {
      const surface = {};
      new Function('window', flightSource)(surface);
      new Function('window', pageSource)(surface);
      new Function('window', itemSource)(surface);
      window.__syntheticPageApi = surface.__humbleLibraryPage;
      window.__syntheticItems = surface.__humbleLibraryItems;
    }, { flightSource, pageSource, itemSource });
    async function call(method, ...args) {
      return page.evaluate(({ method, args }) => {
        try { return { ok: true, value: window.__syntheticPageApi[method](...args) }; }
        catch (error) { return { ok: false, reason: error.message, ...(error.protocolCode === undefined ? {} : { protocolCode: error.protocolCode }), ...(error.detailComponentsCount === undefined ? {} : { detailComponentsCount: error.detailComponentsCount }) }; }
      }, { method, args });
    }
    async function check(name, action) { await action(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    await check('Exact AuthProvider and UserLibrary components project only bundle parents without account fields or a flat purchase list', async () => {
      const result = await call('decodeLibraryHtml', html()); assert(result.ok); assert(result.value.authenticated);
      assert.equal(result.value.bundleItems.length, 1); assert.deepEqual(Object.keys(result.value).sort(), ['authenticated', 'bundleItems']);
      assert.equal(JSON.stringify(result).includes(user.id), false); assert.equal(JSON.stringify(result).includes(user.email), false); assert.equal(Object.hasOwn(result.value.bundleItems[0], 'userId'), false);
    });
    await check('An authenticated empty bundle collection does not claim to enumerate the Purchased or Vault collections', async () => {
      const result = await call('decodeLibraryHtml', html({ items: [] })); assert(result.ok); assert.deepEqual(result.value.bundleItems, []); assert.deepEqual(Object.keys(result.value).sort(), ['authenticated', 'bundleItems']);
    });
    await check('The separate current Choice parent consumes only its exact id and never root wrapper metadata', async () => {
      const id = 'SYNTHETIC_CURRENT_CHOICE';
      for (const subscriptionEntitlement of [{ id, title: '$Lunsupported', entitlements: '$Lunsupported', productEntitlementId: '$Lunsupported', userId: user.id }, '$a']) {
        const fixture = html({ items: [], libraryProps: { subscriptionEntitlement }, extra: row('a', { id: '$b', ignored: '$Lunsupported' }) + row('b', id) });
        const result = await call('decodeLibraryHtml', fixture); assert.equal(result.ok, true);
        assert.deepEqual(result.value, { authenticated: true, bundleItems: [], subscriptionEntitlement: { id } });
        assert.equal(JSON.stringify(result).includes(user.id), false); assert.equal(JSON.stringify(result).includes('$Lunsupported'), false);
      }
      for (const subscriptionEntitlement of [undefined, null, '$undefined']) {
        const result = await call('decodeLibraryHtml', html({ libraryProps: { subscriptionEntitlement } }));
        assert.equal(result.ok, true); assert.equal(Object.hasOwn(result.value, 'subscriptionEntitlement'), false);
      }
      for (const subscriptionEntitlement of [7, [], {}, { id: null }, { id: '' }, { id: '../bad' }, { id: 'x'.repeat(257) }]) {
        assert.equal((await call('decodeLibraryHtml', html({ libraryProps: { subscriptionEntitlement } }))).ok, false);
      }
    });
    await check('Account membership is available inside the adapter and excluded from serialized page projections', async () => {
      const result = await page.evaluate(({ library, detail, identity }) => {
        const left = window.__syntheticPageApi.decodeLibraryHtml(library);
        const right = window.__syntheticPageApi.decodeDetailHtml(detail);
        return { same: left.accountIdentity === identity && right.accountIdentity === identity,
          libraryEnumerable: Object.keys(left).includes('accountIdentity'),
          detailEnumerable: Object.keys(right).includes('accountIdentity') };
      }, { library: html(), detail: html({ detail: true }), identity: user.id });
      assert.deepEqual(result, { same: true, libraryEnumerable: false, detailEnumerable: false });
    });
    await check('Declared application refusal is distinct from malformed or missing success and leaks no error text', async () => {
      const value = { success: false, error: 'SYNTHETIC_PRIVATE_ERROR', results: [{ private: 'SYNTHETIC_PRIVATE_RESULT' }] };
      assert.deepEqual(await call('decodeLibraryResult', value), { ok: false, reason: 'service', protocolCode: 'libraryRejected' });
      for (const invalid of [null, [], {}, { success: 'false' }, { success: 0 }]) {
        assert.deepEqual(await call('decodeLibraryResult', invalid), { ok: false, reason: 'protocol', protocolCode: 'libraryResponse' });
      }
      const retryable = await page.evaluate(value => {
        try { window.__syntheticPageApi.decodeLibraryResult(value); }
        catch (error) { return error.retryable === true; }
      }, value);
      assert.equal(retryable, true);
    });
    await check('Null users, missing components, malformed rows and duplicate library components fail closed', async () => {
      for (const fixture of [html({ authenticated: false }), html({ library: false }), html({ malformed: true }), html({ extra: row('4', ['$', '$L2', null, { bundleItems: [], vaultItems: [] }]) }), '<div>Not a Next library page</div>']) {
        const result = await call('decodeLibraryHtml', fixture); assert.equal(result.ok, false); assert(['auth', 'protocol'].includes(result.reason));
      }
    });
    await check('Cyclic and over-deep property references in component props stop with a closed protocol error', async () => {
      const wrap = wire => `<script>self.__next_f.push(${JSON.stringify([1, wire])})</script>`;
      const prefix = row('1', ['fixture', [], 'AuthProvider'], 'I') + row('2', ['fixture', [], 'UserLibrary'], 'I');
      const variants = [
        prefix + row('3', ['$', '$L1', null, '$4']) + row('4', '$5') + row('5', '$4'),
        prefix + row('3', ['$', '$L1', null, '$4:user']) + row('4', '$5:user') + row('5', '$4:user'),
        prefix + row('3', ['$', '$L1', null, { user: '$4:user' }]) + row('4', '$5:user') + row('5', '$4:user'),
      ];
      let deep = prefix + row('3', ['$', '$L1', null, '$4:user']);
      for (let id = 4; id <= 109; id++) deep += row(id.toString(16), `$${(id + 1).toString(16)}:user`);
      variants.push(deep + row('6e', {}));
      for (const wire of variants) assert.deepEqual(await call('decodeLibraryHtml', wrap(wire)), { ok: false, reason: 'protocol' });
    });
    await check('Every consumed bundle route and title validates before any parent index is accepted', async () => {
      const invalid = [
        { ...item(), id: undefined, productEntitlementId: undefined },
        { ...item(), id: '../bad', productEntitlementId: null },
        { ...item(), productEntitlementId: '../bad' },
        { ...item(), productEntitlementId: '' },
        { ...item(), productEntitlementId: 7 },
        { ...item(), title: undefined }, { ...item(), title: null }, { ...item(), title: 'x'.repeat(1001) },
      ];
      for (const value of invalid) assert.equal((await call('decodeLibraryHtml', html({ items: [item(), value] }))).ok, false);
      for (const items of [null, 'wrong', {}, Array(10001).fill(item())]) assert.equal((await call('decodeLibraryHtml', html({ items }))).ok, false);
    });
    await check('Root wrappers and unused references are ignored while canonical bundle aliases retain the official route', async () => {
      const parent = 'SYNTHETIC_CANONICAL_PARENT';
      const first = { ...item(), id: { unusedInvalidId: true }, productEntitlementId: parent, itemType: 'unused-kind',
        entitlements: null, collection: '$Lunsupported', userId: '$Lunsupported', unrelatedMetadata: '$Lunsupported' };
      const second = { ...first, id: 'SYNTHETIC_ROW_ALIAS', entitlements: '$Lunsupported', purchasedAt: '$Lunsupported' };
      const canonical = { id: parent, title: item().title, productEntitlementId: parent };
      const result = await call('decodeLibraryHtml', html({ items: [first, second] }));
      assert.equal(result.ok, true); assert.deepEqual(result.value.bundleItems, [canonical, canonical]);
      assert.equal(new Set(result.value.bundleItems.map(row => row.id)).size, 1);
      assert.equal(JSON.stringify(result).includes('$Lunsupported'), false);
      const fallback = await call('decodeLibraryHtml', html({ items: [{ id: 'SYNTHETIC_FALLBACK', title: 'Synthetic fallback', productEntitlementId: null, entitlements: 7 }] }));
      assert.deepEqual(fallback.value.bundleItems, [{ id: 'SYNTHETIC_FALLBACK', title: 'Synthetic fallback', productEntitlementId: 'SYNTHETIC_FALLBACK' }]);
      const absent = await call('decodeLibraryHtml', html({ items: [{ id: 'SYNTHETIC_FALLBACK', title: 'Synthetic fallback', entitlements: '$Lunsupported' }] }));
      assert.equal(absent.ok, true); assert.deepEqual(absent.value.bundleItems, fallback.value.bundleItems);
      const outlined = await call('decodeLibraryHtml', html({ items: '$a', extra: row('a', ['$b']) + row('b', first) }));
      assert.equal(outlined.ok, true); assert.deepEqual(outlined.value.bundleItems, [canonical]);
    });
    await check('Inert page parsing accepts an empty unrelated async stream and never executes page scripts', async () => {
      const result = await call('decodeLibraryHtml', html({ extra: 'a:X\na:C\n' }) + '<script>window.__privateScriptRan=true</script><img src="https://example.test/private-image">');
      assert(result.ok); assert.equal(await page.evaluate(() => window.__privateScriptRan), undefined); assert.deepEqual(network, []);
      assert.equal((await call('decodeLibraryHtml', html({ extra: 'a:X\na:{}\na:C\n' }))).ok, false);
    });
    await check('Exact ProductKeysDownloads props provide the selected item and route identity', async () => {
      const result = await call('decodeDetailHtml', html({ detail: true })); assert(result.ok); assert.equal(result.value.productEntitlementId, item().id); assert.equal(result.value.userLibraryItem.entitlements.keys[0].id, entitlement().id);
      assert.equal(Object.hasOwn(result.value.userLibraryItem, 'userId'), false);
      assert.equal((await call('decodeDetailHtml', html())).ok, false);
    });
    await check('Async Flight imports use export slot2 and extended element tuples retain their props', async () => {
      for (const asyncModules of [false, true]) for (const extendedElement of [false, true]) {
        const library = await call('decodeLibraryHtml', html({ asyncModules, extendedElement })); assert.equal(library.ok, true); assert.equal(library.value.bundleItems.length, 1);
        const detail = await call('decodeDetailHtml', html({ detail: true, asyncModules, extendedElement })); assert.equal(detail.ok, true);
        assert.equal(detail.value.parts.length, 1); assert.equal(detail.value.detailComponentsCount, 1);
        assert.equal(detail.value.parts[0].userLibraryItem.entitlements.keys[0].id, entitlement().id);
      }
      const asyncDetailOnly = html({ detail: true }).replace(row('2', ['fixture', [], 'ProductKeysDownloads'], 'I'), row('2', ['fixture', [], 'ProductKeysDownloads', 1], 'I'));
      const selected = await call('decodeDetailHtml', asyncDetailOnly);
      assert.equal(selected.ok, true); assert.equal(selected.value.detailComponentsCount, 1);
      assert.equal(selected.value.userLibraryItem.entitlements.keys[0].id, entitlement().id);
    });
    await check('All detail components survive without requiring parent IDs, item types or download-context route equality', async () => {
      const first = { userLibraryItem: { title: 'Synthetic child A', itemType: 'unused-parent-kind', unusedMetadata: '$Lunsupported', entitlements: { keys: [{ ...entitlement(), id: 'SYNTHETIC_CHILD_KEY_A' }] } }, productEntitlementId: 'opaque:download/context', showDisclaimer: true };
      const second = { userLibraryItem: { title: 'Synthetic child B', id: { ignored: true }, entitlements: { downloads: [{ ...entitlement(), id: 'SYNTHETIC_CHILD_DOWNLOAD_B', type: 'ebook' }] } } };
      const result = await call('decodeDetailHtml', html({ detail: true, detailParts: [first, second], asyncModules: true, extendedElement: true }));
      assert.equal(result.ok, true); assert.equal(result.value.detailComponentsCount, 2); assert.equal(result.value.parts.length, 2);
      assert.equal(result.value.productEntitlementId, 'opaque:download/context');
      assert.equal(result.value.userLibraryItem.entitlements.keys[0].id, 'SYNTHETIC_CHILD_KEY_A');
      assert.equal(result.value.parts[1].userLibraryItem.entitlements.downloads[0].id, 'SYNTHETIC_CHILD_DOWNLOAD_B');
      assert(result.value.parts.every(part => !Object.hasOwn(part.userLibraryItem, 'itemType') && !Object.hasOwn(part.userLibraryItem, 'userId')));
      assert.equal(JSON.stringify(result).includes('$Lunsupported'), false);
      const normalized = await page.evaluate(fixture => window.__syntheticPageApi.decodeDetailHtml(fixture).parts.flatMap(part => window.__syntheticItems.normalize(part.userLibraryItem)), html({ detail: true, detailParts: [first, second] }));
      assert.equal(normalized.length, 2); assert.equal(normalized[1].status, 'external');
    });
    await check('Detail envelope, missing components and malformed consumed entries have closed distinct diagnostics', async () => {
      assert.deepEqual(await call('decodeDetailHtml', '<p>not a Flight document</p>'), { ok: false, reason: 'protocol', protocolCode: 'detailEnvelope' });
      assert.deepEqual(await call('decodeDetailHtml', html()), { ok: false, reason: 'protocol', protocolCode: 'detailComponents', detailComponentsCount: 0 });
      const valid = { userLibraryItem: item() };
      for (const invalid of [{}, { userLibraryItem: null }, { userLibraryItem: [] }, { userLibraryItem: { entitlements: 'wrong' } }, { userLibraryItem: { entitlements: { keys: [null] } } }, { userLibraryItem: { entitlements: { downloads: [{ id: null }] } } }]) {
        assert.deepEqual(await call('decodeDetailHtml', html({ detail: true, detailParts: [valid, invalid] })), { ok: false, reason: 'protocol', protocolCode: 'detailEntry', detailComponentsCount: 2 });
      }
      assert.deepEqual(await call('decodeDetailHtml', html({ detail: true, authenticated: false })), { ok: false, reason: 'auth' });
    });
    await check('Filter results require success, full valid entries and bounded page totals', async () => {
      const valid = { success: true, results: [item()], pagination: { page: 1, totalPages: 2, totalDocs: 2 }, requestId: '1' };
      const result = await call('decodeLibraryResult', valid); assert(result.ok); assert.deepEqual(result.value.pagination, { totalPages: 2, totalDocs: 2 });
      for (const value of [{ ...valid, success: false }, { ...valid, results: [item(), { id: 'broken' }] }, { ...valid, pagination: { totalPages: 'wrong', totalDocs: 2 } }, { ...valid, results: [] }]) assert.equal((await call('decodeLibraryResult', value)).ok, false);
      assert((await call('decodeLibraryResult', { success: true, results: [], pagination: { page: 1, totalPages: 1, totalDocs: 0 } })).ok);
    });
    await check('The standalone Purchased decoder retains repeated contexts without imposing its wrapper schema on bundle parents', async () => {
      const first = { ...item(), productEntitlementId: 'SYNTHETIC_PARENT_A', entitlements: { keys: [{ ...entitlement(), id: 'SYNTHETIC_KEY_A' }], downloads: [] } };
      const second = { ...item(), itemType: 'entitlement-group', productEntitlementId: 'SYNTHETIC_PARENT_B', entitlements: { keys: [{ ...entitlement(), id: 'SYNTHETIC_KEY_B' }], downloads: [] } };
      const payload = results => ({ success: true, results, pagination: { totalPages: 1, totalDocs: results.length } });
      const result = await call('decodeLibraryResult', payload([first, second]));
      assert.equal(result.ok, true); assert.equal(result.value.results.length, 2);
      assert.deepEqual(result.value.results.map(row => row.id), [first.id, second.id]);
      assert.deepEqual(result.value.results.map(row => row.itemType), ['content-entitlement', 'entitlement-group']);
      assert.deepEqual(result.value.results.map(row => row.productEntitlementId), ['SYNTHETIC_PARENT_A', 'SYNTHETIC_PARENT_B']);
      assert.deepEqual(result.value.results.map(row => row.entitlements.keys[0].id), ['SYNTHETIC_KEY_A', 'SYNTHETIC_KEY_B']);
      assert(result.value.results.every(row => !Object.hasOwn(row, 'userId')));
      assert.equal((await call('decodeLibraryResult', payload([first, first]))).value.results.length, 2);
      for (const malformed of [{ ...second, title: null }, { ...second, entitlements: { keys: 'wrong' } }, { id: first.id }]) {
        assert.deepEqual(await call('decodeLibraryResult', payload([first, malformed])), { ok: false, reason: 'protocol', protocolCode: 'libraryEntry' });
      }
      const parents = await call('decodeLibraryHtml', html({ items: [first, second] }));
      assert.equal(parents.ok, true);
      assert.deepEqual(parents.value.bundleItems.map(row => row.id), ['SYNTHETIC_PARENT_A', 'SYNTHETIC_PARENT_B']);
      const unrelatedVault = await call('decodeLibraryHtml', html({ items: [], vaultItems: [first, second] }));
      assert.equal(unrelatedVault.ok, true); assert.deepEqual(unrelatedVault.value.bundleItems, []); assert.equal(Object.hasOwn(unrelatedVault.value, 'vaultItems'), false);
    });
    await check('Missing detail entitlement containers become empty without relaxing list metadata validation', async () => {
      const metadata = { id: 'SYNTHETIC_METADATA', title: 'Synthetic metadata', itemType: 'content-entitlement', type: 'storefront' };
      const second = { ...metadata, id: 'SYNTHETIC_METADATA_2' };
      const result = await call('decodeLibraryResult', { success: true, results: [metadata, second], pagination: { totalPages: 1, totalDocs: 2 } });
      assert(result.ok); assert.deepEqual(result.value.results, [metadata, second]);
      for (const detailItem of [metadata, { ...metadata, entitlements: null }, {}]) {
        const detail = await call('decodeDetailHtml', html({ detail: true, items: [detailItem] }));
        assert.equal(detail.ok, true); assert.deepEqual(detail.value.userLibraryItem.entitlements, { keys: [], downloads: [], redemptionGroups: [] });
      }
      for (const entitlements of [null, { keys: [], downloads: null }, { keys: 'wrong', downloads: [] }]) {
        assert.equal((await call('decodeLibraryResult', { success: true, results: [{ ...metadata, entitlements }], pagination: { totalPages: 1, totalDocs: 1 } })).ok, false);
      }
    });
    await check('Key-only and download-only list rows pass through detail decoding and the real item normalizer', async () => {
      const keyOnly = { ...item(), id: 'SYNTHETIC_KEY_PURCHASE', entitlements: { keys: [{ ...entitlement(), redemptionData: { keyFormatted: 'SYNTHETIC-COPY' } }] } };
      const downloadOnly = { ...item(), id: 'SYNTHETIC_DOWNLOAD_PURCHASE', entitlements: { downloads: [{ ...entitlement(), id: 'SYNTHETIC_DOWNLOAD', type: 'ebook' }] } };
      const list = await call('decodeLibraryResult', { success: true, results: [keyOnly, downloadOnly], pagination: { totalPages: 1, totalDocs: 2 } });
      assert(list.ok); assert.equal(list.value.results.length, 2);
      const normalized = [];
      for (const value of [keyOnly, downloadOnly]) {
        normalized.push(await page.evaluate(fixture => {
          const detail = window.__syntheticPageApi.decodeDetailHtml(fixture);
          return window.__syntheticItems.normalize(detail.userLibraryItem);
        }, html({ detail: true, items: [value] })));
      }
      assert.equal(normalized[0][0].key, 'SYNTHETIC-COPY'); assert.equal(normalized[0][0].status, 'revealed');
      assert.equal(normalized[1][0].key, null); assert.equal(normalized[1][0].status, 'external');
      for (const entitlements of [{ keys: null }, { downloads: null }, { keys: 'wrong' }, { downloads: {} }]) {
        assert.equal((await call('decodeDetailHtml', html({ detail: true, items: [{ ...item(), entitlements }] }))).ok, false);
      }
    });
    await check('Omitted, null and malformed unrelated Vault data cannot block a valid bundle index or enter its projection', async () => {
      const canary = 'SYNTHETIC_UNRELATED_VAULT';
      const vaultVariants = [null, 7, 'wrong', { wrong: canary }, [{ id: canary, entitlements: { downloads: 'wrong' } }], '$Lunresolved'];
      for (const fixture of [html({ omitVault: true }), ...vaultVariants.map(vaultItems => html({ vaultItems }))]) {
        const result = await call('decodeLibraryHtml', fixture); assert.equal(result.ok, true);
        assert.deepEqual(Object.keys(result.value).sort(), ['authenticated', 'bundleItems']);
        assert.deepEqual(result.value.bundleItems.map(row => row.id), [item().id]);
        assert.equal(JSON.stringify(result).includes(canary), false);
      }
      assert.equal((await call('decodeLibraryHtml', html({ items: [{ ...item(), entitlements: null }] }))).ok, true);
      assert.equal((await call('decodeDetailHtml', html({ detail: true, items: [{ ...item(), entitlements: { downloads: null } }] }))).ok, false);
    });
    await check('Unrelated Purchased and product metadata never become bundle parents or substitute for a missing bundle index', async () => {
      const canary = 'SYNTHETIC_UNRELATED_PURCHASE';
      const flat = [{ ...item(), id: canary, title: canary }];
      const libraryProps = { purchased: flat, results: flat, products: flat, filterUserLibrary: { success: true, results: flat } };
      const result = await call('decodeLibraryHtml', html({ libraryProps }));
      assert.equal(result.ok, true); assert.deepEqual(result.value.bundleItems.map(row => row.id), [item().id]);
      assert.deepEqual(Object.keys(result.value).sort(), ['authenticated', 'bundleItems']);
      assert.equal(JSON.stringify(result).includes(canary), false);
      for (const bundleItems of [undefined, null, 'wrong']) {
        assert.equal((await call('decodeLibraryHtml', html({ libraryProps: { ...libraryProps, bundleItems } }))).ok, false);
      }
    });
    await check('Pagination permits an omitted page and normalizes zero pages only for an empty account', async () => {
      const empty = { success: true, results: [], pagination: { totalPages: 0, totalDocs: 0 } };
      assert.deepEqual((await call('decodeLibraryResult', empty)).value.pagination, { totalPages: 1, totalDocs: 0 });
      const metadata = { id: 'SYNTHETIC_METADATA', title: 'Synthetic metadata', itemType: 'entitlement-group' };
      const result = await call('decodeLibraryResult', { success: true, results: [metadata], pagination: { totalPages: 1, totalDocs: 1 } });
      assert(result.ok); assert.equal(Object.hasOwn(result.value.pagination, 'page'), false);
      for (const pagination of [{ totalPages: 0, totalDocs: 1 }, { totalPages: 1, totalDocs: -1 }, { totalPages: 1, totalDocs: 'wrong' }]) {
        assert.equal((await call('decodeLibraryResult', { ...empty, pagination })).ok, false);
      }
    });
    await check('Misleading UI page and request echoes are omitted without weakening data and total validation', async () => {
      const metadata = { id: 'SYNTHETIC_METADATA', title: 'Synthetic metadata', itemType: 'entitlement-group' };
      const canary = 'SYNTHETIC_PRIVATE_UI_ECHO';
      for (const auxiliary of [{ page: 98, requestId: '700' }, { page: 0, requestId: null }, { page: { unexpected: canary }, requestId: { unexpected: canary } }]) {
        const input = { success: true, results: [metadata], pagination: { page: auxiliary.page, totalPages: 1, totalDocs: 1 }, requestId: auxiliary.requestId };
        const result = await call('decodeLibraryResult', input);
        assert.deepEqual(result, { ok: true, value: { results: [metadata], pagination: { totalPages: 1, totalDocs: 1 } } });
        assert.equal(JSON.stringify(result).includes(canary), false);
      }
      for (const input of [
        { success: true, results: [metadata], pagination: { page: 98, totalPages: 0, totalDocs: 1 }, requestId: '700' },
        { success: true, results: [metadata], pagination: { page: 98, totalPages: 1, totalDocs: 0 }, requestId: '700' },
        { success: true, results: 'wrong', pagination: { page: 98, totalPages: 1, totalDocs: 1 }, requestId: '700' },
      ]) assert.equal((await call('decodeLibraryResult', input)).ok, false);
    });
    await check('Library diagnostics use only fixed pagination and entry codes without raw values', async () => {
      const canary = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_CANARY';
      const base = { success: true, results: [], pagination: { totalPages: 1, totalDocs: 0 } };
      const cases = [
        [{ ...base, results: canary }, 'libraryEntry'],
        [{ ...base, pagination: { totalPages: canary, totalDocs: 0 } }, 'libraryPagination'],
      ];
      for (const [value, code] of cases) {
        const result = await call('decodeLibraryResult', value);
        assert.deepEqual(result, { ok: false, reason: 'protocol', protocolCode: code });
        assert.equal(JSON.stringify(result).includes(canary), false);
      }
    });
    await check('Action chunks referenced only by Flight import metadata are discovered through outlined strings', async () => {
      const extra = row('a', '/_next/static/chunks/library-action.js') + row('b', [456, ['$a'], 'AdditionalModule'], 'I');
      const fixture = html({ extra });
      const result = await call('scriptPathsFromHtml', fixture, 'https://www.humblebundle.com');
      assert.deepEqual(result, { ok: true, value: ['/_next/static/chunks/library-action.js'] });
      assert.deepEqual(await call('scriptPathsFromHtml', fixture, 'https://humblebundle.com'), result);
    });
    await check('Chunk discovery deduplicates script and preload paths and ignores every noncanonical resource', async () => {
      const fixture = html() + '<script src="/_next/static/chunks/library.js"></script><link rel="preload" as="script" href="/_next/static/chunks/library.js"><link rel="modulepreload" href="https://humblebundle.com/_next/static/chunks/shared.js"><script src="https://auth.humblebundle.com/_next/static/chunks/auth.js"></script><script src="http://www.humblebundle.com/_next/static/chunks/insecure.js"></script><script src="https://www.humblebundle.com:444/_next/static/chunks/port.js"></script><script src="/_next/static/chunks/not-js.css"></script><script src="/_next/static/chunks/query.js?private=synthetic"></script><script src="/arbitrary.js"></script>';
      assert.deepEqual((await call('scriptPathsFromHtml', fixture, 'https://www.humblebundle.com')).value, ['/_next/static/chunks/library.js', '/_next/static/chunks/shared.js']);
      assert.equal((await call('scriptPathsFromHtml', fixture, 'https://auth.humblebundle.com')).ok, false);
      assert.equal((await call('scriptPathsFromHtml', html(), 'https://www.humblebundle.com')).ok, false);
    });
    await check('Only confirmed explicitly requested actions are extracted without pinning deployment hashes', async () => {
      for (const hash of ['6'.repeat(42), 'a'.repeat(40)]) {
        const source = `let read=(0,r.createServerReference)("${hash}",r.callServer,void 0,r.findSourceMapURL,"filterUserLibrary");`;
        const result = await call('extractActionReferences', source, ['filterUserLibrary']); assert.deepEqual(result.value, { filterUserLibrary: hash });
      }
      assert.equal((await call('extractActionReferences', '', ['removeCartDiscountCode'])).ok, false);
      const redeemHash = 'b'.repeat(42);
      const redeemSource = `let mutation=(0,r.createServerReference)("${redeemHash}",r.callServer,void 0,r.findSourceMapURL,"redeemEntitlementAction");`;
      assert.deepEqual((await call('extractActionReferences', redeemSource, ['redeemEntitlementAction'])).value, { redeemEntitlementAction: redeemHash });
      assert.deepEqual((await call('extractActionReferences', redeemSource, ['filterUserLibrary'])).value, {});
    });
    await check('Comments, literals, unrequested actions and conflicting action mappings are rejected or ignored', async () => {
      const hash = '6'.repeat(42), other = '7'.repeat(42);
      const read = `createServerReference)("${hash}",r.callServer,void 0,r.findSourceMapURL,"filterUserLibrary")`;
      const source = `// ${read}\n/* ${read} */const s=${JSON.stringify(read)};const expression=/${read.replace(/[()]/g, '\\$&')}/;`;
      assert.deepEqual((await call('extractActionReferences', source, ['filterUserLibrary'])).value, {});
      const mutation = `createServerReference)("${hash}",r.callServer,void 0,r.findSourceMapURL,"redeemEntitlementAction")`;
      assert.deepEqual((await call('extractActionReferences', mutation, ['filterUserLibrary'])).value, {});
      assert.equal((await call('extractActionReferences', read + ';' + read.replace(hash, other), ['filterUserLibrary'])).ok, false);
    });
    assert.deepEqual(network, []);
    report.passed = report.checks.length;
    report.scope = 'Synthetic inline Flight/components/actions only, with real inert DOMParser and all network blocked. No real account or production HTML copied into fixtures.';
    fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(path.join(outputRoot, 'humble-page-report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS ${report.passed} Humble page scenarios`);
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
