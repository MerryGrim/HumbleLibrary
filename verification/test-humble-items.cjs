const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot, outputRoot, loadPlaywright, browserLaunchOptions } = require('./test-env.cjs');

// All fixtures are invented. No saved page, profile, session, or real key is read.
const source = fs.readFileSync(path.join(sourceRoot, 'src-tauri/src/humble_items.js'), 'utf8');
const report = { fixtureOnly: true, cases: [], scope: 'Read-only modern entitlement normalization with a real inert DOMParser. No network or live account.' };

(async () => {
  const browser = await loadPlaywright().chromium.launch(browserLaunchOptions);
  const requests = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: source });
    const normalize = (keys = [], downloads = [], extra = {}) => page.evaluate(({ keys, downloads, extra }) =>
      window.__humbleLibraryItems.normalize({ title: 'Synthetic bundle', entitlements: { keys, downloads, ...extra } }, 'synthetic-bundle'), { keys, downloads, extra });
    const key = (id, extra = {}) => ({ id, title: `Synthetic ${id}`, type: 'steam', redeemable: true, redemptionData: {}, ...extra });
    const check = async (name, action) => { await action(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`); };

    await check('Keeps every platform and unknown provider without a Fab-only filter', async () => {
      const platforms = ['steam', 'epic', 'fab', 'gog', 'uplay', 'origin', 'battlenet', 'itch', 'unity', 'new_synthetic_provider'];
      const result = await normalize(platforms.map((type, i) => key(`platform-${i}`, { type })));
      assert.equal(result.length, platforms.length);
      assert.deepEqual(result.map(item => item.platform), ['Steam', 'Epic Games', 'Fab', 'GOG', 'Ubisoft Connect', 'EA app', 'Battle.net', 'itch.io', 'Unity Asset Store', 'new_synthetic_provider']);
      assert(result.every(item => item.status === 'hidden' && item.key === null));
    });
    await check('Exports only the actual formatted key and never the gift token', async () => {
      const result = await normalize([
        key('formatted', { redemptionData: { keyFormatted: 'SYNTHETIC-COPY-VALUE\nSECOND-LINE' }, gameKey: 'SyntheticGift001' }),
        key('gift-token-only', { gameKey: 'SyntheticGift002', redeemed_key_val: 'WRONG-LEGACY-FIELD' }),
      ]);
      assert.equal(result[0].key, 'SYNTHETIC-COPY-VALUE\nSECOND-LINE');
      assert.equal(result[0].status, 'revealed');
      assert.equal(result[1].key, null); assert.equal(result[1].status, 'hidden');
      assert(!JSON.stringify(result).includes('SyntheticGift')); assert(!JSON.stringify(result).includes('WRONG-LEGACY-FIELD'));
    });
    await check('Preserves redeemed and blocked states without inventing a license', async () => {
      const result = await normalize([
        key('redeemed', { redeemedAt: '2026-01-01T00:00:00Z' }), key('direct', { directRedeem: true }),
        key('gifted', { giftStatus: 'gifted' }), key('disabled', { redeemable: false }),
        key('keyless', { keyIntegrationId: 'gog_keyless' }), key('linked-activation', { keyIntegrationId: 'uplay' }),
        key('expired', { expired: true }), key('stock', { outOfStock: true }), key('preorder', { preOrdered: true }),
        key('already-key', { expired: true, redemptionData: { keyFormatted: 'SYNTHETIC-SAVED' } }),
      ]);
      assert.deepEqual(result.map(item => item.status), ['external', 'external', 'external', 'external', 'external', 'external', 'unavailable', 'unavailable', 'unavailable', 'revealed']);
      assert(result.slice(0, 9).every(item => item.key === null));
    });
    await check('Keeps mutually exclusive redemption choices outside automatic reveal', async () => {
      const result = await normalize([key('choice-a'), key('choice-b'), key('ordinary')], [], {
        redemptionGroups: [{ maxRedemptions: 1, state: 'AVAILABLE', options: [{ entitlementId: 'choice-a', eligible: true }, { entitlementId: 'choice-b', eligible: true }] }],
      });
      assert.deepEqual(result.map(item => item.status), ['external', 'external', 'hidden']);
    });
    await check('Retains downloads as external items, with clean instructions and safe URLs', async () => {
      const result = await normalize([], [
        key('download', { type: 'ebook', redemptionData: { keyFormatted: 'DO-NOT-EXPORT-DOWNLOAD' }, instructionsHtml: '<p>Open the official download.</p><script>PRIVATE_SCRIPT</script>', customDisclaimer: '<b>Keep a copy.</b>', customCtaUrl: 'https://downloads.example.test/book' }),
        key('download-fallback', { customCtaUrl: 'javascript:alert(1)' }),
      ]);
      assert(result.every(item => item.key === null && item.status === 'external'));
      assert.equal(result[0].instructions, 'Open the official download.\n\nKeep a copy.');
      assert.equal(result[0].redeemUrl, 'https://downloads.example.test/book');
      assert.equal(result[1].redeemUrl, 'https://www.humblebundle.com/home/library/synthetic-bundle');
      assert(!JSON.stringify(result).includes('PRIVATE_SCRIPT'));
    });
    await check('Uses integration identity when the platform field is missing', async () => {
      const result = await normalize([key('integration', { type: null, keyIntegrationId: 'synthetic_integration' })]);
      assert.equal(result[0].platform, 'synthetic_integration');
      const noLink = await page.evaluate(() => window.__humbleLibraryItems.normalize({ entitlements: { keys: [{ id: 'none', gameKey: 'SyntheticGift003', redemptionData: {}, redeemable: true }] } }));
      assert.equal(noLink[0].key, null); assert.equal(noLink[0].redeemUrl, null);
    });
    await check('Rejects malformed and oversized values instead of coercing them into codes', async () => {
      for (const input of [
        { entitlements: { keys: [key('object-code', { redemptionData: { keyFormatted: { secret: 'SYNTHETIC' } } })] } },
        { entitlements: { keys: [key('control', { redemptionData: { keyFormatted: 'SYNTHETIC\u0000CODE' } })] } },
        { entitlements: { keys: [key('large', { redemptionData: { keyFormatted: 'S'.repeat(262145) } })] } },
        { entitlements: { keys: [key('duplicate'), key('duplicate')] } },
        { entitlements: { keys: {} } }, { entitlements: { keys: Array(10001).fill(key('too-many')) } },
      ]) {
        const message = await page.evaluate(input => { try { window.__humbleLibraryItems.normalize(input); return 'accepted'; } catch (error) { return error.message; } }, input);
        assert.equal(message, 'protocol');
      }
    });
    await check('Distinguishes returned license keys from pending or keyless grants', async () => {
      const result = await page.evaluate(() => [
        { success: true, key: 'SYNTHETIC-RESULT' }, { success: true, orderStatus: 'GRANT_PENDING' },
        { success: true, accountName: 'Synthetic account' }, { success: false, errorKind: 'generic' },
      ].map(value => window.__humbleLibraryItems.normalizeRedeemResult(value)));
      assert.deepEqual(result, [{ key: 'SYNTHETIC-RESULT', status: 'revealed' }, { key: null, status: 'external' }, { key: null, status: 'external' }, null]);
    });
    await check('Vault metadata stays external without preparing signed downloads, inventing routes or exporting codes', async () => {
      const result = await page.evaluate(() => window.__humbleLibraryItems.normalizeVault({
        id: 'synthetic-vault', title: 'Synthetic Vault title', entitlements: {
          keys: [{ id: 'ignored-key', redemptionData: { keyFormatted: 'SYNTHETIC-PRIVATE-KEY' } }],
          downloads: [
            { id: 'vault-download', type: 'download', title: 'Synthetic download', instructionsHtml: '<p>Open the Vault library.</p>', gameKey: 'SYNTHETIC-PRIVATE-GIFT', redemptionData: { keyFormatted: 'SYNTHETIC-PRIVATE-CODE' }, signedUrls: { private: 'https://example.test/SYNTHETIC-PRIVATE-URL' }, downloads: [{ key: 'windows', downloadStruct: [{ name: 'Installer', size: '1 GB', url: { web: 'SYNTHETIC-PRIVATE-PATH' } }] }] },
            { id: 'vault-ebook', type: 'ebook' },
          ],
        },
      }));
      assert.deepEqual(result.map(item => item.id), ['vault-download', 'vault-ebook']);
      assert.deepEqual(result.map(item => item.platform), ['Humble Vault', 'ebook']);
      assert.equal(result[0].title, 'Synthetic download'); assert.equal(result[1].title, 'Synthetic Vault title');
      assert.equal(result[0].instructions, 'Open the Vault library.');
      assert(result.every(item => item.key === null && item.status === 'external' && item.redeemUrl === null));
      assert.equal(JSON.stringify(result).includes('SYNTHETIC-PRIVATE'), false);
    });
    await check('Vault nullish optional collections are empty while malformed present data still fails closed', async () => {
      for (const extra of [{}, { entitlements: null }, { entitlements: {} }, { entitlements: { downloads: null } }, { entitlements: { downloads: [] } }]) {
        const result = await page.evaluate(extra => window.__humbleLibraryItems.normalizeVault({ id: 'synthetic-vault', title: 'Synthetic Vault', ...extra }), extra);
        assert.deepEqual(result, []);
      }
      for (const extra of [{ entitlements: 'wrong' }, { entitlements: [] }, { entitlements: { downloads: 'wrong' } }, { entitlements: { downloads: {} } }, { entitlements: { downloads: [null] } }, { entitlements: { downloads: [{ id: 'duplicate' }, { id: 'duplicate' }] } }]) {
        const message = await page.evaluate(extra => { try { window.__humbleLibraryItems.normalizeVault({ id: 'synthetic-vault', title: 'Synthetic Vault', ...extra }); return 'accepted'; } catch (error) { return error.message; } }, extra);
        assert.equal(message, 'protocol');
      }
    });
    assert.deepEqual(requests, []);
    report.passed = true;
  } finally { await browser.close(); }
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'humble-items-check.json'), JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
