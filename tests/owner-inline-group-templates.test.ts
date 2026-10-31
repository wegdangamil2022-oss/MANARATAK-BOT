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
import {validGroupPolicyStudioRoute} from '../src/telegram-inline-group-templates.js';

const NOW=1_700_000_000_000, OWNER='100',SOURCE='-100123',TARGET='-100124';
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const cb=(i:number,data:string,actor=100,group=false)=>({
 update_id:i,callback_query:{id:'template_'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:71,from:{id:999,is_bot:true},
 chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}
});
const buttons=(r:Handled)=>{
 if(r.status==='APPLIED')assert.equal(isValidTelegramInlineKeyboard(r.plan?.inlineMarkup),true);
 return r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
};
const click=(r:Handled,needle:string)=>{
 const item=buttons(r).find(b=>b.text.includes(needle));
 assert.ok(item,'missing callback button '+needle+' in '+r.plan?.text);
 assert.ok(Buffer.byteLength(item.callback_data)<=64);
 return item.callback_data;
};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-templates-'));
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 let now=NOW;
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'template-test',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('Must not call Telegram network');}});
 const approve=(id:string,scopes=['navigation','moderation'])=>policy.approveChat(OWNER,id,scopes);
 const save=async (id:string,options:{mode?:'MONITOR'|'OFF';rule?:boolean;allow?:boolean}={})=>{
  const s=await store.snapshot(),chat=s.chats.find(x=>x.id===id)!;
  return new GroupProtectionPolicyService(store,policy,()=>now).save(OWNER,{
   chatId:id,revision:1,mode:options.mode??'MONITOR',
   rules:options.rule===false?[]:[{id:'source_link',kind:'LINK',hosts:'*',enabled:true,action:'WARN'}],
   allowedDomains:options.allow?['example.org']:[],
   allowedPhrases:options.allow?['trusted student']:[],
   exemptMemberIds:options.allow?['999']:[]
  },chat.version,0);
 };
 return {store,policy,app,approve,save,
  advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
test('template and group-copy routes reject noncanonical and oversized callbacks',()=>{
 for(const valid of ['gt:1:h','gt:1:p:l:0','gt:1:p:e:9','gt:1:v:l:-100123:1',
  'gt:1:s:0','gt:1:d:-100123:0','gt:1:x:-100123:-100124',
  'gt:1:c:'+'A'.repeat(24)]){
  assert.equal(validGroupPolicyStudioRoute(valid),true,valid);
 }
 for(const bad of ['gt:1:p:l:00','gt:1:p:x:0','gt:1:v:l:-100123:0',
  'gt:1:v:l:100123:1','gt:1:d:-100123:00','gt:1:s:-1',
  'gt:1:x:-100123:-100123:extra','gt:1:c:abc','gt:1:h\n',
  'gt:1:h:'+'z'.repeat(100),'gt:2:h']){
  assert.equal(validGroupPolicyStudioRoute(bad),false,bad);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('owner can apply empty local monitoring template with a preview and one-shot confirmation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const home=await f.app().handle(cb(1,'mi:1:i:01:06'));
   assert.equal(home.status,'APPLIED');
   assert.match(home.plan?.text??'',/قوالب إعدادات المجموعات/);
   const list=await f.app().handle(cb(2,click(home,'القالب الدراسي')));
   assert.match(list.plan?.text??'',/اختيار مجموعة/);
   const preview=await f.app().handle(cb(3,click(list,TARGET)));
   assert.match(preview.plan?.text??'',/معاينة/);
   assert.match(preview.plan?.text??'',/مراقبة فقط/);
   assert.equal((await f.store.snapshot()).protectionPolicies?.length??0,0);
   const token=click(preview,'تأكيد');
   const rejected=await f.app().handle(cb(4,token,200));
   assert.equal(rejected.status,'DENIED');
   const applied=await f.app().handle(cb(5,token));
   assert.equal(applied.status,'APPLIED');
   assert.match(applied.plan?.text??'',/حُفظ.*محلي/);
   const state=await f.store.snapshot();
   assert.equal(state.protectionPolicies?.length,1);
   assert.equal(state.protectionPolicies?.[0]?.policy.chatId,TARGET);
   assert.equal(state.protectionPolicies?.[0]?.policy.mode,'MONITOR');
   assert.deepEqual(state.protectionPolicies?.[0]?.policy.rules,[]);
   assert.deepEqual(state.protectionPolicies?.[0]?.policy.exemptMemberIds,[]);
   assert.equal(state.audit.filter(a=>a.reason==='GROUP_TEMPLATE_MONITOR_SAVED').length,1);
   assert.equal((await f.app().handle(cb(6,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length,1);
  }finally{await f.close();}
 });
 test('owner can choose a link review template and cannot overwrite an existing policy ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const home=await f.app().handle(cb(10,'mi:1:i:01:06'));
   const list=await f.app().handle(cb(11,click(home,'مراجعة الروابط')));
   const preview=await f.app().handle(cb(12,click(list,TARGET)));
   assert.match(preview.plan?.text??'',/الروابط/);
   assert.match(preview.plan?.text??'',/اختبار عينة ثابتة: تطابق/);
   assert.match(preview.plan?.text??'',/دون تنفيذ/);
   const token=click(preview,'تأكيد');
   const applied=await f.app().handle(cb(13,token));
   assert.equal(applied.status,'APPLIED');
   const state=await f.store.snapshot(),saved=state.protectionPolicies?.[0]?.policy;
   assert.equal(saved?.rules.length,1);
   assert.equal(saved?.rules[0]?.kind,'LINK');
   assert.equal(saved?.rules[0]?.action,'REVIEW');
   assert.equal(saved?.mode,'MONITOR');
   const repeat=await f.app().handle(cb(14,'gt:1:v:l:'+TARGET+':'+state.chats[0]!.version));
   assert.equal(repeat.status,'DENIED');
  }finally{await f.close();}
 });
 test('copy policy from source to target, excluding allowances and exempt members ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(SOURCE);await f.approve(TARGET);
   assert.equal((await f.save(SOURCE,{allow:true})).status,'SAVED');
   const srcBefore=(await f.store.snapshot()).protectionPolicies![0]!.policy;
   const sources=await f.app().handle(cb(20,'mi:1:i:01:07'));
   assert.equal(sources.status,'APPLIED');
   assert.match(sources.plan?.text??'',/نسخ ومقارنة/);
   const targets=await f.app().handle(cb(21,click(sources,SOURCE)));
   assert.match(targets.plan?.text??'',/المجموعة الهدف/);
   const preview=await f.app().handle(cb(22,click(targets,TARGET)));
   assert.match(preview.plan?.text??'',/مقارنة/);
   assert.match(preview.plan?.text??'',/الاستثناءات.*لن تُنسخ/);
   assert.equal((await f.store.snapshot()).protectionPolicies?.length,1);
   const token=click(preview,'تأكيد النسخ');
   const done=await f.app().handle(cb(23,token));
   assert.equal(done.status,'APPLIED');
   const state=await f.store.snapshot(),rows=state.protectionPolicies!;
   assert.equal(rows.length,2);
   const target=rows.find(x=>x.policy.chatId===TARGET)!.policy;
   assert.deepEqual(target.rules,srcBefore.rules);
   assert.deepEqual(target.allowedDomains,[]);
   assert.deepEqual(target.allowedPhrases,[]);
   assert.deepEqual(target.exemptMemberIds,[]);
   assert.equal(target.mode,'MONITOR');
   assert.equal(target.revision,1);
   assert.deepEqual(rows.find(x=>x.policy.chatId===SOURCE)!.policy,srcBefore);
   assert.equal(state.audit.filter(a=>a.reason==='GROUP_TEMPLATE_COPY_MONITOR_SAVED').length,1);
   assert.equal((await f.app().handle(cb(24,token))).status,'DENIED');
  }finally{await f.close();}
 });
 test('copy cannot overwrite target, cannot use stale source, and cannot replay expired token ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(SOURCE);await f.approve(TARGET);
   await f.save(SOURCE);
   const preview=await f.app().handle(cb(30,'gt:1:x:'+SOURCE+':'+TARGET));
   const token=click(preview,'تأكيد النسخ');
   await f.policy.approveChat(OWNER,SOURCE,['navigation','moderation']);
   assert.equal((await f.app().handle(cb(31,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length,1);
   const old=await f.app().handle(cb(32,'gt:1:x:'+SOURCE+':'+TARGET));
   assert.equal(old.status,'DENIED');
   const state=await f.store.snapshot();
   const fresh=await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save(OWNER,{
     chatId:SOURCE,revision:2,mode:'MONITOR',rules:[],
     allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },state.chats.find(c=>c.id===SOURCE)!.version,1);
   assert.equal(fresh.status,'STALE');
  }finally{await f.close();}
 });
 test('target revision changes and confirmation expires fail closed ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const preview=await f.app().handle(cb(40,'gt:1:v:e:'+TARGET+':1'));
   const token=click(preview,'تأكيد');
   await f.policy.approveChat(OWNER,TARGET,['navigation','moderation']);
   assert.equal((await f.app().handle(cb(41,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length??0,0);
   const fresh=await f.app().handle(cb(42,'gt:1:v:e:'+TARGET+':2'));
   const next=click(fresh,'تأكيد');
   f.advance(121_000);
   assert.equal((await f.app().handle(cb(43,next))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length??0,0);
  }finally{await f.close();}
 });
 test('reject cross-scope, outsiders, group callbacks, forged selector and absent group ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   assert.equal((await f.app().handle(cb(50,'mi:1:i:01:06',200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(51,'mi:1:i:01:06',100,true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(52,'gt:1:v:e:-100777:1'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(53,'gt:1:x:'+SOURCE+':'+TARGET))).status,'DENIED');
   await f.approve(SOURCE,['navigation']);
   assert.equal((await f.app().handle(cb(54,'gt:1:x:'+SOURCE+':'+TARGET))).status,'DENIED');
  }finally{await f.close();}
 });
 test('group-picker pagination is bounded and buttons stay within Telegram limits ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<19;i++)await f.approve('-100'+String(1000+i));
   const first=await f.app().handle(cb(60,'gt:1:p:e:0'));
   assert.equal(buttons(first).filter(b=>b.callback_data.startsWith('gt:1:v:')).length,8);
   assert.ok(buttons(first).some(b=>b.callback_data==='gt:1:p:e:1'));
   const next=await f.app().handle(cb(61,'gt:1:p:e:1'));
   assert.equal(buttons(next).filter(b=>b.callback_data.startsWith('gt:1:v:')).length,8);
   const last=await f.app().handle(cb(62,'gt:1:p:e:2'));
   assert.equal(buttons(last).filter(b=>b.callback_data.startsWith('gt:1:v:')).length,3);
   assert.equal((await f.app().handle(cb(63,'gt:1:p:e:3'))).status,'DENIED');
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('configured destination offers read-only group policy comparison without overwrite ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(SOURCE);await f.approve(TARGET);
   assert.equal((await f.save(SOURCE,{allow:true})).status,'SAVED');
   assert.equal((await f.save(TARGET,{mode:'OFF',rule:false})).status,'SAVED');
   const before=await f.store.snapshot();
   const sources=await f.app().handle(cb(100,'mi:1:i:01:07'));
   const targetList=await f.app().handle(cb(101,click(sources,SOURCE)));
   const compareLink=click(targetList,TARGET);
   assert.equal(compareLink,'gt:1:q:'+SOURCE+':'+TARGET);
   const comparison=await f.app().handle(cb(102,compareLink));
   assert.equal(comparison.status,'APPLIED');
   assert.match(comparison.plan?.text??'',/مقارنة/);
   assert.match(comparison.plan?.text??'',/قواعد المصدر: 1/);
   assert.match(comparison.plan?.text??'',/قواعد الهدف: 0/);
   assert.match(comparison.plan?.text??'',/لا يمكن النسخ فوق سياسة موجودة/);
   assert.equal(buttons(comparison).some(b=>b.text.includes('تأكيد')),false);
   assert.equal((await f.app().handle(cb(103,compareLink,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(104,'gt:1:q:'+SOURCE+':'+SOURCE))).status,'DENIED');
   const after=await f.store.snapshot();
   assert.deepEqual(after.protectionPolicies,before.protectionPolicies);
   // Transport always records successful callback acknowledgement receipts;
   // the read-only comparison must add no actual policy-mutation audit.
   assert.deepEqual(after.audit.filter(a=>a.reason.startsWith('GROUP_TEMPLATE_')),
    before.audit.filter(a=>a.reason.startsWith('GROUP_TEMPLATE_')));
  }finally{await f.close();}
 });
 test('duplicate restored approval quarantines preview and confirmation atomically ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const preview=await f.app().handle(cb(110,'gt:1:v:l:'+TARGET+':1'));
   const token=click(preview,'تأكيد');
   await f.store.transaction(s=>{s.chats.push({...s.chats[0]!});});
   assert.equal((await f.app().handle(cb(111,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length??0,0);
   assert.equal((await f.app().handle(cb(112,'gt:1:v:l:'+TARGET+':1'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('copying an OFF template preserves OFF and does not import active enforcement ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(SOURCE);await f.approve(TARGET);
   assert.equal((await f.save(SOURCE,{mode:'OFF'})).status,'SAVED');
   const preview=await f.app().handle(cb(120,'gt:1:x:'+SOURCE+':'+TARGET));
   assert.match(preview.plan?.text??'',/متوقفة/);
   const done=await f.app().handle(cb(121,click(preview,'تأكيد')));
   assert.equal(done.status,'APPLIED');
   const dest=(await f.store.snapshot()).protectionPolicies?.find(r=>r.policy.chatId===TARGET)!;
   assert.equal(dest.policy.mode,'OFF');
   assert.equal(dest.policy.rules[0]?.action,'WARN');
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('owner settings epoch change invalidates a previously issued template confirmation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const preview=await f.app().handle(cb(130,'gt:1:v:e:'+TARGET+':1'));
   const token=click(preview,'تأكيد');
   await f.store.transaction(s=>{s.privateSettingsRevision=(s.privateSettingsRevision??0)+1;});
   assert.equal((await f.app().handle(cb(131,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length??0,0);
  }finally{await f.close();}
 });
 test('disabled owner dashboard denies template preview and confirmation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const preview=await f.app().handle(cb(140,'gt:1:v:e:'+TARGET+':1'));
   const token=click(preview,'تأكيد');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app().handle(cb(141,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(142,'mi:1:i:01:06'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length??0,0);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('racing distinct confirmations commit one policy and one mutation receipt ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const screen=await f.app().handle(cb(150,'gt:1:v:l:'+TARGET+':1'));
   const token=click(screen,'تأكيد');
   const [first,second]=await Promise.all([
    f.app().handle(cb(151,token)),f.app().handle(cb(152,token))
   ]);
   assert.deepEqual([first.status,second.status].sort(),['APPLIED','DENIED']);
   const s=await f.store.snapshot();
   assert.equal(s.protectionPolicies?.filter(x=>x.policy.chatId===TARGET).length,1);
   assert.equal(s.audit.filter(x=>x.reason==='GROUP_TEMPLATE_MONITOR_SAVED').length,1);
   assert.equal(s.callbacks.filter(x=>x.action.startsWith('group-template-confirm:')&&x.used).length,1);
  }finally{await f.close();}
 });
 test('source policy with future timestamp is unusable for copy or compare ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(SOURCE);await f.approve(TARGET);
   assert.equal((await f.save(SOURCE)).status,'SAVED');
   await f.store.transaction(s=>{s.protectionPolicies![0]!.updatedAt=NOW+120_000;});
   assert.equal((await f.app().handle(cb(160,'gt:1:x:'+SOURCE+':'+TARGET))).status,'DENIED');
   const root=await f.app().handle(cb(161,'mi:1:i:01:07'));
   assert.equal(root.status,'APPLIED');
   assert.equal(buttons(root).some(x=>x.callback_data.startsWith('gt:1:d:')),false);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('approved group card provides navigation to built-in templates and safe copy ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.approve(TARGET);
   const listing=await f.app().handle(cb(170,'mi:1:i:01:01'));
   const detail=await f.app().handle(cb(171,click(listing,TARGET)));
   assert.equal(detail.status,'APPLIED');
   assert.equal(buttons(detail).some(x=>x.callback_data==='gt:1:h'),true);
   assert.equal(buttons(detail).some(x=>x.callback_data==='gt:1:s:0'),true);
   const templates=await f.app().handle(cb(172,'gt:1:h'));
   assert.equal(templates.status,'APPLIED');
   assert.match(templates.plan?.text??'',/قوالب إعدادات/);
   const compare=await f.app().handle(cb(173,'gt:1:s:0'));
   assert.equal(compare.status,'APPLIED');
   assert.match(compare.plan?.text??'',/نسخ ومقارنة/);
   assert.equal((await f.store.snapshot()).protectionPolicies?.length??0,0);
  }finally{await f.close();}
 });
}
