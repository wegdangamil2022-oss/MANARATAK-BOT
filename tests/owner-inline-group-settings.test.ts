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
import {validOwnerGroupSettingsRoute} from '../src/telegram-inline-group-settings.js';

const OWNER='100',GROUP='-100123',NOW=1_700_000_000_000;
const cb=(update:number,data:string,actor=100,group=false)=>({
 update_id:update,callback_query:{id:'owner-settings-'+update,from:{id:actor,is_bot:false},data,
 message:{message_id:57,from:{id:999,is_bot:true},
 chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'}}}
});
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(result:Handled)=>{
 if(result.status==='APPLIED')assert.equal(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup),true);
 return result.plan?.inlineMarkup?.inline_keyboard.flat()??[];
};
const key=(result:Handled,label:string)=>{
 const b=buttons(result).find(b=>b.text.includes(label));
 assert.ok(b,'button '+label+' missing from '+result.plan?.text);
 assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64);
 return b.callback_data;
};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-group-settings-'));
 const store=new BotStore(join(dir,'data.'+engine),{engine}),policy=new Policy(store,OWNER,()=>now);
 let now=NOW;
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'settings-bot',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('No Telegram network calls allowed');}});
 const approve=(id=GROUP,scopes=['navigation','moderation','assistant'])=>policy.approveChat(OWNER,id,scopes);
 const save=async(id=GROUP,mode:'MONITOR'|'OFF'='OFF')=>{
  const state=await store.snapshot(),chat=state.chats.find(c=>c.id===id)!;
  return new GroupProtectionPolicyService(store,policy,()=>now).save(OWNER,{
   chatId:id,revision:1,mode,rules:[{id:'rule_one',kind:'WORD',value:'spam',enabled:true,action:'REVIEW'}],
   allowedDomains:['example.org'],allowedPhrases:['education'],exemptMemberIds:[]
  },chat.version,0);
 };
 return {store,policy,app,approve,save,advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
test('group settings callback route grammar rejects noncanonical, overlength and untrusted input',()=>{
 const accepted=['gs:1:h','gs:1:p:0','gs:1:p:999','gs:1:g:-100123:1:0',
  'gs:1:v:-100123:1:0:x','gs:1:v:-100123:1:0:o',
  'gs:1:v:-100123:1:0:s','gs:1:v:-100123:1:0:a',
  'gs:1:v:-100123:1:0:m','gs:1:v:-100123:1:0:f',
  'gs:1:c:'+'A'.repeat(24),'gs:1:k:'+'B'.repeat(24)];
 for(const input of accepted)assert.equal(validOwnerGroupSettingsRoute(input),true,input);
 for(const input of ['gs:1:p:00','gs:1:p:1000','gs:1:g:100123:1:0',
  'gs:1:g:-100123:0:0','gs:1:g:-100123:01:0','gs:1:g:-100123:1:01',
  'gs:1:v:-100123:1:0:z','gs:1:v:-100123:1:0:x\n',
  'gs:1:c:short','gs:1:k:'+'Z'.repeat(25),'gs:2:h',
  'gs:1:g:-100123:1:0:1'])
  assert.equal(validOwnerGroupSettingsRoute(input),false,input);
});
for(const engine of ['json','sqlite'] as const){
 test('owner group settings opens real section and pages authorized groups only ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<17;i++)await f.approve('-100'+String(1000+i),['navigation']);
   const home=await f.app().handle(cb(1,'mi:1:i:01:12'));
   assert.equal(home.status,'APPLIED');
   assert.match(home.plan?.text??'',/إعدادات قسم المجموعات/);
   const first=await f.app().handle(cb(2,'gs:1:p:0'));
   assert.equal(buttons(first).filter(b=>b.callback_data.startsWith('gs:1:g:')).length,8);
   assert.ok(buttons(first).some(b=>b.callback_data==='gs:1:p:1'));
   const p2=await f.app().handle(cb(3,'gs:1:p:2'));
   assert.equal(buttons(p2).filter(b=>b.callback_data.startsWith('gs:1:g:')).length,1);
   assert.equal((await f.app().handle(cb(4,'gs:1:p:3'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(5,'gs:1:h',200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(6,'gs:1:h',100,true))).status,'DENIED');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('GROUP_SETTINGS_')).length,0);
  }finally{await f.close();}
 });
 test('owner changes AI to STAFF_MENTION with one-shot confirmation and scope validation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();
   const card=await f.app().handle(cb(10,'gs:1:g:'+GROUP+':1:0'));
   assert.equal(card.status,'APPLIED');
   assert.match(card.plan?.text??'',/المساعد المحلي: OFF/);
   const preview=await f.app().handle(cb(11,key(card,'المشرفون')));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/معاينة/);
   assert.match(preview.plan?.text??'',/STAFF_MENTION/);
   assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'OFF');
   const confirm=key(preview,'تأكيد التعديل');
   assert.equal((await f.app().handle(cb(12,confirm,200))).status,'DENIED');
   const done=await f.app().handle(cb(13,confirm));
   assert.equal(done.status,'APPLIED');
   const updated=await f.store.snapshot();
   assert.equal(updated.chats[0]!.groupAI,'STAFF_MENTION');
   assert.equal(updated.chats[0]!.version,2);
   assert.equal(updated.audit.filter(a=>a.reason==='GROUP_SETTINGS_AI_MODE_SAVED').length,1);
   assert.equal((await f.app().handle(cb(14,confirm))).status,'DENIED');
   assert.equal((await f.app().handle(cb(15,'gs:1:g:'+GROUP+':1:0'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(16,'gs:1:g:'+GROUP+':2:0'))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('local AI mode change warns it invalidates existing monitored policy ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();assert.equal((await f.save()).status,'SAVED');
   const preview=await f.app().handle(cb(20,'gs:1:v:'+GROUP+':1:0:o'));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/سياسة الحماية.*مراجعة/);
   assert.equal((await f.app().handle(cb(21,key(preview,'تأكيد التعديل')))).status,'APPLIED');
   const s=await f.store.snapshot();
   assert.equal(s.chats[0]!.version,2);
   assert.equal(s.protectionPolicies?.[0]?.chatPolicyVersion,1);
   assert.equal(s.protectionPolicies?.[0]?.policy.mode,'OFF');
  }finally{await f.close();}
 });
 test('owner can disable AI without assistant scope but cannot grant it without scope ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(GROUP,['navigation','moderation']);
   assert.equal((await f.app().handle(cb(30,'gs:1:v:'+GROUP+':1:0:a'))).status,'DENIED');
   await f.store.transaction(s=>{s.chats[0]!.groupAI='OWNER_MENTION';});
   const preview=await f.app().handle(cb(31,'gs:1:v:'+GROUP+':1:0:x'));
   assert.equal(preview.status,'APPLIED');
   assert.equal((await f.app().handle(cb(32,key(preview,'تأكيد التعديل')))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'OFF');
  }finally{await f.close();}
 });
 test('owner enables and disables local protection monitor without altering rules and without ENFORCE ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();assert.equal((await f.save()).status,'SAVED');
   const screen=await f.app().handle(cb(40,'gs:1:g:'+GROUP+':1:0'));
   assert.equal(screen.status,'APPLIED');
   assert.match(screen.plan?.text??'',/الحماية المحلية: متوقفة/);
   const review=await f.app().handle(cb(41,key(screen,'تشغيل المراقبة')));
   assert.match(review.plan?.text??'',/MONITOR/);
   assert.match(review.plan?.text??'',/لا حذف ولا كتم/);
   assert.equal((await f.app().handle(cb(42,key(review,'تأكيد التعديل')))).status,'APPLIED');
   let s=await f.store.snapshot();
   assert.equal(s.protectionPolicies?.[0]?.policy.mode,'MONITOR');
   assert.equal(s.protectionPolicies?.[0]?.policy.revision,2);
   assert.deepEqual(s.protectionPolicies?.[0]?.policy.rules,[{id:'rule_one',kind:'WORD',value:'spam',enabled:true,action:'REVIEW'}]);
   assert.equal(s.protectionPolicies?.[0]?.policy.allowedDomains[0],'example.org');
   assert.equal(s.chats[0]!.version,1);
   assert.equal(s.audit.filter(a=>a.reason==='GROUP_SETTINGS_MONITOR_ENABLED').length,1);
   const card=await f.app().handle(cb(43,'gs:1:g:'+GROUP+':1:0'));
   const off=await f.app().handle(cb(44,key(card,'إيقاف المراقبة')));
   assert.equal((await f.app().handle(cb(45,key(off,'تأكيد التعديل')))).status,'APPLIED');
   s=await f.store.snapshot();
   assert.equal(s.protectionPolicies?.[0]?.policy.mode,'OFF');
   assert.equal(s.protectionPolicies?.[0]?.policy.revision,3);
   assert.equal(s.audit.filter(a=>a.reason==='GROUP_SETTINGS_MONITOR_DISABLED').length,1);
  }finally{await f.close();}
 });
 test('monitor mode switch is blocked on absent, stale or damaged group policy ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();
   assert.equal((await f.app().handle(cb(50,'gs:1:v:'+GROUP+':1:0:m'))).status,'DENIED');
   assert.equal((await f.save()).status,'SAVED');
   const review=await f.app().handle(cb(51,'gs:1:v:'+GROUP+':1:0:m'));
   const old=key(review,'تأكيد التعديل');
   await f.store.transaction(s=>{s.protectionPolicies![0]!.updatedAt=NOW+10000;});
   assert.equal((await f.app().handle(cb(52,old))).status,'DENIED');
   assert.equal((await f.app().handle(cb(53,'gs:1:v:'+GROUP+':1:0:m'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('cancel revokes prepared group setting and a new preview remains usable ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();
   const review=await f.app().handle(cb(60,'gs:1:v:'+GROUP+':1:0:o'));
   const token=key(review,'تأكيد التعديل'),cancel=key(review,'إلغاء المعاينة');
   assert.equal((await f.app().handle(cb(61,cancel))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(62,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(63,cancel))).status,'DENIED');
   assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'OFF');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='GROUP_SETTINGS_PREVIEW_CANCELLED').length,1);
   const newReview=await f.app().handle(cb(64,'gs:1:v:'+GROUP+':1:0:o'));
   assert.equal((await f.app().handle(cb(65,key(newReview,'تأكيد التعديل')))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('expired, duplicate, and racing confirmation references cannot double-change policy ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();
   const review=await f.app().handle(cb(70,'gs:1:v:'+GROUP+':1:0:a'));
   const token=key(review,'تأكيد التعديل');
   f.advance(121000);
   assert.equal((await f.app().handle(cb(71,token))).status,'DENIED');
   const fresh=await f.app().handle(cb(72,'gs:1:v:'+GROUP+':1:0:a'));
   const nonce=key(fresh,'تأكيد التعديل');
   const results=await Promise.all([f.app().handle(cb(73,nonce)),f.app().handle(cb(74,nonce))]);
   assert.deepEqual(results.map(x=>x.status).sort(),['APPLIED','DENIED']);
   assert.equal((await f.store.snapshot()).chats[0]!.version,2);
  }finally{await f.close();}
 });
 test('pending preview rejected if group state, owner settings, or list membership changes ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();
   let review=await f.app().handle(cb(80,'gs:1:v:'+GROUP+':1:0:o'));
   let token=key(review,'تأكيد التعديل');
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation','assistant']);
   assert.equal((await f.app().handle(cb(81,token))).status,'DENIED');
   review=await f.app().handle(cb(82,'gs:1:v:'+GROUP+':2:0:o'));
   token=key(review,'تأكيد التعديل');
   await f.store.transaction(s=>{s.privateSettingsRevision=(s.privateSettingsRevision??0)+1;});
   assert.equal((await f.app().handle(cb(83,token))).status,'DENIED');
   review=await f.app().handle(cb(84,'gs:1:v:'+GROUP+':2:0:o'));
   token=key(review,'تأكيد التعديل');
   await f.approve('-1000999',['navigation']);
   assert.equal((await f.app().handle(cb(85,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).chats.find(c=>c.id===GROUP)?.groupAI,'OFF');
  }finally{await f.close();}
 });
 test('dashboard disable and ambiguous restored approvals fail closed ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve();
   const review=await f.app().handle(cb(90,'gs:1:v:'+GROUP+':1:0:a'));
   const nonce=key(review,'تأكيد التعديل');
   await f.store.transaction(s=>{s.chats.push({...s.chats[0]!});});
   assert.equal((await f.app().handle(cb(91,nonce))).status,'DENIED');
   assert.equal((await f.app().handle(cb(92,'gs:1:g:'+GROUP+':1:0'))).status,'DENIED');
   await f.store.transaction(s=>{s.chats.pop();s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app().handle(cb(93,'mi:1:i:01:12'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(94,nonce))).status,'DENIED');
  }finally{await f.close();}
 });
}
