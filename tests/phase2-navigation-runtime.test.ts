import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication,telegramWebhookListener} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher,TelegramBotApiTextSender,TelegramBotApiCallbackAcker} from '../src/telegram-replies.js';
import {menuLabels} from '../src/telegram-menu.js';
const NOW=1700000000000,GROUP='-100123',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',SECRET='s'.repeat(40);
type Payload=Record<string,unknown>;
type Wire={chat_id?:string;message_id?:number;message_thread_id?:number;text?:string;callback_query_id?:string;show_alert?:boolean;reply_markup?:{inline_keyboard:{text:string;callback_data:string}[][]}};
for(const engine of ['json','sqlite'] as const)test(engine+' phase-two HTTP runtime covers student, owner, staff, group/topic, replay, expiry and emergency STOP',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'phase2-runtime-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=0,run=true;
 const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
 await policy.approveChat('100',GROUP,['navigation','moderation']);await policy.grant('100','301','chat.manage',GROUP,NOW+600000);
 await education.createCategory('100',{id:'private',scope:'private',title:'مصدر خاص',order:1});await education.createCategory('100',{id:'group',scope:GROUP,title:'مصدر المجموعة',order:1});
 await store.transaction(s=>{s.educationCategories.find(c=>c.id==='group')!.topicVisibility=[{topicId:7,enabled:true}];});
 const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),clock:()=>now,botId:'phase2-runtime',botUsername:'ManaratakBot',ownerMenuMode:'inline',studentMenuMode:'inline',membership:async()=>{throw Error('UNEXPECTED_EXTERNAL_READ');}});
 const deliveries:Wire[]=[],acks:Wire[]=[];
 const request=(async(url:unknown,init:RequestInit)=>{
  const wire=JSON.parse(String(init.body)) as Wire;
  if(String(url).endsWith('/answerCallbackQuery')){acks.push(wire);return Response.json({ok:true,result:true});}
  assert.ok(String(url).endsWith('/sendMessage')||String(url).endsWith('/editMessageText'));
  assert.ok(wire.reply_markup?.inline_keyboard);assert.equal('keyboard' in wire.reply_markup!,false);
  for(const b of wire.reply_markup!.inline_keyboard.flat())assert.ok(Buffer.byteLength(b.callback_data)>0&&Buffer.byteLength(b.callback_data)<=64);
  deliveries.push(wire);return Response.json({ok:true,result:{message_id:wire.message_id??55,chat:{id:Number(wire.chat_id)},...(Number(wire.chat_id)<0?{message_thread_id:7}:{})}});
 }) as typeof fetch;
 const dispatcher=new TelegramReplyDispatcher(store,policy,new TelegramBotApiTextSender(TOKEN,request),()=>now,async()=>run);
 const server=createServer(telegramWebhookListener(app,SECRET,dispatcher,{},async()=>run,new TelegramBotApiCallbackAcker(TOKEN,request)));
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  const post=async(payload:Payload,secret=SECRET)=>{const r=await fetch(base+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(payload)});return {http:r.status,body:await r.json() as {status:string}};};
  const message=(text:string,actor=300,group=false,topic?:number):Payload=>({update_id:++id,message:{message_id:id,from:{id:actor,is_bot:false},chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},text,...(topic?{message_thread_id:topic}:{})}});
  const callback=(data:string,actor=300,group=false,topic?:number):Payload=>({update_id:++id,callback_query:{id:'runtime_'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},...(topic?{message_thread_id:topic}:{})}}});
  const last=()=>deliveries.at(-1)!;
  const choose=(label:string)=>{const b=last().reply_markup!.inline_keyboard.flat().find(b=>b.text===label||b.text.startsWith(label));assert.ok(b,label);return b.callback_data;};
  assert.equal((await post(message('/start'))).body.status,'APPLIED');const home=structuredClone(last());assert.equal(last().message_id,undefined);
  for(const b of home.reply_markup!.inline_keyboard.flat()){
   assert.equal((await post(callback(b.callback_data))).body.status,'APPLIED',b.text);assert.equal(last().message_id,55);
   assert.equal((await post(callback('pn:1:h'))).body.status,'APPLIED');
  }
  await post(message('/start',100));await post(callback(choose(menuLabels.owner),100));await post(callback('mi:1:p:1',100));await post(callback('mi:1:s:09:0',100));assert.equal(last().message_id,55);
  await post(message('/start',301));await post(callback(choose('🛡️ لوحة المشرف'),301));await post(callback(choose('🛡️ '+GROUP),301));assert.ok(last().text!.includes('chat.manage'));
  const beforeDenied=deliveries.length;assert.equal((await post(callback('mi:1:h',300))).body.status,'DENIED');assert.equal(deliveries.length,beforeDenied);assert.equal(acks.at(-1)!.show_alert,true);assert.ok(acks.at(-1)!.text!.includes('غير متاح'));
  assert.equal((await post(callback('mi:1:h',100,true))).body.status,'DENIED');
  assert.equal((await post(message('/categories',300,true,7))).body.status,'APPLIED');const category=choose('مصدر المجموعة');await post(callback(category,300,true,7));assert.equal(last().message_id,55);assert.equal(Number(last().chat_id),Number(GROUP));assert.ok(last().text!.includes('مصدر المجموعة'));assert.equal(last().text!.includes('مصدر خاص'),false);
  assert.equal((await post(callback(category,300,true,8))).body.status,'DENIED');
  const repeated=callback('pn:1:h');await post(repeated);const sent=deliveries.length;assert.equal((await post(repeated)).body.status,'DUPLICATE');assert.equal(deliveries.length,sent);assert.equal(acks.at(-1)!.show_alert,false);
  const expiring=home.reply_markup!.inline_keyboard[0]![0]!.callback_data;now=NOW+120000;assert.equal((await post(callback(expiring))).body.status,'DENIED');assert.equal(acks.at(-1)!.show_alert,true);
  run=false;const snapshot=await store.snapshot(),calls=deliveries.length+acks.length;assert.equal((await post(callback('pn:1:h'))).http,503);assert.deepEqual(await store.snapshot(),snapshot);assert.equal(deliveries.length+acks.length,calls);
  run=true;assert.equal((await post(message('/start'),'wrong')).http,401);assert.equal(deliveries.length+acks.length,calls);
  const final=await store.snapshot();assert.equal(final.moderationOperations.length,0);assert.ok(final.telegramReplyJobs!.every(j=>j.status==='SENT'),JSON.stringify(final.telegramReplyJobs!.filter(j=>j.status!=='SENT')));assert.ok(final.telegramReplyJobs!.every(j=>j.plan===undefined));
 }finally{server.closeAllConnections();if(server.listening){server.close();await once(server,'close');}await rm(dir,{recursive:true,force:true});}
});
