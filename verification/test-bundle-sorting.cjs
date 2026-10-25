const assert = require('node:assert/strict');
const { loadTypescript } = require('./test-env.cjs');
const { sortBundles, loadBundleSortPreference, saveBundleSortPreference, bundleSortStorageKey } = loadTypescript('src/bundleSorting.ts');
let checks = 0;
const check = (name, action) => { action(); checks += 1; console.log(`PASS ${name}`); };
const bundle = (id, purchasedAt, title = id) => ({ id, title, purchasedAt, imageUrl: '', items: [{ id: `${id}-key`, title: `Supplier ${id}`, platform: 'Other', key: `SYNTHETIC/${id}:exact`, status: 'revealed' }] });
const ids = values => Array.from(values, item => item.id);

check('Purchase date defaults to newest first, with invalid and missing dates last', () => {
  const input = [bundle('old', '2025-01-01'), bundle('empty', ''), bundle('new', '2026-10-25'), bundle('invalid', 'not-a-date'), bundle('missing', undefined), bundle('middle', '2026-03-12')];
  assert.deepEqual(ids(sortBundles(input, 'dateDesc', 'ru-RU')), ['new', 'middle', 'old', 'empty', 'invalid', 'missing']);
});
check('Oldest first still puts invalid and missing purchase dates last', () => {
  const input = [bundle('empty', ''), bundle('new', '2026-10-25'), bundle('invalid', 'not-a-date'), bundle('old', '2025-01-01')];
  assert.deepEqual(ids(sortBundles(input, 'dateAsc', 'en-US')), ['old', 'new', 'empty', 'invalid']);
});
check('Equivalent timestamps with different offsets preserve source order in both directions', () => {
  const input = [bundle('offset', '2026-10-25T12:00:00+02:00'), bundle('utc', '2026-10-25T10:00:00Z'), bundle('fraction', '2026-10-25T10:00:00.000Z')];
  for (const preference of ['dateAsc', 'dateDesc']) assert.deepEqual(ids(sortBundles(input, preference, 'en')), ['offset', 'utc', 'fraction']);
});
check('Impossible ISO calendar days are invalid, while real leap dates work', () => {
  const input = [bundle('impossible', '2026-02-30'), bundle('invalid-leap', '2025-02-29'), bundle('leap', '2024-02-29'), bundle('valid', '2026-03-01')];
  assert.deepEqual(ids(sortBundles(input, 'dateDesc', 'en')), ['valid', 'leap', 'impossible', 'invalid-leap']);
});
check('Epoch and pre-epoch timestamps are valid instead of being treated as absent', () => {
  const input = [bundle('missing', undefined), bundle('epoch', '1970-01-01T00:00:00Z'), bundle('earlier', '1969-12-31T23:59:59Z')];
  assert.deepEqual(ids(sortBundles(input, 'dateAsc', 'en')), ['earlier', 'epoch', 'missing']);
});
check('Title sorting uses numeric collation and stable case-insensitive ties', () => {
  const input = [bundle('ten', undefined, 'Pack 10'), bundle('two-first', undefined, 'Pack 2'), bundle('two-second', undefined, 'PACK 2'), bundle('one', undefined, 'Pack 1')];
  assert.deepEqual(ids(sortBundles(input, 'titleAsc', 'en-US')), ['one', 'two-first', 'two-second', 'ten']);
  assert.deepEqual(ids(sortBundles(input, 'titleDesc', 'en-US')), ['ten', 'two-first', 'two-second', 'one']);
});
check('Requested locale affects collation without changing supplier names', () => {
  const input = [bundle('z', undefined, 'Zebra'), bundle('ring', undefined, 'Ångström')];
  assert.deepEqual(ids(sortBundles(input, 'titleAsc', 'en')), ['ring', 'z']);
  assert.deepEqual(ids(sortBundles(input, 'titleAsc', 'sv')), ['z', 'ring']);
});
check('Sorting copies the array and preserves frozen source objects, keys and title bytes', () => {
  const input = [bundle('b', '2026-01-02', 'Exact Supplier B'), bundle('a', '2026-01-01', 'Exact Supplier A')];
  const before = JSON.stringify(input);
  for (const entry of input) { Object.freeze(entry.items[0]); Object.freeze(entry.items); Object.freeze(entry); }
  Object.freeze(input);
  const output = sortBundles(input, 'titleAsc', 'en');
  assert.notEqual(output, input); assert.equal(output[0], input[1]); assert.equal(JSON.stringify(input), before);
});
check('Preference default and valid restoration use only the dedicated storage key', () => {
  const values = new Map(); const store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(loadBundleSortPreference(store), 'dateDesc');
  for (const preference of ['dateDesc', 'dateAsc', 'titleAsc', 'titleDesc']) { saveBundleSortPreference(preference, store); assert.equal(values.get(bundleSortStorageKey), preference); assert.equal(loadBundleSortPreference(store), preference); }
  assert.deepEqual([...values.keys()], ['humble-library-bundle-sort']);
});
check('Invalid saved values and blocked browser storage safely fall back', () => {
  for (const value of ['', 'newest', 'title', 'constructor', '{}']) assert.equal(loadBundleSortPreference({ getItem: () => value }), 'dateDesc');
  assert.equal(loadBundleSortPreference({ getItem() { throw Error('Storage blocked'); } }), 'dateDesc');
  assert.doesNotThrow(() => saveBundleSortPreference('titleAsc', { setItem() { throw Error('Storage blocked'); } }));
  let written = false; saveBundleSortPreference('invalid', { setItem() { written = true; } }); assert.equal(written, false);
});
check('Empty libraries, bad locales and invalid runtime preferences stay usable', () => {
  assert.deepEqual(ids(sortBundles([], 'dateDesc', 'en')), []);
  const input = [bundle('old', '2020-01-01'), bundle('new', '2026-01-01')];
  assert.deepEqual(ids(sortBundles(input, 'invalid', 'not_a_locale')), ['new', 'old']);
});
console.log(`PASS ${checks} bundle-sorting checks`);
