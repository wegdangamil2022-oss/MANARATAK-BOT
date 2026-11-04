import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4ServiceCleanupDispatcher,TelegramBotApiServiceCleanupGateway} from '../src/phase4-service-cleanup.js';
import {phase4CommunityScreen,parsePhase4CommunityCommand} from '../src/phase4-community-ui.js';

const GROUP='-1001234',OWNER='100',MEMBER='300';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-p4-service-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 let now=1_000_000;const clock=()=>now;
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.setPresence(GROUP,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy,clock);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',
  membership:async()=> 'VERIFIED',community,clock});
 const approve=async(kind:'CHANGE_LOG_ON'|'CHANGE_LOG_OFF'|'SERVICE_CLEANUP_ON'|'SERVICE_CLEANUP_OFF'|'SERVICE_CLEANUP_DELAY',
  delayMs?:number)=>{
  const draft=await community.pending(OWNER,{kind,...(delayMs!==undefined?{delayMs}:{})},GROUP);
  return community.approve(OWNER,draft.id);
 };
 return {dir,path,store,policy,community,app,clock,approve,
  advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{force:true,recursive:true})};
}
function serviceUpdate(updateId:number,changes:Record<string,unknown>,date?:number){
 return {update_id:updateId,message:{
  message_id:updateId,chat:{id:Number(GROUP),type:'supergroup',title:'الاسم السابق'},
  from:{id:Number(MEMBER),is_bot:false,first_name:'مُشرف'},
  ...(date===undefined?{}:{date}),...changes}};
}
const memberJoined=()=>({new_chat_members:[{id:301,is_bot:false,first_name:'طالب جديد'}]});
const title=()=>({new_chat_title:'الاسم الجديد <script> &'});
const photo=()=>({new_chat_photo:[{file_id:'AgACAgQAAxkBAAABC12',
 file_unique_id:'QWERTY123456',width:90,height:90}]});
const deletePhoto=()=>({delete_chat_photo:true});
const eventKey=(n:number)=>'b3-webhook:bot-main:'+n;

for(const engine of ['json','sqlite'] as const){
 test('P4 '+engine+': group title/photo changes require explicit owner opt-in, are authenticated and store no titles or photo ids',async()=>{
  const f=await fixture(engine);try{
   const ignored=await f.app().handle(serviceUpdate(901,title()));
   assert.equal(ignored.status,'IGNORED');
   assert.equal((await f.store.snapshot()).phase4Community?.serviceChanges?.length??0,0);
   await f.approve('CHANGE_LOG_ON');
   const changed=await f.app().handle(serviceUpdate(902,title()));
   const changedPhoto=await f.app().handle(serviceUpdate(903,photo()));
   const removedPhoto=await f.app().handle(serviceUpdate(904,deletePhoto()));
   assert.equal(changed.status,'APPLIED');
   assert.equal(changedPhoto.status,'APPLIED');
   assert.equal(removedPhoto.status,'APPLIED');
   const list=await f.community.recentChanges(OWNER,GROUP);
   assert.deepEqual(list.map(x=>x.kind),['PHOTO_REMOVED','PHOTO_CHANGED','TITLE_CHANGED']);
   const raw=JSON.stringify((await f.store.snapshot()).phase4Community);
   assert.equal(raw.includes('الاسم الجديد'),false);
   assert.equal(raw.includes('QWERTY123456'),false);
   assert.equal(raw.includes('file_id'),false);
   await assert.rejects(f.community.recentChanges(MEMBER,GROUP),/COMMUNITY_OWNER_DENIED/);
   assert.equal((await f.app().handle(serviceUpdate(902,title()))).status,'DUPLICATE');
  }finally{await f.close();}
 });
 test('P4 '+engine+': opt-in cleanups are delayed, bounded, idempotent and unchanged if disabled',async()=>{
  const f=await fixture(engine);try{
   await f.app().handle(serviceUpdate(910,memberJoined()));
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length??0,0);
   await f.approve('SERVICE_CLEANUP_ON');
   await f.approve('SERVICE_CLEANUP_DELAY',90000);
   const sent=await f.app().handle(serviceUpdate(911,memberJoined()));
   assert.equal(sent.plan,undefined);
   const queued=(await f.store.snapshot()).phase4Community?.cleanupJobs??[];
   assert.equal(queued.length,1);
   assert.equal(queued[0]?.messageId,911);
   assert.equal(queued[0]?.status,'QUEUED');
   assert.equal(queued[0]?.dueAt,f.clock()+90000);
   assert.equal(JSON.stringify(queued).includes('طالب جديد'),false);
   await assert.rejects(f.community.pending(MEMBER,{kind:'SERVICE_CLEANUP_OFF'},GROUP),/COMMUNITY_OWNER_DENIED/);
  }finally{await f.close();}
 });
 test('P4 '+engine+': cleanup refuses late/edited/forged events; only current authorized service message can be scheduled',async()=>{
  const f=await fixture(engine);try{
   await f.approve('SERVICE_CLEANUP_ON');
   assert.equal((await f.app().handle({...serviceUpdate(920,title()),edited_message:{
    ...serviceUpdate(920,title()).message,edit_date:1
   },message:undefined})).status,'IGNORED');
   const malformed=await f.app().handle(serviceUpdate(921,{new_chat_title:'',new_chat_photo:[{}]}));
   assert.equal(malformed.status,'DENIED');
   const old=await f.app().handle(serviceUpdate(922,memberJoined(),50));
   assert.equal(old.status,'IGNORED');
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length??0,0);
   await f.app().handle(serviceUpdate(923,photo()));
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length,1);
  }finally{await f.close();}
 });
 test('P4 '+engine+': cleanup must check rights and emergency gate, and never replay ambiguous deletes',async()=>{
  const f=await fixture(engine);try{
   await f.approve('SERVICE_CLEANUP_ON');
   await f.app().handle(serviceUpdate(930,memberJoined()));
   const key=(await f.store.snapshot()).phase4Community!.cleanupJobs![0]!.key;
   const calls:{delete:number;rights:number}={delete:0,rights:0};
   const gateway={canDelete:async()=>{calls.rights++;return true;},
    deleteMessage:async()=>{calls.delete++;return 'UNKNOWN_OUTCOME' as const;}};
   let allowed=false;
   const service=new Phase4ServiceCleanupDispatcher(f.store,f.policy,gateway,f.clock,async()=>allowed);
   f.advance(120001);
   assert.equal(await service.dispatch(key),'PAUSED');
   assert.equal(calls.rights,0);
   allowed=true;
   assert.equal(await service.dispatch(key),'UNKNOWN_OUTCOME');
   assert.equal(calls.delete,1);
   assert.equal(await service.dispatch(key),'UNKNOWN_OUTCOME');
   assert.equal(calls.delete,1);
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.[0]?.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}
 });
 test('P4 '+engine+': revoked group or modified configuration makes cleanup impossible',async()=>{
  const f=await fixture(engine);try{
   await f.approve('SERVICE_CLEANUP_ON');
   await f.app().handle(serviceUpdate(940,memberJoined()));
   const key=(await f.store.snapshot()).phase4Community!.cleanupJobs![0]!.key;
   const gateway={canDelete:async()=>true,deleteMessage:async()=>{throw Error('MUST_NOT_DELETE');}};
   const dispatcher=new Phase4ServiceCleanupDispatcher(f.store,f.policy,gateway,f.clock);
   await f.approve('SERVICE_CLEANUP_OFF');
   f.advance(120001);
   assert.equal(await dispatcher.dispatch(key),'SKIPPED');
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.[0]?.status,'SKIPPED');
  }finally{await f.close();}
 });
 test('P4 '+engine+': owner can inspect change log and reviewed service cleanup switches from official section 09',async()=>{
  const f=await fixture(engine);try{
   const root=await phase4CommunityScreen(f.community,OWNER,'mi:1:i:09:04');
   assert.ok(root);
   const setting=await phase4CommunityScreen(f.community,OWNER,'p4c:1:g:'+GROUP);
   assert.match(setting!.text,/الرسائل الخدمية/);
   const change=await phase4CommunityScreen(f.community,OWNER,'p4c:1:t:'+GROUP+':g:1');
   assert.match(change!.text,/تأكيد/);
   const confirm=change!.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('p4c:1:c:'))!;
   await phase4CommunityScreen(f.community,OWNER,confirm.callback_data);
   assert.equal((await f.community.view(OWNER,GROUP)).changeLogEnabled,true);
   const parsed=parsePhase4CommunityCommand('/servicedelay '+GROUP+' 120');
   assert.deepEqual(parsed,{kind:'EDIT',chatId:GROUP,
    request:{kind:'SERVICE_CLEANUP_DELAY',delayMs:120000}});
   await f.app().handle(serviceUpdate(950,title()));
   const history=await phase4CommunityScreen(f.community,OWNER,'p4c:1:h:'+GROUP);
   assert.match(history!.text,/اسم المجموعة/);
  }finally{await f.close();}
 });
}

test('P4 Telegram cleanup gateway checks actual bot administrator delete rights and reads no private message data',async()=>{
 const token='12345:'+('T'.repeat(36)),calls:string[]=[];
 const valid:typeof fetch=async(input,init)=>{
  const url=String(input);calls.push(url.split('/').at(-1)!);
  const body=JSON.parse(String(init?.body)) as {user_id?:number;chat_id:string;message_id?:number};
  assert.equal(body.chat_id,GROUP);
  if(url.endsWith('getChatMember')){
   assert.equal(body.user_id,12345);
   return new Response(JSON.stringify({ok:true,result:{status:'administrator',can_delete_messages:true}}),
    {status:200});
  }
  assert.equal(body.message_id,500);
  return new Response(JSON.stringify({ok:true,result:true}),{status:200});
 };
 const gateway=new TelegramBotApiServiceCleanupGateway(token,valid);
 assert.equal(await gateway.canDelete(GROUP),true);
 assert.equal(await gateway.deleteMessage(GROUP,500),'CONFIRMED');
 assert.deepEqual(calls,['getChatMember','deleteMessage']);
 let deletions=0;
 const denied=new TelegramBotApiServiceCleanupGateway(token,async(_url,init)=>{
  const x=JSON.parse(String(init?.body)) as Record<string,unknown>;
  if(x.message_id!==undefined)deletions++;
  return new Response(JSON.stringify({ok:true,result:{status:'member'}}),{status:200});
 });
 assert.equal(await denied.canDelete(GROUP),false);
 assert.equal(deletions,0);
});
