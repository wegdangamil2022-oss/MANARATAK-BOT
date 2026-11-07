import {randomBytes} from 'node:crypto';
import type {BotState,BotStore,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {validGroupNetwork} from './group-network-model.js';
import {isValidGroupProtectionRecord} from './protection-rules.js';
import {previewNetworkGroupCopy,applyNetworkGroupCopy,
 type NetworkCopyPart,type NetworkCopyPreview} from './network-group-copy.js';

/** Owner-reviewed NETWORK-007: copy a safe subset of existing group settings.
 * Only approved current network members may participate; no Telegram send. */
const PREFIX='network-group-copy:',TTL=120_000,SIZE=8;
const net='([a-f0-9]{12})',group='(-[1-9][0-9]{0,15})',
 page='(0|[1-9][0-9]{0,2})';
const sources=new RegExp('^nw:1:cl:'+net+':'+page+'$','u');
const targets=new RegExp('^nw:1:ct:'+net+':'+group+':'+page+'$','u');
const preview=new RegExp('^nw:1:cv:'+net+':'+group+':'+group+':([rfb])$','u');
const confirm=/^nw:1:cc:([A-Za-z0-9_-]{24})$/u;
const cancel=/^nw:1:cx:([A-Za-z0-9_-]{24})$/u;
const time=(now:number)=>Number.isSafeInteger(now)&&now>=0&&now<=8_640_000_000_000_000-TTL;
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const labels={r:'قواعد الحماية فقط',f:'حدود الفلود فقط',b:'القواعد والفلود'} as const;
interface Pending{
 netId:string;sourceId:string;targetId:string;parts:NetworkCopyPart;
 networkRevision:number;sourceRevision:number;targetRevision:number;proof:string;
}
function decode(raw:string):Pending|null{
 let v:unknown;try{v=JSON.parse(raw);}catch{return null;}
 if(!v||typeof v!=='object'||Array.isArray(v))return null;
 const a=v as Record<string,unknown>;
 if(Object.keys(a).sort().join(',')!=='netId,networkRevision,parts,proof,sourceId,sourceRevision,targetId,targetRevision'||
  typeof a.netId!=='string'||!/^[a-f0-9]{12}$/u.test(a.netId)||
  typeof a.sourceId!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(a.sourceId)||
  typeof a.targetId!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(a.targetId)||
  !Number.isSafeInteger(Number(a.sourceId))||!Number.isSafeInteger(Number(a.targetId))||
  a.sourceId===a.targetId||
  !['r','f','b'].includes(String(a.parts))||
  ![a.networkRevision,a.sourceRevision,a.targetRevision].every(x=>
   typeof x==='number'&&Number.isSafeInteger(x)&&x>0&&x<=9_999_999_999)||
  typeof a.proof!=='string'||!/^[a-f0-9]{64}$/u.test(a.proof))return null;
 return a as unknown as Pending;
}
export function validOwnerNetworkGroupCopyRoute(data:unknown):boolean{
 return typeof data==='string'&&Buffer.byteLength(data,'utf8')<=64&&
  [sources,targets,preview,confirm,cancel].some(re=>re.test(data));
}
export class OwnerNetworkGroupCopy{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private allowed(s:BotState,actor:string,now:number):boolean{
  return time(now)&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private network(s:BotState,id:string,now:number){
  const rows=(s.groupNetworks??[]).filter(n=>n.id===id),n=rows[0];
  return rows.length===1&&!!n&&validGroupNetwork(n)&&n.updatedAt<=now?n:null;
 }
 private eligible(s:BotState,actor:string,now:number,id:string):Chat[]|null{
  if(!this.allowed(s,actor,now))return null;
  const network=this.network(s,id,now);if(!network)return null;
  const groups:Chat[]=[];
  for(const entry of network.members){
   const chats=s.chats.filter(c=>c.id===entry.chatId),chat=chats[0];
   if(chats.length!==1||!chat||!chat.approved||chat.version!==entry.version||
      !chat.scopes.includes('moderation')||!this.policy.canUseChat(s,chat.id,'moderation')||
      !this.policy.has(s,actor,'chat.manage',chat.id,now))continue;
   const policies=(s.protectionPolicies??[]).filter(p=>p.policy.chatId===chat.id),p=policies[0];
   if(policies.length!==1||!p||!isValidGroupProtectionRecord(p)||
      p.chatPolicyVersion!==chat.version||p.updatedAt>now||
      p.policy.mode==='ENFORCE'||p.policy.revision>=2_000_000_000)continue;
   groups.push(chat);
  }
  return groups.sort((a,b)=>a.id.localeCompare(b.id));
 }
 private sourceList(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const network=this.network(s,id,now),groups=this.eligible(s,actor,now,id);
  if(!network||!groups)return null;
  const pages=Math.max(1,Math.ceil(groups.length/SIZE));if(p>=pages)return null;
  const rows=groups.slice(p*SIZE,(p+1)*SIZE)
   .map(c=>[btn('📤 مصدر '+c.id,'nw:1:ct:'+id+':'+c.id+':0')]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:cl:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:cl:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]);
  return ui('<b>🔄 نسخ إعدادات المراقبة بين المجموعات</b>\n'+
   'الشبكة: '+esc(network.name)+' · صفحة '+(p+1)+'/'+pages+'\n'+
   'اختر مجموعة المصدر. تتوفر فقط سياسات OFF وMONITOR المعتمدة محليًا.\n'+
   'لن تُنسخ استثناءات الأعضاء أو حقوق Telegram، ولن يُفعّل وضع ENFORCE.',rows);
 }
 private targetList(s:BotState,actor:string,now:number,id:string,
  source:string,p:number):OwnerInlineScreen|null{
  const network=this.network(s,id,now),members=this.eligible(s,actor,now,id);
  if(!network||!members||!members.some(c=>c.id===source))return null;
  const variants:NetworkCopyPart[]=['b','r','f'];
  const candidates=members.filter(c=>c.id!==source)
   .map(chat=>({chat,kinds:variants.filter(kind=>
    previewNetworkGroupCopy(s,this.policy,actor,now,id,source,chat.id,kind)!==null)}))
   .filter(x=>x.kinds.length>0);
  const pages=Math.max(1,Math.ceil(candidates.length/SIZE));
  if(p>=pages)return null;
  const rows=candidates.slice(p*SIZE,(p+1)*SIZE)
   .map(({chat,kinds})=>kinds.map(kind=>btn(
    (kind==='r'?'📑':kind==='f'?'🌊':'📦')+chat.id+' · '+labels[kind],
    'nw:1:cv:'+id+':'+source+':'+chat.id+':'+kind)));
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:ct:'+id+':'+source+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:ct:'+id+':'+source+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ اختيار المصدر','nw:1:cl:'+id+':0')]);
  return ui('<b>📥 اختر المجموعة المستهدفة</b>\n'+
   'الشبكة: '+esc(network.name)+' · المصدر: <code>'+source+'</code>\n'+
   'صفحة '+(p+1)+'/'+pages+'\n'+
   'يمكن نسخ إعدادات مختارة حتى لو كانت للوجهة سياسة قائمة. لن تُنسخ بيانات المجموعات الأخرى.',rows);
 }
 private async review(actor:string,netId:string,sourceId:string,targetId:string,
  parts:NetworkCopyPart):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),network=this.network(s,netId,now);
   const selected=previewNetworkGroupCopy(s,this.policy,actor,now,netId,sourceId,targetId,parts);
   if(!this.allowed(s,actor,now)||!network||!selected)return null;
   const token=randomBytes(18).toString('base64url');
   const ref='c_'+token;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&
    c.action.startsWith(PREFIX)&&c.used===false&&c.revoked===false&&c.expiresAt>now);
   if(s.callbacks.some(c=>c.ref===ref)||pending.length>=100)return null;
   // Choosing another field set invalidates the former confirmation receipt.
   for(const old of pending)old.revoked=true;
   const pending:Pending={netId,sourceId,targetId,parts,networkRevision:selected.networkRevision,
    sourceRevision:selected.sourceRevision,targetRevision:selected.targetRevision,proof:selected.proof};
   s.callbacks.push({ref,action:PREFIX+JSON.stringify(pending),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,
    used:false,revoked:false,expiresAt:now+TTL});
   const choices:{text:string;callback_data:string}[]=[
    btn('📑 قواعد فقط','nw:1:cv:'+netId+':'+sourceId+':'+targetId+':r'),
    btn('🌊 فلود فقط','nw:1:cv:'+netId+':'+sourceId+':'+targetId+':f'),
    btn('📦 كلاهما','nw:1:cv:'+netId+':'+sourceId+':'+targetId+':b')
   ];
   return ui('<b>🔎 معاينة نسخ آمن بين مجموعتين</b>\n'+
    'الشبكة: '+esc(network.name)+'\n'+
    'المصدر: <code>'+sourceId+'</code> · سياسة '+selected.sourceRevision+'\n'+
    'الوجهة: <code>'+targetId+'</code> · سياسة '+selected.targetRevision+'\n'+
    'اختيار النسخ: '+labels[parts]+'\n'+
    'ستتغير فقط: '+selected.fields.map(x=>x==='rules'?'قواعد الحماية':'حدود الفلود').join('، ')+'\n'+
    'عدد قواعد المصدر: '+selected.ruleCount+'\n'+    (selected.fields.includes('rules')?'تُنقل قائمة القواعد المسموحة كاملةً بدل قواعد الوجهة الحالية؛ لا تُنقل قواعد الأعضاء أو الدفع.\n':'')+

    'وضع الوجهة الذي سيبقى: '+selected.targetMode+'\n'+
    'روابط متابعة ستتوقف احترازيًا: '+selected.pausedLinks+'\n'+
    'لا تُنقل القنوات والعضويات الموثوقة والاستثناءات وقوائم السماح ولا أذونات Telegram.\n'+
    'إذا احتوى المصدر على قواعد هوية أو دفع حساسة تُرفض عملية نسخ القواعد بدل تجاهلها سرًا.\n'+
    'تأكيد خاص لمرة واحدة خلال دقيقتين، دون عقوبة أو إرسال Telegram.',
    [choices,[btn('✅ تأكيد نسخ الإعدادات','nw:1:cc:'+token)],
     [btn('✖ إلغاء المعاينة','nw:1:cx:'+token)],
     [btn('↩️ اختيار وجهة أخرى','nw:1:ct:'+netId+':'+sourceId+':0')]]);
  });
 }
 private async decide(actor:string,token:string,doCopy:boolean):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.allowed(s,actor,now))return null;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+token),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||
     c.policyVersion!==0||!c.oneShot||c.used||c.revoked||
     !Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||
     !c.action.startsWith(PREFIX))return null;
   if(!doCopy){
    c.revoked=true;
    return ui('أُلغيت عملية النسخ دون تغيير إعدادات أي مجموعة.',
     [[btn('🌐 الشبكات والاتحادات','nw:1:h')]]);
   }
   const saved=decode(c.action.slice(PREFIX.length));if(!saved)return null;
   const current=previewNetworkGroupCopy(s,this.policy,actor,now,
    saved.netId,saved.sourceId,saved.targetId,saved.parts);
   if(!current||current.proof!==saved.proof||
      current.networkRevision!==saved.networkRevision||
      current.sourceRevision!==saved.sourceRevision||
      current.targetRevision!==saved.targetRevision)return null;
   const result=applyNetworkGroupCopy(s,this.policy,actor,now,
    saved.netId,saved.sourceId,saved.targetId,saved.parts,saved.proof);
   if(!result)return null;
   c.used=true;
   s.audit.push({actorId:actor,updateKey:'network-group-copy:'+token,
    decision:'ALLOW',reason:'NETWORK_POLICY_PORTABLE_FIELDS_COPIED_LOCAL',
    policyVersion:result.newRevision,at:now});
   return ui('<b>✅ نُسخت إعدادات المراقبة محليًا</b>\n'+
    'المجموعة المستهدفة: <code>'+result.targetId+'</code>\n'+
    'إصدار السياسة الجديد: '+result.newRevision+'\n'+
    'الوضع المحفوظ دون تعديل: '+result.mode+'\n'+
    'الحقول المنسوخة: '+result.fields.map(x=>x==='rules'?'القواعد':'الفلود').join('، ')+'\n'+
    'روابط التوريث التي توقفت: '+result.pausedLinks+'\n'+
    'لا نسخ لاستثناءات الأعضاء ولا تشغيل عقوبة Telegram.',
    [[btn('↩️ بطاقة الشبكة','nw:1:d:'+saved.netId)],
     [btn('📋 شبكاتي','nw:1:p:0')]]);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkGroupCopyRoute(data))return null;
  const c=confirm.exec(data);if(c)return this.decide(actor,c[1]!,true);
  const x=cancel.exec(data);if(x)return this.decide(actor,x[1]!,false);
  const v=preview.exec(data);
  if(v)return this.review(actor,v[1]!,v[2]!,v[3]!,v[4] as NetworkCopyPart);
  const s=await this.store.snapshot(),now=this.clock();
  if(!this.allowed(s,actor,now))return null;
  const a=sources.exec(data);if(a)return this.sourceList(s,actor,now,a[1]!,Number(a[2]));
  const t=targets.exec(data);
  if(t)return this.targetList(s,actor,now,t[1]!,t[2]!,Number(t[3]));
  return null;
 }
}
