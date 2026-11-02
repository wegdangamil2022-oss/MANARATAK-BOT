import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramModerationAppeals,validModerationAppealRoute} from '../src/telegram-moderation-appeals.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {protectionUIEpoch} from '../src/protection-ui-access.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
const route=(s:OwnerInlineScreen|null,p:string)=>{assert.ok(s);assert.ok(isValidTelegramInlineKeyboard(s.keyboard));const b=s.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('appeal routes reject ambiguous selectors and trailing input',()=>{for(const bad of ['ap:1:h:00','ap:1:d:0:0:abcdef0123456789','ap:1:h:0\n','ap:1:d:0:1:abcdef0123456789:extra','ap:1: :0:1:abcdef0123456789'])assert.equal(validModerationAppealRoute(bad),false);});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'appeals-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=100000;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);await policy.grant('100','200','chat.manage','-100',999999);const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now);await moderation.issueWarning('100','-100','300','warning-a');
  return {store,file,policy,moderation,gateway,ui:new TelegramModerationAppeals(store,policy,()=>now),time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};}
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
 test(engine+' request capacity is bounded and runtime routes remain private',async()=>{const f=await fixture();try{
  for(let i=0;i<4;i++){if(i)await f.moderation.issueWarning('100','-100','300','warning-'+i);const own=await f.ui.handle('300','ap:1:h:0');const buttons=own!.keyboard.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('ap:1:d:'));const p=await f.ui.handle('300',buttons[i?i-1:0]!.callback_data);await f.ui.handle('300',route(p,'ap:1:c:'));}
  assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('MODERATION_APPEAL_OPEN:')).length,3);
  const education=new EducationService(f.store,f.policy),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education),faq:new ApprovedAnswerService(f.store,f.policy),links:new ResourceLinkService(f.store,f.policy),moderation:f.moderation,botId:'appeal',botUsername:'ManaratakBot',clock:()=>100000,membership:async()=>{throw Error('network forbidden');}});
  const result=await app.handle({update_id:1,message:{message_id:1,from:{id:300,is_bot:false},chat:{id:300,type:'private'},text:'/appeals'}});assert.equal(result.status,'APPLIED');assert.equal(result.plan!.chatId,'300');
  const group=await app.handle({update_id:2,callback_query:{id:'a',from:{id:300,is_bot:false},message:{message_id:1,from:{id:999,is_bot:true},chat:{id:-100,type:'supergroup'}},data:'ap:1:h:0'}});assert.equal(group.status,'DENIED');
 }finally{await f.close();}});
}
