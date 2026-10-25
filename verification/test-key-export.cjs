const assert = require('node:assert/strict');
const { loadTypescript } = require('./test-env.cjs');
// The isolated module context uses a Russian fixture locale and real local imports.
const { exportableItems, exportKeysTxt, exportItemsCsv, suggestExportName } = loadTypescript('src/keyExport.ts');

let checks = 0;
const check = (name, action) => { action(); checks += 1; console.log(`PASS ${name}`); };
const item = (id, key, extra = {}) => ({ id, title: `Synthetic product ${id}`, platform: 'Other', status: key ? 'revealed' : 'hidden', key, ...extra });
const mixed = [
  item('epic', 'PREVIEW-FAB-ONLY-0001', { platform: 'Epic / Fab' }),
  item('steam', null, { platform: 'Steam' }),
  item('gog', 'PREVIEW-GOG-ONLY-0003', { platform: 'GOG' }),
  item('license', 'preview_art:license/123', { platform: 'Other' }),
  item('unavailable', null, { status: 'unavailable', instructions: 'Temporarily unavailable' }),
  item('external', null, { status: 'external', redeemUrl: 'https://www.humblebundle.com' }),
];

check('TXT preserves supplier key formats across Epic, GOG and software', () => {
  assert.equal(exportKeysTxt(mixed), 'PREVIEW-FAB-ONLY-0001\r\nPREVIEW-GOG-ONLY-0003\r\npreview_art:license/123\r\n');
});
check('TXT exports only real values, with no headings, placeholders or product names', () => {
  const text = exportKeysTxt(mixed);
  assert.equal(text.trimEnd().split('\r\n').length, 3);
  for (const row of mixed) assert.equal(text.includes(row.title), false);
  for (const label of ['Не раскрыт', 'Недоступен', 'На сайте издателя', 'Активирован', 'null', 'undefined']) assert.equal(text.includes(label), false);
  assert.equal(exportKeysTxt(mixed.filter(row => !row.key)), '');
});
check('Export deduplicates exact values, preserving order, case and punctuation', () => {
  const values = [item('a', '  PREVIEW-A  '), item('b', 'PREVIEW-A'), item('c', 'preview-a'), item('d', ''), item('e', '  '), item('f', 'preview:two/3')];
  assert.equal(exportKeysTxt(values), 'PREVIEW-A\r\npreview-a\r\npreview:two/3\r\n');
  assert.deepEqual(Array.from(exportableItems(values), row => row.id), ['a', 'c', 'f']);
});
check('Export leaves the source inventory and status values intact', () => {
  const snapshot = JSON.stringify(mixed);
  exportKeysTxt(mixed); exportItemsCsv(mixed); exportableItems(mixed);
  assert.equal(JSON.stringify(mixed), snapshot);
});
check('CSV retains every product and reports source state without inventing activation', () => {
  const csv = exportItemsCsv(mixed);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  for (const row of mixed) assert(csv.includes(row.title));
  for (const label of ['Не раскрыт', 'Раскрыт', 'Недоступен', 'На сайте издателя']) assert(csv.includes(label));
  assert.equal(csv.includes('Активирован'), false);
  assert.equal(csv.trimEnd().split('\r\n').length, 7);
});
check('CSV quotes separators, line breaks and literal quotes, guarding formula-like cells', () => {
  const csv = exportItemsCsv([item('csv', '=SYNTHETIC()', { title: 'A; "B"\r\nC', platform: '+Synthetic platform', instructions: '@Synthetic note' })]);
  assert(csv.includes('"A; ""B""\r\nC"'));
  assert(csv.includes('"\'=SYNTHETIC()"'));
  assert(csv.includes('"\'+Synthetic platform"'));
  assert(csv.includes('"\'@Synthetic note"'));
});
check('Suggested filenames are safe for Windows and keep useful Unicode names', () => {
  assert.equal(suggestExportName('Бандл с ключами', 'txt'), 'Бандл с ключами.txt');
  assert.equal(suggestExportName('A:/B*?"<>|\\C. ', 'csv'), 'A__B_______C.csv');
  for (const value of ['', ' ', 'CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) assert.equal(suggestExportName(value, 'txt'), 'Humble-bundle.txt');
  assert(suggestExportName('A'.repeat(180), 'txt').length <= 124);
});
check('Canonical Unicode filenames and empty exports remain predictable', () => {
  assert.equal(suggestExportName('Cafe\u0301', 'txt'), 'Café.txt');
  assert.equal(exportKeysTxt([]), '');
  assert(exportItemsCsv([]).includes('Название'));
});

console.log(`PASS ${checks} export checks`);
