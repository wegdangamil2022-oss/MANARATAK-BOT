import {constants,type BigIntStats} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';

/** A separately provisioned, private, durable operator kill switch.
 * The bot cannot create, edit, or remove the flag. The trusted host operator
 * replaces it atomically with mode 0600 (or stricter) and EXACT contents
 * RUN\n or STOP\n. No inferred default and no Telegram API request.
 *
 * The opened file descriptor, not a second pathname lookup, supplies the
 * content. A hard link or replacement during the read is rejected: a pathname
 * verified before a network action must never authorize a different inode.
 */
export async function readTelegramSafetySwitch(file:string):Promise<'RUN'|'STOP'>{
 const invalid=():never=>{throw Error('LIVE_TELEGRAM_SAFETY_INVALID');};
 if(typeof file!=='string'||!isAbsolute(file)||file!==resolve(file)||
   /[\u0000-\u001f\u007f]/u.test(file))return invalid();
 // O_NOFOLLOW prevents an attacker from replacing the final component with a
 // symlink before open. O_NONBLOCK avoids blocking indefinitely on a FIFO
 // substituted at the path. Only regular private files pass the fstat gate.
 const flags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
 try{
  const handle=await open(file,flags);
  try{
   const first=await handle.stat({bigint:true});
   const trusted=(s:BigIntStats)=>s.isFile()&&!s.isSymbolicLink()&&
    s.nlink===1n&&(s.mode&0o077n)===0n&&s.size>=4n&&s.size<=5n;
   const sameInode=(a:BigIntStats,b:BigIntStats)=>
    a.dev===b.dev&&a.ino===b.ino;
   if(!trusted(first))return invalid();
   // Verify the actual opened inode still belongs to this canonical path.
   const before=await lstat(file,{bigint:true});
   if(!trusted(before)||!sameInode(first,before)||
      await realpath(file)!==file)return invalid();
   const body=await handle.readFile('utf8');
   // A STOP/RUN rewrite (even of equal length) or a pathname swap while
   // reading must not be interpreted as a stable operator instruction.
   const after=await handle.stat({bigint:true});
   const pathnameAfter=await lstat(file,{bigint:true});
   if(!trusted(after)||!trusted(pathnameAfter)||
      !sameInode(first,after)||!sameInode(first,pathnameAfter)||
      first.mode!==after.mode||first.size!==after.size||
      first.mtimeNs!==after.mtimeNs||first.ctimeNs!==after.ctimeNs||
      await realpath(file)!==file)return invalid();
   if(body==='RUN\n')return 'RUN';
   if(body==='STOP\n')return 'STOP';
   return invalid();
  }finally{await handle.close();}
 }catch{return invalid();}
}
/** Fail-closed per-attempt gate: missing, forged, corrupt, or unreadable flags
 * never default to RUN, including after a live process has started.
 */
export function createTelegramSafetyGate(file:string):()=>Promise<boolean>{
 return async()=>{
  try{return await readTelegramSafetySwitch(file)==='RUN';}
  catch{return false;}
 };
}
