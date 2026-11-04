import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4GroupProfileDispatcher,TelegramBotApiGroupProfileGateway} from '../src/phase4-group-profile.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen} from '../src/phase4-community-ui.js';
import {defaultCommunityConfig,validCommunityConfig,validCommunityState}
 from '../src/phase4-community-model.js';
const GROUP='-1001122334455',OWNER='100',STUDENT='300';
const PHOTO='AgACAgQAAxkBAAIBFmVQWX9zQVlHdNfVaeayqcpw29KyAAJ2szEbQ1BKUX9xJ-sbl9sQAQADAgADbQADNgQ';
const TOKEN='123456789:'+('A'.repeat(36));
const JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,0xff,0xd9]);
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-photo-upload-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite'),clock=()=>1800000000000;
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);await policy.setPresence(GROUP,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const approve=async(request:Parameters<typeof community.pending>[1])=>
  community.approve(OWNER,(await community.pending(OWNER,request,GROUP)).id);
 return {store,policy,community,approve,file,clock,close:()=>rm(dir,{recursive:true,force:true})};
}
test('WELCOME-005 photo-upload: command has strict group and photo file id boundaries',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/groupphoto '+GROUP+' '+PHOTO),{
  kind:'EDIT',chatId:GROUP,request:{kind:'GROUP_PHOTO_SET',photoFileId:PHOTO}
 });
 for(const command of ['/groupphoto 100 '+PHOTO,
  '/groupphoto '+GROUP+' '+PHOTO+' EXTRA',
  '/groupphoto '+GROUP+' https://evil.example/a.jpg',
  '/groupphoto '+GROUP+' short',
  '/groupphoto '+GROUP+' '+PHOTO+'\nDELETE']){
  assert.equal(parsePhase4CommunityCommand(command),null,command);
 }
});
test('WELCOME-005 photo-upload: malformed persisted jobs cannot carry file ids in wrong states',()=>{
 const valid=defaultCommunityConfig(GROUP);
 assert.equal(validCommunityConfig(valid),true);
 const item={key:'a'.repeat(24),chatId:GROUP,chatVersion:1,policyVersion:2,
  kind:'PHOTO_SET',status:'QUEUED',createdAt:1000,profileEpoch:0,photoFileId:PHOTO};
 const state=(job:unknown)=>({configs:[],drafts:[],receipts:[],profileJobs:[job]});
 assert.equal(validCommunityState(state(item)),true);
 assert.equal(validCommunityState(state({...item,photoFileId:'https://evil.invalid/x'})),false);
 assert.equal(validCommunityState(state({...item,status:'SENDING',attemptId:'a'.repeat(24)})),false);
 assert.equal(validCommunityState(state({...item,kind:'TITLE_SET'})),false);
 assert.equal(validCommunityState(state({...item,status:'QUEUED',photoFileId:undefined})),false);
});
for(const engine of ['json','sqlite'] as const){
 test('WELCOME-005 photo-upload '+engine+': owner opt-in, review, persistence and owner UI before Telegram upload',async()=>{
  const f=await fixture(engine);
  try{
   await assert.rejects(f.community.pending(OWNER,{kind:'GROUP_PHOTO_SET',photoFileId:PHOTO},GROUP),
    /COMMUNITY_PROFILE_DISABLED/);
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await assert.rejects(f.community.pending(STUDENT,{kind:'GROUP_PHOTO_SET',photoFileId:PHOTO},GROUP),
    /COMMUNITY_OWNER_DENIED/);
   const draft=await f.community.pending(OWNER,{kind:'GROUP_PHOTO_SET',photoFileId:PHOTO},GROUP);
   assert.match(f.community.preview(draft),/صورة/u);
   assert.doesNotMatch(f.community.preview(draft),new RegExp(PHOTO));
   assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.length??0,0);
   const config=await f.community.approve(OWNER,draft.id);
   const job=(await f.store.snapshot()).phase4Community!.profileJobs![0]!;
   assert.equal(job.status,'QUEUED');
   assert.equal(job.kind,'PHOTO_SET');
   assert.equal(job.photoFileId,PHOTO);
   assert.equal(config.version,job.policyVersion);
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.profileJobs?.[0]?.photoFileId,PHOTO);
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:p:'+GROUP);
   assert.match(screen?.text??'',/رفع صورة/u);
   assert.doesNotMatch(screen?.text??'',new RegExp(PHOTO));
  }finally{await f.close();}
 });
 test('WELCOME-005 photo-upload '+engine+': claim removes media id before outbound, at-most-once with verified rights',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_PHOTO_SET',photoFileId:PHOTO});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   let calls=0;
   const dispatcher=new Phase4GroupProfileDispatcher(f.store,f.policy,{
    canChangeInfo:async()=>true,setTitle:async()=>{throw Error('wrong operation')},
    removePhoto:async()=>{throw Error('wrong operation')},
    setPhoto:async(chat,fileId)=>{
     calls++;assert.equal(chat,GROUP);assert.equal(fileId,PHOTO);
     assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.[0]?.photoFileId,undefined);
     assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.[0]?.status,'SENDING');
     return 'CONFIRMED' as const;
    }
   },f.clock,async()=>true);
   const results=await Promise.all([dispatcher.dispatch(key),dispatcher.dispatch(key)]);
   assert.deepEqual(results.sort(),['CONFIRMED','UNKNOWN_OUTCOME']);
   assert.equal(calls,1);
   assert.equal(await dispatcher.dispatch(key),'CONFIRMED');
   assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.[0]?.photoFileId,undefined);
  }finally{await f.close();}
 });
 test('WELCOME-005 photo-upload '+engine+': safety STOP and a change in Telegram profile epoch block upload',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_PHOTO_SET',photoFileId:PHOTO});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   let calls=0;
   const gate={canChangeInfo:async()=>true,setTitle:async()=> 'CONFIRMED' as const,
    removePhoto:async()=> 'CONFIRMED' as const,setPhoto:async()=>{calls++;return 'CONFIRMED' as const}};
   assert.equal(await new Phase4GroupProfileDispatcher(f.store,f.policy,gate,f.clock,async()=>false).dispatch(key),
    'PAUSED');
   assert.equal(calls,0);
   await f.community.recordServiceEvent({chatId:GROUP,actorId:STUDENT,messageId:909,
    kind:'PHOTO_CHANGED',updateKey:'b3-webhook:bot-main:909',sentAtMs:f.clock()});
   assert.equal(await new Phase4GroupProfileDispatcher(f.store,f.policy,gate,f.clock,async()=>true).dispatch(key),
    'SKIPPED');
   assert.equal(calls,0);
   assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.[0]?.photoFileId,undefined);
  }finally{await f.close();}
 });
 test('WELCOME-005 photo-upload '+engine+': unknown network outcome never triggers second upload',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_PHOTO_SET',photoFileId:PHOTO});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   let attempts=0;
   const gateway={canChangeInfo:async()=>true,setTitle:async()=> 'CONFIRMED' as const,
    removePhoto:async()=> 'CONFIRMED' as const,setPhoto:async()=>{attempts++;return 'UNKNOWN_OUTCOME' as const}};
   const dispatcher=new Phase4GroupProfileDispatcher(f.store,f.policy,gateway,f.clock,async()=>true);
   assert.equal(await dispatcher.dispatch(key),'UNKNOWN_OUTCOME');
   assert.equal(await dispatcher.dispatch(key),'UNKNOWN_OUTCOME');
   assert.equal(attempts,1);
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.profileJobs?.[0]?.photoFileId,undefined);
  }finally{await f.close();}
 });
}
function mockRequest(options:{filePath?:string;fileSize?:number;body?:Uint8Array;getStatus?:number;
  setStatus?:number;fileStatus?:number}={}){
 const urls:string[]=[],requests:RequestInit[]=[];
 const request=async(url:string|URL|Request,init?:RequestInit)=>{
  urls.push(String(url));requests.push(init??{});
  if(String(url).endsWith('/getFile')){
   return new Response(JSON.stringify({ok:true,result:{file_id:PHOTO,
    file_path:options.filePath??'photos/file_53.jpg',
    file_size:options.fileSize??JPEG.length}}),{status:options.getStatus??200});
  }
  if(String(url).endsWith('/setChatPhoto')){
   assert.equal(init?.method,'POST');
   assert.ok(init?.body instanceof FormData,'setChatPhoto must use binary multipart form, not JSON/file_id');
   const form=init!.body as FormData;
   assert.equal(form.get('chat_id'),GROUP);
   const file=form.get('photo');
   assert.ok(file instanceof Blob);
   assert.equal(file.type,'image/jpeg');
   assert.deepEqual(Buffer.from(await file.arrayBuffer()),JPEG);
   return new Response(JSON.stringify({ok:(options.setStatus??200)===200,result:true}),
    {status:options.setStatus??200});
  }
  if(String(url).includes('/file/bot')){
   return new Response(options.body??JPEG,{status:options.fileStatus??200});
  }
  throw Error('unexpected endpoint');
 };
 return {request:request as typeof fetch,urls,requests};
}
test('WELCOME-005 photo-upload: official getFile re-download and fresh multipart InputFile setChatPhoto',async()=>{
 const fake=mockRequest(),api=new TelegramBotApiGroupProfileGateway(TOKEN,fake.request);
 assert.equal(await api.setPhoto(GROUP,PHOTO),'CONFIRMED');
 assert.equal(fake.urls.length,3);
 assert.match(fake.urls[0]??'',/\/getFile$/u);
 assert.match(fake.urls[1]??'',/\/file\/bot/u);
 assert.match(fake.urls[2]??'',/\/setChatPhoto$/u);
 assert.equal(fake.requests[1]?.redirect,'error');
 assert.equal(fake.requests[2]?.redirect,'error');
});
test('WELCOME-005 photo-upload: file download rejects traversal, unexpected extension and huge input',async()=>{
 for(const bad of ['../../.env','photos/%2e%2e/key.jpg','https://attacker.invalid/x.jpg',
  'photos/photo.png','photos/a%2Fb.jpg','photos/file_name.jpg?x=1','photos/foo\\\\bar.jpg',
  'file_7.jpg','photos/x.jpg#fragment']){
  const fake=mockRequest({filePath:bad}),api=new TelegramBotApiGroupProfileGateway(TOKEN,fake.request);
  assert.equal(await api.setPhoto(GROUP,PHOTO),'FAILED_CONFIRMED',bad);
  assert.equal(fake.urls.length,1,bad);
 }
 const huge=mockRequest({fileSize:10_485_761});
 assert.equal(await new TelegramBotApiGroupProfileGateway(TOKEN,huge.request).setPhoto(GROUP,PHOTO),'FAILED_CONFIRMED');
 assert.equal(huge.urls.length,1);
});
test('WELCOME-005 photo-upload: wrong type, truncated content, 5xx and network errors fail safely',async()=>{
 for(const bytes of [new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a]),new Uint8Array([0xff,0xd8,0xff,0xe0,0xaa,0xaa])]){
  const fake=mockRequest({body:bytes,fileSize:bytes.length});
  assert.equal(await new TelegramBotApiGroupProfileGateway(TOKEN,fake.request).setPhoto(GROUP,PHOTO),
   'FAILED_CONFIRMED');
  assert.equal(fake.urls.length,2);
 }
 const failure=mockRequest({setStatus:503});
 assert.equal(await new TelegramBotApiGroupProfileGateway(TOKEN,failure.request).setPhoto(GROUP,PHOTO),
  'UNKNOWN_OUTCOME');
 const network=new TelegramBotApiGroupProfileGateway(TOKEN,async()=>{throw Error('net')});
 assert.equal(await network.setPhoto(GROUP,PHOTO),'FAILED_CONFIRMED');
});
