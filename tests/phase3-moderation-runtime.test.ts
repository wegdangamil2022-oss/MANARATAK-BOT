import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {FakeModerationGateway,ModerationService} from '../src/moderation.js';
import {FakePurgeGateway,ModerationPurgeService} from '../src/moderation-purge.js';
import {GroupPermissionLockService} from '../src/group-permission-lock.js';
import {GROUP_PERMISSION_KEYS,type GroupPermissions} from '../src/group-permission-model.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {moderationProtectionEnforcer} from '../src/protection-enforcement.js';
import {TelegramUpdateApplication,telegramWebhookListener} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher,TelegramBotApiTextSender,TelegramBotApiCallbackAcker} from '../src/telegram-replies.js';

const NOW=1700000000000,CHAT='-100123',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',SECRET='s'.repeat(40);
type Wire={chat_id?:string;text?:string;message_id?:number;reply_markup?:{inline_keyboard:{text:string;callback_data:string}[][]}};
for(const engine of ['json','sqlite'] as const)test(engine+' phase-three local HTTP integrates reviewed moderation, permission restoration, protection, purge and STOP',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'phase3-runtime-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=100,run=true,permissionWrites=0;
 const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
 await policy.approveChat('100',CHAT,['moderation','navigation']);await policy.grant('100','200','chat.manage',CHAT,NOW+1000000);
 const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now),purgeGateway=new FakePurgeGateway(),purge=new ModerationPurgeService(store,policy,purgeGateway,()=>now);
 await purge.observe({chatId:CHAT,messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});
 const baseline={...Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])),can_invite_users:false,can_pin_messages:false} as GroupPermissions;let permissions=structuredClone(baseline);
 const groupPermissions=new GroupPermissionLockService(store,policy,{read:async()=>structuredClone(permissions),apply:async(_c,before,after,current)=>{if(!await current())return 'FAILED_CONFIRMED';assert.deepEqual(permissions,before);permissionWrites++;permissions=structuredClone(after);return 'CONFIRMED';}},()=>now);
 const enforcer=moderationProtectionEnforcer(moderation),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),moderation,groupPermissions,purge,protectionEnforcer:enforcer,clock:()=>now,botId:'phase3-runtime',botUsername:'ManaratakBot',ownerMenuMode:'inline',studentMenuMode:'inline',membership:async()=>{throw Error('Unexpected external read');}});
 const deliveries:Wire[]=[];
 const request=(async(url:unknown,init:RequestInit)=>{
  if(String(url).endsWith('/answerCallbackQuery'))return Response.json({ok:true,result:true});
  assert.ok(String(url).endsWith('/sendMessage')||String(url).endsWith('/editMessageText'));const body=JSON.parse(String(init.body)) as Wire;
  assert.ok(body.reply_markup?.inline_keyboard);assert.ok(body.reply_markup.inline_keyboard.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));deliveries.push(body);
  return Response.json({ok:true,result:{message_id:body.message_id??55,chat:{id:Number(body.chat_id)}}});
 }) as typeof fetch;
 const dispatcher=new TelegramReplyDispatcher(store,policy,new TelegramBotApiTextSender(TOKEN,request),()=>now,async()=>run);
 const server=createServer(telegramWebhookListener(app,SECRET,dispatcher,{},async()=>run,new TelegramBotApiCallbackAcker(TOKEN,request)));
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const post=async(payload:unknown)=>{const r=await fetch('http://127.0.0.1:'+address.port+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET},body:JSON.stringify(payload)});return {http:r.status,body:await r.json() as {status:string}};};
  const command=(text:string,actor=200)=>({update_id:++id,message:{message_id:1000+id,chat:{id:Number(CHAT),type:'supergroup'},from:{id:actor,is_bot:false},text,reply_to_message:{message_id:10,date:(NOW-1000)/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}}}});
  const click=(data:string,actor=200)=>({update_id:++id,callback_query:{id:'phase3_'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:actor,type:'private'}}}});
  const choose=(prefix:string)=>{const b=deliveries.at(-1)!.reply_markup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,prefix);return b.callback_data;};
  await post(command('/kick kick_case'));assert.equal(gateway.calls.length,0);assert.equal(deliveries.at(-1)!.chat_id,'200');const kick=choose('mc:1:c:');assert.equal((await post(click(kick,201))).body.status,'DENIED');assert.equal((await post(click(kick))).body.status,'APPLIED');assert.equal(gateway.calls[0]!.action,'KICK');assert.equal((await post(click(kick))).body.status,'DENIED');
  now++;await post(command('/mute timed 10m'));await post(click(choose('mc:1:c:')));assert.equal((await store.snapshot()).moderationReasons[0]!.expiresAt,now+600000);
  now++;await post(command('/unmute timed'));await post(click(choose('mc:1:c:')));assert.equal((await store.snapshot()).moderationReasons[0]!.active,false);
  await post(command('/lock media'));assert.equal(permissionWrites,0);await post(click(choose('lk:1:c:')));assert.equal(permissionWrites,1);assert.equal(permissions.can_send_photos,false);assert.equal(permissions.can_send_messages,true);
  now++;await post(command('/unlock'));await post(click(choose('lk:1:c:')));assert.deepEqual(permissions,baseline);assert.equal(permissionWrites,2);
  const protection=new GroupProtectionPolicyService(store,policy,()=>now,enforcer);assert.equal((await protection.save('100',{chatId:CHAT,revision:1,mode:'ENFORCE',rules:[{id:'spam',kind:'WORD',value:'spam',enabled:true,action:'WARN'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},policy.chatRevision(await store.snapshot(),CHAT),0)).status,'SAVED');
  await post(command('spam',300));assert.equal((await store.snapshot()).warnings.length,1);
  await post(command('/delete'));assert.equal(purgeGateway.calls.length,0);await post(click(choose('pd:1:c:')));assert.equal(purgeGateway.calls.length,1);assert.equal(purgeGateway.calls[0]!.messageId,10);
  run=false;const snapshot=await store.snapshot(),sent=deliveries.length;assert.equal((await post(command('/ban stopped'))).http,503);assert.deepEqual(await store.snapshot(),snapshot);assert.equal(deliveries.length,sent);
  assert.ok((await store.snapshot()).telegramReplyJobs!.every(j=>j.status==='SENT'&&j.plan===undefined));
 }finally{server.closeAllConnections();if(server.listening){server.close();await once(server,'close');}await rm(dir,{recursive:true,force:true});}
});
