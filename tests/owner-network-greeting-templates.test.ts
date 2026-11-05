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
import {defaultCommunityConfig,emptyCommunityState,validCommunityConfig} from '../src/phase4-community-model.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';

const OWNER='100',NOW=1_700_000_000_000,NETWORK='abcdef123456';
const SOURCE='-100123',TARGET='-100124',OVERRIDE='-100125';
const cb=(i:number,data:string,actor=100,inGroup=false)=>({
 update_id:i,callback_query:{id:'network-greeting-'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:42,from:{id:999,is_bot:true},
 chat:{id:inGroup?-100123:actor,type:inGroup?'supergroup':'private'}}}
});
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
function click(result:Handled,needle:string):string{
 assert.equal(result.status,'APPLIED',result.reason);
 assert.equal(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup),true);
 const b=result.plan?.inlineMarkup?.inline_keyboard.flat().find(x=>x.text.includes(needle));
 assert.ok(b,'Missing '+needle+' in '+result.plan?.text);
 assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64);
 return b.callback_data;
}
async function fixture(engine:'json'|'sqlite',targets=[TARGET,OVERRIDE]){
 const dir=await mkdtemp(join(tmpdir(),'network-greeting-'));
 let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'network-greeting-test',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('NETWORK_GREETING_MUST_NOT_CALL_TELEGRAM');}});
 for(const id of [SOURCE,...targets])
  await policy.approveChat(OWNER,id,['navigation','moderation']);
 await store.transaction(s=>{
  s.groupNetworks??=[];
  s.groupNetworks.push({id:NETWORK,name:'شبكة المنح',revision:1,createdBy:OWNER,
   updatedAt:now,members:s.chats.filter(c=>[SOURCE,...targets].includes(c.id))
    .map(c=>({chatId:c.id,version:c.version}))});
  s.phase4Community=emptyCommunityState();
  const src=defaultCommunityConfig(SOURCE);
  src.version=1;
  src.welcome={enabled:true,text:'مرحبا {العضو} في {اسم_المجموعة}',
   localized:{en:'Welcome {العضو}'},
   photoFileId:'A'.repeat(40),
   buttons:[{text:'Rules',url:'https://example.org/rules'}]};
  src.welcomeByJoin={SELF:'أهلًا بانضمامك {العضو}',BATCH:'أهلًا بالجميع'};
  src.farewell={enabled:true,text:'إلى اللقاء {العضو}'};
  src.rulesUrl='https://t.me/StudyinEurope3';
  src.privateWelcomeEnabled=true;
  src.repliesEnabled=true;
  s.phase4Community.configs.push(src);
  assert.equal(validCommunityConfig(src),true);
 });
 return {store,policy,app,advance:(ms:number)=>{now+=ms;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('NETWORK-002 greeting callback routes are canonical and limited to 64 bytes',()=>{
 for(const key of ['nw:1:w:'+NETWORK+':0','nw:1:w:'+NETWORK+':999',
  'nw:1:v:'+NETWORK+':'+SOURCE+':0','nw:1:v:'+NETWORK+':'+SOURCE+':999'])
  assert.equal(validOwnerNetworkRoute(key),true,key);
 for(const key of ['nw:1:w:'+NETWORK+':00','nw:1:w:'+NETWORK+':1000',
  'nw:1:v:'+NETWORK+':'+SOURCE+':-1','nw:1:v:'+NETWORK+':123:0',
  'nw:1:v:ABCDEF123456:'+SOURCE+':0','nw:1:v:'+NETWORK+':'+SOURCE+':0\n'])
  assert.equal(validOwnerNetworkRoute(key),false,key);
});
for(const engine of ['json','sqlite'] as const){
 test('NETWORK-002 greeting templates copy only to unconfigured members, without sending or secrets ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    const exception=defaultCommunityConfig(OVERRIDE);
    exception.version=4;exception.welcome.text='نص محلي خاص بالمجموعة';
    s.phase4Community!.configs.push(exception);
   });
   const home=await f.app().handle(cb(1,'nw:1:d:'+NETWORK));
   const sources=await f.app().handle(cb(2,click(home,'قوالب الترحيب')));
   assert.match(sources.plan?.text??'',/المصدر/);
   const preview=await f.app().handle(cb(3,click(sources,SOURCE)));
   assert.match(preview.plan?.text??'',/معاينة/);
   assert.match(preview.plan?.text??'',/1 مجموعات/);
   assert.equal((await f.store.snapshot()).phase4Community!.configs.length,2);
   const token=click(preview,'تأكيد');
   assert.equal((await f.app().handle(cb(4,token,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(5,token,100,true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(6,token))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(7,token))).status,'DENIED');
   const state=await f.store.snapshot();
   assert.equal(state.phase4Community!.configs.length,3);
   const dest=state.phase4Community!.configs.find(c=>c.chatId===TARGET)!;
   const src=state.phase4Community!.configs.find(c=>c.chatId===SOURCE)!;
   assert.equal(dest.version,1);
   assert.equal(dest.welcome.enabled,false);
   assert.equal(dest.farewell.enabled,false);
   assert.equal(dest.privateWelcomeEnabled,undefined);
   assert.equal(dest.repliesEnabled,false);
   assert.deepEqual(dest.rules,[]);
   assert.equal(dest.rulesUrl,undefined);
   assert.equal(dest.welcome.photoFileId,undefined);
   assert.equal(dest.welcome.buttons,undefined);
   assert.equal(dest.welcome.text,src.welcome.text);
   assert.deepEqual(dest.welcome.localized,src.welcome.localized);
   assert.deepEqual(dest.welcomeByJoin,src.welcomeByJoin);
   assert.equal(dest.farewell.text,src.farewell.text);
   assert.equal(state.phase4Community!.configs.find(c=>c.chatId===OVERRIDE)!.welcome.text,
    'نص محلي خاص بالمجموعة');
   assert.equal(state.audit.filter(a=>a.reason==='OWNER_NETWORK_GREETING_TEMPLATES_COPIED').length,1);
  }finally{await f.close();}
 });
 test('NETWORK-002 greeting preview refuses source, network, and target changes ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const preview=await f.app().handle(cb(20,'nw:1:v:'+NETWORK+':'+SOURCE+':0'));
   const token=click(preview,'تأكيد');
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal((await f.app().handle(cb(21,token))).status,'DENIED');
   const second=await f.app().handle(cb(22,'nw:1:v:'+NETWORK+':'+SOURCE+':0'));
   const secondToken=click(second,'تأكيد');
   await f.store.transaction(s=>{
    const src=s.phase4Community!.configs.find(c=>c.chatId===SOURCE)!;
    src.welcome.text='تعديل بعد المعاينة';src.version++;
   });
   assert.equal((await f.app().handle(cb(23,secondToken))).status,'DENIED');
   const third=await f.app().handle(cb(24,'nw:1:v:'+NETWORK+':'+SOURCE+':0'));
   const thirdToken=click(third,'تأكيد');
   await f.policy.revokeChatAtRevision(OWNER,TARGET,1);
   assert.equal((await f.app().handle(cb(25,thirdToken))).status,'DENIED');
   assert.equal((await f.store.snapshot()).phase4Community!.configs.length,1);
  }finally{await f.close();}
 });
 test('NETWORK-002 greeting previews expire, cancel, and cannot double-confirm ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const preview=await f.app().handle(cb(30,'nw:1:v:'+NETWORK+':'+SOURCE+':0'));
   const token=click(preview,'تأكيد'),cancel=click(preview,'إلغاء');
   assert.equal((await f.app().handle(cb(31,cancel))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(32,token))).status,'DENIED');
   const second=await f.app().handle(cb(33,'nw:1:v:'+NETWORK+':'+SOURCE+':0'));
   const secondToken=click(second,'تأكيد');
   f.advance(121000);
   assert.equal((await f.app().handle(cb(34,secondToken))).status,'DENIED');
   const third=await f.app().handle(cb(35,'nw:1:v:'+NETWORK+':'+SOURCE+':0'));
   const thirdToken=click(third,'تأكيد');
   const results=await Promise.all([
    f.app().handle(cb(36,thirdToken)),f.app().handle(cb(37,thirdToken))]);
   assert.deepEqual(results.map(x=>x.status).sort(),['APPLIED','DENIED']);
   assert.equal((await f.store.snapshot()).phase4Community!.configs.length,3);
  }finally{await f.close();}
 });
 test('NETWORK-002 greeting preview pages max 8 targets and isolates each approval ('+engine+')',async()=>{
  const targets=Array.from({length:11},(_,i)=>'-100'+(9000+i));
  const f=await fixture(engine,targets);try{
   const first=await f.app().handle(cb(40,'nw:1:v:'+NETWORK+':'+SOURCE+':0'));
   assert.match(first.plan?.text??'',/8 مجموعات/);
   const second=await f.app().handle(cb(41,click(first,'التالي')));
   assert.match(second.plan?.text??'',/3 مجموعات/);
   const token=click(second,'تأكيد');
   assert.equal((await f.app().handle(cb(42,token))).status,'APPLIED');
   let state=await f.store.snapshot();
   assert.equal(state.phase4Community!.configs.length,4);
   assert.equal((await f.app().handle(cb(43,'nw:1:v:'+NETWORK+':'+SOURCE+':0'))).status,'APPLIED');
   assert.ok(state.phase4Community!.configs.every(c=>validCommunityConfig(c)));
  }finally{await f.close();}
 });
}
