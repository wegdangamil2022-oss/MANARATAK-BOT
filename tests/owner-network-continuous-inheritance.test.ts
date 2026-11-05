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
import {Phase4CommunityService} from '../src/phase4-community.js';
import {defaultCommunityConfig,emptyCommunityState} from '../src/phase4-community-model.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456';
const SOURCE='-100123',A='-100124',B='-100125';
const cb=(i:number,data:string,user=100,inGroup=false)=>({
 update_id:i,callback_query:{id:'network-follow-'+i,from:{id:user,is_bot:false},data,
 message:{message_id:42,from:{id:999,is_bot:true},chat:{id:inGroup?-100123:user,
 type:inGroup?'supergroup':'private'}}}
});
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
function button(result:Handled,part:string):string{
 assert.equal(result.status,'APPLIED',result.reason);
 assert.equal(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup),true);
 const found=result.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.includes(part));
 assert.ok(found,'Missing '+part+' in '+result.plan?.text);
 assert.ok(Buffer.byteLength(found.callback_data,'utf8')<=64);
 return found.callback_data;
}
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'network-inheritance-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'network-inheritance-test',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('INHERITANCE_MUST_NEVER_CONTACT_TELEGRAM');}});
 const protection=new GroupProtectionPolicyService(store,policy,()=>now);
 const community=new Phase4CommunityService(store,policy,()=>now);
 for(const chat of [SOURCE,A,B])await policy.approveChat(OWNER,chat,['navigation','moderation']);
 await store.transaction(s=>{
  s.groupNetworks=[{id:NET,name:'شبكة المنح',revision:1,createdBy:OWNER,updatedAt:now,
   members:s.chats.filter(c=>[SOURCE,A,B].includes(c.id))
    .map(c=>({chatId:c.id,version:c.version}))}];
 });
 const savePolicy=async(chat:string,revision:number,phrase='phase-'+revision)=>{
  const snapshot=await store.snapshot(),current=snapshot.chats.find(c=>c.id===chat)!;
  return protection.save(OWNER,{chatId:chat,revision,mode:'MONITOR',
   rules:[{id:'r1',kind:'PHRASE',value:phrase,enabled:true,action:'REVIEW'}],
   allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},current.version,revision-1);
 };
 const sourceGreeting=async()=>{
  await store.transaction(s=>{
   s.phase4Community=emptyCommunityState();
   const cfg=defaultCommunityConfig(SOURCE);cfg.version=1;cfg.welcome.text='مرحبا {العضو}';
   cfg.farewell.text='وداعا {العضو}';s.phase4Community.configs.push(cfg);
  });
 };
 return {store,policy,protection,community,app,savePolicy,sourceGreeting,
  advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('NETWORK-002 explicit opt-in continuously updates reviewed monitor policies ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.savePolicy(SOURCE,1)).status,'SAVED');
   const preview=await f.app().handle(cb(1,'nw:1:z:'+NET+':'+SOURCE+':0'));
   const following=button(preview,'متابعة المصدر');
   assert.equal((await f.app().handle(cb(2,following,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(3,following,100,true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(4,following))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(5,following))).status,'DENIED');
   let state=await f.store.snapshot();
   assert.equal(state.networkInheritance?.length,2);
   assert.equal(state.networkInheritance?.every(link=>link.status==='ACTIVE'&&link.kind==='POLICY'),true);
   assert.deepEqual(state.protectionPolicies?.map(x=>x.policy.chatId).sort(),[SOURCE,A,B].sort());
   assert.equal((await f.savePolicy(SOURCE,2,'updated phrase')).status,'SAVED');
   state=await f.store.snapshot();
   assert.equal(state.protectionPolicies?.find(x=>x.policy.chatId===A)!.policy.revision,2);
   assert.equal(state.protectionPolicies?.find(x=>x.policy.chatId===B)!.policy.rules[0]!.kind,'PHRASE');
   assert.equal(state.protectionPolicies?.find(x=>x.policy.chatId===B)!.policy.mode,'MONITOR');
   assert.deepEqual(state.protectionPolicies?.find(x=>x.policy.chatId===A)!.policy.allowedDomains,[]);
   assert.equal(state.networkInheritance?.every(link=>link.status==='ACTIVE'&&link.targetRevision===2),true);
  }finally{await f.close();}
 });
 test('NETWORK-002 target-specific protection edits pause rather than overwrite inheritance ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.savePolicy(SOURCE,1);
   const view=await f.app().handle(cb(10,'nw:1:z:'+NET+':'+SOURCE+':0'));
   assert.equal((await f.app().handle(cb(11,button(view,'متابعة المصدر')))).status,'APPLIED');
   assert.equal((await f.savePolicy(A,2,'local exemption')).status,'SAVED');
   await f.savePolicy(SOURCE,2,'new source value');
   const state=await f.store.snapshot();
   assert.equal(state.networkInheritance?.find(x=>x.targetChatId===A)!.status,'PAUSED');
   assert.equal(state.networkInheritance?.find(x=>x.targetChatId===B)!.status,'ACTIVE');
   assert.equal(state.protectionPolicies?.find(x=>x.policy.chatId===A)!.policy.rules[0]!.kind,'PHRASE');
   assert.equal((state.protectionPolicies?.find(x=>x.policy.chatId===A)!.policy.rules[0] as {value:string}).value,'local exemption');
   assert.equal(state.protectionPolicies?.find(x=>x.policy.chatId===B)!.policy.revision,2);
  }finally{await f.close();}
 });
 test('NETWORK-002 network revision changes fail closed for automatic propagation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.savePolicy(SOURCE,1);
   const view=await f.app().handle(cb(20,'nw:1:z:'+NET+':'+SOURCE+':0'));
   assert.equal((await f.app().handle(cb(21,button(view,'متابعة المصدر')))).status,'APPLIED');
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   await f.savePolicy(SOURCE,2);
   const s=await f.store.snapshot();
   assert.equal(s.networkInheritance?.every(x=>x.status==='PAUSED'),true);
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===A)!.policy.revision,1);
  }finally{await f.close();}
 });
 test('NETWORK-002 optional greeting inheritance follows approved source revisions but never enables sending ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.sourceGreeting();
   const view=await f.app().handle(cb(30,'nw:1:v:'+NET+':'+SOURCE+':0'));
   assert.equal((await f.app().handle(cb(31,button(view,'متابعة المصدر')))).status,'APPLIED');
   const draft=await f.community.pending(OWNER,{kind:'WELCOME_TEXT',text:'نص جديد {العضو}'},SOURCE);
   await f.community.approve(OWNER,draft.id);
   const state=await f.store.snapshot();
   for(const id of [A,B]){
    const cfg=state.phase4Community!.configs.find(c=>c.chatId===id)!;
    assert.equal(cfg.welcome.text,'نص جديد {العضو}');
    assert.equal(cfg.welcome.enabled,false);
    assert.equal(cfg.farewell.enabled,false);
    assert.equal(cfg.repliesEnabled,false);
    assert.equal(cfg.welcome.photoFileId,undefined);
    assert.equal(cfg.version,2);
   }
   assert.equal(state.networkInheritance?.every(x=>x.status==='ACTIVE'&&x.targetRevision===2),true);
  }finally{await f.close();}
 });
 test('NETWORK-002 local greeting enablement overrides the follow setting forever ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.sourceGreeting();
   const view=await f.app().handle(cb(40,'nw:1:v:'+NET+':'+SOURCE+':0'));
   assert.equal((await f.app().handle(cb(41,button(view,'متابعة المصدر')))).status,'APPLIED');
   const local=await f.community.pending(OWNER,{kind:'WELCOME_ON'},A);
   await f.community.approve(OWNER,local.id);
   const source=await f.community.pending(OWNER,{kind:'WELCOME_TEXT',text:'second value'},SOURCE);
   await f.community.approve(OWNER,source.id);
   const state=await f.store.snapshot();
   assert.equal(state.networkInheritance?.find(x=>x.targetChatId===A)!.status,'PAUSED');
   assert.equal(state.phase4Community!.configs.find(x=>x.chatId===A)!.welcome.enabled,true);
   assert.equal(state.phase4Community!.configs.find(x=>x.chatId===A)!.welcome.text,'مرحبا {العضو}');
   assert.equal(state.phase4Community!.configs.find(x=>x.chatId===B)!.welcome.text,'second value');
  }finally{await f.close();}
 });
 test('NETWORK-002 owner can pause a linked target through a reviewed one-shot action ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.savePolicy(SOURCE,1);
   const p=await f.app().handle(cb(50,'nw:1:z:'+NET+':'+SOURCE+':0'));
   assert.equal((await f.app().handle(cb(51,button(p,'متابعة المصدر')))).status,'APPLIED');
   const card=await f.app().handle(cb(52,'nw:1:d:'+NET));
   const listing=await f.app().handle(cb(53,button(card,'المتابعة')));
   const prepare=await f.app().handle(cb(54,button(listing,A)));
   const confirm=button(prepare,'تأكيد إيقاف');
   assert.equal((await f.app().handle(cb(55,confirm,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(56,confirm))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(57,confirm))).status,'DENIED');
   await f.savePolicy(SOURCE,2);
   const s=await f.store.snapshot();
   assert.equal(s.networkInheritance?.find(x=>x.targetChatId===A)!.status,'PAUSED');
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===A)!.policy.revision,1);
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===B)!.policy.revision,2);
  }finally{await f.close();}
 });
 test('NETWORK-002 corrupt inheritance metadata rejects the entire JSON/SQLite transaction ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.store.transaction(s=>{
    (s as unknown as {networkInheritance:unknown}).networkInheritance=[
     {kind:'POLICY',networkId:NET,targetChatId:A,status:'ACTIVE'}];
   }));
   assert.equal((await f.store.snapshot()).networkInheritance,undefined);
  }finally{await f.close();}
 });
}
