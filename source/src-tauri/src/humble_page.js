// Passive parser for the current Humble Next page contract. Scripts are data:
// they are never installed, evaluated, imported or followed to another URL.
(() => {
  'use strict';
  const LIMIT = 16 * 1024 * 1024;
  const MAX_ROWS = 100000;
  const idPattern = /^[a-zA-Z0-9_-]{1,256}$/;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = protocolCode => {
    const error = new Error('protocol');
    if (protocolCode !== undefined) Object.defineProperty(error, 'protocolCode', { value: protocolCode });
    throw error;
  };
  const bounded = value => {
    if (typeof value !== 'string' || value.length > LIMIT || new TextEncoder().encode(value).byteLength > LIMIT) fail();
    return value;
  };
  const validId = value => typeof value === 'string' && idPattern.test(value);

  function pushes(source) {
    const result = [];
    let cursor = 0;
    const prefix = 'self.__next_f.push(';
    while ((cursor = source.indexOf(prefix, cursor)) !== -1) {
      const start = cursor + prefix.length;
      let end = start, quoted = false, escaped = false, depth = 0;
      for (; end < source.length; end++) {
        const char = source[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '(') depth++;
        else if (char === ')') { if (depth === 0) break; depth--; }
      }
      if (end === source.length || quoted) fail();
      let value;
      try { value = JSON.parse(source.slice(start, end)); } catch { return fail(); }
      if (!Array.isArray(value)) fail();
      if (value[0] === 0 && value.length === 1 || value[0] === 2 && value.length === 2) { cursor = end + 1; continue; }
      if (value.length !== 2 || value[0] !== 1 || typeof value[1] !== 'string') fail();
      result.push(value[1]);
      cursor = end + 1;
    }
    return result;
  }

  function pageModels(html) {
    const doc = new DOMParser().parseFromString(bounded(html), 'text/html');
    const chunks = [];
    for (const script of doc.querySelectorAll('script:not([src])')) chunks.push(...pushes(script.textContent || ''));
    if (!chunks.length) fail();
    const bytes = new TextEncoder().encode(bounded(chunks.join('')));
    const rows = new Map();
    const decodeText = value => { try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { return fail(); } };
    const parseHex = value => {
      if (!/^[0-9a-f]{1,14}$/.test(value)) fail();
      const result = Number.parseInt(value, 16);
      if (!Number.isSafeInteger(result)) fail();
      return result;
    };
    let cursor = 0;
    while (cursor < bytes.length) {
      const colon = bytes.indexOf(58, cursor);
      if (colon < 0 || colon - cursor > 14 || rows.size >= MAX_ROWS) fail();
      // Resource hint rows have no model ID. Keep them inert; never preload.
      if (colon === cursor && bytes[colon + 1] === 72) {
        const end = bytes.indexOf(10, colon + 2);
        if (end < 0) fail();
        cursor = end + 1;
        continue;
      }
      const id = parseHex(decodeText(bytes.subarray(cursor, colon))).toString(16);
      cursor = colon + 1;
      let tag = String.fromCharCode(bytes[cursor]);
      let raw;
      if ('TAOobUSsLlGgMmV'.includes(tag)) {
        const comma = bytes.indexOf(44, ++cursor);
        if (comma < 0 || comma - cursor > 14) fail();
        const length = parseHex(decodeText(bytes.subarray(cursor, comma)));
        cursor = comma + 1;
        if (length > bytes.length - cursor) fail();
        raw = tag === 'T' ? decodeText(bytes.subarray(cursor, cursor + length)) : '';
        cursor += length;
      } else {
        if (/^[A-Z#rx]$/.test(tag)) cursor++;
        else tag = 'model';
        const newline = bytes.indexOf(10, cursor);
        if (newline < 0) fail();
        raw = decodeText(bytes.subarray(cursor, newline)); cursor = newline + 1;
      }
      if (tag === 'E') fail();
      if (rows.has(id)) {
        // Next may send an unrelated empty async iterable in page metadata.
        // It is not treated as a library result or used as ownership proof.
        if (tag === 'C' && rows.get(id).tag === 'X' && raw === '') { rows.set(id, { tag: 'closed-stream' }); continue; }
        fail();
      }
      let value = raw;
      if (tag === 'model' || tag === 'I') { try { value = JSON.parse(raw); } catch { return fail(); } }
      rows.set(id, { tag, value });
    }
    if ([...rows.values()].some(row => row.tag === 'X')) fail();
    const flight = window.__humbleLibraryFlight;
    if (!flight || typeof flight.decode !== 'function') fail();
    function project(value) {
      let wire = `0:${JSON.stringify({ a: value })}\n`;
      for (const [id, row] of rows) {
        if (id === '0') continue;
        if (row.tag === 'model') wire += `${id}:${JSON.stringify(row.value)}\n`;
        else if (row.tag === 'T') wire += `${id}:T${new TextEncoder().encode(row.value).byteLength.toString(16)},${row.value}`;
      }
      return flight.decode(wire);
    }
    function unwrap(value, depth = 0, seen = new Set()) {
      for (; depth <= 100; depth++) {
        if (typeof value !== 'string' || !/^\$(?:@)?[0-9a-f]+(?::.*)?$/.test(value)) return value;
        const match = /^\$(?:@)?([0-9a-f]+)(?::(.*))?$/.exec(value);
        if (seen.has(value)) fail(); seen.add(value);
        const row = rows.get(match[1]);
        if (!row || !['model', 'T'].includes(row.tag)) fail();
        value = row.value;
        if (match[2]) for (const key of match[2].split(':')) {
          value = unwrap(value, depth + 1, seen);
          if (['__proto__', 'constructor', 'prototype'].includes(key) || !record(value) && !Array.isArray(value) || !own(value, key)) fail();
          value = value[key];
        }
      }
      return fail();
    }
    const moduleChunks = [];
    for (const row of rows.values()) {
      if (row.tag !== 'I') continue;
      if (!Array.isArray(row.value) || row.value.length < 3 || !Array.isArray(row.value[1])) fail();
      const paths = project(row.value[1]);
      if (!Array.isArray(paths) || paths.length > 160 || !paths.every(value => typeof value === 'string' && value.length <= 2048)) fail();
      moduleChunks.push(...paths);
    }
    const components = [];
    let count = 0;
    for (const row of rows.values()) {
      if (row.tag !== 'model') continue;
      const pending = [{ value: row.value, depth: 0 }];
      while (pending.length) {
        const { value, depth } = pending.pop();
        if (++count > MAX_ROWS || depth > 100) fail();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value) && value.length >= 4 && value[0] === '$' && typeof value[1] === 'string') {
          const match = /^\$L?([0-9a-f]+)$/.exec(value[1]);
          const module = match && rows.get(match[1]);
          if (module?.tag === 'I' && Array.isArray(module.value)) {
            // React import metadata is [id, chunks, exportName, async?]. The
            // optional async marker is not part of the component's name.
            const name = project(module.value[2]);
            if (['AuthProvider', 'UserLibrary', 'ProductKeysDownloads'].includes(name)) components.push({ name, props: unwrap(value[3]) });
          }
        }
        const children = Object.values(value);
        for (let index = children.length - 1; index >= 0; index--) pending.push({ value: children[index], depth: depth + 1 });
      }
    }
    return { components, project, unwrap, moduleChunks, doc };
  }

  function authenticated(page) {
    const providers = page.components.filter(component => component.name === 'AuthProvider');
    if (!providers.length) throw new Error('auth');
    let identity = null;
    for (const { props } of providers) {
      if (!record(props) || !own(props, 'user')) throw new Error('auth');
      const user = page.unwrap(props.user);
      if (!record(user)) throw new Error('auth');
      const id = own(user, 'id') ? page.project(user.id) : undefined;
      const email = own(user, 'email') ? page.project(user.email) : undefined;
      if (!validId(id) || typeof email !== 'string' || !email.includes('@') || email.length > 320 || identity !== null && identity !== id) throw new Error('auth');
      identity = id;
    }
    return identity;
  }

  function entry(value, requireEntitlements = false, nullableVault = false) {
    if (!record(value) || !validId(value.id) || typeof value.title !== 'string' || value.title.length > 1000) fail('libraryEntry');
    if (value.itemType !== undefined && !['content-entitlement', 'entitlement-group'].includes(value.itemType)) fail('libraryEntry');
    if (value.entitlements !== undefined && !(nullableVault && value.entitlements === null)) {
      if (!record(value.entitlements)) fail('libraryEntry');
      const lists = nullableVault ? [value.entitlements.downloads] : [value.entitlements.keys, value.entitlements.downloads];
      for (const list of lists) {
        if (list === undefined || nullableVault && list === null) continue;
        if (!Array.isArray(list) || list.length > 10000 || !list.every(item => record(item) && validId(item.id))) fail('libraryEntry');
      }
    } else if (requireEntitlements) fail('libraryEntry');
    const { userId, ...safe } = value;
    return safe;
  }

  function entries(value, nullableVault = false, allowRepeatedIds = false) {
    if (!Array.isArray(value) || value.length > 10000) fail('libraryEntry');
    const result = value.map(item => entry(item, false, nullableVault));
    if (!allowRepeatedIds && new Set(result.map(item => item.id)).size !== result.length) fail('libraryEntry');
    return result;
  }

  function decodeLibraryHtml(html) {
    const page = pageModels(html);
    const identity = authenticated(page);
    const libraries = page.components.filter(component => component.name === 'UserLibrary');
    if (libraries.length !== 1 || !record(libraries[0].props)) fail();
    const props = libraries[0].props;
    if (!own(props, 'bundleItems')) fail('libraryEntry');
    const roots = page.unwrap(props.bundleItems);
    if (!Array.isArray(roots) || roots.length > 10000) fail('libraryEntry');
    const bundleItems = roots.map(value => {
      const source = page.unwrap(value);
      if (!record(source)) fail('libraryEntry');
      // The official Bundles row consumes only this route and its title.
      // Unused wrapper entitlement models may contain unrelated references.
      const parentId = (own(source, 'productEntitlementId') ? page.project(source.productEntitlementId) : undefined)
        ?? (own(source, 'id') ? page.project(source.id) : undefined);
      const title = own(source, 'title') ? page.project(source.title) : undefined;
      if (!validId(parentId) || typeof title !== 'string' || title.length > 1000) fail('libraryEntry');
      const result = { id: parentId, productEntitlementId: parentId, title };
      try { if (own(source, 'purchasedAt')) {
        const date = page.project(source.purchasedAt);
        if (typeof date === 'string' && date.length <= 100 && !/[\u0000-\u001f\u007f]/.test(date)
            || date instanceof Date && Number.isFinite(date.getTime())) result.purchasedAt = date;
      } } catch { /* Optional date metadata cannot hide an owned bundle. */ }
      return result;
    });
    const result = {
      authenticated: true,
      bundleItems,
      // Bundles is an independent complete parent index. Flat Purchased and
      // Vault props are unrelated to it and must not become purchase tiles or
      // block this projection when those unconsumed props change shape.
    };
    // Kept only inside the adapter to bind read responses to one account.
    // This value must not enter DTOs, diagnostics or the application UI.
    Object.defineProperty(result, 'accountIdentity', { value: identity });
    return result;
  }

  function decodeDetailHtml(html) {
    const detailFail = (code, count) => {
      const error = new Error('protocol');
      Object.defineProperty(error, 'protocolCode', { value: code });
      if (Number.isSafeInteger(count) && count >= 0 && count <= 10000) Object.defineProperty(error, 'detailComponentsCount', { value: count });
      throw error;
    };
    let page;
    try { page = pageModels(html); }
    catch { detailFail('detailEnvelope'); }
    let identity;
    try { identity = authenticated(page); }
    catch (error) { if (error?.message === 'auth') throw error; detailFail('detailEnvelope'); }
    const details = page.components.filter(component => component.name === 'ProductKeysDownloads');
    const count = details.length;
    if (count === 0 || count > 10000) detailFail('detailComponents', count);
    const parts = details.map(component => {
      try {
        const props = component.props;
        if (!record(props) || !own(props, 'userLibraryItem')) detailFail('detailEntry', count);
        const source = page.unwrap(props.userLibraryItem);
        if (!record(source)) detailFail('detailEntry', count);
        // This component consumes titles and entitlement lists. Its parent ID,
        // itemType and other metadata do not establish membership in the URL.
        const item = {};
        for (const name of ['id', 'title', 'purchasedAt']) {
          if (!own(source, name)) continue;
          try {
            const value = page.project(source[name]);
            if (typeof value === 'string' || name === 'purchasedAt' && value instanceof Date && Number.isFinite(value.getTime())) item[name] = value;
          } catch { /* Unused parent metadata cannot hide valid keys. */ }
        }
        let entitlements = page.unwrap(source.entitlements);
        if (entitlements === undefined || entitlements === null || entitlements === '$undefined') entitlements = {};
        if (!record(entitlements)) detailFail('detailEntry', count);
        item.entitlements = {};
        for (const name of ['keys', 'downloads', 'redemptionGroups']) {
          let list = own(entitlements, name) ? page.project(entitlements[name]) : undefined;
          if (list === undefined || name === 'redemptionGroups' && list === null) list = [];
          if (!Array.isArray(list) || list.length > 10000 || !list.every(value => record(value))) detailFail('detailEntry', count);
          if (name !== 'redemptionGroups' && !list.every(value => typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(value.id))) detailFail('detailEntry', count);
          item.entitlements[name] = list;
        }
        let productEntitlementId = null;
        try {
          const value = page.project(props.productEntitlementId);
          if (typeof value === 'string' && value.length <= 1000) productEntitlementId = value;
        } catch { /* Download context is optional and is not a route identity. */ }
        return { userLibraryItem: item, productEntitlementId, showDisclaimer: props.showDisclaimer === true };
      } catch { detailFail('detailEntry', count); }
    });
    const result = { ...parts[0], parts, detailComponentsCount: count };
    Object.defineProperty(result, 'accountIdentity', { value: identity });
    return result;
  }

  function decodeLibraryResult(value) {
    if (!record(value) || typeof value.success !== 'boolean') fail('libraryResponse');
    if (value.success === false) {
      // The official client treats this as an application failure, even when
      // HTTP is 200. It is never an empty/successful page or the next state.
      const error = new Error('service');
      Object.defineProperties(error, {
        protocolCode: { value: 'libraryRejected' }, retryable: { value: true },
      });
      throw error;
    }
    const pagination = value.pagination;
    if (!record(pagination) || !Number.isSafeInteger(pagination.totalPages) || pagination.totalPages < 0 || pagination.totalPages > 10000 || !Number.isSafeInteger(pagination.totalDocs) || pagination.totalDocs < 0 || pagination.totalDocs > 100000) fail('libraryPagination');
    // Purchased rows can share an ID while carrying different entitlement or
    // route context. Validate every row; page traversal owns replay checks.
    const results = entries(value.results, false, true);
    if (results.length > pagination.totalDocs || pagination.totalDocs > 0 && results.length === 0) fail('libraryPagination');
    const totalPages = pagination.totalPages === 0 && pagination.totalDocs === 0 && results.length === 0 ? 1 : pagination.totalPages;
    if (totalPages < 1) fail('libraryPagination');
    // Returned page/requestId belong to the website's shared UI state. The
    // caller binds each serialized HTTP response to its own requested page.
    return { results, pagination: { totalPages, totalDocs: pagination.totalDocs } };
  }

  function scriptPathsFromHtml(html, origin = location.origin) {
    const origins = new Set(['https://www.humblebundle.com', 'https://humblebundle.com']);
    if (!origins.has(origin)) fail();
    const page = pageModels(html);
    const candidates = [...page.moduleChunks];
    for (const element of page.doc.querySelectorAll('script[src],link[rel="preload"][as="script"],link[rel="modulepreload"]')) {
      candidates.push(element.getAttribute(element.tagName.toLowerCase() === 'script' ? 'src' : 'href'));
    }
    const paths = new Set();
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      let url;
      try { url = new URL(candidate, origin); } catch { continue; }
      if (!origins.has(url.origin) || url.username || url.password || url.search || url.hash || !/^\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js$/.test(url.pathname)) continue;
      paths.add(url.pathname);
      if (paths.size > 160) fail();
    }
    if (!paths.size) fail();
    return [...paths];
  }

  function extractActionReferences(script, allowedNames) {
    bounded(script);
    if (!Array.isArray(allowedNames) || allowedNames.length > 16 || !allowedNames.every(name => ['filterUserLibrary', 'redeemEntitlementAction'].includes(name))) fail();
    const allowed = new Set(allowedNames), result = {};
    const call = /^createServerReference\)?\(\s*"([0-9a-f]{40,64})"\s*,\s*[A-Za-z_$][\w$]*\.callServer\s*,\s*void\s+0\s*,\s*[A-Za-z_$][\w$]*\.findSourceMapURL\s*,\s*"([A-Za-z_$][\w$]*)"\s*\)/;
    let previous = '';
    for (let index = 0; index < script.length;) {
      const char = script[index];
      if (char === '"' || char === "'" || char === '`') {
        const quote = char; index++;
        while (index < script.length) { if (script[index] === '\\') index += 2; else if (script[index++] === quote) break; }
        previous = 's'; continue;
      }
      if (script.startsWith('//', index)) { const end = script.indexOf('\n', index + 2); index = end < 0 ? script.length : end + 1; continue; }
      if (script.startsWith('/*', index)) { const end = script.indexOf('*/', index + 2); if (end < 0) fail(); index = end + 2; continue; }
      if (char === '/' && (!previous || /[({[=,:;!?&|]/.test(previous))) {
        index++;
        let characterClass = false;
        while (index < script.length) {
          const token = script[index++];
          if (token === '\\') index++;
          else if (token === '[') characterClass = true;
          else if (token === ']') characterClass = false;
          else if (token === '/' && !characterClass) break;
        }
        while (/[a-z]/i.test(script[index] || '') && index < script.length) index++;
        previous = 'r'; continue;
      }
      if (script.startsWith('createServerReference', index) && !/[\w$]/.test(script[index - 1] || '')) {
        const match = call.exec(script.slice(index));
        if (match) {
          if (allowed.has(match[2])) {
            if (result[match[2]] && result[match[2]] !== match[1]) fail();
            result[match[2]] = match[1];
          }
          index += match[0].length; previous = ')'; continue;
        }
      }
      if (!/\s/.test(char)) previous = char;
      index++;
    }
    return result;
  }

  window.__humbleLibraryPage = Object.freeze({ decodeLibraryHtml, decodeDetailHtml, decodeLibraryResult, scriptPathsFromHtml, extractActionReferences });
})();
