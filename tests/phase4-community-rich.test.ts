import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher,TelegramBotApiTextSender,validTelegramReplyJob} from '../src/telegram-replies.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {defaultCommunityConfig,validCommunityConfig} from '../src/phase4-community-model.js';
import {validCommunityPhotoId,validCommunityLinkButton,validCommunityLinkKeyboard} from '../src/phase4-community-rich.js';
import {phase4CommunityScreen,parsePhase4CommunityCommand} from '../src/phase4-community-ui.js';

const CHAT='-10012121212',OWNER='100',MEMBER='301';
const PHOTO='AgACAgQAAxkBAAICDmiRQ9Yae3456_CTl0v8k90P1zHx'; 
async function setup(engine:'json'|'sqlite'){
 const folder=await mkdtemp(join(tmpdir(),'p4-rich-')),file=join(folder,engine==='json'?'bot.json':'bot.sqlite');
 let now=1_800_010_000_000;
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,CHAT,['navigation']);await policy.setPresence(CHAT,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy,clock);
 const app=new TelegramUpdateApplication({store,policy,community,education,
  admin:new EducationAdminFacade(store,policy,education),faq:new ApprovedAnswerService(store,policy),
  links:new ResourceLinkService(store,policy),botId:'bot-main',botUsername:'ManaratakBot',
  membership:async()=> 'VERIFIED',clock});
 const approve=async(req:Parameters<typeof community.pending>[1])=>{
  const draft=await community.pending(OWNER,req,CHAT);return community.approve(OWNER,draft.id);
 };
 const joinUpdate=(id:number,memberId:number=301)=>({update_id:id,message:{message_id:id,
  chat:{id:Number(CHAT),type:'supergroup',title:'منارتك للمنح'},
  from:{id:memberId,is_bot:false,first_name:'طالب'},
  new_chat_members:[{id:memberId,is_bot:false,first_name:'طالب'}]}});
 const ownerMessage=(id:number,text:string)=>({update_id:id,message:{message_id:id,
  chat:{id:Number(OWNER),type:'private'},from:{id:Number(OWNER),is_bot:false,first_name:'المالك'},text}});
 return {folder,file,store,community,policy,app,approve,joinUpdate,ownerMessage,clock,
  move:(ms:number)=>{now+=ms;},close:()=>rm(folder,{recursive:true,force:true})};
}
test('P4 rich: photo identifiers and outbound URL buttons reject secrets, exfiltration and callback injection',()=>{
 assert.equal(validCommunityPhotoId(PHOTO),true);
 for(const wrong of ['http://example.com/x','../etc/passwd','a','AgAC AgAC','\u0000'+PHOTO])
  assert.equal(validCommunityPhotoId(wrong),false,wrong);
 assert.equal(validCommunityLinkButton({text:'📚 دليل المنح',url:'https://t.me/StudyinEurope3'}),true);
 for(const url of ['http://t.me/channel','https://t.me.evil.net/StudyinEurope3',
  'https://user:pass@example.com/x','https://example.com/x#secret',
  'https://127.0.0.1/private','https://example.com/x?token=private','javascript:alert(1)'])
  assert.equal(validCommunityLinkButton({text:'الرابط',url}),false,url);
 assert.equal(validCommunityLinkKeyboard({inline_keyboard:[[{
  text:'📚 دليل المنح',url:'https://t.me/StudyinEurope3'}]]}),true);
 assert.equal(validCommunityLinkKeyboard({inline_keyboard:[[{
  text:'📚 دليل المنح',url:'https://t.me/StudyinEurope3',callback_data:'mi:1:h'}]]}),false);
 assert.equal(validCommunityConfig({...defaultCommunityConfig(CHAT),welcome:{
  enabled:false,text:'أهلًا',photoFileId:'http://evil.test'}}),false);
});
test('P4 rich: owner commands parse photo/buttons without executing callbacks',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/welcomephoto '+CHAT+' '+PHOTO),
  {kind:'EDIT',chatId:CHAT,request:{kind:'WELCOME_PHOTO_SET',photoFileId:PHOTO}});
 assert.deepEqual(parsePhase4CommunityCommand('/clearwelcomephoto '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'WELCOME_PHOTO_CLEAR'}});
 assert.deepEqual(parsePhase4CommunityCommand('/welcomebutton '+CHAT+' دليل القوانين | https://t.me/StudyinEurope3'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'WELCOME_BUTTON_ADD',
   buttonText:'دليل القوانين',buttonUrl:'https://t.me/StudyinEurope3'}});
 assert.deepEqual(parsePhase4CommunityCommand('/clearwelcomebuttons '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'WELCOME_BUTTONS_CLEAR'}});
 assert.equal(parsePhase4CommunityCommand('/welcomebutton '+CHAT+' هدية | javascript:alert(1)'),null);
});
for(const engine of ['json','sqlite'] as const){
 test('P4 rich '+engine+': owner reviews photo/URL buttons, protects drafts and persists across reloads',async()=>{
  const f=await setup(engine);
  try{
   await assert.rejects(f.community.pending(MEMBER,{kind:'WELCOME_PHOTO_SET',photoFileId:PHOTO},CHAT));
   const draft=await f.community.pending(OWNER,{kind:'WELCOME_PHOTO_SET',photoFileId:PHOTO},CHAT);
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.photoFileId,undefined);
   await f.community.approve(OWNER,draft.id);
   await f.approve({kind:'WELCOME_BUTTON_ADD',buttonText:'📚 المنح',
    buttonUrl:'https://t.me/StudyinEurope3'});
   const config=await f.community.view(OWNER,CHAT);
   assert.equal(config.welcome.photoFileId,PHOTO);
   assert.deepEqual(config.welcome.buttons,[{text:'📚 المنح',url:'https://t.me/StudyinEurope3'}]);
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.configs[0]?.welcome.photoFileId,PHOTO);
   await assert.rejects(f.approve({kind:'WELCOME_BUTTON_ADD',
    buttonText:'📚 المنح',buttonUrl:'https://t.me/StudyinEurope3'}),/COMMUNITY_BUTTON_DUPLICATE/);
   await assert.rejects(f.approve({kind:'WELCOME_BUTTON_ADD',
    buttonText:'منح ثانية',buttonUrl:'https://t.me/StudyinEurope3'}),/COMMUNITY_BUTTON_DUPLICATE/);
  }finally{await f.close();}
 });
 test('P4 rich '+engine+': photo and reviewed URL buttons are queued and blocked if configuration changes',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'WELCOME_PHOTO_SET',photoFileId:PHOTO});
   await f.approve({kind:'WELCOME_BUTTON_ADD',buttonText:'القوانين',buttonUrl:'https://t.me/StudyinEurope3'});
   await f.approve({kind:'WELCOME_ON'});
   const joined=await f.app.handle(f.joinUpdate(710));
   assert.equal(joined.status,'APPLIED');assert.ok(joined.deliveryKey);
   assert.equal(joined.plan?.photoFileId,PHOTO);
   assert.deepEqual(joined.plan?.communityLinks?.inline_keyboard,
    [[{text:'القوانين',url:'https://t.me/StudyinEurope3'}]]);
   const job=(await f.store.snapshot()).telegramReplyJobs?.find(x=>x.updateKey===joined.deliveryKey);
   assert.ok(job&&validTelegramReplyJob(job));
   const gone=await f.approve({kind:'WELCOME_PHOTO_CLEAR'});
   assert.equal(gone.welcome.photoFileId,undefined);
   let invoked=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,
    {send:async()=>{invoked++;return {status:'CONFIRMED' as const,messageId:55};}},f.clock);
   assert.equal((await dispatcher.dispatch(joined.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(invoked,0);
   f.move(9000);
   const next=await f.app.handle(f.joinUpdate(711,302));
   assert.equal(next.status,'APPLIED');assert.equal(next.plan?.photoFileId,undefined);
   assert.ok(next.plan?.communityLinks);
  }finally{await f.close();}
 });
 test('P4 rich '+engine+': queued photo plans respect Telegram 1024-byte caption limit',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'WELCOME_TEXT',text:'😄'.repeat(255)+' {العضو}'});
   await f.approve({kind:'WELCOME_PHOTO_SET',photoFileId:PHOTO});
   await f.approve({kind:'WELCOME_ON'});
   const outcome=await f.app.handle(f.joinUpdate(722));
   assert.equal(outcome.plan,undefined);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.some(j=>j.updateKey==='b3-webhook:bot-main:722'),false);
  }finally{await f.close();}
 });
 test('P4 rich '+engine+': owner private preview is not approval and removed buttons do not leak',async()=>{
  const f=await setup(engine);
  try{
   const preview=await f.app.handle(f.ownerMessage(1000,
    '/welcomebutton '+CHAT+' دليل القوانين | https://t.me/StudyinEurope3'));
   assert.equal(preview.status,'APPLIED');assert.match(preview.plan?.text??'',/دليل القوانين/);
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.buttons,undefined);
   const code=preview.plan?.inlineMarkup?.inline_keyboard.flat()
    .find(b=>b.callback_data.startsWith('p4c:1:c:'))?.callback_data;
   assert.ok(code);
   await f.community.approve(OWNER,code!.slice('p4c:1:c:'.length));
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.buttons?.length,1);
   await f.approve({kind:'WELCOME_BUTTONS_CLEAR'});
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.buttons,undefined);
  }finally{await f.close();}
 });
}
test('P4 rich sender: sendPhoto is an opt-in one-shot payload, never an HTTP photo download',async()=>{
 const calls:{url:string;body:Record<string,unknown>}[]=[];
 const fetcher=async(url:string|URL|Request,init?:RequestInit):Promise<Response>=>{
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  calls.push({url:String(url),body});
  return new Response(JSON.stringify({ok:true,result:{message_id:55,chat:{id:Number(CHAT)}}}),
   {status:200,headers:{'content-type':'application/json'}});
 };
 const sender=new TelegramBotApiTextSender('10001:'+('x'.repeat(40)),fetcher as typeof fetch);
 const sent=await sender.send({chatId:CHAT,parseMode:'HTML',text:'مرحبًا',
  photoFileId:PHOTO,communityLinks:{inline_keyboard:[[{text:'القوانين',url:'https://t.me/StudyinEurope3'}]]}});
 assert.equal(sent.status,'CONFIRMED');assert.equal(calls.length,1);
 assert.match(calls[0]!.url,/\/sendPhoto$/u);
 assert.equal(calls[0]!.body.photo,PHOTO);
 assert.equal(calls[0]!.body.caption,'مرحبًا');
 assert.equal(calls[0]!.body.text,undefined);
 assert.deepEqual(calls[0]!.body.reply_markup,
  {inline_keyboard:[[{text:'القوانين',url:'https://t.me/StudyinEurope3'}]]});
 const invalid=await sender.send({chatId:CHAT,parseMode:'HTML',text:'x',
  photoFileId:'https://evil.test/photo'});
 assert.equal(invalid.status,'FAILED_CONFIRMED');assert.equal(calls.length,1);
});

const ownerPhoto=(id:number,actor:number,caption:string,fileId=PHOTO)=>({
 update_id:id,message:{message_id:id,chat:{id:actor,type:'private'},
  from:{id:actor,is_bot:false,first_name:'صاحب الصورة'},
  caption,photo:[{file_id:fileId,file_unique_id:'UniquePhotoEntryA12',width:320,height:240,file_size:51000},
   {file_id:fileId,file_unique_id:'UniquePhotoEntryB34',width:640,height:480,file_size:80000}]}
});
const ownerPhotoConfirm=(id:number,data:string)=>({
 update_id:id,callback_query:{id:'r'+id,data,from:{id:Number(OWNER),is_bot:false},
  message:{message_id:90,chat:{id:Number(OWNER),type:'private'},from:{id:900,is_bot:true}}}
});
for(const engine of ['json','sqlite'] as const){
 test('P4 rich '+engine+': owner sends an actual Telegram photo with group command caption, previews and confirms without exposing file_id',async()=>{
  const f=await setup(engine);
  try{
   const preview=await f.app.handle(ownerPhoto(1100,Number(OWNER),'/welcomephoto '+CHAT));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/معاينة صورة الترحيب/);
   assert.equal(JSON.stringify(preview.plan).includes(PHOTO),false);
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.photoFileId,undefined);
   const approve=preview.plan?.inlineMarkup?.inline_keyboard.flat()
    .find(b=>b.callback_data.startsWith('p4c:1:c:'))?.callback_data;
   assert.ok(approve);
   const confirmed=await f.app.handle(ownerPhotoConfirm(1101,approve!));
   assert.equal(confirmed.status,'APPLIED');
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.photoFileId,PHOTO);
  }finally{await f.close();}
 });
 test('P4 rich '+engine+': forged, missing-caption or non-owner photo uploads cannot update greeting',async()=>{
  const f=await setup(engine);
  try{
   const notOwner=await f.app.handle(ownerPhoto(1110,501,'/welcomephoto '+CHAT));
   assert.equal(notOwner.status,'DENIED');
   const missing=await f.app.handle(ownerPhoto(1111,Number(OWNER),''));
   assert.notEqual(missing.status,'APPLIED');
   const bad=await f.app.handle(ownerPhoto(1112,Number(OWNER),'/welcomephoto '+CHAT,'BAD_FILE'));
   assert.notEqual(bad.status,'APPLIED');
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.photoFileId,undefined);
  }finally{await f.close();}
 });
}
