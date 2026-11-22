export function createAudioPlayer(audio, { onChange = () => {}, onPlayError = () => {} } = {}) {
  let status = 'idle'; // idle | loading | ready | error
  let errorKind = null;
  let sources = [];
  let sourceIdx = 0;
  let pendingSeek = null;
  let targetRate = 1;

  function emit() {
    onChange(snapshot());
  }

  function applyRate() {
    const r = Number(targetRate) || 1;
    audio.defaultPlaybackRate = r;
    if (audio.playbackRate !== r) {
      try { audio.playbackRate = r; } catch {}
    }
  }

  function flushPendingSeek() {
    if (pendingSeek === null) return false;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const seekable = audio.seekable && audio.seekable.length > 0;
    if (!duration && !seekable) return false;
    const maxT = duration || audio.seekable.end(audio.seekable.length - 1);
    if (!Number.isFinite(maxT) || maxT <= 0) return false;
    const target = Math.max(0, Math.min(pendingSeek, maxT));
    try {
      audio.currentTime = target;
      // On iOS Safari, currentTime assignment before buffered metadata can silently stay at 0
      if (Math.abs(audio.currentTime - target) <= 1.2 || target < 0.5) {
        pendingSeek = null;
        return true;
      }
    } catch {}
    return false;
  }

  function snapshot() {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    return {
      status,
      errorKind,
      currentTime,
      duration,
      paused: audio.paused,
      hasSource: sources.length > 0,
    };
  }

  function applySource(src) {
    status = 'loading';
    errorKind = null;
    audio.src = src;
    applyRate();
    audio.load();
    emit();
  }

  audio.addEventListener('loadedmetadata', () => {
    status = 'ready';
    errorKind = null;
    applyRate();
    flushPendingSeek();
    emit();
  });

  audio.addEventListener('canplay', () => {
    if (status !== 'ready') {
      status = 'ready';
      errorKind = null;
    }
    applyRate();
    flushPendingSeek();
    emit();
  });

  audio.addEventListener('playing', () => {
    status = 'ready';
    errorKind = null;
    applyRate();
    flushPendingSeek();
    emit();
  });

  audio.addEventListener('error', () => {
    if (sourceIdx + 1 < sources.length) {
      sourceIdx += 1;
      applySource(sources[sourceIdx]);
      return;
    }
    status = 'error';
    const code = audio.error?.code;
    errorKind = code === 3 || code === 4 ? 'decode' : 'network';
    emit();
  });

  function load(target, { fallbacks = [] } = {}) {
    const list = [target, ...fallbacks].filter(Boolean);
    if (!list.length) return;
    if (sources[0] === list[0] && status !== 'error' && audio.src) {
      applyRate();
      emit();
      return;
    }
    sources = list;
    sourceIdx = 0;
    pendingSeek = null;
    audio.pause();
    applySource(sources[0]);
  }

  function setRate(rate) {
    targetRate = Number(rate) || 1;
    applyRate();
  }

  function play() {
    if (status === 'error' && sources.length) {
      sourceIdx = 0;
      applySource(sources[0]);
    }
    applyRate();
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        const kind = err?.name === 'NotAllowedError' ? 'autoplay' : 'play';
        onPlayError({ kind, error: err });
        emit();
      });
    }
  }

  function pause() {
    audio.pause();
    emit();
  }

  function seek(time) {
    const t = Math.max(0, Number(time) || 0);
    pendingSeek = t;
    flushPendingSeek();
    emit();
  }

  function seekAndPlay(time) {
    const t = Math.max(0, Number(time) || 0);
    pendingSeek = t;
    flushPendingSeek();
    play();
  }

  return { load, play, pause, seek, seekAndPlay, setRate, snapshot };
}
