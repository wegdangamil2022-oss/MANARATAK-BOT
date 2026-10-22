import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { BotStore, type AuditRecord, type BotState } from './store.js';
import { Policy } from './policy.js';
import { EducationService } from './education.js';
import { EducationAdminFacade, type VerifiedAdminContext } from './education-admin.js';
import { ApprovedAnswerService, ResourceLinkService, type MembershipPort } from './education-interactions.js';
import type { ImportFormat } from './ingestion.js';
import type { SubscriptionGate } from './subscription.js';
import type {PlatformCatalogPreviewService} from './platform-catalog-preview.js';
import type {B6AnswerPreflight} from './b6-approved-answer-preflight.js';
import {subscriptionRequirementMode,acceptsActiveSubscriptionEvidence} from './subscription-integrity.js';
import type { TelegramReplyDispatcher } from './telegram-replies.js';
import {BoundedIngress,decodeStrictJsonBytes,type IngressOptions} from './http-ingress-guard.js';
import {menuLabels,mainMenuKeyboard,backMenuKeyboard,categoryButton,
 resourceButton,listingKeyboard,categoryButtonId,resourceButtonId,
 matchingCategories,menuPageButton,parseMenuPageCommand,type MenuPageCommand,
 type TelegramReplyKeyboard} from './telegram-menu.js';
import {OwnerTelegramMenu,isOwnerMenuText} from './telegram-owner-menu.js';
import {parseSearchQuery,parseSearchPageCommand,searchPageButton} from './telegram-search.js';
import {parsePrivateFAQQuery,privateFAQBrowseLabel,parsePrivateFAQPage,
 privateFAQPageLabel,parsePrivateFAQSelection,privateFAQButton,
 isPrivateFAQBrowseText} from './telegram-private-faq.js';
import {privateFAQSearchLabel,parsePrivateFAQSearchQuery,parsePrivateFAQSearchPage,
 privateFAQSearchPageLabel,isPrivateFAQSearchText} from './telegram-private-faq-search.js';
import {escapeTelegramListPreview} from './telegram-preview.js';
import {parseB6ExplicitMention} from './b6-telegram-mention.js';
import {parseB6OwnerReplyTarget} from './b6-telegram-owner-reply.js';

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
export interface TelegramReplyPlan { chatId: string; parseMode: 'HTML'; text: string;
 replyMarkup?:TelegramReplyKeyboard; }
export interface TelegramResult { status: 'APPLIED' | 'DUPLICATE' | 'DENIED' | 'IGNORED' | 'UNKNOWN'; reason: string; plan?: TelegramReplyPlan; deliveryKey?: string; }
export interface TelegramApplicationOptions {
  store: BotStore; policy: Policy; education: EducationService; admin: EducationAdminFacade;
  faq: ApprovedAnswerService; links: ResourceLinkService; membership: MembershipPort;
  botId: string; botUsername: string; subscription?: SubscriptionGate; clock?: () => number; documentDownload?: TelegramDocumentPort;
  /** Optional B5 read-only owner preview; absent in usual offline deployment. */
  platformCatalog?:PlatformCatalogPreviewService;
  /** B6 offline approved-knowledge-only planner; no AI configured by default. */
  answerPreflight?:B6AnswerPreflight;
}

type Event = {updateId: number; actorId: string; chatId: string; kind: 'private' | 'group'; text: string; entities?:unknown; messageId?:number; replyTo?:unknown; document?: IncomingDocument};
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
  return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),chatId:String(msg.chat.id),kind,text:msg.text,
   ...(msg.entities!==undefined?{entities:msg.entities}:{}),
   ...(msg.message_id!==undefined?{messageId:msg.message_id as number}:{}),
   ...(msg.reply_to_message!==undefined?{replyTo:msg.reply_to_message}:{})},reason:'VALID'};
}

/** Immutable local authorization witness for a B6 group question. Membership
 * checks may finish before a slow approved-FAQ lookup. Compare the exact
 * group + subscription + required-channel state again after that lookup,
 * including when the first state had no required-channel rule.
 */
function groupQuestionSubscriptionEpoch(s:BotState,groupId:string):string {
 const rules=s.subscriptionRequirements.filter(r=>r?.chatId===groupId);
 const ids=new Set<string>([groupId]);
 for(const rule of rules)
  if(Array.isArray(rule?.channelIds))
   for(const id of rule.channelIds)
    if(typeof id==='string')ids.add(id);
 const approvals=[...ids].sort().map(id=>
  [id,s.chats.filter(c=>c?.id===id).map(c=>
   [c.approved,c.present,c.version,c.scopes,c.groupAI])]);
 return JSON.stringify([subscriptionRequirementMode(s,groupId),rules,approvals]);
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
  /** End-of-planning fence, after the FAQ await but before creating a reply.
   * A changed local policy epoch invalidates prior Telegram membership proof.
   * When channels are required, fresh membership evidence must be obtained.
   * This is not an outbound-dispatch-time or remote-API transaction.
   */
  private async finalGroupAnswerGate(groupId:string,actorId:string,
   initialEpoch:string|undefined):Promise<string|null>{
   if(initialEpoch===undefined)return 'SUBSCRIPTION_UNAVAILABLE';
   let before:BotState;
   try{before=await this.opts.store.snapshot();}catch{return 'SUBSCRIPTION_UNAVAILABLE';}
   if(!this.opts.policy.canUseChat(before,groupId,'navigation')||
     groupQuestionSubscriptionEpoch(before,groupId)!==initialEpoch)
    return 'SUBSCRIPTION_UNAVAILABLE';
   const mode=subscriptionRequirementMode(before,groupId);
   if(mode==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
   if(mode==='ACTIVE'){
    if(!this.opts.subscription)return 'SUBSCRIPTION_UNAVAILABLE';
    let status:Awaited<ReturnType<SubscriptionGate['verify']>>['status'];
    try{status=(await this.opts.subscription.verify(groupId,actorId)).status;}
    catch{return 'SUBSCRIPTION_UNAVAILABLE';}
    if(!acceptsActiveSubscriptionEvidence(status,this.opts.policy.isOwner(actorId)))
     return status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE';
   }
   let latest:BotState;
   try{latest=await this.opts.store.snapshot();}catch{return 'SUBSCRIPTION_UNAVAILABLE';}
   if(!this.opts.policy.canUseChat(latest,groupId,'navigation')||
     groupQuestionSubscriptionEpoch(latest,groupId)!==initialEpoch)
    return 'SUBSCRIPTION_UNAVAILABLE';
   return null;
  }
  private plan(chatId:string,text:string,replyMarkup?:TelegramReplyKeyboard):TelegramReplyPlan {
    if(Buffer.byteLength(text,'utf8')>4096)throw Error('REPLY_TOO_LONG');
    return replyMarkup?{chatId,parseMode:'HTML',text,replyMarkup}:{chatId,parseMode:'HTML',text};
  }
  // A private chat is not proof of membership in an approved group. Group-scoped
  // libraries require a fresh trusted membership check even when opened in DM.
  private async authorizePrivateGroupBrowse(scope:string,actorId:string):Promise<string|null> {
    if(scope==='private')return null;
    const before=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(before,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    if(subscriptionRequirementMode(before,scope)==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
    // An external membership check is evidence only for the exact group and
    // subscription-rule epochs at which it started. Revoking/reapproving the
    // group, or introducing a required channel mid-check, invalidates it.
    const epoch=(state:Awaited<ReturnType<BotStore['snapshot']>>):string=>{
      const group=state.chats.find(c=>c.id===scope);
      const rules=state.subscriptionRequirements.filter(r=>r.chatId===scope)
       .map(r=>[r.version,r.mode,...r.channelIds]);
      return JSON.stringify([group?.version,group?.approved,group?.scopes,rules]);
    };
    const originalEpoch=epoch(before);
    let member:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
    try {member=await this.opts.membership(scope,actorId);}catch{return 'MEMBERSHIP_UNAVAILABLE';}
    const during=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(during,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    if(epoch(during)!==originalEpoch)return 'MEMBERSHIP_UNAVAILABLE';
    const requirement=subscriptionRequirementMode(during,scope);
    if(requirement==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
    if(member!=='VERIFIED')return member==='NOT_MEMBER'?'GROUP_MEMBERSHIP_REQUIRED':'MEMBERSHIP_UNAVAILABLE';
    if(requirement==='ACTIVE') {
      if(!this.opts.subscription)return 'SUBSCRIPTION_UNAVAILABLE';
      const check=await this.opts.subscription.verify(scope,actorId);
      if(!acceptsActiveSubscriptionEvidence(check.status,this.opts.policy.isOwner(actorId)))
        return check.status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE';
    }
    const after=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(after,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    if(epoch(after)!==originalEpoch)return 'MEMBERSHIP_UNAVAILABLE';
    if(subscriptionRequirementMode(after,scope)==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
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
    // Telegram's verified MessageEntity is mandatory for a free-text mention.
    // The slash command remains a separate explicit opt-in route.
    const mention=kind==='group'
     ?parseB6ExplicitMention(text,event.entities,this.opts.botUsername)
     :{status:'NO_MATCH'} as const;
    if(mention.status==='INVALID')return {status:'DENIED',reason:'INVALID_MENTION_ENTITIES'};
    const commandPrefix=`/ask@${this.opts.botUsername} `;
    const groupQuestion=kind==='group'
     ?(mention.status==='MATCH'?mention.question:
       text.startsWith(commandPrefix)?text.slice(commandPrefix.length):null)
     :null;
    let groupAnswerSubscriptionEpoch:string|undefined;
    if(kind==='group'&&(cmd==='/categories'||cmd==='/resources'||
      cmd===`/ask@${this.opts.botUsername}`||groupQuestion!==null)) {
      const snapshot=await this.opts.store.snapshot();
      if(groupQuestion!==null)
       groupAnswerSubscriptionEpoch=groupQuestionSubscriptionEpoch(snapshot,chatId);
      const requirement=subscriptionRequirementMode(snapshot,chatId);
      if(requirement==='INVALID')
        return {status:'DENIED',reason:'SUBSCRIPTION_UNAVAILABLE'};
      if(requirement==='ACTIVE') {
        if(!this.opts.subscription)return {status:'DENIED',reason:'SUBSCRIPTION_UNAVAILABLE'};
        const verified=await this.opts.subscription.verify(chatId,actorId);
        if(!acceptsActiveSubscriptionEvidence(verified.status,this.opts.policy.isOwner(actorId)))
          return {status:'DENIED',reason:verified.status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE'};
        // Do not let mid-flight changes (including pause/recreate, policy scope
        // edits or duplicate rules) turn the old proof into access.
        const current=await this.opts.store.snapshot();
        const revision=(state:Awaited<ReturnType<BotStore['snapshot']>>)=>
          JSON.stringify([state.chats.find(c=>c.id===chatId)?.version,
            state.subscriptionRequirements.filter(r=>r?.chatId===chatId)]);
        if(!this.opts.policy.canUseChat(current,chatId,'navigation') ||
          subscriptionRequirementMode(current,chatId)!=='ACTIVE' ||
          revision(current)!==revision(snapshot))
          return {status:'DENIED',reason:'SUBSCRIPTION_UNAVAILABLE'};
      }
    }
    const result=(message:string,replyMarkup?:TelegramReplyKeyboard):TelegramResult=>({
      status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,message,replyMarkup)});
    // The real Telegram reply keyboard uses verified ordinary message texts,
    // not callback claims. Every selection is re-authorized on every tap.
    if(kind==='private'){
      const m=menuLabels;
      const owner=this.opts.policy.isOwner(actorId);
      const main=()=>result('<b>أهلًا بك في بوت منارتك 🎓</b>\n'
        +'اختر أحد الأقسام من الأزرار أسفل المحادثة. تظهر الموارد المعتمدة فقط.\n'
        +'يمكنك أيضًا استخدام /categories private و /help.\n'
        +'المساعد الذكي وبعض الخدمات ما زالت قيد التطوير.',
        mainMenuKeyboard(owner));
      if(cmd==='/start'||cmd==='/help'||text===m.home||text===m.back)return main();
      if(isOwnerMenuText(text)){
        if(!owner)return {status:'DENIED',reason:'OWNER_ONLY'};
        const screen=await new OwnerTelegramMenu(
          this.opts.store,this.opts.policy,this.opts.education,this.opts.admin,
          this.opts.platformCatalog,this.clock
        ).handle(text,adminCtx);
        if(!screen)return {status:'DENIED',reason:'OWNER_MENU_UNAVAILABLE'};
        return result(screen.text,screen.keyboard);
      }
      // Explicit /ask is separate from /faq. This opt-in B6 preview relies
      // solely on current approved B3 FAQ text; no generation or source mixing.
      if(this.opts.answerPreflight&&(text==='/ask'||text.startsWith('/ask '))){
       const plan=await this.opts.answerPreflight.prepare({
        actor:actorId,scope:'private',question:text.slice(5),optedIn:true
       });
       if(plan.status==='NO_APPROVED_SOURCE')return result(
        '<b>المساعد التعليمي</b>\n'
        +'لم نعثر على إجابة معتمدة لهذا السؤال. لا يوجد توليد AI تلقائي.\n'
        +'يمكنك تجربة /faq أو تصفح المكتبة المنشورة.',
        backMenuKeyboard());
       if(plan.status==='AMBIGUOUS')return result(
        '<b>المساعد التعليمي</b>\n'
        +'هناك إجابات معتمدة متعارضة؛ يلزم توضيح أو مراجعة المالك.',
        backMenuKeyboard());
       if(plan.status!=='APPROVED_ANSWER')
        return {status:'DENIED',reason:'B6_'+plan.status};
       return result('<b>إجابة من مصادر منارتك المعتمدة ✅</b>\n'
        +escapeTelegramHtml(plan.answer)+'\n'
        +'هذه إجابة محفوظة وليست مولدة بالذكاء الاصطناعي.',
        backMenuKeyboard());
      }
      if(text==='/faq')return result(
       '<b>الأسئلة الشائعة المعتمدة ❓</b>\n'
       +'للحصول على إجابة من مورد تعليمي منشور ومعتمد، اكتب: '
       +'<code>/faq ما شروط المنحة؟</code>\n'
       +'هذه إجابات محفوظة يراجعها المالك؛ لا يوجد ذكاء اصطناعي توليدي.',
       backMenuKeyboard());
      if(isPrivateFAQSearchText(text)){
       if(text===privateFAQSearchLabel)return result(
        '<b>البحث في الأسئلة المعتمدة 🔎</b>\n'
        +'اكتب <code>/faqsearch منحة</code> للبحث داخل عناوين الأسئلة وصيغها البديلة المعتمدة.\n'
        +'النتائج تأتي من موارد الخاص المنشورة فقط، ولا تستخدم AI خارجيًا.',
        listingKeyboard([privateFAQBrowseLabel]));
       const command=parsePrivateFAQSearchQuery(text);
       const paging=parsePrivateFAQSearchPage(text);
       if(!command&&!paging)return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_SEARCH'};
       const query=command??paging!.query;
       // The trusted service matches reviewed titles and approved aliases
       // on a single freshly authorized source snapshot. It exposes only
       // question titles and GLOBAL ordinals, never alias/admin metadata.
       const catalogue=await this.opts.faq.searchPrivateReviewedFAQs(actorId,query);
       if(catalogue.status==='DISABLED')
        return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
       const hits=catalogue.items.map(({id,question,ordinal})=>({
        q:{id,question},ordinal
       }));
       const page=paging?.page??0,pages=Math.ceil(hits.length/10);
       if(paging&&(!pages||page>=pages||
         (paging.direction==='next'&&page===0)||
         (paging.direction==='previous'&&page===pages-1)))
        return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_SEARCH_PAGE'};
       if(!hits.length)return result(
        '<b>البحث في الأسئلة المعتمدة 🔎</b>\n'
        +'لا توجد أسئلة معتمدة مطابقة لهذه الكلمات ضمن مكتبة الخاص الحالية.\n'
        +'يمكنك تغيير الكلمات أو تصفح القائمة المعتمدة.',
        listingKeyboard([privateFAQBrowseLabel]));
       const shown=hits.slice(page*10,page*10+10);
       return result('<b>نتائج البحث في الأسئلة 🔎</b>\n'
        +'المطابقات: '+hits.length+'\nصفحة '+(page+1)+' من '+pages+'\n'
        +shown.map(({q,ordinal})=>ordinal+'. '+
          escapeTelegramListPreview(q.question,220)).join('\n')
        +'\nاختر رقم السؤال المطابق لفتح إجابته المعتمدة.',
        listingKeyboard(shown.map(({q,ordinal})=>privateFAQButton(q.id,ordinal)),{
         previous:page>0?privateFAQSearchPageLabel(query,page-1,'previous'):undefined,
         next:page+1<pages?privateFAQSearchPageLabel(query,page+1,'next'):undefined
        }));
      }
      if(text.startsWith('/faq')){
       const question=parsePrivateFAQQuery(text);
       if(!question)return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_QUERY'};
       const answer=await this.opts.faq.answerPrivateApprovedFAQ(actorId,question);
       if(answer.status==='DISABLED')return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
       if(answer.status==='NO_MATCH')return result(
        '<b>الأسئلة الشائعة ❓</b>\n'
        +'لم نعثر على إجابة معتمدة لهذا السؤال ضمن موارد الخاص المنشورة.\n'
        +'جرّب صياغة أخرى أو تصفح مكتبة المنح.',
        backMenuKeyboard());
       if(answer.status==='AMBIGUOUS')return result(
        '<b>الأسئلة الشائعة ❓</b>\n'
        +'توجد أكثر من إجابة معتمدة متشابهة لهذا السؤال؛ يلزم مراجعة الإدارة.\n'
        +'لم نختر إجابة عشوائية.',
        backMenuKeyboard());
       if(answer.status!=='ANSWER')
        return {status:'DENIED',reason:'PRIVATE_FAQ_UNAVAILABLE'};
       return result('<b>إجابة من موارد منارتك المعتمدة ✅</b>\n'
        +escapeTelegramHtml(answer.answer)+'\n'
        +'هذه إجابة من سؤال شائع معتمد وليست محتوى مولّدًا بالذكاء الاصطناعي.',
        backMenuKeyboard());
      }
      if(isPrivateFAQBrowseText(text)){
       // Every page and choice is independently authorized from the current
       // library snapshot. Opaque button hashes are not grants and can only
       // resolve to exactly one currently visible reviewed private FAQ.
       const catalogue=await this.opts.faq.listPrivateReviewedFAQs(actorId);
       if(catalogue.status==='DISABLED')
        return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
       const items=catalogue.items;
       const requested=parsePrivateFAQPage(text);
       if(text===privateFAQBrowseLabel||requested){
        const page=requested?.page??0;
        const pages=Math.min(1000,Math.ceil(items.length/10));
        if(requested&&(!pages||page>=pages||
          (requested.direction==='next'&&page===0)||
          (requested.direction==='previous'&&page===pages-1)))
         return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_PAGE'};
        if(!pages)return result('<b>تصفح الأسئلة المعتمدة 📖</b>\n'
         +'لا توجد أسئلة معتمدة من موارد الخاص المنشورة حاليًا.\n'
         +'يمكنك البحث في المكتبة أو إرسال سؤال محدد عبر /faq.',
         backMenuKeyboard());
        const visible=items.slice(page*10,page*10+10);
        return result('<b>تصفح الأسئلة المعتمدة 📖</b>\n'
          +'عدد الأسئلة المتاحة: '+items.length+'\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +visible.map((q,i)=>(page*10+i+1)+'. '+escapeTelegramListPreview(q.question,220)).join('\n')
          +'\nاختر رقم السؤال المطابق من الأزرار لعرض الإجابة المعتمدة.',
          listingKeyboard(visible.map((q,i)=>privateFAQButton(q.id,page*10+i+1)),{
           previous:page>0?privateFAQPageLabel(page-1,'previous'):undefined,
           next:page+1<pages?privateFAQPageLabel(page+1,'next'):undefined
          }));
       }
       const token=parsePrivateFAQSelection(text);
       if(!token)return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_SELECTION'};
       const matches=items.filter((q,i)=>privateFAQButton(q.id,i+1)===text);
       if(matches.length!==1)return {status:'DENIED',reason:'PRIVATE_FAQ_NOT_ACCESSIBLE'};
       const answer=await this.opts.faq.answerPrivateReviewedFAQById(actorId,matches[0]!.id);
       if(answer.status!=='ANSWER')return {status:'DENIED',reason:'PRIVATE_FAQ_NOT_ACCESSIBLE'};
       return result('<b>إجابة معتمدة من مكتبة منارتك ✅</b>\n'
         +escapeTelegramHtml(answer.answer)+'\n'
         +'مصدرها منشور ومعتمد في مكتبة الخاص، وليس إجابة AI مولدة.',
         listingKeyboard([privateFAQBrowseLabel]));
      }
      const sections:Readonly<Record<string,{section:string;title:string}>>={
        [m.scholarships]:{section:'scholarships',title:'المنح الدراسية'},
        [m.courses]:{section:'courses',title:'الدورات التعليمية'},
        [m.universities]:{section:'universities',title:'الجامعات والتخصصات'},
        [m.exams]:{section:'exams',title:'الاختبارات'},
        [m.files]:{section:'files',title:'ملفات ونماذج'},
        [m.library]:{section:'all',title:'التعليم والموارد'}
      };
      const denyPage=():TelegramResult=>({status:'DENIED',reason:'INVALID_MENU_PAGE'});
      const sectionPage=async(section:string,title:string,page:number,
        direction?:MenuPageCommand['direction']):Promise<TelegramResult>=>{
        const categories=matchingCategories(
          await this.opts.education.listCategories(actorId,'private'),section);
        if(categories.length===0&&page===0&&!direction)return result(
          '<b>'+escapeTelegramHtml(title)+'</b>\n'
          +'لا توجد أقسام معتمدة متاحة في هذا القسم حاليًا.\n'
          +'لن نعرض فرصًا أو خدمات غير منشورة.',backMenuKeyboard());
        const pages=Math.ceil(categories.length/10);
        if(page<0||page>=pages||
          (direction==='next'&&page===0)||
          (direction==='previous'&&page>=pages-1))return denyPage();
        const view=categories.slice(page*10,page*10+10);
        return result('<b>'+escapeTelegramHtml(title)+'</b>\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +'اختر القسم المناسب:\n'+view.map(c=>'• '+escapeTelegramListPreview(c.title,220)).join('\n'),
          listingKeyboard(view.map(categoryButton),{
            previous:page>0?menuPageButton('c',section,page-1,'previous'):undefined,
            next:page+1<pages?menuPageButton('c',section,page+1,'next'):undefined
          }));
      };
      const resourcesPage=async(catId:string,page:number,
        direction?:MenuPageCommand['direction']):Promise<TelegramResult>=>{
        const visible=await this.opts.education.listCategories(actorId,'private');
        const cat=visible.find(x=>x.id===catId);
        if(!cat)return {status:'DENIED',reason:'CATEGORY_NOT_ACCESSIBLE'};
        const resources=await this.opts.education.listResources(actorId,'private',catId);
        if(resources.length===0&&page===0&&!direction)return result(
          '<b>'+escapeTelegramHtml(cat.title)+'</b>\n'
          +'لا توجد موارد معتمدة منشورة في هذا القسم حاليًا.',backMenuKeyboard());
        const pages=Math.ceil(resources.length/10);
        if(page<0||page>=pages||
          (direction==='next'&&page===0)||
          (direction==='previous'&&page>=pages-1))return denyPage();
        const view=resources.slice(page*10,page*10+10);
        return result('<b>'+escapeTelegramHtml(cat.title)+'</b>\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +view.map(r=>'• '+escapeTelegramListPreview(r.title,220)).join('\n'),
          listingKeyboard(view.map(resourceButton),{
            previous:page>0?menuPageButton('r',cat.id,page-1,'previous'):undefined,
            next:page+1<pages?menuPageButton('r',cat.id,page+1,'next'):undefined
          }));
      };
      if(Object.prototype.hasOwnProperty.call(sections,text)){
        const selection=sections[text]!;
        return sectionPage(selection.section,selection.title,0);
      }
      const searchPage=async(query:string,page:number,
        direction?:'next'|'previous'):Promise<TelegramResult>=>{
        // Keep the normal private navigation feature switch independent of AI
        // and owner controls, and re-evaluate it on every untrusted page tap.
        const state=await this.opts.store.snapshot();
        if(!this.opts.policy.privateFeature(state,'education.navigate',actorId))
          return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
        const matches=await this.opts.education.searchPublishedResources(actorId,query);
        if(matches.length===0&&page===0&&!direction)
          return result('<b>نتائج البحث 🔍</b>\n'
            +'لم نعثر على موارد منشورة ومعتمدة تطابق هذا البحث.\n'
            +'جرّب كلمات مختلفة أو تصفح أقسام المكتبة.',backMenuKeyboard());
        const pages=Math.ceil(matches.length/10);
        if(page<0||page>=pages||(direction==='next'&&page===0)||
          (direction==='previous'&&page>=pages-1))return denyPage();
        const selection=matches.slice(page*10,page*10+10);
        return result('<b>نتائج البحث 🔍</b>\n'
          +'البحث: '+escapeTelegramHtml(query)+'\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +selection.map(r=>'• '+escapeTelegramListPreview(r.title,220)).join('\n'),
          listingKeyboard(selection.map(resourceButton),{
            previous:page>0?searchPageButton(query,page-1,'previous'):undefined,
            next:page+1<pages?searchPageButton(query,page+1,'next'):undefined
          }));
      };
      if(text===m.search)return result('<b>البحث في الموارد 🔍</b>\n'
        +'اكتب /search ثم كلمة البحث. مثال: <code>/search Grant</code>\n'
        +'يُعرض المحتوى المنشور والمعتمد فقط؛ لا تُعرض ملفات المراجعة.',
        backMenuKeyboard());
      if(text.startsWith('/search')){
        const term=parseSearchQuery(text);
        return term?searchPage(term,0):{status:'DENIED',reason:'INVALID_SEARCH_QUERY'};
      }
      const searchRequest=parseSearchPageCommand(text);
      if(searchRequest)return searchPage(
        searchRequest.query,searchRequest.page,searchRequest.direction);
      if(text.startsWith('➡️ التالي · s:')||text.startsWith('⬅️ السابق · s:'))
        return denyPage();
      const pageRequest=parseMenuPageCommand(text);
      if(pageRequest){
        if(pageRequest.kind==='c'){
          const chosen=Object.values(sections).find(x=>x.section===pageRequest.id);
          if(!chosen)return denyPage();
          return sectionPage(chosen.section,chosen.title,pageRequest.page,pageRequest.direction);
        }
        return resourcesPage(pageRequest.id,pageRequest.page,pageRequest.direction);
      }
      if(text.startsWith('➡️ التالي · ')||text.startsWith('⬅️ السابق · '))
        return denyPage();
      if(text===m.assistant)return result(
        '<b>المساعد التعليمي 💬</b>\n'
        +'يمكنك السؤال من قاعدة الأسئلة المعتمدة في الخاص عبر '
        +'<code>/faq ما شروط المنحة؟</code>\n'
        +'ضمن المجموعات المسموح بها: <code>/ask@'
        +escapeTelegramHtml(this.opts.botUsername)+' السؤال</code> حسب سياسة المجموعة.\n'
        +'المساعد الذكي التوليدي غير متصل؛ إجابات /faq مستندة إلى موارد منشورة.\n'
        +'اضغط «تصفح الأسئلة المعتمدة» أو «ابحث في الأسئلة» للعثور على إجابة منشورة.',
        listingKeyboard([privateFAQBrowseLabel,privateFAQSearchLabel]));
      if(text===m.communities)return result(
        '<b>المجموعات والقنوات 👥</b>\n'
        +'تُدار صلاحيات المجموعات والتحقق من العضوية ضمن أنظمة منارتك.\n'
        +'دليل عام وروابط انضمام موثقة للمجموعات لم تُنشر بعد.',
        backMenuKeyboard());
      if(text===m.help)return result(
        '<b>المساعدة والدعم 🆘</b>\n'
        +'للتصفح اختر أحد أقسام القائمة أو استخدم /categories private.\n'
        +'التواصل المباشر مع فريق الدعم ونظام التذاكر لم يُفعّلا بعد.',
        backMenuKeyboard());
      const categoryId=categoryButtonId(text);
      if(!categoryId&&text.startsWith('📁 '))
        return {status:'DENIED',reason:'INVALID_MENU_SELECTION'};
      if(categoryId){
        const visible=await this.opts.education.listCategories(actorId,'private');
        const cat=visible.find(x=>x.id===categoryId);
        if(!cat||categoryButton(cat)!==text)return {status:'DENIED',reason:'CATEGORY_NOT_ACCESSIBLE'};
        return resourcesPage(categoryId,0);
      }
      const resourceId=resourceButtonId(text);
      if(!resourceId&&text.startsWith('🔎 '))
        return {status:'DENIED',reason:'INVALID_MENU_SELECTION'};
      if(resourceId){
        const snapshot=await this.opts.store.snapshot();
        const candidate=snapshot.educationResources.find(x=>x.id===resourceId&&x.scope==='private');
        if(!candidate)return {status:'DENIED',reason:'RESOURCE_NOT_ACCESSIBLE'};
        const visible=await this.opts.education.listResources(actorId,'private',candidate.categoryId);
        const found=visible.find(x=>x.id===resourceId);
        if(!found||resourceButton(found)!==text)return {status:'DENIED',reason:'RESOURCE_NOT_ACCESSIBLE'};
        return result('<b>مورد تعليمي معتمد 📄</b>\n'
          +escapeTelegramHtml(found.title)+'\nالجامعة: '+escapeTelegramHtml(found.university)
          +'\nالدورة: '+escapeTelegramHtml(found.cycle)+'\nالدرجة: '
          +escapeTelegramHtml(found.degree),backMenuKeyboard());
      }
    }
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
      return result('<b>التعليم والموارد</b>\n'+categories.slice(0,12).map(c=>`• ${escapeTelegramListPreview(c.title,220)} (<code>${escapeTelegramHtml(c.id)}</code>)`).join('\n'));
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
      return result('<b>الموارد المنشورة</b>\n'+resources.slice(0,12).map(r=>`• ${escapeTelegramListPreview(r.title,180)}${r.university?` — ${escapeTelegramListPreview(r.university,80)}`:''}`).join('\n'));
    }
    if(cmd==='/resource'&&kind==='private'){
      if(words.length!==2)return {status:'DENIED',reason:'INVALID_RESOURCE_REF'};
      const subscription=this.opts.subscription;
      const opened=await this.opts.links.resolve(words[1]!,actorId,this.opts.membership,
        subscription?async (scope,user)=>(await subscription.verify(scope,user)).status:undefined);
      if(opened.status!=='FOUND')return {status:'DENIED',reason:'RESOURCE_DENIED'};
      return result(`<b>مورد تعليمي</b>\n${escapeTelegramHtml(opened.resource.title)}\n${escapeTelegramHtml(opened.resource.university)}`);
    }
    if(kind==='group'&&groupQuestion!==null){
      let question=groupQuestion;
      // Owner's explicit reply-to invocation is NOT an arbitrary AI prompt:
      // the sole question source is the direct reply_to_message in this update.
      // Never attempt to fetch earlier Telegram conversation history.
      if(question==='أجب عن هذا السؤال'){
       if(!this.opts.policy.isOwner(actorId))
        return {status:'DENIED',reason:'OWNER_ONLY'};
       const target=parseB6OwnerReplyTarget(event.replyTo,chatId,event.messageId,actorId);
       if(target.status==='MISSING_REPLY')
        return result('يرجى استخدام المنشن بالرد على رسالة السؤال نفسها، أو أعد إرفاق السؤال.');
       if(target.status!=='QUESTION')
        return {status:'DENIED',reason:'INVALID_REPLY_TARGET'};
       question=target.question;
      }
      if(this.opts.answerPreflight){
       const plan=await this.opts.answerPreflight.prepare({
        actor:actorId,scope:chatId,question,explicitMention:true
       });
       if(plan.status!=='APPROVED_ANSWER')
        return {status:'DENIED',reason:'B6_'+plan.status};
       const fence=await this.finalGroupAnswerGate(chatId,actorId,groupAnswerSubscriptionEpoch);
       if(fence)return {status:'DENIED',reason:fence};
       return result('<b>إجابة من موارد منارتك المعتمدة</b>\n'
        +escapeTelegramHtml(plan.answer)+'\n'
        +'جواب محفوظ ومعتمد، لا AI توليدي.');
      }
      const ans=await this.opts.faq.answerGroup(actorId,chatId,question,true);
      if(ans.status!=='ANSWER')return {status:'DENIED',reason:`FAQ_${ans.status}`};
      const fence=await this.finalGroupAnswerGate(chatId,actorId,groupAnswerSubscriptionEpoch);
      if(fence)return {status:'DENIED',reason:fence};
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
 outbound?:TelegramReplyDispatcher,ingressOptions:IngressOptions={},
 safetyGate?:()=>Promise<boolean>):RequestListener {
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(secretToken))throw Error('INVALID_WEBHOOK_SECRET');
  const guard=new BoundedIngress(ingressOptions);
  return (req,res)=>{
    void (async()=>{
      if(req.method!=='POST'){respond(res,405,{ok:false});return;}
      if(req.url!=='/telegram/webhook'){respond(res,404,{ok:false});return;}
      if(!secretValid(req,secretToken)){respond(res,401,{ok:false});return;}
      const release=guard.enter(req);
      if(!release){respond(res,503,{ok:false});return;}
      try{
      // No new durable update may be claimed while emergency STOP is active.
      // A missing/corrupt safety flag is also STOP. Never trust a request body
      // to supply or override this operator-controlled decision.
      if(safetyGate){
       let allowed=false;
       try{allowed=await safetyGate();}catch{/* fail closed */}
       if(!allowed){respond(res,503,{ok:false});return;}
      }
      if(req.headers['content-encoding']!==undefined){respond(res,415,{ok:false});return;}
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){respond(res,415,{ok:false});return;}
      const declared=req.headers['content-length'];
      if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY)){respond(res,413,{ok:false});return;}
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=(chunk as Buffer).length;if(length>MAX_BODY){respond(res,413,{ok:false});return;}chunks.push(chunk as Buffer);}
      let payload:unknown;
      try{payload=decodeStrictJsonBytes(chunks);}catch{respond(res,400,{ok:false});return;}
      const result=await app.handle(payload);
      // Live delivery is explicitly opt-in via a separate injected dispatcher.
      // Ambiguous outcomes remain blocked in the durable outbox: never retry
      // automatically, even if Telegram repeats the inbound webhook request.
      if(outbound&&result.plan&&result.deliveryKey)await outbound.dispatch(result.deliveryKey);
      // Keep the reply body minimal: no user text, provider errors or Bot API secret.
      respond(res,result.status==='DENIED'&&result.reason==='INVALID_UPDATE_ID'?422:200,{ok:true,status:result.status});
      }finally{release();}
    })().catch(()=>{if(!res.headersSent)respond(res,503,{ok:false});else res.end();});
  };
}
