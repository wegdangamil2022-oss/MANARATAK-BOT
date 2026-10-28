import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectIsolatedModerationGroupReadOnly} from '../src/moderation-trial-group.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde', BOT=123456789;
const OWNER='100', CHAT='-100123';
const result=(payload:unknown,code=200)=>new Response(
 JSON.stringify({ok:code===200,result:payload}),
 {status:code,headers:{'content-type':'application/json'}});
const rights=(allowed=true)=>result({status:'administrator',
 user:{id:BOT,is_bot:true},can_restrict_members:allowed});
const chat=(type:string,id=Number(CHAT),extra:Record<string,unknown>={})=>
 result({id,type,title:'PRIVATE GROUP TITLE',...extra});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-group-readiness-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),
  safetyFile=join(dir,'switch.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.setPresence(CHAT,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 return {dir,store,policy,stateFile,backupFile,safetyFile,
  options:()=>({stateFile,backupFile,safetyFile,trialChatId:CHAT,now:Date.now(),staleAfterMs:900_000}),
  close:()=>rm(dir,{recursive:true,force:true})};
}
function adapter(handler:(method:string,count:number)=>Promise<Response>|Response){
 const calls:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  calls.push(method);
  const body=JSON.parse(String(init?.body)) as {chat_id:string;user_id?:number};
  assert.equal(body.chat_id,CHAT);
  assert.ok(method==='getChat'||method==='getChatMember',
   'trial read-only probe must not invoke mutation methods');
  if(method==='getChat')assert.equal('user_id' in body,false);
  else assert.equal(body.user_id,BOT);
  return handler(method,calls.filter(x=>x===method).length);
 }) as typeof fetch;
 return {gateway:new TelegramBotApiModerationGateway(TOKEN,request),calls};
}
const good=(type='supergroup')=>adapter(method=>method==='getChat'?chat(type):rights());
const full=['getChatMember','getChatMember','getChat','getChatMember','getChat','getChatMember'];

test('isolated STOP-backed supergroup identity is verified twice with refreshed Telegram bot rights',async()=>{
 const f=await fixture();try{
  const port=good();
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),readFile(f.safetyFile)]);
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.deepEqual(report,{stage:'READ_ONLY_MODERATION_GROUP',status:'PASS',
   safety:'STOP',rollback:'MATCH',botRights:'GRANTED',group:'SUPERGROUP',reasons:[]});
  assert.deepEqual(port.calls,full);
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]),before);
 }finally{await f.close();}
});
test('basic Telegram group is also accepted, but channel is never a group',async()=>{
 for(const [type,expected,status] of [
  ['group','GROUP','PASS'],['channel','NOT_GROUP','BLOCKED'],
  ['private','NOT_GROUP','BLOCKED']] as const){
  const f=await fixture();try{
   const port=good(type);
   const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
   assert.equal(report.status,status);
   assert.equal(report.group,expected);
   assert.deepEqual(port.calls,full);
   if(type!=='group')assert.deepEqual(report.reasons,['TRIAL_REMOTE_CHAT_NOT_GROUP']);
  }finally{await f.close();}
 }
});
test('returned remote chat ID mismatch blocks even a purported supergroup',async()=>{
 const f=await fixture();try{
  const port=adapter(method=>method==='getChat'?chat('supergroup',-100456):rights());
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.group,'UNKNOWN');
  assert.deepEqual(report.reasons,['TRIAL_REMOTE_CHAT_UNKNOWN']);
  assert.equal(JSON.stringify(report).includes('-100456'),false);
 }finally{await f.close();}
});
test('Telegram group to supergroup migration marker is not accepted as stable original identity',async()=>{
 const f=await fixture();try{
  const port=adapter(method=>method==='getChat'?
   chat('group',Number(CHAT),{migrated_to_chat_id:-100456}):rights());
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.group,'UNKNOWN');
 }finally{await f.close();}
});
test('remote group type changed during sequential observations is blocked',async()=>{
 const f=await fixture();try{
  const port=adapter((method,n)=>method==='getChat'?
   chat(n===1?'group':'supergroup'):rights());
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.group,'CHANGED');
  assert.deepEqual(report.reasons,['TRIAL_REMOTE_CHAT_KIND_CHANGED']);
  assert.deepEqual(port.calls,full);
 }finally{await f.close();}
});
test('unknown first remote group response followed by known supergroup cannot be promoted',async()=>{
 const f=await fixture();try{
  const port=adapter((method,n)=>method==='getChat'?
   n===1?new Response('network unavailable',{status:503}):chat('supergroup'):rights());
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.group,'CHANGED');
 }finally{await f.close();}
});
test('bot restriction right lost after first chat read stops before second getChat',async()=>{
 const f=await fixture();try{
  const port=adapter((method,n)=>method==='getChat'?
   chat('supergroup'):rights(n<=2));
  // Rights read #3 (after first getChat) is DENIED.
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.group,'NOT_CHECKED');
  assert.deepEqual(report.reasons,['BOT_MODERATION_RIGHTS_CHANGED']);
  assert.deepEqual(port.calls,full.slice(0,4));
 }finally{await f.close();}
});
test('switch to RUN during first group lookup blocks before further remote calls',async()=>{
 const f=await fixture();try{
  const port=adapter(async method=>{
   if(method==='getChat')await writeFile(f.safetyFile,'RUN\n');
   return method==='getChat'?chat('supergroup'):rights();
  });
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.reasons.includes('SAFETY_NOT_STOP'));
  assert.deepEqual(port.calls,full.slice(0,3));
 }finally{await f.close();}
});
test('replaced same-content STOP inode blocks even when all remote data matches',async()=>{
 const f=await fixture();try{
  const port=adapter(async method=>{
   if(method==='getChat'){
    const replacement=join(f.dir,'new-switch.flag');
    await writeFile(replacement,'STOP\n',{mode:0o600});
    await rename(replacement,f.safetyFile);
   }
   return method==='getChat'?chat('group'):rights();
  });
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['TRIAL_CHECKPOINT_CHANGED']);
  assert.deepEqual(port.calls,full.slice(0,3));
 }finally{await f.close();}
});
test('extra approved group refuses EVERY Telegram network observation',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,'-100456',['moderation']);
  const port=adapter(()=>{throw Error('SHOULD_NOT_CONTACT_TELEGRAM');});
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),port.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.group,'NOT_CHECKED');
  assert.deepEqual(port.calls,[]);
 }finally{await f.close();}
});
test('structural fake group reader is not trusted despite claimed TELEGRAM_API provenance',async()=>{
 const f=await fixture();try{
  let reads=0;
  const fake={inspectBotModerationRights:async()=>{reads++;return 'GRANTED';},
   inspectTrialGroupKind:async()=>{reads++;return 'SUPERGROUP';},
   attemptGateway:'TELEGRAM_API'};
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),
   fake as unknown as TelegramBotApiModerationGateway);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.group,'NOT_CHECKED');
  assert.equal(reads,0);
 }finally{await f.close();}
});
test('method shadowing of getChat reader while Telegram rights await cannot grant PASS',async()=>{
 const f=await fixture();try{
  let gateway!:TelegramBotApiModerationGateway;
  const port=adapter(method=>method==='getChat'?chat('supergroup'):rights());
  gateway=port.gateway;
  // Shadow immediately after constructing; an official gateway brand alone is not a proof.
  gateway.inspectTrialGroupKind=async()=> 'SUPERGROUP';
  const report=await inspectIsolatedModerationGroupReadOnly(f.options(),gateway);
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['BOT_MODERATION_GATEWAY_UNTRUSTED']);
  assert.deepEqual(port.calls,['getChatMember','getChatMember']);
 }finally{await f.close();}
});
test('raw getChat observation does not accept unexpected payload shape or wrong identity',async()=>{
 const cases:[[unknown,string],...[unknown,string][]]=[
  [{id:Number(CHAT),type:'supergroup'},'SUPERGROUP'],
  [{id:Number(CHAT),type:'group'},'GROUP'],
  [{id:Number(CHAT),type:'channel'},'NOT_GROUP'],
  [{id:-100456,type:'supergroup'},'UNKNOWN'],
  [{id:String(CHAT),type:'supergroup'},'UNKNOWN'],
  [{id:Number(CHAT),type:'group',migrated_to_chat_id:-100456},'UNKNOWN'],
  [{id:Number(CHAT),type:'other'},'UNKNOWN'],
  [true,'UNKNOWN']
 ];
 for(const [value,expected] of cases){
  const port=adapter(method=>method==='getChat'?result(value):rights());
  assert.equal(await port.gateway.inspectTrialGroupKind(CHAT),expected);
  assert.deepEqual(port.calls,['getChat']);
 }
});
