// Read-only projection of ProductKeysDownloads.userLibraryItem. This helper
// never requests, claims, redeems, signs download URLs, or follows gift links.
(() => {
  'use strict';
  const fail = () => { throw new Error('protocol'); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = (value, limit = 1024) => typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit)
    : '';
  const code = value => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 262144 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
    return value.trim() ? value : null;
  };
  const safeUrl = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, 'https://www.humblebundle.com');
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  };
  const plain = value => {
    if (typeof value !== 'string' || !value) return '';
    const doc = new DOMParser().parseFromString(value.slice(0, 65536), 'text/html');
    doc.querySelectorAll('script,style,template').forEach(node => node.remove());
    return text(doc.body.textContent || '', 12000).trim();
  };
  const platformNames = {
    steam: 'Steam', steam_keyless: 'Steam', epic: 'Epic Games', epicgames: 'Epic Games',
    epic_games: 'Epic Games', epic_keyless: 'Epic Games', unreal: 'Unreal / Fab',
    unreal_engine: 'Unreal / Fab', fab: 'Fab', gog: 'GOG', uplay: 'Ubisoft Connect',
    ubisoft: 'Ubisoft Connect', origin: 'EA app', ea: 'EA app', battlenet: 'Battle.net',
    blizzard: 'Battle.net', blizzard_keyless: 'Battle.net', itch: 'itch.io', unity: 'Unity Asset Store',
    gog_keyless: 'GOG', origin_keyless: 'EA app', nintendo_direct: 'Nintendo',
    vaultn_steamkey: 'VaultN', genba_key: 'Genba', genba: 'Genba',
    external_key: 'External Key', url: 'URL', epay: 'ePay',
  };
  const accountActivations = new Set(['epic_keyless', 'gog_keyless', 'origin_keyless', 'blizzard_keyless', 'uplay']);
  const platform = entry => {
    const name = text(entry.type || entry.keyIntegrationId, 160);
    return platformNames[name.toLowerCase()] || name || 'Другая площадка';
  };
  const description = entry => [plain(entry.instructionsHtml), plain(entry.customDisclaimer)]
    .filter(Boolean).join('\n\n') || null;

  function normalize(item, bundleId) {
    if (!object(item) || !object(item.entitlements)) fail();
    const { keys = [], downloads = [], redemptionGroups = [] } = item.entitlements;
    if (![keys, downloads, redemptionGroups].every(Array.isArray) || keys.length + downloads.length > 10000) fail();
    const sourceIds = new Set();
    const grouped = new Set();
    for (const group of redemptionGroups) {
      if (!object(group) || !Array.isArray(group.options)) fail();
      for (const option of group.options) if (object(option) && typeof option.entitlementId === 'string') grouped.add(option.entitlementId);
    }
    const detailUrl = typeof bundleId === 'string' && bundleId && bundleId.length <= 1000
      ? `https://www.humblebundle.com/home/library/${encodeURIComponent(bundleId)}` : null;
    const identity = entry => {
      if (!object(entry) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 1000 || sourceIds.has(entry.id)) fail();
      sourceIds.add(entry.id);
      return entry.id;
    };
    const normalized = keys.map(entry => {
      const id = identity(entry);
      if (entry.redemptionData != null && !object(entry.redemptionData)) fail();
      // gameKey is a gift-claim token, not the displayed license. Only the
      // same field used by Humble's copy control is allowed into an export.
      const key = code(entry.redemptionData?.keyFormatted);
      const unavailable = entry.expired === true || entry.outOfStock === true || entry.preOrdered === true;
      const external = entry.directRedeem === true || accountActivations.has(entry.keyIntegrationId)
        || !!entry.redeemedAt || entry.giftStatus === 'gifted'
        || grouped.has(id) || entry.redeemable !== true;
      return {
        id, title: text(entry.title || item.title, 1000), platform: platform(entry), key,
        status: key ? 'revealed' : unavailable ? 'unavailable' : external ? 'external' : 'hidden',
        instructions: description(entry), redeemUrl: safeUrl(entry.customCtaUrl) || detailUrl,
      };
    });
    for (const entry of downloads) {
      const id = identity(entry);
      normalized.push({
        id, title: text(entry.title || item.title, 1000), platform: platform(entry), key: null,
        status: entry.expired === true || entry.outOfStock === true || entry.preOrdered === true ? 'unavailable' : 'external',
        instructions: description(entry), redeemUrl: safeUrl(entry.customCtaUrl) || detailUrl,
      });
    }
    return normalized;
  }

  function normalizeRedeemResult(result) {
    if (!object(result) || typeof result.success !== 'boolean') fail();
    if (!result.success) return null;
    const key = code(result.key);
    // Keyless activation or an asynchronous provider grant is not a revealed
    // license. The caller must keep that distinction when updating the cache.
    return { key, status: key ? 'revealed' : 'external' };
  }

  function normalizeVault(item) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 1000 || typeof item.title !== 'string') fail();
    // The official Vault row uses `entitlements?.downloads ?? []`. Its file
    // buttons prepare signed URLs only after an explicit click. This passive
    // projection neither prepares downloads nor invents a content-detail URL.
    if (item.entitlements == null) return [];
    if (!object(item.entitlements)) fail();
    const downloads = item.entitlements.downloads ?? [];
    if (!Array.isArray(downloads) || downloads.length > 10000) fail();
    const seen = new Set();
    return downloads.map(entry => {
      if (!object(entry) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 1000 || seen.has(entry.id)) fail();
      seen.add(entry.id);
      const rawPlatform = text(entry.type, 160);
      const generic = ['', 'download', 'downloads', 'vault', 'bundle'].includes(rawPlatform.toLowerCase());
      return {
        id: entry.id,
        title: text(typeof entry.title === 'string' && entry.title ? entry.title : item.title, 1000),
        platform: generic ? 'Humble Vault' : platform(entry),
        key: null, status: 'external', instructions: description(entry), redeemUrl: null,
      };
    });
  }

  window.__humbleLibraryItems = Object.freeze({ normalize, normalizeRedeemResult, normalizeVault });
})();
