(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VocabReview = api;
})(globalThis, function () {
  'use strict';
  const LIMIT = 100;
  const keyFor = w => w.recordKey || `${w.groupId}:${w.word}`;
  const dayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'
  });
  const dayKey = (now = Date.now()) => dayFormatter.format(new Date(now));
  const isNew = (r, day) => !!r?.firstLearnedAt && dayKey(r.firstLearnedAt) === day;
  const pendingCorrection = s => s?.answered && s.result?.results?.[0]?.correct === false && s.result.correction?.done !== true;

  function ensureDay(progress, items, now = Date.now()) {
    const date = dayKey(now), byKey = new Map(items.map(w => [keyFor(w),w]));
    // A single old attempt has an exact first-practice time. With multiple
    // legacy attempts that date is unknown; never guess it from lastSeen.
    if (!progress.reviewDay) for (const r of Object.values(progress.records)) {
      if (!r.firstLearnedAt && r.attempts===1 && r.lastSeen>0) r.firstLearnedAt=r.lastSeen;
    }
    if (progress.reviewDay?.version === 1 && progress.reviewDay.date === date) {
      const d=progress.reviewDay;
      if(d.completionRule!==2){
        // Older releases counted submissions, including wrong answers. Only
        // retain successes supported by the existing word state.
        d.oldDone=d.oldDone.filter(k=>progress.records[k]?.streak>0&&!progress.records[k].flagged);
        d.completionRule=2;
      }
      return d;
    }
    const d = progress.reviewDay = {version:1,completionRule:2,date,oldKeys:[],oldDone:[],newDone:{}};
    // Count genuine work already done in an unfinished legacy session today.
    // A carried correction remains mandatory, without creating another attempt.
    for (const s of Object.values(progress.sessions || {})) {
      if (s.kind !== 'wrong' || s.mode !== 'review') continue;
      const tested = s.queue.slice(0,s.index).concat(s.answered ? [s.queue[s.index]] : []);
      for (const key of tested) {
        const r = progress.records[key];
        if (!byKey.has(key) || !r || (dayKey(r.lastSeen || 0) !== date && !(key === s.queue[s.index] && pendingCorrection(s)))) continue;
        if (isNew(r,date)) d.newDone[key] = r.attempts || 0;
        else if (!d.oldKeys.includes(key) && d.oldKeys.length < LIMIT) {
          d.oldKeys.push(key);
          const current=key===s.queue[s.index]&&s.answered;
          if(current?s.result?.results?.[0]?.correct&&!s.result.guessed:r.streak>0&&!r.flagged)d.oldDone.push(key);
        }
      }
    }
    return d;
  }

  function schedule(progress, items, now = Date.now(), pin = null) {
    const d = ensureDay(progress,items,now), records = progress.records;
    d.oldKeys=d.oldKeys.filter(k=>!isNew(records[k],d.date));
    d.oldDone=d.oldDone.filter(k=>d.oldKeys.includes(k));
    const old = items.filter(w => {
      const r = records[keyFor(w)];
      return r && !isNew(r,d.date) && ((r.dueAt > 0 && r.dueAt <= now) || (r.flagged && !r.dueAt) || r.manualPending);
    });
    const selected = new Set(d.oldKeys);
    const add = w => { const k = keyFor(w); if (!d.cloudLocked && selected.size < LIMIT && !selected.has(k)) { selected.add(k); d.oldKeys.push(k); } };
    const pinned = old.find(w => keyFor(w) === pin); if (pinned) add(pinned);
    const remaining = LIMIT - selected.size;
    // An explicit workload policy, not a claimed scientifically optimal ratio:
    // reserve half for weak/recently learned due words, half for the oldest debt.
    const weak = old.filter(w => { const r=records[keyFor(w)]; return r.flagged || (r.streak || 0) <= 1; })
      .sort((a,b) => (records[keyFor(b)].lastSeen || 0) - (records[keyFor(a)].lastSeen || 0) || (records[keyFor(a)].dueAt || 0) - (records[keyFor(b)].dueAt || 0) || keyFor(a).localeCompare(keyFor(b)));
    let taken=0;
    for (const w of weak) if (!selected.has(keyFor(w)) && taken < Math.ceil(remaining/2)) { add(w); taken++; }
    const oldest = [...old].sort((a,b) => (records[keyFor(a)].dueAt || 0) - (records[keyFor(b)].dueAt || 0) || keyFor(a).localeCompare(keyFor(b)));
    for (const w of oldest) add(w);
    const done = new Set(d.oldDone);
    // Once admitted, an old word stays in today's work until independent
    // recall succeeds. A failed attempt's future SRS date cannot hide it.
    const oldPending = d.oldKeys.filter(k => !done.has(k));
    const newPending = items.filter(w => {
      const k=keyFor(w),r=records[k];
      return isNew(r,d.date) && (r.flagged || r.manualPending) && (d.newDone[k] === undefined || d.newDone[k] < (r.attempts || 0));
    }).map(keyFor);
    const admitted = new Set(d.oldKeys);
    const deferred = old.filter(w=>!admitted.has(keyFor(w))).length;
    return {date:d.date,keys:[...newPending,...oldPending],oldPending:oldPending.length,newPending:newPending.length,
      oldDone:d.oldDone.length,oldSelected:d.oldKeys.length,deferred,limit:LIMIT};
  }

  function markReviewed(progress, item, items, now=Date.now(), correct) {
    const d=ensureDay(progress,items,now),key=keyFor(item),r=progress.records[key];
    if(isNew(r,d.date))d.newDone[key]=r.attempts || 0;
    else if(d.oldKeys.includes(key)){
      const success=correct===undefined?r.streak>0&&!r.flagged:correct;
      d.oldDone=d.oldDone.filter(k=>k!==key);
      if(success)d.oldDone.push(key);
    }
    if(progress.reviewDrafts)delete progress.reviewDrafts[key];
  }
  function reopen(progress,key,items,now=Date.now()) {
    const d=ensureDay(progress,items,now);d.oldDone=d.oldDone.filter(k=>k!==key);delete d.newDone[key];
  }

  function prepare(progress,items,cached,now=Date.now(),restart=false) {
    const key=cached?.queue[cached.index],carry=pendingCorrection(cached);
    const active=cached&&(!cached.reviewDate||cached.reviewDate===dayKey(now)||carry);
    const drafting=cached&&!cached.answered&&key&&cached.answers?.some(Boolean);
    const p=schedule(progress,items,now,drafting||active&&!cached.answered?key:null),d=progress.reviewDay;
    const eligible=new Set(p.keys),known=new Set(items.map(keyFor));
    if(drafting){
      progress.reviewDrafts ||= {};progress.reviewDrafts[key]=cached.answers[0];
    }
    const prefix=active?cached.queue.slice(0,cached.index).filter(k=>known.has(k)&&(d.oldKeys.includes(k)||isNew(progress.records[k],d.date))):[];
    const hold=active&&cached.answered&&(!restart||carry);
    const tail=active?cached.queue.slice(cached.index+(cached.answered?1:0)).filter(k=>eligible.has(k)):[];
    const pending=[...new Set([...tail,...p.keys])].filter(k=>!hold||k!==key);
    if(hold&&eligible.has(key))pending.push(key);
    const queue=prefix.concat(hold?[key]:[],pending);
    const current=queue[prefix.length],same=active&&key===current&&!restart;
    return {queue,index:prefix.length,answered:!!hold,answers:hold?[...cached.answers]:same?[...cached.answers]:[progress.reviewDrafts?.[current] || ''],
      result:hold?structuredClone(cached.result):null,repeat:false,reviewDate:d.date};
  }
  return {LIMIT,dayKey,isNew,ensureDay,schedule,markReviewed,reopen,prepare};
});
