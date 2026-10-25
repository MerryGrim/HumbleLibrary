const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

const baseUrl = process.env.HL_PREVIEW_URL || process.argv[2] || 'http://127.0.0.1:1427/';
const previewUrl = new URL(baseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(previewUrl.hostname), 'Verification must use a local preview server');
previewUrl.searchParams.set('preview', '1');
const expectedKeys = ['PREVIEW-FAB-ONLY-0001', 'PREVIEW-GOG-ONLY-0003', 'preview_art:license/123'];
const titles = ['Fantasy Environment', 'Adventure Toolkit', 'Pixel Adventure', 'Art Studio', 'Audio Collection', 'Publisher Collection'];
const report = { fixtureOnly: true, previewUrl: previewUrl.toString(), checks: [], screenshots: [], errors: [] };
fs.mkdirSync(outputRoot, { recursive: true });
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };

async function downloadText(download) {
  const stream = await download.createReadStream();
  assert(stream, 'Preview export must produce a download stream');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function assertViewport(page) {
  const measure = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  assert(measure.scrollWidth <= measure.width + 1 && measure.bodyWidth <= measure.width + 1, 'Window must not horizontally overflow');
  for (const control of ['.workspace-brand', '.theme-button', '.account-trigger', '.window-controls', '.workspace-footer']) {
    const box = await page.locator(control).boundingBox();
    assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= measure.width + 1, `Control must stay inside the window: ${control}`);
  }
}

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 960, height: 640 }]) {
      for (const theme of ['dark', 'light']) {
        const context = await browser.newContext({ viewport, locale: 'ru-RU', reducedMotion: 'reduce', acceptDownloads: true });
        const page = await context.newPage();
        const external = [];
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (['data:', 'blob:'].includes(url.protocol) || url.origin === previewUrl.origin) return route.continue();
          external.push(url.origin);
          return route.abort();
        });
        await page.addInitScript(theme => {
          localStorage.setItem('humble-library-theme', theme);
          localStorage.setItem('humble-library-language', 'ru');
          window.__copiedPreview = [];
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedPreview.push(value); } } });
        }, theme);
        page.on('pageerror', error => report.errors.push(error.message));
        await page.goto(previewUrl.toString());
        await page.getByRole('button', { name: 'Открыть бандл Game Development Collection', exact: true }).waitFor();
        assert.equal(await page.locator('.bundle-tile').count(), 3);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.equal(await page.locator('.workspace-nav').count(), 0, 'The redundant Library header tab is removed');
        await assertViewport(page);
        const prefix = `library-${viewport.width}x${viewport.height}-${theme}`;
        const screenshot = async suffix => {
          const name = `${prefix}-${suffix}.png`;
          await page.screenshot({ path: path.join(outputRoot, name) });
          report.screenshots.push(name);
        };
        await screenshot('tiles');
        await page.getByRole('button', { name: 'Открыть бандл Game Development Collection', exact: true }).click();
        const rows = page.locator('.key-table tbody tr');
        assert.equal(await rows.count(), 6);
        for (const title of titles) assert.equal(await rows.filter({ hasText: title }).count(), 1);
        for (const name of ['Epic / Fab', 'Steam', 'GOG', 'Other', 'Publisher']) assert(await page.getByRole('combobox', { name: 'Площадка', exact: true }).locator('option').filter({ hasText: name }).count());
        const copyButtons = page.getByRole('button', { name: /^Скопировать ключ:/ });
        assert.equal(await copyButtons.count(), 3);
        await page.getByRole('button', { name: 'Скопировать ключ: Fantasy Environment', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.__copiedPreview), [expectedKeys[0]]);
        assert.equal(await page.getByRole('button', { name: 'Скопировано: Fantasy Environment', exact: true }).count(), 1);
        assert.equal(await rows.filter({ hasText: 'Audio Collection' }).getByRole('button', { name: /^Скопировать/ }).count(), 0);
        await assertViewport(page);
        for (let index = 0; index < 6; index += 1) {
          await rows.nth(index).scrollIntoViewIfNeeded();
          const box = await rows.nth(index).boundingBox();
          assert(box && box.x >= 0 && box.x + box.width <= viewport.width + 1, 'Every product row is horizontally accessible');
        }
        await page.locator('.workspace-content').evaluate(element => { element.scrollTop = 0; });
        await screenshot('keys');
        await page.getByRole('combobox', { name: 'Площадка', exact: true }).selectOption({ label: 'Steam' });
        assert.equal(await rows.count(), 1);
        assert(await rows.first().innerText().then(text => text.includes('Adventure Toolkit')));
        await page.getByRole('combobox', { name: 'Площадка', exact: true }).selectOption('');
        await page.getByRole('textbox', { name: 'Поиск по названию товара', exact: true }).fill('nothing-synthetic');
        assert.equal(await page.getByRole('heading', { name: 'Ничего не найдено', exact: true }).count(), 1);
        await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
        assert.equal(await rows.count(), 6);
        await page.getByRole('button', { name: 'Экспортировать', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Экспорт ключей', exact: true });
        await dialog.waitFor();
        await screenshot('export');
        const dialogBox = await dialog.boundingBox();
        assert(dialogBox && dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= viewport.width && dialogBox.y + dialogBox.height <= viewport.height + 1, 'Export dialog stays in the viewport');
        const downloadPromise = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Сохранить TXT', exact: true }).click();
        const download = await downloadPromise;
        assert(download.suggestedFilename().endsWith('.txt'));
        assert.equal(await downloadText(download), expectedKeys.join('\r\n') + '\r\n');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await rows.filter({ hasText: 'Adventure Toolkit' }).getByRole('button', { name: 'Раскрыть', exact: true }).count(), 1, 'Plain export must not reveal hidden keys');
        assert.equal(await page.getByText('Активирован', { exact: true }).count(), 0, 'Export must not claim redemption');
        assert.equal(external.length, 0, 'Preview does not access live accounts or external services');
        check(`${viewport.width}x${viewport.height} ${theme}: tiles, all-platform inventory, copy, filters, TXT and viewport`);
        await context.close();
      }
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', reducedMotion: 'reduce', acceptDownloads: true });
    const page = await context.newPage();
    await page.addInitScript(() => { localStorage.setItem('humble-library-language', 'ru'); });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(previewUrl.toString());
    await page.getByRole('button', { name: 'Открыть бандл Indie Adventure Bundle', exact: true }).click();
    await page.getByRole('button', { name: 'Раскрыть все', exact: true }).click();
    await page.getByRole('progressbar', { name: 'Раскрытие ключей', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Остановить', exact: true }).click();
    await page.getByText('Очередь остановлена. Полученные ключи остаются в списке.', { exact: true }).waitFor();
    assert.equal(await page.locator('.key-table tbody .key-value').count(), 1, 'Current reveal is retained');
    assert.equal(await page.getByRole('button', { name: 'Раскрыть', exact: true }).count(), 2, 'Later keys remain hidden');
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('.key-table tbody .key-value').count(), 1, 'Cancel must prevent a later reveal request');
    await page.getByRole('button', { name: 'Экспортировать', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Экспорт ключей', exact: true });
    await dialog.getByRole('combobox', { name: 'Формат файла', exact: true }).selectOption('csv');
    const csvDownload = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Сохранить CSV', exact: true }).click();
    const csv = await downloadText(await csvDownload);
    for (const title of ['Northern Lights', 'Faraway Islands', 'The Long Journey']) assert(csv.includes(title));
    assert(csv.includes('Не раскрыт') && csv.includes('Раскрыт'));
    assert.equal(csv.includes('Активирован'), false);
    check('Stop-after-current preserves the first collected key, leaves later keys hidden, and CSV keeps truthful states');
    await context.close();
    assert.deepEqual(report.errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(outputRoot, 'library-ui-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(`PASS ${report.checks.length} browser scenarios, ${report.screenshots.length} screenshots`);
})().catch(error => { console.error(error); process.exitCode = 1; });
