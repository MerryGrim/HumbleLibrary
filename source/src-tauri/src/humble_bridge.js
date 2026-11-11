// Same-origin Humble adapter. This file never logs keys, credentials or raw errors.
// Protocol fields are based on the Humble front end and the public implementations:
// github.com/MrMarble/hb-key-exporter/src/util.ts
// github.com/gfargo/humble-bundle-keys/humble_bundle_keys/api.py
(() => {
  'use strict';
  const storefrontOrigins = new Set(['https://www.humblebundle.com', 'https://humblebundle.com']);
  if (window.top !== window || !storefrontOrigins.has(location.origin)) return;
  const nativeFetch = window.fetch.bind(window);
  const invoke = (...args) => window.__TAURI_INTERNALS__.invoke(...args);
  let current = null;
  window.__humbleLibraryBridgeState = () => current ? 'busy' : 'ready';
  const orders = new Map();
  const modernEntries = new Map();
  const syncPhases = new Set(['libraryPage', 'librarySchema', 'actionDiscovery', 'purchasedPage', 'purchasedWire', 'purchasedSchema', 'purchasedIdentity', 'purchasedComplete', 'detailPage', 'detailSchema', 'keySchema']);
  const protocolCodes = new Set(['flightWire', 'flightEnvelope', 'flightServerError', 'flightReference', 'flightScalar', 'flightType', 'libraryResponse', 'libraryRejected', 'libraryPagination', 'libraryEntry', 'libraryIdentity', 'detailEnvelope', 'detailComponents', 'detailEntry', 'detailIdentity']);
  function failProtocol(code) {
    const failure = new Error('protocol');
    if (protocolCodes.has(code)) failure.protocolCode = code;
    throw failure;
  }
  let modernSession = false;
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
  async function request(path, options, operation) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('protocol');
    delete operation.httpStatus;
    let response;
    try { response = await nativeFetch(path, { cache: 'no-store', credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...options.headers }, signal: operation.controller.signal }); }
    catch { const error = new Error(operation.cancelled ? 'cancelled' : 'network'); error.retryable = !operation.cancelled; throw error; }
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) operation.httpStatus = response.status;
    if (operation.cancelled) throw new Error('cancelled');
    if (response.status === 401 || response.status === 403) throw new Error('auth');
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'rateLimited' : 'service');
      error.retryable = response.status === 429 || response.status === 408 || response.status >= 500;
      const retry = response.headers?.get?.('retry-after');
      if (typeof retry === 'string' && retry.length <= 128) {
        const milliseconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        if (Number.isFinite(milliseconds)) error.retryAfterMs = Math.max(0, Math.min(60000, milliseconds));
      }
      throw error;
    }
    if (response.redirected) {
      let destination;
      try { destination = new URL(response.url); } catch { throw new Error('protocol'); }
      if (destination.username || destination.password || !storefrontOrigins.has(destination.origin)) throw new Error('auth');
      if (/\/(?:login|signin)(?:[/?#]|$)/.test(destination.pathname)) throw new Error('auth');
    }
    return response;
  }
  async function json(path, options, operation) {
    const response = await request(path, options, operation);
    try { return await response.json(); } catch { throw new Error('protocol'); }
  }
  async function pageText(path, operation) {
    const response = await request(path, { headers: { Accept: 'text/html' } }, operation);
    let url;
    try { url = new URL(response.url); } catch { throw new Error('protocol'); }
    if (!storefrontOrigins.has(url.origin) || url.username || url.password
        || url.pathname !== new URL(path, location.origin).pathname) throw new Error('auth');
    const bytes = await window.__humbleLibraryFlight.read(response, operation.controller.signal);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('protocol'); }
  }
  function bundleRoute(item) {
    // The official Bundles tab links this purchase container. Purchased rows
    // and their individual content routes are never library tiles.
    const id = item.productEntitlementId ?? item.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new Error('protocol');
    return { id: 'bundle-' + id, path: '/home/library/' + encodeURIComponent(id) };
  }
  function decodeModernDetail(html, operation) {
    try {
      const detail = window.__humbleLibraryPage.decodeDetailHtml(html);
      operation.detailComponentsCount = detail.parts?.length ?? 1;
      return detail;
    } catch (failure) {
      if (Number.isInteger(failure?.detailComponentsCount) && failure.detailComponentsCount >= 0
          && failure.detailComponentsCount <= 10000) operation.detailComponentsCount = failure.detailComponentsCount;
      throw failure;
    }
  }
  function normalizeDetail(detail, path, fallbackTitle) {
    const parts = detail.parts ?? [detail], items = [], entries = new Map();
    if (!Array.isArray(parts) || !parts.length || parts.length > 10000) failProtocol('detailComponents');
    for (const part of parts) {
      const source = part.userLibraryItem;
      if (!source || typeof source !== 'object' || Array.isArray(source)) failProtocol('detailEntry');
      let normalized;
      try {
        normalized = window.__humbleLibraryItems.normalize({ ...source,
          title: text(source.title, 1000) || fallbackTitle || 'Humble Bundle', entitlements: source.entitlements ?? {} });
      } catch { failProtocol('detailEntry'); }
      for (const value of normalized) {
        const item = { ...value, redeemUrl: value.redeemUrl || new URL(path, location.origin).href };
        const entitlement = source.entitlements?.keys?.find(entry => entry.id === item.id);
        const identity = JSON.stringify([entitlement ? 'key' : 'download', entitlement?.keyIntegrationId ?? null]);
        const previous = entries.get(item.id);
        if (previous) {
          if (previous.identity !== identity || previous.item.key !== item.key || previous.item.status !== item.status
              || previous.item.platform !== item.platform) failProtocol('detailIdentity');
          // The same entitlement can be rendered in several child sections.
          // Cosmetic titles are not ownership or mutation identifiers.
          if (item.instructions && item.instructions !== previous.item.instructions) {
            previous.item.instructions = text([previous.item.instructions, item.instructions].filter(Boolean).join('\n\n'), 12000);
          }
          continue;
        }
        if (items.length >= 10000) failProtocol('detailEntry');
        entries.set(item.id, { item, entitlement, identity }); items.push(item);
      }
    }
    return { items, entries };
  }
  function detailDiagnostic(operation, failure) {
    const result = {};
    if (['detailPage', 'detailSchema', 'keySchema'].includes(operation.phase)) {
      for (const name of ['detailComponentsCount', 'completedDetails', 'totalDetails']) {
        if (Number.isInteger(operation[name]) && operation[name] >= 0 && operation[name] <= 10000) result[name] = operation[name];
      }
      if (protocolCodes.has(failure?.protocolCode)) result.protocolCode = failure.protocolCode;
    }
    return result;
  }
  function purchaseMetadata(value) {
    if (typeof value === 'string' && value.trim() && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
    return null;
  }
  async function discoverAction(html, operation, name) {
    if (name !== 'redeemEntitlementAction') throw new Error('protocol');
    const paths = new Set();
    // Page modules can be loaded by the Next runtime from Flight import rows
    // without appearing in the original document's script elements.
    for (const source of window.__humbleLibraryPage.scriptPathsFromHtml(html, location.origin)) {
      let url;
      try { url = new URL(source, location.origin); } catch { continue; }
      if (url.origin === location.origin && !url.username && !url.password
          && /^\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js$/.test(url.pathname)) paths.add(url.pathname + url.search);
    }
    if (!paths.size || paths.size > 160) throw new Error('protocol');
    const queue = [...paths];
    let action = null, totalBytes = 0;
    // Only site-owned JavaScript is read as text. No downloaded code executes.
    for (let offset = 0; offset < queue.length && !action; offset += 3) {
      const results = await Promise.all(queue.slice(offset, offset + 3).map(async path => {
        const response = await request(path, { headers: { Accept: 'text/javascript' } }, operation);
        let received;
        try { received = new URL(response.url); } catch { throw new Error('protocol'); }
        if (!storefrontOrigins.has(received.origin) || received.pathname !== new URL(path, location.origin).pathname) throw new Error('protocol');
        const bytes = await window.__humbleLibraryFlight.read(response, operation.controller.signal);
        if (bytes.length > 4 * 1024 * 1024) throw new Error('protocol');
        totalBytes += bytes.length;
        if (totalBytes > 32 * 1024 * 1024) throw new Error('protocol');
        let script;
        try { script = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('protocol'); }
        return window.__humbleLibraryPage.extractActionReferences(script, [name])[name];
      }));
      for (const found of results.filter(Boolean)) {
        if (action && action !== found) throw new Error('protocol');
        action = found;
      }
    }
    if (!action) throw new Error('protocol');
    return action;
  }
  function routerHeader() {
    try {
      const current = window.history?.state?.__PRIVATE_NEXTJS_INTERNALS_TREE;
      const tree = current?.tree ?? current;
      if (!Array.isArray(tree)) return {};
      let nodes = 0;
      const prepare = (tree, depth = 0) => {
        if (++nodes > 10000 || depth > 100 || !Array.isArray(tree)
            || !tree[1] || typeof tree[1] !== 'object' || Array.isArray(tree[1])) throw new Error('protocol');
        const [segment, children, , refetch, rootLayout] = tree;
        if (typeof segment !== 'string' && (!Array.isArray(segment) || segment.length < 3)) throw new Error('protocol');
        const routes = {};
        for (const [name, child] of Object.entries(children)) {
          if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('protocol');
          routes[name] = prepare(child, depth + 1);
        }
        // Match Next's non-HMR prepareFlightRouterStateForRequest. Private
        // navigation/cache fields do not belong in the request header.
        const result = [typeof segment === 'string' ? segment : [segment[0], segment[1], segment[2], null], routes];
        if (refetch) { result[2] = null; result[3] = refetch; }
        if (rootLayout !== undefined) result[4] = rootLayout;
        return result;
      };
      const encoded = encodeURIComponent(JSON.stringify(prepare(tree)));
      return encoded.length <= 65536 ? { 'Next-Router-State-Tree': encoded } : {};
    } catch { return {}; }
  }
  async function syncModern(operation) {
    const coordinator = window.__humbleLibrarySync;
    if (!coordinator || typeof coordinator.run !== 'function') throw new Error('protocol');
    let readSequence = 0, identity = null, accountKey = null;
    let completedDetails = 0, totalDetails = 0;
    const nextEntries = new Map(), reported = new WeakSet();
    const diagnosticFields = ['phase', 'httpStatus', 'requestedPage', 'pageRows', 'overlapRows',
      'detailComponentsCount', 'completedDetails', 'totalDetails'];
    // Each attempt gets an isolated context. A response arriving after timeout
    // or cancellation cannot overwrite the next attempt's diagnostics/state.
    const execute = async (phase, signal, task) => {
      const sequence = ++readSequence;
      const context = { nonce: operation.nonce, kind: 'sync', controller: { signal }, phase,
        completedDetails, totalDetails, get cancelled() { return operation.cancelled; } };
      try { return await task(context); }
      catch (failure) {
        const error = failure instanceof Error ? failure : new Error('service');
        for (const name of diagnosticFields) {
          if (context[name] !== undefined && !Object.prototype.hasOwnProperty.call(error, name)) {
            Object.defineProperty(error, name, { value: context[name] });
          }
        }
        throw error;
      } finally {
        if (sequence === readSequence && current === operation) {
          for (const name of diagnosticFields) {
            delete operation[name];
            if (context[name] !== undefined) operation[name] = context[name];
          }
        }
      }
    };
    const adapter = {
      index: signal => execute('libraryPage', signal, async context => {
        const html = await pageText('/home/library', context);
        context.phase = 'librarySchema';
        const library = window.__humbleLibraryPage.decodeLibraryHtml(html);
        identity = library.accountIdentity;
        if (typeof identity !== 'string' || !identity) throw new Error('auth');
        const digest = await globalThis.crypto.subtle.digest('SHA-256',
          new TextEncoder().encode('humble-library-account-v1\0' + identity));
        accountKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        await send(operation.nonce, { kind: 'session', authenticated: true });
        return { html, library };
      }),
      plan: root => {
        const sources = new Map();
        for (const item of root.library.bundleItems) {
          const route = bundleRoute(item), previous = sources.get(route.path);
          sources.set(route.path, { read: true, route, item: { ...item,
            purchasedAt: purchaseMetadata(previous?.item.purchasedAt) || purchaseMetadata(item.purchasedAt) } });
        }
        totalDetails = sources.size;
        return [...sources.values()];
      },
      detail: (source, signal) => execute('detailPage', signal, async context => {
        const row = source.item, path = source.route.path;
        const base = { id: source.route.id, title: text(row.title, 1000) || 'Humble Bundle', imageUrl: '',
          purchasedAt: purchaseMetadata(row.purchasedAt), sourceUrl: new URL(path, location.origin).href };
        const html = await pageText(path, context);
        context.phase = 'detailSchema';
        const detail = decodeModernDetail(html, context);
        if (detail.accountIdentity !== identity) throw new Error('auth');
        context.phase = 'keySchema';
        const { items } = normalizeDetail(detail, path, base.title);
        completedDetails++; context.completedDetails = completedDetails;
        nextEntries.set(source.route.id, { path });
        const detailDate = detail.parts.map(part => purchaseMetadata(part.userLibraryItem.purchasedAt)).find(Boolean);
        return { ...base, purchasedAt: base.purchasedAt || detailDate || null, items };
      }),
      failed: async (source, failure) => {
        if (failure && typeof failure === 'object' && !reported.has(failure)) {
          reported.add(failure);
          const payload = { kind: 'syncWarning', reason: ['protocol', 'network', 'rateLimited', 'service'].includes(failure.message)
            ? failure.message : 'service', phase: syncPhases.has(failure.phase) ? failure.phase : 'detailPage' };
          if (protocolCodes.has(failure.protocolCode)) payload.protocolCode = failure.protocolCode;
          else if (failure.message === 'protocol') payload.protocolCode = payload.phase === 'keySchema' ? 'detailEntry' : 'detailEnvelope';
          if (Number.isInteger(failure.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599) payload.httpStatus = failure.httpStatus;
          if (['detailPage', 'detailSchema', 'keySchema'].includes(payload.phase)) {
            for (const name of ['detailComponentsCount', 'completedDetails', 'totalDetails']) {
              if (Number.isInteger(failure[name]) && failure[name] >= 0 && failure[name] <= 10000) payload[name] = failure[name];
            }
          }
          await send(operation.nonce, payload);
        }
        const row = source.item, path = source.route.path;
        return { id: source.route.id,
          title: text(row.title, 1000) || 'Humble Bundle', imageUrl: '',
          purchasedAt: purchaseMetadata(row.purchasedAt), sourceUrl: new URL(path, location.origin).href,
          items: [], detailsFailed: true };
      },
      verify: (root, signal) => execute('libraryPage', signal, async context => {
        const html = await pageText('/home/library', context);
        context.phase = 'librarySchema';
        if (window.__humbleLibraryPage.decodeLibraryHtml(html).accountIdentity !== identity) throw new Error('auth');
      }),
      emit: payload => send(operation.nonce, payload),
    };
    const result = await coordinator.run(adapter, { signal: operation.controller.signal });
    if (operation.cancelled || current !== operation) throw new Error('cancelled');
    modernEntries.clear();
    for (const [id, item] of nextEntries) modernEntries.set(id, item);
    return { ...result, accountKey, sourceProtocol: 'modern', sourceProjection: 'bundles-v1', parentIndexComplete: true };
  }
  function modernPath(id) {
    const match = /^(bundle|group|content)-([a-zA-Z0-9_-]{1,256})$/.exec(id || '');
    if (!match) return null;
    return `/home/library/${match[1] === 'bundle' ? '' : match[1] + '/'}${encodeURIComponent(match[2])}`;
  }
  async function revealModern(args, operation, path) {
    const html = await pageText(path, operation);
    const detail = decodeModernDetail(html, operation);
    const { entries } = normalizeDetail(detail, path, 'Humble Bundle');
    const selected = entries.get(args.itemId);
    const item = selected?.item;
    if (!item) throw new Error('notFound');
    if (item.key || item.status === 'unavailable') return { item };
    if (item.status !== 'hidden') throw new Error('external');
    const entitlement = selected.entitlement;
    if (!entitlement || typeof entitlement.keyIntegrationId !== 'string'
        || !/^[a-zA-Z0-9_-]{1,160}$/.test(entitlement.keyIntegrationId)) throw new Error('external');
    const action = await discoverAction(html, operation, 'redeemEntitlementAction');
    let result;
    try {
      // Exactly one user-requested mutation. React serializes an omitted
      // credential as $undefined; no account-linking or group choice is made.
      const response = await request(path, { method: 'POST', headers: {
        Accept: 'text/x-component', 'Next-Action': action, ...routerHeader(),
        'Content-Type': 'text/plain;charset=UTF-8',
      }, body: JSON.stringify([entitlement.id, entitlement.keyIntegrationId, '$undefined']) }, operation);
      let destination;
      try { destination = new URL(response.url); } catch { throw new Error('uncertain'); }
      if (!storefrontOrigins.has(destination.origin) || destination.username || destination.password
          || destination.pathname !== path) throw new Error('uncertain');
      if (response.headers.get('x-action-redirect') || response.headers.get('x-nextjs-action-not-found') === '1'
          || !response.headers.get('content-type')?.toLowerCase().startsWith('text/x-component')) throw new Error('uncertain');
      result = window.__humbleLibraryItems.normalizeRedeemResult(window.__humbleLibraryFlight.decode(
        await window.__humbleLibraryFlight.read(response, operation.controller.signal)));
    } catch (failure) {
      if (failure?.message === 'auth' || failure?.message === 'rateLimited') throw failure;
      throw new Error('uncertain');
    }
    if (!result) throw new Error('service');
    if (result.key) return { item: { ...item, key: result.key, status: 'revealed' } };
    // Some provider operations return no printable license; preserve that
    // distinction instead of treating a grant as a key or repeating the POST.
    return { item: { ...item, key: null, status: 'external' } };
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
  async function libraryOrderIds(operation) {
    // The established library bootstrap is also used by Playnite and GameIndex:
    // github.com/Lacro59/playnite-plugincommon/blob/b19aa9f49f65921900b850ad6c970ef093d76d1a/CommonPlayniteShared/PluginLibrary/HumbleLibrary/Services/HumbleAccountClient.cs#L53-L67
    // Fetch it afresh; a cached DOM or a few visible purchase links are not proof.
    const response = await request('/home/library', { headers: { Accept: 'text/html' } }, operation);
    let destination;
    try { destination = new URL(response.url); } catch { throw new Error('protocol'); }
    if (destination.username || destination.password || !storefrontOrigins.has(destination.origin) || !/^\/home\/library\/?$/.test(destination.pathname)) throw new Error('auth');
    const limit = 16 * 1024 * 1024;
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('protocol');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (operation.cancelled) throw new Error('cancelled');
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) {
          await reader.cancel().catch(() => {});
          throw new Error('protocol');
        }
        chunks.push(decoder.decode(chunk.value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } catch (error) {
      if (error?.message === 'protocol' || error?.message === 'cancelled') throw error;
      throw new Error(operation.cancelled ? 'cancelled' : 'network');
    } finally { reader.releaseLock(); }
    const document = new DOMParser().parseFromString(chunks.join(''), 'text/html');
    const blocks = document.querySelectorAll('script#user-home-json-data');
    if (blocks.length === 0 && typeof window.__humbleLibraryPage?.decodeLibraryHtml === 'function') {
      window.__humbleLibraryPage.decodeLibraryHtml(chunks.join(''));
      modernSession = true;
      return null;
    }
    if (blocks.length !== 1) throw new Error('protocol');
    const source = blocks[0].textContent || '';
    if (new TextEncoder().encode(source).byteLength > limit) throw new Error('protocol');
    let data;
    try { data = JSON.parse(source); } catch { throw new Error('protocol'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('protocol');
    return orderIds(data.gamekeys);
  }
  async function getOrderIds(operation) {
    try { return orderIds(await json('/api/v1/user/order', {}, operation)); }
    catch (error) {
      if (error?.message !== 'service' || operation.httpStatus !== 404) throw error;
      return libraryOrderIds(operation);
    }
  }
  async function auth(operation) {
    // The current storefront itself uses this read-only route to revalidate
    // AuthProvider (SessionRevalidator in its client bundle). A successful cart
    // action or a page URL is never evidence of an authenticated session.
    try {
      const response = await request('/api/auth/session-status', {}, operation);
      let destination;
      try { destination = new URL(response.url); } catch { throw new Error('protocol'); }
      if (destination.username || destination.password || !storefrontOrigins.has(destination.origin)
          || destination.pathname !== '/api/auth/session-status') throw new Error('auth');
      let status;
      try { status = await response.json(); } catch { throw new Error('protocol'); }
      if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('protocol');
      if (status.status === 'anonymous') throw new Error('auth');
      if (status.status !== 'authenticated') throw new Error('protocol');
      modernSession = true;
    } catch (failure) {
      // Retain compatibility with the previous storefront only when the new
      // route is absent. A rejected/unknown session never falls back to cache.
      if (failure?.message !== 'service' || operation.httpStatus !== 404) throw failure;
      await getOrderIds(operation);
    }
    // Authentication probes never return account records or key material.
    return { authenticated: true };
  }
  async function sync(operation) {
    if (modernSession) return syncModern(operation);
    const ids = await getOrderIds(operation);
    if (modernSession) return syncModern(operation);
    // This proof precedes every order/detail/cover read. The native side binds
    // it to the active sync nonce and never infers login from a local snapshot.
    await send(operation.nonce, { kind: 'session', authenticated: true });
    const bundles = [];
    for (let index = 0; index < ids.length; index++) {
      if (operation.cancelled) throw new Error('cancelled');
      const order = await getOrder(ids[index], operation);
      // Keep purchases without keys visible too: their content/instructions may matter.
      const bundle = normalizeOrder(order, ids[index]);
      // Banner discovery is temporarily paused. Preserve API metadata, but do
      // not fetch purchase HTML or CDN images during library synchronization.
      bundles.push(bundle);
      await send(operation.nonce, { kind: 'progress', completed: index + 1, total: ids.length });
      if (index + 1 < ids.length) await new Promise(resolve => setTimeout(resolve, 120));
    }
    return { bundles, syncedAt: new Date().toISOString(), enumerationComplete: true, sourceProtocol: 'legacy' };
  }
  async function reveal(args, operation) {
    const path = modernEntries.get(args.bundleId)?.path || modernPath(args.bundleId);
    if (path) return revealModern(args, operation, path);
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
    const operation = current;
    if (operation?.nonce === nonce) {
      operation.cancelled = true; operation.controller.abort();
      // A timed-out read-only probe may be stuck waiting for an IPC reply that
      // its native caller has already abandoned. It must not block later probes.
      // Read-only jobs may be replaced immediately. Their detached completions
      // remain bound to the old nonce. Reveal mutations stay serialized.
      if (['auth', 'sync'].includes(operation.kind) && current === operation) current = null;
    }
  };
  window.__humbleLibraryRequest = async args => {
    if (!storefrontOrigins.has(location.origin) || current || !args || typeof args.nonce !== 'string') return;
    const operation = { nonce: args.nonce, kind: args.operation, controller: new AbortController(), cancelled: false };
    current = operation;
    try {
      const payload = args.operation === 'auth' ? await auth(operation) : args.operation === 'sync' ? await sync(operation) : args.operation === 'reveal' ? await reveal(args, operation) : (() => { throw new Error('protocol'); })();
      if (args.operation === 'sync' && (operation.cancelled || current !== operation)) throw new Error('cancelled');
      await send(args.nonce, { kind: 'result', ok: true, ...payload });
    } catch (error) {
      const allowed = ['auth', 'rateLimited', 'service', 'protocol', 'network', 'cancelled', 'notFound', 'unavailable', 'external', 'uncertain'];
      const diagnostic = (args.operation === 'auth' || args.operation === 'sync' && syncPhases.has(operation.phase))
        && Number.isInteger(operation.httpStatus) ? { httpStatus: operation.httpStatus } : {};
      const phase = args.operation === 'sync' && syncPhases.has(operation.phase) ? { phase: operation.phase } : {};
      const protocol = args.operation === 'sync' && protocolCodes.has(error?.protocolCode) ? { protocolCode: error.protocolCode } : {};
      const pagination = {};
      if (args.operation === 'sync' && /^purchased(?:Page|Wire|Schema|Identity|Complete)$/.test(operation.phase)) {
        for (const name of ['requestedPage', 'pageRows', 'overlapRows']) {
          const value = operation[name], limit = name === 'requestedPage' ? 2000 : 10000;
          if (Number.isInteger(value) && value >= (name === 'requestedPage' ? 1 : 0) && value <= limit) pagination[name] = value;
        }
      }
      await send(args.nonce, { kind: 'result', ok: false, reason: allowed.includes(error?.message) ? error.message : 'service', ...diagnostic, ...phase, ...protocol, ...pagination,
        ...(args.operation === 'sync' ? detailDiagnostic(operation, error) : {}) }).catch(() => {});
    } finally { if (current === operation) current = null; }
  };
})();
