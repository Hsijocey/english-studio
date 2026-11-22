(() => {
  "use strict";

  const groups = Array.isArray(window.VOCAB_GROUPS) ? window.VOCAB_GROUPS : [];
  const plan = window.VocabPlan;
  const newId = () => {
    if(window.crypto?.randomUUID)return window.crypto.randomUUID();
    const bytes=new Uint8Array(16);
    if(window.crypto?.getRandomValues)window.crypto.getRandomValues(bytes);else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
    return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  };
  const review = window.VocabReview;
  const dayKey = () => review ? review.dayKey() : new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const tomorrow = () => Date.now() + 24 * 60 * 60 * 1000;
  const intervals = [1, 3, 7, 14, 30];
  let availableVoices = [];
  let autoplayTimer = null;
  let speakChainTimer = null;
  let speakWatchdogTimer = null;
  let speakToken = 0;
  let activeUtterances = [];

  const $ = (id) => document.getElementById(id);
  const els = {
    sidebar: $("sidebar"), sidebarBackdrop: $("sidebarBackdrop"), groupList: $("groupList"), sidebarClose: $("sidebarClose"), menuButton: $("menuButton"),
    groupEyebrow: $("groupEyebrow"), pageTitle: $("pageTitle"), todayAttempts: $("todayAttempts"), todayAccuracy: $("todayAccuracy"), dueCount: $("dueCount"),
    sessionLabel: $("sessionLabel"), cardProgressText: $("cardProgressText"), progressFill: $("progressFill"), promptKicker: $("promptKicker"),
    mainPrompt: $("mainPrompt"), promptDetail: $("promptDetail"), speakButton: $("speakButton"), answerForm: $("answerForm"), answerInput: $("answerInput"),
    batchAnswerForm: $("batchAnswerForm"), batchInputs: $("batchInputs"), batchCheckButton: $("batchCheckButton"), checkButton: $("checkButton"),
    manualWordActions: $("manualWordActions"), addWrongButton: $("addWrongButton"),
    feedback: $("feedback"), cardActions: $("cardActions"), unsureButton: $("unsureButton"), nextButton: $("nextButton"), practiceCard: $("practiceCard"),
    emptyCard: $("emptyCard"), emptyIcon: $("emptyIcon"), emptyTitle: $("emptyTitle"), emptyText: $("emptyText"), restartButton: $("restartButton"), wrongBadge: $("wrongBadge"),
    wrongCount: $("wrongCount"), blockLabel: $("blockLabel"), startWrongReview: $("startWrongReview"), startBlockReview: $("startBlockReview"),
    autoPlay: $("autoPlay"), resetProgress: $("resetProgress"), resetDialog: $("resetDialog"), cancelReset: $("cancelReset"), confirmReset: $("confirmReset"),
    studyState: $("studyState"), recallState: $("recallState"), dictationState: $("dictationState"), planMinutes: $("planMinutes"),
    progressNotice: $("progressNotice"), storageStatus: $("storageStatus"), exportProgress: $("exportProgress"),
    importProgress: $("importProgress"), retrySave: $("retrySave"), reloadProgress: $("reloadProgress"), restoreBackup: $("restoreBackup"), reviewLoad: $("reviewLoad"), syncNow: $("syncNow"), syncSignIn: $("syncSignIn")
  };

  const defaultProgress = {
    selectedGroup: 6,
    records: {},
    completed: {},
    completedGroups: [1, 2, 3, 4, 5],
    sessions: {},
    groupSessions: {},
    today: { date: dayKey(), attempts: 0, correct: 0 },
    voiceLang: "en-GB",
    autoPlay: true
  };

  const persistence = window.VocabProgress;
  if (!persistence || !plan || !review) {
    els.progressNotice.textContent = "进度组件没有载入，训练暂时暂停。请刷新页面后重试。";
    els.progressNotice.classList.remove("hidden");
    els.practiceCard.classList.add("hidden");
    return;
  }
  let storage;
  try { storage = window.localStorage; } catch {}
  const store = persistence.createStore(storage, defaultProgress, groups);
  let progress = store.progress;
  const cloudLib = window.VocabCloud;
  const legacyImport = store.raw;
  let clientId;
  try {clientId=storage.getItem('vocab-listening-lab-client-v1');if(!clientId){clientId=newId();storage.setItem('vocab-listening-lab-client-v1',clientId);}} catch {clientId=newId();}
  if(cloudLib&&!store.problem)cloudLib.upgrade(progress);
  let cloud=null,cloudStatus='loading',cloudMessage='',booting=true;
  let state = {
    mode: "study",
    sessionKind: "group",
    groupId: Math.min(Math.max(progress.selectedGroup || 6, 1), Math.max(groups.length, 1)),
    queue: [],
    index: 0,
    answered: false,
    answers: [],
    result: null,
    repeat: false,
    lastQueue: []
  };
  const itemByKey = new Map(groups.flatMap(group => group.words.map(word => [plan.wordKey(word, group.id), { ...word, groupId: group.id }])));
  const allItems = [...itemByKey.values()];

  function sessionKey(mode = state.mode, kind = state.sessionKind, groupId = state.groupId) {
    return plan.sessionKey(groupId, kind, mode);
  }

  function canResume(mode, kind) {
    return ["group", "wrong", "block"].includes(kind) && ["study", "recall", "dictation", "review"].includes(mode);
  }

  function rememberSession() {
    if (!canResume(state.mode, state.sessionKind) || !state.queue.length) return;
    const checkpoint = {
      groupId: state.groupId, kind: state.sessionKind, mode: state.mode,
      queue: state.queue.map(keyFor), index: state.index, answered: state.answered,
      answers: [...state.answers], result: state.result ? structuredClone(state.result) : null, repeat: state.repeat,
      runId:state.runId,runStartedAt:state.runStartedAt,deviceId:clientId,
      ...(state.sessionKind === "wrong" ? {reviewDate:dayKey()} : {})
    };
    const previous=progress.sessions[sessionKey()],{updatedAt,...prior}=previous||{};
    checkpoint.updatedAt=JSON.stringify(prior)===JSON.stringify(checkpoint)?updatedAt:new Date(Math.max(Date.now(),(Date.parse(updatedAt)||0)+1)).toISOString();
    progress.sessions[sessionKey()]=checkpoint;
    progress.lastSession = { groupId: state.groupId, kind: state.sessionKind, mode: state.mode };
    progress.groupSessions[plan.groupSessionKey(state.groupId)] = { ...progress.lastSession };
  }

  let draftSaveTimer = null;
  function saveProgress() {
    if (draftSaveTimer) { window.clearTimeout(draftSaveTimer); draftSaveTimer = null; }
    refreshDailyCounters();
    if(cloudLib)cloudLib.upgrade(progress);
    if(!booting)progress.navigationAt=Math.max(Date.now(),(progress.navigationAt||0)+1);
    rememberSession();
    const saved = store.save(progress);
    if (saved) progress = store.progress;
    renderStorageStatus();
    if(saved)cloud?.changed();
    return saved;
  }

  function renderStorageStatus() {
    const issue = store.problem;
    const labels={loading:'正在读取进度…',saving:'正在保存…',saved:'已保存到本机磁盘',static:'已保存在当前浏览器',offline:'浏览器已缓存 · 等待本机重试',signin:'本机服务未连接',account:'账号不一致 · 已暂停同步',local:'本机保存需要处理'};
    els.storageStatus.textContent = issue ? "进度保存需要处理" : cloud ? labels[cloudStatus] : "进度已保存在此浏览器";
    els.progressNotice.textContent = issue?.message || (cloud&&['offline','signin','account','local'].includes(cloudStatus)?cloudMessage||'当前记录保留在浏览器，恢复连接后自动保存。':store.fresh ? '' : "");
    els.progressNotice.classList.toggle("hidden", !els.progressNotice.textContent);
    els.retrySave.classList.toggle("hidden", issue?.kind !== "write");
    els.reloadProgress.classList.toggle("hidden", issue?.kind !== "conflict");
    els.restoreBackup.classList.toggle("hidden", issue?.kind !== "corrupt" || !store.readBackup());
    els.syncNow.classList.toggle('hidden',!cloud||!['offline','signin','account','local'].includes(cloudStatus));
    els.syncSignIn.classList.toggle('hidden',cloudStatus!=='signin'||!cloud);
  }

  function canAct() {
    const current = store.check();
    if (!current) { stopPlayback(); renderStorageStatus(); }
    if (current) refreshDailyCounters();
    return current;
  }

  function refreshDailyCounters() {
    const date=dayKey();
    if(defaultProgress.today.date!==date)defaultProgress.today={date,attempts:0,correct:0};
    if(progress.today.date!==date)progress.today={date,attempts:0,correct:0};
  }

  function acceptCloudProgress(input) {
    refreshDailyCounters();
    if(!store.check()){renderStorageStatus();return false;}
    const signature=()=>JSON.stringify([state.groupId,state.mode,state.sessionKind,state.queue.map(keyFor),state.index,state.answered,state.answers,state.result]);
    const before=signature(),next=persistence.normalize(input,defaultProgress,groups);
    if(!store.save(next)){renderStorageStatus();return false;}
    progress=store.progress;store.fresh=false;
    const last=progress.lastSession,initial=last&&progress.sessions[plan.sessionKey(last.groupId,last.kind,last.mode)]?last:{groupId:progress.selectedGroup,...persistence.initialSession(progress,progress.selectedGroup)};
    state.groupId=initial.groupId;state.mode=initial.mode;state.sessionKind=initial.kind;
    let cached=progress.sessions[sessionKey()];
    if(state.sessionKind==='wrong')cached={...cached,...review.prepare(progress,allItems,cached)};
    state.queue=cached?cached.queue.filter(k=>itemByKey.has(k)).map(k=>({...itemByKey.get(k)})):buildQueue(state.mode,state.sessionKind);
    state.lastQueue=[...state.queue];state.index=cached?.index||0;state.answered=!!cached?.answered;
    state.answers=[...(cached?.answers||[])];state.result=cached?.result?structuredClone(cached.result):null;state.repeat=!!cached?.repeat;
    state.runId=cached?.runId||newId();state.runStartedAt=cached?.runStartedAt||Date.now();
    if(state.sessionKind==='group'&&persistence.stageDone(progress,state.groupId,state.mode)&&!state.repeat){state.index=state.queue.length;state.answered=false;state.answers=[];state.result=null;}
    setModeTab(state.mode);
    if(before!==signature())renderAll();else{renderGroups();renderHeader();renderStats();renderStorageStatus();}
    return true;
  }

  if(window.VocabSync&&typeof window.fetch==='function'&&!store.problem){
    cloud=window.VocabSync.create({read:()=>progress,accept:acceptCloudProgress,status:(s,message)=>{
      cloudStatus=s;cloudMessage=message||'';renderStorageStatus();renderStats();
      if(!state.queue.length&&['signin','offline','account','local'].includes(s)){
        els.emptyTitle.textContent=s==='signin'?'请登录后同步进度':s==='account'?'请切回原账号':'本机记录已保留';
        els.emptyText.textContent=cloudMessage||'恢复连接后会自动重试；也可以继续本机新词学习。';
      }
    },clientId,legacyImport,config:{groups,plan,review}});
  }

  function currentGroup() {
    return groups.find((group) => group.id === state.groupId) || groups[0];
  }

  function keyFor(item) { return plan.wordKey(item, item.groupId); }
  function recordFor(item) {
    const key = keyFor(item);
    return { attempts: 0, correct: 0, streak: 0, flagged: false, dueAt: 0, lastSeen: 0, ...progress.records[key] };
  }

  function withGroupId(group) {
    return group.words.map((word) => ({ ...word, groupId: group.id }));
  }

  function shuffle(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function blockRange(groupId) {
    const start = Math.floor((groupId - 1) / 5) * 5 + 1;
    return { start, end: Math.min(start + 4, groups.length) };
  }

  function wrongItems() {
    return review.schedule(progress,allItems).keys.map(key=>itemByKey.get(key));
  }

  function updateWrongButton(button, item) {
    const added = recordFor(item).flagged;
    button.textContent = store.problem?.kind === "write" && added ? "待保存" : added ? "✓ 已在错题" : "＋ 加入错题";
    button.disabled = !!added || !!store.problem;
  }

  function renderManualControls() {
    const item = currentItem();
    els.manualWordActions.classList.toggle("hidden", !item || state.mode === "dictation");
    if (item) updateWrongButton(els.addWrongButton, item);
    for (const button of els.batchInputs.querySelectorAll("button")) {
      const word = itemByKey.get(button.dataset.wordKey);
      if (word) updateWrongButton(button, word);
    }
  }

  function addToWrong(item) {
    if (!canAct() || !item) return;
    const key = keyFor(item), previous = recordFor(item);
    if (previous.flagged) { renderManualControls(); return; }
    const now = Date.now();
    progress.records[key] = { ...previous, flagged: true, manualPending: true, manualAddedAt: now, dueAt: Math.min(previous.dueAt || now, now) };
    cloudLib?.write(progress,key,clientId,'manual',{record:progress.records[key],now});
    review.reopen(progress,key,allItems,now);
    const allowed = new Set(review.schedule(progress,allItems,now,key).keys);
    // Preserve unfinished review answers, while making a newly selected word
    // available even when an older review queue has already been completed.
    rememberSession();
    let extendedCurrentReview = false;
    for (const [savedKey, cached] of Object.entries(progress.sessions)) {
      if (cached.kind !== "wrong" || cached.mode !== "review") continue;
      if (!allowed.has(key)) continue;
      const pendingCorrection = cached.answered && cached.result?.results[0]?.correct === false && cached.result.correction?.done !== true;
      const pendingIndex = cached.index + (cached.answered && !pendingCorrection ? 1 : 0);
      if (cached.queue.slice(pendingIndex).includes(key)) continue;
      cached.queue.push(key);
      if (state.sessionKind === "wrong" && state.mode === "review" && savedKey === sessionKey()) {
        state.queue.push({ ...item }); state.lastQueue = [...state.queue]; extendedCurrentReview = true;
      }
    }
    saveProgress();
    renderStats();
    if (extendedCurrentReview) renderPractice();
  }

  function buildQueue(mode, kind = "group") {
    if (!groups.length) return [];
    if (kind === "wrong") return wrongItems();
    if (kind === "block") {
      const range = blockRange(state.groupId);
      return shuffle(groups.filter((group) => group.id >= range.start && group.id <= range.end).flatMap(withGroupId));
    }
    const items = withGroupId(currentGroup());
    return mode === "study" ? items : shuffle(items);
  }

  function setModeTab(mode) {
    document.querySelectorAll(".mode-tab").forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    const stage = mode === "study" ? 0 : mode === "recall" ? 1 : mode === "dictation" ? 2 : 3;
    document.querySelectorAll(".method-step").forEach((step, index) => step.classList.toggle("active", index === stage));
  }

  function startSession(mode, kind = "group", options = {}) {
    if (!canAct()) return;
    if(kind==='wrong'&&cloud&&!cloud.canReviewDay(dayKey())){renderStorageStatus();cloud.retry();return;}
    const { restart = false, preserveCurrent = true, fromGesture = false } = options;
    if (preserveCurrent) rememberSession();
    stopPlayback();
    state.mode = mode;
    state.sessionKind = kind;
    const key = sessionKey(mode, kind);
    if (restart && kind !== "wrong") delete progress.sessions[key];
    let cached = (!restart || kind === "wrong") && canResume(mode, kind) ? progress.sessions[key] : null;
    if (kind === "wrong") cached = {...cached,groupId:state.groupId,kind,mode,...review.prepare(progress,allItems,cached,Date.now(),restart)};
    const identity=cached&&!restart?cloudLib?.identity(cached,key,progress.savedAt):null;
    state.runId=identity?.runId||newId();
    state.runStartedAt=identity?.runStartedAt||Date.now();
    state.queue = cached ? cached.queue.filter(itemKey => itemByKey.has(itemKey)).map(itemKey => ({ ...itemByKey.get(itemKey) })) : buildQueue(mode, kind);
    state.lastQueue = [...state.queue];
    state.index = cached ? Math.min(cached.index, state.queue.length) : 0;
    state.answered = cached?.answered || false;
    state.answers = cached ? [...cached.answers] : [];
    state.result = cached?.result ? structuredClone(cached.result) : null;
    state.repeat = restart || cached?.repeat || false;
    if (kind === "group" && persistence.stageDone(progress, state.groupId, mode) &&
        (!state.repeat || (state.answered && state.index + (state.result?.results.length || 0) >= state.queue.length))) {
      state.index = state.queue.length;
      state.answered = false;
      state.answers = [];
      state.result = null;
      state.repeat = false;
    }
    setModeTab(mode === "review" ? "review" : mode);
    els.practiceCard.classList.remove("hidden");
    els.emptyCard.classList.add("hidden");
    renderAll({ fromGesture });
    if (currentItem()) saveProgress();
    if (mode !== "study") window.setTimeout(focusCurrentAnswer, 0);
  }

  function setSidebarOpen(open) {
    els.sidebar.classList.toggle("open", open);
    els.sidebarBackdrop?.classList.toggle("hidden", !open);
  }

  function selectGroup(groupId) {
    if (!canAct()) return;
    rememberSession();
    state.groupId = groupId;
    progress.selectedGroup = groupId;
    const initial = persistence.initialSession(progress, groupId);
    startSession(initial.mode, initial.kind, { preserveCurrent: false, fromGesture: true });
    setSidebarOpen(false);
  }

  function currentItem() { return state.queue[state.index]; }

  function currentBatch() {
    return state.mode === "dictation" ? state.queue.slice(state.index, state.index + 5) : [currentItem()].filter(Boolean);
  }

  function focusCurrentAnswer() {
    if (state.mode === "dictation") els.batchInputs.querySelector("input")?.focus();
    else els.answerInput.focus();
  }

  function refreshVoices() {
    if ("speechSynthesis" in window) availableVoices = speechSynthesis.getVoices();
  }

  function preferredVoice(lang) {
    refreshVoices();
    const candidates = availableVoices.filter((voice) => {
      const vLang = String(voice.lang || "").replace("_", "-").toLowerCase();
      return vLang === lang.toLowerCase() || vLang.startsWith("en");
    });
    const priorities = lang === "en-US"
      ? [/Google US English/i, /Microsoft (Aria|Jenny|Guy|Ana)/i, /Samantha/i, /Ava/i, /Allison/i, /Alex/i]
      : [/Google UK English/i, /Microsoft (Sonia|Ryan|Libby)/i, /Daniel/i, /Serena/i, /Kate/i];
    const novelty = /Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley/i;
    return candidates.sort((a, b) => {
      const score = (voice) => {
        const vLang = String(voice.lang || "").replace("_", "-").toLowerCase();
        const priority = priorities.findIndex((pattern) => pattern.test(voice.name));
        return (vLang === lang.toLowerCase() ? 100 : 0) + (priority >= 0 ? 80 - priority * 8 : 0) + (voice.localService ? 8 : 0) - (novelty.test(voice.name) ? 200 : 0);
      };
      return score(b) - score(a);
    })[0];
  }

  function stopPlayback() {
    speakToken += 1;
    if (autoplayTimer) window.clearTimeout(autoplayTimer);
    autoplayTimer = null;
    if (speakChainTimer) window.clearTimeout(speakChainTimer);
    speakChainTimer = null;
    if (speakWatchdogTimer) window.clearTimeout(speakWatchdogTimer);
    speakWatchdogTimer = null;
    if ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending)) {
      try { speechSynthesis.cancel(); } catch {}
    }
    activeUtterances = [];
  }

  function scheduleAutoplay(callback, fromGesture = false) {
    if (fromGesture) {
      // Keep iOS Safari user-gesture activation stack intact
      callback();
      return;
    }
    if (autoplayTimer) window.clearTimeout(autoplayTimer);
    autoplayTimer = window.setTimeout(() => {
      autoplayTimer = null;
      callback();
    }, 220);
  }

  function speakWords(words, { userInitiated = false } = {}) {
    if (!words?.length) return;
    if (!("speechSynthesis" in window)) {
      if (userInitiated) {
        els.progressNotice.textContent = "当前浏览器不支持系统语音合成，请换用 Safari 或 Chrome 打开。";
        els.progressNotice.classList.remove("hidden");
      }
      return;
    }
    stopPlayback();
    const myToken = speakToken;
    const voice = preferredVoice(progress.voiceLang);

    // Chain utterances one by one with a short natural pause & watchdog to avoid
    // iOS Safari / Android Chrome stalling mid-batch when 5 utterances are queued at once.
    const speakAt = (idx) => {
      if (myToken !== speakToken || idx >= words.length) return;
      const word = words[idx];
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = progress.voiceLang;
      utterance.rate = progress.voiceLang === "en-US" ? 0.82 : 0.87;
      utterance.pitch = 1;
      utterance.volume = 1;
      if (voice) utterance.voice = voice;

      let settled = false;
      const advance = () => {
        if (settled || myToken !== speakToken) return;
        settled = true;
        if (speakWatchdogTimer) {
          window.clearTimeout(speakWatchdogTimer);
          speakWatchdogTimer = null;
        }
        if (idx + 1 < words.length) {
          speakChainTimer = window.setTimeout(() => {
            speakChainTimer = null;
            speakAt(idx + 1);
          }, 420);
        }
      };

      utterance.onend = advance;
      utterance.onerror = (ev) => {
        if (settled || myToken !== speakToken) return;
        const errCode = ev?.error || "";
        if (errCode === "not-allowed") {
          settled = true;
          if (speakWatchdogTimer) {
            window.clearTimeout(speakWatchdogTimer);
            speakWatchdogTimer = null;
          }
          if (!userInitiated && !store.problem) {
            els.progressNotice.textContent = "手机浏览器限制了自动朗读，点一下「播放发音」即可开始。";
            els.progressNotice.classList.remove("hidden");
          }
          return;
        }
        if (errCode === "canceled" || errCode === "interrupted") {
          settled = true;
          return;
        }
        advance();
      };

      activeUtterances.push(utterance);
      try {
        if (speechSynthesis.paused) speechSynthesis.resume();
        speechSynthesis.speak(utterance);
      } catch {
        advance();
        return;
      }

      const maxWait = Math.max(4500, word.length * 450);
      speakWatchdogTimer = window.setTimeout(() => {
        speakWatchdogTimer = null;
        if (!settled && myToken === speakToken && idx + 1 < words.length) {
          try { speechSynthesis.cancel(); } catch {}
          advance();
        }
      }, maxWait);
    };

    speakAt(0);
  }

  function speak(word = currentItem()?.word, opts) { speakWords(word ? [word] : [], opts); }
  function speakBatch(opts) { speakWords(currentBatch().map((item) => item.word), opts); }

  function iconSpeaker() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5Zm12.5 1.2a3 3 0 0 1 0 3.6M19.8 8a6 6 0 0 1 0 8" /></svg>`;
  }

  function sessionCopy() {
    if (state.sessionKind === "wrong") return { label: "每日复习 · 老词答对才减 1", kicker: "老词答错当天队尾再测；看答案订正不抵扣，今日新词错题另算" };
    if (state.sessionKind === "block") return { label: "五组综合复测 · 5 词连播", kicker: "每轮连续听 5 个词，再按顺序填写" };
    if (state.mode === "study") return { label: "快速建立第一印象", kicker: "先看英文、中文和词性，只看一遍" };
    if (state.mode === "recall") return { label: "主动提取 · 中文 → 英文", kicker: "遮住答案，强迫自己想 3–5 秒" };
    return { label: "听写 · 5 词连续捕捉", kicker: "连续听 5 个词，再按顺序写下来" };
  }

  function renderBatchInputs(batch) {
    els.batchInputs.innerHTML = "";
    batch.forEach((item, index) => {
      const wrap = document.createElement("div");
      wrap.className = "batch-input-wrap";
      const label = document.createElement("label");
      label.htmlFor = `batchAnswer${index}`;
      label.textContent = `第 ${index + 1} 个`;
      const input = document.createElement("input");
      input.id = `batchAnswer${index}`;
      input.type = "text";
      input.autocomplete = "off";
      input.autocapitalize = "none";
      input.spellcheck = false;
      input.dataset.index = String(index);
      input.setAttribute("aria-label", `第 ${index + 1} 个单词`);
      wrap.append(label, input);
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "secondary-button manual-wrong-button batch-wrong-button";
      addButton.dataset.wordKey = keyFor(item);
      addButton.setAttribute("aria-label", `第 ${index + 1} 个单词加入错题`);
      updateWrongButton(addButton, item);
      addButton.addEventListener("click", () => addToWrong(item));
      wrap.appendChild(addButton);
      els.batchInputs.appendChild(wrap);
    });
    els.batchCheckButton.textContent = `检查这 ${batch.length} 个`;
  }

  function renderPractice({ fromGesture = false } = {}) {
    stopPlayback();
    const item = currentItem();
    if (!item) {
      showCompletion();
      return;
    }
    els.practiceCard.classList.remove("hidden");
    els.emptyCard.classList.add("hidden");
    const copy = sessionCopy();
    els.sessionLabel.textContent = copy.label;
    els.promptKicker.textContent = copy.kicker;
    const batch = currentBatch();
    const shownIndex = state.mode === "dictation" ? Math.floor(state.index / 5) + 1 : state.index + 1;
    const shownTotal = state.mode === "dictation" ? Math.ceil(state.queue.length / 5) : state.queue.length;
    const completedThrough = state.mode === "dictation" ? Math.min(state.index + batch.length, state.queue.length) : state.index + 1;
    els.cardProgressText.textContent = state.mode === "dictation" ? `第 ${shownIndex} / ${shownTotal} 轮` : `${shownIndex} / ${shownTotal}`;
    els.progressFill.style.width = `${(completedThrough / state.queue.length) * 100}%`;
    els.feedback.className = "feedback hidden";
    els.feedback.textContent = "";
    els.answerInput.value = state.answers[0] || "";
    els.answerInput.disabled = state.answered;
    els.checkButton.disabled = false;
    els.checkButton.textContent = "检查";
    els.nextButton.disabled = false;
    els.answerForm.classList.add("hidden");
    els.batchAnswerForm.classList.add("hidden");
    els.speakButton.innerHTML = `${iconSpeaker()}播放发音`;

    if (state.mode === "study") {
      els.mainPrompt.className = "main-prompt";
      els.mainPrompt.textContent = item.word;
      els.promptDetail.textContent = `${item.meaning} · ${item.pos}`;
      els.cardActions.classList.remove("hidden");
      els.unsureButton.classList.remove("hidden");
      els.unsureButton.textContent = "不熟，留下";
      els.nextButton.textContent = "下一个";
      els.speakButton.classList.remove("hidden");
    } else if (state.mode === "recall") {
      els.mainPrompt.className = "main-prompt chinese";
      els.mainPrompt.textContent = item.meaning;
      els.promptDetail.textContent = item.pos;
      els.answerForm.classList.remove("hidden");
      els.cardActions.classList.add("hidden");
      els.speakButton.classList.add("hidden");
    } else if (state.mode === "dictation") {
      els.mainPrompt.className = "main-prompt audio-only";
      els.mainPrompt.innerHTML = iconSpeaker();
      els.promptDetail.textContent = `本轮连续播放 ${batch.length} 个词`;
      renderBatchInputs(batch);
      [...els.batchInputs.querySelectorAll("input")].forEach((input, index) => { input.value = state.answers[index] || ""; });
      els.batchAnswerForm.classList.remove("hidden");
      els.cardActions.classList.add("hidden");
      els.speakButton.classList.remove("hidden");
      els.speakButton.innerHTML = `${iconSpeaker()}重播这 ${batch.length} 个词`;
      if (progress.autoPlay && !state.answered) scheduleAutoplay(() => speakBatch({ userInitiated: fromGesture }), fromGesture);
    } else {
      els.mainPrompt.className = "main-prompt audio-only";
      els.mainPrompt.innerHTML = iconSpeaker();
      els.promptDetail.textContent = `${item.pos} · 第 ${item.groupId} 组`;
      els.answerForm.classList.remove("hidden");
      els.cardActions.classList.add("hidden");
      els.speakButton.classList.remove("hidden");
      els.speakButton.innerHTML = `${iconSpeaker()}播放发音`;
      if (progress.autoPlay && !state.answered) scheduleAutoplay(() => speak(item.word, { userInitiated: fromGesture }), fromGesture);
    }
    if (state.answered) renderAnswerResult();
    renderManualControls();
  }

  function renderGroups() {
    els.groupList.innerHTML = "";
    groups.forEach((group) => {
      const button = document.createElement("button");
      button.className = `group-button${group.id === state.groupId ? " active" : ""}`;
      const learned = persistence.stageDone(progress, group.id, "dictation");
      const started = ["study", "recall"].some(mode => persistence.stageDone(progress, group.id, mode));
      button.innerHTML = `<span class="group-number">${String(group.id).padStart(2, "0")}</span><span class="group-copy"><strong>Day ${group.id}</strong><small>${group.words.length} 个词${learned ? " · 已完成" : started ? " · 训练中" : ""}</small></span><span class="group-progress${learned ? " done" : ""}"></span>`;
      button.addEventListener("click", () => selectGroup(group.id));
      els.groupList.appendChild(button);
    });
  }

  function renderHeader() {
    const group = currentGroup();
    const range = blockRange(state.groupId);
    els.pageTitle.textContent = state.sessionKind === "block" ? `第 ${range.start}–${range.end} 组综合复测` : state.sessionKind === "wrong" ? "错词与到期词复习" : `Day ${state.groupId} · 词汇训练`;
    els.groupEyebrow.textContent = state.groupId === 6 && progress.completedGroups.length === 5 ? "新方法 · 从这里开始" : `${group?.words.length || 0} 个词${state.groupId > plan.KEEP ? " · 轻量计划" : ""}`;
    els.blockLabel.textContent = `第 ${range.start}–${range.end} 组`;
    els.planMinutes.textContent = `约 ${Math.max(5, Math.round((group?.words.length || 30) / 5))} 分钟`;
  }

  function renderStats() {
    const today = progress.today;
    const load = review.schedule(progress,allItems),wrong = load.keys;
    els.todayAttempts.textContent = today.attempts;
    els.todayAccuracy.textContent = today.attempts ? `${Math.round((today.correct / today.attempts) * 100)}%` : "—";
    els.dueCount.textContent = load.oldPending;
    els.wrongCount.textContent = wrong.length;
    els.wrongBadge.textContent = wrong.length;
    els.startWrongReview.disabled = wrong.length === 0;
    if(cloud&&!cloud.canReviewDay(dayKey()))els.startWrongReview.disabled=true;
    els.reviewLoad.textContent = `往期已答对 ${load.oldDone} / ${load.oldSelected} · 往期待做 ${load.oldPending} · 今日新词错题 ${load.newPending}（另计）${load.deferred ? ` · 其余 ${load.deferred} 个往期词顺延` : ""}`;
    els.studyState.textContent = persistence.stageDone(progress, state.groupId, "study") ? "已完成" : "开始";
    els.recallState.textContent = persistence.stageDone(progress, state.groupId, "recall") ? "已完成" : "开始";
    els.dictationState.textContent = persistence.stageDone(progress, state.groupId, "dictation") ? "已完成" : "开始";
    renderManualControls();
  }

  function renderAll(options = {}) {
    renderGroups();
    renderHeader();
    renderStats();
    els.autoPlay.checked = progress.autoPlay;
    document.querySelectorAll(".voice-option").forEach((button) => button.classList.toggle("active", button.dataset.lang === progress.voiceLang));
    renderPractice(options);
  }

  function markRecord(item, correct, flagged = false) {
    const key = keyFor(item);
    const previous = recordFor(item);
    const next = { ...previous };
    if (!previous.attempts && !previous.firstLearnedAt && state.sessionKind === "group") next.firstLearnedAt = Date.now();
    next.attempts += 1;
    next.lastSeen = Date.now();
    if (correct && !flagged) {
      next.correct += 1;
      next.streak += 1;
      const keepManual = previous.manualPending === true && state.mode !== "review";
      next.flagged = keepManual;
      if (previous.manualPending) next.manualPending = keepManual;
      const days = intervals[Math.min(next.streak - 1, intervals.length - 1)];
      next.dueAt = keepManual ? Math.min(previous.dueAt || Date.now(), Date.now()) : Date.now() + days * 24 * 60 * 60 * 1000;
    } else {
      next.streak = 0;
      next.flagged = true;
      next.dueAt = tomorrow();
    }
    progress.records[key] = next;
    cloudLib?.write(progress,key,clientId,'attempt',{record:next,correct:correct&&!flagged,mode:state.mode,countToday:state.mode!=='study',day:dayKey(),now:Date.now()});
  }

  function normalizeAnswer(value) {
    return value.trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");
  }

  function needsCorrection() {
    return state.mode === "review" && state.answered && state.result?.results[0]?.correct === false && state.result.correction?.done !== true;
  }

  function submitAnswer(value) {
    if (!canAct()) return null;
    if (needsCorrection()) {
      const item = currentItem();
      if (!item || !normalizeAnswer(value)) { els.answerInput.focus(); return { accepted: false, reason: "empty" }; }
      const correct = normalizeAnswer(value) === normalizeAnswer(item.word);
      state.result.correction = { draft: value, done: correct };
      // Copying a visible answer is correction, not a new successful recall.
      saveProgress(); renderAnswerResult();
      return { accepted: true, correct, correction: true, expected: item.word, meaning: item.meaning };
    }
    if (state.mode === "study" || state.mode === "dictation" || state.answered || !currentItem()) return null;
    const item = currentItem();
    if (state.mode === "review" && !review.schedule(progress,allItems).keys.includes(keyFor(item))) {
      startSession("review","wrong");
      return {accepted:false,reason:"daily-limit"};
    }
    if(state.mode==='review'&&cloud&&!cloud.canReviewDay(dayKey())){cloud.retry();renderStorageStatus();return {accepted:false,reason:'sync-required'};}
    const answer = normalizeAnswer(value);
    if (!answer) {
      els.answerInput.focus();
      return { accepted: false, reason: "empty" };
    }
    const correct = answer === normalizeAnswer(item.word);
    state.answered = true;
    state.answers = [value];
    state.result = { type: "single", results: [{ key: keyFor(item), answer, correct }], ...(state.mode === "review" && !correct ? { correction: { draft: "", done: false } } : {}) };
    progress.today.attempts += 1;
    if (correct) progress.today.correct += 1;
    markRecord(item, correct, !correct);
    if (state.mode === "review") {
      review.markReviewed(progress,item,allItems,Date.now(),correct);
      appendOldRetry(item);
    }
    if (state.index === state.queue.length - 1) markSessionComplete();
    saveProgress();
    renderAnswerResult(); renderGroups(); renderStats();
    return { accepted: true, correct, expected: item.word, meaning: item.meaning };
  }

  function submitBatchAnswers(values) {
    if (!canAct()) return null;
    if (state.mode !== "dictation" || state.answered) return null;
    const batch = currentBatch();
    if (!batch.length) return null;
    const answers = batch.map((_, index) => normalizeAnswer(values[index] || ""));
    if (!answers.some(Boolean)) {
      focusCurrentAnswer();
      return { accepted: false, reason: "empty" };
    }

    const results = batch.map((item, index) => ({
      item,
      answer: answers[index],
      correct: answers[index] === normalizeAnswer(item.word)
    }));

    state.answered = true;
    state.answers = batch.map((_, index) => values[index] || "");
    state.result = { type: "batch", results: results.map(result => ({ key: keyFor(result.item), answer: result.answer, correct: result.correct })) };
    progress.today.attempts += results.length;
    progress.today.correct += results.filter((result) => result.correct).length;
    results.forEach((result) => markRecord(result.item, result.correct, !result.correct));
    if (state.index + batch.length >= state.queue.length) markSessionComplete();
    saveProgress();
    const correctCount = results.filter((result) => result.correct).length;
    renderAnswerResult(); renderGroups(); renderStats();

    return {
      accepted: true,
      correctCount,
      itemCount: results.length,
      results: results.map((result) => ({ answer: result.answer, expected: result.item.word, correct: result.correct }))
    };
  }

  function renderAnswerResult() {
    const results = state.result?.results.map(result => ({ ...result, item: itemByKey.get(result.key) })) || [];
    if (!results.length) return;
    els.feedback.className = `feedback ${results.every(result => result.correct) ? "correct" : "incorrect"}`;
    els.cardActions.classList.remove("hidden");
    els.nextButton.disabled = needsCorrection();
    if (state.result.type === "single") {
      const { item, correct } = results[0];
      const pending = needsCorrection();
      els.answerInput.disabled = !pending;
      els.checkButton.disabled = !pending;
      els.checkButton.textContent = pending ? "检查订正" : "检查";
      if (state.mode === "review" && !correct) els.answerInput.value = state.result.correction?.draft || "";
      const oldRetry=state.mode==='review'&&!review.isNew(recordFor(item),dayKey())&&review.schedule(progress,allItems).keys.includes(keyFor(item));
      els.feedback.innerHTML = state.result.guessed ? `<strong>已留下：</strong>${item.word} · ${oldRetry?'今天队尾会再测，不抵扣剩余数量。':'明天会优先复习。'}`
        : correct ? `<strong>正确。</strong> ${item.word} · ${item.meaning}`
        : `<strong>正确答案：${item.word}</strong> · ${item.meaning}。这个词已进入错词复习。`;
      if (pending) els.feedback.innerHTML += `<br>请看着上面的答案，重新输入并答对一次，才能继续。`;
      else if (state.mode === "review" && !correct && state.result.correction?.done) els.feedback.innerHTML += `<br><strong>已订正，可以继续。</strong> ${oldRetry?'今天队尾会隐藏答案再测；独立答对才减 1。':'原来的错误仍保留，之后会再复习。'}`;
      els.unsureButton.textContent = "我其实是蒙的";
      els.unsureButton.classList.toggle("hidden", !correct || state.result.guessed);
      els.nextButton.textContent = state.index === state.queue.length - 1 ? "完成本轮" : "下一个";
      if (state.mode === "recall") els.speakButton.classList.remove("hidden");
      if (pending) els.answerInput.focus();
      return;
    }
    [...els.batchInputs.querySelectorAll("input")].forEach((input, index) => {
      input.disabled = true;
      input.classList.add(results[index].correct ? "correct" : "incorrect");
    });
    const list = document.createElement("div");
    list.className = "batch-result-list";
    results.forEach((result, index) => {
      const row = document.createElement("div");
      row.className = `batch-result-row ${result.correct ? "correct" : "incorrect"}`;
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      const comparison = document.createElement("strong");
      comparison.textContent = result.correct ? result.item.word : `${result.answer || "（未写）"} → ${result.item.word}`;
      const status = document.createElement("em");
      status.textContent = result.correct ? "正确" : "已进错词";
      row.append(number, comparison, status);
      list.appendChild(row);
    });
    els.feedback.replaceChildren(list);
    els.unsureButton.classList.add("hidden");
    els.nextButton.textContent = state.index + results.length >= state.queue.length ? "完成本轮" : "下一组 5 词";
  }

  function appendOldRetry(item) {
    if(state.mode!=='review'||review.isNew(recordFor(item),dayKey()))return;
    const key=keyFor(item);
    if(review.schedule(progress,allItems).keys.includes(key)&&!state.queue.slice(state.index+1).some(w=>keyFor(w)===key)){
      state.queue.push({...item});state.lastQueue=[...state.queue];
    }
  }

  function nextItem() {
    if (!canAct() || !currentItem()) return;
    if (needsCorrection()) { els.answerInput.focus(); return; }
    if(state.answered)appendOldRetry(currentItem());
    if (state.mode === "study") {
      state.index += 1;
    } else if (state.mode === "dictation" && state.answered) {
      state.index += currentBatch().length;
    } else if (state.answered) {
      state.index += 1;
    } else {
      return;
    }
    state.answered = false; state.answers = []; state.result = null;
    if (state.index >= state.queue.length) showCompletion();
    else {
      renderPractice({ fromGesture: true });
      saveProgress();
      if (state.mode !== "study") window.setTimeout(focusCurrentAnswer, 0);
    }
  }

  function flagCurrentAndAdvance() {
    if (!canAct()) return;
    const item = currentItem();
    if (!item) return;
    if (state.mode !== "study" && state.answered) {
      if (state.result?.guessed) return;
      progress.records[keyFor(item)] = { ...recordFor(item), flagged: true, streak: 0, dueAt: tomorrow() };
      cloudLib?.write(progress,keyFor(item),clientId,'guessed',{record:progress.records[keyFor(item)],now:Date.now()});
      if (state.mode==='review'||review.isNew(recordFor(item),dayKey())) review.reopen(progress,keyFor(item),allItems);
      state.result.guessed = true;
      appendOldRetry(item);
      renderAnswerResult();
      saveProgress(); renderStats();
    } else {
      markRecord(item, false, true);
      nextItem();
      renderStats();
    }
  }

  function showCompletion() {
    els.emptyIcon.textContent='✓';els.restartButton.textContent='再练一轮';
    els.practiceCard.classList.add("hidden");
    els.emptyCard.classList.remove("hidden");
    if (state.sessionKind === "group") {
      markSessionComplete();
      els.emptyTitle.textContent = `第 ${state.groupId} 组这一轮完成`;
      els.emptyText.textContent = state.mode === "study" ? "第一印象已经建立。下一步直接去“主动回忆”，不要重新从头看。" : "会的词先放走；错词和犹豫词已经自动留下，之后按间隔再测。";
    } else if (state.sessionKind === "wrong") {
      els.emptyTitle.textContent = "今天的错词复习完成";
      const load=review.schedule(progress,allItems);
      els.emptyText.textContent = `本轮已完成。每天最多选择 100 个不同老词，老词独立答对才减 1；答错先订正，再在当天队尾隐藏答案重测，重试次数不限。今日新词错题另算。${load.deferred ? `另有 ${load.deferred} 个往期词顺延，不会追加到今天。` : ""}${load.keys.length ? "仍有待做词，可点“开始错词复习”继续。" : ""}`;
    } else {
      els.emptyTitle.textContent = "五组综合复测完成";
      els.emptyText.textContent = "这次没有提前看答案。留下的错词，就是下一次真正需要练的内容。";
    }
    saveProgress();
    renderGroups();
    renderStats();
  }

  function markSessionComplete() {
    if (state.sessionKind !== "group" || !state.queue.length) return;
    progress.completed[plan.stageKey(state.groupId, state.mode)] = true;
    if (state.mode === "dictation") {
      const completed = state.groupId > plan.KEEP ? (progress.dailyCompletedGroups ||= []) : progress.completedGroups;
      if (!completed.includes(state.groupId)) completed.push(state.groupId);
    }
  }

  function registerWebMCP() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const fail = (message) => { throw new Error(message); };
    try {
      context.registerTool({
        name: "start_vocab_session",
        title: "开始词汇训练",
        description: "选择词组和训练模式，并在页面中开始该训练。",
        inputSchema: {
          type: "object",
          properties: {
            groupId: { type: "integer", minimum: 1, maximum: groups.length },
            mode: { type: "string", enum: ["study", "recall", "dictation", "review"] }
          },
          required: ["groupId", "mode"], additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!canAct()) fail(store.problem.message);
          if (!Number.isInteger(input?.groupId) || input.groupId < 1 || input.groupId > groups.length) fail("无效词组");
          if (!["study", "recall", "dictation", "review"].includes(input?.mode)) fail("无效模式");
          rememberSession();
          state.groupId = input.groupId;
          progress.selectedGroup = input.groupId;
          startSession(input.mode, input.mode === "review" ? "wrong" : "group", { preserveCurrent: false });
          return { groupId: state.groupId, mode: state.mode, itemCount: state.queue.length };
        }
      });
      context.registerTool({
        name: "submit_vocab_answer",
        title: "提交词汇答案",
        description: "提交当前答案并更新同一训练进度。主动回忆和错词复习使用 answer；五词听写使用按顺序排列的 answers。",
        inputSchema: {
          type: "object",
          properties: {
            answer: { type: "string", minLength: 1 },
            answers: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }
          },
          anyOf: [{ required: ["answer"] }, { required: ["answers"] }],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          const result = state.mode === "dictation"
            ? submitBatchAnswers(Array.isArray(input?.answers) ? input.answers : [])
            : submitAnswer(typeof input?.answer === "string" ? input.answer : "");
          if (!result?.accepted) fail("当前题目不能提交答案");
          return result;
        }
      });
      context.registerTool({
        name: "read_vocab_progress",
        title: "读取训练进度",
        description: "读取当前词组、今日正确率和待复习词数量，不修改数据。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute() {
          const load=review.schedule(structuredClone(progress),allItems);
          return { groupId: state.groupId, mode: state.mode, todayAttempts: progress.today.attempts, todayCorrect: progress.today.correct, reviewCount: load.keys.length, reviewLoad:load,
            completedGroups: plan.completedIds(progress), completed: { ...progress.completed }, saved: !store.problem, saveProblem: store.problem?.message || null };
        }
      });
    } catch (error) {
      console.warn("WebMCP registration unavailable", error);
    }
  }

  document.querySelectorAll(".mode-tab").forEach((tab) => tab.addEventListener("click", () => {
    const mode = tab.dataset.mode;
    startSession(mode, mode === "review" ? "wrong" : "group", { fromGesture: true });
  }));
  document.querySelectorAll(".plan-item").forEach((item) => item.addEventListener("click", () => startSession(item.dataset.startMode, "group", { fromGesture: true })));
  document.querySelectorAll(".voice-option").forEach((button) => button.addEventListener("click", () => {
    if (!canAct()) return;
    progress.voiceLang = button.dataset.lang;
    progress.preferencesAt=Date.now();
    saveProgress();
    renderAll();
    if (state.mode === "dictation") speakBatch({ userInitiated: true });
    else speak(currentItem()?.word, { userInitiated: true });
  }));
  els.speakButton.addEventListener("click", () => state.mode === "dictation" ? speakBatch({ userInitiated: true }) : speak(currentItem()?.word, { userInitiated: true }));
  els.mainPrompt.addEventListener("click", () => {
    if (state.mode === "dictation") speakBatch({ userInitiated: true });
    else if (state.mode !== "study" && state.mode !== "recall") speak(currentItem()?.word, { userInitiated: true });
  });
  els.answerForm.addEventListener("submit", (event) => { event.preventDefault(); submitAnswer(els.answerInput.value); });
  els.batchAnswerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitBatchAnswers([...els.batchInputs.querySelectorAll("input")].map((input) => input.value));
  });
  function scheduleDraftSave() {
    if (draftSaveTimer) window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(() => {
      draftSaveTimer = null;
      if (!store.problem) saveProgress();
    }, 250);
  }
  els.answerInput.addEventListener("input", () => {
    if (!canAct() || (state.answered && !needsCorrection())) return;
    if (needsCorrection()) {
      state.result.correction = { draft: els.answerInput.value, done: false };
      scheduleDraftSave();
      return;
    }
    state.answers = [els.answerInput.value];
    scheduleDraftSave();
  });
  els.batchInputs.addEventListener("input", () => {
    if (!canAct() || state.answered) return;
    state.answers = [...els.batchInputs.querySelectorAll("input")].map(input => input.value);
    scheduleDraftSave();
  });
  els.batchInputs.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const inputs = [...els.batchInputs.querySelectorAll("input")];
    const index = inputs.indexOf(event.target);
    if (index >= 0 && index < inputs.length - 1) {
      event.preventDefault();
      inputs[index + 1].focus();
    }
  });
  els.nextButton.addEventListener("click", nextItem);
  els.addWrongButton.addEventListener("click", () => addToWrong(currentItem()));
  els.unsureButton.addEventListener("click", flagCurrentAndAdvance);
  els.startWrongReview.addEventListener("click", () => startSession("review", "wrong", { fromGesture: true }));
  els.startBlockReview.addEventListener("click", () => startSession("dictation", "block", { fromGesture: true }));
  els.restartButton.addEventListener("click", () => startSession(state.mode, state.sessionKind, { restart: true, fromGesture: true }));
  els.autoPlay.addEventListener("change", () => { if (!canAct()) return; progress.autoPlay = els.autoPlay.checked; progress.preferencesAt=Date.now(); saveProgress(); });
  els.menuButton.addEventListener("click", () => setSidebarOpen(true));
  els.sidebarClose.addEventListener("click", () => setSidebarOpen(false));
  els.sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));
  els.resetProgress.addEventListener("click", () => els.resetDialog.classList.remove("hidden"));
  els.cancelReset.addEventListener("click", () => els.resetDialog.classList.add("hidden"));
  els.confirmReset.addEventListener("click", () => {
    // Only clear this browser's localStorage cache and reload cleanly from disk (data/vocab-progress.json).
    // NEVER overwrite the disk progress file with blank defaults from this button.
    try {
      for (const k of [persistence.KEY, persistence.BACKUP_KEY, persistence.UPGRADE_BACKUP_KEY, persistence.PLAN_BACKUP_KEY, persistence.RESTORE_BACKUP_KEY]) {
        storage?.removeItem(k);
      }
      cloud?.clearDirty?.();
    } catch {}
    els.resetDialog.classList.add("hidden");
    window.location.reload();
  });

  function exportProgress() {
    let savedProgress = progress;
    if (store.problem?.kind === "conflict") {
      try { savedProgress = persistence.normalize(JSON.parse(storage.getItem(persistence.KEY)), defaultProgress, groups); }
      catch {}
    }
    const data = store.problem?.kind === "corrupt" || store.problem?.kind === "unavailable"
      ? { app: "vocab-listening-lab", exportedAt: new Date().toISOString(), rawProgress: store.raw, backup: store.readBackup(), problem: store.problem.message }
      : { app: "vocab-listening-lab", exportedAt: new Date().toISOString(), progress: savedProgress };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `词汇听写台进度-${dayKey()}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function restoreProgress(candidate) {
    try {
      const cleaned = structuredClone(candidate);
      delete cleaned.cloudOwner;
      if (cleaned.reviewDay) cleaned.reviewDay.cloudLocked = false;
      const validated = persistence.normalize(cleaned, defaultProgress, groups);
      if (!window.confirm("导入会更新当前本机进度；导入前当前记录会自动先备份。继续吗？")) return;
      if (!store.importProgress(validated)) { renderStorageStatus(); return; }
      progress = store.progress; store.fresh = false;
      state.groupId = progress.selectedGroup; state.queue = []; state.answers = []; state.result = null; state.answered = false;
      els.restartButton.disabled = false;
      const initial = persistence.initialSession(progress, state.groupId);
      startSession(initial.mode, initial.kind, { preserveCurrent: false });
      renderStorageStatus();
      (cloud?.forcePush || cloud?.changed)?.();
    } catch {
      els.progressNotice.textContent = "备份格式无法读取，当前进度没有被替换。请选择本听写台导出的进度备份。";
      els.progressNotice.classList.remove("hidden");
    }
  }

  els.exportProgress.addEventListener("click", exportProgress);
  els.importProgress.addEventListener("change", async () => {
    const file = els.importProgress.files?.[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw Error("large");
      const data = JSON.parse(await file.text());
      if (data.app !== "vocab-listening-lab" || !data.progress) throw Error("format");
      restoreProgress(data.progress);
    } catch {
      els.progressNotice.textContent = "备份无法读取，当前进度没有被替换。请选择本听写台导出的 JSON 备份。";
      els.progressNotice.classList.remove("hidden");
    }
    els.importProgress.value = "";
  });
  els.restoreBackup.addEventListener("click", () => { const backup = store.readBackup(); if (backup) restoreProgress(backup); });
  els.retrySave.addEventListener("click", () => { if (saveProgress()){renderAll();cloud?.retry();} });
  els.syncNow.addEventListener('click',()=>{if(cloudStatus==='account')window.location.reload();else cloud?.retry();});
  els.reloadProgress.addEventListener("click", () => window.location.reload());
  window.addEventListener("storage", event => { if (event.key === persistence.KEY || event.key === null) { if (!store.check()) stopPlayback(); renderStorageStatus(); } });
  window.addEventListener("pagehide", () => { if (!booting && !store.problem && state.queue.length) saveProgress(); cloud?.flush(); });
  window.addEventListener('online',()=>cloud?.retry());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){ if(!booting && !store.problem && draftSaveTimer) saveProgress(); cloud?.flush(); } else { cloud?.retry(); }});
  els.resetDialog.addEventListener("click", (event) => { if (event.target === els.resetDialog) els.resetDialog.classList.add("hidden"); });
  document.addEventListener("keydown", (event) => {
    // Let each button handle its own Enter activation; do not advance a graded
    // question when the learner is using the manual-add button or another tool.
    if (event.key === "Enter" && event.target?.tagName === "BUTTON" && event.target !== els.nextButton) return;
    // When typing a correction inside answerInput, let the form submit handler run ONCE
    // instead of firing both form submit and this global keydown handler.
    if (event.key === "Enter" && event.target === els.answerInput && needsCorrection()) return;
    if (event.key === "Enter" && state.answered && els.resetDialog.classList.contains("hidden")) {
      event.preventDefault();
      if (!event.repeat && !event.isComposing) {
        if (needsCorrection()) submitAnswer(els.answerInput.value);
        else nextItem();
      }
      return;
    }
    if (event.key === "Escape") { setSidebarOpen(false); els.resetDialog.classList.add("hidden"); }
    if (event.code === "Space" && document.activeElement === document.body && state.mode !== "study") {
      event.preventDefault();
      if (state.mode === "dictation") speakBatch({ userInitiated: true });
      else speak(currentItem()?.word, { userInitiated: true });
    }
  });

  refreshVoices();
  if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", refreshVoices);

  if (!groups.length) {
    els.mainPrompt.textContent = "词表载入失败";
    els.promptDetail.textContent = "请刷新页面后重试。";
    return;
  }

  renderStorageStatus();
  if (store.problem) {
    els.practiceCard.classList.add("hidden"); els.emptyCard.classList.remove("hidden");
    els.emptyTitle.textContent = "历史进度需要恢复"; els.emptyText.textContent = store.problem.message;
    els.restartButton.disabled = true;
  } else if(cloud) {
    renderGroups();renderHeader();renderStats();
    els.practiceCard.classList.add('hidden');els.emptyCard.classList.remove('hidden');
    els.emptyIcon.textContent='…';els.restartButton.textContent='继续本机学习';
    els.emptyTitle.textContent='正在读取本机进度';
    els.emptyText.textContent='正在连接本地持久化服务读取最新进度；若服务未启动，仍可点下方继续使用浏览器缓存练习。';
  } else {
    const initial = persistence.initialSession(progress, state.groupId);
    startSession(initial.mode, initial.kind, { preserveCurrent: false });
  }
  registerWebMCP();
  booting=false;
  cloud?.start();
})();
