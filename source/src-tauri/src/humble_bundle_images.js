// Purchase-cover discovery. Never executes purchase HTML or exports page contents.
(() => {
  'use strict';
  const storefrontOrigins = new Set(['https://www.humblebundle.com', 'https://humblebundle.com']);
  const ORIGIN = location.origin;
  if (window.top !== window || !storefrontOrigins.has(ORIGIN) || typeof window.fetch !== 'function') return;
  const nativeFetch = window.fetch.bind(window);
  const cache = new Map();
  const MAX_HTML = 2 * 1024 * 1024;
  const cancelled = () => new Error('cancelled');
  const safeImage = value => {
    if (value && typeof value === 'object') value = value.url || value.src || value.image_url;
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return '';
    try {
      const url = new URL(value, ORIGIN);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };
  const generic = (url, description = '') => /^(?:(?:humble(?: bundle)?)(?: logo)?[\s|/-]*)+$/i.test(description.trim())
    || /(?:humble(?:[-_]?bundle)?[-_]?(?:logo|brand)|(?:logo|brand)[-_]?humble(?:[-_]?bundle)?)(?:[./_?\-]|$)/i.test(url);
  const dedicated = order => {
    const fields = ['bundle_logo', 'bundle_logo_url', 'logo', 'logo_url', 'banner', 'banner_url', 'header_image', 'header_image_url', 'header', 'header_url', 'image', 'image_url', 'large_image', 'large_image_url', 'cover', 'cover_url'];
    for (const source of [order?.product, order]) {
      if (!source || typeof source !== 'object') continue;
      for (const field of fields) { const url = safeImage(source[field]); if (url && !generic(url)) return url; }
    }
    return '';
  };
  const icon = order => {
    for (const value of [order?.product?.icon, order?.product?.icon_url, order?.icon, order?.icon_url]) { const url = safeImage(value); if (url) return url; }
    return '';
  };
  const remember = (id, url) => {
    if (!cache.has(id) && cache.size >= 10000) cache.delete(cache.keys().next().value);
    cache.set(id, url);
    return url;
  };
  async function boundedHtml(response, signal) {
    const size = Number(response.headers?.get('content-length'));
    if (Number.isFinite(size) && size > MAX_HTML) { await response.body?.cancel().catch(() => {}); return ''; }
    const type = response.headers?.get('content-type') || '';
    if (type && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)) return '';
    if (!response.body?.getReader) {
      // Real WebView2 responses are streamed. The fallback needs a bounded length.
      if (!Number.isFinite(size) || size <= 0 || size > MAX_HTML) return '';
      const value = await response.text();
      if (signal?.aborted) throw cancelled();
      return new TextEncoder().encode(value).length <= MAX_HTML ? value : '';
    }
    const reader = response.body.getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        if (signal?.aborted) throw cancelled();
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_HTML) { await reader.cancel(); return ''; }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    if (signal?.aborted) throw cancelled();
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
  function fromHtml(html, order) {
    if (!html) return '';
    // Template contents remain inert: scripts, images and frames are never attached.
    const template = document.createElement('template'); template.innerHTML = html;
    const title = String(order?.product?.human_name || order?.human_name || '').toLowerCase();
    const tokens = title.match(/[\p{L}\p{N}]+/gu)?.filter(value => value.length > 2 && !['humble', 'bundle', 'the', 'and', 'for', 'with'].includes(value)) || [];
    let best = '', bestScore = 0;
    const excluded = 'nav,footer,[role="navigation"],.navbar,.navigation,.site-header,.site-footer,.global-header,.global-footer,.humble-header,.humble-footer';
    for (const image of Array.from(template.content.querySelectorAll('img')).slice(0, 512)) {
      if (image.closest(excluded)) continue;
      // Purchase pages use a#logo (not img.logo); its link points to the
      // purchased bundle. A homepage/navigation logo is never a bundle cover.
      const logoLink = image.closest('a#logo');
      if (logoLink) {
        let bundleLink = false;
        try {
          const target = new URL(logoLink.getAttribute('href') || '', ORIGIN);
          const route = target.pathname.replace(/\/+$/, '') || '/';
          bundleLink = storefrontOrigins.has(target.origin) && !target.username && !target.password
            && !['/', '/home', '/bundles', '/store', '/membership', '/subscription', '/login', '/logout', '/about'].includes(route)
            && !/^\/home\//.test(route);
        } catch {}
        if (!bundleLink) continue;
      }
      const url = safeImage(image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src'));
      const description = [image.getAttribute('alt'), image.getAttribute('title'), image.getAttribute('aria-label')].filter(Boolean).join(' ');
      if (!url || generic(url, description) || /(?:^|[\s_-])(?:tracking|pixel|avatar)(?:[\s_.-]|$)/i.test(url + ' ' + description)) continue;
      let score = logoLink ? 400 : image.matches('.logo-holder img,.product-logo img,.bundle-logo img,.main-logo img,.logo img,img.product-logo,img.bundle-logo,img.main-logo') ? 300 : image.matches('img.logo') ? 200 : 0;
      const width = Number.parseFloat(image.getAttribute('width') || image.getAttribute('data-width') || '0');
      const height = Number.parseFloat(image.getAttribute('height') || image.getAttribute('data-height') || '0');
      const wide = width >= 300 && height > 0 && width / height >= 1.6;
      const header = image.closest('header,.bundle-header,.product-header,.download-header,.purchase-header,.page-header,.hero,.header') || /(?:banner|header|hero|logo)/i.test(image.className);
      const descriptionLower = (description + ' ' + url).toLowerCase();
      const matches = tokens.filter(token => descriptionLower.includes(token)).length;
      if (!score && !(wide && header && matches)) continue;
      score += (wide ? 30 : 0) + Math.min(matches, 10) * 10;
      if (score > bestScore) { best = url; bestScore = score; }
    }
    return best;
  }
  window.__humbleLibraryBundleImage = async (order, id, signal) => {
    if (signal?.aborted) throw cancelled();
    const fallback = icon(order);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) return fallback;
    const authoritative = dedicated(order);
    if (authoritative) return remember(id, authoritative);
    if (cache.has(id)) return cache.get(id) || fallback;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10000);
    try {
      const response = await nativeFetch(`/downloads?key=${encodeURIComponent(id)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (signal?.aborted) throw cancelled();
      if (!response.ok) return fallback;
      if (response.redirected) {
        const destination = new URL(response.url);
        if (!storefrontOrigins.has(destination.origin) || destination.username || destination.password) return fallback;
      }
      const html = await boundedHtml(response, signal);
      if (signal?.aborted) throw cancelled();
      const found = fromHtml(html, order);
      return found ? remember(id, found) : fallback;
    } catch {
      if (signal?.aborted) throw cancelled();
      return fallback;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  };
})();
