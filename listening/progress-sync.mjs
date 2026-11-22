import { mergeProgress } from './listening-progress.mjs';

const DIRTY_KEY = 'listening-desk-dirty-v1';
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

export function createProgressSync({ read, accept, status }) {
  const endpoint = '../api/listening/progress';
  const seedUrl = './seed-progress.json';
  let started = false;
  let staticMode = false;
  let timer = null;
  let inFlight = false;
  let dirty = false;
  let seq = 0;

  async function loadSeedIfEmpty(local) {
    if (local?.units?.length) return false;
    try {
      const res = await fetch(seedUrl, { cache: 'no-store' });
      if (!res.ok) return false;
      const json = await res.json();
      const seed = json?.progress || null;
      if (!seed || !Array.isArray(seed.units)) return false;
      accept(seed);
      return true;
    } catch {
      return false;
    }
  }

  async function push(preferKeepalive = false) {
    if (!started) return;
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
    const payload = read();
    if (!payload) return;
    const bodyStr = JSON.stringify({ progress: payload });
    const useKeepalive = preferKeepalive && byteLength(bodyStr) <= KEEPALIVE_MAX_BYTES;
    const mySeq = ++seq;
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
    } catch {
      markLocalDirty(true);
      status('offline');
    } finally {
      inFlight = false;
      if (dirty) {
        dirty = false;
        push(false);
      }
    }
  }

  async function start() {
    status('loading');
    const local = read();
    try {
      const res = await fetch(endpoint, { cache: 'no-store' });
      const ct = res.headers.get('content-type') || '';
      if (res.status === 404 || res.status === 405 || (res.ok && !ct.includes('json'))) {
        staticMode = true;
        await loadSeedIfEmpty(local);
        markLocalDirty(false);
        started = true;
        status('static');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const remote = json?.progress || null;
      let needPush = false;
      if (remote) {
        const merged = hasLocalDirty() && local?.units?.length ? mergeProgress(remote, local) : remote;
        accept(merged);
        if (hasLocalDirty() && local?.units?.length) needPush = true;
        else markLocalDirty(false);
      } else if (local?.units?.length) {
        needPush = true;
      }
      started = true;
      status('saved');
      if (needPush) await push(false);
    } catch {
      await loadSeedIfEmpty(local);
      started = true;
      status('offline');
    }
  }

  function changed() {
    if (staticMode) {
      status('static');
      return;
    }
    markLocalDirty(true);
    if (!started) return;
    dirty = true;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      push(false);
    }, 150);
  }

  function flush() {
    if (!started || staticMode) return;
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
      dirty = true;
    }
    if (dirty || hasLocalDirty()) {
      push(true);
    }
  }

  function retry() {
    if (staticMode) return;
    if (!started) {
      start();
      return;
    }
    if (dirty || hasLocalDirty()) push(false);
  }

  return { start, changed, flush, retry, clearDirty: () => markLocalDirty(false) };
}
