import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat,symlink,access,mkdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';

const OWNER='100';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-backup-safe-'));
 const source=join(dir,'source.sqlite'),target=join(dir,'backup.sqlite');
 const exists=async(path:string)=>access(path).then(()=>true,()=>false);
 return {dir,source,target,exists,close:()=>rm(dir,{force:true,recursive:true})};
}
for(const kind of ['zero-byte','text','bogus-header'] as const){
 test(`B4 guarded backup: ${kind} SQLite source is rejected before backup or source initialization`,async()=>{
  const f=await fixture();try{
   const bytes=kind==='zero-byte'?Buffer.alloc(0):
    kind==='text'?Buffer.from('non SQLite data here that is not valid'):
     Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.from('this-is-not-a-database')]);
   await writeFile(f.source,bytes);
   const original=await readFile(f.source);
   await assert.rejects(BotStore.backupSqlite(f.source,f.target),/BACKUP_SOURCE_INVALID/);
   assert.deepEqual(await readFile(f.source),original);
   assert.equal(await f.exists(f.target),false);
   assert.equal(await f.exists(f.source+'-wal'),false);
  }finally{await f.close()}
 });
}
test('B4 guarded backup: refuse uninitialized SQLite that lacks bot_state, without auto-creating that table',async()=>{
 const f=await fixture();try{
  const raw=new DatabaseSync(f.source);
  try{raw.exec('CREATE TABLE innocent (id INTEGER PRIMARY KEY)');}finally{raw.close()}
  await assert.rejects(BotStore.backupSqlite(f.source,f.target),/BACKUP_SOURCE_INVALID/);
  const db=new DatabaseSync(f.source,{readOnly:true});
  try{
   assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='bot_state'").all().length,0);
  }finally{db.close()}
  assert.equal(await f.exists(f.target),false);
 }finally{await f.close()}
});
test('B4 guarded backup: refuse bot_state table with no initialized row',async()=>{
 const f=await fixture();try{
  const raw=new DatabaseSync(f.source);
  try{raw.exec('CREATE TABLE bot_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');}finally{raw.close()}
  await assert.rejects(BotStore.backupSqlite(f.source,f.target),/BACKUP_SOURCE_INVALID/);
  assert.equal(await f.exists(f.target),false);
 }finally{await f.close()}
});
test('B4 guarded backup: refuse bot_state with corrupt schema and preserve original bytes',async()=>{
 const f=await fixture();try{
  const raw=new DatabaseSync(f.source);
  try{
   raw.exec('CREATE TABLE bot_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
   raw.prepare('INSERT INTO bot_state (id,data) VALUES (1,?)').run(JSON.stringify({schemaVersion:999,token:'sensitive'}));
  }finally{raw.close()}
  const bytes=await readFile(f.source);
  await assert.rejects(BotStore.backupSqlite(f.source,f.target),/BACKUP_SOURCE_INVALID/);
  assert.deepEqual(await readFile(f.source),bytes);
  assert.equal(await f.exists(f.target),false);
 }finally{await f.close()}
});
test('B4 guarded backup: refuse source-file symlink or symlinked ancestor',async()=>{
 const f=await fixture();try{
  const store=new BotStore(f.source,{engine:'sqlite'});
  await new Policy(store,OWNER).approveChat(OWNER,'-100',['moderation']);
  const direct=join(f.dir,'alias.sqlite');
  await symlink(f.source,direct);
  await assert.rejects(BotStore.backupSqlite(direct,f.target),/BACKUP_SOURCE_ALIAS/);
  const parentAlias=join(f.dir,'redirected');
  const realDir=join(f.dir,'real');
  await mkdir(realDir);
  const realSource=join(realDir,'db.sqlite');
  await new Policy(new BotStore(realSource,{engine:'sqlite'}),OWNER).approveChat(OWNER,'-200',['moderation']);
  await symlink(realDir,parentAlias);
  await assert.rejects(BotStore.backupSqlite(join(parentAlias,'db.sqlite'),f.target),/BACKUP_SOURCE_ALIAS/);
  assert.equal(await f.exists(f.target),false);
 }finally{await f.close()}
});
test('B4 guarded backup: refuse symlinked destination parent and never write through redirect',async()=>{
 const f=await fixture();try{
  await new Policy(new BotStore(f.source,{engine:'sqlite'}),OWNER).approveChat(OWNER,'-100',['moderation']);
  const realDir=join(f.dir,'backup-target');
  await mkdir(realDir);
  const alias=join(f.dir,'backup-redirect');
  await symlink(realDir,alias);
  const redirectTarget=join(alias,'backup.sqlite');
  await assert.rejects(BotStore.backupSqlite(f.source,redirectTarget),/BACKUP_DESTINATION_ALIAS/);
  assert.equal(await f.exists(join(realDir,'backup.sqlite')),false);
 }finally{await f.close()}
});
test('B4 guarded backup: canonical-only paths, explicit no overwrite and private new snapshot',async()=>{
 const f=await fixture();try{
  const s=new BotStore(f.source,{engine:'sqlite'});
  await new Policy(s,OWNER).approveChat(OWNER,'-100',['moderation']);
  const before=await s.snapshot();
  await assert.rejects(BotStore.backupSqlite(f.source+'/../source.sqlite',f.target),/BACKUP_INVALID_PATH/);
  await assert.rejects(BotStore.backupSqlite(f.source,f.target+'/../backup.sqlite'),/BACKUP_INVALID_PATH/);
  await BotStore.backupSqlite(f.source,f.target);
  assert.deepEqual(await new BotStore(f.target,{engine:'sqlite'}).snapshot(),before);
  const mode=(await stat(f.target)).mode;
  assert.equal(mode&0o077,0);
  await assert.rejects(BotStore.backupSqlite(f.source,f.target),/BACKUP_ALREADY_EXISTS/);
  assert.deepEqual(await new BotStore(f.target,{engine:'sqlite'}).snapshot(),before);
 }finally{await f.close()}
});
test('B4 guarded backup: failed input does not create any requested destination directory',async()=>{
 const f=await fixture();try{
  await writeFile(f.source,'SQLite format 3\0 junk but invalid state');
  const dest=join(f.dir,'not-yet-created','backup.sqlite');
  await assert.rejects(BotStore.backupSqlite(f.source,dest),/BACKUP_SOURCE_INVALID/);
  assert.equal(await f.exists(join(f.dir,'not-yet-created')),false);
 }finally{await f.close()}
});
test('B4 guarded backup: valid WAL content and purge safety receipts survive backup without deletion',async()=>{
 const f=await fixture();try{
  const store=new BotStore(f.source,{engine:'sqlite'}),policy=new Policy(store,OWNER);
  await policy.approveChat(OWNER,'-100',['moderation']);
  await store.transaction(s=>{
   s.rollingMessageMeta.push({chatId:'-100',messageId:19,senderKind:'USER',senderId:'200',
    sentAt:1,observedAt:2,contentType:'TEXT',hasLinks:false,pinned:false,
    linkedChannel:false,adminLog:false,approvedAnnouncement:false});
  });
  const before=await store.snapshot();
  await BotStore.backupSqlite(f.source,f.target);
  assert.deepEqual(await new BotStore(f.target,{engine:'sqlite'}).snapshot(),before);
  assert.equal((await store.snapshot()).rollingMessageMeta.length,1);
 }finally{await f.close()}
});
