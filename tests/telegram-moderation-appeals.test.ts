import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramModerationAppeals,validModerationAppealRoute,cancelAppealWarningPreview} from '../src/telegram-moderation-appeals.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {protectionUIEpoch} from '../src/protection-ui-access.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramGroupRules} from '../src/telegram-group-rules.js';
const route=(s:OwnerInlineScreen|null,p:string)=>{assert.ok(s);assert.ok(isValidTelegramInlineKeyboard(s.keyboard));const b=s.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('appeal routes reject ambiguous selectors and trailing input',()=>{for(const bad of ['ap:1:h:00','ap:1:d:0:0:abcdef0123456789','ap:1:h:0\n','ap:1:d:0:1:abcdef0123456789:extra','ap:1: :0:1:abcdef0123456789'])assert.equal(validModerationAppealRoute(bad),false);});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'appeals-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=100000;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);await policy.grant('100','200','chat.manage','-100',999999);const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now);await moderation.issueWarning('100','-100','300','warning-a');
  return {store,file,policy,moderation,gateway,ui:new TelegramModerationAppeals(store,policy,()=>now),time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' law explanations are private, source bound and keep the historical paragraph for warnings and mutes',async()=>{
  for(const kind of ['WARNING','MUTE'] as const){const f=await fixture();try{
   const rules=new TelegramGroupRules(f.store,f.policy,()=>100000),p=await rules.preview('100','/setrules -100\nاحترام <الأعضاء>');await rules.handle('100',route(p,'rl:1:c:'));
   if(kind==='WARNING')await f.moderation.issueWarning('100','-100','300','law_v1_p1_m42');else await f.moderation.addManualReason('100','-100','300','law_v1_p1_m42','MUTE',undefined,300);
   const home=await f.ui.handle('300','ap:1:h:0'),choice=home!.keyboard.inline_keyboard.flat().find(b=>b.text.includes(kind==='WARNING'?'تحذير':'كتم'))!;
   const detail=await f.ui.handle('300',choice.callback_data),explain=route(detail,'ap:1:q:');assert.equal(await f.ui.handle('301',explain),null);
   const before=await f.store.snapshot(),text=await f.ui.handle('300',explain);assert.ok(text);assert.match(text.text,/احترام &lt;الأعضاء&gt;/u);assert.match(text.text,/الإصدار 1/u);assert.match(text.text,/42/u);assert.deepEqual(await f.store.snapshot(),before);assert.ok(await f.ui.handle('300',route(text,'ap:1:d:')));
   const education=new EducationService(f.store,f.policy),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education),faq:new ApprovedAnswerService(f.store,f.policy),links:new ResourceLinkService(f.store,f.policy),moderation:f.moderation,botId:'explain',botUsername:'ManaratakBot',clock:()=>100000,membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
   const tap=(id:number,group:boolean)=>app.handle({update_id:id,callback_query:{id:'explain-'+id,from:{id:300,is_bot:false},data:explain,message:{message_id:2,from:{id:999,is_bot:true},chat:group?{id:-100,type:'supergroup'}:{id:300,type:'private'}}}});
   assert.equal((await tap(1,true)).status,'DENIED');const privateView=await tap(2,false);assert.equal(privateView.status,'APPLIED');assert.equal(privateView.plan?.chatId,'300');assert.match(privateView.plan!.text,/احترام &lt;الأعضاء&gt;/u);
   assert.equal((await f.store.snapshot()).audit.some(a=>a.reason.startsWith('MODERATION_APPEAL_OPEN:')),false);
   await f.ui.handle('300',route(detail,'ap:1:c:'));const review=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));assert.match(review!.text,/احترام &lt;الأعضاء&gt;/u);
   const journal=await f.ui.handle('300','ap:1:j:0'),entry=await f.ui.handle('300',route(journal,'ap:1:v:'));assert.match(entry!.text,/احترام &lt;الأعضاء&gt;/u);
   const currentHome=await f.ui.handle('300','ap:1:h:0'),currentDetail=await f.ui.handle('300',currentHome!.keyboard.inline_keyboard.flat().find(b=>b.text.includes(kind==='WARNING'?'تحذير':'كتم'))!.callback_data),currentExplanation=route(currentDetail,'ap:1:q:');assert.ok(await f.ui.handle('300',currentExplanation));
   const next=await rules.preview('100','/setrules -100\nقانون مختلف');await rules.handle('100',route(next,'rl:1:c:'));assert.equal(await f.ui.handle('300',currentExplanation),null);
   const refreshed=await f.ui.handle('300','ap:1:h:0'),again=await f.ui.handle('300',refreshed!.keyboard.inline_keyboard.flat().find(b=>b.text.includes(kind==='WARNING'?'تحذير':'كتم'))!.callback_data),old=await f.ui.handle('300',route(again,'ap:1:q:'));assert.match(old!.text,/احترام &lt;الأعضاء&gt;/u);assert.doesNotMatch(old!.text,/قانون مختلف/u);
  }finally{await f.close();}}
 });
 test(engine+' ambiguous law cases never supply a trusted explanation',async()=>{const f=await fixture();try{
  const rules=new TelegramGroupRules(f.store,f.policy,()=>100000),p=await rules.preview('100','/setrules -100\nاحترام الأعضاء');await rules.handle('100',route(p,'rl:1:c:'));await f.moderation.issueWarning('100','-100','300','law_v1_p1_m42');
  const detail=await f.ui.handle('300',route(await f.ui.handle('300','ap:1:h:0'),'ap:1:d:')),q=route(detail,'ap:1:q:');
  await f.store.transaction(s=>{s.warnings.push({...s.warnings.find(w=>w.reference==='law_v1_p1_m42')!});});assert.equal(await f.ui.handle('300',q),null);
  const current=await f.ui.handle('300',route(await f.ui.handle('300','ap:1:h:0'),'ap:1:d:'));assert.equal(current!.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('ap:1:q:')),false);
 }finally{await f.close();}});
 test(engine+' private appeal requires case ownership, confirmation and independent authorized review; no sanction is lifted',async()=>{const f=await fixture();try{
  const own=await f.ui.handle('300','ap:1:h:0'),selected=route(own,'ap:1:d:');assert.equal(await f.ui.handle('301',selected),null);assert.equal((await f.ui.handle('301','ap:1:h:0'))!.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('ap:1:d:')),false);
  const preview=await f.ui.handle('300',selected);assert.match(preview!.text,/عند التأكيد/u);assert.equal((await f.store.snapshot()).audit.some(a=>a.reason.startsWith('MODERATION_APPEAL_OPEN:')),false);
  const confirm=route(preview,'ap:1:c:');await f.ui.handle('300',confirm);assert.equal(await f.ui.handle('300',confirm),null);
  const reopened=new TelegramModerationAppeals(new BotStore(f.file,{engine}),f.policy,()=>100000);let inbox=await reopened.handle('200','ap:1:r:0');const pick=route(inbox,'ap:1:p:');assert.equal(await reopened.handle('300',pick),null);
  const details=await reopened.handle('200',pick),accept=route(details,'ap:1:a:');const before=protectionUIEpoch(await f.store.snapshot(),f.policy,'200',100000);
  const accepted=await reopened.handle('200',accept);assert.ok(accepted?.access);assert.equal(accepted.access.epoch,protectionUIEpoch(await f.store.snapshot(),f.policy,'200',100000));assert.equal(await reopened.handle('200',accept),null);const s=await f.store.snapshot();assert.equal(s.warnings[0]!.active,true);assert.equal(f.gateway.calls.length,0);assert.notEqual(protectionUIEpoch(s,f.policy,'200',100000),before);
  assert.match((await f.ui.handle('300','ap:1:h:0'))!.text,/مراجعة مقبولة/u);
  await f.store.transaction(s=>{s.warnings[0]!.active=false;});const journal=await f.ui.handle('300',route(await f.ui.handle('300','ap:1:h:0'),'ap:1:j:'));const record=await f.ui.handle('300',route(journal,'ap:1:v:'));assert.match(record!.text,/مراجعة مقبولة/u);
 }finally{await f.close();}});
 test(engine+' changed case, revoked staff, private feature and chat policy cannot authorize old review decisions',async()=>{
  for(const change of ['case','grant','private','chat'] as const){const f=await fixture();try{
   const own=await f.ui.handle('300','ap:1:h:0');const p=await f.ui.handle('300',route(own,'ap:1:d:'));await f.ui.handle('300',route(p,'ap:1:c:'));
   const d=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:')),accept=route(d,'ap:1:a:');
   await f.store.transaction(s=>{if(change==='case')s.warnings[0]!.active=false;else if(change==='grant')s.grants[0]!.revoked=true;else if(change==='private')s.privateFeatures['support.use']=false;else s.chats[0]!.version++;});
   assert.equal(await f.ui.handle('200',accept),null);assert.equal((await f.store.snapshot()).audit.some(a=>a.reason==='MODERATION_APPEAL_ACCEPTED'),false);
  }finally{await f.close();}}
 });
 test(engine+' malformed appeal decision is never displayed as an accepted or open review',async()=>{
  for(const change of ['reason','decision','actor','version','time','future'] as const){const f=await fixture();try{
   const own=await f.ui.handle('300','ap:1:h:0'),preview=await f.ui.handle('300',route(own,'ap:1:d:'));await f.ui.handle('300',route(preview,'ap:1:c:'));
   await f.store.transaction(s=>{const open=s.audit.find(a=>a.reason.startsWith('MODERATION_APPEAL_OPEN:'))!;s.audit.push({actorId:change==='actor'?'':'200',updateKey:open.updateKey+':decision',decision:change==='decision'?'DENY':'ALLOW',reason:change==='reason'?'INVALID':'MODERATION_APPEAL_ACCEPTED',policyVersion:open.policyVersion+(change==='version'?1:0),at:change==='time'?open.at-1:change==='future'?open.at+1:open.at});});
   const inbox=await f.ui.handle('200','ap:1:r:0');assert.ok(inbox);assert.equal(inbox.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('ap:1:p:')),false);assert.equal((await f.store.snapshot()).warnings[0]!.active,true);
  }finally{await f.close();}}
 });
 test(engine+' accepted warning cancellation requires confirmation and navigation revokes the old button',async()=>{const f=await fixture();try{
  const own=await f.ui.handle('300','ap:1:h:0'),request=await f.ui.handle('300',route(own,'ap:1:d:'));await f.ui.handle('300',route(request,'ap:1:c:'));
  let detail=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));await f.ui.handle('200',route(detail,'ap:1:a:'));
  detail=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));let preview=await f.ui.handle('200',route(detail,'ap:1:u:'));const stale=route(preview,'ap:1:z:');
  assert.equal((await f.store.snapshot()).warnings[0]!.active,true);assert.equal(await f.ui.handle('100',stale),null);await cancelAppealWarningPreview(f.store,'200');assert.equal(await f.ui.handle('200',stale),null);
  detail=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));preview=await f.ui.handle('200',route(detail,'ap:1:u:'));const confirm=route(preview,'ap:1:z:');assert.ok(await f.ui.handle('200',confirm));assert.equal(await f.ui.handle('200',confirm),null);
  const state=await f.store.snapshot();assert.equal(state.warnings[0]!.active,false);assert.equal(state.audit.filter(a=>a.reason==='MODERATION_APPEAL_WARNING_REVOKED').length,1);assert.equal(f.gateway.calls.length,0);
 }finally{await f.close();}});
 test(engine+' cancellation rechecks expiry, warning, manager and group authority',async()=>{
  for(const change of ['expiry','warning','grant','scope','duplicate','token','decision'] as const){const f=await fixture();try{
   const own=await f.ui.handle('300','ap:1:h:0'),request=await f.ui.handle('300',route(own,'ap:1:d:'));await f.ui.handle('300',route(request,'ap:1:c:'));
   let detail=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));await f.ui.handle('200',route(detail,'ap:1:a:'));detail=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));
   const confirm=route(await f.ui.handle('200',route(detail,'ap:1:u:')),'ap:1:z:');
   if(change==='expiry')f.time(220000);else await f.store.transaction(s=>{if(change==='warning')s.warnings[0]!.reference='changed';else if(change==='grant')s.grants[0]!.revoked=true;else if(change==='scope')s.chats[0]!.version++;else if(change==='duplicate')s.warnings.push({...s.warnings[0]!});else if(change==='decision')s.audit.find(a=>a.reason==='MODERATION_APPEAL_ACCEPTED')!.actorId='100';else s.callbacks.find(c=>c.ref.startsWith('moderation:appeal-warning:'))!.expiresAt=NaN;});
   assert.equal(await f.ui.handle('200',confirm),null);const state=await f.store.snapshot();assert.equal(state.warnings[0]!.active,true);assert.equal(state.audit.some(a=>a.reason==='MODERATION_APPEAL_WARNING_REVOKED'),false);
  }finally{await f.close();}}
 });
 test(engine+' real private callback navigation cancels the pending cancellation preview',async()=>{const f=await fixture();try{
  const own=await f.ui.handle('300','ap:1:h:0'),request=await f.ui.handle('300',route(own,'ap:1:d:'));await f.ui.handle('300',route(request,'ap:1:c:'));
  let detail=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));await f.ui.handle('200',route(detail,'ap:1:a:'));detail=await f.ui.handle('200',route(await f.ui.handle('200','ap:1:r:0'),'ap:1:p:'));
  const education=new EducationService(f.store,f.policy),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education),faq:new ApprovedAnswerService(f.store,f.policy),links:new ResourceLinkService(f.store,f.policy),moderation:f.moderation,botId:'appeal',botUsername:'ManaratakBot',clock:()=>100000,membership:async()=>{throw Error('network forbidden');}});
  const tap=(id:number,data:string,group=false)=>app.handle({update_id:id,callback_query:{id:'appeal-'+id,from:{id:200,is_bot:false},message:{message_id:2,from:{id:999,is_bot:true},chat:group?{id:-100,type:'supergroup'}:{id:200,type:'private'}},data}});
  const preview=await tap(1,route(detail,'ap:1:u:'));assert.equal(preview.status,'APPLIED');const confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('ap:1:z:'))!.callback_data;
  assert.equal((await tap(2,confirm,true)).status,'DENIED');assert.equal((await tap(3,'ap:1:r:0')).status,'APPLIED');assert.equal((await tap(4,confirm)).status,'DENIED');assert.equal((await f.store.snapshot()).warnings[0]!.active,true);
 }finally{await f.close();}});
 test(engine+' request capacity is bounded and runtime routes remain private',async()=>{const f=await fixture();try{
  for(let i=0;i<4;i++){if(i)await f.moderation.issueWarning('100','-100','300','warning-'+i);const own=await f.ui.handle('300','ap:1:h:0');const buttons=own!.keyboard.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('ap:1:d:'));const p=await f.ui.handle('300',buttons[i?i-1:0]!.callback_data);await f.ui.handle('300',route(p,'ap:1:c:'));}
  assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('MODERATION_APPEAL_OPEN:')).length,3);
  const education=new EducationService(f.store,f.policy),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education),faq:new ApprovedAnswerService(f.store,f.policy),links:new ResourceLinkService(f.store,f.policy),moderation:f.moderation,botId:'appeal',botUsername:'ManaratakBot',clock:()=>100000,membership:async()=>{throw Error('network forbidden');}});
  const result=await app.handle({update_id:1,message:{message_id:1,from:{id:300,is_bot:false},chat:{id:300,type:'private'},text:'/appeals'}});assert.equal(result.status,'APPLIED');assert.equal(result.plan!.chatId,'300');
  const group=await app.handle({update_id:2,callback_query:{id:'a',from:{id:300,is_bot:false},message:{message_id:1,from:{id:999,is_bot:true},chat:{id:-100,type:'supergroup'}},data:'ap:1:h:0'}});assert.equal(group.status,'DENIED');
 }finally{await f.close();}});
}
