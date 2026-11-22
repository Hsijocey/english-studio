import {createProgressSync} from './progress-sync.mjs';
import {mergeProgress} from './listening-progress.mjs';
import {createAudioPlayer} from './audio-player.mjs';
import {stageFor,dueDate,planDailyTask,roundErrors,buildWeakPointLedger,restoreConfirmedProgress} from './listening-schedule.mjs';
import {cueTranslation,questionExplanation} from './listening-help.mjs';
import {buildReviewModel,focusQuestions,selectReviewCues,markedTranscript,questionReplay} from './listening-review.mjs';

(() => {
  'use strict';
  const KEY = 'listening-desk-progress-v1';
  const LEGACY = [
    {batch:1,title:'试运行：Asia-Pacific Tours / Foxton Bay / Poppy Reserve',detail:'3 套入门题 · 已完成',ids:['p1-1','p1-15','p1-22']},
    {batch:2,title:'Notes on A Part time Society',detail:'已完成',ids:['p1-7']},
    {batch:3,title:'Birthday Party Arrangement',detail:'Day 7 复测 10/10 · 2026-09-18',ids:['p1-17']},
    {batch:4,title:'Enquiries on Hot Air Balloon Trip',detail:'Day 7 复测 10/10 · 2026-09-21',ids:['p1-41']}
  ];
  const LABEL = {d1:'Day 1 · 首次盲听',d2blind:'Day 2 · 盲听',review:'Day 2 · 精听核对',d2verify:'Day 2 · 整段验证',d7:'Day 7 · 延迟复测',done:'已完成'};
  const el = document.getElementById('app');
  const audio = document.getElementById('audio');
  const cueAudio=document.getElementById('cue-audio');
  cueAudio.setAttribute('playsinline','');
  function applyCueRate(){const r=Number(state?.settings?.speed)||1;cueAudio.defaultPlaybackRate=r;try{cueAudio.playbackRate=r;}catch(_){}}
  function stopCue(){cueAudio.pause();cueAudio.removeAttribute('src');cueAudio.load();cueAudio.loop=false;document.getElementById('cue-player-panel').hidden=true;}
  document.getElementById('stop-cue').addEventListener('click',stopCue);
  audio.addEventListener('play',stopCue);
  cueAudio.addEventListener('loadedmetadata',applyCueRate);
  cueAudio.addEventListener('play',()=>{applyCueRate();player.pause();});
  cueAudio.addEventListener('error',()=>toast('本段音频未加载成功，请再点一次回听。'));
  const lightbox=document.getElementById('img-lightbox'),lightboxImg=document.getElementById('lightbox-img');
  function openLightbox(src,alt){if(!lightbox||!lightboxImg)return;lightboxImg.src=src;lightboxImg.alt=alt||'题页放大图';lightbox.hidden=false;}
  function closeLightbox(){if(!lightbox)return;lightbox.hidden=true;if(lightboxImg)lightboxImg.removeAttribute('src');}
  document.getElementById('close-lightbox')?.addEventListener('click',closeLightbox);
  lightbox?.addEventListener('click',e=>{if(e.target===lightbox)closeLightbox();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&lightbox&&!lightbox.hidden)closeLightbox();});
  let sync;
  let bank = [], byId = {}, translations = {}, state, view = 'home', unitId = null, phase = 'form', resultStage = null;
  let partFilter = 0, bankSearch = '', mistakeFilter = 'active', loopA = null, loopB = null, noticeTimer;
  let scrubbing = false, audioSource = '';
  let transcriptMode='focus',transcriptSearch='',transcriptHighlights=true,transcriptFocusedQ=null,segmentEnd=null;
  const reviewModels=new WeakMap();
  const player = createAudioPlayer(audio, {
    onChange: updateAudio,
    onPlayError: ({kind}) => {if(kind==='autoplay')toast('浏览器限制了自动播放，请点播放键开始。');}
  });

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const addDays = (date, n) => { const [y,m,d]=date.split('-').map(Number), x=new Date(y,m-1,d+n); return [x.getFullYear(),String(x.getMonth()+1).padStart(2,'0'),String(x.getDate()).padStart(2,'0')].join('-'); };
  const prettyDate = date => date ? `${Number(date.slice(5,7))}月${Number(date.slice(8))}日` : '待定';
  const fresh = () => ({schema:1,nextBatch:5,units:[],settings:{speed:1},legacy:LEGACY});
  function load(){ try { const v=JSON.parse(localStorage.getItem(KEY)); if(v && v.schema===1 && Array.isArray(v.units) && Number.isInteger(v.nextBatch)) return v; } catch(_){} return fresh(); }
  function cacheState(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch(_){toast('本机存储不可用，请留意云端保存状态。');}}
  function save(){state.weakPoints=buildWeakPointLedger(state,bank);cacheState();sync?.changed();}
  function syncStatus(status){const n=document.getElementById('sync-status');if(!n)return;const labels={loading:'正在读取进度…',saving:'正在保存…',saved:'已保存到本机磁盘',static:'已保存在当前浏览器',offline:'本机服务暂不可用 · 浏览器已保留，将自动重试',signin:'本机服务未连接'};n.textContent=labels[status]||labels.saved;n.dataset.state=status;const link=document.getElementById('sync-signin');if(link)link.hidden=status!=='signin';}
  function toast(message){const n=document.getElementById('notice');n.textContent=message;n.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>n.hidden=true,4300);}
  const item = id => byId[id];
  const unit = () => state.units.find(x=>x.id===unitId);
  const lastResultStage = u => u?.stages?.d7||u?.confirmedCompleted?.d7?'d7':['d2verify','d2blind','d1'].find(k=>u?.stages?.[k])||(u?.confirmedCompleted?'d2verify':null);
  const completionSignature = p => JSON.stringify((p?.units||[]).map(u=>[u.id,Object.keys(u.stages||{}).sort(),Object.keys(u.confirmedCompleted||{}).sort()]));
  let rendered=false;
  function acceptCloudProgress(p){
    const before=completionSignature(state),previous=unit();
    state=restoreConfirmedProgress(p,bank);
    if(unitId&&!unit()&&previous)unitId=state.units.find(u=>u.batch===previous.batch&&u.setId===previous.setId)?.id||unitId;
    state.weakPoints=buildWeakPointLedger(state,bank);cacheState();
    if(rendered&&before!==completionSignature(state)){
      const u=unit();
      if(view==='practice'&&u&&phase==='form'&&stageFor(u)==='done'){phase='result';resultStage=lastResultStage(u);}
      render();
    }
  }
  const completeIds = () => new Set([...(state.legacy||LEGACY).flatMap(x=>x.ids||[]),...state.units.filter(x=>stageFor(x)==='done').map(x=>x.setId)]);
  function mistakeEntries(){const rows=[];
    for(const u of state.units){const set=item(u.setId);if(!set?.available)continue;
      for(let n=set.questionStart;n<set.questionStart+10;n++){
        const attempts=['d1','d2blind','d2verify','d7'].filter(k=>u.stages[k]).map(k=>({stage:k,...u.stages[k],uncertain:(u.stages[k].flags||[]).includes(n),correct:u.stages[k].right?.[n]===true}));
        if(!attempts.some(a=>!a.correct||a.uncertain))continue;
        const latest=attempts.at(-1);
        rows.push({unitId:u.id,batch:u.batch,set,n,attempts,latest,status:!latest.correct?'wrong':latest.uncertain?'uncertain':'correct',wrongCount:attempts.filter(a=>!a.correct).length});
      }
    }
    return rows.sort((a,b)=>(a.status==='correct')-(b.status==='correct')||b.batch-a.batch||a.n-b.n);
  }
  function dailyTask(){const task=planDailyTask({...state,legacy:state.legacy||LEGACY},bank,today());if(JSON.stringify(task)!==JSON.stringify(state.dailyTask)){state.dailyTask=task;save();}return task;}
  function canPractice(u){const t=dailyTask();return !!t&&!t.completed&&t.unitId===u.id;}
  function isDue(u){const d=dueDate(u);return !d || d<=today();}
  function dueLabel(u){const d=dueDate(u);if(!d)return '可立即开始';if(d<today())return `已逾期 · 原定 ${prettyDate(d)}`;if(d===today())return '今天到期';return `${prettyDate(d)} 到期`;}
  function nextSuggestion(){const used=new Set([...(state.legacy||LEGACY).flatMap(x=>x.ids||[]),...state.units.map(x=>x.setId)]);return bank.find(x=>x.available&&x.part===1&&!used.has(x.id))||bank.find(x=>x.available&&!used.has(x.id));}
  let draftTimer = null;
  function saveDraft(immediate = false){
    if(!state)return;
    const u=unit();if(!u||view!=='practice'||phase!=='form')return;
    const stage=stageFor(u);if(stage==='done'||stage==='review')return;
    const a={},f=[];
    el.querySelectorAll('[data-answer]').forEach(i=>a[i.dataset.answer]=i.value);
    el.querySelectorAll('[data-flag].active').forEach(b=>f.push(Number(b.dataset.flag)));
    u.drafts[stage]={answers:a,flags:f,updatedAt:new Date().toISOString()};
    if(immediate){
      if(draftTimer){clearTimeout(draftTimer);draftTimer=null;}
      save();
    }else{
      if(draftTimer)clearTimeout(draftTimer);
      draftTimer=setTimeout(()=>{draftTimer=null;save();},250);
    }
  }
  function go(to){if(!state)return;stopCue();if(view==='practice'&&to!=='practice')saveDraft(true);if(to!=='practice'){player.pause();segmentEnd=null;}view=to;render();window.scrollTo(0,0);}
  function startSet(id){const set=item(id);if(!set?.available){toast('这套材料尚缺音频或题页，暂不能开始。');return;}
    const task=dailyTask();
    if(!task||task.completed){toast('今天的主任务已完成，明天再继续。你仍可回看文字稿和错题。');return;}
    let u=state.units.find(x=>x.id===task.unitId);
    if(u){if(u.setId!==id){toast('今天先完成已安排的主任务。');return;}openUnit(u.id);return;}
    if(task.kind!=='d1')return;
    if(state.units.some(x=>x.setId===id)||(state.legacy||LEGACY).some(x=>(x.ids||[]).includes(id))){toast('请为今天的新批次选择尚未练过的题组。');return;}
    u={id:`unit-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,setId:id,batch:state.nextBatch++,created:today(),stages:{},drafts:{},reviewDone:false};state.units.push(u);
    state.dailyTask={date:today(),kind:'d1',unitId:u.id,setId:id,completed:false};save();openUnit(u.id);
  }
  function openUnit(id){const u=state.units.find(x=>x.id===id);if(!u)return;
    if(!canPractice(u)){toast('每天一个主任务；到期的 Day 7 优先。其他批次可从训练记录回看。');return;}
    unitId=id;phase=stageFor(u)==='review'?'review':'form';resultStage=null;loopA=loopB=null;segmentEnd=null;resetTranscript();go('practice');
  }
  function stat(label,value,foot){return `<div class="card stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`;}
  function header(eyebrow,title,lead){return `<div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1><p class="subtle page-lead">${lead}</p>`;}
  function taskCard(u,set){const stage=u?stageFor(u):'d1', batch=u?u.batch:state.nextBatch;
    const tag=u?(dueDate(u)&&dueDate(u)<today()?'待补复习':'本轮待完成'):'建议下一套';
    return `<div class="card task-card"><span class="chip ${u&&dueDate(u)&&dueDate(u)<today()?'amber':''}">${tag}</span><h2>批次 ${batch} · ${esc(set.title)}</h2>
      <p>${u?`${LABEL[stage]}。${dueLabel(u)}。按你的实际完成时间继续推进。`:'从 Part 1 开始下一轮。完成首次盲听后，安排次日复习与延迟复测。'}</p>
      <div class="task-meta"><span><b>PART ${set.part}</b> / Questions ${set.questionStart}–${set.questionStart+9}</span><span><b>音频 + 题页 + 文字稿</b></span></div>
      <button class="btn" data-action="${u?'open':'start'}" data-id="${u?u.id:set.id}">${u?'继续这轮训练':'开始批次 '+batch} <span>→</span></button></div>`;
  }
  function renderHome(){const open=state.units.filter(x=>stageFor(x)!=='done'),due=open.filter(isDue),task=dailyTask(),primary=task?.unitId?state.units.find(u=>u.id===task.unitId):null,set=task&&item(task.setId);
    const completed=state.units.filter(x=>stageFor(x)==='done').length+(state.legacy||LEGACY).length;
    el.innerHTML=`<div class="content">${header('YOUR PRACTICE / 今日安排','今天，接着听。','每天一个主任务。Day 7 到期优先，其他日子接续次日回听或新批次；完成后当天不再加量。')}
      <div class="grid stats">${stat('待完成复习',due.length,'按实际完成情况统计')}${stat('进行中批次',open.length,'包含尚未到期')}${stat('已完成批次',completed,'含此前记录的 4 批')}${stat('待巩固题',mistakeEntries().filter(x=>x.status!=='correct').length,'错题与不确定项自动汇总')}</div>
      <div class="grid home-columns"><section><h2 class="section-title">今天只做一个主任务</h2>${task?.completed?`<div class="card task-card"><span class="chip teal">今日已完成</span><h2>批次 ${primary.batch} · ${esc(set.title)}</h2><p>今天的${task.kind==='d2'?'次日回听（盲听、精听、验证）':task.kind==='d7'?'Day 7 延迟复测':'Day 1 首练'}已记录。明天再继续；今天可以自由回看。</p><button class="btn secondary" data-action="history-result" data-id="${primary.id}">回看本批次 →</button></div>`:set?taskCard(primary,set):'<div class="empty">所有可用题组都已安排。</div>'}
      <div class="queue"><div class="row-between"><h2 class="section-title">待办与下一次复习</h2><button class="text-btn" data-view="history">查看记录 →</button></div>
      <div class="queue-list">${open.length?open.sort((a,b)=>a.batch-b.batch).map(u=>`<div class="queue-item"><div><div class="queue-title">批次 ${u.batch} · ${esc(item(u.setId)?.title||u.setId)}</div><small>${LABEL[stageFor(u)]} · ${dueLabel(u)}</small></div><div class="queue-right"><span class="chip ${isDue(u)?'teal':'gray'}">${isDue(u)?'待办':'未到期'}</span>${canPractice(u)?`<button class="text-btn" data-action="open" data-id="${u.id}">今日任务 →</button>`:''}</div></div>`).join(''):'<div class="empty">目前没有进行中的批次。完成首练后，这里会显示复习日期。</div>'}</div></div></section>
      <aside class="card rhythm-card"><div class="eyebrow">THE RHYTHM</div><h3>一套题，三次回听</h3>
      <div class="rhythm-step"><span class="step-badge">1</span><div><strong>首次盲听</strong><small>整段做题，提交后记录真实成绩与不确定项。</small></div></div>
      <div class="rhythm-step"><span class="step-badge">2</span><div><strong>先盲听，再精听</strong><small>次日先做一遍；看错题与文字稿后，再整段验证。</small></div></div>
      <div class="rhythm-step"><span class="step-badge">7</span><div><strong>延迟复测</strong><small>从首次训练起约一周；遇到延误会保留待办。</small></div></div></aside></div></div>`;
  }
  function bankCard(x,used){const existing=state.units.find(u=>u.setId===x.id),incomplete=existing&&stageFor(existing)!=='done'?existing:null,active=incomplete&&canPractice(incomplete),action=active?'open':existing?'history-result':'start';
    return `<div class="card bank-item ${x.available?'':'unavailable'}"><div><div class="number">PART ${x.part} · #${x.number}</div><h3>${esc(x.title)}</h3><p>${x.available?(existing?`批次 ${existing.batch} · ${LABEL[stageFor(existing)]}`:used.has(x.id)?'此前已练过 · 仅接续完成记录':'10 题 · 音频 / 题页 / 文字稿齐全'):'缺少音频和 PDF 题页'}</p></div>
      <button class="btn small ${existing?'secondary':'ghost'}" data-action="${action}" data-id="${existing?existing.id:x.id}" ${!x.available||used.has(x.id)&&!existing?'disabled':''}>${x.available?(active?'今日任务':existing?'回看':used.has(x.id)?'已练过':'加入训练'):'待补全'}</button></div>`;
  }
  function renderBank(){el.innerHTML=`<div class="content">${header('QUESTION BANK / 全部题组','练习题库','按 Part 筛选或搜索。当天安排新批次时可更换题组；已开始的主任务完成后，次日再推进。')}
    <div class="bank-toolbar"><input id="bank-search" class="search" type="search" placeholder="搜索题目名称或编号" value="${esc(bankSearch)}" aria-label="搜索题库"><div class="filter-group">${[[0,'全部'],[1,'Part 1'],[2,'Part 2'],[3,'Part 3']].map(([p,n])=>`<button data-filter="${p}" class="${partFilter===p?'active':''}">${n}</button>`).join('')}</div></div>
    <p id="bank-summary" class="muted-line"></p><div id="bank-results" class="bank-grid"></div></div>`;filterBank();}
  function filterBank(){const v=bankSearch.trim().toLowerCase(),used=completeIds();const list=bank.filter(x=>(!partFilter||x.part===partFilter)&&(!v||(`${x.title} ${x.number} p${x.part}`).toLowerCase().includes(v)));
    const availCount=bank.filter(x=>x.available).length,unavailCount=bank.length-availCount;
    document.getElementById('bank-summary').textContent=`显示 ${list.length} 套 · ${availCount} 套完整${unavailCount?`，${unavailCount} 套待补全`:''}`;
    document.getElementById('bank-results').innerHTML=list.length?list.map(x=>bankCard(x,used)).join(''):'<div class="empty">没有找到匹配的题目。</div>';
  }
  function audioUI(){return `<div class="audio-card"><div class="audio-top"><button class="round-play" data-action="play" aria-label="播放或暂停">▶</button><div class="audio-track"><div class="track-top"><span id="audio-status" role="status">听力音频</span><span id="audio-time">00:00 / 00:00</span></div><input class="range" id="seek" type="range" min="0" max="1" step="0.1" value="0" disabled aria-label="音频进度"></div></div>
    <div class="audio-tools"><button data-action="skip" data-secs="-10">−10 秒</button><button data-action="skip" data-secs="10">+10 秒</button><button data-action="mark-a">设 A</button><button data-action="mark-b">设 B</button><button data-action="clear-loop">清除循环</button><select id="speed" aria-label="播放速度">${[.75,1,1.25,1.5].map(n=>`<option value="${n}" ${Number(state.settings.speed)===n?'selected':''}>${n.toFixed(2).replace(/0$/,'')}×</option>`).join('')}</select></div><div class="audio-tip" id="loop-tip">可在精听时设置 A、B 两点循环播放。</div></div>`;}
  function setAudio(set){scrubbing=false;const target=new URL(set.audio,document.baseURI).href;if(target!==audioSource){loopA=loopB=null;audioSource=target;}player.setRate(Number(state.settings.speed)||1);player.load(target,{fallbacks:set.replay?.audio?[new URL(set.replay.audio,document.baseURI).href]:[]});updateAudio();}
  function resetTranscript(){transcriptMode='focus';transcriptSearch='';transcriptFocusedQ=null;}
  function day2Steps(u,stage){if(!['d2blind','review','d2verify'].includes(stage))return '';const current=stage==='d2blind'?1:stage==='review'?2:3;return `<nav class="day2-steps" aria-label="Day 2 三步回听"><span class="${current===1?'current':''}"><b>1</b>先盲听作答</span><button class="${current===2?'current':''}" data-action="back-to-review" ${!u.stages.d2blind?'disabled':''} ${current===2?'aria-current="step"':''}><b>2</b>错题＋文字稿精听</button><button class="${current===3?'current':''}" data-action="review" ${!u.stages.d2blind?'disabled':''} ${current===3?'aria-current="step"':''}><b>3</b>关稿整段验证</button></nav>`;}
  function questions(set){return `<div class="card question-panel"><div class="panel-heading"><h2>题目原页</h2><small>以 PDF 原题为准</small></div>${set.pages.map((p,i)=>`<img class="page-image" src="${p}" alt="${esc(set.title)}，题页 ${i+1}" loading="${i?'lazy':'eager'}">`).join('')}${set.note?`<p class="pdf-note">${esc(set.note)}</p>`:''}</div>`;}
  function renderForm(u,set){const stage=stageFor(u),draft=u.drafts[stage]||{answers:{},flags:[]},nums=Array.from({length:10},(_,i)=>set.questionStart+i);
    el.innerHTML=`<div class="content"><div class="practice-header"><div><button class="back" data-view="home">← 返回今日任务</button><div class="eyebrow" style="margin-top:16px">BATCH ${u.batch} / ${LABEL[stage]}</div><h1>${esc(set.title)}</h1><div class="subtle">Part ${set.part} · Questions ${nums[0]}–${nums.at(-1)} · ${dueLabel(u)}</div></div><span class="chip">${LABEL[stage]}</span></div>
      ${day2Steps(u,stage)}${stage==='d2blind'?'<div class="review-guide"><strong>文字稿在下一步，不用另外找。</strong><p>先完成这遍盲听并提交；随后会自动打开错题与文字稿精听页。看稿精听后，再关闭文字做整段验证。</p></div>':stage==='d2verify'?'<div class="review-guide"><strong>第 3 步：关稿，整段复听。</strong><p>建议用 1× 语速验证。若还需核对，回看精听稿会保留这里的草稿。</p><button class="btn small secondary" data-action="back-to-review">回看精听稿（保留草稿）</button></div>':''}<div class="mobile-audio">${audioUI()}</div><div class="practice-layout">${questions(set)}<div class="card answer-panel"><div class="panel-heading"><h2>作答区</h2><small>自动保存草稿</small></div><p class="view-only">先独立听完整段。标记不确定题，提交后再核对答案与文字稿。</p>
      ${nums.map(n=>`<div class="answer-row"><label class="qnum" for="q${n}">${n}</label><input id="q${n}" data-answer="${n}" class="answer-input" autocomplete="off" spellcheck="false" placeholder="输入答案" value="${esc(draft.answers[n]||'')}"><button type="button" data-flag="${n}" class="flag ${draft.flags.includes(n)?'active':''}" title="标记不确定" aria-label="第 ${n} 题不确定">?</button></div>`).join('')}
      <div class="answer-footer"><small>输入内容、标记和训练阶段自动保存到本机磁盘；页顶显示保存状态。两题一组的选择题按不计顺序判分。</small><button class="btn" data-action="submit">提交本轮答案 →</button></div></div></div></div>`;
    setAudio(set);
  }
  function normalize(s){return String(s||'').trim().toLowerCase().normalize('NFKC').replace(/[’‘]/g,"'").replace(/(?<=\d),(?=\d)/g,'').replace(/[,\s]+/g,' ').replace(/[.!?]$/,'').trim();}
  function sameAnswer(given,answer){const g=normalize(given);return String(answer).split('/').some(a=>g===normalize(a));}
  function grade(set,answers){const right={};for(const n of Object.keys(set.answers))right[n]=sameAnswer(answers[n],set.answers[n]);
    for(const group of set.groups){const a=group.map(n=>normalize(answers[n]).toUpperCase()).sort().join('|'),b=group.map(n=>normalize(set.answers[n]).toUpperCase()).sort().join('|');for(const n of group)right[n]=a===b;}
    return {score:Object.values(right).filter(Boolean).length,right};
  }
  function submit(){const u=unit(),set=item(u.setId),stage=stageFor(u);if(!['d1','d2blind','d2verify','d7'].includes(stage)||!canPractice(u))return;
    saveDraft(true);const draft=u.drafts[stage],missing=Object.values(draft.answers).filter(x=>!x.trim()).length;
    if(missing && !confirm(`还有 ${missing} 题未填写。仍要提交这一轮吗？`))return;
    const result=grade(set,draft.answers),entry={date:today(),updatedAt:new Date().toISOString(),answers:{...draft.answers},flags:[...draft.flags],score:result.score,right:result.right};
    u.stages[stage]=entry;delete u.drafts[stage];if(stage==='d1')u.day1=today();if(stage==='d2verify')u.day2=today();if(stage==='d7')u.day7=today();
    save();player.pause();segmentEnd=null;resetTranscript();phase=stage==='d2blind'?'review':'result';resultStage=stage;render();window.scrollTo(0,0);
  }
  function reviewModel(set){if(!reviewModels.has(set))reviewModels.set(set,buildReviewModel(set));return reviewModels.get(set);}
  function reviewRows(set,entry,u){const reasons=[['','选择原因（可选）'],['sound','词认识，但没听出声音'],['meaning','词义或表达不熟'],['spelling','拼写／单复数／格式'],['location','定位／转折／干扰项'],['unsure','暂时不确定']];return Array.from({length:10},(_,i)=>set.questionStart+i).map(n=>`<div class="review-row ${entry.right[n]?'good':'bad'}"><span class="num">${n}</span><div><strong>${entry.right[n]?'✓ 正确':'× 需核对'}${(entry.flags||[]).includes(n)?'<em>曾标记不确定</em>':''}</strong><small>你的答案：${esc(entry.answers[n]||'（空白）')}　·　参考：${esc(set.answers[n])}</small>${roundBadges(u,n)}<button class="text-btn" data-action="review-question" data-question="${n}">▶ 定位并回听 Q${n} 错句</button>${!entry.right[n]||(entry.flags||[]).includes(n)?`<label class="reason-label">这次卡在哪里？<select data-error-reason="${n}" aria-label="Q${n} 错因">${reasons.map(([v,t])=>`<option value="${v}" ${u.listeningReview?.reasonsByStage?.[resultStage||'d2blind']?.[n]===v?'selected':''}>${t}</option>`).join('')}</select></label>`:''}</div></div>`).join('');}
  function roundBadges(u,q){return `<div class="round-errors">${roundErrors(u,q).filter(r=>!r.correct||r.uncertain).map(r=>`<span class="stage-pill">${LABEL[r.stage]} ${!r.correct?'× 答错':'✓'}${r.uncertain?' · 不确定':''}</span>`).join('')}</div>`;}
  function transcriptRows(set,entry,u){
    const model=reviewModel(set),wrong=focusQuestions(entry),qs=transcriptFocusedQ===null?(wrong.length?wrong:Object.keys(set.answers).map(Number)):[transcriptFocusedQ];
    const selection=selectReviewCues(model,{questions:qs,difficult:u.listeningReview?.difficultCues||[],mode:transcriptMode,query:transcriptMode==='hidden'?'':transcriptSearch});
    const intro=transcriptMode==='focus'?(selection.fallback?'<p class="stage-hint">目前没有可可靠定位的重点段落，先显示全文；也可自行标记难句。</p>':`<p class="stage-hint">${transcriptFocusedQ===null?(wrong.length?'当前答错和不确定的题目优先':'本轮没有错题，可自由回听各题'):'正在定位 Q'+transcriptFocusedQ}，保留前后各一段语境。${selection.unmatched.length?'Q'+selection.unmatched.join('、Q')+' 暂无可靠定位，可切换完整稿查找。':''}</p>`):'';
    return `${intro}${selection.rows.length?selection.rows.map(c=>{const difficult=(u.listeningReview?.difficultCues||[]).includes(c.index),explicit=c.explicit.filter(q=>qs.includes(q)),candidate=model.questions.filter(q=>qs.includes(q.q)&&q.source==='candidate'&&q.indices.includes(c.index)).map(q=>q.q);return `<article class="review-cue" data-cue-index="${c.index}"><div class="cue-heading"><span>第 ${c.index+1} 段 · ${c.timed?format(c.start)+'–'+format(c.end)+(c.clip?' · 已校准独立音频':' · 整段精听定位'):'原稿时间未核验'}</span>${explicit.length?`<span class="cue-tag">原稿题号 Q${explicit.join('、Q')}</span>`:candidate.length?`<span class="cue-tag candidate">Q${candidate.join('、Q')} 关键词候选</span>`:''}</div>${transcriptMode==='hidden'?'':model.questions.filter(q=>q.indices.includes(c.index)).map(q=>roundBadges(u,q.q)).join('')}${transcriptMode==='hidden'?'<p class="hidden-transcript">文字已隐藏，先听，再试着复述。</p>':`<p class="cue-text" tabindex="0">${markedTranscript(c.text,model,{highlights:transcriptHighlights,query:transcriptSearch})}</p><button class="text-btn help-toggle" data-action="toggle-cue-help" aria-expanded="false" aria-controls="cue-help-${c.index}">中文与简析</button><div class="cue-help" id="cue-help-${c.index}"><p lang="zh-CN">${esc(cueTranslation(translations,set,c.index))}</p>${model.questions.filter(q=>q.indices.includes(c.index)).map(q=>`<p class="cue-explanation"><b>Q${q.q}</b> ${esc(questionExplanation(translations,set,q.q,entry))}</p>`).join('')}</div>`}<div class="cue-actions">${c.timed?`<button class="btn small secondary" data-action="play-cue" data-index="${c.index}">▶ 回听本段</button><button class="text-btn" data-action="loop-cue" data-index="${c.index}">循环本段</button>`:'<span class="stage-hint">此段尚未完成音频校准，暂不自动回听；可用整段播放器手动定位／设 A、B。</span>'}<button class="text-btn" data-action="difficult-cue" data-index="${c.index}" aria-pressed="${difficult}">${difficult?'★ 已标难句':'☆ 标为难句'}</button></div></article>`;}).join(''):'<p class="empty">没有匹配的文字，试试清空搜索或切换完整文字稿。</p>'}`;
  }
  function playReviewClip(clip,label,loop=false){
    if(!clip)return;
    if(clip.clip){
      player.pause();loopA=loopB=null;segmentEnd=null;stopCue();
      cueAudio.src=new URL(clip.clip,document.baseURI).href;
      cueAudio.loop=loop;
      cueAudio.defaultPlaybackRate=cueAudio.playbackRate=Number(state.settings.speed)||1;
      cueAudio.load();
      document.getElementById('cue-player-label').textContent=`${label} · ${format(clip.start)}–${format(clip.end)}`;
      document.getElementById('cue-player-panel').hidden=false;
      cueAudio.play().catch(()=>toast('请点本段播放器的播放键继续。'));
      updateAudio();
      return;
    }
    if(Number.isFinite(clip.start)&&Number.isFinite(clip.end)&&clip.end>clip.start){
      stopCue();
      if(loop){loopA=clip.start;loopB=clip.end;segmentEnd=null;}
      else{loopA=loopB=null;segmentEnd=clip.end;}
      player.seekAndPlay(clip.start);
      updateAudio();
    }
  }
  function wrongReplayButtons(set,entry){const qs=focusQuestions(entry);return `<div class="wrong-replay"><strong>${qs.length?'本轮错题与不确定项：点题号，直接听原声':'本轮没有错题，可从下方回听各题'}</strong><p>先回听这句，试着辨出没听清的词；再对照下方原稿和中文，最后再听一次。第 2、3 步随时可往返，不会清空草稿。</p><div>${qs.map(q=>`<button class="btn small secondary" data-action="review-question" data-question="${q}">▶ 回听 Q${q} 错句</button>`).join('')}</div></div>`;}
  function showTranscript(set,entry,u){return `<section class="card review-panel transcript-panel" aria-label="精听文字稿">${wrongReplayButtons(set,entry)}<div class="panel-heading"><h2>精听文字稿</h2><small>${set.transcript.length} 段 · 原始材料已收录</small></div><div class="transcript-tabs" role="group" aria-label="文字稿显示方式">${[['focus','本轮错题'],['all','完整文字稿'],['hidden','隐藏文字复听']].map(([v,t])=>`<button data-transcript-mode="${v}" class="${transcriptMode===v?'active':''}" aria-pressed="${transcriptMode===v}">${t}</button>`).join('')}</div>${transcriptMode==='hidden'?'<p class="stage-hint">文字和答案都已隐藏；需要核对时再切回。</p>':`<div class="transcript-tools"><input id="transcript-search" class="search" type="search" aria-label="搜索文字稿" placeholder="搜索原稿中的词或短语" value="${esc(transcriptSearch)}"><button class="btn small secondary" data-action="toggle-transcript-highlights" aria-pressed="${transcriptHighlights}">${transcriptHighlights?'关闭':'开启'}重点标注</button></div><p class="stage-hint">中文默认隐藏：电脑把鼠标放在英文段落上查看，手机点“中文与简析”。翻译供理解参考，原音与原稿为准。</p><p class="transcript-legend"><mark class="word-answer">参考答案词</mark> <mark class="word-signal">转折／否定等信号词</mark></p><details class="listening-method"><summary>怎么用这份稿精听？</summary><p>① 回听没听懂的短段，先试着辨词；② 对照稿，找答案前后的词组、转折和信息关系；③ 留意词界、重音与 and／to／of 等常见弱读；④ 隐藏文字再听，最后关稿做整段验证。</p><p>颜色标注用于定位语义，不代表已从音频检测出真实重音或连读。关键词候选未必就是唯一答案句；请结合前后文核对。</p></details>`}<p class="source-note">文字来自你上传的原稿，未改写；个别转写与原音可能有差异，以原音和 PDF 答案为准。没有时间戳的段落不会虚构跳转点。</p><div id="transcript-rows" class="transcript-rows">${transcriptRows(set,entry,u)}</div></section>`;}
  function currentReview(){const u=unit(),set=u&&item(u.setId),entry=u?.stages[resultStage||'d2blind'];return view==='practice'&&['review','result'].includes(phase)&&set&&(entry||u.confirmedCompleted)?{u,set,entry:entry||{answers:{},flags:[],right:{},external:true}}:null;}
  function redrawTranscript(){const c=currentReview(),rows=document.getElementById('transcript-rows');if(c&&rows)rows.innerHTML=transcriptRows(c.set,c.entry,c.u);}
  function renderResult(u,set){const stage=resultStage||'d2blind',entry=u.stages[stage]||(u.confirmedCompleted?{answers:{},flags:[],right:{},external:true}:null);if(!entry){phase='form';return renderForm(u,set);}
    const isReview=phase==='review', next=stageFor(u),due=dueDate(u);
    let action='';
    if(stage==='d2blind'&&!u.stages.d2verify&&canPractice(u))action=`<button class="btn" data-action="review">关闭文字，开始整段验证 →</button>`;
    else action=`<button class="btn" data-view="home">返回今日任务 →</button>`;
    el.innerHTML=`<div class="content"><div class="practice-header"><div><button class="back" data-view="home">← 返回今日任务</button><div class="eyebrow" style="margin-top:16px">BATCH ${u.batch} / ${LABEL[stage]}</div><h1>${esc(set.title)}</h1></div><span class="chip teal">${entry.external?'已确认完成 · 未录入成绩':'已提交 · '+prettyDate(entry.date)}</span></div>
      <div class="result-banner"><div><div class="eyebrow">SESSION RESULT</div><h2>${entry.external?(u.confirmedCompleted?.d7?'1 · 2 · 7 全部完成':'Day 1、Day 2 已完成'):stage==='d2verify'?'验证已记录':stage==='d7'?'延迟复测完成':isReview?'精听核对':'这一轮已记录'}</h2><p>${entry.external?'按你在聊天中的确认接续完成状态；没有编造成绩和错题。可在此自由回听、查看原稿。':stage==='d2blind'?'下面对照错题与文字稿精听，随后再做一次整段验证。':stage==='d7'?'本批次完成；需要时可从题库再练。':stage==='d1'?`下次先盲听；${due?prettyDate(due):'明天'}到期。`:stage==='d2verify'?`延迟复测安排在 ${prettyDate(due)} 或之后。`:''}</p></div><div class="score">${entry.external?'—':entry.score}<small>${entry.external?'无逐题成绩':' / 10'}</small></div></div>
      ${day2Steps(u,stage==='d2blind'?'review':stage)}<div class="mobile-audio">${audioUI()}</div>${stage==='d2blind'&&!u.stages.d2verify&&canPractice(u)?`<div class="review-guide"><strong>第 2 步：错题与文字稿精听</strong><p>原稿就在下方。重点段落看清后，点“关闭文字，开始整段验证”。</p>${action}</div>`:''}<div class="intensive-layout">${showTranscript(set,entry,u)}<aside class="card review-panel"><div class="panel-heading"><h2>答案核对</h2><small>PDF 答案页为准</small></div><div class="review-list">${transcriptMode==='hidden'?'<p class="hidden-transcript">答案已随文字稿隐藏。</p>':entry.external?'<p class="stage-hint">未录入你当时的逐题答案，以下仅为原题参考答案。</p>'+Object.entries(set.answers).map(([q,a])=>`<p>Q${q}：${esc(a)}</p>`).join(''):reviewRows(set,entry,u)}</div></aside></div>
      <div class="review-controls">${action}<button class="btn secondary" data-action="show-questions">查看题页</button></div><p class="stage-hint">${stage==='d2blind'?'Day 2 的盲听成绩与之后的验证成绩分别保存，不会互相覆盖。':'成绩按本轮提交时的答案保存。'}</p><div id="question-modal"></div></div>`;
    setAudio(set);
  }
  function renderPractice(){const u=unit(),set=u&&item(u.setId);if(!u||!set){go('home');return;}
    if(phase==='review'){resultStage='d2blind';renderResult(u,set);return;}
    if(phase==='result'){renderResult(u,set);return;}
    if(stageFor(u)==='done'){resultStage=lastResultStage(unit());if(!resultStage){toast('本批次尚未提交答案。');return;}phase='result';renderResult(u,set);return;}
    renderForm(u,set);
  }
  function renderMistakes(){const all=mistakeEntries(),active=all.filter(x=>x.status!=='correct'),shown=mistakeFilter==='all'?all:mistakeFilter==='correct'?all.filter(x=>x.status==='correct'):active;
    const statusText={wrong:'最近一轮仍错',uncertain:'答对但仍不确定',correct:'最近一轮答对'};
    el.innerHTML=`<div class="content">${header('REVIEW / 自动错题本','听错的，留在这里。','每次提交后自动汇总错题与“不确定”标记；后续复听的结果会更新状态，原记录仍保留。')}
      <div class="grid stats">${stat('累计收录',all.length,'含标记不确定的题')}${stat('仍需巩固',active.length,'最近一轮错或不确定')}${stat('最近已答对',all.length-active.length,'不等于永久掌握')}${stat('涉及批次',new Set(all.map(x=>x.unitId)).size,'只统计应用内逐题记录')}</div>
      <div class="bank-toolbar"><div class="filter-group">${[['active','待巩固'],['all','全部记录'],['correct','最近答对']].map(([f,t])=>`<button data-mistake-filter="${f}" class="${mistakeFilter===f?'active':''}">${t}</button>`).join('')}</div></div>
      <div class="mistake-list">${shown.length?shown.map(x=>`<div class="card mistake-card"><div class="row-between"><div><div class="number">批次 ${x.batch} · PART ${x.set.part} · QUESTION ${x.n}</div><h3>${esc(x.set.title)}</h3></div><span class="chip ${x.status==='correct'?'teal':x.status==='uncertain'?'amber':''}">${statusText[x.status]}</span></div>
      <div class="mistake-answer"><span>最近作答：<b>${esc(x.latest.answers?.[x.n]||'（空白）')}</b></span><span>参考答案：<b>${esc(x.set.answers[x.n])}</b></span></div>
      <div class="mistake-timeline">${x.attempts.map(a=>`<button class="stage-pill ${a.correct?'done':''}" data-action="review-mistake" data-id="${esc(x.unitId)}" data-stage="${a.stage}">${LABEL[a.stage].replace(' · ',' ')}：${a.correct?'✓':'×'}${a.uncertain?' ?':''}</button>`).join('')}</div>
      <div class="row-between mistake-bottom"><span class="muted-line">历次答错 ${x.wrongCount} 次 · 最近记录 ${prettyDate(x.latest.date)}</span><button class="text-btn" data-action="review-mistake" data-id="${esc(x.unitId)}" data-stage="${x.latest.stage}">回听与核对 →</button></div></div>`).join(''):'<div class="empty">这里暂时没有这类题。开始训练并提交答案后，会自动更新。</div>'}</div>
      <p class="stage-hint">此前批次 1–4 及聊天确认完成的阶段，只接续完成情况；没有逐题答案的阶段不编造错题。已有逐题记录会保留。</p></div>`;
  }
  function renderHistory(){const active=[...state.units].sort((a,b)=>b.batch-a.batch);
    el.innerHTML=`<div class="content">${header('RECORDS / 训练记录','每一次，按实际完成记。','Day 2 的首次盲听和精听后验证单独记录；错题与不确定项可随时回看。')}
      <div class="history-list">${active.map(u=>{const set=item(u.setId),stage=stageFor(u);return `<div class="card history-card"><div class="row-between"><div><h3>批次 ${u.batch} · ${esc(set?.title||u.setId)}</h3><p>${LABEL[stage]} · ${stage==='done'?(u.day7?`完成于 ${prettyDate(u.day7)}`:'已确认完成 · 日期未记录'):dueLabel(u)}</p></div><button class="btn small secondary" data-action="${canPractice(u)?'open':'history-result'}" data-id="${u.id}">${canPractice(u)?'今日任务':'回看'}</button></div><div class="history-stages">${u.confirmedCompleted?'<p class="stage-hint">你已确认'+(u.confirmedCompleted.d7?' Day 1、Day 2、Day 7':' Day 1、Day 2')+' 完成；未提供的逐题成绩不补写。'+esc(u.scheduleAnchorNote||'')+'</p>':''}${['d1','d2blind','d2verify','d7'].map(k=>u.stages[k]?`<button class="stage-pill done" data-action="review-mistake" data-id="${u.id}" data-stage="${k}">${LABEL[k]} ${u.stages[k].score}/10</button>`:`<span class="stage-pill">${LABEL[k]}${u.confirmedCompleted?.[k==='d2blind'||k==='d2verify'?'d2':k]?' · 已确认完成':''}</span>`).join('')}</div></div>`}).join('')}
      ${(state.legacy||LEGACY).slice().reverse().map(x=>`<div class="card history-card"><h3>批次 ${x.batch} · ${esc(x.title)}</h3><p>${esc(x.detail)} · 从此前训练记录接续</p><div class="history-stages"><span class="stage-pill done">已完成</span></div></div>`).join('')}</div></div>`;
  }
  function renderSettings(){el.innerHTML=`<div class="content">${header('YOUR DATA / 进度与备份','进度保存在这里。','输入、完成阶段与错题自动写入本机磁盘 data/listening-progress.json 并滚动备份；服务离线时先留在浏览器缓存并自动重试。')}
    <section class="card settings-card"><h2>本机训练记录</h2><p>当前有 ${state.units.length} 个新批次，另接续了此前 ${(state.legacy||LEGACY).length} 个批次。每次提交与精听标记均实时保存，也可随时导出或导入 JSON 备份。</p><div class="settings-actions"><button class="btn" data-action="export">导出 JSON 备份 ↓</button><label class="btn secondary" for="import-file">导入备份 ↑</label><input id="import-file" type="file" accept="application/json,.json"></div></section>
    <section class="card settings-card"><h2>复习如何排期</h2><p>Day 1 提交后，次日安排 Day 2；Day 2 包含先盲听、精听核对和整段验证；Day 7 自首练约一周到期。若 Day 2 做得更晚，延迟复测至少放在完成验证的次日。每天只安排一个主任务：到期 Day 7 优先，其次未完成的 Day 2，再安排新批次。Day 2 三步合计一个任务，今天完成后不再推进；忙碌期间未做的任务一直保留。首练当天算 Day 1，例如 1 日首练，7 日为 Day 7。</p></section>
</div>`;}
  function render(){document.getElementById('breadcrumb-name').textContent=({home:'今日任务',bank:'题库',mistakes:'错题本',history:'训练记录',settings:'数据与设置',practice:'正在训练'})[view];document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
    document.getElementById('mistake-count').textContent=mistakeEntries().filter(x=>x.status!=='correct').length;
    if(view==='home')renderHome();else if(view==='bank')renderBank();else if(view==='mistakes')renderMistakes();else if(view==='history')renderHistory();else if(view==='settings')renderSettings();else renderPractice();}
  function seconds(t){if(!t)return null;const parts=t.replace(',','.').split(':').map(Number);return parts.every(Number.isFinite)?parts.reduce((a,n)=>a*60+n,0):null;}
  function format(s){if(!Number.isFinite(s))return '00:00';return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;}
  function updateAudio(){
    const s=player.snapshot(),ready=s.status==='ready'&&s.duration>0;
    const t=document.getElementById('audio-time'),r=document.getElementById('seek'),p=document.querySelector('.round-play'),label=document.getElementById('audio-status');
    if(t&&!scrubbing)t.textContent=`${format(s.currentTime)} / ${format(s.duration)}`;
    if(r){r.disabled=!ready;if(!scrubbing){r.max=s.duration||1;r.value=s.currentTime;r.setAttribute('aria-valuetext',`${format(s.currentTime)}，共 ${format(s.duration)}`);}}
    if(p){p.textContent=s.paused?'▶':'Ⅱ';p.disabled=!s.hasSource;p.setAttribute('aria-label',s.status==='error'?'重试加载音频':'播放或暂停');}
    if(label)label.textContent=s.status==='loading'?'点击播放开始加载音频…':s.status==='error'?(s.errorKind==='decode'?'音频解码失败 · 点播放重新加载':'音频下载失败 · 点播放重新加载'):'听力音频';
    el.querySelectorAll('[data-action="skip"],[data-action="mark-a"],[data-action="mark-b"]').forEach(b=>b.disabled=!ready);
    const tip=document.getElementById('loop-tip');if(tip)tip.textContent=loopA!==null&&loopB!==null?`循环 ${format(loopA)}–${format(loopB)}。点击“清除循环”结束。`:loopA!==null?`A 点 ${format(loopA)} 已设置；播放到片段结束时设 B。`:'可拖动进度条跳转；精听时可设置 A、B 两点循环。';
  }
  function seekAudio(time){stopCue();segmentEnd=null;if(loopA!==null&&loopB!==null&&(time<loopA||time>=loopB))loopA=loopB=null;player.seek(time);}
  function finishScrub(){if(!scrubbing)return;const r=document.getElementById('seek');scrubbing=false;if(r&&!r.disabled)seekAudio(Number(r.value));else updateAudio();}
  audio.addEventListener('timeupdate',()=>{if(!scrubbing&&loopB!==null&&loopA!==null&&audio.currentTime>=loopB)player.seek(loopA);else if(!scrubbing&&segmentEnd!==null&&audio.currentTime>=segmentEnd){const end=segmentEnd;segmentEnd=null;player.pause();player.seek(end);}updateAudio();const c=currentReview();if(c){const model=reviewModel(c.set);el.querySelectorAll('[data-cue-index]').forEach(row=>{const cue=model.cues[Number(row.dataset.cueIndex)];row.classList.toggle('playing',!!cue?.timed&&audio.currentTime>=cue.start&&audio.currentTime<cue.end);});}});
  ['play','pause','seeked','seeking','ended'].forEach(name=>audio.addEventListener(name,updateAudio));
  el.addEventListener('pointerdown',e=>{if(e.target.id==='seek'&&!e.target.disabled)scrubbing=true;});
  document.addEventListener('pointerup',finishScrub);
  document.addEventListener('pointercancel',()=>{scrubbing=false;updateAudio();});
  document.querySelectorAll('.nav button[data-view]').forEach(b=>b.addEventListener('click',()=>{saveDraft(true);go(b.dataset.view);}));
  el.addEventListener('click',e=>{
    const pageImg=e.target.closest('.page-image');if(pageImg){openLightbox(pageImg.src,pageImg.alt);return;}
    const filter=e.target.closest('[data-filter]');if(filter){partFilter=Number(filter.dataset.filter);renderBank();return;}
    const transcriptTab=e.target.closest('[data-transcript-mode]');if(transcriptTab){const c=currentReview();if(!c||!['focus','all','hidden'].includes(transcriptTab.dataset.transcriptMode))return;transcriptMode=transcriptTab.dataset.transcriptMode;transcriptFocusedQ=null;renderResult(c.u,c.set);return;}
    const mistakeTab=e.target.closest('[data-mistake-filter]');if(mistakeTab){mistakeFilter=mistakeTab.dataset.mistakeFilter;renderMistakes();return;}
    const nav=e.target.closest('[data-view]');if(nav){go(nav.dataset.view);return;}
    const flag=e.target.closest('[data-flag]');if(flag){flag.classList.toggle('active');saveDraft(true);return;}
    const stamp=e.target.closest('[data-seek-time]');if(stamp){const t=seconds(stamp.dataset.seekTime);if(t!==null){stopCue();segmentEnd=null;player.seekAndPlay(t);}return;}
    const b=e.target.closest('[data-action]');if(!b)return;const action=b.dataset.action;
    if(action==='start')startSet(b.dataset.id);else if(action==='open')openUnit(b.dataset.id);
    else if(action==='submit')submit();
    else if(action==='review'){stopCue();const u=unit();if(!u?.stages.d2blind)return;if(u.stages.d2verify){phase='result';resultStage='d2verify';render();window.scrollTo(0,0);return;}if(!canPractice(u))return;u.reviewDone=true;save();player.pause();loopA=loopB=null;segmentEnd=null;player.seek(0);phase='form';resultStage=null;render();window.scrollTo(0,0);}
    else if(action==='back-to-review'){const u=unit();if(!u?.stages.d2blind)return;stopCue();saveDraft(true);player.pause();loopA=loopB=null;segmentEnd=null;resetTranscript();phase='review';resultStage='d2blind';render();window.scrollTo(0,0);}
    else if(action==='toggle-cue-help'){const row=b.closest('.review-cue');if(!row)return;const open=row.classList.toggle('help-open');b.setAttribute('aria-expanded',String(open));}
    else if(action==='toggle-transcript-highlights'){const c=currentReview();if(!c)return;transcriptHighlights=!transcriptHighlights;renderResult(c.u,c.set);}
    else if(action==='review-question'){const c=currentReview(),q=Number(b.dataset.question);if(!c||!Object.hasOwn(c.set.answers,q))return;transcriptFocusedQ=q;transcriptMode='focus';transcriptSearch='';renderResult(c.u,c.set);document.getElementById('transcript-rows')?.scrollIntoView({behavior:'smooth',block:'nearest'});const clip=questionReplay(reviewModel(c.set),c.set,q);if(clip)playReviewClip(clip,`Q${q} 错句原声（含前后语境）`);else toast('这题尚未取得可靠音频位置；保留原稿供核对。');}
    else if(action==='play-cue'||action==='loop-cue'){const c=currentReview(),cue=c&&reviewModel(c.set).cues[Number(b.dataset.index)];if(cue?.timed)playReviewClip(cue,`${action==='loop-cue'?'循环':'回听'}第 ${cue.index+1} 段`,action==='loop-cue');}
    else if(action==='difficult-cue'){const c=currentReview(),index=Number(b.dataset.index);if(!c||!Number.isInteger(index)||!reviewModel(c.set).cues[index])return;c.u.listeningReview ||= {};const marked=new Set(c.u.listeningReview.difficultCues||[]);if(marked.has(index))marked.delete(index);else marked.add(index);c.u.listeningReview.difficultCues=[...marked].sort((a,b)=>a-b);save();redrawTranscript();}
    else if(action==='play'){stopCue();if(player.snapshot().status==='error'||audio.paused)player.play();else player.pause();}
    else if(action==='skip')seekAudio(player.snapshot().currentTime+Number(b.dataset.secs));
    else if(action==='mark-a'){stopCue();segmentEnd=null;loopA=audio.currentTime;loopB=null;updateAudio();}
    else if(action==='mark-b'){if(loopA===null||audio.currentTime<=loopA+1){toast('先设置 A 点，再播放至少 1 秒后设置 B 点。');return;}segmentEnd=null;loopB=audio.currentTime;updateAudio();}
    else if(action==='clear-loop'){stopCue();segmentEnd=null;loopA=loopB=null;updateAudio();}
    else if(action==='history-result'){unitId=b.dataset.id;resultStage=lastResultStage(unit());if(!resultStage){toast('本批次尚未提交答案。');return;}phase='result';segmentEnd=null;loopA=loopB=null;resetTranscript();go('practice');}
    else if(action==='review-mistake'){unitId=b.dataset.id;resultStage=b.dataset.stage;phase='result';segmentEnd=null;loopA=loopB=null;resetTranscript();go('practice');}
    else if(action==='show-questions'){const set=item(unit().setId),box=document.getElementById('question-modal');box.innerHTML=box.innerHTML?'':`<div class="card question-panel" style="margin-top:15px">${set.pages.map((p,i)=>`<img class="page-image" src="${p}" alt="题页 ${i+1}">`).join('')}</div>`;if(box.innerHTML)box.scrollIntoView({behavior:'smooth'});}
    else if(action==='export'){const blob=new Blob([JSON.stringify({app:'listening-desk',exportedAt:new Date().toISOString(),progress:state},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`英语听力训练备份-${today()}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    else if(action==='reset'){if(confirm('确定清空当前浏览器的听力缓存并重新读取本机磁盘记录吗？')){try{localStorage.removeItem(KEY);sync?.clearDirty?.();}catch(_){}window.location.reload();}}
  });
  el.addEventListener('input',e=>{if(e.target.matches('[data-answer]'))saveDraft(false);if(e.target.id==='bank-search'){bankSearch=e.target.value;filterBank();}if(e.target.id==='transcript-search'){transcriptSearch=e.target.value;redrawTranscript();}if(e.target.id==='seek'&&!e.target.disabled){scrubbing=true;const t=document.getElementById('audio-time');if(t)t.textContent=`${format(Number(e.target.value))} / ${format(player.snapshot().duration)}`;e.target.setAttribute('aria-valuetext',`${format(Number(e.target.value))}，共 ${format(player.snapshot().duration)}`);}});
  el.addEventListener('change',async e=>{if(e.target.id==='speed'){state.settings.speed=Number(e.target.value);player.setRate(state.settings.speed);applyCueRate();save();}
    if(e.target.id==='seek')finishScrub();
    if(e.target.matches('[data-error-reason]')){const c=currentReview(),q=Number(e.target.dataset.errorReason),value=e.target.value;if(!c||!Object.hasOwn(c.set.answers,q)||!['','sound','meaning','spelling','location','unsure'].includes(value))return;c.u.listeningReview ||= {};c.u.listeningReview.reasonsByStage ||= {};const stage=resultStage||'d2blind';c.u.listeningReview.reasonsByStage[stage] ||= {};c.u.listeningReview.reasonsByStage[stage][q]=value;save();}
    if(e.target.id==='import-file'&&e.target.files[0]){try{const obj=JSON.parse(await e.target.files[0].text()),candidate=obj.progress;if(obj.app!=='listening-desk'||candidate?.schema!==1||!Array.isArray(candidate.units)||!Number.isInteger(candidate.nextBatch)||candidate.units.some(u=>!item(u.setId)))throw Error('格式不匹配');if(confirm(`将合并备份中的 ${candidate.units.length} 个批次，保留现有训练记录。继续吗？`)){state=restoreConfirmedProgress(mergeProgress(state,candidate),bank);state.settings ||= {speed:1};state.legacy ||= LEGACY;save();go('home');toast('备份已导入。');}}catch(_){toast('无法导入：请选择本训练台导出的完整 JSON 备份。');}e.target.value='';}
  });
  el.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-answer]')){e.preventDefault();const fields=[...el.querySelectorAll('[data-answer]')],i=fields.indexOf(e.target);fields[i+1]?.focus();}});
  async function init(){document.getElementById('today-label').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'short'}).format(new Date());
    try{const r=await fetch('bank.json?v=9',{cache:'no-store'});if(!r.ok)throw Error('bank');bank=await r.json();try{const rr=await fetch('replay-manifest.json?v=9',{cache:'no-store'});if(rr.ok){const manifest=await rr.json();for(const set of bank){const r=manifest.sets?.[set.id];if(r?.revision===8&&r.sourceAudio===set.audio&&r.cues?.length===set.transcript?.length&&r.cues.every((c,i)=>c.text===set.transcript[i][2]))set.replay=r;}}}catch(_){}byId=Object.fromEntries(bank.map(x=>[x.id,x]));state=restoreConfirmedProgress(load(),bank);sync=createProgressSync({read:()=>state,accept:acceptCloudProgress,status:syncStatus});await sync.start();try{const zh=await fetch('listening-zh.json?v=7');if(zh.ok)translations=await zh.json();}catch(_){}state.weakPoints=buildWeakPointLedger(state,bank);if(state.units.length)cacheState();document.getElementById('bank-count').textContent=bank.filter(x=>x.available).length;rendered=true;render();}catch(e){el.innerHTML='<div class="content"><div class="empty">题库载入失败。请刷新页面重试。</div></div>';}}
  window.addEventListener('online',()=>sync?.retry());
  window.addEventListener('pagehide',()=>{stopCue();saveDraft(true);sync?.flush();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')sync?.retry();else{saveDraft(true);sync?.flush();}});
  init();
})();
