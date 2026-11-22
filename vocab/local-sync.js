(function (root) {
  'use strict';

  /**
   * Local disk persistence adapter replacing ChatGPT cloud-sync.
   * Invariants:
   * 1. NEVER overwrites live UI / typing state after initial boot.
   * 2. Respects the 64 KiB browser fetch keepalive limit so large payloads
   *    never get silently dropped on pagehide / visibilitychange.
   * 3. Serializes writes strictly (no concurrent out-of-order PUT races).
   */
  const DIRTY_KEY = 'vocab-listening-lab-dirty-v1';
  const KEEPALIVE_MAX_BYTES = 60 * 1024;

  function markLocalDirty(flag) {
    try {
      if (flag) window.localStorage.setItem(DIRTY_KEY, '1');
      else window.localStorage.removeItem(DIRTY_KEY);
    } catch {}
  }

  function hasLocalDirty() {
    try {
      return window.localStorage.getItem(DIRTY_KEY) === '1';
    } catch {
      return false;
    }
  }

  function byteLength(str) {
    try {
      return new TextEncoder().encode(str).length;
    } catch {
      return str.length * 2;
    }
  }

  function create({ read, accept, status, legacyImport, config }) {
    const endpoint = '../api/vocab/progress';
    const seedUrl = './seed-progress.json';
    let initialized = false;
    let staticMode = false;
    let debounceTimer = null;
    let inFlight = false;
    let dirty = false;
    let seq = 0;

    async function loadSeedIfEmpty() {
      if (legacyImport) return false;
      try {
        const res = await fetch(seedUrl, { cache: 'no-store' });
        if (!res.ok) return false;
        const json = await res.json();
        const seed = json?.progress || null;
        if (!seed || typeof seed !== 'object') return false;
        if (seed.reviewDay) seed.reviewDay.cloudLocked = false;
        delete seed.cloudOwner;
        accept(seed);
        return true;
      } catch {
        return false;
      }
    }

    async function pushNow(preferKeepalive = false) {
      if (!initialized) return;
      if (staticMode) {
        dirty = false;
        markLocalDirty(false);
        status('static');
        return;
      }
      if (inFlight) {
        dirty = true;
        return;
      }
      const mySeq = ++seq;
      const payload = read();
      if (!payload) return;
      const bodyStr = JSON.stringify({ progress: payload });
      const useKeepalive = preferKeepalive && byteLength(bodyStr) <= KEEPALIVE_MAX_BYTES;
      inFlight = true;
      dirty = false;
      if (!preferKeepalive) status('saving');
      try {
        const res = await fetch(endpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          keepalive: useKeepalive,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (mySeq === seq && !dirty) {
          markLocalDirty(false);
          status('saved');
        }
      } catch (err) {
        markLocalDirty(true);
        status('offline', '本机服务暂时未响应，记录已保留在浏览器缓存中。');
      } finally {
        inFlight = false;
        if (dirty) {
          dirty = false;
          pushNow(false);
        }
      }
    }

    async function start() {
      status('loading');
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        if (res.status === 404 || res.status === 405) {
          // Pure static hosting (e.g. GitHub Pages): persist cleanly in browser localStorage
          staticMode = true;
          const seeded = await loadSeedIfEmpty();
          if (!seeded) accept(read());
          markLocalDirty(false);
          initialized = true;
          status('static');
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('json')) {
          staticMode = true;
          const seeded = await loadSeedIfEmpty();
          if (!seeded) accept(read());
          markLocalDirty(false);
          initialized = true;
          status('static');
          return;
        }
        const json = await res.json();
        const remote = json?.progress || null;
        const local = read();

        let chosen = local;
        let needPush = false;
        if (remote) {
          if (hasLocalDirty() && legacyImport && window.VocabCloud) {
            try {
              chosen = window.VocabCloud.merge(remote, local, {
                groups: config.groups,
                plan: config.plan,
                review: config.review,
                server: false,
              });
              needPush = true;
            } catch {
              chosen = remote;
            }
          } else {
            chosen = remote;
          }
          if (chosen.reviewDay) chosen.reviewDay.cloudLocked = false;
          delete chosen.cloudOwner;
          accept(chosen);
          if (!needPush) markLocalDirty(false);
        } else {
          accept(local);
          needPush = true;
        }
        initialized = true;
        status('saved');
        if (needPush) await pushNow(false);
      } catch (err) {
        // Fallback: stay completely usable in browser localStorage
        const seeded = await loadSeedIfEmpty();
        if (!seeded) accept(read());
        initialized = true;
        status('offline', '未能连接本地持久化接口，当前已切回浏览器本地缓存模式。');
      }
    }

    function changed() {
      if (staticMode) {
        status('static');
        return;
      }
      markLocalDirty(true);
      if (!initialized) return;
      dirty = true;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        pushNow(false);
      }, 150);
    }

    function flush() {
      if (!initialized || staticMode) return;
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
        dirty = true;
      }
      if (dirty || hasLocalDirty()) {
        pushNow(true);
      }
    }

    function forcePush() {
      if (staticMode) {
        status('static');
        return;
      }
      markLocalDirty(true);
      dirty = true;
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (initialized) pushNow(false);
    }

    function retry() {
      if (staticMode) return;
      if (!initialized) {
        start();
        return;
      }
      if (dirty || hasLocalDirty()) pushNow(false);
    }

    return {
      start,
      changed,
      flush,
      forcePush,
      retry,
      clearDirty: () => markLocalDirty(false),
      canReviewDay: () => true,
    };
  }

  root.VocabSync = { create };
})(globalThis);
