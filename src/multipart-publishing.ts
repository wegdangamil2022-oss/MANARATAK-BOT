import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PublicationRenderPart, PublicationRenderPlan } from './publication-preview-plan.js';

/** This is an isolated, mock-only per-part ledger; it is NOT the production campaign ledger. */
export type PartStatus = 'QUEUED'|'SENDING'|'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED';
export type MultipartStatus = 'STAGED'|'IN_PROGRESS'|'COMPLETED'|'CANCELLED';
export interface MultipartPart {
  index:number; payload:PublicationRenderPart; status:PartStatus;
  attemptId?:string; messageId?:string;
}
export interface MultipartDelivery {
  campaignId:string; deliveryId:string; sourceResourceId:string; sourceRevision:string;
  destination:string; approvedBy:string; approvedFingerprint:string;
  status:MultipartStatus; parts:MultipartPart[];
}
export interface MultipartAuthorizedDraft {
  campaignId:string; deliveryId:string; sourceResourceId:string; sourceRevision:string;
  destination:string; approvedBy:string;
  /** Must come from a trusted, already-approved B4 campaign snapshot, not the Telegram request. */
  approved:boolean; approvedFingerprint?:string; renderPlan:PublicationRenderPlan;
}
export type MultipartOutcome = {status:'SENT';messageId:string} | {status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
export interface MultipartReceipt {attemptId:string;destination:string;messageId:string}
export interface MultipartGateway {
  canPost(destination:string):Promise<boolean>;
  sendPart(request:{destination:string;index:number;attemptId:string;part:PublicationRenderPart}):Promise<MultipartOutcome>;
  verifyReceipt(receipt:MultipartReceipt):Promise<boolean>;
}
export type MultipartPermission = (campaign:Readonly<MultipartDelivery>)=>Promise<boolean>;
export type MultipartDispatchResult = {status:PartStatus|'BLOCKED'|'EMPTY'|'CANCELLED';index?:number;messageId?:string};
type Data = {version:1;deliveries:MultipartDelivery[]};
const lockMap = new Map<string,Promise<void>>();
const blank = ():Data=>({version:1,deliveries:[]});
const clone = <T>(x:T):T=>structuredClone(x);
const isId = (v:unknown):v is string => typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v);
const fingerprint = (plan:PublicationRenderPlan) => createHash('sha256').update(JSON.stringify({kind:plan.kind,parts:plan.parts,...(plan.linkPreview?{linkPreview:plan.linkPreview}:{})})).digest('hex');

/** Local JSON serialization for tests; NOT safe across Node processes, servers or deployment replicas. */
export class MultipartTestStore {
  constructor(readonly path:string){}
  private async read():Promise<Data>{
    try {const s:unknown=JSON.parse(await readFile(this.path,'utf8'));
      if(!s||typeof s!=='object'||!('version'in s)||s.version!==1||!('deliveries'in s)||!Array.isArray(s.deliveries))throw new Error('INVALID_LEDGER');
      return s as Data;
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return blank();throw e;}
  }
  async snapshot():Promise<Data>{return clone(await this.read());}
  async transaction<T>(fn:(state:Data)=>T|Promise<T>):Promise<T>{
    const previous=lockMap.get(this.path)??Promise.resolve();
    let release!:()=>void;const current=new Promise<void>(r=>release=r);
    lockMap.set(this.path,current);
    await previous;
    try{
      const s=await this.read();
      const result=await fn(s);
      await mkdir(dirname(this.path),{recursive:true});
      const temp=`${this.path}.${randomUUID()}.tmp`;
      try{await writeFile(temp,JSON.stringify(s),'utf8');await rename(temp,this.path);}catch(e){try{const fs=await import('node:fs/promises');await fs.unlink(temp);}catch{/* already moved */}throw e;}
      return result;
    }finally{release();if(lockMap.get(this.path)===current)lockMap.delete(this.path);}
  }
}

export class MultipartPublicationService {
  constructor(private readonly store:MultipartTestStore,private readonly gateway:MultipartGateway,
              private readonly authorized:MultipartPermission,private readonly clock:()=>number=Date.now){}
  private async permit(d:MultipartDelivery):Promise<boolean>{try{return (await this.authorized(clone(d)))===true;}catch{return false;}}
  private valid(input:MultipartAuthorizedDraft):void{
    if(!input.approved)throw new Error('NOT_APPROVED');
    if(![input.campaignId,input.deliveryId,input.sourceResourceId,input.sourceRevision,input.destination,input.approvedBy].every(isId))throw new Error('INVALID_IDENTIFIERS');
    const p=input.renderPlan;
    if(!p||!Array.isArray(p.parts)||p.parts.length===0||p.parts.length>10||!['TEXT','PHOTO'].includes(p.kind)||
      typeof p.fingerprint!=='string'||p.fingerprint!==fingerprint(p)||
      (input.approvedFingerprint!==undefined&&input.approvedFingerprint!==p.fingerprint))throw new Error('PREVIEW_MISMATCH');
    if(p.kind==='PHOTO'&&(p.parts.length!==1||p.parts[0]?.kind!=='PHOTO'||p.linkPreview))throw new Error('PREVIEW_MISMATCH');
    if(p.kind==='TEXT'&&p.parts.some(x=>x?.kind!=='TEXT'))throw new Error('PREVIEW_MISMATCH');
    // The fingerprint proves consistency, not authority. The external approved-campaign
    // callback must establish the source of truth for this exact render plan.
    for(const part of p.parts){
      if(!part||typeof part.text!=='string'||part.text.length===0||part.text.length>(part.kind==='PHOTO'?1024:4096)||
        /[\u0000-\u0008\u000B-\u001F\u007F]/u.test(part.text))throw new Error('INVALID_PART');
      if(part.kind==='PHOTO'&&!/^[A-Za-z0-9_-]{8,128}$/u.test(part.mediaId))throw new Error('INVALID_PART');
    }
  }
  async stage(input:MultipartAuthorizedDraft):Promise<MultipartDelivery>{
    this.valid(input);
    const d:MultipartDelivery={campaignId:input.campaignId,deliveryId:input.deliveryId,
      sourceResourceId:input.sourceResourceId,sourceRevision:input.sourceRevision,
      destination:input.destination,approvedBy:input.approvedBy,approvedFingerprint:input.renderPlan.fingerprint,
      status:'STAGED',parts:input.renderPlan.parts.map((payload,index)=>({index,payload:clone(payload),status:'QUEUED'}))};
    if(!await this.permit(d))throw new Error('NOT_AUTHORIZED');
    return this.store.transaction(s=>{
      if(s.deliveries.some(x=>x.deliveryId===d.deliveryId))throw new Error('DELIVERY_ID_CONFLICT');
      if(s.deliveries.some(x=>x.sourceResourceId===d.sourceResourceId&&x.sourceRevision===d.sourceRevision&&x.destination===d.destination))throw new Error('RESERVED');
      s.deliveries.push(d);return clone(d);
    });
  }
  async inspect(id:string):Promise<MultipartDelivery>{
    const d=(await this.store.snapshot()).deliveries.find(x=>x.deliveryId===id);
    if(!d)throw new Error('NOT_FOUND');return clone(d);
  }
  async recoverPending():Promise<number>{
    return this.store.transaction(s=>{
      let n=0;
      for(const d of s.deliveries)for(const p of d.parts){if(p.status==='SENDING'){p.status='UNKNOWN_OUTCOME';n++;}}
      return n;
    });
  }
  async dispatchNext(id:string):Promise<MultipartDispatchResult>{
    const claim=await this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.deliveryId===id);if(!d)throw new Error('NOT_FOUND');
      if(d.status==='CANCELLED')return {kind:'CANCELLED' as const};
      if(d.status==='COMPLETED')return {kind:'EMPTY' as const};
      const next=d.parts.find(p=>!['SENT','CANCELLED'].includes(p.status));
      if(!next)return {kind:'EMPTY' as const};
      if(next.status!=='QUEUED')return {kind:'BLOCKED' as const};
      next.status='SENDING';next.attemptId=randomUUID();d.status='IN_PROGRESS';
      return {kind:'SEND' as const, part:clone(next),destination:d.destination, snapshot:clone(d)};
    });
    if(claim.kind!=='SEND')return {status:claim.kind};
    let eligible=false;
    try{eligible=(await this.gateway.canPost(claim.destination))===true&&await this.permit(claim.snapshot);}catch{/* deny */}
    if(!eligible){
      await this.store.transaction(s=>{const d=s.deliveries.find(x=>x.deliveryId===id);
        const p=d?.parts[claim.part.index];if(p?.attemptId===claim.part.attemptId&&p?.status==='SENDING')p.status='QUEUED';
      });
      return {status:'BLOCKED'};
    }
    // Gate again against the persisted state after async permission evaluation.
    const stillCurrent=await this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.deliveryId===id),p=d?.parts[claim.part.index];
      return d?.status==='IN_PROGRESS'&&p?.status==='SENDING'&&p?.attemptId===claim.part.attemptId;
    });
    if(!stillCurrent)return {status:'BLOCKED'};
    let outcome:MultipartOutcome;
    try{outcome=await this.gateway.sendPart({destination:claim.destination,index:claim.part.index,attemptId:claim.part.attemptId!,part:clone(claim.part.payload)});}
    catch{outcome={status:'UNKNOWN_OUTCOME'};}
    return this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.deliveryId===id)!;
      const p=d.parts[claim.part.index]!;
      if(p.attemptId!==claim.part.attemptId||p.status!=='SENDING')return {status:'BLOCKED' as const};
      if(outcome.status==='SENT'&&isId(outcome.messageId)&&!s.deliveries.some(x=>x.parts.some(y=>y!==p&&y.status==='SENT'&&x.destination===d.destination&&y.messageId===outcome.messageId))){
        p.status='SENT';p.messageId=outcome.messageId;
        if(d.parts.every(x=>x.status==='SENT'))d.status='COMPLETED';
        return {status:'SENT' as const,index:p.index,messageId:outcome.messageId};
      }
      p.status=outcome.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
      return {status:p.status,index:p.index};
    });
  }
  async retryFailed(id:string,index:number):Promise<void>{
    const pre=await this.inspect(id);
    if(!await this.permit(pre))throw new Error('NOT_AUTHORIZED');
    await this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.deliveryId===id)!;
      const p=d.parts[index];
      if(d.status==='CANCELLED'||p?.status!=='FAILED_CONFIRMED')throw new Error('NOT_CONFIRMED_FAILED');
      p.status='QUEUED';delete p.attemptId;delete p.messageId;
    });
  }
  async reconcileUnknown(id:string,index:number,receipt:MultipartReceipt):Promise<MultipartPart>{
    const pre=await this.inspect(id),part=pre.parts[index];
    if(!await this.permit(pre))throw new Error('NOT_AUTHORIZED');
    if(part?.status!=='UNKNOWN_OUTCOME'||part.attemptId!==receipt.attemptId||pre.destination!==receipt.destination||!isId(receipt.messageId))throw new Error('INVALID_RECEIPT');
    if(!await this.gateway.verifyReceipt(receipt))throw new Error('INVALID_RECEIPT');
    // Do not trust authorization cached before the asynchronous provider check.
    if(!await this.permit(await this.inspect(id)))throw new Error('NOT_AUTHORIZED');
    return this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.deliveryId===id)!;
      const p=d.parts[index]!;
      if(p.status!=='UNKNOWN_OUTCOME'||p.attemptId!==receipt.attemptId)throw new Error('INVALID_RECEIPT');
      if(s.deliveries.some(x=>x.destination===receipt.destination&&x.parts.some(y=>y.messageId===receipt.messageId&&y.status==='SENT')))
        throw new Error('DUPLICATE_RECEIPT');
      p.status='SENT';p.messageId=receipt.messageId;
      if(d.status!=='CANCELLED'&&d.parts.every(x=>x.status==='SENT'))d.status='COMPLETED';
      return clone(p);
    });
  }
  async cancel(id:string):Promise<void>{
    if(!await this.permit(await this.inspect(id)))throw new Error('NOT_AUTHORIZED');
    await this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.deliveryId===id);if(!d)throw new Error('NOT_FOUND');
      if(d.status==='COMPLETED')throw new Error('ALREADY_COMPLETED');
      d.status='CANCELLED';
      for(const p of d.parts){if(p.status==='QUEUED')p.status='CANCELLED';if(p.status==='SENDING')p.status='UNKNOWN_OUTCOME';}
    });
  }
}
