import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestListener, IncomingMessage, ServerResponse } from 'node:http';
import { URLSearchParams } from 'node:url';
import { EducationAdminFacade, type VerifiedAdminContext } from './education-admin.js';
import type { ImportFormat } from './ingestion.js';
import type { BotStore } from './store.js';
import type { Policy } from './policy.js';
import type {PlatformCatalogPreviewService} from './platform-catalog-preview.js';
import { reviewTelegramReplyOutbox, recordTelegramReplyManualReview } from './telegram-reply-maintenance.js';
import {BoundedIngress,decodeStrictJsonBytes,type IngressOptions} from './http-ingress-guard.js';

const AUTH_HEADER='x-telegram-init-data';
const MAX_INIT_LENGTH=8192;
const MAX_JSON_BYTES=260*1024;
const isObject=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const safeScope=(v:unknown):v is string=>typeof v==='string' && (v==='private'||/^-[1-9]\d{0,18}$/.test(v));
const safeIdentifier=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** Telegram Mini App HMAC verifier. Never use initDataUnsafe or user IDs from POST bodies. */
export class TelegramMiniAppAuth {
  private readonly secret:Buffer;
  constructor(botToken:string, private readonly clock:()=>number=Date.now, private readonly maxAgeSeconds=600){
    if(!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(botToken))throw Error('INVALID_BOT_TOKEN_CONFIG');
    if(!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>3600)throw Error('INVALID_AUTH_WINDOW');
    this.secret=createHmac('sha256','WebAppData').update(botToken,'utf8').digest();
  }
  verify(raw:string):VerifiedAdminContext {
    const invalid=():never=>{throw Error('INVALID_MINIAPP_AUTH');};
    if(typeof raw!=='string'||raw.length<1||raw.length>MAX_INIT_LENGTH||/%(?![\da-f]{2})/iu.test(raw))return invalid();
    const fields=new URLSearchParams(raw);
    const values=new Map<string,string>();
    for(const [key,value] of fields){
      if(!/^[a-z][a-z0-9_]{0,63}$/i.test(key)||values.has(key)||value.length>6000
        ||/[\u0000-\u001f\u007f\ufffd]/u.test(key+value))return invalid();
      values.set(key,value);
    }
    const claimedHash=values.get('hash');
    if(!claimedHash||! /^[a-f0-9]{64}$/.test(claimedHash))return invalid();
    values.delete('hash');
    const data=[...values.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
    const expected=createHmac('sha256',this.secret).update(data).digest();
    const given=Buffer.from(claimedHash,'hex');
    if(given.length!==expected.length||!timingSafeEqual(given,expected))return invalid();
    const timestamp=values.get('auth_date');
    if(!timestamp||!/^\d{10}$/.test(timestamp))return invalid();
    const seconds=Number(timestamp),now=Math.floor(this.clock()/1000);
    if(!Number.isSafeInteger(now)||seconds<now-this.maxAgeSeconds||seconds>now+30)return invalid();
    let user:unknown;
    try {user=JSON.parse(values.get('user')??'');}catch{return invalid();}
    if(!isObject(user)||typeof user.id!=='number'||!Number.isSafeInteger(user.id)||user.id<=0||user.is_bot===true)return invalid();
    const actorId=String(user.id);
    return {origin:'ADMIN_WEB',actorId,chatId:actorId,verified:true};
  }
}

function reply(res:ServerResponse,status:number,body:Record<string,unknown>):void {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'"});
  res.end(JSON.stringify(body));
}
function requestInitData(req:IncomingMessage):string|null {
  const count=req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===AUTH_HEADER).length;
  const header=req.headers[AUTH_HEADER];
  return count===1&&typeof header==='string'&&header.length<=MAX_INIT_LENGTH?header:null;
}
function payloadError(err:unknown):number {
  if(err instanceof Error && ['UPLOAD_DENIED','PUBLISH_DENIED','UNTRUSTED_ADMIN_CONTEXT','OWNER_ONLY','SCOPE_DENIED'].includes(err.message))return 403;
  if(err instanceof Error && ['INVALID_FORMAT','INVALID_FILENAME','DOCUMENT_TOO_LARGE','FILE_TOO_LARGE','UNSUPPORTED_FORMAT','INVALID_CSV','INVALID_JSON','INVALID_HEADERS','INVALID_RECORD','NEEDS_REVIEW','DUPLICATE_CANDIDATE','NOT_APPROVED','CATEGORY_DISABLED_OR_MISSING','CANDIDATE_NOT_FOUND','CATEGORY_SCOPE_MISMATCH'].includes(err.message))return 422;
  return 503;
}
/** Local-only endpoint; no deployment, public CORS, cookies or Telegram output. */
export interface OwnerReplyReviewWebOptions{
 readonly store:BotStore;
 readonly policy:Policy;
 readonly clock?:()=>number;
 /** Opt-in, separately configured source reader. Never installs a real API itself. */
 readonly platformCatalog?:PlatformCatalogPreviewService;
}
/** Optional owner-only route extension. Existing admin routes remain unchanged,
 * and neither Telegram's live webhook server nor any external listener installs
 * these routes automatically.
 */
export function telegramAdminWebListener(auth:TelegramMiniAppAuth, admin:EducationAdminFacade,
  replyOps?:OwnerReplyReviewWebOptions,ingressOptions:IngressOptions={}):RequestListener {
  const guard=new BoundedIngress(ingressOptions);
  const routes=new Set(['/admin/panel','/admin/import','/admin/approve','/admin/publish']);
  if(replyOps){routes.add('/admin/replies/summary');routes.add('/admin/replies/review');}
  if(replyOps?.platformCatalog){
    routes.add('/admin/platform/preview');routes.add('/admin/platform/integrity');
  }
  return (req,res)=>{
    void (async()=>{
      if(req.method!=='POST'){reply(res,405,{ok:false});return;}
      if(!routes.has(req.url??'')){reply(res,404,{ok:false});return;}
      const opsRoute=req.url==='/admin/replies/summary'||req.url==='/admin/replies/review';
      const platformRoute=req.url==='/admin/platform/preview'||req.url==='/admin/platform/integrity';
      const initData=requestInitData(req);
      if(!initData){reply(res,401,{ok:false});return;}
      let ctx:VerifiedAdminContext;
      try{ctx=auth.verify(initData);}catch{reply(res,401,{ok:false});return;}
      // Auth derives actor from signed initData, never from submitted JSON.
      if((opsRoute||platformRoute)&&(!replyOps||!replyOps.policy.isOwner(ctx.actorId))){
        reply(res,403,{ok:false});return;
      }
      const release=guard.enter(req);
      if(!release){reply(res,503,{ok:false});return;}
      try{
      if(req.headers['content-encoding']!==undefined){reply(res,415,{ok:false});return;}
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){
        reply(res,415,{ok:false});return;
      }
      const maxBytes=opsRoute||platformRoute?2048:MAX_JSON_BYTES;
      const declared=req.headers['content-length'];
      if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes)){
        reply(res,413,{ok:false});return;
      }
      const chunks:Buffer[]=[];let total=0;
      for await(const chunk of req){
        total+=(chunk as Buffer).length;
        if(total>maxBytes){reply(res,413,{ok:false});return;}
        chunks.push(chunk as Buffer);
      }
      let payload:unknown;
      try{payload=decodeStrictJsonBytes(chunks);}
      catch{reply(res,400,{ok:false});return;}
      if(!isObject(payload)){reply(res,422,{ok:false});return;}
      try{
        if(platformRoute){
          // HMAC provides identity, but never bypasses local owner-dashboard
          // policy. Source data comes exclusively from an explicitly injected
          // read-only reader and is unverified until reviewed separately.
          const source=replyOps?.platformCatalog;
          if(!source){reply(res,404,{ok:false});return;}
          if(req.url==='/admin/platform/preview'){
            if(Object.keys(payload).some(k=>k!=='limit'&&k!=='cursor')||
               (payload.limit!==undefined&&(!Number.isSafeInteger(payload.limit)||
                 typeof payload.limit!=='number'||payload.limit<1||payload.limit>10))||
               (payload.cursor!==undefined&&payload.cursor!==null&&
                 (typeof payload.cursor!=='string'||!/^[A-Za-z0-9_-]{1,64}$/u.test(payload.cursor)))){
              reply(res,422,{ok:false});return;
            }
            const preview=await source.preview(ctx.actorId,{
              ...(payload.limit===undefined?{}:{limit:payload.limit as number}),
              ...(payload.cursor===undefined?{}:{cursor:payload.cursor as string|null})
            });
            if(preview.status!=='PREVIEW'){
              if(preview.status==='DENIED')reply(res,403,{ok:false});
              else reply(res,503,{ok:false,status:'UNAVAILABLE'});
              return;
            }
            reply(res,200,{
              ok:true,status:'PREVIEW',trust:'UNVERIFIED_EXTERNAL',
              records:preview.records,nextCursor:preview.nextCursor,
              fingerprint:preview.fingerprint
            });return;
          }
          if(Object.keys(payload).length!==2||
             !Object.keys(payload).every(k=>k==='sourceId'||k==='expectedDigest')||
             typeof payload.sourceId!=='string'||
             !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(payload.sourceId)||
             typeof payload.expectedDigest!=='string'||
             !/^[a-f0-9]{64}$/u.test(payload.expectedDigest)){
            reply(res,422,{ok:false});return;
          }
          const report=await source.inspectPublished(ctx.actorId,payload.sourceId,payload.expectedDigest);
          if(report.status==='DENIED'){reply(res,403,{ok:false});return;}
          if(report.status==='STALE'){reply(res,409,{ok:false,status:'STALE'});return;}
          if(report.status==='UNAVAILABLE'){reply(res,503,{ok:false,status:'UNAVAILABLE'});return;}
          if(report.status==='CURRENT'){
            reply(res,200,{ok:true,status:report.status,
              sourceId:report.sourceId,resourceId:report.resourceId});return;
          }
          reply(res,200,{ok:true,status:report.status});return;
        }
        if(opsRoute){
          // Both paths are reachable only when explicitly injected at creation.
          if(!replyOps){reply(res,404,{ok:false});return;}
          const now=(replyOps.clock??Date.now)();
          const staleAfterMs=15*60_000; // owner cannot weaken staleness from JSON
          if(req.url==='/admin/replies/summary'){
            if(Object.keys(payload).length!==0){reply(res,422,{ok:false});return;}
            const summary=await reviewTelegramReplyOutbox(replyOps.store,{now,staleAfterMs});
            reply(res,200,{ok:true,summary});return;
          }
          // Reject free-text notes, forged actor IDs, client clocks, evidence URLs,
          // and all unknown properties before mutating any durable state.
          if(Object.keys(payload).length!==3||
             !Object.keys(payload).every(k=>['updateKey','attemptId','decision'].includes(k))||
             typeof payload.updateKey!=='string'||
             !/^b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+$/.test(payload.updateKey)||
             typeof payload.attemptId!=='string'||
             !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.attemptId)||
             (payload.decision!=='ACKNOWLEDGED_UNRESOLVED'&&payload.decision!=='ESCALATED')){
            reply(res,422,{ok:false});return;
          }
          try {
            const result=await recordTelegramReplyManualReview(replyOps.store,replyOps.policy,{
              actorId:ctx.actorId,updateKey:payload.updateKey,attemptId:payload.attemptId,
              decision:payload.decision,now,staleAfterMs
            });
            reply(res,200,{ok:true,result:result.result});return;
          }catch(err){
            // No raw exceptions, paths, receipt IDs, or provider/student payloads.
            const conflict=err instanceof Error&&[
              'REPLY_REVIEW_NOT_FOUND','REPLY_REVIEW_NOT_STALE',
              'REPLY_REVIEW_NOT_REVIEWABLE','REPLY_REVIEW_ATTEMPT_MISMATCH',
              'REPLY_REVIEW_ALREADY_RECORDED'
            ].includes(err.message);
            reply(res,conflict?409:503,{ok:false});return;
          }
        }
        if(req.url==='/admin/panel'){
          if(!safeScope(payload.scope)){reply(res,422,{ok:false});return;}
          const panel=await admin.panel(ctx,payload.scope);
          reply(res,200,{ok:true,panel});return;
        }
        if(req.url==='/admin/import'){
          if(!safeScope(payload.scope)||!['csv','json','txt','md'].includes(String(payload.format))
            ||typeof payload.filename!=='string'||typeof payload.text!=='string'
            ||Buffer.byteLength(payload.text,'utf8')>256*1024){reply(res,422,{ok:false});return;}
          const run=await admin.upload(ctx,payload.scope,payload.format as ImportFormat,payload.filename,payload.text);
          reply(res,200,{ok:true,id:run.id,report:run.report});return;
        }
        if(!safeIdentifier(payload.importId)||!Number.isSafeInteger(payload.index)
          ||typeof payload.index!=='number'||payload.index<0||!safeIdentifier(payload.categoryId)){
          reply(res,422,{ok:false});return;
        }
        if(req.url==='/admin/approve'){
          await admin.approve(ctx,payload.importId,payload.index,payload.categoryId);
          reply(res,200,{ok:true,status:'APPROVED_LOCALLY'});return;
        }
        const resource=await admin.publish(ctx,payload.importId,payload.index,payload.categoryId);
        reply(res,200,{ok:true,status:'PUBLISHED_IN_LOCAL_LIBRARY',resourceId:resource.id});
      }catch(err){reply(res,payloadError(err),{ok:false});}
      }finally{release();}
    })().catch(()=>{if(!res.headersSent)reply(res,503,{ok:false});else res.end();});
  };
}
