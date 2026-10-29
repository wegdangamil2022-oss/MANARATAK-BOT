export type StudioAction={kind:'URL'|'COPY'|'INLINE'|'SERVICE'|'MINI_APP';target:string};
export interface StudioCondition{role:'ANY'|'OWNER';opensAt:number;closesAt:number;seats:number;}
export interface StudioButton{id:string;title:string;action:StudioAction;style:'default'|'primary'|'success'|'danger';condition:StudioCondition;}
export interface StudioContent{name:string;text:string;buttons:StudioButton[];layout:number[];timezone:string;hour12:boolean;calendar:'gregory'|'islamic';}
export interface StudioVersion{revision:number;by:string;at:number;content:StudioContent;}
export interface StudioTemplate{id:string;revision:number;createdBy:string;createdAt:number;updatedBy:string;updatedAt:number;draft:StudioContent;versions:StudioVersion[];}
export interface StudioInput{actor:string;templateId:string;revision:number;field:string;buttonId:string;expiresAt:number;}
export interface StudioState{templates:StudioTemplate[];inputs:StudioInput[];}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&Array.from(v).length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000;
export const studioId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
export const studioServices=['si:2:s:h','si:2:u:h','si:2:c:h','si:2:e:h','si:2:f:h','student:open'] as const;
export function studioURL(input:string):string|null{
 try{const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||u.port||input!==u.href||u.href.length>1000||
  !/^[a-z0-9.-]+$/u.test(u.hostname)||!u.hostname.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/u.test(u.hostname)||
  /^[0-9.]+$/u.test(u.hostname)||u.hostname.split('.').some(x=>!x||x.startsWith('-')||x.endsWith('-'))||
  ['bit.ly','tinyurl.com','t.co','goo.gl','is.gd'].includes(u.hostname)||/[\s\u0000-\u001f\u007f\\]/u.test(input))return null;return u.href;
 }catch{return null;}
}
export function validStudioAction(v:unknown):v is StudioAction{
 if(!object(v)||!exact(v,['kind','target'])||typeof v.target!=='string')return false;
 if(v.kind==='URL'||v.kind==='MINI_APP')return studioURL(v.target)!==null;
 if(v.kind==='COPY')return text(v.target,256);
 if(v.kind==='INLINE')return text(v.target,128)&&!/[\r\n\t]/u.test(v.target);
 return v.kind==='SERVICE'&&studioServices.includes(v.target as typeof studioServices[number]);
}
export function validStudioContent(v:unknown):v is StudioContent{
 if(!object(v)||!exact(v,['name','text','buttons','layout','timezone','hour12','calendar'])||!text(v.name,80)||/[\r\n\t]/u.test(String(v.name))||!text(v.text,1200)||
  !Array.isArray(v.buttons)||v.buttons.length>24||!Array.isArray(v.layout)||v.layout.length>24||
  !v.layout.every(n=>Number.isSafeInteger(n)&&n>=1&&n<=3)||v.layout.reduce((a,b)=>a+b,0)!==v.buttons.length||
  typeof v.timezone!=='string'||v.timezone.length>80||typeof v.hour12!=='boolean'||!['gregory','islamic'].includes(String(v.calendar)))return false;
 try{new Intl.DateTimeFormat('ar',{timeZone:v.timezone});}catch{return false;}
 const ids=new Set();
 for(const b of v.buttons){
  if(!object(b)||!exact(b,['id','title','action','style','condition'])||!studioId(b.id)||ids.has(b.id)||!text(b.title,48)||
   /[\r\n\t]/u.test(String(b.title))||!validStudioAction(b.action)||!['default','primary','success','danger'].includes(String(b.style))||!object(b.condition)||
   !exact(b.condition,['role','opensAt','closesAt','seats']))return false;
  ids.add(b.id);const c=b.condition;
  if(!['ANY','OWNER'].includes(String(c.role))||!time(c.opensAt)||!time(c.closesAt)||c.closesAt!==0&&c.closesAt<=c.opensAt||
   !Number.isSafeInteger(c.seats)||Number(c.seats)<0||Number(c.seats)>1000000)return false;
 }
 const variables=String(v.text).match(/\{[^{}]*\}/gu)??[];
 return variables.every(s=>['{العضو}','{اسم_المجموعة}','{التاريخ}','{الوقت}','{رابط_القوانين}'].includes(s));
}
export function validStudioState(v:unknown):v is StudioState{
 if(!object(v)||!exact(v,['templates','inputs'])||!Array.isArray(v.templates)||v.templates.length>200||!Array.isArray(v.inputs)||v.inputs.length>20)return false;
 const ids=new Set();
 for(const t of v.templates){
  if(!object(t)||!exact(t,['id','revision','createdBy','createdAt','updatedBy','updatedAt','draft','versions'])||!studioId(t.id)||ids.has(t.id)||
   !Number.isSafeInteger(t.revision)||Number(t.revision)<1||!text(t.createdBy,20)||!text(t.updatedBy,20)||!time(t.createdAt)||!time(t.updatedAt)||
   !validStudioContent(t.draft)||!Array.isArray(t.versions)||t.versions.length>50)return false;
  ids.add(t.id);const revs=new Set();
  for(const h of t.versions){if(!object(h)||!exact(h,['revision','by','at','content'])||!Number.isSafeInteger(h.revision)||Number(h.revision)<1||Number(h.revision)>Number(t.revision)||revs.has(h.revision)||!text(h.by,20)||!time(h.at)||!validStudioContent(h.content))return false;revs.add(h.revision);}
 }
 const actors=new Set();
 for(const i of v.inputs){if(!object(i)||!exact(i,['actor','templateId','revision','field','buttonId','expiresAt'])||!text(i.actor,20)||actors.has(i.actor)||!studioId(i.templateId)||!ids.has(i.templateId)||!Number.isSafeInteger(i.revision)||Number(i.revision)<1||!text(i.field,24)||typeof i.buttonId!=='string'||i.buttonId!==''&&!studioId(i.buttonId)||!time(i.expiresAt))return false;actors.add(i.actor);}
 return true;
}
