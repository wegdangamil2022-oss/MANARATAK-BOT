import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectIsolatedModerationTargetReadOnly} from '../src/moderation-trial-target.js';

const BOT=123456789, OWNER='100', CHAT='-100123', TARGET='300';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const response=(status:string,id:number,more:Record<string,unknown>={})=>
 new Response(JSON.stringify({ok:true,result:{status,user:{
  id,is_bot:id===BOT},...more}}),{status:200,headers:{'content-type':'application/json'}});
const bot=(granted=true)=>response('administrator',BOT,{can_restrict_members:granted});
const member=(status='member')=>response(status,Number(TARGET));

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-moderation-target-readonly-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),
  safetyFile=join(dir,'safety.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.setPresence(CHAT,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 const options=()=>({stateFile,backupFile,safetyFile,trialChatId:CHAT,
   staleAfterMs:900_000,now:Date.now()});
 return {dir,store,policy,stateFile,backupFile,safetyFile,options,
  close:()=>rm(dir,{recursive:true,force:true})};
}
function gateway(react:(body:{user_id:number},at:number)=>Response|Promise<Response>){
 const calls:{method:string;user_id:number}[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const body=JSON.parse(String(init?.body)) as {chat_id:string;user_id:number};
  calls.push({method,user_id:body.user_id});
  assert.equal(method,'getChatMember','read-only inspection cannot sanction');
  assert.equal(body.chat_id,CHAT);
  return react(body,calls.length);
 }) as typeof fetch;
 return {gateway:new TelegramBotApiModerationGateway(TOKEN,request),calls};
}
const ids=[BOT,BOT,Number(TARGET),BOT,Number(TARGET),BOT];

test('isolated STOP-backed target eligibility completes with double member and fresh rights reads, without writes',async()=>{
 const f=await fixture();try{
  const port=gateway(body=>body.user_id===BOT?bot():member());
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),readFile(f.safetyFile)]);
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.deepEqual(result,{stage:'READ_ONLY_MODERATION_TARGET',
   status:'PASS',safety:'STOP',rollback:'MATCH',botRights:'GRANTED',
   target:'ELIGIBLE',reasons:[]});
  assert.deepEqual(port.calls.map(c=>c.user_id),ids);
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]),before);
 }finally{await f.close();}
});
test('administrator target is protected and never yields advisory eligibility',async()=>{
 const f=await fixture();try{
  const port=gateway(body=>body.user_id===BOT?bot():member('administrator'));
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'PROTECTED_OR_UNVERIFIED');
  assert.deepEqual(result.reasons,['TRIAL_TARGET_NOT_VERIFIED_MEMBER']);
  assert.deepEqual(port.calls.map(c=>c.user_id),ids);
 }finally{await f.close();}
});
test('target status change between two Telegram reads is blocked',async()=>{
 const f=await fixture();try{
  let reads=0;
  const port=gateway(body=>body.user_id===BOT?bot():member(++reads===1?'member':'administrator'));
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'CHANGED');
  assert.deepEqual(result.reasons,['TRIAL_TARGET_STATUS_CHANGED']);
  assert.deepEqual(port.calls.map(c=>c.user_id),ids);
 }finally{await f.close();}
});
test('unverified network response for target fails closed even if second read appears normal',async()=>{
 const f=await fixture();try{
  let targetReads=0;
  const port=gateway(body=>{
   if(body.user_id===BOT)return bot();
   return ++targetReads===1?new Response('server error',{status:503}):member();
  });
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'CHANGED');
  assert.deepEqual(result.reasons,['TRIAL_TARGET_STATUS_CHANGED']);
 }finally{await f.close();}
});
test('bot permission revoked after first member read blocks before another target read',async()=>{
 const f=await fixture();try{
  let rightsReads=0;
  const port=gateway(body=>body.user_id===BOT?bot(++rightsReads<=2):member());
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.deepEqual(result.reasons,['BOT_MODERATION_RIGHTS_CHANGED']);
  assert.deepEqual(port.calls.map(c=>c.user_id),ids.slice(0,4));
 }finally{await f.close();}
});
test('STOP flipped while reading target stops all subsequent Telegram calls',async()=>{
 const f=await fixture();try{
  const port=gateway(async body=>{
   if(body.user_id===Number(TARGET))await writeFile(f.safetyFile,'RUN\n');
   return body.user_id===BOT?bot():member();
  });
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.ok(result.reasons.includes('SAFETY_NOT_STOP'));
  assert.deepEqual(port.calls.map(c=>c.user_id),ids.slice(0,3));
 }finally{await f.close();}
});
test('replaced same-content STOP inode during member read cannot inherit PASS',async()=>{
 const f=await fixture();try{
  const port=gateway(async body=>{
   if(body.user_id===Number(TARGET)){
    const tmp=join(f.dir,'another-stop.flag');
    await writeFile(tmp,'STOP\n',{mode:0o600});
    await rename(tmp,f.safetyFile);
   }
   return body.user_id===BOT?bot():member();
  });
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.deepEqual(result.reasons,['TRIAL_CHECKPOINT_CHANGED']);
  assert.deepEqual(port.calls.map(c=>c.user_id),ids.slice(0,3));
 }finally{await f.close();}
});
test('extra approved group forbids every Telegram rights and member read',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,'-100456',['moderation']);
  const port=gateway(()=>{throw Error('must not read');});
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,port.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.deepEqual(port.calls,[]);
 }finally{await f.close();}
});
test('untrusted structural fake cannot produce target eligibility or remote requests',async()=>{
 const f=await fixture();try{
  let invoked=0;
  const spoof={
   inspectBotModerationRights:async()=>{invoked++;return 'GRANTED' as const;},
   isProtected:async()=>{invoked++;return false;},
   attemptGateway:'TELEGRAM_API'
  };
  const result=await inspectIsolatedModerationTargetReadOnly(f.options(),TARGET,
    spoof as unknown as TelegramBotApiModerationGateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.equal(invoked,0);
 }finally{await f.close();}
});
test('invalid member ID is rejected before reading filesystem or contacting Telegram',async()=>{
 const port=gateway(()=>{throw Error('must not read');});
 for(const bad of ['0','-100','01','300/other','9007199254740992']){
  await assert.rejects(()=>inspectIsolatedModerationTargetReadOnly({
   stateFile:'/never/sent.sqlite',backupFile:'/never/backup.sqlite',
   safetyFile:'/never/stop.flag',trialChatId:CHAT,
   staleAfterMs:900_000,now:Date.now()},bad,port.gateway,OWNER),
   /MODERATION_TRIAL_INVALID_TARGET/);
 }
 assert.deepEqual(port.calls,[]);
});

test('owner identity is required and owner cannot be a selected target even if remote says member',async()=>{
 const port=gateway(()=>{throw Error('remote should not happen');});
 const options={stateFile:'/never/sent.sqlite',backupFile:'/never/backup.sqlite',
  safetyFile:'/never/stop.flag',trialChatId:CHAT,staleAfterMs:900_000,
  now:Date.now()};
 for(const owner of ['', '00','-100']){
  await assert.rejects(()=>inspectIsolatedModerationTargetReadOnly(options,
   TARGET,port.gateway,owner),/MODERATION_TRIAL_INVALID_TARGET/);
 }
 await assert.rejects(()=>inspectIsolatedModerationTargetReadOnly(options,
  OWNER,port.gateway,OWNER),/MODERATION_TRIAL_INVALID_TARGET/);
 assert.deepEqual(port.calls,[]);
});
