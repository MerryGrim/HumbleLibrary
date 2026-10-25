// Same-origin Humble adapter. This file never logs keys, credentials or raw errors.
// Protocol fields are based on the Humble front end and the public implementations:
// github.com/MrMarble/hb-key-exporter/src/util.ts
// github.com/gfargo/humble-bundle-keys/humble_bundle_keys/api.py
(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://www.humblebundle.com') return;
  const nativeFetch = window.fetch.bind(window);
  const invoke = (...args) => window.__TAURI_INTERNALS__.invoke(...args);
  let current = null;
  const orders = new Map();
  const text = (value, limit = 1024) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit) : '';
  const safeUrl = value => {
    if (typeof value !== 'string' || !value.trim()) return '';
    try { const u = new URL(value, location.origin); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; }
  };
  const plain = value => {
    if (typeof value !== 'string' || !value) return '';
    const parsed = new DOMParser().parseFromString(value.slice(0, 65536), 'text/html');
    return text(parsed.body.textContent || '', 12000).trim();
  };
  const keyValue = value => {
    let result = null;
    if (typeof value === 'string') result = value.trim() ? value : null;
    else if (value && typeof value === 'object' && !Array.isArray(value)) result = JSON.stringify(value);
    if (result !== null && (new TextEncoder().encode(result).byteLength > 262144 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result))) throw new Error('protocol');
    return result;
  };
  function tpks(order) {
    const source = order?.tpkd_dict;
    if (!source || typeof source !== 'object') return [];
    for (const name of ['all_tpks', 'chosen_tpks', 'primary_tpks']) {
      if (Array.isArray(source[name]) && source[name].length) return source[name];
    }
    return [];
  }
  const keyIndex = tpk => {
    const value = tpk.keyindex ?? tpk.key_index;
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,8})$/.test(value)) return Number(value);
    return null;
  };
  const itemId = (tpk, index) => `${text(tpk.machine_name, 300)}:${keyIndex(tpk) ?? index}:${text(tpk.key_type, 100)}`;
  const platformNames = { steam: 'Steam', epic: 'Epic Games', epicgames: 'Epic Games', epic_games: 'Epic Games', unreal: 'Unreal / Fab', unreal_engine: 'Unreal / Fab', fab: 'Fab', gog: 'GOG', uplay: 'Ubisoft Connect', ubisoft: 'Ubisoft Connect', origin: 'EA app', ea: 'EA app', battlenet: 'Battle.net', itch: 'itch.io', unity: 'Unity Asset Store', other: 'Другая площадка' };
  function normalizeItem(tpk, index) {
    const key = keyValue(tpk.redeemed_key_val);
    const rawPlatform = text(tpk.key_type_human_name || tpk.key_type || 'Другая площадка', 160);
    const instructionsHtml = tpk.custom_instructions_html || tpk.instructions_html || '';
    const instructions = plain(instructionsHtml);
    let redeemUrl = safeUrl(tpk.redeem_url || tpk.redemption_url || '');
    if (!redeemUrl && instructionsHtml) {
      const doc = new DOMParser().parseFromString(instructionsHtml.slice(0, 65536), 'text/html');
      for (const a of doc.querySelectorAll('a[href]')) { redeemUrl = safeUrl(a.getAttribute('href')); if (redeemUrl) break; }
    }
    const missingIndex = keyIndex(tpk) === null;
    const status = key ? 'revealed' : tpk.is_expired || tpk.sold_out ? 'unavailable' : tpk.is_gift || tpk.direct_redeem || !tpk.machine_name || missingIndex ? 'external' : 'hidden';
    return { id: itemId(tpk, index), title: text(tpk.human_name || tpk.display_name || tpk.machine_name || 'Без названия', 1000), platform: platformNames[rawPlatform.toLowerCase()] || rawPlatform, key, status, instructions: instructions || null, redeemUrl: redeemUrl || null };
  }
  function normalizeOrder(order, id) {
    const product = order.product && typeof order.product === 'object' ? order.product : {};
    const image = product.icon || product.icon_url || product.logo || product.logo_url || product.image || order.icon || order.icon_url || '';
    return { id, title: text(product.human_name || product.machine_name || order.human_name || 'Покупка Humble Bundle', 1000), imageUrl: safeUrl(typeof image === 'string' ? image : image?.url || ''), purchasedAt: text(order.created || '', 100) || null, items: tpks(order).map(normalizeItem) };
  }
  const send = (nonce, payload) => invoke('humble_bridge_result', { nonce, payload });
  async function json(path, options, operation) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('protocol');
    let response;
    try { response = await nativeFetch(path, { cache: 'no-store', credentials: 'same-origin', ...options, signal: operation.controller.signal }); }
    catch { throw new Error(operation.cancelled ? 'cancelled' : 'network'); }
    if (operation.cancelled) throw new Error('cancelled');
    if (response.status === 401 || response.status === 403) throw new Error('auth');
    if (response.status === 429) throw new Error('rateLimited');
    if (!response.ok) throw new Error('service');
    if (response.redirected && /\/(?:login|signin)(?:[/?#]|$)/.test(response.url)) throw new Error('auth');
    try { return await response.json(); } catch { throw new Error('protocol'); }
  }
  async function getOrder(id, operation) {
    const order = await json(`/api/v1/order/${encodeURIComponent(id)}?all_tpkds=true`, {}, operation);
    if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('protocol');
    orders.set(id, order);
    return order;
  }
  function orderIds(list) {
    if (!Array.isArray(list) || list.length > 10000 || !list.every(row => {
      const id = typeof row === 'string' ? row : row && typeof row === 'object' && !Array.isArray(row) ? row.gamekey : null;
      return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(id);
    })) throw new Error('protocol');
    return [...new Set(list.map(row => typeof row === 'string' ? row : row.gamekey))];
  }
  async function auth(operation) {
    orderIds(await json('/api/v1/user/order', {}, operation));
    // Authentication probes never return orders, purchase IDs or key material.
    return { authenticated: true };
  }
  async function sync(operation) {
    const list = await json('/api/v1/user/order', {}, operation);
    const ids = orderIds(list);
    // This proof precedes every order/detail/cover read. The native side binds
    // it to the active sync nonce and never infers login from a local snapshot.
    await send(operation.nonce, { kind: 'session', authenticated: true });
    const bundles = [];
    for (let index = 0; index < ids.length; index++) {
      if (operation.cancelled) throw new Error('cancelled');
      const order = await getOrder(ids[index], operation);
      // Keep purchases without keys visible too: their content/instructions may matter.
      const bundle = normalizeOrder(order, ids[index]);
      if (typeof window.__humbleLibraryBundleImage === 'function') bundle.imageUrl = await window.__humbleLibraryBundleImage(order, ids[index], operation.controller.signal);
      bundles.push(bundle);
      await send(operation.nonce, { kind: 'progress', completed: index + 1, total: ids.length });
      if (index + 1 < ids.length) await new Promise(resolve => setTimeout(resolve, 120));
    }
    return { bundles, syncedAt: new Date().toISOString() };
  }
  async function reveal(args, operation) {
    // Refresh this specific order first. A previous timed-out reveal is never replayed blindly.
    const order = await getOrder(args.bundleId, operation);
    const entries = tpks(order);
    const index = entries.findIndex((entry, position) => itemId(entry, position) === args.itemId);
    if (index < 0) throw new Error('notFound');
    const tpk = entries[index];
    let item = normalizeItem(tpk, index);
    if (item.key) return { item };
    if (item.status === 'unavailable') return { item };
    if (item.status !== 'hidden') throw new Error('external');
    const body = new URLSearchParams({ keytype: tpk.machine_name, key: args.bundleId, keyindex: String(keyIndex(tpk)) });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    const csrf = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('csrf_cookie='));
    if (csrf) { try { headers['CSRF-Prevention-Token'] = decodeURIComponent(csrf.slice('csrf_cookie='.length)); } catch {} }
    // One POST only. Cancellation cannot undo a request already accepted by Humble.
    const result = await json('/humbler/redeemkey', { method: 'POST', headers, body: body.toString() }, operation);
    if (result?.success === false || result?.error || result?.error_msg) {
      // A retry flag alone says nothing about stock/expiry. Resolve only from
      // typed order fields, and never repeat the POST after an ambiguous result.
      const refreshed = await getOrder(args.bundleId, operation);
      item = tpks(refreshed).map(normalizeItem).find(entry => entry.id === args.itemId);
      if (item?.key || item?.status === 'unavailable') return { item };
      throw new Error('service');
    }
    const value = keyValue(result?.key ?? result?.redeemed_key_val ?? result?.key_val);
    if (value) {
      tpk.redeemed_key_val = value;
      item = normalizeItem(tpk, index);
      return { item };
    }
    // Some successes omit the value; an authoritative read resolves the outcome.
    const refreshed = await getOrder(args.bundleId, operation);
    const refreshedItems = tpks(refreshed).map(normalizeItem);
    item = refreshedItems.find(entry => entry.id === args.itemId);
    if (!item?.key) throw new Error('uncertain');
    return { item };
  }
  window.__humbleLibraryCancel = nonce => {
    if (current?.nonce === nonce) { current.cancelled = true; current.controller.abort(); }
  };
  window.__humbleLibraryRequest = async args => {
    if (location.origin !== 'https://www.humblebundle.com' || current || !args || typeof args.nonce !== 'string') return;
    const operation = { nonce: args.nonce, controller: new AbortController(), cancelled: false };
    current = operation;
    try {
      const payload = args.operation === 'auth' ? await auth(operation) : args.operation === 'sync' ? await sync(operation) : args.operation === 'reveal' ? await reveal(args, operation) : (() => { throw new Error('protocol'); })();
      await send(args.nonce, { kind: 'result', ok: true, ...payload });
    } catch (error) {
      const allowed = ['auth', 'rateLimited', 'service', 'protocol', 'network', 'cancelled', 'notFound', 'unavailable', 'external', 'uncertain'];
      await send(args.nonce, { kind: 'result', ok: false, reason: allowed.includes(error?.message) ? error.message : 'service' }).catch(() => {});
    } finally { if (current === operation) current = null; }
  };
})();
