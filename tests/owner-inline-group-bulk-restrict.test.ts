import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {validOwnerGroupBulkRestrictRoute} from '../src/telegram-inline-group-bulk-restrict.js';

const OWNER='100',NOW=1_700_000_000_000,GROUP='-100123';
const cb=(i:number,data:string,actor=100,inGroup=false)=>({
 update_id:i,callback_query:{id:'bulk-local-'+i,from:{id:actor,is_bot:false},data,
  message:{message_id:72,from:{id:999,is_bot:true},
   chat:{id:inGroup?-100123:actor,type:inGroup?'supergroup':'private'}}}
});
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(result:Handled)=>{
 if(result.status==='APPLIED')assert.equal(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup),true);
 return result.plan?.inlineMarkup?.inline_keyboard.flat()??[];
};
const pick=(result:Handled,needle:string)=>{
 const chosen=buttons(result).find(b=>b.text.includes(needle));
 assert.ok(chosen,'Missing '+needle+' in '+result.plan?.text);
 assert.ok(Buffer.byteLength(chosen.callback_data,'utf8')<=64);
 return chosen.callback_data;
};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-bulk-restrict-'));
 let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'local-bulk',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('No Telegram calls allowed');}});
 const approve=(id:string,scopes=['navigation','assistant','moderation'])=>policy.approveChat(OWNER,id,scopes);
 const ai=async(id:string)=>policy.configureGroupAI(OWNER,id,'OWNER_MENTION');
 const monitor=async(id:string,mode:'MONITOR'|'OFF'='MONITOR')=>{
  const chat=(await store.snapshot()).chats.find(c=>c.id===id)!;
  return new GroupProtectionPolicyService(store,policy,()=>now).save(OWNER,{
   chatId:id,revision:1,mode,
   rules:[{id:'keep',kind:'WORD',value:'ads',enabled:true,action:'REVIEW'}],
   allowedDomains:['university.edu'],allowedPhrases:['scholarship'],exemptMemberIds:[]
  },chat.version,0);
 };
 return {store,policy,app,approve,ai,monitor,
  advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
test('group bulk restrictive callbacks are canonical, typed, and at most 64 bytes',()=>{
 for(const valid of ['gb:1:h','gb:1:p:a:0','gb:1:p:m:99','gb:1:v:a:0',
   'gb:1:v:m:999','gb:1:c:'+'a'.repeat(24),'gb:1:k:'+'A'.repeat(24)])
  assert.equal(validOwnerGroupBulkRestrictRoute(valid),true,valid);
 for(const bad of ['gb:2:h','gb:1:h:0','gb:1:p:a:00','gb:1:p:m:-1',
   'gb:1:v:x:0','gb:1:v:m:1000','gb:1:p:a:0\n',
   'gb:1:c:abc','gb:1:k:'+'Z'.repeat(25)])
  assert.equal(validOwnerGroupBulkRestrictRoute(bad),false,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('bulk restrictive actions appear under owner group action hub and on group card ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);
   const hub=await f.app().handle(cb(1,'gt:1:b:h'));
   assert.equal(hub.status,'APPLIED');
   assert.ok(buttons(hub).some(b=>b.callback_data==='gb:1:h'));
   const root=await f.app().handle(cb(2,'gb:1:h'));
   assert.equal(root.status,'APPLIED');
   assert.match(root.plan?.text??'',/إيقاف خدمات/);
   const list=await f.app().handle(cb(3,'mi:1:i:01:01'));
   const card=await f.app().handle(cb(4,pick(list,GROUP)));
   assert.equal(card.status,'APPLIED');
   assert.ok(buttons(card).some(b=>b.callback_data==='gb:1:h'));
  }finally{await f.close();}
 });
 test('owner disables AI across eight groups, not the ninth, after a one-shot preview ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<9;i++){
    const id='-100'+String(1000+i);
    await f.approve(id);await f.ai(id);
   }
   const page=await f.app().handle(cb(10,'gb:1:p:a:0'));
   assert.equal(page.status,'APPLIED');
   assert.match(page.plan?.text??'',/8 مجموعات/);
   assert.ok(buttons(page).some(b=>b.callback_data==='gb:1:p:a:1'));
   const preview=await f.app().handle(cb(11,pick(page,'معاينة')));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/تغيير إصدار/);
   assert.equal((await f.store.snapshot()).chats.filter(x=>x.groupAI==='OFF').length,0);
   const token=pick(preview,'تأكيد');
   assert.equal((await f.app().handle(cb(12,token,200))).status,'DENIED');
   const [x,y]=await Promise.all([f.app().handle(cb(13,token)),f.app().handle(cb(14,token))]);
   assert.deepEqual([x.status,y.status].sort(),['APPLIED','DENIED']);
   const s=await f.store.snapshot();
   assert.equal(s.chats.filter(x=>x.groupAI==='OFF').length,8);
   assert.equal(s.chats.find(x=>x.id==='-1001008')?.groupAI,'OWNER_MENTION');
   assert.equal(s.chats.filter(x=>x.groupAI==='OFF').every(x=>x.version===3),true);
   assert.equal(s.audit.filter(a=>a.reason==='GROUP_BULK_AI_DISABLED_LOCAL').length,1);
   assert.equal((await f.app().handle(cb(15,token))).status,'DENIED');
   const page2=await f.app().handle(cb(16,'gb:1:p:a:1'));
   assert.equal(page2.status,'APPLIED');
   assert.match(page2.plan?.text??'',/1 مجموعات/);
  }finally{await f.close();}
 });
 test('bulk monitor shutdown retains every rule and allowance and advances revision ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.approve('-100124');
   assert.equal((await f.monitor(GROUP)).status,'SAVED');
   assert.equal((await f.monitor('-100124','OFF')).status,'SAVED');
   const before=await f.store.snapshot();
   const preview=await f.app().handle(cb(20,'gb:1:v:m:0'));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/1 مجموعات/);
   const token=pick(preview,'تأكيد');
   assert.equal((await f.app().handle(cb(21,token))).status,'APPLIED');
   const s=await f.store.snapshot();
   assert.equal(s.protectionPolicies?.find(p=>p.policy.chatId===GROUP)?.policy.mode,'OFF');
   assert.equal(s.protectionPolicies?.find(p=>p.policy.chatId===GROUP)?.policy.revision,2);
   assert.equal(s.protectionPolicies?.find(p=>p.policy.chatId==='-100124')?.policy.revision,1);
   assert.deepEqual(s.protectionPolicies?.find(p=>p.policy.chatId===GROUP)?.policy.rules,
    before.protectionPolicies?.find(p=>p.policy.chatId===GROUP)?.policy.rules);
   assert.deepEqual(s.protectionPolicies?.find(p=>p.policy.chatId===GROUP)?.policy.allowedDomains,['university.edu']);
   assert.equal(s.chats.find(x=>x.id===GROUP)?.version,1);
   assert.equal(s.audit.filter(a=>a.reason==='GROUP_BULK_MONITOR_DISABLED_LOCAL').length,1);
  }finally{await f.close();}
 });
 test('bulk confirmation is all or nothing if a target changes after preview ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);
   await f.approve('-100124');await f.ai('-100124');
   const preview=await f.app().handle(cb(30,'gb:1:v:a:0'));
   const token=pick(preview,'تأكيد');
   await f.policy.configureGroupAI(OWNER,'-100124','STAFF_MENTION');
   assert.equal((await f.app().handle(cb(31,token))).status,'DENIED');
   const s=await f.store.snapshot();
   assert.equal(s.chats.find(c=>c.id===GROUP)?.groupAI,'OWNER_MENTION');
   assert.equal(s.chats.find(c=>c.id==='-100124')?.groupAI,'STAFF_MENTION');
   assert.equal(s.audit.filter(a=>a.reason==='GROUP_BULK_AI_DISABLED_LOCAL').length,0);
  }finally{await f.close();}
 });
 test('bulk monitor refuses stale, future-dated and duplicated policies without modifying them ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);assert.equal((await f.monitor(GROUP)).status,'SAVED');
   const preview=await f.app().handle(cb(40,'gb:1:v:m:0'));
   const token=pick(preview,'تأكيد');
   await f.store.transaction(s=>{s.protectionPolicies![0]!.updatedAt=NOW+9999;});
   assert.equal((await f.app().handle(cb(41,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(42,'gb:1:v:m:0'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.[0]?.policy.mode,'MONITOR');
  }finally{await f.close();}
 });
 test('cancelling a bulk preview revokes the persistent token and permits a fresh one ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);
   const preview=await f.app().handle(cb(50,'gb:1:v:a:0'));
   const token=pick(preview,'تأكيد'),cancel=pick(preview,'إلغاء المعاينة');
   assert.equal((await f.app().handle(cb(51,cancel,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(52,cancel))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(53,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(54,cancel))).status,'DENIED');
   assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'OWNER_MENTION');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='GROUP_BULK_PREVIEW_CANCELLED').length,1);
   const fresh=await f.app().handle(cb(55,'gb:1:v:a:0'));
   assert.equal((await f.app().handle(cb(56,pick(fresh,'تأكيد')))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('expired bulk approval and owner-dashboard disable reject changes ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);
   const preview=await f.app().handle(cb(60,'gb:1:v:a:0'));
   const token=pick(preview,'تأكيد');
   f.advance(121000);
   assert.equal((await f.app().handle(cb(61,token))).status,'DENIED');
   const next=await f.app().handle(cb(62,'gb:1:v:a:0'));
   const fresh=pick(next,'تأكيد');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app().handle(cb(63,fresh))).status,'DENIED');
   assert.equal((await f.app().handle(cb(64,'gb:1:h'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'OWNER_MENTION');
  }finally{await f.close();}
 });
 test('group, outsider, malformed and out-of-range callbacks cannot run bulk changes ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);
   assert.equal((await f.app().handle(cb(70,'gb:1:h',200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(71,'gb:1:h',100,true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(72,'gb:1:p:a:1'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(73,'gb:1:v:a:1'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(74,'gb:1:v:a:00'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(75,'gb:1:v:m:0'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'OWNER_MENTION');
  }finally{await f.close();}
 });
 test('restored duplicate approval invalidates all pending bulk restrictions ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);
   const preview=await f.app().handle(cb(80,'gb:1:v:a:0'));
   const token=pick(preview,'تأكيد');
   await f.store.transaction(s=>{s.chats.push({...s.chats[0]!});});
   assert.equal((await f.app().handle(cb(81,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(82,'gb:1:v:a:0'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'OWNER_MENTION');
  }finally{await f.close();}
 });
}

test('bulk group restrict history grammar accepts only canonical bounded actions',()=>{
 for(const valid of ['gb:1:r:p:0','gb:1:r:p:999','gb:1:r:v:'+'A'.repeat(24)])
  assert.equal(validOwnerGroupBulkRestrictRoute(valid),true,valid);
 for(const bad of ['gb:1:r:p:00','gb:1:r:p:1000','gb:1:r:v:tiny',
   'gb:1:r:v:'+'a'.repeat(25),'gb:1:r:p:0\n'])
  assert.equal(validOwnerGroupBulkRestrictRoute(bad),false,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('owner can inspect verified bulk restriction audit, without actionable permissions ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);assert.equal((await f.monitor(GROUP)).status,'SAVED');
   const ai=await f.app().handle(cb(90,'gb:1:v:a:0'));
   assert.equal((await f.app().handle(cb(91,pick(ai,'تأكيد')))).status,'APPLIED');
   const state=await f.store.snapshot(),rev=state.chats.find(c=>c.id===GROUP)!.version;
   assert.equal((await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save(OWNER,{
    chatId:GROUP,revision:2,mode:'MONITOR',rules:[{id:'keep',kind:'WORD',value:'ads',enabled:true,action:'REVIEW'}],
    allowedDomains:['university.edu'],allowedPhrases:['scholarship'],exemptMemberIds:[]
   },rev,1)).status,'STALE');
   const root=await f.app().handle(cb(92,'gb:1:h'));
   assert.ok(buttons(root).some(b=>b.callback_data==='gb:1:r:p:0'));
   const history=await f.app().handle(cb(93,'gb:1:r:p:0'));
   assert.equal(history.status,'APPLIED');
   assert.match(history.plan?.text??'',/سجل الإيقاف الجماعي/);
   assert.match(history.plan?.text??'',/عملية واحدة/);
   const details=await f.app().handle(cb(94,pick(history,'🤖')));
   assert.equal(details.status,'APPLIED');
   assert.match(details.plan?.text??'',/المجموعات المستهدفة/);
   assert.match(details.plan?.text??'',new RegExp(GROUP));
   assert.equal(buttons(details).some(b=>b.text.includes('تأكيد')),false);
   assert.equal((await f.app().handle(cb(95,'gb:1:r:p:1'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(96,'gb:1:r:p:0',200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(97,'gb:1:r:p:0',100,true))).status,'DENIED');
  }finally{await f.close();}
 });
 test('bulk restriction audit rejects duplicate or forged receipts after restoration ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP);await f.ai(GROUP);
   const draft=await f.app().handle(cb(100,'gb:1:v:a:0'));
   assert.equal((await f.app().handle(cb(101,pick(draft,'تأكيد')))).status,'APPLIED');
   const first=await f.app().handle(cb(102,'gb:1:r:p:0'));
   assert.equal(buttons(first).filter(b=>b.callback_data.startsWith('gb:1:r:v:')).length,1);
   await f.store.transaction(s=>{const event=s.audit.find(a=>a.reason==='GROUP_BULK_AI_DISABLED_LOCAL')!;s.audit.push({...event});});
   const second=await f.app().handle(cb(103,'gb:1:r:p:0'));
   assert.equal(second.status,'APPLIED');
   assert.match(second.plan?.text??'',/لا توجد عمليات موثقة/);
   assert.equal(buttons(second).some(b=>b.callback_data.startsWith('gb:1:r:v:')),false);
   assert.equal((await f.store.snapshot()).chats.find(c=>c.id===GROUP)?.groupAI,'OFF');
  }finally{await f.close();}
 });
}
