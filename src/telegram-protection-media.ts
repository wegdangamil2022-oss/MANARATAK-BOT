import type {ProtectionMessageType} from './protection-rules.js';
export interface ProtectionMedia{type:Exclude<ProtectionMessageType,'TEXT'>;caption:string;entities?:unknown;}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const files={photo:'PHOTO',video:'VIDEO',animation:'ANIMATION',sticker:'STICKER',document:'DOCUMENT',audio:'AUDIO',voice:'VOICE',video_note:'VIDEO_NOTE'} as const;
const present=(msg:Record<string,unknown>,field:string)=>Object.hasOwn(msg,field);
const file=(v:unknown)=>object(v)&&typeof v.file_id==='string'&&/^[A-Za-z0-9_-]{1,512}$/u.test(v.file_id);
/** Retains only classification, caption and entity metadata. No media IDs,
 * contacts, poll contents or coordinates escape into the observation. */
export function protectionMediaFromMessage(msg:Record<string,unknown>):{status:'ABSENT'|'INVALID'}|{status:'MEDIA';media:ProtectionMedia}{
 let fields=[...Object.keys(files),'contact','location','poll'].filter(field=>present(msg,field));
 // Telegram also supplies document for backwards compatibility with animation.
 if(fields.length===2&&fields.includes('animation')&&fields.includes('document')&&file(msg.document))fields=['animation'];
 if(!fields.length)return {status:'ABSENT'};
 if(fields.length!==1||present(msg,'text')||msg.caption!==undefined&&(typeof msg.caption!=='string'||msg.caption.length>4096||msg.caption.includes('\0')))return {status:'INVALID'};
 const field=fields[0]!,value=msg[field];let type:ProtectionMedia['type'];
 if(field==='photo'){
  if(!Array.isArray(value)||value.length<1||value.length>10||!value.every(file))return {status:'INVALID'};
  type='PHOTO';
 }else if(Object.hasOwn(files,field)){
  if(!file(value))return {status:'INVALID'};
  type=files[field as keyof typeof files];
 }else{
  if(!object(value))return {status:'INVALID'};
  if(field==='contact'){
   if(typeof value.phone_number!=='string'||value.phone_number.length<1||value.phone_number.length>128||typeof value.first_name!=='string'||value.first_name.length>256)return {status:'INVALID'};
   type='CONTACT';
  }else if(field==='location'){
   if(typeof value.latitude!=='number'||!Number.isFinite(value.latitude)||Math.abs(value.latitude)>90||typeof value.longitude!=='number'||!Number.isFinite(value.longitude)||Math.abs(value.longitude)>180)return {status:'INVALID'};
   type='LOCATION';
  }else{
   if(typeof value.id!=='string'||value.id.length<1||value.id.length>128||typeof value.question!=='string'||value.question.length>300||!Array.isArray(value.options)||value.options.length<2||value.options.length>12)return {status:'INVALID'};
   type='POLL';
  }
 }
 return {status:'MEDIA',media:{type,caption:typeof msg.caption==='string'?msg.caption:'',...(msg.caption_entities!==undefined?{entities:msg.caption_entities}:{})}};
}
