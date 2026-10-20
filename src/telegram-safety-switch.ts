import {lstat,realpath,readFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';

/** A separately provisioned, private, durable operator kill switch.
 * The bot cannot create, edit, or remove the flag. The trusted host operator
 * replaces it atomically with mode 0600 (or stricter) and EXACT contents
 * RUN\n or STOP\n. No inferred default and no Telegram API request.
 */
export async function readTelegramSafetySwitch(file:string):Promise<'RUN'|'STOP'>{
 const invalid=():never=>{throw Error('LIVE_TELEGRAM_SAFETY_INVALID');};
 if(typeof file!=='string'||!isAbsolute(file)||file!==resolve(file)||
   /[\u0000-\u001f\u007f]/u.test(file))return invalid();
 try{
  const meta=await lstat(file);
  if(!meta.isFile()||meta.isSymbolicLink()||(meta.mode&0o077)!==0||
    meta.size<4||meta.size>5||await realpath(file)!==file)return invalid();
  const body=await readFile(file,'utf8');
  if(body==='RUN\n')return 'RUN';
  if(body==='STOP\n')return 'STOP';
  return invalid();
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
