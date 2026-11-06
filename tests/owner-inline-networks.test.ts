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
const buttons=(r:Handled)=>{if(r.status==='APPLIED')assert.equal(isValidTelegramInlineKeyboard(r.plan?.inlineMarkup),true,JSON.stringify(r.plan?.inlineMarkup?.inline_keyboard.flat().map(b=>b.callback_data)));return r.plan?.inlineMarkup?.inline_keyboard.flat()??[];};
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
 let creates=0;
 const create=async(name='شبكة الطب')=>{
  const base=700+creates++*10;
  assert.equal((await app().handle(callback(base,'nw:1:n'))).status,'APPLIED');
  const input=await app().handle(textMsg(base+1,name));
  assert.equal(input.status,'APPLIED');
  assert.match(input.plan?.text??'',/معاينة/);
  const saved=await app().handle(callback(base+2,find(input,'تأكيد')));
  assert.equal(saved.status,'APPLIED');
  return (await store.snapshot()).groupNetworks!.find(n=>n.name===name)!;
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


test('network rename and delete callbacks only accept canonical network IDs',()=>{
 const id='abcdef123456';
 assert.equal(validOwnerNetworkRoute('nw:1:e:'+id),true);
 assert.equal(validOwnerNetworkRoute('nw:1:x:'+id),true);
 for(const bad of ['nw:1:e:ABCDEF123456','nw:1:x:abcdef12345',
  'nw:1:x:abcdef123456\n','nw:1:e:abcdef123456:1','nw:1:x:abcdef123456:0'])
  assert.equal(validOwnerNetworkRoute(bad),false,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('owner renames a local network through private text and confirmed preview ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const start=await f.app().handle(callback(200,'nw:1:e:'+n.id));
   assert.equal(start.status,'APPLIED');
   assert.match(start.plan?.text??'',/الاسم الجديد/);
   const typed=await f.app().handle(textMsg(201,'شبكة الهندسة'));
   assert.equal(typed.status,'APPLIED');
   assert.match(typed.plan?.text??'',/معاينة إعادة تسمية/);
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.name,'شبكة الطب');
   const token=find(typed,'تأكيد');
   assert.equal((await f.app().handle(callback(202,token,200))).status,'DENIED');
   assert.equal((await f.app().handle(callback(203,token))).status,'APPLIED');
   const state=await f.store.snapshot();
   assert.equal(state.groupNetworks?.[0]?.name,'شبكة الهندسة');
   assert.equal(state.groupNetworks?.[0]?.revision,2);
   assert.deepEqual(state.groupNetworks?.[0]?.members,[]);
   assert.equal(state.audit.filter(x=>x.reason==='OWNER_NETWORK_RENAMED').length,1);
   assert.equal((await f.app().handle(callback(204,token))).status,'DENIED');
   const details=await f.app().handle(callback(205,'nw:1:d:'+n.id));
   assert.match(details.plan?.text??'',/شبكة الهندسة/);
  }finally{await f.close();}
 });
 test('network rename fails on duplicate names and concurrent membership edits ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const n=await f.create();
   const second=await f.create('شبكة العلوم');
   assert.notEqual(n.id,second.id);
   assert.equal((await f.app().handle(callback(210,'nw:1:e:'+n.id))).status,'APPLIED');
   const duplicate=await f.app().handle(textMsg(211,'شبكة العلوم'));
   assert.equal(duplicate.status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.name,'شبكة الطب');
   const input=await f.app().handle(textMsg(212,'شبكة الطب الجديدة'));
   const token=find(input,'تأكيد');
   await f.approve(GROUP);
   const preview=await f.app().handle(callback(213,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal(preview.status,'APPLIED');
   assert.equal((await f.app().handle(callback(214,find(preview,'تأكيد')))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(215,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.find(x=>x.id===n.id)?.name,'شبكة الطب');
  }finally{await f.close();}
 });
 test('owner can delete an empty network only after fresh one-shot confirmation ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const n=await f.create();
   const card=await f.app().handle(callback(220,'nw:1:d:'+n.id));
   const review=await f.app().handle(callback(221,find(card,'حذف الشبكة')));
   assert.equal(review.status,'APPLIED');
   assert.match(review.plan?.text??'',/معاينة حذف/);
   assert.equal((await f.store.snapshot()).groupNetworks?.length,1);
   const token=find(review,'تأكيد الحذف');
   assert.equal((await f.app().handle(callback(222,token,200))).status,'DENIED');
   const result=await Promise.all([
    f.app().handle(callback(223,token)),f.app().handle(callback(224,token))
   ]);
   assert.deepEqual(result.map(x=>x.status).sort(),['APPLIED','DENIED']);
   const state=await f.store.snapshot();
   assert.equal(state.groupNetworks?.length,0);
   assert.equal(state.audit.filter(x=>x.reason==='OWNER_NETWORK_DELETED').length,1);
   assert.equal((await f.app().handle(callback(225,token))).status,'DENIED');
  }finally{await f.close();}
 });
 test('network deletion is blocked while membership exists, or network changes after preview ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const preview=await f.app().handle(callback(230,'nw:1:x:'+n.id));
   assert.equal(preview.status,'APPLIED');
   const token=find(preview,'تأكيد الحذف');
   const associate=await f.app().handle(callback(231,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal((await f.app().handle(callback(232,find(associate,'تأكيد')))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(233,token))).status,'DENIED');
   assert.equal((await f.app().handle(callback(234,'nw:1:x:'+n.id))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,1);
  }finally{await f.close();}
 });
 test('rename pending input cancels on navigation and delete preview cancellation is durable ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const n=await f.create();
   assert.equal((await f.app().handle(callback(240,'nw:1:e:'+n.id))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(241,'nw:1:h'))).status,'APPLIED');
   const stray=await f.app().handle(textMsg(242,'اسم لم يُطلب'));
   assert.notEqual(stray.reason,'NETWORK_TEXT_PREVIEW');
   const review=await f.app().handle(callback(243,'nw:1:x:'+n.id));
   const token=find(review,'تأكيد الحذف'),cancel=find(review,'إلغاء');
   assert.equal((await f.app().handle(callback(244,cancel))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(245,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.length,1);
  }finally{await f.close();}
 });
}


test('network audit routes only accept canonical bounded payloads',()=>{
 for(const good of ['nw:1:r:p:0','nw:1:r:p:999','nw:1:r:v:'+'A'.repeat(24)]){
  assert.equal(validOwnerNetworkRoute(good),true,good);
 }
 for(const bad of ['nw:1:r:p:00','nw:1:r:p:1000','nw:1:r:p:-1',
  'nw:1:r:v:short','nw:1:r:v:'+'A'.repeat(25),'nw:1:r:v:'+'A'.repeat(24)+'\n']){
  assert.equal(validOwnerNetworkRoute(bad),false,bad);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('verified network history retains create rename and delete even after network removal ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const network=await f.create();
   assert.equal((await f.app().handle(callback(280,'nw:1:e:'+network.id))).status,'APPLIED');
   const rename=await f.app().handle(textMsg(281,'شبكة جديدة'));
   assert.equal((await f.app().handle(callback(282,find(rename,'تأكيد')))).status,'APPLIED');
   const deletePreview=await f.app().handle(callback(283,'nw:1:x:'+network.id));
   assert.equal((await f.app().handle(callback(284,find(deletePreview,'تأكيد الحذف')))).status,'APPLIED');
   const before=await f.store.snapshot();
   assert.equal(before.groupNetworks?.length,0);
   const home=await f.app().handle(callback(285,'nw:1:h'));
   assert.ok(buttons(home).some(x=>x.callback_data==='nw:1:r:p:0'));
   const history=await f.app().handle(callback(286,'nw:1:r:p:0'));
   assert.equal(history.status,'APPLIED');
   assert.match(history.plan?.text??'',/سجل تغييرات الشبكات/);
   assert.match(history.plan?.text??'',/3 عمليات/);
   const rows=buttons(history).filter(x=>x.callback_data.startsWith('nw:1:r:v:'));
   assert.equal(rows.length,3);
   const details=await Promise.all(rows.map((x,i)=>f.app().handle(callback(287+i,x.callback_data))));
   assert.equal(details.every(x=>x.status==='APPLIED'),true);
   assert.ok(details.some(x=>(x.plan?.text??'').includes('OWNER_NETWORK_RENAMED')));
   assert.ok(details.some(x=>(x.plan?.text??'').includes('OWNER_NETWORK_DELETED')));
   assert.ok(details.some(x=>(x.plan?.text??'').includes('OWNER_NETWORK_CREATED')));
   assert.equal(details.every(x=>!buttons(x).some(b=>b.text.includes('تأكيد'))),true);
   assert.equal((await f.app().handle(callback(295,'nw:1:r:p:1'))).status,'DENIED');
   assert.equal((await f.app().handle(callback(296,'nw:1:r:p:0',200))).status,'DENIED');
   assert.equal((await f.app().handle(callback(297,'nw:1:r:p:0',100,true))).status,'DENIED');
   const after=await f.store.snapshot();
   assert.deepEqual(after.groupNetworks,before.groupNetworks);
   assert.equal(after.audit.filter(x=>x.reason==='OWNER_NETWORK_DELETED').length,1);
  }finally{await f.close();}
 });
 test('network history refuses to trust duplicate or orphaned mutation evidence ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.create();
   const list=await f.app().handle(callback(310,'nw:1:r:p:0'));
   const action=find(list,'🌐');
   const state=await f.store.snapshot();
   const audit=state.audit.find(a=>a.reason==='OWNER_NETWORK_CREATED')!;
   await f.store.transaction(s=>{s.audit.push({...audit});});
   const after=await f.app().handle(callback(311,'nw:1:r:p:0'));
   assert.equal(after.status,'APPLIED');
   assert.match(after.plan?.text??'',/لا توجد عمليات موثقة/);
   assert.equal((await f.app().handle(callback(312,action))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.length,1);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('navigating from rename entry to group membership revokes input intent ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   assert.equal((await f.app().handle(callback(360,'nw:1:e:'+n.id))).status,'APPLIED');
   const connect=await f.app().handle(callback(361,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal(connect.status,'APPLIED');
   assert.equal((await f.app().handle(callback(362,find(connect,'تأكيد')))).status,'APPLIED');
   const stale=await f.app().handle(textMsg(363,'شبكة قديمة'));
   assert.equal(stale.status,'IGNORED');
   assert.equal((await f.store.snapshot()).callbacks.filter(c=>c.action.startsWith('owner-network-input:rename:')&&!c.revoked&&!c.used).length,0);
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.name,'شبكة الطب');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.revision,2);
   assert.equal((await f.app().handle(callback(364,'nw:1:e:'+n.id))).status,'APPLIED');
   const fresh=await f.app().handle(textMsg(365,'شبكة حديثة'));
   assert.equal(fresh.status,'APPLIED');
   assert.equal((await f.app().handle(callback(366,find(fresh,'تأكيد')))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.name,'شبكة حديثة');
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('rename input fails closed on an external concurrent membership revision update ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   assert.equal((await f.app().handle(callback(370,'nw:1:e:'+n.id))).status,'APPLIED');
   // Simulate a second authorized process updating the same DB directly
   // without causing callback navigation to cancel the pending name entry.
   await f.store.transaction(s=>{
    const network=s.groupNetworks!.find(x=>x.id===n.id)!;
    network.members.push({chatId:GROUP,version:1});
    network.revision++;
    network.updatedAt=NOW;
   });
   const stale=await f.app().handle(textMsg(371,'شبكة جديدة'));
   assert.equal(stale.status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.name,'شبكة الطب');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.revision,2);
   assert.equal((await f.app().handle(callback(372,'nw:1:e:'+n.id))).status,'APPLIED');
   const fresh=await f.app().handle(textMsg(373,'شبكة محدثة'));
   assert.equal(fresh.status,'APPLIED');
   assert.equal((await f.app().handle(callback(374,find(fresh,'تأكيد')))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.name,'شبكة محدثة');
  }finally{await f.close();}
 });
}


test('stale network cleanup callback routes are canonical and length bounded',()=>{
 for(const key of ['nw:1:s:abcdef123456:0',
  'nw:1:q:abcdef123456:2:-100123:1:0'])
  assert.equal(validOwnerNetworkRoute(key),true,key);
 for(const key of ['nw:1:s:abcdef123456:00',
  'nw:1:q:ABCDEF123456:2:-100123:1:0',
  'nw:1:q:abcdef123456:02:-100123:1:0',
  'nw:1:q:abcdef123456:2:-100123:01:0',
  'nw:1:q:abcdef123456:2:100123:1:0',
  'nw:1:q:abcdef123456:2:-100123:1:0\\n',
  'nw:1:q:abcdef123456:9999999999:-1234567890123456:9999999999:1000'])
  assert.equal(validOwnerNetworkRoute(key),false,key);
});
for(const engine of ['json','sqlite'] as const){
 test('stale network association cleanup is one-shot, owner-only and audited ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const linked=await f.app().handle(callback(800,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal((await f.app().handle(callback(801,find(linked,'تأكيد')))).status,'APPLIED');
   await f.approve(GROUP); // approval revision changes: the old association is stale
   const card=await f.app().handle(callback(802,'nw:1:d:'+n.id));
   assert.match(card.plan?.text??'',/ارتباطات تحتاج مراجعة: 1/);
   const cleanup=await f.app().handle(callback(803,find(card,'مراجعة الارتباطات القديمة')));
   assert.equal(cleanup.status,'APPLIED');
   assert.match(cleanup.plan?.text??'',/الارتباطات القديمة/);
   const preview=await f.app().handle(callback(804,find(cleanup,GROUP)));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/معاينة فصل ارتباط قديم/);
   const token=find(preview,'تأكيد الفصل');
   assert.equal((await f.app().handle(callback(805,token,200))).status,'DENIED');
   assert.equal((await f.app().handle(callback(806,token,100,true))).status,'DENIED');
   const results=await Promise.all([
    f.app().handle(callback(807,token)),f.app().handle(callback(808,token))
   ]);
   assert.deepEqual(results.map(x=>x.status).sort(),['APPLIED','DENIED']);
   const state=await f.store.snapshot();
   assert.deepEqual(state.groupNetworks?.[0]?.members,[]);
   assert.equal(state.groupNetworks?.[0]?.revision,3);
   assert.equal(state.audit.filter(x=>x.reason==='OWNER_NETWORK_STALE_MEMBER_REMOVED').length,1);
   assert.equal(state.chats.find(x=>x.id===GROUP)?.approved,true);
   const history=await f.app().handle(callback(809,'nw:1:r:p:0'));
   assert.ok(buttons(history).some(x=>x.text.includes('تنظيف ارتباط قديم')));
   const detail=await f.app().handle(callback(810,find(history,'تنظيف ارتباط قديم')));
   assert.match(detail.plan?.text??'',/OWNER_NETWORK_STALE_MEMBER_REMOVED/);
   assert.equal((await f.app().handle(callback(811,token))).status,'DENIED');
  }finally{await f.close();}
 });
 test('stale cleanup rejects active associations, changed proof, cancel and expiry ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const link=await f.app().handle(callback(820,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal((await f.app().handle(callback(821,find(link,'تأكيد')))).status,'APPLIED');
   const live=await f.app().handle(callback(822,'nw:1:d:'+n.id));
   assert.equal(buttons(live).some(x=>x.text.includes('مراجعة الارتباطات القديمة')),false);
   assert.equal((await f.app().handle(callback(823,'nw:1:s:'+n.id+':0'))).status,'DENIED');
   assert.equal((await f.app().handle(callback(824,'nw:1:q:'+n.id+':2:'+GROUP+':1:0'))).status,'DENIED');
   await f.approve(GROUP);
   const pending=await f.app().handle(callback(825,'nw:1:q:'+n.id+':2:'+GROUP+':1:0'));
   assert.equal(pending.status,'APPLIED');
   const token=find(pending,'تأكيد الفصل');
   await f.approve(GROUP); // network revision unchanged, group approval proof changed
   assert.equal((await f.app().handle(callback(826,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,1);
   const cancelPreview=await f.app().handle(callback(827,'nw:1:q:'+n.id+':2:'+GROUP+':1:0'));
   const cancelToken=find(cancelPreview,'تأكيد الفصل');
   assert.equal((await f.app().handle(callback(828,find(cancelPreview,'إلغاء')))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(829,cancelToken))).status,'DENIED');
   const timeout=await f.app().handle(callback(830,'nw:1:q:'+n.id+':2:'+GROUP+':1:0'));
   const timedToken=find(timeout,'تأكيد الفصل');
   f.advance(121000);
   assert.equal((await f.app().handle(callback(831,timedToken))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,1);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('revoked group association can be detached without reauthorizing the chat ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const link=await f.app().handle(callback(840,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal((await f.app().handle(callback(841,find(link,'تأكيد')))).status,'APPLIED');
   await f.policy.revokeChatAtRevision(OWNER,GROUP,1);
   const card=await f.app().handle(callback(842,'nw:1:d:'+n.id));
   assert.match(card.plan?.text??'',/ارتباطات تحتاج مراجعة: 1/);
   const stale=await f.app().handle(callback(843,find(card,'مراجعة الارتباطات القديمة')));
   const preview=await f.app().handle(callback(844,find(stale,GROUP)));
   assert.equal((await f.app().handle(callback(845,find(preview,'تأكيد الفصل')))).status,'APPLIED');
   const saved=await f.store.snapshot();
   assert.deepEqual(saved.groupNetworks?.[0]?.members,[]);
   assert.equal(saved.chats.find(c=>c.id===GROUP)?.approved,false);
   const deletion=await f.app().handle(callback(846,'nw:1:x:'+n.id));
   assert.equal((await f.app().handle(callback(847,find(deletion,'تأكيد الحذف')))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.length,0);
  }finally{await f.close();}
 });
}


test('network stale batch callbacks have canonical bounded payloads',()=>{
 for(const value of ['nw:1:b:abcdef123456:1:0','nw:1:b:abcdef123456:9999999999:999'])
  assert.equal(validOwnerNetworkRoute(value),true,value);
 for(const value of ['nw:1:b:abcdef123456:01:0','nw:1:b:ABCDEF123456:1:0',
  'nw:1:b:abcdef123456:1:00','nw:1:b:abcdef123456:1:1000',
  'nw:1:b:abcdef123456:0:0','nw:1:b:abcdef123456:1:0\n'])
  assert.equal(validOwnerNetworkRoute(value),false,value);
});

for(const engine of ['json','sqlite'] as const){
 test('network batch stale cleanup is scoped and atomic ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const link=await f.app().handle(callback(1000,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal((await f.app().handle(callback(1001,find(link,'تأكيد')))).status,'APPLIED');
   const oldIds=Array.from({length:9},(_,i)=>'-2000'+(10+i));
   await f.store.transaction(s=>{
    const network=s.groupNetworks![0]!;
    network.members.push(...oldIds.map(chatId=>({chatId,version:1})));
    network.revision++;
   });
   const card=await f.app().handle(callback(1002,'nw:1:d:'+n.id));
   assert.match(card.plan?.text??'',/مجموعات فعالة: 1/);
   assert.match(card.plan?.text??'',/ارتباطات تحتاج مراجعة: 9/);
   const page=await f.app().handle(callback(1003,'nw:1:s:'+n.id+':0'));
   assert.equal(page.status,'APPLIED');
   assert.match(page.plan?.text??'',/صفحة 1 من 2/);
   const preview=await f.app().handle(callback(1004,find(page,'تنظيف الصفحة')));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/معاينة تنظيف جماعي/);
   assert.match(preview.plan?.text??'',/8 ارتباطات/);
   assert.ok(oldIds.slice(0,8).every(id=>(preview.plan?.text??'').includes(id)));
   assert.equal((preview.plan?.text??'').includes(oldIds[8]!),false);
   const token=find(preview,'تأكيد التنظيف');
   assert.equal((await f.app().handle(callback(1005,token,200))).status,'DENIED');
   assert.equal((await f.app().handle(callback(1006,token,100,true))).status,'DENIED');
   const concurrent=await Promise.all([
    f.app().handle(callback(1007,token)),f.app().handle(callback(1008,token))
   ]);
   assert.deepEqual(concurrent.map(x=>x.status).sort(),['APPLIED','DENIED']);
   let s=await f.store.snapshot();
   assert.equal(s.groupNetworks?.[0]?.revision,4);
   assert.deepEqual(s.groupNetworks?.[0]?.members.map(x=>x.chatId).sort(),
    [GROUP,oldIds[8]!].sort());
   assert.equal(s.audit.filter(a=>a.reason==='OWNER_NETWORK_STALE_MEMBERS_PRUNED').length,1);
   assert.equal(s.chats.find(x=>x.id===GROUP)?.approved,true);
   const again=await f.app().handle(callback(1009,'nw:1:s:'+n.id+':0'));
   assert.equal(again.status,'APPLIED');
   assert.match(again.plan?.text??'',/صفحة 1 من 1/);
   const last=await f.app().handle(callback(1010,find(again,'تنظيف الصفحة')));
   assert.match(last.plan?.text??'',/1 ارتباط/);
   assert.equal((await f.app().handle(callback(1011,find(last,'تأكيد التنظيف')))).status,'APPLIED');
   s=await f.store.snapshot();
   assert.deepEqual(s.groupNetworks?.[0]?.members,[{chatId:GROUP,version:1}]);
   assert.equal(s.groupNetworks?.[0]?.revision,5);
   const history=await f.app().handle(callback(1012,'nw:1:r:p:0'));
   const receipts=buttons(history).filter(b=>b.text.includes('تنظيف جماعي'));
   assert.equal(receipts.length,2);
   const detail=await f.app().handle(callback(1013,receipts[0]!.callback_data));
   assert.match(detail.plan?.text??'',/OWNER_NETWORK_STALE_MEMBERS_PRUNED/);
  }finally{await f.close();}
 });
 test('network stale batch rejects active links and changed revisions ('+engine+')',async()=>{
  const f=await setup(engine);try{
   await f.approve(GROUP);
   const n=await f.create();
   const link=await f.app().handle(callback(1020,'nw:1:t:'+n.id+':1:'+GROUP+':1:0'));
   assert.equal((await f.app().handle(callback(1021,find(link,'تأكيد')))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(1022,'nw:1:b:'+n.id+':2:0'))).status,'DENIED');
   await f.approve(GROUP); // old association becomes stale
   const batch=await f.app().handle(callback(1023,'nw:1:b:'+n.id+':2:0'));
   assert.equal(batch.status,'APPLIED');
   const token=find(batch,'تأكيد التنظيف');
   await f.approve(GROUP); // no network edit: just the group approval epoch changes
   assert.equal((await f.app().handle(callback(1024,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,1);
   assert.equal((await f.app().handle(callback(1025,'nw:1:b:'+n.id+':1:0'))).status,'DENIED');
   const fresh=await f.app().handle(callback(1026,'nw:1:b:'+n.id+':2:0'));
   assert.equal(fresh.status,'APPLIED');
   const freshToken=find(fresh,'تأكيد التنظيف');
   await f.store.transaction(s=>{
    const network=s.groupNetworks![0]!;
    network.name='شبكة الطب المحدثة';network.revision++;
   });
   assert.equal((await f.app().handle(callback(1027,freshToken))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,1);
  }finally{await f.close();}
 });
 test('network stale batch cancellation and expiry are irreversible ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const n=await f.create();
   await f.store.transaction(s=>{
    s.groupNetworks![0]!.members=[{chatId:GROUP,version:1}];
    s.groupNetworks![0]!.revision=2;
   });
   const preview=await f.app().handle(callback(1030,'nw:1:b:'+n.id+':2:0'));
   assert.equal(preview.status,'APPLIED');
   const token=find(preview,'تأكيد التنظيف');
   assert.equal((await f.app().handle(callback(1031,find(preview,'إلغاء')))).status,'APPLIED');
   assert.equal((await f.app().handle(callback(1032,token))).status,'DENIED');
   const second=await f.app().handle(callback(1033,'nw:1:b:'+n.id+':2:0'));
   const token2=find(second,'تأكيد التنظيف');
   f.advance(121000);
   assert.equal((await f.app().handle(callback(1034,token2))).status,'DENIED');
   assert.deepEqual((await f.store.snapshot()).groupNetworks?.[0]?.members,
    [{chatId:GROUP,version:1}]);
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='OWNER_NETWORK_STALE_MEMBERS_PRUNED').length,0);
  }finally{await f.close();}
 });
 test('network stale batch audit rejects duplicate evidence ('+engine+')',async()=>{
  const f=await setup(engine);try{
   const n=await f.create();
   await f.store.transaction(s=>{s.groupNetworks![0]!.members=[{chatId:GROUP,version:1}];});
   const preview=await f.app().handle(callback(1040,'nw:1:b:'+n.id+':1:0'));
   assert.equal((await f.app().handle(callback(1041,find(preview,'تأكيد التنظيف')))).status,'APPLIED');
   const history=await f.app().handle(callback(1042,'nw:1:r:p:0'));
   const ref=buttons(history).find(x=>x.text.includes('تنظيف جماعي'))?.callback_data;
   assert.ok(ref);
   await f.store.transaction(s=>{
    const event=s.audit.find(a=>a.reason==='OWNER_NETWORK_STALE_MEMBERS_PRUNED')!;
    s.audit.push({...event});
   });
   const after=await f.app().handle(callback(1043,'nw:1:r:p:0'));
   assert.equal(buttons(after).some(x=>x.callback_data===ref),false);
   assert.equal((await f.app().handle(callback(1044,ref!))).status,'DENIED');
   assert.equal((await f.store.snapshot()).groupNetworks?.[0]?.members.length,0);
  }finally{await f.close();}
 });
}
