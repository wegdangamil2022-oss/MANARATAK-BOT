import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectIsolatedModerationRightsReadOnly} from '../src/moderation-trial-rights.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const BOT=123456789,OWNER='100',CHAT='-100123',OTHER='-100234';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-trial-rights-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),safetyFile=join(dir,'safety.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.setPresence(CHAT,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 const backup=async()=>{await BotStore.backupSqlite(stateFile,backupFile);await chmod(backupFile,0o600);};
 const options=()=>({stateFile,backupFile,safetyFile,now:Date.now(),
  staleAfterMs:900_000,trialChatId:CHAT});
 return {dir,stateFile,backupFile,safetyFile,store,policy,backup,options,close:()=>rm(dir,{recursive:true,force:true})};
}
const member=(rights:boolean)=>new Response(JSON.stringify({ok:true,result:{
 status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:rights
}}),{status:200,headers:{'content-type':'application/json'}});
const make=(callback:(count:number)=>Promise<Response>|Response)=>{
 const methods:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const data=JSON.parse(String(init?.body)) as {chat_id:string;user_id:number};
  assert.deepEqual(data,{chat_id:CHAT,user_id:BOT});
  methods.push(method);
  return callback(methods.length);
 }) as typeof fetch;
 return {methods,gateway:new TelegramBotApiModerationGateway(TOKEN,request)};
};
test('STOP plus clean trial scope and two matching verified rights reads are locally advisory PASS',async()=>{
 const f=await fixture();try{
  await f.backup();
  const t=make(()=>member(true));
  const before=await readFile(f.stateFile),anchor=await readFile(f.backupFile);
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.deepEqual(r,{stage:'READ_ONLY_MODERATION_RIGHTS',status:'PASS',
   safety:'STOP',rollback:'MATCH',botRights:'GRANTED',reasons:[]});
  assert.deepEqual(t.methods,['getChatMember','getChatMember']);
  assert.deepEqual(await readFile(f.stateFile),before);
  assert.deepEqual(await readFile(f.backupFile),anchor);
 }finally{await f.close();}
});
test('revoked Telegram restrict right is BLOCKED, with no mutating requests',async()=>{
 const f=await fixture();try{
  await f.backup();
  const t=make(()=>member(false));
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.equal(r.status,'BLOCKED');
  assert.equal(r.botRights,'DENIED');
  assert.deepEqual(r.reasons,['BOT_MODERATION_RIGHTS_DENIED']);
  assert.deepEqual(t.methods,['getChatMember','getChatMember']);
 }finally{await f.close();}
});
test('a grant-to-deny change during sequential rights reads is fail closed',async()=>{
 const f=await fixture();try{
  await f.backup();
  const t=make(i=>member(i===1));
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.equal(r.status,'BLOCKED');assert.equal(r.botRights,'CHANGED');
  assert.deepEqual(r.reasons,['BOT_MODERATION_RIGHTS_CHANGED']);
  assert.deepEqual(t.methods,['getChatMember','getChatMember']);
 }finally{await f.close();}
});
test('uncertain HTTP failure never becomes rights confirmation',async()=>{
 const f=await fixture();try{
  await f.backup();
  const t=make(()=>new Response('timeout',{status:503}));
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.equal(r.status,'BLOCKED');assert.equal(r.botRights,'UNKNOWN');
  assert.deepEqual(r.reasons,['BOT_MODERATION_RIGHTS_UNKNOWN']);
  assert.deepEqual(t.methods,['getChatMember','getChatMember']);
 }finally{await f.close();}
});
test('STOP/RUN mismatch and second moderator-enabled group block before ALL remote reads',async()=>{
 const f=await fixture();try{
  await f.backup();
  const t=make(()=>member(true));
  await writeFile(f.safetyFile,'RUN\n');
  let r=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.equal(r.status,'BLOCKED');assert.equal(r.botRights,'NOT_CHECKED');
  assert.deepEqual(r.reasons,['SAFETY_NOT_STOP']);
  assert.deepEqual(t.methods,[]);
  await writeFile(f.safetyFile,'STOP\n');
  await f.policy.approveChat(OWNER,OTHER,['moderation']);
  await f.backup();
  r=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.equal(r.status,'BLOCKED');assert.equal(r.botRights,'NOT_CHECKED');
  assert.deepEqual(r.reasons,['OTHER_MODERATION_GROUP_APPROVED']);
  assert.deepEqual(t.methods,[]);
 }finally{await f.close();}
});
test('local authority revoked during Telegram lookup cannot yield a trial PASS',async()=>{
 const f=await fixture();try{
  await f.backup();
  const t=make(async()=>{
   await f.policy.revokeChat(OWNER,CHAT);
   return member(true);
  });
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.equal(r.status,'BLOCKED');
  assert.ok(r.reasons.includes('BACKUP_STATE_MISMATCH'));
  assert.deepEqual(t.methods,['getChatMember']);
 }finally{await f.close();}
});
