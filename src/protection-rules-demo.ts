import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {GroupProtectionPolicyService} from './group-protection-policy.js';
import type {ProtectionPolicy} from './protection-rules.js';
async function main():Promise<void>{
 const directory=await mkdtemp(join(tmpdir(),'manaratak-rules-demo-'));
 try{
  const store=new BotStore(join(directory,'state.sqlite'),{engine:'sqlite'}),policy=new Policy(store,'100',()=>1000);
  await policy.approveChat('100','-100',['moderation']);
  const service=new GroupProtectionPolicyService(store,policy,()=>1000);
  const config:ProtectionPolicy={chatId:'-100',revision:1,mode:'MONITOR',rules:[
   {id:'word',kind:'WORD',value:'إعلان',action:'WARN',enabled:true},
   {id:'external-link',kind:'LINK',hosts:'*',action:'DELETE',enabled:true}
  ],allowedDomains:['school.edu'],allowedPhrases:[],exemptMemberIds:[]};
  const epoch=policy.chatRevision(await store.snapshot(),'-100');
  assert.equal((await service.save('100',config,epoch,0)).status,'SAVED');
  const result=await service.preview('100','-100',{chatId:'-100',memberId:'300',type:'TEXT',text:'إِعْــلان https://external.test/'});
  assert.equal(result.status,'EVALUATED');
  if(result.status!=='EVALUATED')throw Error('PREVIEW_NOT_EVALUATED');
  assert.equal(result.result.proposedAction,'DELETE');assert.equal(result.result.authorizedToSend,false);
  assert.equal((await service.save('100',{...config,revision:2,mode:'ENFORCE'},epoch,1)).status,'ENFORCEMENT_NOT_CONNECTED');
  console.log(JSON.stringify({offlineOnly:true,mode:'MONITOR',rulesPersisted:true,
   matchedRuleIds:result.result.matchedRuleIds,proposedAction:result.result.proposedAction,
   authorizedToSend:false,unconnectedEnforcementBlocked:true},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
}
void main().catch(()=>{console.error('OFFLINE_PROTECTION_RULES_DEMO_FAILED');process.exitCode=1;});
