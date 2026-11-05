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
import {validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';

const OWNER='100',NOW=1_700_000_000_000,NETWORK='abcdef123456';
const SOURCE='-100123',TARGET='-100124',OVERRIDE='-100125';
const cb=(i:number,data:string,actor=100,group=false)=>({
 update_id:i,callback_query:{id:'network-policy-'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:42,from:{id:999,is_bot:true},
 chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}
});
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
function click(result:Handled,needle:string):string{
 assert.equal(result.status,'APPLIED',result.reason);
 assert.equal(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup),true);
 const button=result.plan?.inlineMarkup?.inline_keyboard.flat().find(x=>x.text.includes(needle));
 assert.ok(button,'Button '+needle+' missing: '+result.plan?.text);
 assert.ok(Buffer.byteLength(button.callback_data,'utf8')<=64);
 return button.callback_data;
}
async function fixture(engine:'json'|'sqlite',targets=[TARGET,OVERRIDE]){
 const dir=await mkdtemp(join(tmpdir(),'network-policy-rollout-'));
 let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'network-policy-test',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('NETWORK_002_MUST_NOT_CALL_TELEGRAM');}});
 const protection=new GroupProtectionPolicyService(store,policy,()=>now);
 for(const id of [SOURCE,...targets])await policy.approveChat(OWNER,id,['navigation','moderation']);
 await store.transaction(s=>{
  s.groupNetworks??=[];
  s.groupNetworks.push({id:NETWORK,name:'شبكة المنح',revision:1,createdBy:OWNER,
   updatedAt:now,members:s.chats.filter(c=>[SOURCE,...targets].includes(c.id))
    .map(c=>({chatId:c.id,version:c.version}))});
 });
 const save=async(id:string,opts:{allowed?:boolean;mode?:'OFF'|'MONITOR';revision?:number}={})=>{
  const s=await store.snapshot(),chat=s.chats.find(c=>c.id===id)!;
  const revision=opts.revision??1;
  const result=await protection.save(OWNER,{
   chatId:id,revision,mode:opts.mode??'MONITOR',
   rules:[{id:'review_links',kind:'LINK',hosts:'*',enabled:true,action:'REVIEW'}],
   allowedDomains:opts.allowed?['example.org']:[],
   allowedPhrases:opts.allowed?['trusted student']:[],
   exemptMemberIds:opts.allowed?['999']:[]
  },chat.version,revision-1);
  assert.equal(result.status,'SAVED');
 };
 return {store,policy,app,save,advance:(ms:number)=>{now+=ms;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('NETWORK-002 callbacks are canonical and bounded',()=>{
 for(const key of ['nw:1:y:'+NETWORK+':0','nw:1:y:'+NETWORK+':999',
  'nw:1:z:'+NETWORK+':'+SOURCE+':0'])assert.equal(validOwnerNetworkRoute(key),true,key);
 for(const key of ['nw:1:y:'+NETWORK+':00','nw:1:y:'+NETWORK+':1000',
  'nw:1:z:'+NETWORK+':'+SOURCE+':-1','nw:1:z:'+NETWORK+':123:0',
  'nw:1:y:ABCDEF123456:0','nw:1:z:'+NETWORK+':'+SOURCE+':0\n',
  'nw:1:z:'+NETWORK+':'+SOURCE+':0'+('X'.repeat(70))])
  assert.equal(validOwnerNetworkRoute(key),false,key);
});
for(const engine of ['json','sqlite'] as const){
 test('NETWORK-002 copies only new local monitor policies; skips per-group overrides and secrets ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.save(SOURCE,{allowed:true});await f.save(OVERRIDE,{mode:'OFF'});
   const card=await f.app().handle(cb(1,'nw:1:d:'+NETWORK));
   const sourcePage=await f.app().handle(cb(2,click(card,'سياسات الشبكة')));
   assert.match(sourcePage.plan?.text??'',/المصدر/);
   const preview=await f.app().handle(cb(3,click(sourcePage,SOURCE)));
   assert.match(preview.plan?.text??'',/معاينة/);
   assert.match(preview.plan?.text??'',/استثناء/);
   const before=await f.store.snapshot();
   assert.equal(before.protectionPolicies?.length,2);
   const confirm=click(preview,'تأكيد');
   assert.equal((await f.app().handle(cb(4,confirm,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(5,confirm,100,true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(6,confirm))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(7,confirm))).status,'DENIED');
   const after=await f.store.snapshot();
   assert.equal(after.protectionPolicies?.length,3);
   const copied=after.protectionPolicies!.find(r=>r.policy.chatId===TARGET)!;
   assert.ok(copied);
   assert.equal(copied.policy.mode,'MONITOR');
   assert.deepEqual(copied.policy.rules,after.protectionPolicies!.find(r=>r.policy.chatId===SOURCE)!.policy.rules);
   assert.deepEqual(copied.policy.allowedDomains,[]);
   assert.deepEqual(copied.policy.allowedPhrases,[]);
   assert.deepEqual(copied.policy.exemptMemberIds,[]);
   assert.equal(after.protectionPolicies!.find(r=>r.policy.chatId===OVERRIDE)!.policy.mode,'OFF');
   assert.equal(after.audit.filter(a=>a.reason==='OWNER_NETWORK_MONITOR_POLICIES_COPIED').length,1);
  }finally{await f.close();}
 });
 test('NETWORK-002 rejects changed membership, source and authorization during preview ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.save(SOURCE);
   const preview=await f.app().handle(cb(20,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
   const token=click(preview,'تأكيد');
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal((await f.app().handle(cb(21,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length,1);
   const second=await f.app().handle(cb(22,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
   const secondToken=click(second,'تأكيد');
   await f.save(SOURCE,{revision:2});
   assert.equal((await f.app().handle(cb(23,secondToken))).status,'DENIED');
   const third=await f.app().handle(cb(24,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
   const thirdToken=click(third,'تأكيد');
   await f.policy.revokeChatAtRevision(OWNER,TARGET,1);
   assert.equal((await f.app().handle(cb(25,thirdToken))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length,1);
  }finally{await f.close();}
 });
 test('NETWORK-002 cancellation, expiry and simultaneous confirmation cannot duplicate writes ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.save(SOURCE);
   const preview=await f.app().handle(cb(30,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
   const token=click(preview,'تأكيد'),cancel=click(preview,'إلغاء');
   assert.equal((await f.app().handle(cb(31,cancel))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(32,token))).status,'DENIED');
   const second=await f.app().handle(cb(33,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
   const secondToken=click(second,'تأكيد');
   f.advance(121000);
   assert.equal((await f.app().handle(cb(34,secondToken))).status,'DENIED');
   const third=await f.app().handle(cb(35,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
   const thirdToken=click(third,'تأكيد');
   const outcomes=await Promise.all([
    f.app().handle(cb(36,thirdToken)),f.app().handle(cb(37,thirdToken))
   ]);
   assert.deepEqual(outcomes.map(v=>v.status).sort(),['APPLIED','DENIED']);
   const s=await f.store.snapshot();
   assert.equal(s.protectionPolicies?.length,3);
   assert.equal(s.audit.filter(x=>x.reason==='OWNER_NETWORK_MONITOR_POLICIES_COPIED').length,1);
  }finally{await f.close();}
 });
 test('NETWORK-002 pages batches of at most 8 destinations ('+engine+')',async()=>{
  const targets=Array.from({length:11},(_,i)=>'-100'+(9000+i));
  const f=await fixture(engine,targets);try{
   await f.save(SOURCE);
   const page0=await f.app().handle(cb(40,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
   assert.match(page0.plan?.text??'',/8 مجموعات/);
   const next=click(page0,'التالي');
   const page1=await f.app().handle(cb(41,next));
   assert.match(page1.plan?.text??'',/3 مجموعات/);
   assert.equal((await f.app().handle(cb(42,click(page1,'تأكيد')))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.length,4);
   assert.equal((await f.app().handle(cb(43,'nw:1:z:'+NETWORK+':'+SOURCE+':0'))).status,'APPLIED');
  }finally{await f.close();}
 });
  test('NETWORK-002 policy preview supports explicit group exclusions with latest-choice-only confirmation ('+engine+')',async()=>{
   const f=await fixture(engine);try{
    await f.save(SOURCE);
    const first=await f.app().handle(cb(60,'nw:1:z:'+NETWORK+':'+SOURCE+':0'));
    const obsolete=click(first,'تأكيد');
    const excluded=await f.app().handle(cb(61,click(first,'استبعاد '+TARGET)));
    assert.match(excluded.plan?.text??'',/1 مجموعات/);
    assert.match(excluded.plan?.text??'',/مستبعدة/);
    assert.equal((await f.app().handle(cb(62,obsolete))).status,'DENIED');
    const empty=await f.app().handle(cb(63,click(excluded,'استبعاد '+OVERRIDE)));
    assert.match(empty.plan?.text??'',/0 مجموعات/);
    assert.ok(!empty.plan?.inlineMarkup?.inline_keyboard.flat().some(x=>x.text.includes('تأكيد')));
    assert.equal((await f.app().handle(cb(64,click(excluded,'تأكيد')))).status,'DENIED');
    const selected=await f.app().handle(cb(65,click(empty,'تضمين '+TARGET)));
    assert.match(selected.plan?.text??'',/1 مجموعات/);
    const token=click(selected,'تأكيد');
    assert.equal((await f.app().handle(cb(66,token))).status,'APPLIED');
    assert.equal((await f.app().handle(cb(67,token))).status,'DENIED');
    const state=await f.store.snapshot();
    assert.equal(state.protectionPolicies?.length,2);
    assert.ok(state.protectionPolicies?.some(x=>x.policy.chatId===TARGET));
    assert.ok(!state.protectionPolicies?.some(x=>x.policy.chatId===OVERRIDE));
    assert.equal(state.audit.filter(x=>x.reason==='OWNER_NETWORK_MONITOR_POLICIES_COPIED').length,1);
   }finally{await f.close();}
  });

}
