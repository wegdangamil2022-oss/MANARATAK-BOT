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
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';

const OWNER='100',NOW=1700000000000,GROUP='-100123';
const callback=(i:number,data:string,actor=100,inGroup=false)=>({
 update_id:i,callback_query:{id:'network_'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:9,from:{id:999,is_bot:true},chat:{id:inGroup?-100123:actor,type:inGroup?'supergroup':'private'}}}
});
const textMsg=(i:number,text:string,actor=100)=>({update_id:i,message:{message_id:i,from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},date:1700000000,text}});
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Handled)=>{if(r.status==='APPLIED')assert.equal(isValidTelegramInlineKeyboard(r.plan?.inlineMarkup),true);return r.plan?.inlineMarkup?.inline_keyboard.flat()??[];};
const find=(r:Handled,label:string)=>{const b=buttons(r).find(x=>x.text.includes(label));assert.ok(b,'no '+label+' in '+r.plan?.text);return b.callback_data;};
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'network-editor-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'networks-test',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('Network editor must not contact Telegram');}});
 const approve=(id:string)=>policy.approveChat(OWNER,id,['navigation','moderation','assistant']);
 const create=async(name='شبكة الطب')=>{
  assert.equal((await app().handle(callback(700,'nw:1:n'))).status,'APPLIED');
  const input=await app().handle(textMsg(701,name));
  assert.equal(input.status,'APPLIED');
  assert.match(input.plan?.text??'',/معاينة/);
  const saved=await app().handle(callback(702,find(input,'تأكيد')));
  assert.equal(saved.status,'APPLIED');
  return (await store.snapshot()).groupNetworks![0]!;
 };
 return {store,policy,app,approve,create,advance:(ms:number)=>now+=ms,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('network callback keys are canonical and limited to Telegram maximum',()=>{
 const good=['nw:1:h','nw:1:n','nw:1:p:0','nw:1:p:999',
  'nw:1:d:abcdef123456','nw:1:g:abcdef123456:0',
  'nw:1:t:abcdef123456:1:-100123:2:0',
  'nw:1:c:'+'A'.repeat(24),'nw:1:k:'+'A'.repeat(24)];
 for(const value of good)assert.equal(validOwnerNetworkRoute(value),true,value);
 for(const value of ['nw:2:h','nw:1:p:00','nw:1:p:1000','nw:1:d:ABCDEF123456',
  'nw:1:t:abcdef123456:01:-100123:2:0','nw:1:t:abcdef123456:1:100123:2:0',
  'nw:1:c:abc','nw:1:k:'+'A'.repeat(25),'nw:1:h\n'])
  assert.equal(validOwnerNetworkRoute(value),false,value);
});
for(const engine of ['json','sqlite'] as const){
 test('create named local network with preview, actor isolation and audit ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const home=await f.app().handle(callback(1,'mi:1:i:01:03'));
   assert.equal(home.status,'APPLIED');
   assert.match(home.plan?.text??'',/الشبكات والاتحادات/);
   assert.equal((await f.app().handle(callback(2,'nw:1:n',200))).status,'DENIED');
   assert.equal((await f.app().handle(callback(3,'nw:1:n',100,true))).status,'DENIED');
   assert.equal((await f.app().handle(callback(4,'nw:1:n'))).status,'APPLIED');
   const pending=await f.app().handle(textMsg(5,'شبكة الطب'));
   assert.equal(pending.status,'APPLIED');
   assert.match(pending.plan?.text??'',/معاينة إنشاء شبكة/);
   assert.equal((await f.store.snapshot()).groupNetworks?.length??0,0);
   const token=find(pending,'تأكيد');
   assert.equal((await f.app().handle(callback(6,token,200))).status,'DENIED');
   assert.equal((await f.app().handle(callback(7,token))).status,'APPLIED');
   const s=await f.store.snapshot();
   assert.equal(s.groupNetworks?.length,1);
   assert.equal(s.groupNetworks?.[0]?.name,'شبكة الطب');
   assert.deepEqual(s.groupNetworks?.[0]?.members,[]);
   assert.equal(s.audit.filter(a=>a.reason==='OWNER_NETWORK_CREATED').length,1);
   assert.equal((await f.app().handle(callback(8,token))).status,'DENIED');
   assert.equal((await f.app().handle(callback(9,'nw:1:p:1'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('network membership add and remove use version-fenced approvals ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create(),gid=n.id;
   const detail=await f.app().handle(callback(20,'nw:1:d:'+gid));
   assert.equal(detail.status,'APPLIED');
   const chooser=await f.app().handle(callback(21,find(detail,'إدارة المجموعات')));
   assert.equal(chooser.status,'APPLIED');
   const preview=await f.app().handle(callback(22,find(chooser,GROUP)));
   assert.match(preview.plan?.text??'',/معاينة ربط/);
   const confirm=find(preview,'تأكيد');
   assert.equal((await f.app().handle(callback(23,confirm))).status,'APPLIED');
   let s=await f.store.snapshot();
   assert.deepEqual(s.groupNetworks?.[0]?.members,[{chatId:GROUP,version:1}]);
   assert.equal(s.groupNetworks?.[0]?.revision,2);
   assert.equal(s.audit.filter(a=>a.reason==='OWNER_NETWORK_MEMBER_ADDED').length,1);
   const detail2=await f.app().handle(callback(24,'nw:1:d:'+gid));
   assert.match(detail2.plan?.text??'',/مجموعات فعالة: 1/);
   const chooser2=await f.app().handle(callback(25,find(detail2,'إدارة المجموعات')));
   const removePreview=await f.app().handle(callback(26,find(chooser2,GROUP)));
   assert.match(removePreview.plan?.text??'',/معاينة فصل/);
   assert.equal((await f.app().handle(callback(27,find(removePreview,'تأكيد')))).status,'APPLIED');
   s=await f.store.snapshot();
   assert.deepEqual(s.groupNetworks?.[0]?.members,[]);
   assert.equal(s.groupNetworks?.[0]?.revision,3);
  }finally{await f.close();}
 });
 test('stale or revoked group cannot be silently re-associated ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const nav=await f.app().handle(callback(30,'nw:1:g:'+n.id+':0'));
   const p=await f.app().handle(callback(31,find(nav,GROUP)));
   const token=find(p,'تأكيد');
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation','assistant']);
   assert.equal((await f.app().handle(callback(32,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,0);
   const state=await f.store.snapshot();
   assert.equal((await f.app().handle(callback(33,'nw:1:t:'+n.id+':1:'+GROUP+':'+(state.chats[0]!.version)+':0'))).status,'APPLIED');
   const token2=find(await f.app().handle(callback(34,'nw:1:t:'+n.id+':1:'+GROUP+':2:0')),'تأكيد');
   await f.policy.revokeChatAtRevision(OWNER,GROUP,2);
   assert.equal((await f.app().handle(callback(35,token2))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,0);
  }finally{await f.close();}
 });
 test('cancel, expiry and simultaneous confirmations are fail-closed ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const preview=await f.app().handle(callback(40,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   const token=find(preview,'تأكيد'),cancel=find(preview,'إلغاء');
   assert.equal((await f.app().handle(callback(41,cancel))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(42,token))).status,'DENIED');
   const second=await f.app().handle(callback(43,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   const secondToken=find(second,'تأكيد');
   f.advance(121000);
   assert.equal((await f.app().handle(callback(44,secondToken))).status,'DENIED');
   const third=await f.app().handle(callback(45,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   const thirdToken=find(third,'تأكيد');
   const outcomes=await Promise.all([f.app().handle(callback(46,thirdToken)),f.app().handle(callback(47,thirdToken))]);
   assert.deepEqual(outcomes.map(x=>x.status).sort(),['APPLIED','DENIED']);
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,1);
  }finally{await f.close();}
 });
 test('invalid text and dashboard disable deny network changes without storing content ('+engine+')',async()=>{
  const f=await setup(engine);try{
   assert.equal((await f.app().handle(callback(50,'nw:1:n'))).status,'APPLIED');
   const invalid=await f.app().handle(textMsg(51,'<script>alert(1)</script>'));
   assert.equal(invalid.status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.length??0,0);
   const valid=await f.app().handle(textMsg(52,'شبكة التعليم'));
   const token=find(valid,'تأكيد');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app().handle(callback(53,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.length??0,0);
  }finally{await f.close();}
 });
 test('network storage rejects malformed and duplicate network IDs ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const n=await f.create();
   await assert.rejects(()=>f.store.transaction(s=>{
    s.groupNetworks!.push({...n});
   }));
   assert.equal((await f.store.snapshot()).groupNetworks?.length,1);
   await assert.rejects(()=>f.store.transaction(s=>{
    s.groupNetworks![0]!.members=[{chatId:'evil',version:1}];
   }));
   assert.deepEqual((await f.store.snapshot()).groupNetworks?.[0]?.members,[]);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('returning to network home truly cancels unfinished name input ('+engine+')',async()=>{
  const f=await setup(engine);try{
   assert.equal((await f.app().handle(callback(80,'nw:1:n'))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(81,'nw:1:h'))).status,'APPLIED');
   const unrelated=await f.app().handle(textMsg(82,'شبكة متروكة'));
   assert.notEqual(unrelated.reason,'NETWORK_TEXT_PREVIEW');
   assert.equal((await f.store.snapshot()).groupNetworks?.length??0,0);
   assert.equal((await f.store.snapshot()).callbacks.filter(c=>c.action==='owner-network-input:'&&!c.revoked&&!c.used).length,0);
  }finally{await f.close();}
 });
}
