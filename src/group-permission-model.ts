export const GROUP_PERMISSION_KEYS=['can_send_messages','can_send_audios','can_send_documents','can_send_photos','can_send_videos','can_send_video_notes','can_send_voice_notes','can_send_polls','can_send_other_messages','can_add_web_page_previews','can_react_to_messages','can_edit_tag','can_change_info','can_invite_users','can_pin_messages','can_manage_topics'] as const;
export type GroupPermissions=Record<typeof GROUP_PERMISSION_KEYS[number],boolean>;
export const GROUP_LOCK_MODES=['MESSAGES','MEDIA','LINKS','PHOTOS','VIDEOS','DOCUMENTS','OTHER','AUDIOS','VOICE','VIDEO_NOTES','POLLS'] as const;
export type GroupLockMode=typeof GROUP_LOCK_MODES[number];
export const GROUP_LOCK_SINGLE_PERMISSION:Partial<Record<GroupLockMode,typeof GROUP_PERMISSION_KEYS[number]>>={PHOTOS:'can_send_photos',VIDEOS:'can_send_videos',DOCUMENTS:'can_send_documents',OTHER:'can_send_other_messages',AUDIOS:'can_send_audios',VOICE:'can_send_voice_notes',VIDEO_NOTES:'can_send_video_notes',POLLS:'can_send_polls'};
export interface GroupPermissionJob{id:string;chatId:string;actorId:string;scopeVersion:number;kind:'LOCK'|'RESTORE';mode:GroupLockMode;before:GroupPermissions;after:GroupPermissions;sourceEpoch:string;createdAt:number;expiresAt:number;status:'PREVIEW'|'INTENT'|'STARTED'|'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED';restores?:string;attemptId?:string;}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function readGroupPermissions(v:unknown):GroupPermissions|null{
 if(!object(v)||Object.keys(v).some(k=>!GROUP_PERMISSION_KEYS.includes(k as typeof GROUP_PERMISSION_KEYS[number]))||Object.values(v).some(value=>typeof value!=='boolean'))return null;
 const p=Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,v[k]??false])) as GroupPermissions;
 if(v.can_react_to_messages===undefined)p.can_react_to_messages=p.can_send_messages;
 if(v.can_edit_tag===undefined)p.can_edit_tag=p.can_pin_messages;
 if(v.can_manage_topics===undefined)p.can_manage_topics=p.can_pin_messages;
 return p;
}
export function validGroupPermissions(v:unknown):v is GroupPermissions{return object(v)&&Object.keys(v).length===GROUP_PERMISSION_KEYS.length&&readGroupPermissions(v)!==null;}
export function equalGroupPermissions(a:GroupPermissions,b:GroupPermissions):boolean{return GROUP_PERMISSION_KEYS.every(k=>a[k]===b[k]);}
export function lockedGroupPermissions(before:GroupPermissions,mode:GroupLockMode):GroupPermissions{
 const next={...before};for(const key of GROUP_PERMISSION_KEYS){if(mode==='MESSAGES'&&(key.startsWith('can_send_')||key==='can_add_web_page_previews'||key==='can_react_to_messages')||mode==='MEDIA'&&key.startsWith('can_send_')&&key!=='can_send_messages'||mode==='LINKS'&&key==='can_add_web_page_previews'||GROUP_LOCK_SINGLE_PERMISSION[mode]===key)next[key]=false;}return next;
}
export function validGroupPermissionJobs(v:unknown):v is GroupPermissionJob[]{
 return Array.isArray(v)&&new Set(v.map(j=>j?.id)).size===v.length&&v.every(j=>object(j)&&Object.keys(j).every(k=>['id','chatId','actorId','scopeVersion','kind','mode','before','after','sourceEpoch','createdAt','expiresAt','status','restores','attemptId'].includes(k))&&Object.keys(j).length===12+(j.restores===undefined?0:1)+(j.attemptId===undefined?0:1)&&typeof j.id==='string'&&/^[A-Za-z0-9_-]{24}$/u.exec(j.id)?.[0]===j.id&&typeof j.chatId==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(j.chatId)?.[0]===j.chatId&&Number.isSafeInteger(Number(j.chatId))&&typeof j.actorId==='string'&&/^[1-9][0-9]{0,15}$/u.exec(j.actorId)?.[0]===j.actorId&&Number.isSafeInteger(Number(j.actorId))&&Number.isSafeInteger(j.scopeVersion)&&Number(j.scopeVersion)>0&&['LOCK','RESTORE'].includes(String(j.kind))&&GROUP_LOCK_MODES.includes(j.mode as GroupLockMode)&&validGroupPermissions(j.before)&&validGroupPermissions(j.after)&&typeof j.sourceEpoch==='string'&&/^[a-f0-9]{64}$/u.exec(j.sourceEpoch)?.[0]===j.sourceEpoch&&Number.isSafeInteger(j.createdAt)&&Number(j.createdAt)>=0&&Number.isSafeInteger(j.expiresAt)&&j.expiresAt===Number(j.createdAt)+120000&&['PREVIEW','INTENT','STARTED','CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','CANCELLED'].includes(String(j.status))&&(j.kind==='RESTORE'?typeof j.restores==='string'&&/^[A-Za-z0-9_-]{24}$/u.exec(j.restores)?.[0]===j.restores:j.restores===undefined)&&(j.attemptId===undefined?!['STARTED','CONFIRMED','UNKNOWN_OUTCOME'].includes(String(j.status)):!['PREVIEW','INTENT','CANCELLED'].includes(String(j.status))&&typeof j.attemptId==='string'&&/^[A-Za-z0-9_-]{24}$/u.exec(j.attemptId)?.[0]===j.attemptId));
}
