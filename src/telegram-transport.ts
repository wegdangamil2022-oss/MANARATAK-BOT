import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { BotStore, type AuditRecord } from './store.js';
import { Policy } from './policy.js';
import { EducationService } from './education.js';
import { EducationAdminFacade, type VerifiedAdminContext } from './education-admin.js';
import { ApprovedAnswerService, ResourceLinkService, type MembershipPort } from './education-interactions.js';
import type { ImportFormat } from './ingestion.js';
import type { SubscriptionGate } from './subscription.js';
import type { TelegramReplyDispatcher } from './telegram-replies.js';

/** Inbound-only boundary. A test double may supply bytes; there is intentionally no live HTTP implementation. */
export interface TelegramDocumentPort {
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
}
const MAX_DOCUMENT_BYTES = 256 * 1024;
const documentFormats: Readonly<Record<string, ImportFormat>> = {
  csv: 'csv', json: 'json', md: 'md', txt: 'txt'
};
const acceptedMimes: Readonly<Record<ImportFormat, ReadonlySet<string>>> = {
  csv: new Set(['text/csv','text/plain','application/octet-stream','application/vnd.ms-excel']),
  json: new Set(['application/json','text/plain','application/octet-stream']),
  md: new Set(['text/markdown','text/plain','application/octet-stream']),
  txt: new Set(['text/plain','application/octet-stream'])
};
interface IncomingDocument {
  fileId: string; filename: string; size: number; format: ImportFormat; caption: string;
}
/** Offline B3 application adapter: creates plans, NEVER sends a message or connects to Telegram. */
export interface TelegramReplyPlan { chatId: string; parseMode: 'HTML'; text: string; }
export interface TelegramResult { status: 'APPLIED' | 'DUPLICATE' | 'DENIED' | 'IGNORED' | 'UNKNOWN'; reason: string; plan?: TelegramReplyPlan; deliveryKey?: string; }
export interface TelegramApplicationOptions {
  store: BotStore; policy: Policy; education: EducationService; admin: EducationAdminFacade;
  faq: ApprovedAnswerService; links: ResourceLinkService; membership: MembershipPort;
  botId: string; botUsername: string; subscription?: SubscriptionGate; clock?: () => number; documentDownload?: TelegramDocumentPort;
}

type Event = {updateId: number; actorId: string; chatId: string; kind: 'private' | 'group'; text: string; document?: IncomingDocument};
const isObject=(x:unknown):x is Record<string,unknown>=>Boolean(x)&&typeof x==='object'&&!Array.isArray(x);
const positiveId=(x:unknown): x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
const chatId=(x:unknown): x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x!==0;
export function escapeTelegramHtml(text:string):string {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function eventFrom(value:unknown):{event?:Event;reason:string} {
  if(!isObject(value)||!Number.isSafeInteger(value.update_id)||typeof value.update_id!=='number'||value.update_id<0)return {reason:'INVALID_UPDATE_ID'};
  if(!isObject(value.message))return {reason:'UNSUPPORTED_EVENT'};
  const msg=value.message;
  if(!isObject(msg.chat)||!isObject(msg.from)||!positiveId(msg.from.id)||msg.from.is_bot!==false||!chatId(msg.chat.id))return {reason:'INVALID_ACTOR_OR_CHAT'};
  if(msg.sender_chat!==undefined||msg.via_bot!==undefined||msg.forward_origin!==undefined||msg.forward_date!==undefined||msg.is_automatic_forward===true)return {reason:'UNTRUSTED_FORWARD'};
  const kind=msg.chat.type==='private'?'private':msg.chat.type==='group'||msg.chat.type==='supergroup'?'group':null;
  if(!kind || (kind==='private'&&(msg.chat.id!==msg.from.id))||(kind==='group'&&msg.chat.id>=0))return {reason:'INVALID_CHAT_CONTEXT'};
  if(msg.document!==undefined){
    // Telegram must not attach both an ordinary text command and a document.
    if (!isObject(msg.document) || msg.text!==undefined) return {reason:'INVALID_DOCUMENT'};
    const d=msg.document;
    if(typeof d.file_id!=='string'||!/^[A-Za-z0-9_-]{8,512}$/.test(d.file_id)
      ||typeof d.file_name!=='string'||d.file_name.length>120
      ||/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u.test(d.file_name)
      ||!Number.isSafeInteger(d.file_size)||typeof d.file_size!=='number'||d.file_size<1||d.file_size>MAX_DOCUMENT_BYTES)
      return {reason:'INVALID_DOCUMENT'};
    const extension=d.file_name.split('.').at(-1)?.toLowerCase()??'';
    const format=documentFormats[extension];
    if(!format || typeof d.mime_type!=='undefined' && (typeof d.mime_type!=='string'||!acceptedMimes[format].has(d.mime_type.toLowerCase())))
      return {reason:'INVALID_DOCUMENT'};
    if(msg.caption!==undefined&&(typeof msg.caption!=='string'||msg.caption.length>100))return {reason:'INVALID_DOCUMENT_CAPTION'};
    const document:IncomingDocument={fileId:d.file_id,filename:d.file_name,size:d.file_size,format,caption:typeof msg.caption==='string'?msg.caption:''};
    return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),chatId:String(msg.chat.id),kind,text:'',document},reason:'VALID'};
  }
  if(typeof msg.text!=='string'||msg.text.length<1||msg.text.length>4096)return {reason:'UNSUPPORTED_MESSAGE'};
  if(/\u0000/u.test(msg.text))return {reason:'INVALID_TEXT'};
  return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),chatId:String(msg.chat.id),kind,text:msg.text},reason:'VALID'};
}

const isScope=(scope:string):boolean=>scope==='private'||/^-[1-9]\d{0,18}$/.test(scope);
const isId=(value:string):boolean=>/^[a-zA-Z0-9_-]{1,64}$/.test(value);
const asNumber=(value:string):number|null=>/^\d{1,8}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
function safeError(err:unknown):string {
  const message=err instanceof Error?err.message:'';
  const known=new Set(['UPLOAD_DENIED','PUBLISH_DENIED','INVALID_UPLOAD_ORIGIN','INVALID_FAQ','INVALID_FORMAT','INVALID_FILENAME','DOCUMENT_TOO_LARGE','NOT_APPROVED','CANDIDATE_NOT_FOUND','IMPORT_NOT_FOUND','CATEGORY_SCOPE_MISMATCH','NEEDS_REVIEW','DUPLICATE_CANDIDATE','RESOURCE_ARCHIVED','CATEGORY_DISABLED_OR_MISSING']);
  return known.has(message)?message:'OPERATION_UNAVAILABLE';
}

export class TelegramUpdateApplication {
  private readonly clock:()=>number;
  constructor(private readonly opts:TelegramApplicationOptions){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(opts.botId)||!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(opts.botUsername))throw Error('INVALID_BOT_CONFIG');
    this.clock=opts.clock??Date.now;
  }
  private plan(chatId:string,text:string):TelegramReplyPlan {
    if(Buffer.byteLength(text,'utf8')>4096)throw Error('REPLY_TOO_LONG');
    return {chatId,parseMode:'HTML',text};
  }
  // A private chat is not proof of membership in an approved group. Group-scoped
  // libraries require a fresh trusted membership check even when opened in DM.
  private async authorizePrivateGroupBrowse(scope:string,actorId:string):Promise<string|null> {
    if(scope==='private')return null;
    const before=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(before,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    let member:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
    try {member=await this.opts.membership(scope,actorId);}catch{return 'MEMBERSHIP_UNAVAILABLE';}
    if(member!=='VERIFIED')return member==='NOT_MEMBER'?'GROUP_MEMBERSHIP_REQUIRED':'MEMBERSHIP_UNAVAILABLE';
    if(before.subscriptionRequirements.some(r=>r.chatId===scope&&r.channelIds.length)) {
      if(!this.opts.subscription)return 'SUBSCRIPTION_UNAVAILABLE';
      const check=await this.opts.subscription.verify(scope,actorId);
      if(check.status!=='MEMBER'&&check.status!=='NOT_REQUIRED')return check.status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE';
    }
    const after=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(after,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    return null;
  }
  private async handleDocument(event:Event):Promise<TelegramResult> {
    const {actorId,chatId,kind,document}=event;
    if(!document)throw Error('MISSING_DOCUMENT');
    // Even approved groups must not download documents or process them as admin commands.
    if(kind!=='private')return {status:'DENIED',reason:'PRIVATE_ADMIN_UPLOAD_ONLY'};
    const scopeMatch=/^\/upload\s+(private|-[1-9]\d{0,18})$/u.exec(document.caption);
    if(!scopeMatch)return {status:'DENIED',reason:'INVALID_DOCUMENT_CAPTION'};
    const scope=scopeMatch[1]!;
    const ctx:VerifiedAdminContext={origin:'TELEGRAM_PRIVATE',actorId,chatId,verified:true};
    const panel=await this.opts.admin.panel(ctx,scope);
    // The permission gate MUST precede any expensive or external download request.
    if(!panel.canUpload)return {status:'DENIED',reason:'UPLOAD_DENIED'};
    if(!this.opts.documentDownload)return {status:'DENIED',reason:'DOCUMENT_DOWNLOAD_NOT_CONFIGURED'};
    let data:Uint8Array;
    try{data=await this.opts.documentDownload.download(document.fileId,MAX_DOCUMENT_BYTES);}
    catch{return {status:'DENIED',reason:'DOCUMENT_DOWNLOAD_UNAVAILABLE'};}
    if(!(data instanceof Uint8Array) || data.byteLength!==document.size || data.byteLength>MAX_DOCUMENT_BYTES)
      return {status:'DENIED',reason:'DOCUMENT_SIZE_MISMATCH'};
    let text:string;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}
    catch{return {status:'DENIED',reason:'DOCUMENT_NOT_UTF8'};}
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
      return {status:'DENIED',reason:'DOCUMENT_BINARY_CONTENT'};
    // EducationService rechecks upload authorization under its state transaction
    // after the asynchronous download; revocation wins over a stale preflight.
    const run=await this.opts.admin.upload(ctx,scope,document.format,document.filename,text);
    const report=run.report;
    return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,
      `<b>تقرير استيراد ملف Telegram تجريبي</b>\nالمعرف: <code>${escapeTelegramHtml(run.id)}</code>\nالأقسام: ${report.sections}\nالجامعات: ${report.universities}\nفرص مرشحة: ${report.opportunities}\nيتطلب المراجعة قبل الاعتماد والنشر المحلي.`)};
  }
  private async process(event:Event):Promise<{status:TelegramResult['status'];reason:string;plan?:TelegramReplyPlan}> {
    if(event.document)return this.handleDocument(event);
    const {actorId,chatId,kind,text}=event;
    if(kind==='group'&&!this.opts.policy.canUseChat(await this.opts.store.snapshot(),chatId,'navigation'))return {status:'DENIED',reason:'CHAT_NOT_AUTHORIZED'};
    const adminCtx:VerifiedAdminContext={origin:'TELEGRAM_PRIVATE',actorId,chatId,verified:true};
    const words=text.split(/\s+/u);
    const cmd=words[0]??'';
    if(kind==='group'&&(cmd==='/categories'||cmd==='/resources'||cmd===`/ask@${this.opts.botUsername}`)) {
      const snapshot=await this.opts.store.snapshot();
      if(snapshot.subscriptionRequirements.some(r=>r.chatId===chatId&&r.channelIds.length)) {
        if(!this.opts.subscription)return {status:'DENIED',reason:'SUBSCRIPTION_UNAVAILABLE'};
        const verified=await this.opts.subscription.verify(chatId,actorId);
        if(verified.status!=='MEMBER'&&verified.status!=='NOT_REQUIRED')return {status:'DENIED',reason:verified.status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE'};
        // SubscriptionGate re-evaluates its own configuration; the content services
        // below re-read permissions after the async membership lookup.
      }
    }
    const result=(message:string):TelegramResult=>({status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,message)});
    if(cmd==='/admin'&&kind==='private'){
      const scope=words[1];if(!scope||!isScope(scope))return {status:'DENIED',reason:'INVALID_SCOPE'};
      const p=await this.opts.admin.panel(adminCtx,scope);
      return result(`<b>لوحة منارتك (${escapeTelegramHtml(scope)})</b>\nرفع: ${p.canUpload?'مسموح':'غير متاح'}\nمراجعة ونشر محلي: ${p.canPublish?'مسموح':'غير متاح'}`);
    }
    if(cmd==='/import'&&kind==='private'){
      const match=/^\/import (private|-[1-9]\d*) (csv|json|txt|md) ([a-zA-Z0-9._-]{1,90})\n([\s\S]+)$/u.exec(text);
      if(!match)return {status:'DENIED',reason:'INVALID_IMPORT_COMMAND'};
      const scope=match[1]!,format=match[2]! as ImportFormat,filename=match[3]!,body=match[4]!;
      const run=await this.opts.admin.upload(adminCtx,scope,format,filename,body);
      return result(`<b>تقرير استيراد تجريبي</b>\nالمعرف: <code>${escapeTelegramHtml(run.id)}</code>\nالأقسام: ${run.report.sections}\nالجامعات: ${run.report.universities}\nفرص مرشحة: ${run.report.opportunities}\nيتطلب المراجعة قبل الاعتماد والنشر المحلي.`);
    }
    if((cmd==='/approve'||cmd==='/publish')&&kind==='private'){
      if(words.length!==4||!isId(words[1]??'')||asNumber(words[2]??'')===null||!isId(words[3]??''))return {status:'DENIED',reason:'INVALID_REVIEW_COMMAND'};
      const importId=words[1]!,index=asNumber(words[2]!)!,categoryId=words[3]!;
      if(cmd==='/approve'){
        await this.opts.admin.approve(adminCtx,importId,index,categoryId);
        return result('تم اعتماد سجل المحتوى محليًا. لم يُنشر بعد.');
      }
      const resource=await this.opts.admin.publish(adminCtx,importId,index,categoryId);
      return result(`تم نشر المورد داخل المكتبة المحلية فقط: ${escapeTelegramHtml(resource.title)}\nلا إرسال إلى قناة Telegram.`);
    }
    if(cmd==='/categories'){
      const scope=kind==='private'?(words[1]??'private'):chatId;
      if(!isScope(scope))return {status:'DENIED',reason:'INVALID_SCOPE'};
      if(kind==='private') {
        const denied=await this.authorizePrivateGroupBrowse(scope,actorId);
        if(denied)return {status:'DENIED',reason:denied};
      }
      const categories=await this.opts.education.listCategories(actorId,scope);
      if(!categories.length)return {status:'DENIED',reason:'NO_ACCESSIBLE_CATEGORIES'};
      return result('<b>التعليم والموارد</b>\n'+categories.slice(0,12).map(c=>`• ${escapeTelegramHtml(c.title)} (<code>${escapeTelegramHtml(c.id)}</code>)`).join('\n'));
    }
    if(cmd==='/resources'){
      const scope=kind==='private'?(words[1]??''):chatId,cat=kind==='private'?words[2]:words[1];
      if(!isScope(scope)||!cat||!isId(cat))return {status:'DENIED',reason:'INVALID_RESOURCE_QUERY'};
      if(kind==='private') {
        const denied=await this.authorizePrivateGroupBrowse(scope,actorId);
        if(denied)return {status:'DENIED',reason:denied};
      }
      const resources=await this.opts.education.listResources(actorId,scope,cat);
      if(!resources.length)return {status:'DENIED',reason:'NO_ACCESSIBLE_RESOURCES'};
      return result('<b>الموارد المنشورة</b>\n'+resources.slice(0,12).map(r=>`• ${escapeTelegramHtml(r.title)}${r.university?` — ${escapeTelegramHtml(r.university)}`:''}`).join('\n'));
    }
    if(cmd==='/resource'&&kind==='private'){
      if(words.length!==2)return {status:'DENIED',reason:'INVALID_RESOURCE_REF'};
      const opened=await this.opts.links.resolve(words[1]!,actorId,this.opts.membership);
      if(opened.status!=='FOUND')return {status:'DENIED',reason:'RESOURCE_DENIED'};
      return result(`<b>مورد تعليمي</b>\n${escapeTelegramHtml(opened.resource.title)}\n${escapeTelegramHtml(opened.resource.university)}`);
    }
    if(kind==='group'&&text.startsWith(`/ask@${this.opts.botUsername} `)){
      const question=text.slice(`/ask@${this.opts.botUsername} `.length);
      const ans=await this.opts.faq.answerGroup(actorId,chatId,question,true);
      if(ans.status!=='ANSWER')return {status:'DENIED',reason:`FAQ_${ans.status}`};
      return result(`<b>إجابة من موارد منارتك المعتمدة</b>\n${escapeTelegramHtml(ans.answer)}`);
    }
    // No admin command may be executed in groups; no AI or subscription bypass.
    return {status:'IGNORED',reason:'UNSUPPORTED_COMMAND'};
  }
  async handle(payload:unknown):Promise<TelegramResult> {
    const parsed=eventFrom(payload);
    if(!parsed.event)return {status:parsed.reason==='UNSUPPORTED_EVENT'?'IGNORED':'DENIED',reason:parsed.reason};
    const event=parsed.event;
    const key=`b3-webhook:${this.opts.botId}:${event.updateId}`;
    const claim=await this.opts.store.claim(key,this.clock());
    if(claim!=='CLAIMED')return {status:claim==='UNKNOWN'?'UNKNOWN':'DUPLICATE',reason:'REPLAY_OR_UNRESOLVED'};
    let handled:{status:TelegramResult['status'];reason:string;plan?:TelegramReplyPlan};
    try{handled=await this.process(event);}catch(err){handled={status:'DENIED',reason:safeError(err)};}
    const audit:AuditRecord={updateKey:key,decision:handled.status==='APPLIED'?'ALLOW':handled.status==='DENIED'?'DENY':'NOOP',reason:handled.reason,policyVersion:0,at:this.clock()};
    // Commit the decision and outbound reply intent in one durable transaction.
    // No external call occurs before the outbox row exists.
    await this.opts.store.finish(key,audit,handled.plan);
    return handled.plan?{...handled,deliveryKey:key}:handled;
  }
}

const SECRET_HEADER='x-telegram-bot-api-secret-token';
const MAX_BODY=64*1024;
function secretValid(req:IncomingMessage, secret:string):boolean {
  const headerCount=req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===SECRET_HEADER).length;
  const received=req.headers[SECRET_HEADER];
  if(headerCount!==1||typeof received!=='string')return false;
  const a=Buffer.from(received,'utf8'),b=Buffer.from(secret,'utf8');
  return a.length===b.length&&timingSafeEqual(a,b);
}
function respond(res:ServerResponse,status:number,body:Record<string,unknown>):void {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(body));
}
/** Verifies Telegram's shared webhook secret and HTTP boundaries. Does not send any outbound messages. */
export function telegramWebhookListener(app:TelegramUpdateApplication,secretToken:string,
 outbound?:TelegramReplyDispatcher):RequestListener {
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(secretToken))throw Error('INVALID_WEBHOOK_SECRET');
  return (req,res)=>{
    void (async()=>{
      if(req.method!=='POST'){respond(res,405,{ok:false});return;}
      if(req.url!=='/telegram/webhook'){respond(res,404,{ok:false});return;}
      if(!secretValid(req,secretToken)){respond(res,401,{ok:false});return;}
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){respond(res,415,{ok:false});return;}
      const declared=req.headers['content-length'];
      if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY)){respond(res,413,{ok:false});return;}
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=(chunk as Buffer).length;if(length>MAX_BODY){respond(res,413,{ok:false});return;}chunks.push(chunk as Buffer);}
      let payload:unknown;
      try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{respond(res,400,{ok:false});return;}
      const result=await app.handle(payload);
      // Live delivery is explicitly opt-in via a separate injected dispatcher.
      // Ambiguous outcomes remain blocked in the durable outbox: never retry
      // automatically, even if Telegram repeats the inbound webhook request.
      if(outbound&&result.plan&&result.deliveryKey)await outbound.dispatch(result.deliveryKey);
      // Keep the reply body minimal: no user text, provider errors or Bot API secret.
      respond(res,result.status==='DENIED'&&result.reason==='INVALID_UPDATE_ID'?422:200,{ok:true,status:result.status});
    })().catch(()=>{if(!res.headersSent)respond(res,503,{ok:false});else res.end();});
  };
}
