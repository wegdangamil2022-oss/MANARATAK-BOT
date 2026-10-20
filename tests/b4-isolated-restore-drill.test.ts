import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,stat,readFile,writeFile,chmod,readdir,symlink,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {runSqliteRestoreDrill} from '../src/backup-restore-drill.js';

const OWNER='100',CHAT='-100';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'manaratak-restore-drill-'));
 const source=join(root,'live.sqlite'),backup=join(root,'backup.sqlite');
 const sandboxDir=join(root,'sandbox');
 await mkdir(sandboxDir,{mode:0o700});
 const store=new BotStore(source,{engine:'sqlite'});
 await new Policy(store,OWNER,()=>1_000).approveChat(OWNER,CHAT,['moderation','publishing']);
 await store.transaction(s=>{
  s.grants.push({actor:'200',capability:'chat.manage',chatId:CHAT,expiresAt:100_000,grantedBy:OWNER,revoked:false});
  s.deliveries.push({
   id:'delivery1',campaignId:'campaign1',resourceId:'resource1',destination:CHAT,revision:'r1',
   status:'UNKNOWN_OUTCOME',attemptId:'immutable-pub-attempt',startedAt:900,leaseUntil:1000
  });
  s.historicalPublications.push({id:'history1',sourceScope:CHAT,destination:CHAT,
   resourceId:'resource1',revision:'r1',status:'PUBLISHED_VERIFIED',diagnostic:'REVIEWED',
   reviewedBy:OWNER,reviewedAt:900});
  s.purgeJobs.push({
   id:'purge1',chatId:CHAT,actorId:OWNER,scopeVersion:1,createdAt:800,expiresAt:1200,
   filter:{limit:1},excluded:{protected:0,expired:0},status:'PAUSED',
   items:[{messageId:7,metaDigest:'message-meta-hash',status:'UNKNOWN_OUTCOME',
    attemptId:'immutable-purge-attempt',startedAt:850,leaseUntil:950}]
  });
 });
 await BotStore.backupSqlite(source,backup);
 return {root,source,backup,sandboxDir,store,
  run:()=>runSqliteRestoreDrill({backupFile:backup,sandboxDir}),
  close:()=>rm(root,{recursive:true,force:true})};
}
test('restore drill: isolated snapshot preserves immutable publication and UNKNOWN deletion state',async()=>{
 const f=await fixture();try{
  const before=await readFile(f.backup),live=await f.store.snapshot();
  const r=await f.run();
  assert.equal(r.status,'VERIFIED');
  assert.deepEqual(r.counts,{chats:1,grants:1,deliveries:1,historicalPublications:1,
   purgeJobs:1,unknownPurgeItems:1,unknownDeliveries:1});
  assert.equal(JSON.stringify(r).includes(f.root),false);
  assert.equal(JSON.stringify(r).includes(OWNER),false);
  assert.equal(JSON.stringify(r).includes('immutable-'),false);
  assert.deepEqual(await readFile(f.backup),before);
  assert.deepEqual(await f.store.snapshot(),live);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: a second drill has no persistent artifacts or duplicate delete/publication attempts',async()=>{
 const f=await fixture();try{
  const a=await f.run(),b=await f.run();
  assert.deepEqual(a,b);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal((await f.store.snapshot()).deliveries[0]!.status,'UNKNOWN_OUTCOME');
 }finally{await f.close()}
});
test('restore drill: concurrent independent invocations keep one another isolated',async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.run(),f.run()]);
  assert.deepEqual(a,b);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: preexisting sandbox files are never overwritten or removed',async()=>{
 const f=await fixture();try{
  const marker=join(f.sandboxDir,'owner-notes.txt');
  const contents='private backup recovery instructions';
  await writeFile(marker,contents,{mode:0o600});
  await f.run();
  assert.equal(await readFile(marker,'utf8'),contents);
  assert.deepEqual(await readdir(f.sandboxDir),['owner-notes.txt']);
 }finally{await f.close()}
});
test('restore drill: reject corrupted, truncated or unsupported schema before scratch file creation',async()=>{
 const f=await fixture();try{
  for(const bytes of [Buffer.alloc(0),Buffer.from('not an sqlite file at all')]){
   const file=join(f.root,'corrupt.sqlite');await writeFile(file,bytes,{mode:0o600});
   await assert.rejects(runSqliteRestoreDrill({backupFile:file,sandboxDir:f.sandboxDir}),
    /RESTORE_DRILL_INVALID_BACKUP/);
   assert.deepEqual(await readdir(f.sandboxDir),[]);
  }
  const foreign=join(f.root,'foreign.sqlite'),db=new DatabaseSync(foreign);
  try{db.exec('CREATE TABLE bot_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
   db.prepare('INSERT INTO bot_state (id,data) VALUES (1,?)').run(JSON.stringify({schemaVersion:999}));}
  finally{db.close();}
  await chmod(foreign,0o600);
  await assert.rejects(runSqliteRestoreDrill({backupFile:foreign,sandboxDir:f.sandboxDir}),
   /RESTORE_DRILL_INVALID_BACKUP/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: rejected symlink backup file and symlinked ancestor do not touch sandbox',async()=>{
 const f=await fixture();try{
  const link=join(f.root,'linked.sqlite');await symlink(f.backup,link);
  await assert.rejects(runSqliteRestoreDrill({backupFile:link,sandboxDir:f.sandboxDir}),
   /RESTORE_DRILL_UNSAFE_PATH/);
  const dir=join(f.root,'shadow');
  await symlink(f.root,dir);
  await assert.rejects(runSqliteRestoreDrill({backupFile:join(dir,'backup.sqlite'),sandboxDir:f.sandboxDir}),
   /RESTORE_DRILL_UNSAFE_PATH/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: cannot target the backup directory itself or a redirected scratch directory',async()=>{
 const f=await fixture();try{
  const redirect=join(f.root,'sandbox-symlink');await symlink(f.sandboxDir,redirect);
  await assert.rejects(runSqliteRestoreDrill({backupFile:f.backup,sandboxDir:redirect}),
   /RESTORE_DRILL_UNSAFE_PATH/);
  await assert.rejects(runSqliteRestoreDrill({backupFile:f.backup,sandboxDir:f.root}),
   /RESTORE_DRILL_UNSAFE_PATH/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: rejects noncanonical and relative path aliases before opening files',async()=>{
 const f=await fixture();try{
  for(const args of [
   {backupFile:f.backup+'/../backup.sqlite',sandboxDir:f.sandboxDir},
   {backupFile:'relative-backup.sqlite',sandboxDir:f.sandboxDir},
   {backupFile:f.backup,sandboxDir:f.sandboxDir+'/../sandbox'},
   {backupFile:f.backup,sandboxDir:'relative-sandbox'},
  ])await assert.rejects(runSqliteRestoreDrill(args),/RESTORE_DRILL_UNSAFE_PATH/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: refuse world-readable backup or scratch directory',async()=>{
 const f=await fixture();try{
  await chmod(f.backup,0o644);
  await assert.rejects(f.run(),/RESTORE_DRILL_UNSAFE_PERMISSIONS/);
  await chmod(f.backup,0o600);
  await chmod(f.sandboxDir,0o755);
  await assert.rejects(f.run(),/RESTORE_DRILL_UNSAFE_PERMISSIONS/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: sandbox must exist already and is never auto-initialized',async()=>{
 const f=await fixture();try{
  const missing=join(f.root,'missing-sandbox');
  await assert.rejects(runSqliteRestoreDrill({backupFile:f.backup,sandboxDir:missing}),
   /RESTORE_DRILL_UNSAFE_PATH/);
  await assert.rejects(access(missing),{code:'ENOENT'});
 }finally{await f.close()}
});
test('restore drill: missing backup fails closed and does not leave scratch artifacts',async()=>{
 const f=await fixture();try{
  await assert.rejects(runSqliteRestoreDrill({backupFile:join(f.root,'missing.sqlite'),sandboxDir:f.sandboxDir}),
   /RESTORE_DRILL_INVALID_BACKUP/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
test('restore drill: rejects forged unknown options and never interprets a destination as production',async()=>{
 const f=await fixture();try{
  await assert.rejects(runSqliteRestoreDrill({...{backupFile:f.backup,sandboxDir:f.sandboxDir},activate:true} as never),
   /RESTORE_DRILL_INVALID_OPTIONS/);
  await assert.rejects(runSqliteRestoreDrill({backupFile:f.backup,sandboxDir:f.sandboxDir,restoreTo:f.source} as never),
   /RESTORE_DRILL_INVALID_OPTIONS/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close()}
});
