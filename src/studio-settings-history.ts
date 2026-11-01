import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import {validStudioSettings,type StudioSettings} from './button-studio-model.js';
const PREFIX='studio-settings-history:',ACTION='studio.settings.history:',MAX_TIME=8640000000000000;
export interface StudioSettingsHistory{nonce:string;before:StudioSettings;after:StudioSettings;by:string;at:number;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Prior values are usable only with a unique matching sealed audit receipt. */
export function studioSettingsHistory(s:BotState,now:number):StudioSettingsHistory[]{
 const rows:StudioSettingsHistory[]=[];
 for(const c of s.callbacks){
  if(!c.ref.startsWith(PREFIX)||!/^[-A-Za-z0-9_]{24}$/u.test(c.ref.slice(PREFIX.length))||s.callbacks.filter(x=>x.ref===c.ref).length!==1||
   c.chatId!=='private'||!c.actorId||c.policyVersion!==0||c.oneShot!==true||c.used!==true||c.revoked!==false||c.expiresAt!==MAX_TIME||!c.action.startsWith(ACTION))continue;
  const audits=s.audit.filter(a=>a.updateKey===c.ref);if(audits.length!==1)continue;const audit=audits[0]!;
  if(audit.actorId!==c.actorId||audit.decision!=='ALLOW'||audit.policyVersion!==0||audit.reason!=='STUDIO_SETTINGS_SNAPSHOT_'+hash(c.action)||!Number.isSafeInteger(audit.at)||audit.at<0||audit.at>now)continue;
  try{const pair:unknown=JSON.parse(c.action.slice(ACTION.length));if(!Array.isArray(pair)||pair.length!==2||!validStudioSettings(pair[0])||!validStudioSettings(pair[1])||pair[1].revision!==pair[0].revision+1)continue;
   rows.push({nonce:c.ref.slice(PREFIX.length),before:pair[0],after:pair[1],by:c.actorId,at:audit.at});
  }catch{continue;}
 }
 return rows.filter(r=>rows.filter(x=>x.after.revision===r.after.revision).length===1).sort((a,b)=>b.after.revision-a.after.revision);
}
export function recordStudioSettingsChange(s:BotState,actor:string,now:number,before:StudioSettings,after:StudioSettings,restored=false):void{
 const ref=PREFIX+randomBytes(18).toString('base64url'),action=ACTION+JSON.stringify([before,after]);
 s.callbacks.push({ref,action,chatId:'private',actorId:actor,policyVersion:0,expiresAt:MAX_TIME,oneShot:true,used:true,revoked:false});
 s.audit.push({actorId:actor,updateKey:ref,decision:'ALLOW',reason:'STUDIO_SETTINGS_SNAPSHOT_'+hash(action),policyVersion:0,at:now},
  {actorId:actor,updateKey:'studio-settings:'+after.revision,decision:'ALLOW',reason:restored?'STUDIO_SETTINGS_RESTORED':'STUDIO_SETTINGS_CHANGED',policyVersion:0,at:now});
}
export function studioSettingsRestoreProof(s:BotState,current:StudioSettings,source:StudioSettingsHistory):string{
 return hash(JSON.stringify([current,source,s.buttonStudio?.templates??[]]));
}
