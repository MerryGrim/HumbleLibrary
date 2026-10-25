const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sourceRoot } = require('./test-env.cjs');
const ts = require(require.resolve('typescript', { paths: [sourceRoot] }));
const locales = ['en', 'de', 'it', 'es', 'fr', 'zh', 'ja', 'ko'];
const catalogs = Object.fromEntries(locales.map(locale => [locale, JSON.parse(fs.readFileSync(path.join(sourceRoot, 'src/locales', `${locale}.json`), 'utf8'))]));
const placeholders = value => Array.from(value.matchAll(/\{([^{}]+)\}/g), match => match[1]).sort();
let checks = 0;
function check(name, action) { action(); checks += 1; console.log(`PASS ${name}`); }

function loadI18n(systemLanguage = 'ru-RU', saved = null, storageFails = false) {
  const filePath = path.join(sourceRoot, 'src/i18n.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} }, store = new Map(saved ? [['humble-library-language', saved]] : []), listeners = new Map(), document = { documentElement: { lang: '' } }, navigator = { language: systemLanguage };
  const localStorage = { getItem: key => { if (storageFails) throw Error('synthetic storage unavailable'); return store.get(key) ?? null; }, setItem: (key, value) => { if (storageFails) throw Error('synthetic storage unavailable'); store.set(key, value); } };
  const requireModule = name => name === 'react' ? { useSyncExternalStore: (_subscribe, snapshot) => snapshot() } : name.startsWith('./locales/') ? JSON.parse(fs.readFileSync(path.join(sourceRoot, 'src', name), 'utf8')) : require(name);
  vm.runInNewContext(code, { module, exports: module.exports, require: requireModule, localStorage, navigator, document, window: { addEventListener: (name, action) => listeners.set(name, action) } }, { filename: filePath });
  return { api: module.exports, store, listeners, document, navigator };
}

check('All eight translated catalogs have identical keys, nonempty translations and intact placeholders', () => {
  const reference = Object.keys(catalogs.en).sort();
  assert(reference.length >= 150);
  for (const [locale, entries] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(entries).sort(), reference, `${locale} keys differ`);
    for (const [source, value] of Object.entries(entries)) {
      assert.equal(typeof value, 'string');
      assert(value.trim(), `${locale} empty translation: ${source}`);
      assert.notEqual(value, source, `${locale} copied Russian source: ${source}`);
      assert.deepEqual(placeholders(value), placeholders(source), `${locale} placeholders differ: ${source}`);
    }
  }
});
check('Every app, export and Settings Russian literal has a translation in all eight catalogs', () => {
  const sources = new Set(), unwrappedTemplates = [];
  for (const file of ['App.tsx', 'SettingsDialog.tsx', 'Notification.tsx', 'BundleSort.tsx', 'keyExport.ts']) {
    const filePath = path.join(sourceRoot, 'src', file), code = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && /[А-Яа-яЁё]/.test(node.text)) sources.add(node.text.trim());
      if (ts.isTemplateExpression(node) && /[А-Яа-яЁё]/.test([node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(''))) unwrappedTemplates.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(unwrappedTemplates, [], 'Russian dynamic templates must use translation placeholders');
  assert(sources.size > 100, 'UI source scan should include the complete application');
  for (const [locale, entries] of Object.entries(catalogs)) for (const source of sources) assert(Object.hasOwn(entries, source), `${locale} missing: ${source}`);
});
check('System language uses the primary subtag and unsupported systems fall back to English', () => {
  const { api } = loadI18n('fr-CA');
  assert.equal(api.getLanguagePreference(), 'system');
  assert.equal(api.tr('Настройки'), catalogs.fr['Настройки']);
  for (const system of ['pt-BR', 'uk-UA', '', 'xx']) assert.equal(api.resolveLanguage('system', system), 'en');
  for (const [system, expected] of [['zh-Hant-TW', 'zh'], ['de_AT', 'de'], ['ko-KR', 'ko'], ['ru-RU', 'ru']]) assert.equal(api.resolveLanguage('system', system), expected);
});
check('Static native updater and recovery diagnostics are translated without test fixture strings', () => {
  for (const file of ['app_updates.rs', 'updater_helper.rs']) {
    const source = fs.readFileSync(path.join(sourceRoot, 'src-tauri/src', file), 'utf8').split('#[cfg(test)]')[0];
    const messages = new Set(Array.from(source.matchAll(/"([^"\n]*[А-Яа-яЁё][^"\n]*)"/g), match => match[1]));
    assert(messages.size > 20, `${file} diagnostics scan must include the implementation`);
    for (const [locale, entries] of Object.entries(catalogs)) for (const message of messages) assert(Object.hasOwn(entries, message), `${locale} missing native diagnostic: ${message}`);
  }
});
check('Every one of the nine languages can be selected and persisted without storing content', () => {
  const { api, store, document } = loadI18n();
  assert.deepEqual(Array.from(api.languages, item => item.value), ['system', 'ru', ...locales]);
  for (const locale of ['ru', ...locales]) {
    api.setLanguagePreference(locale);
    assert.equal(api.getLanguagePreference(), locale);
    assert.equal(store.get('humble-library-language'), locale);
    assert.equal(api.tr('Настройки'), locale === 'ru' ? 'Настройки' : catalogs[locale]['Настройки']);
    assert(document.documentElement.lang.startsWith(locale));
    assert.equal(api.useLanguage().language, locale);
  }
  assert.deepEqual([...store.keys()], ['humble-library-language']);
});
check('Product names, supplier instructions, keys, paths and interpolated values remain exact', () => {
  const { api } = loadI18n();
  const title = 'Русская игра — PREVIEW {version}', key = 'preview_art:license/123', filePath = 'D:\\Ключи\\bundle.txt';
  for (const locale of ['ru', ...locales]) {
    api.setLanguagePreference(locale);
    for (const value of [title, key, filePath, 'Publisher-specific instructions untouched']) assert.equal(api.tr(value), value);
    assert(api.tr('Открыть бандл {title}', { title }).includes(title));
    assert(api.tr('Экспорт сохранён: {path}', { path: filePath }).includes(filePath));
  }
});
check('Preferences restore, languagechange/storage events work, unavailable storage does not break switching', () => {
  const restored = loadI18n('ru-RU', 'ja');
  assert.equal(restored.api.getLanguagePreference(), 'ja');
  restored.api.setLanguagePreference('system'); restored.navigator.language = 'de-DE'; restored.listeners.get('languagechange')();
  assert.equal(restored.api.tr('Настройки'), catalogs.de['Настройки']);
  restored.listeners.get('storage')({ key: 'humble-library-language', newValue: 'ko' });
  assert.equal(restored.api.getLanguagePreference(), 'ko');
  const blocked = loadI18n('ru-RU', null, true);
  blocked.api.setLanguagePreference('es');
  assert.equal(blocked.api.tr('Настройки'), catalogs.es['Настройки']);
});

check('Native update error prefix follows locale while preserving the exact error suffix', () => {
  const { api } = loadI18n();
  const remainder = 'D:\\Ключи\\Synthetic {version}.txt: ACCESS_DENIED / PREVIEW:key=42\nДанные поставщика';
  const source = 'Обновление: ' + remainder;
  for (const locale of ['ru', 'en', 'de', 'en', 'ru']) {
    api.setLanguagePreference(locale);
    const expected = locale === 'ru' ? source : catalogs[locale]['Обновление: {error}'].replace('{error}', remainder);
    assert.equal(api.trError(source), expected);
    assert.equal(api.trError(remainder), remainder);
    assert.equal(api.trError('Не удалось прочитать настройки обновлений.'), api.tr('Не удалось прочитать настройки обновлений.'));
    assert.equal(api.tr(source), source, 'General translation must not translate arbitrary prefixes');
  }
});

console.log(`PASS ${checks} localization checks; ${Object.keys(catalogs.en).length} messages in each of 8 catalogs`);
