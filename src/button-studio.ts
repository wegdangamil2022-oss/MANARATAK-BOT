import {randomBytes} from 'node:crypto';
import {studioPresetContent} from './button-studio-presets.js';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import {validStudioContent,studioId,defaultStudioSettings,validStudioSettings,type StudioSettings,type StudioTemplate,type StudioContent,type StudioAction,type StudioButton} from './button-studio-model.js';
export type StudioEdit={kind:'NAME'|'TEXT'|'ADD_BUTTON'|'LAYOUT'|'TIMEZONE';value:string}|{kind:'BUTTON_TITLE';buttonId:string;value:string}|
 {kind:'ACTION';buttonId:string;action:StudioAction}|{kind:'STYLE';buttonId:string;style:StudioButton['style']}|
 {kind:'CONDITION';buttonId:string;condition:StudioButton['condition']}|{kind:'DELETE_BUTTON'|'COPY_BUTTON';buttonId:string}|
 {kind:'MOVE_BUTTON';from:number;to:number}|{kind:'COPY_ROW';row:number}|{kind:'PAGE_SIZE';rows:number}|{kind:'FORMAT';hour12:boolean;calendar:StudioContent['calendar']};
export const studioInputFields=['NAME','TEXT','ADD_BUTTON','LAYOUT','BUTTON_TITLE','TARGET','TIMEZONE','OPENS_AT','CLOSES_AT','SEATS'] as const;
const id=()=>randomBytes(6).toString('hex');
export class ButtonStudioService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now){}
 private auth(s:BotState,actor:string):number{
  const now=this.clock();if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor)||!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000-600000)throw Error('STUDIO_NOT_AUTHORIZED');return now;
 }
 private current(s:BotState,actor:string,key:string,revision:number):StudioTemplate{
  const now=this.auth(s,actor),matches=s.buttonStudio?.templates.filter(t=>t.id===key)??[],t=matches[0];
  if(!studioId(key)||matches.length!==1||!t||t.revision!==revision||now<t.updatedAt||t.revision>=1000000)throw Error('STUDIO_STALE_DRAFT');return t;
 }
 private change(s:BotState,actor:string,t:StudioTemplate,edit:StudioEdit):void{
  const d=structuredClone(t.draft),button='buttonId' in edit?d.buttons.find(b=>b.id===edit.buttonId):undefined;
  if('buttonId' in edit&&!button)throw Error('STUDIO_BUTTON_MISSING');
  switch(edit.kind){
   case 'NAME':d.name=edit.value;break;
   case 'TEXT':d.text=edit.value;break;
   case 'TIMEZONE':d.timezone=edit.value;break;
   case 'ADD_BUTTON':d.buttons.push({id:id(),title:edit.value,action:{kind:'COPY',target:edit.value},style:s.buttonStudio?.settings?.colorsByFunction?'success':'default',condition:{role:'ANY',opensAt:0,closesAt:0,seats:0}});d.layout.push(1);break;
   case 'LAYOUT':if(!/^[1-3](?:-[1-3]){0,23}$/u.test(edit.value))throw Error('STUDIO_INVALID_LAYOUT');d.layout=edit.value.split('-').map(Number);break;
   case 'BUTTON_TITLE':button!.title=edit.value;break;
   case 'ACTION':button!.action=structuredClone(edit.action);if(s.buttonStudio?.settings?.colorsByFunction)button!.style=edit.action.kind==='URL'?'primary':edit.action.kind==='COPY'?'success':'default';break;
   case 'STYLE':button!.style=edit.style;break;
   case 'CONDITION':button!.condition=structuredClone(edit.condition);break;
   case 'DELETE_BUTTON':{
    const index=d.buttons.findIndex(b=>b.id===edit.buttonId);let end=0;
    const row=d.layout.findIndex(size=>{end+=size;return index<end;});
    if(index<0||row<0)throw Error('STUDIO_BUTTON_MISSING');
    d.buttons.splice(index,1);if(d.layout[row]===1)d.layout.splice(row,1);else d.layout[row]!--;
    break;
   }
   case 'COPY_BUTTON':d.buttons.push({...structuredClone(button!),id:id()});d.layout.push(1);break;
   case 'MOVE_BUTTON':{
    if(!Number.isSafeInteger(edit.from)||!Number.isSafeInteger(edit.to)||edit.from<0||edit.to<0||edit.from>=d.buttons.length||edit.to>=d.buttons.length||edit.from===edit.to)throw Error('STUDIO_INVALID_MOVE');
    const [b]=d.buttons.splice(edit.from,1);d.buttons.splice(edit.to,0,b!);break;
   }
   case 'COPY_ROW':{
    if(!Number.isSafeInteger(edit.row)||edit.row<0||edit.row>=d.layout.length)throw Error('STUDIO_INVALID_ROW');
    const start=d.layout.slice(0,edit.row).reduce((a,b)=>a+b,0),size=d.layout[edit.row]!;
    const row=d.buttons.slice(start,start+size).map(b=>({...structuredClone(b),id:id()}));d.buttons.splice(start+size,0,...row);d.layout.splice(edit.row+1,0,size);break;
   }
   case 'FORMAT':d.hour12=edit.hour12;d.calendar=edit.calendar;break;
   case 'PAGE_SIZE':d.rowsPerPage=edit.rows;break;
   default:throw Error('STUDIO_UNKNOWN_EDIT');
  }
  if(!validStudioContent(d)||d.buttons.length>(s.buttonStudio?.settings?.buttonLimit??24)||d.buttons.some(b=>b.action.kind==='MENU'&&(b.action.target===t.id||!s.buttonStudio?.templates.some(target=>target.id===b.action.target))))throw Error('STUDIO_INVALID_CONTENT');this.record(s,actor,t,d,'STUDIO_DRAFT_CHANGED');
 }
 private record(s:BotState,actor:string,t:StudioTemplate,draft:StudioContent,reason:string):void{
  t.draft=draft;t.revision++;t.updatedAt=this.clock();t.updatedBy=actor;
  s.audit.push({actorId:actor,updateKey:'studio:'+t.id+':'+t.revision,decision:'ALLOW',reason,policyVersion:0,at:this.clock()});
 }
 async create(actor:string,name:string,preset?:string):Promise<StudioTemplate>{return this.store.transaction(s=>{
  const now=this.auth(s,actor),studio=s.buttonStudio??={templates:[],inputs:[]};if(studio.templates.length>=200)throw Error('STUDIO_LIMIT');
  const settings=studio.settings??defaultStudioSettings(),base=preset===undefined?studio.templates.find(t=>t.id===settings.defaultTemplateId):undefined;
  const draft:StudioContent=preset===undefined?(base?{...structuredClone(base.draft),name,buttons:base.draft.buttons.map(b=>({...structuredClone(b),id:id()}))}:{name,text:'رسالة جديدة',buttons:[],layout:[],timezone:'Asia/Aden',hour12:false,calendar:'gregory',rowsPerPage:settings.rowsPerPage}):studioPresetContent(preset,id)!;
  if(!validStudioContent(draft)||draft.buttons.length>settings.buttonLimit)throw Error('STUDIO_INVALID_CONTENT');
  const t:StudioTemplate={id:id(),revision:1,createdBy:actor,createdAt:now,updatedBy:actor,updatedAt:now,draft,versions:[]};studio.templates.push(t);
  s.audit.push({actorId:actor,updateKey:'studio:'+t.id+':1',decision:'ALLOW',reason:'STUDIO_DRAFT_CREATED',policyVersion:0,at:now});return structuredClone(t);
 });}
 async edit(actor:string,key:string,revision:number,edit:StudioEdit):Promise<StudioTemplate>{return this.store.transaction(s=>{const t=this.current(s,actor,key,revision);this.change(s,actor,t,edit);return structuredClone(t);});}
 async duplicate(actor:string,key:string,revision:number):Promise<StudioTemplate>{return this.store.transaction(s=>{
  const source=this.current(s,actor,key,revision),studio=s.buttonStudio!,now=this.clock();if(studio.templates.length>=200)throw Error('STUDIO_LIMIT');
  const draft=structuredClone(source.draft);draft.name=Array.from('نسخة · '+draft.name).slice(0,80).join('');
  draft.buttons=draft.buttons.map(b=>({...b,id:id()}));if(!validStudioContent(draft))throw Error('STUDIO_INVALID_CONTENT');
  const t:StudioTemplate={id:id(),revision:1,createdBy:actor,createdAt:now,updatedBy:actor,updatedAt:now,draft,versions:[]};studio.templates.push(t);
  s.audit.push({actorId:actor,updateKey:'studio:'+t.id+':1',decision:'ALLOW',reason:'STUDIO_DRAFT_DUPLICATED',policyVersion:0,at:now});return structuredClone(t);
 });}
 async save(actor:string,key:string,revision:number):Promise<StudioTemplate>{return this.store.transaction(s=>{
  const t=this.current(s,actor,key,revision);if(t.versions.length>=50)throw Error('STUDIO_VERSION_LIMIT');
  this.record(s,actor,t,structuredClone(t.draft),'STUDIO_VERSION_SAVED');t.versions.push({revision:t.revision,by:actor,at:this.clock(),content:structuredClone(t.draft)});return structuredClone(t);
 });}
 private restoreInState(s:BotState,actor:string,key:string,revision:number,savedRevision:number):StudioTemplate{
  const t=this.current(s,actor,key,revision),v=t.versions.find(v=>v.revision===savedRevision);if(!v||t.versions.length>=50||v.content.buttons.length>(s.buttonStudio?.settings?.buttonLimit??24))throw Error('STUDIO_VERSION_MISSING');
  this.record(s,actor,t,structuredClone(v.content),'STUDIO_VERSION_RESTORED');t.versions.push({revision:t.revision,by:actor,at:this.clock(),content:structuredClone(t.draft)});return structuredClone(t);
 }
 async restore(actor:string,key:string,revision:number,savedRevision:number):Promise<StudioTemplate>{return this.store.transaction(s=>this.restoreInState(s,actor,key,revision,savedRevision));}
 async issueDecision(actor:string,key:string,revision:number,kind:'RESTORE'|'DELETE_BUTTON',target:string):Promise<string>{return this.store.transaction(s=>{
  const t=this.current(s,actor,key,revision);
  if(kind==='RESTORE'?!/^[1-9][0-9]{0,6}$/u.test(target)||!t.versions.some(v=>v.revision===Number(target)):!t.draft.buttons.some(b=>b.id===target))throw Error('STUDIO_DECISION_INVALID');
  const ref='c_'+randomBytes(18).toString('base64url');
  s.callbacks.push({ref,action:'studio.'+kind+':'+key+':'+revision+':'+target,chatId:'private',actorId:actor,policyVersion:0,expiresAt:this.clock()+(s.buttonStudio?.settings?.confirmationSeconds??120)*1000,oneShot:true,used:false,revoked:false});return ref;
 });}
 async confirmDecision(actor:string,ref:string):Promise<StudioTemplate|null>{return this.store.transaction(s=>{
  const now=this.auth(s,actor),rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
  if(!/^c_[A-Za-z0-9_-]{24}$/u.test(ref)||rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.used!==false||c.revoked!==false||c.oneShot!==true||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000)return null;
  const m=/^studio\.(RESTORE|DELETE_BUTTON):([a-f0-9]{12}):([1-9][0-9]{0,6}):([a-f0-9]{12}|[1-9][0-9]{0,6})$/u.exec(c.action);if(!m||m[0]!==c.action)return null;
  const t=this.current(s,actor,m[2]!,Number(m[3]));
  if(m[1]==='RESTORE')this.restoreInState(s,actor,t.id,t.revision,Number(m[4]));
  else this.change(s,actor,t,{kind:'DELETE_BUTTON',buttonId:m[4]!});c.used=true;return structuredClone(t);
 });}
 async beginInput(actor:string,key:string,revision:number,field:typeof studioInputFields[number],buttonId=''):Promise<void>{await this.store.transaction(s=>{
  const t=this.current(s,actor,key,revision);if(!studioInputFields.includes(field)||buttonId&&!t.draft.buttons.some(b=>b.id===buttonId))throw Error('STUDIO_INVALID_INPUT');
  const studio=s.buttonStudio!;studio.inputs=studio.inputs.filter(i=>i.actor!==actor&&i.expiresAt>this.clock());
  studio.inputs.push({actor,templateId:key,revision,field,buttonId,expiresAt:this.clock()+(studio.settings?.inputSeconds??600)*1000});
 });}
 async cancelInput(actor:string):Promise<void>{await this.store.transaction(s=>{if(!this.policy.isOwner(actor))throw Error('STUDIO_NOT_AUTHORIZED');if(s.buttonStudio)s.buttonStudio.inputs=s.buttonStudio.inputs.filter(i=>i.actor!==actor);});}
 async pressPreview(actor:string,key:string,revision:number,buttonId:string):Promise<StudioButton>{return this.store.transaction(s=>{
  const t=this.current(s,actor,key,revision),b=t.draft.buttons.find(b=>b.id===buttonId),now=this.clock();if(!b||now<b.condition.opensAt||b.condition.closesAt!==0&&now>=b.condition.closesAt||b.condition.role==='OWNER'&&!this.policy.isOwner(actor))throw Error('STUDIO_BUTTON_CONDITION_DENIED');
  if(b.action.kind==='SERVICE'&&!this.policy.privateFeature(s,'education.navigate',actor))throw Error('STUDIO_SERVICE_UNAVAILABLE');
  if(b.action.kind==='MENU'&&(b.action.target===t.id||s.buttonStudio?.templates.filter(target=>target.id===b.action.target).length!==1))throw Error('STUDIO_MENU_UNAVAILABLE');
  if(b.condition.seats){
   const action='studio.seat:'+key+':'+revision+':'+buttonId,claims=s.callbacks.filter(c=>c.action===action);
   if(claims.some(c=>c.used!==true||c.revoked!==false||c.oneShot!==true||c.chatId!=='private'||!c.actorId)||new Set(claims.map(c=>c.actorId)).size!==claims.length)throw Error('STUDIO_BUTTON_CLAIMS_INVALID');
   if(!claims.some(c=>c.actorId===actor)){
    if(claims.length>=b.condition.seats)throw Error('STUDIO_BUTTON_FULL');
    s.callbacks.push({ref:'studio-seat:'+randomBytes(18).toString('base64url'),action,actorId:actor,chatId:'private',policyVersion:0,expiresAt:8_640_000_000_000_000,oneShot:true,used:true,revoked:false});
    s.audit.push({actorId:actor,updateKey:'studio-seat:'+key+':'+revision+':'+buttonId+':'+actor,decision:'ALLOW',reason:'STUDIO_PREVIEW_SEAT_CLAIMED',policyVersion:0,at:now});
   }
  }
  return structuredClone(b);
 });}
 async acceptInput(actor:string,text:string):Promise<StudioTemplate|null>{return this.store.transaction(s=>{
  const input=s.buttonStudio?.inputs.find(i=>i.actor===actor);if(!input)return null;
  const now=this.auth(s,actor),t=this.current(s,actor,input.templateId,input.revision);
  if(input.expiresAt<=now||input.expiresAt>now+600000)throw Error('STUDIO_INPUT_EXPIRED');
  let edit:StudioEdit;
  if(input.field==='BUTTON_TITLE')edit={kind:'BUTTON_TITLE',buttonId:input.buttonId,value:text};
  else if(['OPENS_AT','CLOSES_AT','SEATS'].includes(input.field)){
   const b=t.draft.buttons.find(b=>b.id===input.buttonId);if(!b)throw Error('STUDIO_BUTTON_MISSING');let value:number;
   if(input.field==='SEATS'){if(!/^(?:0|[1-9][0-9]{0,6})$/u.test(text))throw Error('STUDIO_INVALID_SEATS');value=Number(text);}
   else if(text==='0')value=0;
   else{
    const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/u.exec(text);
    if(!m||Number(m[2])<1||Number(m[2])>12||Number(m[3])<1||Number(m[3])>new Date(Date.UTC(Number(m[1]),Number(m[2]),0)).getUTCDate()||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59)throw Error('STUDIO_INVALID_TIME');
    value=Date.parse(text);if(!Number.isSafeInteger(value)||value<0)throw Error('STUDIO_INVALID_TIME');
   }
   edit={kind:'CONDITION',buttonId:b.id,condition:{...b.condition,...(input.field==='SEATS'?{seats:value}:input.field==='OPENS_AT'?{opensAt:value}:{closesAt:value})}};
  }
  else if(input.field==='TARGET'){
   const b=t.draft.buttons.find(b=>b.id===input.buttonId);if(!b)throw Error('STUDIO_BUTTON_MISSING');
   edit={kind:'ACTION',buttonId:input.buttonId,action:{kind:b.action.kind,target:text}};
  }else if(['NAME','TEXT','ADD_BUTTON','LAYOUT','TIMEZONE'].includes(input.field))edit={kind:input.field as 'NAME'|'TEXT'|'ADD_BUTTON'|'LAYOUT'|'TIMEZONE',value:text};
  else throw Error('STUDIO_INVALID_INPUT');
  this.change(s,actor,t,edit);s.buttonStudio!.inputs=s.buttonStudio!.inputs.filter(i=>i!==input);return structuredClone(t);
 });}
 async list(actor:string):Promise<StudioTemplate[]>{const s=await this.store.snapshot();this.auth(s,actor);return structuredClone(s.buttonStudio?.templates??[]);}
 async settings(actor:string):Promise<StudioSettings>{const s=await this.store.snapshot();this.auth(s,actor);return structuredClone(s.buttonStudio?.settings??defaultStudioSettings());}
 async configure(actor:string,revision:number,field:Exclude<keyof StudioSettings,'revision'>,value:string|number|boolean):Promise<StudioSettings>{return this.store.transaction(s=>{
  const now=this.auth(s,actor),studio=s.buttonStudio??={templates:[],inputs:[]},current=studio.settings??defaultStudioSettings();
  if(current.revision!==revision||current.revision>=999999||!['defaultTemplateId','buttonLimit','rowsPerPage','colorsByFunction','inputSeconds','confirmationSeconds'].includes(field))throw Error('STUDIO_STALE_SETTINGS');
  const next={...current,[field]:value,revision:revision+1};if(!validStudioSettings(next)||next.defaultTemplateId&&!studio.templates.some(t=>t.id===next.defaultTemplateId)||studio.templates.some(t=>t.draft.buttons.length>next.buttonLimit))throw Error('STUDIO_INVALID_SETTINGS');
  studio.settings=next;s.audit.push({actorId:actor,updateKey:'studio-settings:'+next.revision,decision:'ALLOW',reason:'STUDIO_SETTINGS_CHANGED',policyVersion:0,at:now});return structuredClone(next);
 });}
}
