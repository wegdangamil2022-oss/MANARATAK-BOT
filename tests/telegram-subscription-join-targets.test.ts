import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramBotApiMembershipGateway} from '../src/telegram-membership.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
test('join targets come only from the approved chat API record and never create or guess invitations',async()=>{
 let record:Record<string,unknown>={id:-200,type:'channel',username:'RequiredChannel'},admin=true;const methods:string[]=[];
 const request=(async(url:unknown)=>{const method=String(url).split('/').at(-1)!;methods.push(method);assert.ok(['getChat','getChatMember'].includes(method));return Response.json({ok:true,result:method==='getChatMember'?{status:admin?'administrator':'member',user:{id:123456789,is_bot:true}}:record});}) as typeof fetch;
 const gateway=new TelegramBotApiMembershipGateway(TOKEN,request);assert.equal(await gateway.joinURL('-200'),'https://t.me/RequiredChannel');
 record={id:-200,type:'channel',invite_link:'https://t.me/+abcdefghijklmno'};assert.equal(await gateway.joinURL('-200'),'https://t.me/+abcdefghijklmno');
 for(const bad of [{id:-201,type:'channel',username:'WrongChannel'},{id:-200,type:'private',username:'WrongChannel'},{id:-200,type:'channel',invite_link:'https://evil.example/+abcdefghijklmno'},{id:-200,type:'channel',invite_link:'https://t.me/+…masked'},{id:-200,type:'channel',username:'bad/name'}]){record=bad;assert.equal(await gateway.joinURL('-200'),null);}
 admin=false;const before=methods.filter(m=>m==='getChat').length;assert.equal(await gateway.joinURL('-200'),null);assert.equal(methods.filter(m=>m==='getChat').length,before);
});
