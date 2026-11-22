(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.VocabPlan = api;
    if (Array.isArray(root.VOCAB_GROUPS)) root.VOCAB_GROUPS = api.split(root.VOCAB_GROUPS);
  }
})(globalThis, function () {
  'use strict';
  const VERSION = 1, PREFIX = 'daily45:', KEEP = 12;
  const wordKey = (word, groupId) => word.recordKey || `${groupId}:${word.word}`;
  const isDaily = id => id > KEEP;
  const stageKey = (id, mode) => `${isDaily(id) ? PREFIX : ''}${id}:${mode}`;
  const sessionKey = (id, kind, mode) => `${isDaily(id) ? PREFIX : ''}${id}:${kind}:${mode}`;
  const groupSessionKey = id => `${isDaily(id) ? PREFIX : ''}${id}`;
  function split(original) {
    if (original.some(g => g.planVersion === VERSION)) return original;
    const kept = original.filter(g => g.id <= KEEP).map(g => ({ ...g, words: g.words.map(w => ({ ...w, recordKey: wordKey(w, g.id), sourceGroupId: g.id })) }));
    const remaining = original.filter(g => g.id > KEEP).flatMap(g => g.words.map(w => ({ ...w, recordKey: wordKey(w, g.id), sourceGroupId: g.id })));
    const days = Math.ceil(remaining.length / 45), size = days ? Math.floor(remaining.length / days) : 0, extra = days ? remaining.length % days : 0;
    let cursor = 0;
    for (let i = 0; i < days; i++) {
      const length = size + (i < extra ? 1 : 0);
      kept.push({ id: KEEP + i + 1, planVersion: VERSION, words: remaining.slice(cursor, cursor + length) }); cursor += length;
    }
    return kept;
  }
  function completedIds(progress) {
    if (progress.planVersion !== VERSION) return [...progress.completedGroups];
    return [...new Set([...progress.completedGroups.filter(id => id <= KEEP), ...(progress.dailyCompletedGroups || [])])].sort((a,b) => a-b);
  }
  function migrate(progress, groups) {
    if (!groups.some(g => g.planVersion === VERSION) || progress.planVersion === VERSION) return progress;
    const old = structuredClone(progress), next = structuredClone(progress);
    next.planVersion = VERSION; next.schema = 3; next.dailyCompletedGroups = [];
    const daily = groups.filter(g => isDaily(g.id)), modes = ['study','recall','dictation'];
    const oldSessions = Object.values(old.sessions || {}).filter(s => s.kind === 'group' && s.groupId > KEEP);
    for (const mode of modes) {
      const done = new Set(), order = new Map(), drafts = new Map(); let rank = 0;
      for (const g of daily) for (const w of g.words) {
        if (old.completed[`${w.sourceGroupId}:${mode}`] === true || mode === 'dictation' && old.completedGroups.includes(w.sourceGroupId)) done.add(w.recordKey);
      }
      for (const s of oldSessions.filter(s => s.mode === mode && !s.repeat)) {
        for (const key of s.queue) if (!order.has(key)) order.set(key, rank++);
        for (const key of s.queue.slice(0, s.index)) done.add(key);
        if (s.answered) for (const r of s.result.results) done.add(r.key);
        else s.answers.forEach((answer, i) => { const key = s.queue[s.index + i]; if (key) drafts.set(key, answer); });
      }
      for (const g of daily) {
        const keys = g.words.map(w => w.recordKey);
        if (keys.every(key => done.has(key))) {
          next.completed[stageKey(g.id,mode)] = true;
          if (mode === 'dictation') next.dailyCompletedGroups.push(g.id);
        } else if (keys.some(key => done.has(key) || order.has(key) || drafts.has(key))) {
          const finished = keys.filter(key => done.has(key)), pending = keys.filter(key => !done.has(key)).sort((a,b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
          const count = mode === 'dictation' ? 5 : 1;
          next.sessions[sessionKey(g.id,'group',mode)] = { groupId:g.id,kind:'group',mode,queue:finished.concat(pending),index:finished.length,answered:false,answers:pending.slice(0,count).map(key=>drafts.get(key)||''),result:null,repeat:false };
        }
      }
    }
    for (const g of daily) if (!next.dailyCompletedGroups.includes(g.id)) {
      for (const mode of ['dictation','recall','study']) {
        const cached = next.sessions[sessionKey(g.id,'group',mode)];
        if (cached && cached.index < cached.queue.length) {
          next.groupSessions[groupSessionKey(g.id)] = { groupId:g.id,kind:'group',mode }; break;
        }
      }
    }
    // Keep every original session, grade and due date; new days have their own
    // stage/session names so old group 13 can never complete new Day 13 by accident.
    const active = old.lastSession, legacy = active && old.sessions?.[`${active.groupId}:${active.kind}:${active.mode}`];
    if (old.selectedGroup > KEEP) {
      const key = legacy?.queue[legacy.index + (legacy.answered ? legacy.result.results.length : 0)];
      next.selectedGroup = daily.find(g => g.words.some(w => key ? w.recordKey === key : w.sourceGroupId === old.selectedGroup))?.id || KEEP + 1;
      const cached = next.sessions[sessionKey(next.selectedGroup,'group',active?.mode)];
      if (cached) next.groupSessions[groupSessionKey(next.selectedGroup)] = next.lastSession = { groupId:next.selectedGroup,kind:'group',mode:cached.mode };
    } else if (old.selectedGroup === KEEP && (old.completed[`${KEEP}:dictation`] || old.completedGroups.includes(KEEP))) {
      next.selectedGroup = daily.find(g => !next.dailyCompletedGroups.includes(g.id))?.id || KEEP;
    }
    return next;
  }
  return { VERSION, KEEP, wordKey, stageKey, sessionKey, groupSessionKey, completedIds, split, migrate };
});
