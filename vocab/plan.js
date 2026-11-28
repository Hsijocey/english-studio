(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.VocabPlan = api;
    if (Array.isArray(root.VOCAB_GROUPS)) root.VOCAB_GROUPS = api.split(root.VOCAB_GROUPS);
  }
})(globalThis, function () {
  'use strict';
  const VERSION = 2;
  const SUPPORTED_VERSIONS = [1, 2];
  const KEEP = 12;
  const KEEP_V1 = 15;
  const PREFIX_V1 = 'daily45:';
  const PREFIX_V2 = 'daily30:';
  const DAILY_TARGET = 30;

  const wordKey = (word, groupId) => word.recordKey || `${groupId}:${word.word}`;
  const isDaily = id => id > KEEP;
  const prefixFor = id => (id > KEEP_V1 ? PREFIX_V2 : id > KEEP ? PREFIX_V1 : '');
  const stageKey = (id, mode) => `${prefixFor(id)}${id}:${mode}`;
  const sessionKey = (id, kind, mode) => `${prefixFor(id)}${id}:${kind}:${mode}`;
  const groupSessionKey = id => `${prefixFor(id)}${id}`;
  const v1StageKey = (id, mode) => `${id > KEEP ? PREFIX_V1 : ''}${id}:${mode}`;
  const v1SessionKey = (id, kind, mode) => `${id > KEEP ? PREFIX_V1 : ''}${id}:${kind}:${mode}`;

  function splitV1(original) {
    if (original.some(g => g.planVersion === 1)) return original;
    const kept = original
      .filter(g => g.id <= KEEP)
      .map(g => ({
        ...g,
        words: g.words.map(w => ({ ...w, recordKey: wordKey(w, g.id), sourceGroupId: w.sourceGroupId || g.id, v1GroupId: g.id }))
      }));
    const remaining = original
      .filter(g => g.id > KEEP)
      .flatMap(g => g.words.map(w => ({ ...w, recordKey: wordKey(w, g.id), sourceGroupId: w.sourceGroupId || g.id })));
    const days = Math.ceil(remaining.length / 45);
    const size = days ? Math.floor(remaining.length / days) : 0;
    const extra = days ? remaining.length % days : 0;
    let cursor = 0;
    for (let i = 0; i < days; i++) {
      const id = KEEP + i + 1;
      const length = size + (i < extra ? 1 : 0);
      kept.push({
        id,
        planVersion: 1,
        words: remaining.slice(cursor, cursor + length).map(w => ({ ...w, v1GroupId: id }))
      });
      cursor += length;
    }
    return kept;
  }

  function split(original) {
    if (original.some(g => g.planVersion === VERSION)) return original;
    const v1 = splitV1(original);
    const kept = v1
      .filter(g => g.id <= KEEP_V1)
      .map(g => ({
        ...g,
        ...(g.id > KEEP ? { planVersion: VERSION } : {}),
        words: g.words.map(w => ({ ...w, recordKey: wordKey(w, g.id), v1GroupId: w.v1GroupId || g.id }))
      }));
    const remaining = v1
      .filter(g => g.id > KEEP_V1)
      .flatMap(g => g.words.map(w => ({ ...w, recordKey: wordKey(w, g.id), v1GroupId: w.v1GroupId || g.id })));
    const days = Math.ceil(remaining.length / DAILY_TARGET);
    const size = days ? Math.floor(remaining.length / days) : 0;
    const extra = days ? remaining.length % days : 0;
    let cursor = 0;
    for (let i = 0; i < days; i++) {
      const id = KEEP_V1 + i + 1;
      const length = size + (i < extra ? 1 : 0);
      kept.push({
        id,
        planVersion: VERSION,
        words: remaining.slice(cursor, cursor + length)
      });
      cursor += length;
    }
    return kept;
  }

  function completedIds(progress) {
    if (!SUPPORTED_VERSIONS.includes(progress.planVersion)) return [...progress.completedGroups];
    return [...new Set([...progress.completedGroups.filter(id => id <= KEEP), ...(progress.dailyCompletedGroups || [])])].sort((a, b) => a - b);
  }

  function migrate(progress, groups) {
    if (!groups.some(g => g.planVersion === VERSION) || progress.planVersion === VERSION) return progress;
    const fromV1 = progress.planVersion === 1;
    const cutoff = fromV1 ? KEEP_V1 : KEEP;
    const old = structuredClone(progress), next = structuredClone(progress);
    next.planVersion = VERSION;
    next.schema = 3;
    next.dailyCompletedGroups = fromV1
      ? [...new Set((old.dailyCompletedGroups || []).filter(id => id > KEEP && id <= KEEP_V1))]
      : [];

    const targetGroups = groups.filter(g => g.id > cutoff);
    const modes = ['study', 'recall', 'dictation'];
    const oldSessions = Object.entries(old.sessions || {})
      .filter(([key, s]) => {
        if (!s || s.kind !== 'group' || s.groupId <= cutoff) return false;
        return fromV1 ? key.startsWith(PREFIX_V1) : (!key.startsWith(PREFIX_V1) && !key.startsWith(PREFIX_V2));
      })
      .map(([, s]) => s);
    const batchSz = [3, 5].includes(old.batchSize) ? old.batchSize : 3;

    for (const mode of modes) {
      const done = new Set(), order = new Map(), drafts = new Map();
      let rank = 0;
      for (const g of targetGroups) {
        for (const w of g.words) {
          const prevGroupId = fromV1 ? w.v1GroupId : w.sourceGroupId;
          const prevCompleted = fromV1
            ? (old.completed[v1StageKey(prevGroupId, mode)] === true || (mode === 'dictation' && (old.dailyCompletedGroups || []).includes(prevGroupId)))
            : (old.completed[`${prevGroupId}:${mode}`] === true || (mode === 'dictation' && (old.completedGroups || []).includes(prevGroupId)));
          if (prevCompleted) done.add(w.recordKey);
        }
      }
      for (const s of oldSessions.filter(s => s.mode === mode && !s.repeat)) {
        for (const key of s.queue || []) if (!order.has(key)) order.set(key, rank++);
        for (const key of (s.queue || []).slice(0, s.index || 0)) done.add(key);
        if (s.answered && Array.isArray(s.result?.results)) {
          for (const r of s.result.results) done.add(r.key);
        } else if (Array.isArray(s.answers)) {
          s.answers.forEach((answer, i) => {
            const key = s.queue?.[s.index + i];
            if (key && answer) drafts.set(key, answer);
          });
        }
      }
      for (const g of targetGroups) {
        const keys = g.words.map(w => w.recordKey);
        if (keys.every(key => done.has(key))) {
          next.completed[stageKey(g.id, mode)] = true;
          if (mode === 'dictation' && !next.dailyCompletedGroups.includes(g.id)) next.dailyCompletedGroups.push(g.id);
        } else if (keys.some(key => done.has(key) || drafts.has(key))) {
          const finished = keys.filter(key => done.has(key));
          const pending = keys.filter(key => !done.has(key)).sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
          const answers = mode === 'study'
            ? []
            : mode === 'recall'
              ? [drafts.get(pending[0]) || '']
              : pending.slice(0, Math.min(batchSz, pending.length)).map(key => drafts.get(key) || '');
          next.sessions[sessionKey(g.id, 'group', mode)] = {
            groupId: g.id, kind: 'group', mode,
            queue: finished.concat(pending), index: finished.length,
            answered: false, answers, result: null, repeat: false
          };
        }
      }
    }

    next.dailyCompletedGroups.sort((a, b) => a - b);

    for (const g of targetGroups) {
      if (!next.dailyCompletedGroups.includes(g.id)) {
        for (const mode of ['dictation', 'recall', 'study']) {
          const cached = next.sessions[sessionKey(g.id, 'group', mode)];
          if (cached && cached.index < cached.queue.length) {
            next.groupSessions[groupSessionKey(g.id)] = { groupId: g.id, kind: 'group', mode };
            break;
          }
        }
      }
    }

    // Preserve every original session, FSRS record and due date; new daily30 days
    // have their own namespace so old daily45 sessions never collide with Day 16+.
    const active = old.lastSession;
    const legacyKey = active
      ? (fromV1 ? v1SessionKey(active.groupId, active.kind, active.mode) : `${active.groupId}:${active.kind}:${active.mode}`)
      : null;
    const legacy = legacyKey ? old.sessions?.[legacyKey] : null;
    const matchPrev = (g, id) => g.words.some(w => (fromV1 ? w.v1GroupId : w.sourceGroupId) === id);

    if (old.selectedGroup > cutoff) {
      if (active?.kind === 'group' && active.groupId > cutoff && legacy) {
        const cursorIdx = (legacy.index || 0) + (legacy.answered ? (legacy.result?.results?.length || 0) : 0);
        const key = legacy.queue?.[cursorIdx];
        const picked = (key && targetGroups.find(g => g.words.some(w => w.recordKey === key)))
          || targetGroups.find(g => matchPrev(g, old.selectedGroup) && !next.dailyCompletedGroups.includes(g.id))
          || targetGroups.find(g => !next.dailyCompletedGroups.includes(g.id))
          || targetGroups.find(g => matchPrev(g, old.selectedGroup))
          || targetGroups[0];
        next.selectedGroup = picked?.id || cutoff + 1;
        const cached = next.sessions[sessionKey(next.selectedGroup, 'group', active.mode)];
        if (cached) {
          next.groupSessions[groupSessionKey(next.selectedGroup)] = next.lastSession = {
            groupId: next.selectedGroup, kind: 'group', mode: cached.mode
          };
        } else if (next.groupSessions[groupSessionKey(next.selectedGroup)]) {
          next.lastSession = { ...next.groupSessions[groupSessionKey(next.selectedGroup)] };
        } else {
          delete next.lastSession;
        }
      } else {
        const picked = targetGroups.find(g => matchPrev(g, old.selectedGroup) && !next.dailyCompletedGroups.includes(g.id))
          || targetGroups.find(g => !next.dailyCompletedGroups.includes(g.id))
          || targetGroups.find(g => matchPrev(g, old.selectedGroup))
          || targetGroups[0];
        next.selectedGroup = picked?.id || cutoff + 1;
        if (active?.kind === 'wrong' && legacy) {
          const carried = structuredClone(legacy);
          carried.groupId = next.selectedGroup;
          next.sessions[sessionKey(next.selectedGroup, 'wrong', 'review')] = carried;
          next.groupSessions[groupSessionKey(next.selectedGroup)] = next.lastSession = {
            groupId: next.selectedGroup, kind: 'wrong', mode: 'review'
          };
        } else if (active && active.groupId > cutoff) {
          delete next.lastSession;
        }
      }
    } else if (old.selectedGroup === cutoff) {
      const cutoffDone = fromV1
        ? (old.completed[v1StageKey(cutoff, 'dictation')] || (old.dailyCompletedGroups || []).includes(cutoff))
        : (old.completed[`${cutoff}:dictation`] || (old.completedGroups || []).includes(cutoff));
      if (cutoffDone) {
        next.selectedGroup = targetGroups.find(g => !next.dailyCompletedGroups.includes(g.id))?.id || cutoff;
      }
    }

    return next;
  }

  return { VERSION, SUPPORTED_VERSIONS, KEEP, KEEP_V1, DAILY_TARGET, wordKey, stageKey, sessionKey, groupSessionKey, completedIds, split, migrate };
});
