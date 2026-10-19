import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { FakePublicationGateway, PublicationService } from '../src/publishing.js';
const run=promisify(execFile);
const OWNER='100', SOURCE='-100', DEST='-200';
async function fixture() {
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b4-sqlite-'));
 const file=join(dir,'state.sqlite'), store=new BotStore(file,{engine:'sqlite'}), clock=()=>1000;
 const policy=new Policy(store,OWNER,clock), education=new EducationService(store,policy,clock);
 const gateway=new FakePublicationGateway(), publishing=new PublicationService(store,policy,gateway,clock);
 await policy.approveChat(OWNER,SOURCE,['navigation']);await policy.approveChat(OWNER,DEST,['publishing']);
 await education.createCategory(OWNER,{id:'grants',scope:SOURCE,title:'المنح',order:1});
 const imp=await education.submitText(OWNER,SOURCE,'ADMIN_WEB','csv','records.csv',
  'title,university\nScholarship A,University A\nScholarship B,University B\n');
 const resources=[];
 for(let i=0;i<2;i++){await education.approveCandidate(OWNER,imp.id,i,'grants');resources.push(await education.publishCandidate(OWNER,imp.id,i,'grants'));}
 return {dir,file,store,policy,education,gateway,publishing,resources,close:()=>rm(dir,{force:true,recursive:true})};
}
async function worker(task:string,file:string,campaign:string) {
 return run(process.execPath,[new URL('./b4-sqlite-worker.js',import.meta.url).pathname,task,file,campaign]);
}

test('B4 sqlite: initializes a single canonical state with SQLite header and shared schema',async()=>{
 const f=await fixture();try{
  const raw=await readFile(f.file);
  assert.equal(raw.subarray(0,15).toString(),'SQLite format 3');
  const snapshot=await new BotStore(f.file,{engine:'sqlite'}).snapshot();
  assert.equal(snapshot.schemaVersion,7);
  assert.equal(snapshot.educationResources.length,2);
  assert.deepEqual(snapshot.deliveries,[]);
 }finally{await f.close()}
});

test('B4 sqlite: rejects write callback failures atomically, keeping prior history',async()=>{
 const f=await fixture();try{
  const initial=await f.store.snapshot();
  await assert.rejects(f.store.transaction(s=>{
    s.deliveries.push({id:'fake',campaignId:'fake',resourceId:'fake',destination:DEST,revision:'r1',status:'SENT'});
    throw new Error('SIMULATED_ABORT');
  }),/SIMULATED_ABORT/);
  assert.deepEqual((await new BotStore(f.file,{engine:'sqlite'}).snapshot()).deliveries,initial.deliveries);
  assert.equal((await f.store.snapshot()).educationResources.length,initial.educationResources.length);
 }finally{await f.close()}
});

test('B4 sqlite: concurrent independent processes cannot approve same source revision twice',async()=>{
 const f=await fixture();try{
  const a=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  const b=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  const results=await Promise.allSettled([worker('approve',f.file,a.id),worker('approve',f.file,b.id)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
  const state=await f.store.snapshot();
  assert.equal(state.deliveries.length,1);
  assert.equal(state.campaigns.filter(x=>x.status==='APPROVED').length,1);
 }finally{await f.close()}
});

test('B4 sqlite: independent processes approving different resources retain both reservations',async()=>{
 const f=await fixture();try{
  const a=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  const b=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[1]!.id]);
  const results=await Promise.allSettled([worker('approve',f.file,a.id),worker('approve',f.file,b.id)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,2);
  const state=await f.store.snapshot();
  assert.equal(state.deliveries.length,2);
  assert.equal(new Set(state.deliveries.map(x=>x.resourceId)).size,2);
 }finally{await f.close()}
});

test('B4 sqlite: two competing worker processes can dispatch a single queued item only once',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  await f.publishing.approve(OWNER,c.id);
  const results=await Promise.all([worker('dispatch',f.file,c.id),worker('dispatch',f.file,c.id)]);
  const calls=results.map(r=>Number(r.stdout.trim().split(':').at(-1)));
  assert.equal(calls.reduce((a,b)=>a+b,0),1);
  assert.equal((await f.store.snapshot()).deliveries[0]!.status,'SENT');
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'EMPTY');
 }finally{await f.close()}
});

test('B4 sqlite: multipart sending progress and ambiguous orphans persist across service restart',async()=>{
 const f=await fixture();try{
  await f.education.setPublicationText(OWNER,f.resources[0]!.id,'منحة مدققة طبية '.repeat(350));
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  await f.publishing.approve(OWNER,c.id);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'SENT');
  const before=await f.store.snapshot(),part=before.deliveries[0]!.multipart!.parts[1]!;
  assert.equal(before.deliveries[0]!.multipart!.parts[0]!.status,'SENT');
  assert.equal(part.status,'QUEUED');
  await f.store.transaction(s=>{s.deliveries[0]!.multipart!.parts[1]!.status='SENDING';
    s.deliveries[0]!.multipart!.parts[1]!.attemptId='crashed-worker';});
  const restarted=new PublicationService(new BotStore(f.file,{engine:'sqlite'}),new Policy(new BotStore(f.file,{engine:'sqlite'}),OWNER,()=>1000),f.gateway,()=>1000);
  assert.equal(await restarted.recoverPending(),1);
  assert.equal((await restarted.dispatchNext(c.id)).status,'BLOCKED');
  const state=await new BotStore(f.file,{engine:'sqlite'}).snapshot();
  assert.equal(state.deliveries[0]!.multipart!.parts[0]!.status,'SENT');
  assert.equal(state.deliveries[0]!.multipart!.parts[1]!.status,'UNKNOWN_OUTCOME');
  assert.equal(state.deliveries[0]!.multipart!.parts[1]!.attemptId,'crashed-worker');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close()}
});

test('B4 sqlite: explicit JSON-to-SQLite import keeps historical, campaigns, parts and B3 data',async()=>{
 const f=await fixture();try{
  const campaign=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  await f.publishing.approve(OWNER,campaign.id);
  await f.publishing.dispatchNext(campaign.id);
  const history=await f.store.snapshot();
  await f.store.transaction(s=>{s.historicalPublications.push({id:'legacy-1',sourceScope:SOURCE,destination:DEST,
    resourceId:f.resources[1]!.id,revision:'rev-1',status:'UNVERIFIED',diagnostic:'NO_PROOF',
    reviewedBy:OWNER,reviewedAt:1000});});
  const original=await f.store.snapshot();
  const json=join(f.dir,'legacy.json'),newDb=join(f.dir,'imported.sqlite');
  await writeFile(json,JSON.stringify(original));
  await BotStore.importJsonToSqlite(json,newDb);
  assert.deepEqual(await new BotStore(newDb,{engine:'sqlite'}).snapshot(),original);
  await assert.rejects(BotStore.importJsonToSqlite(json,newDb),/SQLITE_ALREADY_INITIALIZED/);
  assert.deepEqual(await new BotStore(newDb,{engine:'sqlite'}).snapshot(),original);
  assert.equal(history.deliveries.length,original.deliveries.length);
 }finally{await f.close()}
});

test('B4 sqlite: malformed state remains an error and never silently resets accounts or deliveries',async()=>{
 const f=await fixture();try{
  const db=new DatabaseSync(f.file);
  db.prepare('UPDATE bot_state SET data = ? WHERE id = 1').run('{invalid');
  db.close();
  await assert.rejects(new BotStore(f.file,{engine:'sqlite'}).snapshot());
  await assert.rejects(new BotStore(f.file,{engine:'sqlite'}).transaction(s=>{s.chats=[];}));
  const reopened=new DatabaseSync(f.file);
  const row=reopened.prepare('SELECT data FROM bot_state WHERE id=1').get() as {data:string};
  assert.equal(row.data,'{invalid');
  reopened.close();
 }finally{await f.close()}
});

test('B4 sqlite: online backup is a restorable point-in-time snapshot, not a writable alias',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  await f.publishing.approve(OWNER,c.id);await f.publishing.dispatchNext(c.id);
  const original=await f.store.snapshot();
  const file=join(f.dir,'snapshot.sqlite');
  await BotStore.backupSqlite(f.file,file);
  assert.deepEqual(await new BotStore(file,{engine:'sqlite'}).snapshot(),original);
  await f.store.transaction(s=>{s.audit.push({updateKey:'after-backup',decision:'NOOP',reason:'TEST',policyVersion:0,at:1000});});
  assert.notDeepEqual(await f.store.snapshot(),original);
  assert.deepEqual(await new BotStore(file,{engine:'sqlite'}).snapshot(),original);
  await assert.rejects(BotStore.backupSqlite(f.file,file),/BACKUP_ALREADY_EXISTS/);
  assert.deepEqual(await new BotStore(file,{engine:'sqlite'}).snapshot(),original);
 }finally{await f.close()}
});

test('B4 sqlite: cannot back up a nonexistent store or mistake missing source for a valid empty database',async()=>{
 const f=await fixture();try{
  const noSource=join(f.dir,'no-source.sqlite'),backup=join(f.dir,'backup.sqlite');
  await assert.rejects(BotStore.backupSqlite(noSource,backup),/ENOENT/);
  await assert.rejects(BotStore.importJsonToSqlite(join(f.dir,'missing.json'),backup),/ENOENT/);
 }finally{await f.close()}
});

test('B4 sqlite: older B4 schema v5 is upgraded during explicit import without erasing historic receipts',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  await f.publishing.approve(OWNER,c.id);await f.publishing.dispatchNext(c.id);
  const before=await f.store.snapshot();
  const legacy=join(f.dir,'legacy5.json'),target=join(f.dir,'migrated5.sqlite');
  const data:Record<string,unknown>={...before,schemaVersion:5};
  delete data.historicalPublications;
  await writeFile(legacy,JSON.stringify(data));
  await BotStore.importJsonToSqlite(legacy,target);
  const after=await new BotStore(target,{engine:'sqlite'}).snapshot();
  assert.equal(after.schemaVersion,7);
  assert.deepEqual(after.deliveries,before.deliveries);
  assert.deepEqual(after.campaigns,before.campaigns);
  assert.deepEqual(after.educationResources,before.educationResources);
  assert.deepEqual(after.historicalPublications,[]);
 }finally{await f.close()}
});
