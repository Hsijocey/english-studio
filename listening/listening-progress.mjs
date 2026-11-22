function clone(v) {
  return structuredClone(v);
}

function pickStage(a, b) {
  if (!a) return b ? clone(b) : undefined;
  if (!b) return clone(a);
  const ta = Date.parse(a.updatedAt || a.date || '') || 0;
  const tb = Date.parse(b.updatedAt || b.date || '') || 0;
  return tb > ta ? clone(b) : clone(a);
}

function mergeUnit(a, b) {
  const out = clone(a);
  out.stages = out.stages || {};
  for (const k of ['d1', 'd2blind', 'd2verify', 'd7']) {
    const merged = pickStage(a.stages?.[k], b.stages?.[k]);
    if (merged) out.stages[k] = merged;
  }
  out.drafts = { ...(a.drafts || {}) };
  for (const [k, d] of Object.entries(b.drafts || {})) {
    if (out.stages[k]) continue;
    const ta = Date.parse(out.drafts[k]?.updatedAt || '') || 0;
    const tb = Date.parse(d?.updatedAt || '') || 0;
    if (!out.drafts[k] || tb > ta) out.drafts[k] = clone(d);
  }
  out.reviewDone = !!(a.reviewDone || b.reviewDone);
  out.day1 = a.day1 || b.day1 || undefined;
  out.day2 = a.day2 || b.day2 || undefined;
  out.day7 = a.day7 || b.day7 || undefined;
  if (a.confirmedCompleted || b.confirmedCompleted) {
    out.confirmedCompleted = { ...(a.confirmedCompleted || {}), ...(b.confirmedCompleted || {}) };
  }
  if (a.scheduleAnchorNote || b.scheduleAnchorNote) {
    out.scheduleAnchorNote = a.scheduleAnchorNote || b.scheduleAnchorNote;
  }
  if (a.listeningReview || b.listeningReview) {
    const la = a.listeningReview || {};
    const lb = b.listeningReview || {};
    const difficultCues = [...new Set([...(la.difficultCues || []), ...(lb.difficultCues || [])])].sort((x, y) => x - y);
    const reasonsByStage = clone(la.reasonsByStage || {});
    for (const [st, map] of Object.entries(lb.reasonsByStage || {})) {
      reasonsByStage[st] = { ...(reasonsByStage[st] || {}), ...map };
    }
    out.listeningReview = { ...la, ...lb, difficultCues, reasonsByStage };
  }
  return out;
}

export function mergeProgress(base, incoming) {
  if (!base) return clone(incoming);
  if (!incoming) return clone(base);
  const out = clone(base);
  out.schema = 1;
  out.nextBatch = Math.max(Number(base.nextBatch) || 5, Number(incoming.nextBatch) || 5);
  out.settings = { speed: 1, ...(base.settings || {}), ...(incoming.settings || {}) };
  out.legacy = (base.legacy?.length ? base.legacy : incoming.legacy) || [];

  const byKey = new Map();
  const keyOf = (u) => u.id || `${u.batch}:${u.setId}`;
  for (const u of base.units || []) byKey.set(keyOf(u), clone(u));
  for (const u of incoming.units || []) {
    const k = keyOf(u);
    const sameBatch = [...byKey.values()].find((x) => x.batch === u.batch && x.setId === u.setId);
    if (byKey.has(k)) {
      byKey.set(k, mergeUnit(byKey.get(k), u));
    } else if (sameBatch) {
      byKey.set(keyOf(sameBatch), mergeUnit(sameBatch, u));
    } else {
      byKey.set(k, clone(u));
    }
  }
  out.units = [...byKey.values()].sort((x, y) => x.batch - y.batch);

  // Pick the most recent dailyTask
  const da = base.dailyTask;
  const db = incoming.dailyTask;
  if (!da) out.dailyTask = db ? clone(db) : null;
  else if (!db) out.dailyTask = clone(da);
  else if (db.date > da.date) out.dailyTask = clone(db);
  else if (da.date > db.date) out.dailyTask = clone(da);
  else out.dailyTask = db.completed && !da.completed ? clone(db) : clone(da);

  return out;
}
