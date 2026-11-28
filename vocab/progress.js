(function (root, factory) {
  const api = factory(root.VocabPlan || (typeof require === 'function' ? require('./plan.js') : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VocabProgress = api;
})(globalThis, function (plan) {
  "use strict";
  const KEY = "vocab-listening-lab-v1";
  const BACKUP_KEY = `${KEY}-backup`;
  const UPGRADE_BACKUP_KEY = `${KEY}-before-v6`;
  const PLAN_BACKUP_KEY = `${KEY}-before-plan45-v1`;
  const PLAN30_BACKUP_KEY = `${KEY}-before-plan30-v2`;
  const RESTORE_BACKUP_KEY = `${KEY}-before-restore`;
  const modes = ["study", "recall", "dictation", "review"];
  const kinds = ["group", "wrong", "block"];
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const clone = value => structuredClone(value);

  function normalize(input, defaults, groups) {
    if (!object(input) || (input.schema !== undefined && ![1, 2, 3].includes(input.schema))) throw Error("进度版本或格式无法读取。");
    if (!object(input.records) || !object(input.completed) || !Array.isArray(input.completedGroups)) throw Error("进度记录不完整。");
    const ids = new Set(groups.map(group => group.id));
    if (!input.completedGroups.every(id => Number.isInteger(id) && ids.has(id))) throw Error("已完成词组的记录无法读取。");
    if (!Object.values(input.completed).every(value => typeof value === "boolean")) throw Error("训练阶段的记录无法读取。");
    for (const record of Object.values(input.records)) {
      if (!object(record)) throw Error("单词记录无法读取。");
      if (record.manualPending !== undefined && typeof record.manualPending !== "boolean") throw Error("手动复习标记无法读取。");
      if (record.lastReviewCorrect !== undefined && typeof record.lastReviewCorrect !== "boolean") throw Error("复习结果无法读取。");
      if (record.manualAddedAt !== undefined && (!Number.isFinite(record.manualAddedAt) || record.manualAddedAt < 0)) throw Error("手动加入时间无法读取。");
      for (const field of ["attempts", "correct", "streak", "lapses"]) if (record[field] !== undefined && !count(record[field])) throw Error("单词成绩无法读取。");
      for (const field of ["dueAt", "lastSeen", "firstLearnedAt", "lastReviewAt", "lastLearningAt", "stability", "difficulty"]) if (record[field] !== undefined && (!Number.isFinite(record[field]) || record[field] < 0)) throw Error("复习时间无法读取。");
    }
    if ((input.sessions !== undefined && !object(input.sessions)) || (input.groupSessions !== undefined && !object(input.groupSessions))) throw Error("训练位置无法读取。");
    const supportedVersions = plan?.SUPPORTED_VERSIONS || (plan ? [plan.VERSION] : []);
    if (input.planVersion !== undefined && !supportedVersions.includes(input.planVersion)) throw Error("学习计划版本无法读取。");
    if (input.dailyCompletedGroups !== undefined && (!Array.isArray(input.dailyCompletedGroups) || !input.dailyCompletedGroups.every(id => Number.isInteger(id) && id > plan.KEEP && ids.has(id)))) throw Error("已完成学习日无法读取。");
    const wordKeys = new Set(groups.flatMap(group => group.words.map(word => plan ? plan.wordKey(word, group.id) : `${group.id}:${word.word}`)));
    if (input.reviewDay !== undefined) {
      const d=input.reviewDay;
      if (d?.cloudLocked !== undefined && typeof d.cloudLocked !== 'boolean') throw Error("每日复习记录无法读取。");
      if (d?.completionRule !== undefined && d.completionRule !== 2) throw Error("每日复习规则无法读取。");
      if (!object(d) || d.version!==1 || !/^\d{4}-\d{2}-\d{2}$/.test(d.date||'') || !Array.isArray(d.oldKeys) || d.oldKeys.length>100 || new Set(d.oldKeys).size!==d.oldKeys.length || !d.oldKeys.every(k=>wordKeys.has(k)) || !Array.isArray(d.oldDone) || new Set(d.oldDone).size!==d.oldDone.length || !d.oldDone.every(k=>d.oldKeys.includes(k)) || !object(d.newDone) || !Object.entries(d.newDone).every(([k,n])=>wordKeys.has(k)&&count(n))) throw Error("每日复习记录无法读取。");
    }
    if (input.reviewDrafts !== undefined && (!object(input.reviewDrafts) || !Object.entries(input.reviewDrafts).every(([k,v])=>wordKeys.has(k)&&typeof v==='string'))) throw Error("复习草稿无法读取。");
    for (const session of Object.values(input.sessions || {})) {
      if (session.reviewDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(session.reviewDate)) throw Error("复习日期无法读取。");
      if (!object(session) || !ids.has(session.groupId) || !modes.includes(session.mode) || !kinds.includes(session.kind) ||
          !Array.isArray(session.queue) || !session.queue.every(key => wordKeys.has(key)) ||
          !count(session.index) || session.index > session.queue.length ||
          typeof session.answered !== "boolean" || !Array.isArray(session.answers) || !session.answers.every(answer => typeof answer === "string")) throw Error("保存的训练位置无法读取。");
      if (session.answered && (!object(session.result) || !Array.isArray(session.result.results) ||
          !session.result.results.length || !session.result.results.every(result => object(result) && wordKeys.has(result.key) && typeof result.answer === "string" && typeof result.correct === "boolean"))) throw Error("已提交答案的记录无法读取。");
      if (session.answered) {
        const correction = session.result.correction;
        if (correction !== undefined && (!object(correction) || typeof correction.draft !== "string" || typeof correction.done !== "boolean")) throw Error("订正记录无法读取。");
        const batch = session.mode === "dictation";
        const expectedLen = batch ? Math.min(session.result.results.length, session.queue.length - session.index) : 1;
        const expected = session.queue.slice(session.index, session.index + expectedLen);
        if (session.mode === "study" || session.result.type !== (batch ? "batch" : "single") ||
            (batch && (expectedLen < 1 || expectedLen > 5)) ||
            session.result.results.length !== expected.length || !session.result.results.every((result, index) => result.key === expected[index])) throw Error("已提交答案与训练位置不一致，无法读取。");
      }
    }
    const result = { ...clone(defaults), ...clone(input), schema: plan && groups.some(g => g.planVersion === plan.VERSION) ? 3 : 2,
      records: clone(input.records), completed: clone(input.completed),
      completedGroups: [...new Set(input.completedGroups)], sessions: clone(input.sessions || {}), groupSessions: clone(input.groupSessions || {}) };
    result.selectedGroup = ids.has(input.selectedGroup) ? input.selectedGroup : defaults.selectedGroup;
    result.today = input.today?.date === defaults.today.date && count(input.today.attempts) && count(input.today.correct)
      ? clone(input.today) : clone(defaults.today);
    result.voiceLang = ["en-GB", "en-US", "mixed"].includes(input.voiceLang) ? input.voiceLang : defaults.voiceLang;
    result.autoPlay = typeof input.autoPlay === "boolean" ? input.autoPlay : defaults.autoPlay;
    result.studyAutoPlay = typeof input.studyAutoPlay === "boolean" ? input.studyAutoPlay : (defaults.studyAutoPlay ?? true);
    result.reviewCueMode = ["colloc", "meaning", "blind"].includes(input.reviewCueMode) ? input.reviewCueMode : (defaults.reviewCueMode || "colloc");
    result.batchSize = [3, 5].includes(input.batchSize) ? input.batchSize : (defaults.batchSize || 3);
    result.fastTrack = typeof input.fastTrack === "boolean" ? input.fastTrack : (defaults.fastTrack ?? true);
    return plan ? plan.migrate(result, groups) : result;
  }

  function stageDone(progress, groupId, mode) {
    const key = plan && progress.planVersion === plan.VERSION ? plan.stageKey(groupId, mode) : `${groupId}:${mode}`;
    const completed = plan ? plan.completedIds(progress) : progress.completedGroups;
    return progress.completed[key] === true || (mode === "dictation" && completed.includes(groupId));
  }

  function recommendedMode(progress, groupId) {
    if (stageDone(progress, groupId, "dictation") || stageDone(progress, groupId, "recall")) return "dictation";
    return stageDone(progress, groupId, "study") ? "recall" : "study";
  }

  function initialSession(progress, groupId) {
    const last = progress.groupSessions?.[plan ? plan.groupSessionKey(groupId) : groupId] || progress.lastSession;
    if (last?.groupId === groupId && modes.includes(last.mode) && kinds.includes(last.kind)) {
      const cached = progress.sessions[plan ? plan.sessionKey(groupId, last.kind, last.mode) : `${groupId}:${last.kind}:${last.mode}`];
      const pendingCorrection = cached?.mode === "review" && cached.answered && cached.result?.results[0]?.correct === false && cached.result.correction?.done !== true;
      if (cached && cached.index < cached.queue.length && (pendingCorrection || !(cached.answered && cached.index + cached.result.results.length >= cached.queue.length)) &&
          (last.kind !== "group" || cached.repeat || !stageDone(progress, groupId, last.mode))) return { mode: last.mode, kind: last.kind };
    }
    return { mode: recommendedMode(progress, groupId), kind: "group" };
  }

  function createStore(storage, defaults, groups) {
    const store = { raw: null, progress: clone(defaults), problem: null, fresh: false };
    function problem(kind, message) { store.problem = { kind, message }; return false; }
    try {
      store.raw = storage.getItem(KEY);
      store.fresh = store.raw === null;
      if (store.raw !== null) store.progress = normalize(JSON.parse(store.raw), defaults, groups);
      else store.progress = normalize({ ...clone(defaults), sessions: {} }, defaults, groups);
    } catch (error) {
      problem(store.raw === null ? "unavailable" : "corrupt", store.raw === null
        ? "无法读取浏览器的保存空间，训练暂时暂停。请使用可保存网站数据的浏览器打开。"
        : "历史进度无法读取，训练暂时暂停。原始记录没有被清空；请先导出记录，再恢复有效备份。");
    }
    store.check = function () {
      if (store.problem) return false;
      try {
        if (storage.getItem(KEY) !== store.raw) return problem("conflict", "另一窗口更新了进度。当前训练已暂停，请读取最新进度后继续，避免覆盖旧记录。");
        return true;
      } catch { return problem("unavailable", "无法读取浏览器的保存空间，训练暂时暂停。当前记录没有被重置。"); }
    };
    store.save = function (progress) {
      if (store.problem && store.problem.kind !== "write") return false;
      try {
        if (storage.getItem(KEY) !== store.raw) return problem("conflict", "另一窗口更新了进度。当前训练已暂停，请读取最新进度后继续，避免覆盖旧记录。");
        const next = normalize(progress, defaults, groups);
        next.savedAt = new Date().toISOString();
        const raw = JSON.stringify(next);
        let legacy = false, previous = null;
        try { previous = JSON.parse(store.raw); legacy = object(previous) && (previous.schema === undefined || previous.schema === 1); } catch {}
        const safeSet = (k, v) => { try { storage.setItem(k, v); return true; } catch { return false; } };
        if (plan && next.planVersion === plan.VERSION && store.raw !== null && previous?.planVersion !== plan.VERSION) {
          const backupSlot = previous?.planVersion === 1 ? PLAN30_BACKUP_KEY : PLAN_BACKUP_KEY;
          if (storage.getItem(backupSlot) === null) safeSet(backupSlot, store.raw);
        }
        if (legacy && storage.getItem(UPGRADE_BACKUP_KEY) === null) safeSet(UPGRADE_BACKUP_KEY, store.raw);
        if (store.raw !== null) safeSet(BACKUP_KEY, store.raw);
        try {
          storage.setItem(KEY, raw);
        } catch {
          // Mobile Safari/WebView 5MB quota fallback: evict redundant localStorage backup keys first
          for (const extraKey of [UPGRADE_BACKUP_KEY, PLAN_BACKUP_KEY, PLAN30_BACKUP_KEY, RESTORE_BACKUP_KEY, BACKUP_KEY]) {
            try { storage.removeItem(extraKey); } catch {}
          }
          storage.setItem(KEY, raw);
        }
        store.raw = raw; store.progress = next; store.problem = null;
        return true;
      } catch {
        return problem("write", "这次进度尚未保存，训练暂时暂停。当前内容仍在页面里，请导出备份或重试保存后再关闭。");
      }
    };
    store.readBackup = function () {
      try { const raw = storage.getItem(BACKUP_KEY); return raw === null ? null : normalize(JSON.parse(raw), defaults, groups); }
      catch { return null; }
    };
    store.importProgress = function (input) {
      const next = normalize(input, defaults, groups);
      if (store.problem?.kind === "conflict" || (store.problem && !["corrupt", "write"].includes(store.problem.kind))) return false;
      try { if (storage.getItem(KEY) !== store.raw) return problem("conflict", "另一窗口更新了进度，请读取最新进度后再导入。"); }
      catch { return problem("unavailable", "无法读取保存空间，当前记录没有被替换。"); }
      try { if (store.raw !== null) storage.setItem(RESTORE_BACKUP_KEY, store.raw); }
      catch {
        // Keep import working even if localStorage is tight; disk backup already protects history
        for (const extraKey of [UPGRADE_BACKUP_KEY, PLAN_BACKUP_KEY, PLAN30_BACKUP_KEY, RESTORE_BACKUP_KEY]) {
          try { storage.removeItem(extraKey); } catch {}
        }
      }
      const prior = store.problem; store.problem = null;
      const ok = store.save(next);
      if (!ok && !store.problem) store.problem = prior;
      return ok;
    };
    return store;
  }

  return { KEY, BACKUP_KEY, UPGRADE_BACKUP_KEY, RESTORE_BACKUP_KEY, PLAN_BACKUP_KEY, PLAN30_BACKUP_KEY, normalize, stageDone, recommendedMode, initialSession, createStore };
});
