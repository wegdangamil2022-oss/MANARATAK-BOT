import { BotStore, type EducationResource, type ImportRun } from './store.js';
import { Policy } from './policy.js';
import { EducationService } from './education.js';
import type { ImportFormat } from './ingestion.js';

/** An authenticated transport MUST supply this; never trust actor ID supplied by a Telegram user or HTTP body. */
export interface VerifiedAdminContext { origin:'TELEGRAM_PRIVATE'|'ADMIN_WEB'; actorId:string; chatId:string; verified:boolean; }
export interface AdminPanel { canUpload:boolean; canPublish:boolean; canReview:boolean; }

/** Safe application boundary, not a running Telegram bot / HTTP server. */
export class EducationAdminFacade {
  constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly education:EducationService,private readonly clock:()=>number=Date.now) {}
  private assertContext(ctx:VerifiedAdminContext):void {
    if(!ctx.verified || !/^\d+$/.test(ctx.actorId) || (ctx.origin!=='TELEGRAM_PRIVATE'&&ctx.origin!=='ADMIN_WEB') || (ctx.origin==='TELEGRAM_PRIVATE' && ctx.chatId!==ctx.actorId)) throw new Error('UNTRUSTED_ADMIN_CONTEXT');
  }
  async panel(ctx:VerifiedAdminContext,scope:string):Promise<AdminPanel> {
    this.assertContext(ctx);
    const s=await this.store.snapshot();const allowed=scope==='private'||this.policy.canUseChat(s,scope,'navigation');
    const canUpload=allowed && (scope==='private' ? this.policy.privateFeature(s,'content.upload',ctx.actorId)
      : this.policy.has(s,ctx.actorId,'content.upload',scope,this.clock()));
    const canPublish=allowed && this.policy.has(s,ctx.actorId,'content.publish',scope,this.clock());
    return {canUpload,canPublish,canReview:canPublish};
  }
  async upload(ctx:VerifiedAdminContext,scope:string,format:ImportFormat,filename:string,text:string):Promise<ImportRun> {
    this.assertContext(ctx);
    return this.education.submitText(ctx.actorId,scope,ctx.origin==='TELEGRAM_PRIVATE'?'TELEGRAM_ADMIN':'ADMIN_WEB',format,filename,text);
  }
  async approve(ctx:VerifiedAdminContext,importId:string,index:number,categoryId:string):Promise<void> {
    this.assertContext(ctx);
    return this.education.approveCandidate(ctx.actorId,importId,index,categoryId);
  }
  async publish(ctx:VerifiedAdminContext,importId:string,index:number,categoryId:string):Promise<EducationResource> {
    this.assertContext(ctx);
    return this.education.publishCandidate(ctx.actorId,importId,index,categoryId);
  }
}
