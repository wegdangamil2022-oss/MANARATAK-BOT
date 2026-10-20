import {randomUUID} from 'node:crypto';
import {open,lstat,realpath,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {DatabaseSync,backup} from 'node:sqlite';
import {BotStore,type BotState} from './store.js';

/** Isolated, one-shot disaster recovery rehearsal. NO production restore. */
export interface RestoreDrillOptions {backupFile:string;sandboxDir:string}
export interface RestoreDrillResult {
 status:'VERIFIED';
 counts:{chats:number;grants:number;deliveries:number;historicalPublications:number;
  purgeJobs:number;unknownPurgeItems:number;unknownDeliveries:number};
}
const invalid=(code:'RESTORE_DRILL_INVALID_OPTIONS'|'RESTORE_DRILL_UNSAFE_PATH'|
 'RESTORE_DRILL_UNSAFE_PERMISSIONS'|'RESTORE_DRILL_INVALID_BACKUP'|'RESTORE_DRILL_MISMATCH'):never=>{
 throw new Error(code);
};
const canonical=(path:string):boolean=>
 typeof path==='string'&&isAbsolute(path)&&path===resolve(path)&&
 !/[\u0000-\u001f\u007f]/u.test(path);
/** Only opens SQLite read-only. The official sqlite backup API is used for
 * creating a point-in-time scratch copy, never a raw copy of a live WAL file.
 * The private source is compared against the isolated copy, field for field.
 * All scratch output is owned exclusively by this invocation and removed.
 */
export async function runSqliteRestoreDrill(options:RestoreDrillOptions):Promise<RestoreDrillResult>{
 if(!options||typeof options!=='object'||Array.isArray(options)||
   Object.keys(options).length!==2||
   Object.keys(options).some(k=>!['backupFile','sandboxDir'].includes(k)))
  invalid('RESTORE_DRILL_INVALID_OPTIONS');
 const {backupFile,sandboxDir}=options;
 if(!canonical(backupFile)||!canonical(sandboxDir)||sandboxDir===dirname(backupFile))
  invalid('RESTORE_DRILL_UNSAFE_PATH');
 let backupMeta:Awaited<ReturnType<typeof lstat>>,sandboxMeta:Awaited<ReturnType<typeof lstat>>;
 try{
  [backupMeta,sandboxMeta]=await Promise.all([lstat(backupFile),lstat(sandboxDir)]);
 }catch{
  // Distinguish a nonexistent or corrupt backup from an untrusted scratch path.
  try{await lstat(sandboxDir);}catch{throw new Error('RESTORE_DRILL_UNSAFE_PATH');}
  throw new Error('RESTORE_DRILL_INVALID_BACKUP');
 }
 if(!backupMeta.isFile()||backupMeta.isSymbolicLink()||
    !sandboxMeta.isDirectory()||sandboxMeta.isSymbolicLink())
  invalid('RESTORE_DRILL_UNSAFE_PATH');
 if((Number(backupMeta.mode)&0o077)!==0||(Number(sandboxMeta.mode)&0o077)!==0)
  invalid('RESTORE_DRILL_UNSAFE_PERMISSIONS');
 try{
  if(await realpath(backupFile)!==backupFile||await realpath(sandboxDir)!==sandboxDir)
   invalid('RESTORE_DRILL_UNSAFE_PATH');
 }catch{invalid('RESTORE_DRILL_UNSAFE_PATH');}
 if(!(await BotStore.verifySqliteBackupReadOnly(backupFile)))invalid('RESTORE_DRILL_INVALID_BACKUP');
 let source:DatabaseSync;
 try{source=new DatabaseSync(backupFile,{readOnly:true});}
 catch{throw new Error('RESTORE_DRILL_INVALID_BACKUP');}
 try{
  // Verify the actual opened handle before allowing any filesystem write.
  let original:BotState;
  try{
   const qc=source.prepare('PRAGMA quick_check').get() as {quick_check?:unknown}|undefined;
   if(qc?.quick_check!=='ok')invalid('RESTORE_DRILL_INVALID_BACKUP');
   const row=source.prepare('SELECT data FROM bot_state WHERE id=1').get() as {data?:unknown}|undefined;
   if(!row||typeof row.data!=='string')throw new Error('RESTORE_DRILL_INVALID_BACKUP');
   original=JSON.parse(row.data) as BotState;
  }catch{throw new Error('RESTORE_DRILL_INVALID_BACKUP');}
  // No ability to supply a destination filename. A random, non-overwritable
  // scratch path is generated ONLY under an already-existing private directory.
  const destination=join(sandboxDir,'restore-drill-'+randomUUID()+'.sqlite');
  let reserved=false;
  try{
   const fd=await open(destination,'wx',0o600);
   reserved=true;
   await fd.close();
   await backup(source,destination);
   // The complete scratch SQLite must validate, not just pass a file checksum.
   if(!(await BotStore.verifySqliteBackupReadOnly(destination)))
    invalid('RESTORE_DRILL_MISMATCH');
   const restored=new DatabaseSync(destination,{readOnly:true});
   let after:BotState;
   try{
    const check=restored.prepare('PRAGMA quick_check').get() as {quick_check?:unknown}|undefined;
    if(check?.quick_check!=='ok')invalid('RESTORE_DRILL_MISMATCH');
    const row=restored.prepare('SELECT data FROM bot_state WHERE id=1').get() as {data?:unknown}|undefined;
    if(!row||typeof row.data!=='string')throw new Error('RESTORE_DRILL_MISMATCH');
    after=JSON.parse(row.data) as BotState;
   }catch{throw new Error('RESTORE_DRILL_MISMATCH');}
   finally{restored.close();}
   // Compare the actual source snapshot to recovered BotState with no ignored
   // fields. In particular preserve grants, audit, publication receipts and
   // UNKNOWN_OUTCOME attempts, which MUST never be silently replayed.
   if(!isDeepStrictEqual(original,after))invalid('RESTORE_DRILL_MISMATCH');
   return {status:'VERIFIED',counts:{
    chats:after.chats.length,grants:after.grants.length,deliveries:after.deliveries.length,
    historicalPublications:after.historicalPublications.length,purgeJobs:after.purgeJobs.length,
    unknownPurgeItems:after.purgeJobs.reduce((n,j)=>n+j.items.filter(i=>i.status==='UNKNOWN_OUTCOME').length,0),
    unknownDeliveries:after.deliveries.filter(d=>d.status==='UNKNOWN_OUTCOME').length
   }};
  }finally{
   // Cleanup only the randomly created entry which this invocation reserved.
   // NEVER delete the backup source, primary DB, or preexisting sandbox files.
   if(reserved)await rm(destination,{force:true});
  }
 }finally{source.close();}
}
