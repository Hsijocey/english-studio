function addDays(date, n) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return [
    x.getFullYear(),
    String(x.getMonth() + 1).padStart(2, '0'),
    String(x.getDate()).padStart(2, '0'),
  ].join('-');
}

export function stageFor(u) {
  if (!u) return 'd1';
  const cc = u.confirmedCompleted || {};
  const st = u.stages || {};
  if (st.d7 || cc.d7) return 'done';
  if (st.d2verify || cc.d2) return 'd7';
  if (st.d2blind) return u.reviewDone ? 'd2verify' : 'review';
  if (st.d1 || cc.d1) return 'd2blind';
  return 'd1';
}

export function dueDate(u) {
  const stage = stageFor(u);
  const cc = u.confirmedCompleted || {};
  const d1 = u.day1 || u.stages?.d1?.date || cc.d1?.completedBy || u.created;
  const d2 = u.day2 || u.stages?.d2verify?.date || cc.d2?.completedBy || null;
  if (stage === 'd2blind') {
    return d1 ? addDays(d1, 1) : null;
  }
  if (stage === 'd7') {
    const candidates = [];
    if (d1) candidates.push(addDays(d1, 6));
    if (d2) candidates.push(addDays(d2, 1));
    else if (d1) candidates.push(addDays(d1, 1));
    return candidates.length ? candidates.sort().at(-1) : null;
  }
  return null;
}

function isTaskCompletedForUnit(task, u) {
  if (!u) return false;
  if (task.kind === 'd1') return !!(u.stages?.d1 || u.confirmedCompleted?.d1);
  if (task.kind === 'd2') return !!(u.stages?.d2verify || u.confirmedCompleted?.d2);
  if (task.kind === 'd7') return !!(u.stages?.d7 || u.confirmedCompleted?.d7);
  return false;
}

export function planDailyTask(state, bank, todayStr) {
  const units = Array.isArray(state?.units) ? state.units : [];
  const legacy = Array.isArray(state?.legacy) ? state.legacy : [];
  const existing = state?.dailyTask;

  // If today already has a locked task, keep it and refresh its completion state
  if (existing && existing.date === todayStr) {
    const u = existing.unitId ? units.find((x) => x.id === existing.unitId) : null;
    if (u) {
      const done = existing.completed || isTaskCompletedForUnit(existing, u);
      return { ...existing, completed: done };
    }
    if (!existing.unitId && existing.setId) {
      const matched = units.find((x) => x.setId === existing.setId && x.created === todayStr);
      if (matched) {
        return {
          ...existing,
          unitId: matched.id,
          completed: isTaskCompletedForUnit(existing, matched),
        };
      }
      return { ...existing };
    }
  }

  // Check if any unit already completed a main milestone today (e.g. from import)
  for (const u of units) {
    if (u.day7 === todayStr && u.stages?.d7) {
      return { date: todayStr, kind: 'd7', unitId: u.id, setId: u.setId, completed: true };
    }
    if (u.day2 === todayStr && u.stages?.d2verify) {
      return { date: todayStr, kind: 'd2', unitId: u.id, setId: u.setId, completed: true };
    }
    if (u.day1 === todayStr && u.stages?.d1) {
      return { date: todayStr, kind: 'd1', unitId: u.id, setId: u.setId, completed: true };
    }
  }

  const open = units.filter((u) => stageFor(u) !== 'done');
  const isDueNow = (u) => {
    const d = dueDate(u);
    return !d || d <= todayStr;
  };

  // Priority 1: Due Day 7
  const d7Due = open
    .filter((u) => stageFor(u) === 'd7' && isDueNow(u))
    .sort((a, b) => (dueDate(a) || '0000').localeCompare(dueDate(b) || '0000') || a.batch - b.batch);
  if (d7Due.length) {
    return { date: todayStr, kind: 'd7', unitId: d7Due[0].id, setId: d7Due[0].setId, completed: false };
  }

  // Priority 2: Due Day 2 (d2blind / review / d2verify)
  const d2Due = open
    .filter((u) => ['d2blind', 'review', 'd2verify'].includes(stageFor(u)) && isDueNow(u))
    .sort((a, b) => (dueDate(a) || '0000').localeCompare(dueDate(b) || '0000') || a.batch - b.batch);
  if (d2Due.length) {
    return { date: todayStr, kind: 'd2', unitId: d2Due[0].id, setId: d2Due[0].setId, completed: false };
  }

  // Priority 3: Unfinished Day 1 unit
  const d1Open = open.filter((u) => stageFor(u) === 'd1').sort((a, b) => a.batch - b.batch);
  if (d1Open.length) {
    return { date: todayStr, kind: 'd1', unitId: d1Open[0].id, setId: d1Open[0].setId, completed: false };
  }

  // Priority 4: Suggest next unplayed set from bank (Part 1 first, then Part 2/3)
  const used = new Set([...legacy.flatMap((x) => x.ids || []), ...units.map((u) => u.setId)]);
  const next =
    bank.find((x) => x.available && x.part === 1 && !used.has(x.id)) ||
    bank.find((x) => x.available && !used.has(x.id));
  if (!next) return null;
  return { date: todayStr, kind: 'd1', unitId: null, setId: next.id, completed: false };
}

export function roundErrors(u, q) {
  if (!u?.stages) return [];
  const rows = [];
  for (const stage of ['d1', 'd2blind', 'd2verify', 'd7']) {
    const entry = u.stages[stage];
    if (!entry) continue;
    rows.push({
      stage,
      date: entry.date,
      given: entry.answers?.[q] ?? '',
      correct: entry.right?.[q] === true,
      uncertain: Array.isArray(entry.flags) && entry.flags.includes(Number(q)),
    });
  }
  return rows;
}

export function buildWeakPointLedger(state, bank) {
  const byId = Object.fromEntries((bank || []).map((x) => [x.id, x]));
  const events = [];
  for (const u of state?.units || []) {
    const set = byId[u.setId];
    if (!set) continue;
    for (const stage of ['d1', 'd2blind', 'd2verify', 'd7']) {
      const entry = u.stages?.[stage];
      if (!entry) continue;
      for (let n = set.questionStart; n < set.questionStart + 10; n++) {
        const wrong = entry.right?.[n] === false;
        const uncertain = Array.isArray(entry.flags) && entry.flags.includes(n);
        if (!wrong && !uncertain) continue;
        const reference = String(set.answers?.[n] ?? '');
        events.push({
          id: `${u.id}:${stage}:${n}`,
          unitId: u.id,
          setId: u.setId,
          batch: u.batch,
          question: n,
          stage,
          date: entry.date || '',
          given: String(entry.answers?.[n] ?? ''),
          reference,
          wrong,
          uncertain,
          focusWord: reference.split('/')[0].trim().toLowerCase(),
          reason: u.listeningReview?.reasonsByStage?.[stage]?.[n] || '',
        });
      }
    }
  }
  return { version: 1, events };
}

export function restoreConfirmedProgress(p, bank) {
  const out = structuredClone(p || {});
  out.schema = 1;
  out.units = Array.isArray(out.units) ? out.units : [];
  out.nextBatch = Number.isInteger(out.nextBatch)
    ? Math.max(out.nextBatch, out.units.reduce((m, u) => Math.max(m, (u.batch || 0) + 1), 5))
    : 5;
  out.settings = { speed: 1, ...(out.settings || {}) };
  for (const u of out.units) {
    u.stages = u.stages || {};
    u.drafts = u.drafts || {};
    if (u.stages.d2verify || u.confirmedCompleted?.d2) {
      u.reviewDone = true;
    }
  }
  return out;
}
