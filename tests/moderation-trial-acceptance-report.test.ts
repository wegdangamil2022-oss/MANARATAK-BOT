import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {buildModerationTrialAcceptanceReport,
 inspectModerationTrialAcceptanceReadOnly} from '../src/moderation-trial-acceptance-report.js';
import type {ContinuousModerationTrialReadOnlyReport} from '../src/moderation-trial-continuous.js';

const BOT=123456789,OWNER='100',CHAT='-100123',TARGET='300';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const json=(value:unknown)=>new Response(JSON.stringify({ok:true,result:value}),
 {status:200,headers:{'content-type':'application/json'}});
const member=(id:number,status='member',restrict=true)=>json({
 status,user:{id,is_bot:id===BOT},
 ...(id===BOT?{can_restrict_members:restrict}:{})
});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-advisory-acceptance-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),
  safetyFile=join(dir,'operator-stop.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.setPresence(CHAT,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 return {dir,stateFile,backupFile,safetyFile,store,policy,
  options:()=>({stateFile,backupFile,safetyFile,trialChatId:CHAT,
   now:Date.now(),staleAfterMs:900_000}),
  close:()=>rm(dir,{recursive:true,force:true})};
}
function gateway(callback:(method:string,user:number|undefined,n:number)=>Promise<Response>|Response){
 const calls:{method:string;user:number|undefined}[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const body=JSON.parse(String(init?.body)) as {chat_id:string;user_id?:number};
  assert.equal(body.chat_id,CHAT);
  assert.ok(['getChat','getChatMember'].includes(method),
   'acceptance command is observational: no Telegram mutations');
  calls.push({method,user:body.user_id});
  return callback(method,body.user_id,calls.length);
 }) as typeof fetch;
 return {calls,gateway:new TelegramBotApiModerationGateway(TOKEN,request)};
}
const stable=()=>gateway((method,user)=>method==='getChat'?
 json({id:Number(CHAT),type:'supergroup',title:'PRIVATE TRIAL GROUP'}):
 member(user!,user===BOT?'administrator':'member'));
const PASS:ContinuousModerationTrialReadOnlyReport={
 stage:'READ_ONLY_MODERATION_TRIAL',status:'PASS',
 safety:'STOP',rollback:'MATCH',botRights:'GRANTED',
 group:'SUPERGROUP',target:'ELIGIBLE',reasons:[]
};
const mandatory=[
 'ISOLATED_TEST_GROUP_CONFIRMATION',
 'VOLUNTEER_MEMBER_CONSENT',
 'RESTORE_AND_REVERSAL_PLAN_REVIEW',
 'OWNER_EXPLICIT_TRIAL_APPROVAL'
];
test('clean unified report is TECHNICAL_PASS but explicitly NOT permission to arm live moderation',async()=>{
 const f=await fixture();try{
  const t=stable();
  const before=await Promise.all([readFile(f.stateFile),
   readFile(f.backupFile),readFile(f.safetyFile)]);
  const report=await inspectModerationTrialAcceptanceReadOnly(
   f.options(),TARGET,t.gateway,OWNER);
  assert.deepEqual(report,{
   stage:'READ_ONLY_MODERATION_ACCEPTANCE',status:'TECHNICAL_PASS',
   safety:'STOP',rollback:'MATCH',botRights:'GRANTED',
   group:'SUPERGROUP',target:'ELIGIBLE',reasons:[],
   operatorChecks:mandatory,operatorApproved:false,
   liveModeration:'DISARMED',authorizedToSendSanctions:false
  });
  assert.equal(t.calls.length,18);
  assert.equal(t.calls.filter(x=>x.method==='getChat').length,4);
  assert.equal(t.calls.filter(x=>x.user===Number(TARGET)).length,2);
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]),before);
  const text=JSON.stringify(report);
  for(const secret of [TOKEN,CHAT,TARGET,OWNER,f.dir,'PRIVATE TRIAL GROUP'])
   assert.equal(text.includes(secret),false);
 }finally{await f.close();}
});
test('a forged PASS with RUN, broken backup, missing rights or unsafe group cannot become a technical PASS',()=>{
 const contradictory=[
  {...PASS,safety:'RUN' as const},
  {...PASS,rollback:'MISMATCH' as const},
  {...PASS,botRights:'DENIED' as const},
  {...PASS,group:'NOT_GROUP' as const},
  {...PASS,target:'NOT_CHECKED' as const},
  {...PASS,reasons:['TRIAL_CHECKPOINT_CHANGED'] as ContinuousModerationTrialReadOnlyReport['reasons']}
 ];
 for(const row of contradictory){
  const report=buildModerationTrialAcceptanceReport(row);
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['TRIAL_ACCEPTANCE_EVIDENCE_INCONSISTENT']);
  assert.equal(report.authorizedToSendSanctions,false);
  assert.equal(report.operatorApproved,false);
 }
});
test('nominally passing evidence with a non-boolean or unexpected state cannot be promoted at runtime',()=>{
 const forged={...PASS,status:'PASS',botRights:'GRANTED',
  group:'SUPERGROUP',target:'ELIGIBLE',reasons:[],
  safety:'STOP',rollback:'MATCH'};
 const corrupted={...forged,reasons:'not-an-array'};
 const report=buildModerationTrialAcceptanceReport(
  corrupted as unknown as ContinuousModerationTrialReadOnlyReport);
 assert.equal(report.status,'BLOCKED');
 assert.deepEqual(report.reasons,['TRIAL_ACCEPTANCE_EVIDENCE_INCONSISTENT']);
});
test('blocked existing continuous report preserves safe static reason and still never authorizes sanctions',()=>{
 const blocked:ContinuousModerationTrialReadOnlyReport={
  ...PASS,status:'BLOCKED',group:'NOT_GROUP',target:'NOT_CHECKED',
  reasons:['TRIAL_REMOTE_CHAT_NOT_GROUP']
 };
 const report=buildModerationTrialAcceptanceReport(blocked);
 assert.equal(report.status,'BLOCKED');
 assert.deepEqual(report.reasons,['TRIAL_REMOTE_CHAT_NOT_GROUP']);
 assert.equal(report.liveModeration,'DISARMED');
 assert.deepEqual(report.operatorChecks,mandatory);
});
test('late Telegram group conversion to channel blocks unified report, without exposing group title',async()=>{
 const f=await fixture();try{
  let reads=0;
  const t=gateway((method,user)=>method==='getChat'?
   json({id:Number(CHAT),type:++reads>2?'channel':'supergroup',title:'SECRET CHANNEL'}):
   member(user!,user===BOT?'administrator':'member'));
  const report=await inspectModerationTrialAcceptanceReadOnly(
   f.options(),TARGET,t.gateway,OWNER);
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['TRIAL_REMOTE_CHAT_NOT_GROUP']);
  assert.equal(report.group,'NOT_GROUP');
  assert.equal(report.authorizedToSendSanctions,false);
  assert.equal(JSON.stringify(report).includes('SECRET CHANNEL'),false);
 }finally{await f.close();}
});
test('protected Telegram moderator as target blocks unified acceptance',async()=>{
 const f=await fixture();try{
  const t=gateway((method,user)=>method==='getChat'?
   json({id:Number(CHAT),type:'supergroup'}):
   member(user!,user===BOT?'administrator':'administrator'));
  const report=await inspectModerationTrialAcceptanceReadOnly(
   f.options(),TARGET,t.gateway,OWNER);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.target,'PROTECTED_OR_UNVERIFIED');
  assert.deepEqual(report.reasons,['TRIAL_TARGET_NOT_VERIFIED_MEMBER']);
 }finally{await f.close();}
});
test('owner target and invalid owner are rejected before any filesystem or remote access',async()=>{
 const f=await fixture();try{
  const t=stable();
  for(const [target,owner] of [[OWNER,OWNER],[TARGET,'0'],['01',OWNER]]){
   await assert.rejects(()=>inspectModerationTrialAcceptanceReadOnly(
    f.options(),target!,t.gateway,owner!),/MODERATION_TRIAL_INVALID_TARGET/);
  }
  assert.equal(t.calls.length,0);
 }finally{await f.close();}
});
test('STOP inode replacement while target is probed blocks the receipt',async()=>{
 const f=await fixture();try{
  let replaced=false;
  const t=gateway(async(method,user)=>{
   if(user===Number(TARGET)&&!replaced){
    replaced=true;
    const tmp=join(f.dir,'different-stop.flag');
    await writeFile(tmp,'STOP\n',{mode:0o600});
    await rename(tmp,f.safetyFile);
   }
   return method==='getChat'?json({id:Number(CHAT),type:'supergroup'}):member(user!,user===BOT?'administrator':'member');
  });
  const report=await inspectModerationTrialAcceptanceReadOnly(
   f.options(),TARGET,t.gateway,OWNER);
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['TRIAL_CHECKPOINT_CHANGED']);
  assert.equal(report.authorizedToSendSanctions,false);
 }finally{await f.close();}
});
test('second approved moderation chat blocks before any remote HTTP call',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,'-100456',['moderation']);
  const t=stable();
  const report=await inspectModerationTrialAcceptanceReadOnly(
   f.options(),TARGET,t.gateway,OWNER);
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.reasons.includes('BACKUP_STATE_MISMATCH'));
  assert.equal(t.calls.length,0);
 }finally{await f.close();}
});
const script=fileURLToPath(new URL('../src/moderation-trial-acceptance-cli.js',import.meta.url));
const argv=['--offline-only','--state','/secret/path/current.sqlite',
 '--backup','/secret/path/rollback.sqlite','--safety','/secret/path/stop.flag',
 '--stale-ms','900000','--trial-chat',CHAT,'--trial-target',TARGET];
test('operator CLI denies missing params, missing token and owner-target requests without secrets',()=>{
 const env={...process.env,TELEGRAM_BOT_TOKEN:TOKEN,BOT_OWNER_ID:OWNER};
 const runs=[
  spawnSync(process.execPath,[script],{encoding:'utf8',env}),
  spawnSync(process.execPath,[script,...argv],{encoding:'utf8',
   env:{...env,TELEGRAM_BOT_TOKEN:''}}),
  spawnSync(process.execPath,[script,...argv.slice(0,-1),OWNER],{encoding:'utf8',env})
 ];
 assert.equal(runs.length,3);
 for(const run of runs){
  assert.equal(run.status,1);
  assert.equal(run.stdout,'');
  for(const secret of [TOKEN,CHAT,'/secret/path',OWNER]){
   assert.equal(run.stderr.includes(secret),false);
  }
  assert.ok(run.stderr.startsWith('MANARATAK_MODERATION_ACCEPTANCE_'));
 }
});
