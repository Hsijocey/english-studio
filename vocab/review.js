(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VocabReview = api;
})(globalThis, function () {
  'use strict';

  const LIMIT = 50;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TARGET_RETENTION = 0.85;
  // FSRS-4.5 power-law forgetting curve constants: R(t, S) = (1 + FACTOR * t / S)^DECAY
  const FSRS_FACTOR = 19 / 81;
  const FSRS_DECAY = -0.5;
  const INTERVAL_SCALE = (Math.pow(TARGET_RETENTION, 1 / FSRS_DECAY) - 1) / FSRS_FACTOR; // ~1.637 for R=0.85

  const keyFor = w => w.recordKey || `${w.groupId}:${w.word}`;
  const dayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const dayKey = (now = Date.now()) => dayFormatter.format(new Date(now));
  const isNew = (r, day) => !!r?.firstLearnedAt && dayKey(r.firstLearnedAt) === day;
  const pendingCorrection = s => s?.answered && s.result?.results?.[0]?.correct === false && s.result.correction?.done !== true;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * Infer FSRS Stability (days) & Difficulty (1..10) seamlessly from legacy records.
   */
  function inferStability(r) {
    if (!r) return 1.0;
    if (Number.isFinite(r.stability) && r.stability > 0) return clamp(r.stability, 0.25, 180);
    if (r.dueAt > 0 && r.lastSeen > 0 && r.dueAt > r.lastSeen) {
      const scheduledDays = (r.dueAt - r.lastSeen) / DAY_MS;
      if (scheduledDays >= 0.5) return clamp(scheduledDays / INTERVAL_SCALE, 0.5, 60);
    }
    const streakMap = [0.8, 1.2, 2.8, 6.0, 12.0, 24.0];
    return streakMap[Math.min(r.streak || 0, streakMap.length - 1)];
  }

  function inferDifficulty(r) {
    if (!r) return 5.0;
    if (Number.isFinite(r.difficulty) && r.difficulty >= 1) return clamp(r.difficulty, 1, 10);
    const att = r.attempts || 0;
    if (!att) return 5.0;
    const errRate = (att - (r.correct || 0)) / att;
    return clamp(3.5 + errRate * 5.5, 2.5, 9.5);
  }

  /**
   * Current recall probability R(t, S) in (0, 1].
   */
  function retrievability(r, now = Date.now()) {
    if (!r || !r.lastSeen) return 0;
    const elapsedDays = Math.max(0, (now - r.lastSeen) / DAY_MS);
    const s = inferStability(r);
    return Math.pow(1 + FSRS_FACTOR * (elapsedDays / s), FSRS_DECAY);
  }

  function nextIntervalDays(stability) {
    return clamp(Math.round(stability * INTERVAL_SCALE), 1, 120);
  }

  /**
   * Lightweight FSRS DSR update for three grades:
   *  - 'good': independent recall (or fast-track confident confirmation)
   *  - 'hint': recalled with graduated letter hint (half-mastery, 1-2d consolidation, never resets streak to 0)
   *  - 'again': failed recall / guessed (soft lapse decay instead of hard reset to Day 1 for mature cards)
   */
  function gradeRecord(previous, grade, { now = Date.now(), mode = 'review', isFirstLearn = false } = {}) {
    const next = { ...previous };
    if (!previous.attempts && !previous.firstLearnedAt && isFirstLearn) next.firstLearnedAt = now;
    const prevS = inferStability(previous);
    const prevD = inferDifficulty(previous);
    const R = previous.lastSeen ? retrievability(previous, now) : 0.85;

    next.attempts = (previous.attempts || 0) + 1;
    next.lastSeen = now;
    next.lapses = previous.lapses || 0;

    if (grade === 'good') {
      next.correct = (previous.correct || 0) + 1;
      next.streak = (previous.streak || 0) + 1;
      const keepManual = previous.manualPending === true && mode !== 'review';
      next.flagged = keepManual;
      if (previous.manualPending) next.manualPending = keepManual;

      // FSRS stability growth rewards recalling after longer elapsed time (lower R)
      const difficultyFactor = (11 - prevD) * 0.14;
      const decayDamping = Math.pow(Math.max(prevS, 0.5), -0.15);
      const spacingBonus = Math.exp(0.9 * (1 - R)) - 1;
      const mult = clamp(1 + difficultyFactor * decayDamping * (spacingBonus + 0.65) + 0.45, 1.55, 4.2);
      const newS = previous.attempts ? clamp(prevS * mult, 1.0, 180) : 1.0;
      const newD = clamp(prevD - 0.35, 1, 10);
      next.stability = Number(newS.toFixed(2));
      next.difficulty = Number(newD.toFixed(2));
      const days = nextIntervalDays(newS);
      next.dueAt = keepManual ? Math.min(previous.dueAt || now, now) : now + days * DAY_MS;
    } else if (grade === 'hint') {
      // Scaffolded retrieval: counts as a guided practice, holds streak >= 1, schedules 1-2 days
      next.correct = (previous.correct || 0) + 1;
      next.streak = Math.max(1, previous.streak || 0);
      next.flagged = false;
      next.manualPending = false;
      const newS = clamp(Math.min(prevS * 0.85, 1.4), 0.7, 1.4);
      const newD = clamp(prevD + 0.25, 1, 10);
      next.stability = Number(newS.toFixed(2));
      next.difficulty = Number(newD.toFixed(2));
      const days = clamp(Math.round(newS * INTERVAL_SCALE), 1, 2);
      next.dueAt = now + days * DAY_MS;
    } else {
      // 'again' (lapse): FSRS soft decay for mature words so one slip doesn't trigger backlog avalanche
      next.lapses += 1;
      next.flagged = true;
      const newD = clamp(prevD + 0.8, 1, 10);
      const wasMature = (previous.streak || 0) >= 2 && prevS >= 2.5;
      const newS = wasMature ? clamp(prevS * 0.38, 1.1, 8.0) : 0.6;
      next.streak = wasMature ? Math.max(1, (previous.streak || 0) - 1) : 0;
      next.stability = Number(newS.toFixed(2));
      next.difficulty = Number(newD.toFixed(2));
      const days = wasMature ? clamp(Math.round(newS * 1.1), 1, 3) : 1;
      next.dueAt = now + days * DAY_MS;
    }

    return next;
  }

  function isLeech(r) {
    if (!r) return false;
    const wrong = (r.attempts || 0) - (r.correct || 0);
    return (r.lapses || 0) >= 4 || (wrong >= 5 && (r.correct || 0) / Math.max(1, r.attempts || 1) < 0.5);
  }

  function isFastTrackEligible(r) {
    if (!r) return false;
    return !r.flagged && !r.manualPending && !isLeech(r) && (r.streak || 0) >= 2 && inferStability(r) >= 2.5;
  }

  function ensureDay(progress, items, now = Date.now()) {
    const date = dayKey(now), byKey = new Map(items.map(w => [keyFor(w), w]));
    if (!progress.reviewDay) {
      for (const r of Object.values(progress.records)) {
        if (!r.firstLearnedAt && r.attempts === 1 && r.lastSeen > 0) r.firstLearnedAt = r.lastSeen;
      }
    }
    if (progress.reviewDay?.version === 1 && progress.reviewDay.date === date) {
      const d = progress.reviewDay;
      if (d.completionRule !== 2) {
        d.oldDone = d.oldDone.filter(k => progress.records[k]?.streak > 0 && !progress.records[k].flagged);
        d.completionRule = 2;
      }
      return d;
    }
    const d = progress.reviewDay = { version: 1, completionRule: 2, date, oldKeys: [], oldDone: [], newDone: [] };
    d.newDone = {};
    for (const s of Object.values(progress.sessions || {})) {
      if (s.kind !== 'wrong' || s.mode !== 'review') continue;
      const tested = s.queue.slice(0, s.index).concat(s.answered ? [s.queue[s.index]] : []);
      for (const key of tested) {
        const r = progress.records[key];
        if (!byKey.has(key) || !r || (dayKey(r.lastSeen || 0) !== date && !(key === s.queue[s.index] && pendingCorrection(s)))) continue;
        if (isNew(r, date)) d.newDone[key] = r.attempts || 0;
        else if (!d.oldKeys.includes(key) && d.oldKeys.length < LIMIT) {
          d.oldKeys.push(key);
          const current = key === s.queue[s.index] && s.answered;
          if (current ? s.result?.results?.[0]?.correct && !s.result.guessed : r.streak > 0 && !r.flagged) d.oldDone.push(key);
        }
      }
    }
    return d;
  }

  /**
   * Anti-avalanche FSRS Descending-Retrievability Scheduler:
   *  1. Golden-window fresh due words (R >= 0.45 or overdue <= 7d) sorted by DESCENDING R
   *     -> saves fresh words at 80-85% retention before they rot into backlog!
   *  2. Recent weak / flagged words seen in last 7 days (up to ~20% quota)
   *  3. Backlog relearning pool (overdue > 7d, R < 0.45) capped gently (~20% when fresh pool is full,
   *     or fills remaining slots when fresh pool is small), also sorted by DESCENDING R.
   */
  function schedule(progress, items, now = Date.now(), pin = null) {
    const d = ensureDay(progress, items, now), records = progress.records;
    d.oldKeys = d.oldKeys.filter(k => !isNew(records[k], d.date));
    d.oldDone = d.oldDone.filter(k => d.oldKeys.includes(k));
    if (d.oldKeys.length > LIMIT) {
      const keep = new Set(d.oldDone);
      if (pin && d.oldKeys.includes(pin)) keep.add(pin);
      if (keep.size >= LIMIT) {
        d.oldKeys = d.oldKeys.filter(k => keep.has(k));
      } else {
        const trimmed = [];
        let extra = LIMIT - keep.size;
        for (const k of d.oldKeys) {
          if (keep.has(k)) trimmed.push(k);
          else if (extra > 0) { trimmed.push(k); extra--; }
        }
        d.oldKeys = trimmed;
      }
      d.oldDone = d.oldDone.filter(k => d.oldKeys.includes(k));
    }

    const old = items.filter(w => {
      const r = records[keyFor(w)];
      return r && !isNew(r, d.date) && ((r.dueAt > 0 && r.dueAt <= now) || (r.flagged && !r.dueAt) || r.manualPending);
    });

    const meta = new Map();
    for (const w of old) {
      const k = keyFor(w), r = records[k];
      const R = retrievability(r, now);
      const overdueDays = r.dueAt > 0 ? Math.max(0, (now - r.dueAt) / DAY_MS) : 0;
      const recentDays = r.lastSeen > 0 ? Math.max(0, (now - r.lastSeen) / DAY_MS) : 999;
      const mature = isFastTrackEligible(r) && (r.streak || 0) >= 3 && R >= 0.55;
      const isGoldenFresh = !mature && (recentDays <= 10 || overdueDays <= 7 || r.manualPending);
      meta.set(k, { R, overdueDays, recentDays, mature, isGoldenFresh });
    }

    const selected = new Set(d.oldKeys);
    const add = w => {
      const k = keyFor(w);
      if (!d.cloudLocked && selected.size < LIMIT && !selected.has(k)) {
        selected.add(k);
        d.oldKeys.push(k);
        return true;
      }
      return false;
    };

    const pinned = old.find(w => keyFor(w) === pin);
    if (pinned) add(pinned);

    const remaining = LIMIT - selected.size;
    if (remaining > 0) {
      // Bucket 1 (~50%): Golden-window fresh & recent words (not yet mature), Descending R
      const freshPool = old
        .filter(w => meta.get(keyFor(w)).isGoldenFresh)
        .sort((a, b) => {
          const ka = keyFor(a), kb = keyFor(b);
          const ma = meta.get(ka), mb = meta.get(kb);
          const mp = (records[kb].manualPending ? 1 : 0) - (records[ka].manualPending ? 1 : 0);
          return mp || (mb.R - ma.R) || (ma.recentDays - mb.recentDays) || ka.localeCompare(kb);
        });

      // Bucket 2 (~30%): Mature fast-track maintenance words (quick 2s confirmation, boosts accuracy & keeps long-term memory fresh)
      const maturePool = old
        .filter(w => meta.get(keyFor(w)).mature)
        .sort((a, b) => {
          const ka = keyFor(a), kb = keyFor(b);
          const ma = meta.get(ka), mb = meta.get(kb);
          return (mb.R - ma.R) || (ma.overdueDays - mb.overdueDays) || ka.localeCompare(kb);
        });

      // Bucket 3 (~20% reserved): Deep backlog & weak relearning pool, Descending R (most recoverable first)
      const backlogPool = old
        .filter(w => !meta.get(keyFor(w)).isGoldenFresh && !meta.get(keyFor(w)).mature)
        .sort((a, b) => {
          const ka = keyFor(a), kb = keyFor(b);
          const ma = meta.get(ka), mb = meta.get(kb);
          return (mb.R - ma.R) || (ma.overdueDays - mb.overdueDays) || ka.localeCompare(kb);
        });

      const takeUpTo = (pool, cap) => {
        let taken = 0;
        for (const w of pool) {
          if (taken >= cap) break;
          if (add(w)) taken++;
        }
      };

      takeUpTo(freshPool, Math.round(remaining * 0.50));
      takeUpTo(maturePool, Math.round(remaining * 0.30));
      takeUpTo(backlogPool, Math.max(Math.round(LIMIT * 0.20), remaining - (selected.size - (LIMIT - remaining))));

      // Fill any leftover capacity cleanly: fresh -> backlog -> mature
      for (const w of freshPool) add(w);
      for (const w of backlogPool) add(w);
      for (const w of maturePool) add(w);
    }

    const done = new Set(d.oldDone);
    const oldPending = d.oldKeys.filter(k => !done.has(k));
    const newPending = items.filter(w => {
      const k = keyFor(w), r = records[k];
      return isNew(r, d.date) && (r.flagged || r.manualPending) && (d.newDone[k] === undefined || d.newDone[k] < (r.attempts || 0));
    }).map(keyFor);

    const admitted = new Set(d.oldKeys);
    const deferred = old.filter(w => !admitted.has(keyFor(w))).length;
    const freshPending = oldPending.filter(k => {
      const m = meta.get(k);
      return m ? (m.isGoldenFresh || m.mature) : true;
    }).length;
    const backlogPending = Math.max(0, oldPending.length - freshPending);

    return {
      date: d.date,
      keys: [...newPending, ...oldPending],
      oldPending: oldPending.length,
      freshPending,
      backlogPending,
      newPending: newPending.length,
      oldDone: d.oldDone.length,
      oldSelected: d.oldKeys.length,
      deferred,
      limit: LIMIT
    };
  }

  function markReviewed(progress, item, items, now = Date.now(), correct) {
    const d = ensureDay(progress, items, now), key = keyFor(item), r = progress.records[key];
    if (isNew(r, d.date)) d.newDone[key] = r.attempts || 0;
    else if (d.oldKeys.includes(key)) {
      const success = correct === undefined ? r.streak > 0 && !r.flagged : correct;
      d.oldDone = d.oldDone.filter(k => k !== key);
      if (success) d.oldDone.push(key);
    }
    if (progress.reviewDrafts) delete progress.reviewDrafts[key];
  }

  function reopen(progress, key, items, now = Date.now()) {
    const d = ensureDay(progress, items, now);
    d.oldDone = d.oldDone.filter(k => k !== key);
    delete d.newDone[key];
  }

  function prepare(progress, items, cached, now = Date.now(), restart = false) {
    const key = cached?.queue[cached.index], carry = pendingCorrection(cached);
    const active = cached && (!cached.reviewDate || cached.reviewDate === dayKey(now) || carry);
    const drafting = cached && !cached.answered && key && cached.answers?.some(Boolean);
    const p = schedule(progress, items, now, drafting || carry || (active && !cached.answered) ? key : null), d = progress.reviewDay;
    const eligible = new Set(p.keys), known = new Set(items.map(keyFor));
    if (drafting) {
      progress.reviewDrafts ||= {};
      progress.reviewDrafts[key] = cached.answers[0];
    }
    const prefix = active ? cached.queue.slice(0, cached.index).filter(k => known.has(k) && (d.oldKeys.includes(k) || isNew(progress.records[k], d.date))) : [];
    const hold = active && cached.answered && (!restart || carry);
    const tail = active ? cached.queue.slice(cached.index + (cached.answered ? 1 : 0)).filter(k => eligible.has(k)) : [];
    const pending = [...new Set([...tail, ...p.keys])].filter(k => !hold || k !== key);
    if (hold && eligible.has(key)) pending.push(key);
    const queue = prefix.concat(hold ? [key] : [], pending);
    const current = queue[prefix.length], same = active && key === current && !restart;
    return {
      queue,
      index: prefix.length,
      answered: !!hold,
      answers: hold ? [...cached.answers] : same ? [...cached.answers] : [progress.reviewDrafts?.[current] || ''],
      result: hold ? structuredClone(cached.result) : null,
      repeat: false,
      reviewDate: d.date
    };
  }

  return {
    LIMIT,
    dayKey,
    isNew,
    inferStability,
    inferDifficulty,
    retrievability,
    nextIntervalDays,
    gradeRecord,
    isLeech,
    isFastTrackEligible,
    ensureDay,
    schedule,
    markReviewed,
    reopen,
    prepare
  };
});
