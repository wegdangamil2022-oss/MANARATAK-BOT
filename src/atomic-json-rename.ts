import {rename} from 'node:fs/promises';
const RETRY_DELAYS=[10,30,80,160,320] as const;
/** Retry a Windows sharing conflict without deleting the old state or temp file. */
export async function renameStateAtomically(from:string,to:string,
 move:(from:string,to:string)=>Promise<void>=rename,platform:NodeJS.Platform=process.platform,
 wait:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))):Promise<void>{
 for(let attempt=0;;attempt++){
  try{await move(from,to);return;}catch(error){
   const code=(error as NodeJS.ErrnoException|null)?.code;
   if(platform!=='win32'||(code!=='EPERM'&&code!=='EBUSY')||attempt>=RETRY_DELAYS.length)throw error;
   await wait(RETRY_DELAYS[attempt]!);
  }
 }
}
