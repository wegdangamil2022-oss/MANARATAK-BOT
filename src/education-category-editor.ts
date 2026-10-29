import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,EducationCategory,CallbackRecord} from './store.js';
import type {Policy} from './policy.js';
import {categoryVisibilityFingerprint,validCategoryLanguage} from './education-category-policy.js';
type Edit={kind:'RENAME'|'CHILD'|'ROOT'|'LANG'|'PARENT';id:string;proof:string;epoch:number;page:number};
const INPUT='category.input:',WRITE='category.write:',PICK='category.parent.picker:';
const random=()=>randomBytes(18).toString('base64url');
function decode(v:unknown):Edit|null{
 if(!Array.isArray(v)||v.length!==5||!['RENAME','CHILD','ROOT','LANG','PARENT'].includes(v[0])||typeof v[1]!=='string'||typeof v[2]!=='string'||!Number.isSafeInteger(v[3])||v[3]<0||!Number.isSafeInteger(v[4])||v[4]<0||v[4]>999)return null;
 return {kind:v[0],id:v[1],proof:v[2],epoch:v[3],page:v[4]};
}
const encode=(e:Edit)=>[e.kind,e.id,e.proof,e.epoch,e.page];
export class EducationCategoryEditor{
 constructor(private store:BotStore,private policy:Policy,private clock:()=>number=Date.now){}
 private auth(s:BotState,actor:string):number{const now=this.clock();if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor)||!Number.isSafeInteger(now)||now<0||now>8640000000000000-600000)throw Error('CATEGORY_EDITOR_DENIED');return now;}
 private current(s:BotState,e:Edit):EducationCategory|null{
  if(e.kind==='ROOT'){if(e.id!==''||e.proof!==''||e.epoch!==0)throw Error('CATEGORY_ROOT_INVALID');return null;}
  const matches=s.educationCategories.filter(c=>c.id===e.id),c=matches[0];
  if(matches.length!==1||!c||categoryVisibilityFingerprint(c)!==e.proof||(c.scope==='private'?0:this.policy.chatRevision(s,c.scope))!==e.epoch||c.scope!=='private'&&!this.policy.canUseChat(s,c.scope,'navigation'))throw Error('CATEGORY_EDITOR_STALE');return c;
 }
 private valid(c:CallbackRecord,actor:string,now:number,ttl:number):boolean{return c.actorId===actor&&c.chatId==='private'&&c.policyVersion===0&&c.oneShot===true&&c.used===false&&c.revoked===false&&Number.isSafeInteger(c.expiresAt)&&c.expiresAt>now&&c.expiresAt<=now+ttl;}
 private parent(s:BotState,source:EducationCategory,value:string,rootMarker='0'):EducationCategory|null{
  if(value===rootMarker)return null;
  const matches=s.educationCategories.filter(c=>c.id===value),target=matches[0];if(matches.length!==1||!target||target.scope!==source.scope)throw Error('CATEGORY_PARENT_SCOPE_INVALID');
  let current:EducationCategory|undefined=target;const seen=new Set<string>();
  while(current){if(current.id===source.id||seen.has(current.id)||current.scope!==source.scope)throw Error('CATEGORY_PARENT_CYCLE');seen.add(current.id);if(!current.parentId)break;const parents=s.educationCategories.filter(c=>c.id===current!.parentId);if(parents.length!==1)throw Error('CATEGORY_PARENT_INVALID');current=parents[0];}
  return target;
 }
 private parentChainProof(s:BotState,target:EducationCategory|null):string{
  if(!target)return '';
  const frames:string[]=[],seen=new Set<string>();let current:EducationCategory|undefined=target;
  while(current){if(seen.has(current.id)||current.scope!==target.scope)throw Error('CATEGORY_PARENT_CYCLE');seen.add(current.id);frames.push(categoryVisibilityFingerprint(current));
   if(!current.parentId)break;const matches=s.educationCategories.filter(c=>c.id===current!.parentId);if(matches.length!==1)throw Error('CATEGORY_PARENT_INVALID');current=matches[0];
  }
  return createHash('sha256').update(JSON.stringify(frames)).digest('hex');
 }
 async cancel(actor:string):Promise<void>{await this.store.transaction(s=>{if(!this.policy.isOwner(actor))return;for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(INPUT)&&c.used===false)c.revoked=true;});}
 async begin(actor:string,kind:Edit['kind'],id:string,page:number):Promise<void>{await this.store.transaction(s=>{
  const now=this.auth(s,actor),cat=s.educationCategories.find(c=>c.id===id),e:Edit={kind,id,proof:cat?categoryVisibilityFingerprint(cat):'',epoch:cat&&cat.scope!=='private'?this.policy.chatRevision(s,cat.scope):0,page};
  if(!decode(encode(e)))throw Error('CATEGORY_EDITOR_INVALID');this.current(s,e);
  for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(INPUT)&&c.used===false)c.revoked=true;
  if(s.buttonStudio)s.buttonStudio.inputs=s.buttonStudio.inputs.filter(i=>i.actor!==actor);
  s.callbacks.push({ref:'c_'+random(),action:INPUT+JSON.stringify(encode(e)),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+600000});
 });}
 async parentPicker(actor:string,id:string,returnPage:number,page=0,expectedProof?:string,expectedEpoch?:number):Promise<{text:string;buttons:{text:string;callback_data:string}[]}>{return this.store.transaction(s=>{
  const now=this.auth(s,actor),matches=s.educationCategories.filter(c=>c.id===id),source=matches[0];if(matches.length!==1||!source)throw Error('CATEGORY_EDITOR_STALE');
  const proof=categoryVisibilityFingerprint(source),epoch=source.scope==='private'?0:this.policy.chatRevision(s,source.scope);
  if(expectedProof!==undefined&&(expectedProof!==proof||expectedEpoch!==epoch))throw Error('CATEGORY_EDITOR_STALE');
  const e:Edit={kind:'PARENT',id,proof,epoch,page:returnPage};if(!decode(encode(e)))throw Error('CATEGORY_EDITOR_INVALID');this.current(s,e);
  const counts=new Map<string,number>();for(const c of s.educationCategories)counts.set(c.id,(counts.get(c.id)??0)+1);
  const choices=s.educationCategories.filter(c=>{
   if(c.id===id||c.scope!==source.scope||counts.get(c.id)!==1)return false;
   try{this.parent(s,source,c.id,'@root');return true;}catch{return false;}
  }).sort((a,b)=>a.title.localeCompare(b.title,'ar')||a.id.localeCompare(b.id));
  const pages=Math.max(1,Math.ceil(choices.length/8));if(!Number.isSafeInteger(page)||page<0||page>=pages||page>999)throw Error('CATEGORY_PARENT_PAGE_INVALID');
  s.callbacks=s.callbacks.filter(c=>!c.action.startsWith(PICK)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt>now);
  const needed=Math.min(8,choices.length-page*8)+1+(page>0?1:0)+(page+1<pages?1:0);
  if(s.callbacks.filter(c=>c.action.startsWith(PICK)&&c.expiresAt>now).length+needed>200)throw Error('CATEGORY_PARENT_PICKER_LIMIT');
  const make=(label:string,kind:'PAGE'|'SELECT',value:string,targetProof='')=>{
   const ref='c_'+random();s.callbacks.push({ref,action:PICK+JSON.stringify([encode(e),kind,value,targetProof]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000});
   return {text:Array.from(label.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ')).slice(0,60).join(''),callback_data:'ec:1:p:'+ref.slice(2)};
  };
  const buttons=choices.slice(page*8,page*8+8).map(c=>{
   const ancestor=c.parentId?s.educationCategories.find(p=>p.id===c.parentId&&p.scope===c.scope)?.title:'رئيسي';
   return make('📁 '+Array.from(c.title).slice(0,32).join('')+' · '+Array.from(ancestor??'أب غير متاح').slice(0,20).join(''),'SELECT',c.id,this.parentChainProof(s,c));
  });
  buttons.push(make('🏠 قسم رئيسي بلا أب','SELECT','@root'));
  if(page>0)buttons.push(make('⬅️ السابق','PAGE',String(page-1)));
  if(page+1<pages)buttons.push(make('➡️ التالي','PAGE',String(page+1)));
  return {text:'<b>اختيار القسم الأب</b>\nاختر من الأقسام في النطاق نفسه، أو اجعل القسم رئيسيًا.\nالصفحة '+(page+1)+' من '+pages+'\nيمكنك أيضًا إرسال المعرّف مباشرةً.',buttons};
 });}
 async chooseParent(actor:string,ref:string):Promise<{kind:'PAGE';id:string;proof:string;epoch:number;page:number;returnPage:number}|{kind:'PREVIEW';name:string;ref:string}|null>{return this.store.transaction(s=>{
  const now=this.auth(s,actor),matches=s.callbacks.filter(c=>c.ref===ref),c=matches[0];if(matches.length!==1||!c||!/^c_[A-Za-z0-9_-]{24}$/u.test(ref)||!this.valid(c,actor,now,120000)||!c.action.startsWith(PICK))return null;
  const v:unknown=JSON.parse(c.action.slice(PICK.length));if(!Array.isArray(v)||v.length!==4||!['PAGE','SELECT'].includes(v[1])||typeof v[2]!=='string'||typeof v[3]!=='string')return null;
  const e=decode(v[0]);if(!e||e.kind!=='PARENT')return null;const source=this.current(s,e)!;
  if(v[1]==='PAGE'){
   if(!/^(0|[1-9][0-9]{0,2})$/u.test(v[2])||v[3]!=='')return null;c.used=true;return {kind:'PAGE',id:e.id,proof:e.proof,epoch:e.epoch,page:Number(v[2]),returnPage:e.page};
  }
  const target=this.parent(s,source,v[2],'@root');if(v[3]!==this.parentChainProof(s,target))throw Error('CATEGORY_PARENT_STALE');
  const confirmation='c_'+random();s.callbacks.push({ref:confirmation,action:WRITE+JSON.stringify([encode(e),v[2],v[3],'EXACT']),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000});
  for(const pending of s.callbacks)if(pending.actorId===actor&&pending.action.startsWith(INPUT)&&pending.used===false)pending.revoked=true;
  c.used=true;
  return {kind:'PREVIEW',name:target?.title??'قسم رئيسي بلا أب',ref:confirmation};
 });}
 async preview(actor:string,text:string):Promise<{name:string;kind:Edit['kind'];ref:string}|null>{return this.store.transaction(s=>{
  const active=s.callbacks.filter(c=>c.actorId===actor&&c.action.startsWith(INPUT)&&c.used===false&&c.revoked===false);if(!active.length)return null;
  const now=this.auth(s,actor),c=active[0]!;if(active.length!==1||s.callbacks.filter(x=>x.ref===c.ref).length!==1||!this.valid(c,actor,now,600000))throw Error('CATEGORY_INPUT_EXPIRED');
  const e=decode(JSON.parse(c.action.slice(INPUT.length)));if(!e)throw Error('CATEGORY_INPUT_INVALID');const source=this.current(s,e);
  const name=text.trim();if(!name||name.length>100||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name))throw Error('CATEGORY_NAME_INVALID');
  if(e.kind==='LANG'&&!validCategoryLanguage(name))throw Error('CATEGORY_LANGUAGE_INVALID');
  const target=e.kind==='PARENT'?this.parent(s,source!,name):null;
  const ref='c_'+random();s.callbacks.push({ref,action:WRITE+JSON.stringify([encode(e),name,...(e.kind==='PARENT'?[target?categoryVisibilityFingerprint(target):'']:[])]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000});c.used=true;
  return {name:e.kind==='PARENT'?(target?.title??'قسم رئيسي بلا أب'):name,kind:e.kind,ref};
 });}
 async confirm(actor:string,ref:string):Promise<{page:number;category:EducationCategory}|null>{return this.store.transaction(s=>{
  const now=this.auth(s,actor),matches=s.callbacks.filter(c=>c.ref===ref),c=matches[0];if(matches.length!==1||!c||!/^c_[A-Za-z0-9_-]{24}$/u.test(ref)||!this.valid(c,actor,now,120000)||!c.action.startsWith(WRITE))return null;
  const v:unknown=JSON.parse(c.action.slice(WRITE.length));if(!Array.isArray(v)||![2,3,4].includes(v.length)||typeof v[1]!=='string'||!v[1]||v[1]!==v[1].trim()||v[1].length>100||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v[1]))return null;
  const e=decode(v[0]);if(!e||(e.kind==='PARENT'?(v.length!==3&&!(v.length===4&&v[3]==='EXACT')):v.length!==2))return null;let cat=this.current(s,e);
  if(e.kind==='PARENT'){
   const target=this.parent(s,cat!,v[1],v.length===4?'@root':'0');if(v[2]!==(v.length===4?this.parentChainProof(s,target):target?categoryVisibilityFingerprint(target):''))throw Error('CATEGORY_PARENT_STALE');
   const parentId=target?.id??null,peers=s.educationCategories.filter(c=>c.scope===cat!.scope&&c.parentId===parentId&&c.id!==cat!.id),order=peers.length?Math.max(...peers.map(c=>c.order))+1:0;
   if(!Number.isSafeInteger(order)||!Number.isSafeInteger((cat!.revision??0)+1))throw Error('CATEGORY_ORDER_INVALID');cat!.parentId=parentId;cat!.order=order;cat!.revision=(cat!.revision??0)+1;
  }else if(e.kind==='LANG'){
   if(!validCategoryLanguage(v[1])||!Number.isSafeInteger((cat!.revision??0)+1))throw Error('CATEGORY_LANGUAGE_INVALID');
   cat!.language=Intl.getCanonicalLocales(v[1])[0]!;cat!.revision=(cat!.revision??0)+1;
  }else if(e.kind==='RENAME'){
   if(!Number.isSafeInteger((cat!.revision??0)+1)||s.educationCategories.some(c=>c.id!==cat!.id&&c.scope===cat!.scope&&c.parentId===cat!.parentId&&c.title===v[1]))throw Error('CATEGORY_NAME_EXISTS');
   cat!.title=v[1];cat!.revision=(cat!.revision??0)+1;
  }
  else{
   const scope=cat?.scope??'private',parentId=cat?.id??null,peers=s.educationCategories.filter(c=>c.scope===scope&&c.parentId===parentId);
   if(peers.some(c=>c.title===v[1]))throw Error('CATEGORY_NAME_EXISTS');
   const order=peers.length?Math.max(...peers.map(c=>c.order))+1:0;if(!Number.isSafeInteger(order))throw Error('CATEGORY_ORDER_INVALID');
   cat={id:'cat-'+randomBytes(12).toString('hex'),scope,parentId,title:v[1],order,enabled:true,revision:1};s.educationCategories.push(cat);
  }
  c.used=true;s.audit.push({actorId:actor,updateKey:'category-edit:'+ref,decision:'ALLOW',reason:'CATEGORY_'+e.kind+'_CONFIRMED',policyVersion:e.epoch,at:now});return {page:e.page,category:structuredClone(cat!)};
 });}
}
