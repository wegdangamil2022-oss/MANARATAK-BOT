import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ButtonStudioService} from '../src/button-studio.js';
import {GroupWelcomeFarewell,type GroupGreetingPayload,type GroupGreetingSender} from '../src/group-welcome-farewell.js';
import {TelegramWelcomeOwner} from '../src/telegram-welcome-owner.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {ownerInlineConnection,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const NOW=1700000000000,G='-100123',OWNER='100';
const btn=(v:OwnerInlineScreen|null,name:string)=>{
 assert.ok(v);const found=v.keyboard.inline_keyboard.flat().find(b=>b.text.includes(name));
 assert.ok(found,'missing '+name+' in '+v.text);return found.callback_data;
};
test('welcome and farewell is linked to an actual owner editor, not a catalogue-only placeholder',()=>{
 assert.equal(ownerInlineConnection('mi:1:i:09:01'),'EDITOR');
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'group-welcome-farewell-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW,safe=true,right:'GRANTED'|'DENIED'|'UNKNOWN'='GRANTED';
  let response:'CONFIRMED'|'UNKNOWN_OUTCOME'|'FAILED_CONFIRMED'='CONFIRMED',del:'ACKNOWLEDGED'|'UNKNOWN_OUTCOME'='ACKNOWLEDGED';
  let duringSend:(()=>Promise<void>)|undefined;
  const sent:GroupGreetingPayload[]=[],deleted:{chatId:string;messageId:number}[]=[];
  const policy=new Policy(store,OWNER,()=>now);await policy.approveChat(OWNER,G,['moderation','verification','navigation']);
  const studio=new ButtonStudioService(store,policy,()=>now);
  const create=async(label:string,body:string,url?:string)=>{
   let t=await studio.create(OWNER,label);t=await studio.edit(OWNER,t.id,t.revision,{kind:'TEXT',value:body});
   if(url){t=await studio.edit(OWNER,t.id,t.revision,{kind:'ADD_BUTTON',value:'📚 دليل الطلاب'});
    t=await studio.edit(OWNER,t.id,t.revision,{kind:'ACTION',buttonId:t.draft.buttons[0]!.id,action:{kind:'URL',target:url}});}
   t=await studio.save(OWNER,t.id,t.revision);
   return {id:t.id,revision:t.versions.at(-1)!.revision,template:t};
  };
  const sender:GroupGreetingSender={
   send:async(payload,verify)=>{
    if(!await verify())return {status:'NOT_SENT'} as const;
    sent.push(payload);
    if(duringSend){const callback=duringSend;duringSend=undefined;await callback();}
    return response==='CONFIRMED'?{status:'CONFIRMED',messageId:600+sent.length} as const:{status:response};
   },
   delete:async(chatId,messageId,verify)=>{
    if(!await verify())return 'NOT_SENT';
    deleted.push({chatId,messageId});return del;
   }
  };
  const greetings=new GroupWelcomeFarewell(store,policy,sender,()=>now,async()=>safe,async()=>right);
  const enable=async(kind:'WELCOME'|'FAREWELL'|'GUIDE',id:string,revision:number)=>
   assert.equal(await greetings.configure(OWNER,G,kind,true,id,revision,greetings.epoch(await store.snapshot(),G,kind)),true);
  const observe=async(kind:'WELCOME'|'FAREWELL'='WELCOME',msg=71,upd=71,topicId?:number)=>
   greetings.observe(G,kind,msg,'b3-webhook:greetings:'+upd,now,topicId);
  const education=new EducationService(store,policy,()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,
   admin:new EducationAdminFacade(store,policy,education,()=>now),
   faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),
   membership:async()=> 'VERIFIED',clock:()=>now,botId:'greetings',botUsername:'ManaratakBot',welcomeFarewell:greetings});
  return {dir,store,policy,studio,greetings,sent,deleted,create,enable,observe,app,
   now:()=>now,advance:(n:number)=>{now+=n;},stop:()=>{safe=false;},start:()=>{safe=true;},
   rights:(r:typeof right)=>{right=r;},sendResult:(r:typeof response)=>{response=r;},
   deleteResult:(r:typeof del)=>{del=r;},during:(c:()=>Promise<void>)=>{duringSend=c;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' no public greeting runs without a separately approved saved studio version',async()=>{
  const f=await fixture();try{
   const t=await f.create('رسالة الطلاب','مرحبًا {العضو}');
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'WELCOME')?.enabled,false);
   assert.equal(await f.observe(),0);assert.equal((await f.greetings.drain()).sent,0);assert.equal(f.sent.length,0);
   assert.equal(await f.greetings.configure(OWNER,G,'WELCOME',true,t.id,t.revision+1,f.greetings.epoch(await f.store.snapshot(),G,'WELCOME')),false);
  }finally{await f.close();}
 });
 test(engine+' trusted join renders approved studio version, topic and safe URL button and cleans own receipt after five minutes',async()=>{
  const f=await fixture();try{
   const t=await f.create('ترحيب عربي','🎓 أهلاً {العضو} في {اسم_المجموعة}. اليوم {التاريخ}.','https://study.example.org/guide');
   await f.enable('WELCOME',t.id,t.revision);
   assert.equal(await f.observe('WELCOME',71,71,42),1);
   assert.deepEqual(await f.greetings.drain(),{sent:1,unresolved:0});
   assert.equal(f.sent.length,1);
   assert.equal(f.sent[0]!.chatId,G);assert.equal(f.sent[0]!.topicId,42);
   assert.match(f.sent[0]!.text,/أهلاً عضو جديد في مجموعة منارتك/u);
   assert.deepEqual(f.sent[0]!.buttons,[[{text:'📚 دليل الطلاب',url:'https://study.example.org/guide'}]]);
   assert.equal((await f.greetings.cleanup()).deleted,0);
   f.advance(300000);assert.deepEqual(await f.greetings.cleanup(),{deleted:1,unresolved:0});
   assert.deepEqual(f.deleted,[{chatId:G,messageId:601}]);
   assert.equal((await f.greetings.cleanup()).deleted,0);
  }finally{await f.close();}
 });
 test(engine+' farewell uses separate consent and saved English template',async()=>{
  const f=await fixture();try{
   const hello=await f.create('Welcome','Welcome to our learning group');
   const bye=await f.create('Farewell','Goodbye, {العضو}. Thank you for being with us.');
   await f.enable('WELCOME',hello.id,hello.revision);
   assert.equal(await f.observe('FAREWELL',72,72),0);
   await f.enable('FAREWELL',bye.id,bye.revision);
   assert.equal(await f.observe('FAREWELL',72,72),1);
   assert.equal((await f.greetings.drain()).sent,1);
   assert.match(f.sent[0]!.text,/Goodbye, one of our members/u);
   assert.doesNotMatch(f.sent[0]!.text,/300|72/u);
  }finally{await f.close();}
 });
 test(engine+' changing an unsaved draft does not mutate published welcome version',async()=>{
  const f=await fixture();try{
   const t=await f.create('A','Welcome to our study group');
   await f.enable('WELCOME',t.id,t.revision);
   await f.studio.edit(OWNER,t.id,t.template.revision,{kind:'TEXT',value:'Unapproved secret content'});
   assert.equal(await f.observe(),1);
   assert.equal((await f.greetings.drain()).sent,1);
   assert.equal(f.sent[0]!.text,'Welcome to our study group');
  }finally{await f.close();}
 });
 test(engine+' removing the saved template revision invalidates consent and blocks sending',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome to Manaratak');
   await f.enable('WELCOME',t.id,t.revision);
   await f.store.transaction(s=>{s.buttonStudio!.templates[0]!.versions=[];});
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'WELCOME')?.enabled,false);
   assert.equal(await f.observe(),0);
   assert.equal((await f.greetings.drain()).sent,0);
  }finally{await f.close();}
 });
 test(engine+' duplicate, stale, malformed and burst join events never multiply greetings',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');
   await f.enable('WELCOME',t.id,t.revision);
   assert.equal(await f.observe(),1);
   assert.equal(await f.observe(),0);
   assert.equal(await f.observe('WELCOME',72,72),0);
   assert.equal(await f.greetings.observe(G,'WELCOME',999,'FAKE',f.now()),0);
   assert.equal(await f.greetings.observe(G,'WELCOME',999,'b3-webhook:greetings:999',NOW-31000),0);
   assert.equal((await f.greetings.drain()).sent,1);
   f.advance(61000);
   assert.equal(await f.observe('WELCOME',73,73),1);
   assert.equal((await f.greetings.drain()).sent,1);
  }finally{await f.close();}
 });
 test(engine+' pending greeting is cancelled if owner turns it off or group approval changes',async()=>{
  for(const cause of ['off','group'] as const){
   const f=await fixture();try{
    const t=await f.create('Welcome','Welcome');
    await f.enable('WELCOME',t.id,t.revision);await f.observe();
    if(cause==='off')assert.equal(await f.greetings.configure(OWNER,G,'WELCOME',false,'',0,f.greetings.epoch(await f.store.snapshot(),G,'WELCOME')),true);
    else await f.store.transaction(s=>{s.chats.find(c=>c.id===G)!.version++;});
    assert.equal((await f.greetings.drain()).sent,0);assert.equal(f.sent.length,0);
   }finally{await f.close();}
  }
 });
 test(engine+' unknown send and started-only attempts never resend after restart',async()=>{
  for(const cause of ['unknown','crash'] as const){
   const f=await fixture();try{
    const t=await f.create('Welcome','Welcome');
    await f.enable('WELCOME',t.id,t.revision);await f.observe();
    if(cause==='unknown')f.sendResult('UNKNOWN_OUTCOME');else await f.store.transaction(s=>{
     const a=s.audit.find(a=>/^greeting:job:[a-f0-9]{64}$/u.test(a.updateKey))!;
     s.audit.push({actorId:OWNER,updateKey:a.updateKey+':started',decision:'ALLOW',reason:'GROUP_GREETING_SEND_STARTED',policyVersion:a.policyVersion,at:f.now()});
    });
    assert.equal((await f.greetings.drain()).sent,0);
    const reopened=new GroupWelcomeFarewell(new BotStore(f.store.file,{engine}),f.policy,
     {send:async()=>{throw Error('unexpected retry');},delete:async()=>{throw Error('unexpected cleanup');}},
     f.now,async()=>true,async()=> 'GRANTED');
    assert.equal((await reopened.drain()).sent,0);
    f.advance(300000);assert.equal((await reopened.cleanup()).deleted,0);
    assert.equal(f.sent.length,cause==='unknown'?1:0);
   }finally{await f.close();}
  }
 });
 test(engine+' unknown delete is terminal, and STOP or missing delete rights pauses without attempting',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');
   await f.enable('WELCOME',t.id,t.revision);await f.observe();await f.greetings.drain();f.advance(300000);
   f.stop();assert.equal((await f.greetings.cleanup()).deleted,0);assert.equal(f.deleted.length,0);
   f.start();f.rights('DENIED');assert.equal((await f.greetings.cleanup()).deleted,0);
   f.rights('GRANTED');f.deleteResult('UNKNOWN_OUTCOME');
   assert.equal((await f.greetings.cleanup()).unresolved,1);
   assert.equal((await f.greetings.cleanup()).deleted,0);assert.equal(f.deleted.length,1);
  }finally{await f.close();}
 });
 test(engine+' consent withdrawal during send makes the result terminal and disallows cleanup',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');await f.enable('WELCOME',t.id,t.revision);await f.observe();
   f.during(async()=>assert.equal(await f.greetings.configure(OWNER,G,'WELCOME',false,'',0,f.greetings.epoch(await f.store.snapshot(),G,'WELCOME')),true));
   assert.equal((await f.greetings.drain()).unresolved,1);
   f.advance(300000);assert.equal((await f.greetings.cleanup()).deleted,0);
   assert.equal(f.sent.length,1);
  }finally{await f.close();}
 });
 test(engine+' STOP pauses greeting send before any Telegram call and resumes only while event is current',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');
   await f.enable('WELCOME',t.id,t.revision);await f.observe();
   f.stop();assert.deepEqual(await f.greetings.drain(),{sent:0,unresolved:0});assert.equal(f.sent.length,0);
   f.start();assert.equal((await f.greetings.drain()).sent,1);
   assert.equal(f.sent.length,1);
  }finally{await f.close();}
 });
 test(engine+' a corrupted own-message receipt cannot authorize any deletion',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');
   await f.enable('WELCOME',t.id,t.revision);await f.observe();assert.equal((await f.greetings.drain()).sent,1);
   await f.store.transaction(s=>{const proof=s.audit.find(a=>a.updateKey.endsWith(':receipt')&&a.updateKey.startsWith('greeting:job:'))!;
    proof.reason='FORGED:'+proof.reason;});
   f.advance(300000);
   assert.equal((await f.greetings.cleanup()).deleted,0);
   assert.equal(f.deleted.length,0);
  }finally{await f.close();}
 });
 test(engine+' stopping a greeting type does not block cleanup of its previously verified own message',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');
   await f.enable('WELCOME',t.id,t.revision);await f.observe();
   assert.equal((await f.greetings.drain()).sent,1);
   assert.equal(await f.greetings.configure(OWNER,G,'WELCOME',false,'',0,
    f.greetings.epoch(await f.store.snapshot(),G,'WELCOME')),true);
   f.advance(300000);assert.equal((await f.greetings.cleanup()).deleted,1);
   assert.deepEqual(f.deleted,[{chatId:G,messageId:601}]);
  }finally{await f.close();}
 });
 test(engine+' a greeting message older than one day is never deleted automatically',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');
   await f.enable('WELCOME',t.id,t.revision);await f.observe();
   await f.greetings.drain();f.advance(86400001);
   assert.equal((await f.greetings.cleanup()).deleted,0);
   assert.equal(f.deleted.length,0);
  }finally{await f.close();}
 });
 test(engine+' owner menu previews and confirms saved studio version separately for welcome and farewell',async()=>{
  const f=await fixture();try{
   const t=await f.create('ترحيب منارتك','أهلاً بك في منارتك!');
   const owner=new TelegramWelcomeOwner(f.store,f.policy,f.greetings,f.now);
   const root=await owner.handle(OWNER,'mi:1:i:09:01'),group=await owner.handle(OWNER,btn(root,G));
   const welcome=await owner.handle(OWNER,btn(group,'الترحيب'));
   const choose=await owner.handle(OWNER,btn(welcome,'اختيار قالب'));
   const preview=await owner.handle(OWNER,btn(choose,'ترحيب منارتك'));
   assert.match(preview!.text,/معاينة/u);assert.equal(f.greetings.policy(await f.store.snapshot(),G,'WELCOME')?.enabled,false);
   const confirm=btn(preview,'تأكيد');assert.ok(await owner.handle(OWNER,confirm));
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'WELCOME')?.templateId,t.id);
   assert.equal(await owner.handle(OWNER,confirm),null);
   const newRoot=await owner.handle(OWNER,'mi:1:i:09:01'),newGroup=await owner.handle(OWNER,btn(newRoot,G));
   const current=await owner.handle(OWNER,btn(newGroup,'الترحيب'));
   const off=await owner.handle(OWNER,btn(current,'إيقاف الترحيب'));
   assert.ok(await owner.handle(OWNER,btn(off,'تأكيد')));
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'WELCOME')?.enabled,false);
  }finally{await f.close();}
 });
 test(engine+' bot-only join or bot departure cannot trigger a human welcome or farewell',async()=>{
  const f=await fixture();try{
   const hi=await f.create('Welcome','Welcome');const bye=await f.create('Bye','Goodbye');
   await f.enable('WELCOME',hi.id,hi.revision);await f.enable('FAREWELL',bye.id,bye.revision);
   const incoming=await f.app.handle({update_id:131,message:{message_id:131,date:f.now()/1000,
    from:{id:100,is_bot:false},chat:{id:Number(G),type:'supergroup'},
    new_chat_members:[{id:301,is_bot:true}]}});
   const outgoing=await f.app.handle({update_id:132,message:{message_id:132,date:f.now()/1000,
    from:{id:100,is_bot:false},chat:{id:Number(G),type:'supergroup'},
    left_chat_member:{id:301,is_bot:true}}});
   assert.equal(incoming.status,'IGNORED');assert.equal(outgoing.status,'IGNORED');
   assert.deepEqual(await f.greetings.drain(),{sent:0,unresolved:0});
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test(engine+' group guide is initially off and no unsolicited Telegram guide is queued',async()=>{
  const f=await fixture();try{
   const t=await f.create('دليل المجموعة','🎓 مجتمع منارتك: دليل المنح والدورات');
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'GUIDE')?.enabled,false);
   const guide=await f.app.handle({update_id:101,message:{message_id:81,date:f.now()/1000,
    from:{id:300,is_bot:false},chat:{id:Number(G),type:'supergroup'},text:'/guide'}});
   assert.equal(guide.status,'IGNORED');
   assert.equal((await f.greetings.drain()).sent,0);
   assert.equal(f.sent.length,0);
   assert.ok(t.id);
  }finally{await f.close();}
 });
 test(engine+' member guide command emits exactly one saved Studio URL message and preserves topic',async()=>{
  const f=await fixture();try{
   const t=await f.create('دليل الطلاب','🎓 دليل منارتك للمنح والدورات مع {التاريخ}','https://study.example.org/guide');
   await f.enable('GUIDE',t.id,t.revision);
   const command=(update_id:number,content:string,topicId?:number)=>({update_id,message:{
    message_id:update_id,date:f.now()/1000,from:{id:300,is_bot:false},
    chat:{id:Number(G),type:'supergroup'},text:content,
    ...(topicId?{message_thread_id:topicId}:{})}});
   const queued=await f.app.handle(command(101,'/guide@ManaratakBot',42));
   assert.equal(queued.status,'IGNORED');assert.equal(queued.reason,'GROUP_GUIDE_QUEUED');
   assert.equal((await f.greetings.drain()).sent,1);
   assert.match(f.sent[0]!.text,/دليل منارتك للمنح والدورات/u);
   assert.deepEqual(f.sent[0]!.buttons,[[{text:'📚 دليل الطلاب',url:'https://study.example.org/guide'}]]);
   assert.equal(f.sent[0]!.topicId,42);
   assert.equal((await f.app.handle(command(102,'/guide'))).reason,'GROUP_GUIDE_RATE_LIMITED_OR_DISABLED');
   assert.equal((await f.greetings.drain()).sent,0);assert.equal(f.sent.length,1);
   f.advance(61000);
   assert.equal((await f.app.handle(command(103,'/guide'))).reason,'GROUP_GUIDE_QUEUED');
   assert.equal((await f.greetings.drain()).sent,1);
   assert.equal(f.sent.length,2);
  }finally{await f.close();}
 });
 test(engine+' guide cannot be triggered through wrong bot mention, forwarded or edited service',async()=>{
  const f=await fixture();try{
   const t=await f.create('دليل الطلاب','مرحبا بطلاب منارتك');
   await f.enable('GUIDE',t.id,t.revision);
   const base={message_id:51,date:f.now()/1000,from:{id:300,is_bot:false},chat:{id:Number(G),type:'supergroup'},text:'/guide'};
   const unrelated=await f.app.handle({update_id:51,message:{...base,text:'/guide@AnotherBot'}});
   assert.notEqual(unrelated.reason,'GROUP_GUIDE_QUEUED');
   const forwarded=await f.app.handle({update_id:52,message:{...base,message_id:52,forward_date:Math.floor(f.now()/1000)}});
   assert.notEqual(forwarded.reason,'GROUP_GUIDE_QUEUED');
   const edited=await f.app.handle({update_id:53,edited_message:{...base,message_id:53}});
   assert.notEqual(edited.reason,'GROUP_GUIDE_QUEUED');
   assert.equal((await f.greetings.drain()).sent,0);assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test(engine+' owner guide menu previews saved version and confirms independently from welcome/farewell',async()=>{
  const f=await fixture();try{
   const t=await f.create('دليل الطلاب','دليل منارتك للطلاب');
   const owner=new TelegramWelcomeOwner(f.store,f.policy,f.greetings,f.now);
   const root=await owner.handle(OWNER,'mi:1:i:09:02');
   assert.match(root!.text,/دليل العضو الجديد/u);
   const group=await owner.handle(OWNER,btn(root,G));
   const editor=await owner.handle(OWNER,btn(group,'دليل العضو'));
   const templates=await owner.handle(OWNER,btn(editor,'اختيار قالب'));
   const preview=await owner.handle(OWNER,btn(templates,'دليل الطلاب'));
   assert.match(preview!.text,/معاينة/u);
   const accept=btn(preview,'تأكيد');
   assert.ok(await owner.handle(OWNER,accept));
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'GUIDE')?.templateId,t.id);
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'WELCOME')?.enabled,false);
   assert.equal(await owner.handle(OWNER,accept),null);
   const reopened=await owner.handle(OWNER,'mi:1:i:09:02');
   const groupAgain=await owner.handle(OWNER,btn(reopened,G));
   const editAgain=await owner.handle(OWNER,btn(groupAgain,'دليل العضو'));
   const off=await owner.handle(OWNER,btn(editAgain,'إيقاف دليل'));
   assert.ok(await owner.handle(OWNER,btn(off,'تأكيد')));
   assert.equal(f.greetings.policy(await f.store.snapshot(),G,'GUIDE')?.enabled,false);
  }finally{await f.close();}
 });
 test(engine+' Telegram join and leave webhook routes enqueue only trusted local greeting events',async()=>{
  const f=await fixture();try{
   const t=await f.create('Welcome','Welcome');
   const bye=await f.create('Bye','Goodbye');
   await f.enable('WELCOME',t.id,t.revision);await f.enable('FAREWELL',bye.id,bye.revision);
   const joinEvent={update_id:41,message:{message_id:41,date:f.now()/1000,from:{id:100,is_bot:false},
    chat:{id:Number(G),type:'supergroup'},new_chat_members:[{id:300,is_bot:false}],message_thread_id:42}};
   const leaveEvent={update_id:42,message:{message_id:42,date:f.now()/1000,from:{id:300,is_bot:false},
    chat:{id:Number(G),type:'supergroup'},left_chat_member:{id:300,is_bot:false}}};
   assert.equal((await f.app.handle(joinEvent)).status,'IGNORED');
   assert.equal((await f.app.handle(leaveEvent)).status,'IGNORED');
   assert.equal((await f.greetings.drain()).sent,2);
   assert.equal(f.sent.filter(x=>x.topicId===42).length,1);
   assert.equal(f.sent.filter(x=>x.text==='Goodbye').length,1);
   const forged=await f.app.handle({update_id:43,message:{...joinEvent.message,message_id:43,
    new_chat_members:[{id:301,is_bot:false}],text:'fake'}});
   assert.equal(forged.status,'DENIED');assert.equal((await f.greetings.drain()).sent,0);
  }finally{await f.close();}
 });
}
