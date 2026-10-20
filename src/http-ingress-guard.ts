import type {IncomingMessage} from 'node:http';

/** Local process backpressure only, NOT an IP-level rate limiter or a substitute
 * for ingress proxy throttling. Acquire after authentication, before reading a
 * body or claiming a durable update, and hold through external side effects.
 */
export interface IngressOptions {
 readonly maxActive?:number;
 readonly inactivityTimeoutMs?:number;
}
export class BoundedIngress {
 private active=0;
 readonly maxActive:number;
 readonly inactivityTimeoutMs:number;
 constructor(options:IngressOptions={}){
  if(!options||typeof options!=='object'||Array.isArray(options)||
    Object.keys(options).some(k=>!['maxActive','inactivityTimeoutMs'].includes(k))||
    (options.maxActive!==undefined&&(!Number.isSafeInteger(options.maxActive)||
      options.maxActive<1||options.maxActive>64))||
    (options.inactivityTimeoutMs!==undefined&&
      (!Number.isSafeInteger(options.inactivityTimeoutMs)||
      options.inactivityTimeoutMs<250||options.inactivityTimeoutMs>30_000)))
   throw Error('INVALID_INGRESS_OPTIONS');
  this.maxActive=options.maxActive??16;
  this.inactivityTimeoutMs=options.inactivityTimeoutMs??15_000;
 }
 enter(req:IncomingMessage):null|(()=>void){
  if(this.active>=this.maxActive)return null;
  this.active++;
  let left=false;
  req.setTimeout(this.inactivityTimeoutMs,()=>{
   // Never report a truncated request as valid, never initiate a retry.
   req.destroy();
  });
  return ()=>{
   if(left)return;
   left=true;
   req.setTimeout(0);
   this.active--;
  };
 }
}

/** Reject silent lossy decoding and BOM ambiguity. Body is read only after
 * the caller enforces its size/identity/content-type budget.
 */
export function decodeStrictJsonBytes(chunks:readonly Uint8Array[]):unknown {
 const body=Buffer.concat(chunks);
 if(body.length>=3&&body[0]===0xef&&body[1]===0xbb&&body[2]===0xbf)
  throw Error('HTTP_INVALID_JSON');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}
 catch{throw Error('HTTP_INVALID_JSON');}
}
