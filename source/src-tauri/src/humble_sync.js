// Read-only synchronization coordinator. Transport, account identity, projection
// and persistence belong to adapters; this module cannot reveal or export keys.
(() => {
  'use strict';
  const fail = code => { const error = new Error('protocol'); error.protocolCode = code; throw error; };
  const cancelled = () => { throw new Error('cancelled'); };
  const transient = error => ['network', 'rateLimited', 'service'].includes(error?.message) && error.retryable === true;
  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new Error('cancelled')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  async function run(adapter, options = {}) {
    const signal = options.signal ?? new AbortController().signal;
    const now = adapter.now || (() => performance.now());
    const wait = adapter.wait || sleep;
    const interval = options.intervalMs ?? 1000;
    const detailInterval = options.detailIntervalMs ?? 200;
    const timeout = options.timeoutMs ?? 30000;
    const attempts = options.maxAttempts ?? 4;
    const delays = options.retryDelays ?? [2000, 5000, 15000];
    const budget = options.maxDurationMs ?? 2 * 60 * 60 * 1000 - 60000;
    if (!Number.isFinite(interval) || interval < 0 || interval > 60000
        || !Number.isFinite(detailInterval) || detailInterval < 0 || detailInterval > 60000
        || !Number.isFinite(timeout) || timeout <= 0 || timeout > 60000
        || !Number.isInteger(attempts) || attempts < 1 || attempts > 4
        || !Number.isFinite(budget) || budget <= 0
        || !Array.isArray(delays) || delays.length < attempts - 1
        || delays.some(value => !Number.isFinite(value) || value < 0 || value > 60000)) fail('libraryPagination');
    const started = now();
    let nextRead = started, lastFinished = null, detailGap = detailInterval, healthyDetails = 0;
    const check = () => {
      if (signal?.aborted) cancelled();
      if (now() - started >= budget) throw new Error('network');
    };
    const pause = async ms => {
      check();
      const remaining = budget - (now() - started);
      if (ms >= remaining) throw new Error('network');
      if (ms > 0) await wait(ms, signal);
      check();
    };
    const emit = async event => { check(); await adapter.emit(event); check(); };
    const read = async (phase, task) => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const detailRead = phase === 'detailPage';
        const gap = detailRead ? detailGap : interval;
        // Honor both the preceding read's cooldown and this read's profile.
        // Purchased actions and final identity verification retain their gap.
        await pause(Math.max(0, nextRead - now(), lastFinished === null ? 0 : lastFinished + gap - now()));
        await emit({ kind: 'syncActivity', phase, state: 'reading', attempt, delayMs: 0 });
        const controller = new AbortController();
        const stop = () => controller.abort();
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) controller.abort();
        let timedOut = false, failure, value, timer;
        const expiry = new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('network')); },
            Math.min(timeout, budget - (now() - started)));
        });
        const stopped = new Promise((_, reject) => {
          const abort = () => reject(new Error('cancelled'));
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
        try { value = await Promise.race([Promise.resolve().then(() => task(controller.signal)), expiry, stopped]); }
        catch (error) { failure = error; }
        finally {
          clearTimeout(timer); signal?.removeEventListener('abort', stop);
        }
        if (signal?.aborted) cancelled();
        if (timedOut) { failure = new Error('network'); failure.retryable = true; }
        check();
        if (detailRead) {
          if (failure) {
            healthyDetails = 0;
            if (transient(failure)) detailGap = Math.min(Math.max(5000, detailInterval), Math.max(1000, detailGap * 2));
          } else if (++healthyDetails === 5) {
            detailGap = Math.max(detailInterval, Math.ceil(detailGap / 2));
            healthyDetails = 0;
          }
        }
        lastFinished = now();
        nextRead = lastFinished + (detailRead ? detailGap : interval);
        if (!failure) return value;
        if (failure.message === 'auth' || failure.message === 'cancelled') throw failure;
        if (!transient(failure) || attempt === attempts) throw failure;
        const retryAfter = Number.isFinite(failure.retryAfterMs) ? Math.max(0, Math.min(60000, failure.retryAfterMs)) : 0;
        const delayMs = Math.min(60000, Math.ceil(Math.max(delays[attempt - 1], retryAfter, nextRead - now())));
        await emit({ kind: 'syncActivity', phase, state: 'waiting', attempt: attempt + 1, delayMs,
          reason: failure.message });
        await pause(delayMs);
      }
    };

    const root = await read('libraryPage', signal => adapter.index(signal));
    check();
    const sources = adapter.plan(root);
    if (!Array.isArray(sources) || sources.length > 10000) fail('libraryEntry');
    await emit({ kind: 'progress', completed: 0, total: sources.length, stage: 'keys' });
    const bundles = [];
    let transientFailures = 0, circuitError = null;
    for (const source of sources) {
      check();
      try {
        if (source.read !== false && circuitError) throw circuitError;
        const bundle = source.read === false ? await adapter.detail(source, signal)
          : await read('detailPage', signal => adapter.detail(source, signal));
        bundles.push(bundle);
        if (source.read !== false) transientFailures = 0;
      } catch (error) {
        if (signal?.aborted || error?.message === 'cancelled') cancelled();
        if (error?.message === 'auth') throw error;
        if (source.read !== false) {
          if (transient(error)) transientFailures++;
          else transientFailures = 0;
        }
        if (error?.message === 'rateLimited' || transientFailures >= 3) circuitError = error;
        bundles.push(await adapter.failed(source, error));
      }
      await emit({ kind: 'progress', completed: bundles.length, total: sources.length, stage: 'keys' });
    }
    // Reconfirm the same account after the last read, before any native commit.
    await read('libraryPage', signal => adapter.verify(root, signal));
    check();
    return { bundles, enumerationComplete: true, syncedAt: new Date().toISOString() };
  }
  window.__humbleLibrarySync = Object.freeze({ run });
})();
