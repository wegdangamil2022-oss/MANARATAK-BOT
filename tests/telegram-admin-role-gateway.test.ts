import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramAdminRoleGateway,ADMIN_ROLE_FLAGS} from '../src/telegram-admin-role-gateway.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',GROUP='-100123',USER='301';
function fixture(){
 let allowed=true,authority=true,editable=true,rights=true,extra=false,drift=false,throws=false,mutations=0,member:Record<string,unknown>={status:'member',user:{id:301,is_bot:false}},last:Record<string,unknown>={};
 const request=(async(url:unknown,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1),body=JSON.parse(String(init?.body));
  let result:unknown;
  if(method==='getChat')result={id:Number(GROUP),type:'supergroup'};
  else if(method==='getChatMember')result=body.user_id===123456789?{status:'administrator',user:{id:123456789,is_bot:true},can_manage_chat:true,can_promote_members:rights,can_delete_messages:rights,can_restrict_members:rights}:member;
  else {assert.equal(method,'promoteChatMember');mutations++;last=body;if(throws)throw Error('timeout');member=body.can_manage_chat?{...body,status:'administrator',user:{id:301,is_bot:false},can_be_edited:editable,...(extra?{can_manage_chat:true,can_promote_members:true}:{})}:{status:'member',user:{id:301,is_bot:false}};result=true;if(drift)member={status:'left',user:{id:301,is_bot:false}};}
  return new Response(JSON.stringify({ok:true,result}),{headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 const gateway=new TelegramAdminRoleGateway(TOKEN,request,async()=>allowed),guard=async()=>authority;
 return {gateway,guard,stop:()=>{allowed=false;},revoke:()=>{authority=false;},noRights:()=>{rights=false;},target:(value:Record<string,unknown>)=>{member=value;},extra:()=>{extra=true;},drift:()=>{drift=true;},timeout:()=>{throws=true;},mutations:()=>mutations,last:()=>last};
}
test('reviewed promotion sends only the selected right and confirms exact readback',async()=>{
 const f=fixture(),plan=await f.gateway.prepare(GROUP,USER,'DELETE',f.guard);assert.ok(plan);assert.equal(f.mutations(),0);
 assert.equal(await f.gateway.execute(plan,f.guard),'CONFIRMED');assert.equal(f.mutations(),1);
 for(const flag of ADMIN_ROLE_FLAGS)assert.equal(f.last()[flag],flag==='can_manage_chat'||flag==='can_delete_messages');
 assert.equal(await f.gateway.execute(plan,f.guard),'DENIED');assert.equal(f.mutations(),1);
});
test('STOP, authority revocation and changed remote baseline prevent dispatch',async()=>{
 for(const change of ['stop','revoke','noRights','target'] as const){const f=fixture(),plan=await f.gateway.prepare(GROUP,USER,'RESTRICT',f.guard);assert.ok(plan);if(change==='target')f.target({status:'creator',user:{id:301,is_bot:false}});else f[change]();assert.equal(await f.gateway.execute(plan,f.guard),'DENIED');assert.equal(f.mutations(),0);}
});
test('editable administrator demotion sends false for every flag',async()=>{
 const f=fixture();f.target({status:'administrator',user:{id:301,is_bot:false},can_be_edited:true,can_delete_messages:true});const plan=await f.gateway.prepare(GROUP,USER,'DEMOTE',f.guard);assert.ok(plan);assert.equal(await f.gateway.execute(plan,f.guard),'CONFIRMED');for(const flag of ADMIN_ROLE_FLAGS)assert.equal(f.last()[flag],false);
});
test('protected identities, missing bot rights and fabricated plans cannot mutate',async()=>{
 const f=fixture();for(const status of ['creator','restricted','left','kicked']){f.target({status,user:{id:301,is_bot:false}});assert.equal(await f.gateway.prepare(GROUP,USER,'DELETE',f.guard),null);}
 f.target({status:'administrator',user:{id:301,is_bot:false},can_be_edited:false});assert.equal(await f.gateway.prepare(GROUP,USER,'DEMOTE',f.guard),null);
 assert.equal(await f.gateway.prepare(GROUP,'123456789','DELETE',f.guard),null);f.noRights();assert.equal(await f.gateway.prepare(GROUP,USER,'DEMOTE',f.guard),null);
 assert.equal(await f.gateway.execute({} as never,f.guard),'DENIED');assert.equal(f.mutations(),0);
});
test('timeout, unexpected added privilege and readback mismatch remain unresolved without retry',async()=>{
 for(const change of ['timeout','extra','drift'] as const){const f=fixture(),plan=await f.gateway.prepare(GROUP,USER,'DELETE',f.guard);assert.ok(plan);f[change]();assert.equal(await f.gateway.execute(plan,f.guard),'UNKNOWN_OUTCOME');assert.equal(await f.gateway.execute(plan,f.guard),'DENIED');assert.equal(f.mutations(),1);}
});
test('current-role inspection is read-only and rejects malformed identities and stopped reads',async()=>{
 const f=fixture();assert.deepEqual((await f.gateway.observe(GROUP,USER,f.guard))?.status,'member');for(const member of [{status:'member',user:{id:302,is_bot:false}},{status:'creator',user:{id:301,is_bot:true}},{status:'not-a-role',user:{id:301,is_bot:false}},{status:'administrator',user:{id:301,is_bot:false},can_delete_messages:'yes'}]){f.target(member);assert.equal(await f.gateway.observe(GROUP,USER,f.guard),null);}f.stop();assert.equal(await f.gateway.observe(GROUP,USER,f.guard),null);assert.equal(f.mutations(),0);
});
