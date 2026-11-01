import type {TelegramDocumentPort} from './telegram-transport.js';
const fail=():never=>{throw Error('TELEGRAM_DOCUMENT_UNAVAILABLE');};
async function bounded(response:Response,max:number):Promise<Uint8Array>{
 if(!response.ok||response.status!==200||!response.body)return fail();
 const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/u.test(length)||Number(length)>max))return fail();
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>max){await reader.cancel();return fail();}chunks.push(part.value);}
 }finally{reader.releaseLock();}
 if(length!==null&&Number(length)!==size)return fail();
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
/** Official getFile + fixed-host download. No caller URL, redirects, disk writes or retries. */
export class TelegramBotApiDocumentDownloader implements TelegramDocumentPort{
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch,private readonly safety:()=>Promise<boolean>=async()=>false){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))throw Error('INVALID_TELEGRAM_TOKEN');
 }
 async download(fileId:string,maxBytes:number):Promise<Uint8Array>{
  try{
   if(!/^[A-Za-z0-9_-]{8,512}$/u.test(fileId)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>256*1024||!await this.safety())return fail();
   const signal=AbortSignal.timeout(8000);
   const metadata=await this.request('https://api.telegram.org/bot'+this.token+'/getFile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({file_id:fileId}),redirect:'error',signal});
   const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(metadata,16384)));
   if(!value||typeof value!=='object'||Array.isArray(value))return fail();
   const api=value as Record<string,unknown>,r=api.result;
   if(api.ok!==true||!r||typeof r!=='object'||Array.isArray(r))return fail();
   const file=r as Record<string,unknown>,path=file.file_path;
   if(file.file_id!==fileId||typeof path!=='string'||path.length>512||!path.split('/').every(segment=>/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(segment))||!path.includes('/')||!Number.isSafeInteger(file.file_size)||Number(file.file_size)<1||Number(file.file_size)>maxBytes||!await this.safety())return fail();
   const response=await this.request('https://api.telegram.org/file/bot'+this.token+'/'+path,{method:'GET',redirect:'error',signal});
   const bytes=await bounded(response,maxBytes);if(bytes.length!==file.file_size||!await this.safety())return fail();return bytes;
  }catch{return fail();}
 }
}
