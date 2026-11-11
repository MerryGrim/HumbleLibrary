// Data-only subset of React Flight for Next server-action results. No imports,
// component rendering, module loading, function calls or JavaScript evaluation.
// Wire format: Next's vendored ReactFlightClient parseModelString / row parser:
// github.com/vercel/next.js/blob/0b75c813588940ec968f20ed3d16734e128036be/packages/next/src/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.edge.production.js
// Action envelope: packages/next/src/shared/lib/app-router-types.ts (a).
(() => {
  'use strict';
  const MAX_BYTES = 16 * 1024 * 1024;
  const MAX_NODES = 100000;
  const MAX_DEPTH = 100;
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  const protocolCodes = new Set(['flightWire', 'flightEnvelope', 'flightServerError', 'flightReference', 'flightScalar', 'flightType']);
  const fail = (protocolCode = 'flightWire') => {
    const error = new Error('protocol');
    Object.defineProperty(error, 'protocolCode', { value: protocolCode });
    throw error;
  };
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const utf8 = bytes => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return fail(); }
  };
  const hex = value => {
    if (!/^[0-9a-f]{1,14}$/.test(value)) return fail();
    const number = Number.parseInt(value, 16);
    if (!Number.isSafeInteger(number)) return fail();
    return number;
  };

  function checkTree(root, budget) {
    const pending = [{ value: root, depth: 0 }];
    while (pending.length) {
      const { value, depth } = pending.pop();
      if (++budget.count > MAX_NODES || depth > MAX_DEPTH) fail();
      if (typeof value === 'number' && !Number.isFinite(value)) fail();
      if (value === null || typeof value !== 'object') continue;
      if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) fail('flightScalar');
        continue;
      }
      const keys = Object.keys(value);
      if (pending.length + keys.length > MAX_NODES) fail();
      for (const key of keys) {
        if (forbidden.has(key)) fail();
        pending.push({ value: value[key], depth: depth + 1 });
      }
    }
  }

  function decode(input) {
    let bytes;
    if (typeof input === 'string') {
      // Every UTF-16 code unit needs at least one UTF-8 byte. Avoid allocating
      // a potentially huge temporary byte buffer before checking that floor.
      if (input.length > MAX_BYTES) fail();
      bytes = new TextEncoder().encode(input);
    } else if (input instanceof Uint8Array) bytes = input;
    else return fail();
    if (!bytes.length || bytes.byteLength > MAX_BYTES) fail();
    const rows = new Map();
    const budget = { count: 0 };
    const lengthTags = new Set('TAOobUSsLlGgMmV');
    let offset = 0;
    while (offset < bytes.length) {
      const colon = bytes.indexOf(58, offset);
      if (colon < 0 || colon - offset > 14) fail();
      // ID-less H rows are resource hints, not action data. Ignore them inertly.
      if (colon === offset && bytes[colon + 1] === 72) {
        const end = bytes.indexOf(10, colon + 2);
        if (end < 0) fail();
        offset = end + 1;
        continue;
      }
      const id = hex(utf8(bytes.subarray(offset, colon)));
      if (!rows.has(id) && rows.size >= MAX_NODES) fail();
      offset = colon + 1;
      if (offset >= bytes.length) fail();
      const character = String.fromCharCode(bytes[offset]);
      let tag = '';
      if (lengthTags.has(character)) {
        if (rows.has(id)) fail();
        tag = character;
        const comma = bytes.indexOf(44, ++offset);
        if (comma < 0 || comma - offset > 14) fail();
        const length = hex(utf8(bytes.subarray(offset, comma)));
        offset = comma + 1;
        if (length > MAX_BYTES || length > bytes.length - offset) fail();
        const data = bytes.subarray(offset, offset + length);
        rows.set(id, tag === 'T' ? { kind: 'text', value: utf8(data) } : { kind: 'unsupported' });
        offset += length;
        continue;
      }
      if ((character >= 'A' && character <= 'Z') || character === '#' || character === 'r' || character === 'x') {
        tag = character;
        offset++;
      }
      const end = bytes.indexOf(10, offset);
      if (end < 0) fail();
      const data = utf8(bytes.subarray(offset, end));
      offset = end + 1;
      // Errors (including NEXT_REDIRECT / NEXT_NOT_FOUND) are never library
      // data, even when another row could otherwise be decoded successfully.
      if (tag === 'E') fail('flightServerError');
      if (tag === 'C') {
        const existing = rows.get(id);
        if (data !== '' || existing?.kind !== 'unsupported' || existing.stream !== 'open') fail();
        rows.set(id, { kind: 'unsupported', stream: 'closed' });
        continue;
      }
      if (rows.has(id)) fail();
      if (tag === 'X') {
        // A page re-render may carry an unrelated empty async iterable. Only
        // the exact X\n / C\n pair is accepted; no stream values are decoded.
        if (data !== '') fail();
        rows.set(id, { kind: 'unsupported', stream: 'open' });
        continue;
      }
      if (tag) {
        rows.set(id, { kind: 'unsupported' });
        continue;
      }
      let value;
      try { value = JSON.parse(data); } catch { return fail(); }
      checkTree(value, budget);
      rows.set(id, { kind: 'model', value });
    }
    if ([...rows.values()].some(row => row.stream === 'open')) fail();
    const envelope = rows.get(0);
    if (envelope?.kind !== 'model' || !envelope.value || typeof envelope.value !== 'object' || Array.isArray(envelope.value) || !own(envelope.value, 'a')) fail('flightEnvelope');
    const root = envelope.value;
    const cache = new Map();
    const visiting = new Set();
    function resolveRow(id, depth) {
      if (visiting.has(id) || visiting.size >= MAX_DEPTH) fail('flightReference');
      if (cache.has(id)) return cache.get(id);
      const row = rows.get(id);
      if (!row) fail('flightReference');
      if (row.kind === 'unsupported') fail('flightType');
      visiting.add(id);
      const value = row.kind === 'text' ? row.value : resolve(row.value, depth);
      visiting.delete(id);
      cache.set(id, value);
      return value;
    }
    function resolve(value, depth) {
      if (depth > MAX_DEPTH) fail();
      if (typeof value === 'string') {
        if (!value.startsWith('$')) return value;
        if (value.startsWith('$$')) return value.slice(1);
        if (value === '$undefined') return undefined;
        if (value === '$-0') return -0;
        if (value.startsWith('$D')) {
          // React emits Date.toJSON() after $D. Preserve its inert Date type:
          // coercing it to a string could turn a wrongly typed key into a code.
          const iso = value.slice(2);
          if (!/^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(iso)) fail('flightScalar');
          const date = new Date(iso);
          if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) fail('flightScalar');
          return date;
        }
        const promise = /^\$@([0-9a-f]{1,14})$/.exec(value);
        if (promise) return resolveRow(hex(promise[1]), depth);
        const reference = /^\$([0-9a-f]{1,14})((?::[^:]+)*)$/.exec(value);
        if (!reference) return fail('flightScalar');
        let target = resolveRow(hex(reference[1]), depth);
        if (reference[2]) {
          const path = reference[2].slice(1).split(':');
          if (path.length + depth > MAX_DEPTH) fail('flightReference');
          for (const key of path) {
            if (forbidden.has(key) || target === null || typeof target !== 'object' || !own(target, key)) fail('flightReference');
            target = target[key];
          }
        }
        return target;
      }
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(item => {
        const result = resolve(item, depth + 1);
        return result === undefined ? null : result;
      });
      const result = {};
      for (const key of Object.keys(value)) {
        if (forbidden.has(key)) fail();
        const item = resolve(value[key], depth + 1);
        if (item !== undefined) result[key] = item;
      }
      return result;
    }
    // Next reserves `n` for a hard navigation rather than an action result.
    if (own(root, 'n') && resolve(root.n, 0) != null) fail('flightEnvelope');
    const result = resolve(root.a, 0);
    if (result === undefined) fail('flightEnvelope');
    // Count expanded occurrences too: a small reference DAG must not expand
    // into an unbounded object tree when the caller later serializes it.
    checkTree(result, { count: 0 });
    return result;
  }

  async function read(response, signal) {
    if (signal?.aborted) throw new Error('cancelled');
    if (!response?.body || typeof response.body.getReader !== 'function') fail();
    let reader;
    try { reader = response.body.getReader(); } catch { return fail(); }
    const chunks = [];
    let length = 0;
    const onAbort = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (signal?.aborted) throw new Error('cancelled');
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail();
        length += chunk.value.byteLength;
        if (length > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          fail();
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } catch (error) {
      if (signal?.aborted) throw new Error('cancelled');
      if (error?.message === 'protocol') fail(protocolCodes.has(error.protocolCode) ? error.protocolCode : 'flightWire');
      throw new Error('network');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }

  window.__humbleLibraryFlight = Object.freeze({ decode, read });
})();
