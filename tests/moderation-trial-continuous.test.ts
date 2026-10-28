import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectContinuousModerationTrialReadOnly} from '../src/moderation-trial-continuous.js';

const BOT=123456789,OWNER='100',TARGET='300',CHAT='-100123';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const remote=(value:unknown)=>
 new Response(JSON.stringify({ok:true,result:value}),
 {status:200,headers:{'content-type':'application/json'}});
const bot=(rights=true)=>remote({status:'administrator',
 user:{id:BOT,is_bot:true},can_restrict_members:rights});
const member=(status='member')=>remote({status,
 user:{id:Number(TARGET),is_bot:false}});
const chat=(type='supergroup')=>remote({id:Number(CHAT),type,title:'PRIVATE TRIAL TITLE'});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-combined-trial-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),
  safetyFile=join(dir,'safety.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'}),policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.setPresence(CHAT,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 return {dir,store,policy,stateFile,backupFile,safetyFile,
  options:()=>({stateFile,backupFile,safetyFile,trialChatId:CHAT,now:Date.now(),staleAfterMs:900_000}),
  close:()=>rm(dir,{force:true,recursive:true})};
}
type Call={method:string;user:number|undefined};
function port(handler:(method:string,user:number|undefined,call:Call[])=>Promise<Response>|Response){
 const calls:Call[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const body=JSON.parse(String(init?.body)) as {chat_id:string;user_id?:number};
  assert.equal(body.chat_id,CHAT);
  assert.ok(['getChat','getChatMember'].includes(method),'no mutating Bot API request');
  calls.push({method,user:body.user_id});
  return handler(method,body.user_id,calls);
 }) as typeof fetch;
 return {calls,gateway:new TelegramBotApiModerationGateway(TOKEN,request)};
}
const normal=()=>port((method,user)=>method==='getChat'?chat():user===BOT?bot():member());
const groupReads=(calls:Call[])=>calls.filter(c=>c.method==='getChat').length;
const targetReads=(calls:Call[])=>calls.filter(c=>c.user===Number(TARGET)).length;

test('continuous readiness anchors all three phases and rechecks group identity after member reads',async()=>{
 const f=await fixture();try{
  const t=normal();
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),readFile(f.safetyFile)]);
  const report=await inspectContinuousModerationTrialReadOnly(f.options(),TARGET,t.gateway,OWNER);
  assert.deepEqual(report,{stage:'READ_ONLY_MODERATION_TRIAL',status:'PASS',
   safety:'STOP',rollback:'MATCH',botRights:'GRANTED',
   group:'SUPERGROUP',target:'ELIGIBLE',reasons:[]});
  assert.equal(groupReads(t.calls),4,'must inspect remote group both before AND after target');
  assert.equal(targetReads(t.calls),2);
  assert.equal(t.calls.length,18);
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]),before);
  assert.equal(JSON.stringify(report).includes('PRIVATE TRIAL TITLE'),false);
  assert.equal(JSON.stringify(report).includes(CHAT),false);
 }finally{await f.close();}
});

test('a chat turned into a channel after the first group check cannot inherit trial PASS',async()=>{
 const f=await fixture();try{
  let n=0;
  const t=port((method,user)=>method==='getChat'?chat(++n<=2?'supergroup':'channel'):
   user===BOT?bot():member());
  const result=await inspectContinuousModerationTrialReadOnly(f.options(),TARGET,t.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED','earlier member evidence cannot survive later changed group');
  assert.equal(result.group,'NOT_GROUP');
  assert.deepEqual(result.reasons,['TRIAL_REMOTE_CHAT_NOT_GROUP']);
  assert.equal(groupReads(t.calls),4);
  assert.equal(targetReads(t.calls),2);
 }finally{await f.close();}
});

test('migration from basic group to supergroup between stages refuses the old target clearance',async()=>{
 const f=await fixture();try{
  let n=0;
  const t=port((method,user)=>method==='getChat'?chat(++n<=2?'group':'supergroup'):
   user===BOT?bot():member());
  const result=await inspectContinuousModerationTrialReadOnly(f.options(),TARGET,t.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.deepEqual(result.reasons,['TRIAL_REMOTE_CHAT_KIND_CHANGED']);
 }finally{await f.close();}
});

test('a protected target fails before the final remote group pass and never sends a sanction',async()=>{
 const f=await fixture();try{
  const t=port((method,user)=>method==='getChat'?chat():
   user===BOT?bot():member('administrator'));
  const result=await inspectContinuousModerationTrialReadOnly(f.options(),TARGET,t.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'PROTECTED_OR_UNVERIFIED');
  assert.deepEqual(result.reasons,['TRIAL_TARGET_NOT_VERIFIED_MEMBER']);
  assert.equal(groupReads(t.calls),2,'must not proceed after target protection');
  assert.equal(targetReads(t.calls),2);
 }finally{await f.close();}
});

test('BOT rights revoked after target eligibility blocks before another getChat observation',async()=>{
 const f=await fixture();try{
  let rights=0;
  const t=port((method,user)=>method==='getChat'?chat():
   user===BOT?bot(++rights<=8):member());
  const result=await inspectContinuousModerationTrialReadOnly(f.options(),TARGET,t.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.ok(result.reasons.includes('BOT_MODERATION_RIGHTS_DENIED'));
  assert.equal(groupReads(t.calls),2);
  assert.equal(targetReads(t.calls),2);
 }finally{await f.close();}
});

test('STOP replaced after member eligibility cannot grant final trial PASS',async()=>{
 const f=await fixture();try{
  let targets=0;
  const t=port(async(method,user)=>{
   if(user===Number(TARGET)&&++targets===2){
    const substitute=join(f.dir,'replacement-STOP.flag');
    await writeFile(substitute,'STOP\n',{mode:0o600});
    await rename(substitute,f.safetyFile);
   }
   return method==='getChat'?chat():user===BOT?bot():member();
  });
  const result=await inspectContinuousModerationTrialReadOnly(f.options(),TARGET,t.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.deepEqual(result.reasons,['TRIAL_CHECKPOINT_CHANGED']);
  assert.equal(groupReads(t.calls),2);
 }finally{await f.close();}
});

test('returning a protected owner as nominated target is rejected before remote reads',async()=>{
 const f=await fixture();try{
  let calls=0;
  const t=port(()=>{calls++;throw Error('should not touch network');});
  await assert.rejects(()=>inspectContinuousModerationTrialReadOnly(
   f.options(),OWNER,t.gateway,OWNER),/MODERATION_TRIAL_INVALID_TARGET/);
  assert.equal(calls,0);
 }finally{await f.close();}
});

test('offline isolation failure blocks all Telegram observations',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,'-100456',['moderation']);
  const t=normal();
  const result=await inspectContinuousModerationTrialReadOnly(f.options(),TARGET,t.gateway,OWNER);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.group,'NOT_CHECKED');
  assert.equal(result.target,'NOT_CHECKED');
  assert.equal(t.calls.length,0);
 }finally{await f.close();}
});
