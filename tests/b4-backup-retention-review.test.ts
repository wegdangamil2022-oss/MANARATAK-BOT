import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir,symlink,chmod,utimes,stat,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {reviewSqliteBackups} from '../src/backup-retention-review.js';

const OWNER='100', DAY=86_400_000, NOW=100*DAY;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'manaratak-backup-audit-'));
 const directory=join(root,'backups');
 await mkdir(directory,{mode:0o700});
 const source=join(root,'primary.sqlite');
 const store=new BotStore(source,{engine:'sqlite'});
 await new Policy(store,OWNER,()=>NOW).approveChat(OWNER,'-100',['moderation']);
 const make=async(name:string,ageDays:number)=>{
  const file=join(directory,name);
  await BotStore.backupSqlite(source,file);
  const stamp=(NOW-ageDays*DAY)/1000;
  await utimes(file,stamp,stamp);
  return file;
 };
 const inspect=(days=30)=>reviewSqliteBackups({directory,retentionDays:days,now:NOW});
 return {root,directory,source,store,make,inspect,close:()=>rm(root,{recursive:true,force:true})};
}
test('backup review: empty private directory is read only and lists no candidates',async()=>{
 const f=await fixture();try{
  const before=await readdir(f.directory);
  const report=await f.inspect();
  assert.deepEqual({scanned:report.scanned,validRecent:report.validRecent,expiredCandidates:report.expiredCandidates,
   invalid:report.invalid,unsafe:report.unsafe,skipped:report.skipped},
   {scanned:0,validRecent:0,expiredCandidates:0,invalid:0,unsafe:0,skipped:0});
  assert.deepEqual(report.entries,[]);
  assert.deepEqual(await readdir(f.directory),before);
 }finally{await f.close()}
});
test('backup review: verified old snapshot is a review CANDIDATE, not an automatic deletion',async()=>{
 const f=await fixture();try{
  const old=await f.make('backup-old.sqlite',31);
  const young=await f.make('backup-new.sqlite',5);
  const bytes=await readFile(old);
  const original=await f.store.snapshot();
  const r=await f.inspect();
  assert.equal(r.scanned,2);
  assert.equal(r.validRecent,1);
  assert.equal(r.expiredCandidates,1);
  assert.equal(r.entries.filter(x=>x.status==='EXPIRED_CANDIDATE').length,1);
  assert.equal(r.entries.filter(x=>x.status==='VALID_RECENT').length,1);
  assert.equal(r.entries.every(x=>/^[0-9a-f]{64}$/.test(x.ref)),true);
  assert.equal(JSON.stringify(r).includes(f.root),false);
  assert.equal(JSON.stringify(r).includes('backup-old.sqlite'),false);
  assert.equal(JSON.stringify(r).includes('"senderId"'),false);
  assert.deepEqual(await readFile(old),bytes);
  assert.deepEqual(await new BotStore(old,{engine:'sqlite'}).snapshot(),original);
  assert.deepEqual(await new BotStore(young,{engine:'sqlite'}).snapshot(),original);
 }finally{await f.close()}
});
test('backup review: cutoff is strict older-than and requires supported retention days',async()=>{
 const f=await fixture();try{
  await f.make('boundary.sqlite',30);
  assert.equal((await f.inspect()).expiredCandidates,0);
  assert.equal((await f.inspect()).validRecent,1);
  for(const retentionDays of [0,-1,0.1,366,NaN,Infinity,'30',null]){
   await assert.rejects(reviewSqliteBackups({directory:f.directory,retentionDays:retentionDays as number,now:NOW}),
     /BACKUP_REVIEW_INVALID_POLICY/);
  }
  for(const now of [NaN,-1,Infinity,NOW+.5]){
   await assert.rejects(reviewSqliteBackups({directory:f.directory,retentionDays:30,now}),/BACKUP_REVIEW_INVALID_POLICY/);
  }
 }finally{await f.close()}
});
test('backup review: corrupt and uninitialized SQLite backups are never deemed safe candidates for expiry',async()=>{
 const f=await fixture();try{
  const fake=join(f.directory,'fake.sqlite');
  await writeFile(fake,'SQLite format 3\0 with corrupt bytes');
  const noBot=join(f.directory,'no-state.sqlite');
  const db=new DatabaseSync(noBot);
  try{db.exec('CREATE TABLE unrelated (x INTEGER)');}finally{db.close()}
  const old=(NOW-60*DAY)/1000;
  await chmod(fake,0o600);await chmod(noBot,0o600);
  await utimes(fake,old,old);await utimes(noBot,old,old);
  const beforeFake=await readFile(fake),beforeOther=await readFile(noBot);
  const result=await f.inspect();
  assert.equal(result.invalid,2);assert.equal(result.expiredCandidates,0);
  assert.deepEqual(result.entries.map(x=>x.status),['INVALID','INVALID']);
  assert.deepEqual(await readFile(fake),beforeFake);
  assert.deepEqual(await readFile(noBot),beforeOther);
 }finally{await f.close()}
});
test('backup review: symlinked backup is unsafe and never followed or marked expirable',async()=>{
 const f=await fixture();try{
  const external=await f.make('backup.sqlite',40);
  const alias=join(f.directory,'alias.sqlite');
  await symlink(external,alias);
  const report=await f.inspect();
  assert.equal(report.unsafe,1);
  assert.equal(report.expiredCandidates,1);
  assert.equal(report.entries.find(x=>x.status==='UNSAFE_LINK')?.ref.length,64);
  assert.equal((await readdir(f.directory)).includes('alias.sqlite'),true);
 }finally{await f.close()}
});
test('backup review: canonical directory only, no symlinked ancestor, private permissions required',async()=>{
 const f=await fixture();try{
  const link=join(f.root,'alias-backups');
  await symlink(f.directory,link);
  for(const dir of [link,f.directory+'/../backups','relative/backups']){
   await assert.rejects(reviewSqliteBackups({directory:dir,retentionDays:30,now:NOW}),
    /BACKUP_REVIEW_UNSAFE_DIRECTORY/);
  }
  await chmod(f.directory,0o755);
  await assert.rejects(f.inspect(),/BACKUP_REVIEW_UNSAFE_DIRECTORY/);
  await chmod(f.directory,0o700);
  assert.equal((await f.inspect()).scanned,0);
 }finally{await f.close()}
});
test('backup review: hidden or foreign entries are counted only as skipped, never scanned as backups',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.directory,'notes.txt'),'person data must not appear in reports');
  await writeFile(join(f.directory,'abc.sqlite-wal'),'wal');
  await mkdir(join(f.directory,'nested'),{mode:0o700});
  const report=await f.inspect();
  assert.equal(report.skipped,3);
  assert.equal(report.scanned,0);
  assert.equal(JSON.stringify(report).includes('person data'),false);
  assert.equal((await readdir(f.directory)).length,3);
 }finally{await f.close()}
});
test('backup review: future mtime is quarantined rather than classified as recent or expired',async()=>{
 const f=await fixture();try{
  await f.make('future.sqlite',-3);
  const r=await f.inspect();
  assert.equal(r.expiredCandidates,0);
  assert.equal(r.validRecent,0);
  assert.equal(r.invalid,1);
  assert.equal(r.entries[0]?.status,'FUTURE_TIMESTAMP');
 }finally{await f.close()}
});
test('backup review: existing files with nonprivate permissions are unsafe even if valid',async()=>{
 const f=await fixture();try{
  const old=await f.make('unsafe.sqlite',45);
  await chmod(old,0o644);
  const r=await f.inspect();
  assert.equal(r.unsafe,1);
  assert.equal(r.expiredCandidates,0);
  assert.equal(r.entries[0]?.status,'UNSAFE_PERMISSIONS');
 }finally{await f.close()}
});
test('backup review: source contains unrecognized state schema and must never count as expirable verified backup',async()=>{
 const f=await fixture();try{
  const file=join(f.directory,'unsupported.sqlite');
  const db=new DatabaseSync(file);
  try{
   db.exec('CREATE TABLE bot_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
   db.prepare('INSERT INTO bot_state (id,data) VALUES (1,?)').run(JSON.stringify({schemaVersion:999,updates:[]}));
  }finally{db.close()}
  await chmod(file,0o600);
  const past=(NOW-70*DAY)/1000;await utimes(file,past,past);
  const r=await f.inspect();
  assert.equal(r.expiredCandidates,0);assert.equal(r.invalid,1);
  assert.equal(r.entries[0]?.status,'INVALID');
 }finally{await f.close()}
});
test('backup review: directory cannot be invented and review must never create a new one',async()=>{
 const f=await fixture();try{
  const absent=join(f.root,'absent');
  await assert.rejects(reviewSqliteBackups({directory:absent,retentionDays:30,now:NOW}),
   /BACKUP_REVIEW_UNSAFE_DIRECTORY/);
  await assert.rejects(stat(absent),{code:'ENOENT'});
 }finally{await f.close()}
});
test('backup review: many backups are bounded; scan fails closed rather than omit unreviewed entries',async()=>{
 const f=await fixture();try{
  for(let i=0;i<4;i++)await f.make('backup-'+i+'.sqlite',i+1);
  await assert.rejects(reviewSqliteBackups({directory:f.directory,retentionDays:30,now:NOW,maxEntries:3}),
   /BACKUP_REVIEW_TOO_MANY_ENTRIES/);
  assert.equal((await readdir(f.directory)).filter(x=>x.endsWith('.sqlite')).length,4);
 }finally{await f.close()}
});
