import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';
import {parseRetentionRunnerArgs,runRetentionReviewOnce} from '../src/retention-review-runner.js';

const OWNER='123',DAY=86_400_000,clock=()=>60*DAY;
async function fixture(engine:'sqlite'|'json'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-retention-cli-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const store=new BotStore(file,{engine}),p=new Policy(store,OWNER,clock);
 await p.approveChat(OWNER,'-100',['moderation']); // initialize the persisted state first
 await chmod(file,0o600);
 const service=()=>new ModerationPurgeService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),new FakePurgeGateway(),clock);
 return {dir,file,engine,store,service,close:()=>rm(dir,{recursive:true,force:true})};
}
const exec=promisify(execFile),cli=new URL('../src/retention-review-cli.js',import.meta.url).pathname;
for(const engine of ['json','sqlite'] as const){
 test(`retention local runner ${engine}: strict flags, no defaults or credential arguments`,()=>{
  const file=resolve('/tmp','manaratak-local-review.state');
  assert.deepEqual(parseRetentionRunnerArgs(['--once','--state',file,'--engine',engine]),
   {statePath:file,engine});
  for(const args of [
   [],['--once'],['--once','--engine',engine],['--once','--state',file],
   ['--state',file,'--engine',engine],['--once','--state','relative.state','--engine',engine],
   ['--once','--state',file,'--engine','postgres'],
   ['--once','--state',file,'--engine',engine,'--telegram-token','secret'],
   ['--once','--state',file,'--engine',engine,'--once'],
   ['--once','--state',file,'--engine',engine,'--state',file],
   ['--once','--state',file,'--engine',engine,'--owner','123']
  ])assert.throws(()=>parseRetentionRunnerArgs(args),/INVALID_RETENTION_RUNNER_ARGS/);
 });

 test(`retention local runner ${engine}: absent state never creates an empty bot or a fake checkpoint`,async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(runRetentionReviewOnce({statePath:join(f.dir,'absent.state'),engine}),/RETENTION_STATE_FILE_REQUIRED/);
   const out=await exec(process.execPath,[cli,'--once','--state',join(f.dir,'absent.state'),'--engine',engine]).catch(e=>e);
   assert.notEqual(out.code,0);
   assert.equal(String(out.stdout).includes('senderId'),false);
  }finally{await f.close()}
 });

 test(`retention local runner ${engine}: one-shot disabled status cannot opt in or do any outbound moderation action`,async()=>{
  const f=await fixture(engine);try{
   const original=await f.store.snapshot();
   const result=await runRetentionReviewOnce({statePath:f.file,engine},clock);
   assert.deepEqual(result,{status:'DISABLED'});
   assert.deepEqual(await f.store.snapshot(),original);
   const proc=await exec(process.execPath,[cli,'--once','--state',f.file,'--engine',engine]);
   assert.deepEqual(JSON.parse(proc.stdout),{status:'DISABLED'});
   assert.equal(proc.stderr.includes('RETENTION_RUNNER_FAILED'),false); // Node 22 emits an experimental SQLite warning even for JSON imports
   assert.equal((await f.store.snapshot()).purgeJobs.length,0);
  }finally{await f.close()}
 });

 test(`retention local runner ${engine}: real CLI emits only aggregate overdue checkpoint without compaction`,async()=>{
  const f=await fixture(engine);try{
   const now=()=>Date.now();
   const p=new Policy(f.store,OWNER,now),s=new ModerationPurgeService(f.store,p,new FakePurgeGateway(),now);
   await s.configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   await f.store.transaction(s=>{s.purgeRetentionReview!.nextCheckAt=Date.now()-1000});
   const before=await f.store.snapshot();
   const proc=await exec(process.execPath,[cli,'--once','--state',f.file,'--engine',engine]);
   const record=JSON.parse(proc.stdout);
   assert.equal(record.status,'READY');
   assert.deepEqual(Object.keys(record).sort(),['eligibleJobs','expiredObserved','status']);
   assert.equal(record.eligibleJobs,0);
   assert.equal(record.expiredObserved,0);
   assert.equal(JSON.stringify(record).includes('digest'),false);
   const after=await f.store.snapshot();
   assert.equal(after.rollingMessageMeta.length,before.rollingMessageMeta.length);
   assert.equal(after.purgeJobs.length,before.purgeJobs.length);
   assert.equal(after.audit.filter(x=>x.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
   const second=await exec(process.execPath,[cli,'--once','--state',f.file,'--engine',engine]);
   assert.deepEqual(JSON.parse(second.stdout),{status:'NOT_DUE'});
  }finally{await f.close()}
 });

 test(`retention local runner ${engine}: refuses symlink and insecure readable state file`,async()=>{
  const f=await fixture(engine);try{
   const link=join(f.dir,'shortcut.state');await symlink(f.file,link);
   await assert.rejects(runRetentionReviewOnce({statePath:link,engine}),/RETENTION_STATE_FILE_NOT_REGULAR/);
   await chmod(f.file,0o644);
   await assert.rejects(runRetentionReviewOnce({statePath:f.file,engine}),/RETENTION_STATE_FILE_INSECURE_PERMISSIONS/);
   const stat=await f.store.snapshot();assert.ok(stat.chats.length>0);
  }finally{await f.close()}
 });
}
test('retention local runner: concurrent independent SQLite CLI processes produce one READY notice',async()=>{
 const f=await fixture('sqlite');try{
  const now=()=>Date.now(),s=new ModerationPurgeService(f.store,new Policy(f.store,OWNER,now),new FakePurgeGateway(),now);
  await s.configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
  await f.store.transaction(x=>{x.purgeRetentionReview!.nextCheckAt=Date.now()-500});
  const args=[cli,'--once','--state',f.file,'--engine','sqlite'];
  const [a,b]=await Promise.all([exec(process.execPath,args),exec(process.execPath,args)]);
  const statuses=[JSON.parse(a.stdout).status,JSON.parse(b.stdout).status].sort();
  assert.deepEqual(statuses,['NOT_DUE','READY']);
  assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
 }finally{await f.close()}
});
test('retention local runner: malicious unknown option never prints or stores the supplied secret',async()=>{
 const f=await fixture();try{
  const secret='super-sensitive-telegram-token';
  const proc=await exec(process.execPath,[cli,'--once','--state',f.file,'--engine','json','--token',secret]).catch(e=>e);
  assert.notEqual(proc.code,0);
  assert.equal(String(proc.stderr).includes(secret),false);
  assert.equal(String(proc.stdout).includes(secret),false);
  assert.equal(JSON.stringify(await f.store.snapshot()).includes(secret),false);
 }finally{await f.close()}
});
