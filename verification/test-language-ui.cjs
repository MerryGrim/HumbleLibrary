const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');
const url = new URL(process.env.HL_PREVIEW_URL || process.argv[2] || 'http://127.0.0.1:1430/');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only local synthetic preview is permitted');
url.searchParams.set('preview', '1');
const locales = ['ru', 'en', 'de', 'it', 'es', 'fr', 'zh', 'ja', 'ko'];
const catalogs = Object.fromEntries(locales.filter(locale => locale !== 'ru').map(locale => [locale, JSON.parse(fs.readFileSync(path.join(sourceRoot, 'src/locales', `${locale}.json`), 'utf8'))]));
const message = (locale, source) => locale === 'ru' ? source : catalogs[locale][source];
const report = { fixtureOnly: true, checks: [], errors: [] };
fs.mkdirSync(outputRoot, { recursive: true });

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 960, height: 640 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    await context.addInitScript(() => { localStorage.setItem('humble-library-language', 'ru'); });
    await context.route('**/*', route => {
      const request = new URL(route.request().url());
      return ['blob:', 'data:'].includes(request.protocol) || request.origin === url.origin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(url.toString());
    await page.locator('.bundle-tile').first().waitFor();
    assert.equal(await page.locator('.workspace-nav').count(), 0);
    for (const locale of locales) {
      await page.locator('.settings-button').click();
      const dialog = page.locator('.settings-dialog');
      await dialog.locator('#interface-language').selectOption(locale);
      assert.equal((await dialog.locator('h2').innerText()).trim(), message(locale, 'Настройки'));
      assert.equal(await dialog.locator('#interface-language option').count(), 10, 'System plus all nine Manager languages');
      for (const source of ['Интерфейс', 'Язык интерфейса приложения', 'Обновления', 'Проверять обновления автоматически', 'Репозиторий обновлений', 'Проверить обновления']) assert((await dialog.innerText()).includes(message(locale, source)), `${locale} Settings missing translated text: ${source}`);
      assert.equal(await page.evaluate(() => localStorage.getItem('humble-library-language')), locale);
      assert((await page.locator('html').getAttribute('lang')).startsWith(locale));
      const dimensions = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
      assert(dimensions.scrollWidth <= dimensions.width + 1 && dimensions.documentWidth <= dimensions.viewportWidth + 1, `${locale} Settings must not horizontally overflow`);
      await page.screenshot({ path: path.join(outputRoot, `settings-960x640-${locale}.png`) });
      await dialog.locator('.dialog-head button').click();
      assert.equal((await page.locator('h1').innerText()).trim(), message(locale, 'Библиотека'));
      await page.locator('.bundle-tile').first().click();
      assert.equal((await page.locator('h1').innerText()).trim(), 'Game Development Collection');
      assert.equal(await page.locator('.key-value').first().innerText(), 'PREVIEW-FAB-ONLY-0001');
      assert((await page.locator('.key-table').innerText()).includes('preview_art:license/123'));
      assert.equal((await page.locator('.key-table th').first().textContent()).trim(), message(locale, 'Название'));
      await page.locator('.key-instructions').first().locator('summary').click();
      assert.equal(await page.locator('.key-instructions').first().locator('p').innerText(), 'Демонстрационная запись, не настоящий ключ.', 'Supplier instructions remain exact');
      await page.locator('.page-actions .primary').click();
      const exportDialog = page.locator('.dialog:not(.settings-dialog)');
      assert.equal((await exportDialog.locator('h2').innerText()).trim(), message(locale, 'Экспорт ключей'));
      assert((await exportDialog.innerText()).includes(message(locale, 'Все площадки вместе. В файле будут только раскрытые ключи, без названий и повторов.')));
      await page.keyboard.press('Alt+ArrowLeft');
      assert.equal(await exportDialog.count(), 1, 'Navigation does not dismiss the export dialog');
      await exportDialog.locator('.dialog-head button').click();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.locator('.bundle-tile').first().waitFor();
      assert.equal(await page.locator('.bundle-tile').first().evaluate(element => document.activeElement === element), true, 'Back returns focus to the source bundle');
      await page.locator('.bundle-tile').first().click();
      await page.locator('.workspace-brand').click();
      assert.equal(await page.locator('.bundle-tile').count(), 3, 'Brand returns to bundle library');
      report.checks.push({ language: locale, settings: true, keyTitleInstructionsPreserved: true, export: true, navigation: true });
      console.log(`PASS ${locale}: Settings, library/export translations, metadata preservation, Alt+Left and brand home`);
    }
    await page.locator('.settings-button').click();
    await page.locator('#interface-language').selectOption('system');
    assert.equal(await page.evaluate(() => localStorage.getItem('humble-library-language')), 'system');
    assert.equal((await page.locator('.settings-dialog h2').innerText()).trim(), 'Настройки');
    assert.deepEqual(report.errors, []);
    await context.close();
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(outputRoot, 'language-ui-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(`PASS ${report.checks.length} language browser scenarios plus system preference`);
})().catch(error => { console.error(error); process.exitCode = 1; });
