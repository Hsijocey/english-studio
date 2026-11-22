(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.VocabCloud=api;})(globalThis,function(){
'use strict';
const clone=x=>structuredClone(x),obj=x=>x&&typeof x==='object'&&!Array.isArray(x),n=x=>Number.isSafeInteger(x)&&x>=0?x:0;
const stamp=r=>Math.max(Number(r?.lastSeen)||0,Number(r?.manualAddedAt)||0,Date.parse(r?.updatedAt)||0);
const hash=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0).toString(16);};
function upgrade(p){
 if(p.cloud?.version===1)return p;
 p.cloud={version:1,bases:clone(p.records||{}),words:{},dailyBase:clone(p.today||{}),daily:{},sessionCopies:{},clock:0};
 p.navigationAt ||= Date.parse(p.savedAt)||0;
 return p;
}
function write(p,key,clientId,kind,{record,mode,now=Date.now(),countToday=true,correct=false,day}={}){
 upgrade(p);const c=p.cloud;c.clock=Math.max(c.clock||0,now)+1;
 const slots=c.words[key] ||= {},old=slots[clientId]||{attempts:0,correct:0,lastReviewAt:0,lastLearningAt:0};
 const next={...old,at:c.clock,record:clone(record)};
 if(kind==='attempt'){
  next.attempts=n(old.attempts)+1;next.correct=n(old.correct)+(correct?1:0);
  if(mode==='review'){next.lastReviewAt=c.clock;next.lastReviewCorrect=correct;}else next.lastLearningAt=c.clock;
  if(countToday){const date=day;const daily=(c.daily[date] ||= {})[clientId] ||= {attempts:0,correct:0};daily.attempts++;daily.correct+=correct?1:0;}
 }else next.lastLearningAt=c.clock;
 slots[clientId]=next;
}
function combineBase(a,b){
 if(!a)return clone(b);if(!b)return clone(a);
 const latest=stamp(b)>stamp(a)||stamp(b)===stamp(a)&&n(b.attempts)>n(a.attempts)?b:a;
 const first=[a.firstLearnedAt,b.firstLearnedAt].filter(x=>x>0);
 return {...clone(latest),attempts:Math.max(n(a.attempts),n(b.attempts)),correct:Math.min(Math.max(n(a.correct),n(b.correct)),Math.max(n(a.attempts),n(b.attempts))),...(first.length?{firstLearnedAt:Math.min(...first)}:{})};
}
function chooseSession(a,b){
 if(!a)return clone(b);if(!b)return clone(a);
 const legacy=!a.runId||!b.runId||a.runId.startsWith('legacy-')||b.runId.startsWith('legacy-');
 if(a.runId===b.runId||legacy&&JSON.stringify(a.queue)===JSON.stringify(b.queue)){
  const rank=s=>s.index*10+(s.answered?2:0)+(s.result?.correction?.done?1:0);
  const picked=rank(a)!==rank(b)?(rank(a)>rank(b)?a:b):((Date.parse(b.updatedAt)||0)>(Date.parse(a.updatedAt)||0)?b:a);
  const out=clone(picked),queue=[...a.queue],counts=new Map();for(const k of queue)counts.set(k,(counts.get(k)||0)+1);
  const seen=new Map();for(const k of b.queue){seen.set(k,(seen.get(k)||0)+1);if(seen.get(k)>(counts.get(k)||0))queue.push(k);}
  out.queue=queue;return out;
 }
 if(legacy)return clone((Date.parse(b.updatedAt)||0)>(Date.parse(a.updatedAt)||0)?b:a);
 return clone((b.runStartedAt||0)>(a.runStartedAt||0)?b:(b.runStartedAt||0)===(a.runStartedAt||0)&&(Date.parse(b.updatedAt)||0)>(Date.parse(a.updatedAt)||0)?b:a);
}
function merge(remote,local,{groups,plan,review,owner,server=false,now=Date.now()}){
 const a=upgrade(clone(remote||local)),b=upgrade(clone(local||remote));
 for(const p of [a,b])for(const [key,s]of Object.entries(p.sessions||{})){
  s.runId ||= 'legacy-'+hash(key+JSON.stringify(s.queue));s.runStartedAt ||= Date.parse(p.savedAt)||1;s.updatedAt ||= p.savedAt||'';
 }
 if(a.cloudOwner&&b.cloudOwner&&a.cloudOwner!==b.cloudOwner)throw Error('账号与本机记录不同，已暂停同步，原记录保留。');
 const ca=a.cloud,cb=b.cloud,out=clone(a),c=out.cloud;
 c.clock=Math.max(ca.clock||0,cb.clock||0);c.bases={};c.words={};
 const keys=new Set([...Object.keys(ca.bases),...Object.keys(cb.bases),...Object.keys(ca.words),...Object.keys(cb.words)]);
 out.records={};
 for(const key of keys){
  const base=combineBase(ca.bases[key],cb.bases[key])||{};c.bases[key]=base;
  const slots=c.words[key]={};for(const id of new Set([...Object.keys(ca.words[key]||{}),...Object.keys(cb.words[key]||{})])){
   const x=ca.words[key]?.[id],y=cb.words[key]?.[id],latest=!x?y:!y?x:(y.at||0)>(x.at||0)?y:x;
   slots[id]={...clone(latest),attempts:Math.max(n(x?.attempts),n(y?.attempts)),correct:Math.max(n(x?.correct),n(y?.correct)),lastReviewAt:Math.max(x?.lastReviewAt||0,y?.lastReviewAt||0),lastLearningAt:Math.max(x?.lastLearningAt||0,y?.lastLearningAt||0)};
  }
  const states=Object.entries(slots).map(([deviceId,s])=>({...s,deviceId})),latest=states.sort((x,y)=>(y.at||0)-(x.at||0)||y.deviceId.localeCompare(x.deviceId))[0];
  const r=out.records[key]={...clone(base),...(latest?.record?clone(latest.record):{}),attempts:n(base.attempts)+states.reduce((s,x)=>s+n(x.attempts),0),correct:n(base.correct)+states.reduce((s,x)=>s+n(x.correct),0)};
  const first=[base.firstLearnedAt,...states.map(x=>x.record?.firstLearnedAt)].filter(x=>x>0);
  if(base.attempts&&!base.firstLearnedAt)delete r.firstLearnedAt;else if(first.length)r.firstLearnedAt=Math.min(...first);
  r.lastReviewAt=Math.max(0,...states.map(x=>x.lastReviewAt||0));r.lastLearningAt=Math.max(0,...states.map(x=>x.lastLearningAt||0));
  const lastReview=states.filter(x=>x.lastReviewAt>0).sort((x,y)=>y.lastReviewAt-x.lastReviewAt||y.deviceId.localeCompare(x.deviceId))[0];
  if(lastReview)r.lastReviewCorrect=(lastReview.lastReviewCorrect??true)&&lastReview.record.streak>0&&!lastReview.record.flagged;
 }
 c.daily={};for(const date of new Set([...Object.keys(ca.daily||{}),...Object.keys(cb.daily||{})])){
  c.daily[date]={};for(const id of new Set([...Object.keys(ca.daily[date]||{}),...Object.keys(cb.daily[date]||{})])){
   const x=ca.daily[date]?.[id],y=cb.daily[date]?.[id];c.daily[date][id]={attempts:Math.max(n(x?.attempts),n(y?.attempts)),correct:Math.max(n(x?.correct),n(y?.correct))};
  }
 }
 const date=review.dayKey(now),bases=[ca.dailyBase,cb.dailyBase].filter(x=>x?.date===date);c.dailyBase={date,attempts:Math.max(0,...bases.map(x=>n(x.attempts))),correct:Math.max(0,...bases.map(x=>n(x.correct)))};
 out.today={date,attempts:c.dailyBase.attempts+Object.values(c.daily[date]||{}).reduce((s,x)=>s+n(x.attempts),0),correct:c.dailyBase.correct+Object.values(c.daily[date]||{}).reduce((s,x)=>s+n(x.correct),0)};
 out.completed={...a.completed};for(const [k,v]of Object.entries(b.completed||{}))if(v)out.completed[k]=true;
 out.completedGroups=[...new Set([...a.completedGroups,...b.completedGroups])].sort((x,y)=>x-y);
 out.dailyCompletedGroups=[...new Set([...(a.dailyCompletedGroups||[]),...(b.dailyCompletedGroups||[])])].sort((x,y)=>x-y);
 const nav=(b.navigationAt||0)>(a.navigationAt||0)?b:a;for(const k of ['selectedGroup','lastSession','groupSessions','navigationAt'])if(nav[k]!==undefined)out[k]=clone(nav[k]);
 const prefs=(b.preferencesAt||0)>(a.preferencesAt||0)?b:a;for(const k of ['voiceLang','autoPlay','preferencesAt'])if(prefs[k]!==undefined)out[k]=prefs[k];
 out.sessions={};c.sessionCopies={};
 for(const key of new Set([...Object.keys(a.sessions||{}),...Object.keys(b.sessions||{}),...Object.keys(ca.sessionCopies||{}),...Object.keys(cb.sessionCopies||{})])){
  const copies=c.sessionCopies[key]={...clone(ca.sessionCopies[key]||{})};
  for(const [id,s]of Object.entries(cb.sessionCopies[key]||{}))copies[id]=chooseSession(copies[id],s);
  for(const s of [a.sessions?.[key],b.sessions?.[key]].filter(Boolean)){const id=s.deviceId||s.runId||'legacy';copies[id]=chooseSession(copies[id],s);}
  out.sessions[key]=Object.values(copies).reduce(chooseSession,null);
 }
 out.reviewDrafts={...a.reviewDrafts,...b.reviewDrafts};
 const allItems=groups.flatMap(g=>g.words.map(w=>({...w,groupId:g.id})));
 review.ensureDay(a,allItems,now);review.ensureDay(b,allItems,now);
 const days=[a.reviewDay,b.reviewDay].filter(d=>d?.date===date),primary=remote?.reviewDay?.date===date?a.reviewDay:days[0];
 out.reviewDay={version:1,completionRule:2,date,oldKeys:[...(primary?.oldKeys||[])].slice(0,100),oldDone:[],newDone:{},cloudLocked:!server};
 if(server&&!remote?.reviewDay?.cloudLocked)for(const d of days)for(const k of d.oldKeys)if(out.reviewDay.oldKeys.length<100&&!out.reviewDay.oldKeys.includes(k))out.reviewDay.oldKeys.push(k);
 for(const d of days){for(const k of d.oldDone||[])if(out.reviewDay.oldKeys.includes(k)&&!out.reviewDay.oldDone.includes(k))out.reviewDay.oldDone.push(k);for(const [k,v]of Object.entries(d.newDone||{}))out.reviewDay.newDone[k]=Math.max(v,out.reviewDay.newDone[k]||0);}
 for(const [k,r]of Object.entries(out.records)){
  if(review.isNew(r,date)&&r.lastReviewAt>=r.lastLearningAt&&r.lastReviewAt>0)out.reviewDay.newDone[k]=r.attempts;
  if(review.isNew(r,date)&&r.flagged&&r.lastLearningAt>r.lastReviewAt)delete out.reviewDay.newDone[k];
  if(r.lastLearningAt>r.lastReviewAt&&r.manualPending){out.reviewDay.oldDone=out.reviewDay.oldDone.filter(x=>x!==k);delete out.reviewDay.newDone[k];}
  if(!review.isNew(r,date)){
   const invalidated=r.flagged&&r.lastLearningAt>r.lastReviewAt;
   const testedToday=r.lastReviewAt>0&&review.dayKey(r.lastReviewAt)===date;
   if(invalidated||testedToday&&!r.lastReviewCorrect||!testedToday&&r.flagged)out.reviewDay.oldDone=out.reviewDay.oldDone.filter(x=>x!==k);
   else if(testedToday&&r.lastReviewCorrect&&out.reviewDay.oldKeys.includes(k)&&!out.reviewDay.oldDone.includes(k))out.reviewDay.oldDone.push(k);
  }
 }
 if(server){review.schedule(out,groups.flatMap(g=>g.words.map(w=>({...w,groupId:g.id}))),now);out.reviewDay.cloudLocked=true;}
 if(owner)out.cloudOwner=owner;else out.cloudOwner=a.cloudOwner||b.cloudOwner;
 return out;
}
function identity(session,key,savedAt){return {runId:session.runId||'legacy-'+hash(key+JSON.stringify(session.queue)),runStartedAt:session.runStartedAt||Date.parse(savedAt)||1};}
return {upgrade,write,merge,chooseSession,identity};
});
