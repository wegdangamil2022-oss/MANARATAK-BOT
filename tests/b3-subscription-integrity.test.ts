import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,readFile,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {inspectSubscriptionIntegrityReadOnly} from '../src/subscription-integrity.js';
const OWNER='100',GROUP='-100123',CH1='-100201',CH2='-100202';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-subscription-audit-'));
 const file=join(dir,'state.sqlite'),store=new BotStore(file,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 for(const id of [GROUP,CH1,CH2])await policy.approveChat(OWNER,id,['verification','navigation']);
 await store.transaction(s=>{
  s.subscriptionRequirements.push({chatId:GROUP,mode:'ALL',channelIds:[CH1,CH2],version:1});
 });
 await chmod(file,0o600);
 return {dir,file,store,policy,close:()=>rm(dir,{recursive:true,force:true})};
}
const cli=(file:string,extra:string[]=[])=>spawnSync(process.execPath,[
 'dist/src/subscription-integrity-cli.js','--offline-only','--state',file,...extra
 ],{encoding:'utf8',timeout:15_000,
 env:{...process.env,TELEGRAM_BOT_TOKEN:'do-not-use-token',TELEGRAM_ENABLED:'false'}});
test('offline mandatory-channel integrity audit reports healthy authorized rules with no file mutation',async()=>{
 const f=await fixture();try{
  const bytes=await readFile(f.file),before=await f.store.snapshot();
  const result=await inspectSubscriptionIntegrityReadOnly(f.file);
  assert.deepEqual(result,{
   stage:'OFFLINE_ONLY',status:'PASS',rules:1,activeRules:1,inactiveRules:0,
   invalidRules:0,invalidGroups:0,invalidChannels:0,duplicateChannels:0,
   overLimitRules:0,reasons:[]
  });
  assert.deepEqual(await readFile(f.file),bytes);
  assert.deepEqual(await f.store.snapshot(),before);
  assert.equal(JSON.stringify(result).includes(GROUP),false);
  assert.equal(JSON.stringify(result).includes(CH1),false);
 }finally{await f.close();}
});
test('inactive rule after owner pause is not erroneously considered an active mandatory obligation',async()=>{
 const f=await fixture();try{
  await f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,1,1);
  const result=await inspectSubscriptionIntegrityReadOnly(f.file);
  assert.equal(result.status,'PASS');assert.equal(result.inactiveRules,1);
  assert.equal(result.activeRules,0);assert.equal(result.invalidChannels,0);
 }finally{await f.close();}
});
test('inconsistent legacy active rule with revoked group blocks operator audit without disclosing group identity',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.chats.find(x=>x.id===GROUP)!.approved=false;});
  const result=await inspectSubscriptionIntegrityReadOnly(f.file);
  assert.equal(result.status,'BLOCKED');assert.equal(result.invalidGroups,1);
  assert.deepEqual(result.reasons,['GROUP_NOT_VERIFIABLE']);
  assert.equal(JSON.stringify(result).includes(GROUP),false);
 }finally{await f.close();}
});
test('legacy active rule missing mandatory channel rights fails closed, even when remaining channel remains approved',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.chats.find(x=>x.id===CH2)!.scopes=['navigation']);
  const result=await inspectSubscriptionIntegrityReadOnly(f.file);
  assert.equal(result.status,'BLOCKED');assert.equal(result.invalidChannels,1);
  assert.ok(result.reasons.includes('CHANNEL_NOT_VERIFIABLE'));
  assert.equal(result.activeRules,1);
 }finally{await f.close();}
});
test('noncanonical IDs, duplicates, too many channels and mode/version corruption yield bounded sanitized reasons',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   const cfg=s.subscriptionRequirements[0]!;
   cfg.channelIds=[CH1,CH1,...Array.from({length:9},(_,i)=>'-100'+(500+i)),'not-a-channel'];
   cfg.mode='INVALID' as 'ALL';
   cfg.version=0;
  });
  const result=await inspectSubscriptionIntegrityReadOnly(f.file);
  assert.equal(result.status,'BLOCKED');assert.equal(result.rules,1);
  assert.equal(result.invalidRules,1);assert.equal(result.overLimitRules,1);
  assert.equal(result.duplicateChannels,1);
  assert.ok(result.invalidChannels>0);
  assert.ok(result.reasons.includes('INVALID_RULE_SHAPE'));
  assert.ok(result.reasons.includes('TOO_MANY_REQUIRED_CHANNELS'));
  assert.ok(result.reasons.includes('DUPLICATE_REQUIRED_CHANNELS'));
  assert.ok(result.reasons.includes('CHANNEL_NOT_VERIFIABLE'));
  assert.equal(JSON.stringify(result).includes('not-a-channel'),false);
  assert.equal(JSON.stringify(result).includes(CH1),false);
 }finally{await f.close();}
});
test('audit rejects an absent group and missing group verification scope regardless of flags in saved rule',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.subscriptionRequirements[0]!.chatId='-100999';});
  const a=await inspectSubscriptionIntegrityReadOnly(f.file);
  assert.equal(a.status,'BLOCKED');assert.equal(a.invalidGroups,1);
  await f.store.transaction(s=>{
   s.subscriptionRequirements[0]!.chatId=GROUP;
   s.chats.find(x=>x.id===GROUP)!.scopes=['navigation'];
  });
  const b=await inspectSubscriptionIntegrityReadOnly(f.file);
  assert.equal(b.status,'BLOCKED');assert.equal(b.invalidGroups,1);
 }finally{await f.close();}
});
test('auditor denies relative/absent/symlinked/permissive/forged SQLite paths without opening writable state',async()=>{
 const f=await fixture();try{
  for(const p of ['relative.sqlite',join(f.dir,'missing.sqlite')])
   await assert.rejects(inspectSubscriptionIntegrityReadOnly(p),/TELEGRAM_OUTBOX_STATE_INVALID/);
  const link=join(f.dir,'link.sqlite');await symlink(f.file,link);
  await assert.rejects(inspectSubscriptionIntegrityReadOnly(link),/TELEGRAM_OUTBOX_STATE_INVALID/);
  await chmod(f.file,0o644);
  await assert.rejects(inspectSubscriptionIntegrityReadOnly(f.file),/TELEGRAM_OUTBOX_STATE_INVALID/);
  await chmod(f.file,0o600);
  const broken=join(f.dir,'forged.sqlite');await writeFile(broken,'not a database',{mode:0o600});
  await assert.rejects(inspectSubscriptionIntegrityReadOnly(broken),/TELEGRAM_OUTBOX_STATE_INVALID/);
 }finally{await f.close();}
});
test('operator CLI emits a redacted healthy JSON report and exits zero without Telegram credentials or network',async()=>{
 const f=await fixture();try{
  const bytes=await readFile(f.file);
  const r=cli(f.file);
  assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(r.stdout) as {status:string;stage:string;activeRules:number};
  assert.equal(report.status,'PASS');assert.equal(report.stage,'OFFLINE_ONLY');
  assert.equal(report.activeRules,1);
  assert.equal(r.stdout.includes(f.file),false);
  assert.equal(r.stdout.includes('do-not-use-token'),false);
  assert.equal(r.stdout.includes(GROUP),false);
  assert.deepEqual(await readFile(f.file),bytes);
 }finally{await f.close();}
});
test('operator CLI reports blocked legacy dependency state with exit code 2 but no raw channel identifiers',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.chats.find(x=>x.id===CH1)!.approved=false;});
  const r=cli(f.file);
  assert.equal(r.status,2,r.stderr);
  const report=JSON.parse(r.stdout) as {status:string;invalidChannels:number};
  assert.equal(report.status,'BLOCKED');assert.equal(report.invalidChannels,1);
  assert.equal(r.stdout.includes(CH1),false);
  assert.equal(r.stdout.includes(GROUP),false);
 }finally{await f.close();}
});
test('operator CLI rejects extra activation flags, bad paths and invalid args without secret-leaking errors',async()=>{
 const f=await fixture();try{
  for(const args of [['--enable'],['--activate'],['--send','true']]){
   const r=cli(f.file,args);
   assert.equal(r.status,1);assert.equal(r.stdout,'');
   assert.equal(r.stderr,'MANARATAK_SUBSCRIPTION_AUDIT_INVALID_REQUEST\n');
  }
  const r=cli(join(f.dir,'missing.sqlite'));
  assert.equal(r.status,1);assert.equal(r.stdout,'');
  assert.equal(r.stderr,'MANARATAK_SUBSCRIPTION_AUDIT_INVALID_STATE\n');
 }finally{await f.close();}
});
