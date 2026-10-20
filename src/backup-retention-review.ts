import {createHash} from 'node:crypto';
import {lstat,realpath,readdir} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {BotStore} from './store.js';

/** An offline, read-only advisory: never an authorization to delete any file. */
export interface BackupRetentionReviewOptions {
 directory:string;retentionDays:number;now:number;maxEntries?:number;
}
export type BackupHealth='VALID_RECENT'|'EXPIRED_CANDIDATE'|'INVALID'|'UNSAFE_LINK'|'UNSAFE_PERMISSIONS'|'FUTURE_TIMESTAMP';
export interface BackupReviewEntry {ref:string;status:BackupHealth}
export interface BackupRetentionReviewReport {
 scannedAt:number;retentionDays:number;scanned:number;validRecent:number;
 expiredCandidates:number;invalid:number;unsafe:number;skipped:number;
 entries:BackupReviewEntry[];
}
const DAY_MS=86_400_000,MAX_ENTRIES=500;
const ident=(name:string)=>createHash('sha256').update('manaratak:backup:local-ref:'+name).digest('hex');
/** Inspect an explicitly designated private directory. No scheduler, no network,
 * no file deletion/compaction, and no promotion of an unvalidated backup.
 * Names and absolute file paths never leave the local module.
 */
export async function reviewSqliteBackups(options:BackupRetentionReviewOptions):Promise<BackupRetentionReviewReport>{
 if(!options||typeof options!=='object'||Array.isArray(options)||
    Object.keys(options).some(k=>!['directory','retentionDays','now','maxEntries'].includes(k))||
    typeof options.retentionDays!=='number'||!Number.isSafeInteger(options.retentionDays)||
    options.retentionDays<1||options.retentionDays>365||
    typeof options.now!=='number'||!Number.isSafeInteger(options.now)||options.now<0||
    (options.maxEntries!==undefined&&
     (typeof options.maxEntries!=='number'||!Number.isSafeInteger(options.maxEntries)||
      options.maxEntries<1||options.maxEntries>MAX_ENTRIES)))
    throw new Error('BACKUP_REVIEW_INVALID_POLICY');
 const dir=options.directory;
 if(typeof dir!=='string'||!isAbsolute(dir)||dir!==resolve(dir)||
    /[\u0000-\u001f\u007f]/u.test(dir))throw new Error('BACKUP_REVIEW_UNSAFE_DIRECTORY');
 try{
  const stat=await lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
     await realpath(dir)!==dir)throw new Error('BACKUP_REVIEW_UNSAFE_DIRECTORY');
 }catch{throw new Error('BACKUP_REVIEW_UNSAFE_DIRECTORY');}
 const listing=await readdir(dir,{withFileTypes:true}).catch(()=>{throw new Error('BACKUP_REVIEW_UNSAFE_DIRECTORY');});
 if(listing.length>(options.maxEntries??MAX_ENTRIES))throw new Error('BACKUP_REVIEW_TOO_MANY_ENTRIES');
 const report:BackupRetentionReviewReport={
  scannedAt:options.now,retentionDays:options.retentionDays,
  scanned:0,validRecent:0,expiredCandidates:0,invalid:0,unsafe:0,skipped:0,entries:[]
 };
 for(const entry of listing.sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  // Do not traverse nested directories, .sqlite-wal, unrelated notes, exports
  // or unknown backup types. This is NOT a promise to audit offsite copies.
  if(!entry.name.endsWith('.sqlite')||entry.name.length>128||entry.name.startsWith('.')||
     !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.sqlite$/.test(entry.name)){
   report.skipped++;continue;
  }
  const path=join(dir,entry.name),ref=ident(entry.name);
  let status:BackupHealth;
  if(entry.isSymbolicLink()){status='UNSAFE_LINK';}
  else if(!entry.isFile()){report.skipped++;continue;}
  else{
   let info:Awaited<ReturnType<typeof lstat>>;
   try{info=await lstat(path);}catch{status='INVALID';report.invalid++;report.scanned++;report.entries.push({ref,status});continue;}
   if(!info.isFile()||info.isSymbolicLink()){status='UNSAFE_LINK';}
   else if((info.mode&0o077)!==0){status='UNSAFE_PERMISSIONS';}
   else if(!Number.isFinite(info.mtimeMs)||info.mtimeMs>options.now){status='FUTURE_TIMESTAMP';}
   else{
    const valid=await BotStore.verifySqliteBackupReadOnly(path);
    if(!valid)status='INVALID';
    else status=options.now-info.mtimeMs>options.retentionDays*DAY_MS?'EXPIRED_CANDIDATE':'VALID_RECENT';
   }
  }
  report.scanned++;report.entries.push({ref,status});
  if(status==='EXPIRED_CANDIDATE')report.expiredCandidates++;
  else if(status==='VALID_RECENT')report.validRecent++;
  else if(status==='INVALID'||status==='FUTURE_TIMESTAMP')report.invalid++;
  else report.unsafe++;
 }
 return report;
}
