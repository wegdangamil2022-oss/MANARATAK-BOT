import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { EducationAdminFacade } from '../src/education-admin.js';
import { ApprovedAnswerService, ResourceLinkService } from '../src/education-interactions.js';
import { TelegramUpdateApplication, type TelegramDocumentPort } from '../src/telegram-transport.js';

const GROUP = '-100123', OWNER = '100', UPLOADER = '200', OUTSIDER = '300';
const bytes = new TextEncoder().encode('title,university,cycle\nScholarship One,South University,2027');
const documentMessage = (id: number, actor: number, chat = actor, caption = `/upload ${GROUP}`, overrides: Record<string,unknown> = {}) => ({
  update_id: id,
  message: {
    chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' },
    from: { id: actor, is_bot: false },
    caption,
    document: { file_id: 'AAEvalidTelegramFileID000000', file_name: 'offers.csv', file_size: bytes.length, mime_type: 'text/csv', ...overrides },
  },
});
async function setup(port?: TelegramDocumentPort) {
  const dir = await mkdtemp(join(tmpdir(), 'manaratak-document-'));
  const file = join(dir, 'state.json'); const store = new BotStore(file);
  const policy = new Policy(store,OWNER), education = new EducationService(store,policy);
  const admin = new EducationAdminFacade(store,policy,education);
  const faq = new ApprovedAnswerService(store,policy), links = new ResourceLinkService(store,policy);
  await policy.approveChat(OWNER,GROUP,['navigation']);
  await policy.grant(OWNER,UPLOADER,'content.upload',GROUP,Date.now()+60_000);
  const app = new TelegramUpdateApplication({store,policy,education,admin,faq,links,botId:'bot-1',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED', ...(port ? {documentDownload:port} : {})});
  return {dir,file,store,policy,education,admin,faq,links,app,close:()=>rm(dir,{recursive:true,force:true})};
}
const fake = (data: Uint8Array = bytes) => {
  let calls = 0;
  const port:TelegramDocumentPort = { async download(fileId,maxBytes){
    calls++;
    assert.equal(fileId,'AAEvalidTelegramFileID000000');
    assert.equal(maxBytes,256*1024);
    return data;
  } };
  return {port, get calls(){return calls;}};
};

test('B3 document uploaded in verified Telegram private chat stays under review, never public',async()=>{
  const gateway=fake();const c=await setup(gateway.port);
  try {
    const result=await c.app.handle(documentMessage(400,Number(UPLOADER)));
    assert.equal(result.status,'APPLIED');assert.match(result.plan?.text??'',/يتطلب المراجعة/);
    assert.equal(gateway.calls,1);
    const s=await c.store.snapshot();assert.equal(s.importRuns.length,1);
    assert.equal(s.importRuns[0]?.origin,'TELEGRAM_ADMIN');assert.equal(s.importRuns[0]?.report.opportunities,1);
    assert.equal(s.educationResources.length,0);
    assert.equal(JSON.stringify(s).includes('title,university,cycle'),false);
  } finally {await c.close();}
});

test('B3 document has no download if uploader is not allowed or the chat is a group',async()=>{
  const gateway=fake();const c=await setup(gateway.port);
  try {
    const unauthorized=await c.app.handle(documentMessage(401,Number(OUTSIDER)));
    assert.equal(unauthorized.status,'DENIED');assert.equal(gateway.calls,0);
    const group=await c.app.handle(documentMessage(402,Number(UPLOADER),Number(GROUP)));
    assert.equal(group.status,'DENIED');assert.equal(gateway.calls,0);
    await c.policy.revokeChat(OWNER,GROUP);
    const revoked=await c.app.handle(documentMessage(403,Number(UPLOADER)));
    assert.equal(revoked.status,'DENIED');assert.equal(gateway.calls,0);
  } finally {await c.close();}
});

test('B3 document requires explicit scope selection and existing transport port',async()=>{
  const gateway=fake();const c=await setup(gateway.port);
  try {
    const bad=await c.app.handle(documentMessage(410,Number(UPLOADER),Number(UPLOADER),'please download'));
    assert.equal(bad.status,'DENIED');assert.equal(gateway.calls,0);
    const missing=await c.app.handle({ ...documentMessage(411,Number(UPLOADER)), message:{...documentMessage(411,Number(UPLOADER)).message, document:{ file_id:'AAEvalidTelegramFileID000000',file_name:'offers.csv',file_size:bytes.length,mime_type:'text/csv' } } });
    assert.equal(missing.status,'APPLIED');
    const noPort=await setup(); try {
      assert.equal((await noPort.app.handle(documentMessage(412,Number(UPLOADER)))).status,'DENIED');
    } finally {await noPort.close();}
  } finally {await c.close();}
});

test('B3 filename, MIME, file ID and size are validated before download',async()=>{
  const gateway=fake();const c=await setup(gateway.port);
  try {
    const entries=[
      {file_name:'bad.exe'}, {file_name:'../offers.csv'}, {file_name:'photo.csv',mime_type:'image/jpeg'},
      {file_name:'offers.csv',file_size:262145}, {file_name:'offers.csv',file_size:0},
      {file_id:'https://evil.invalid/my.csv'}, {file_id:'../../secret'}, {file_name:'x\u202Ecsv.txt'},
    ];
    for(const [i, overrides] of entries.entries()){
      const result=await c.app.handle(documentMessage(420+i,Number(UPLOADER),Number(UPLOADER),`/upload ${GROUP}`,overrides));
      assert.equal(result.status,'DENIED',`bad metadata ${i}`);
    }
    assert.equal(gateway.calls,0);
  } finally {await c.close();}
});

test('B3 rejects bytes inconsistent with Telegram size claim and binary or invalid UTF-8',async()=>{
  for(const bad of [new Uint8Array(bytes.length-1),new Uint8Array(bytes.length+1), new Uint8Array([...bytes].map((v,i)=>i===3?0:v)), new Uint8Array([...bytes].map((v,i)=>i===3?0xff:v))]){
    const g=fake(bad),c=await setup(g.port);
    try {
      const r=await c.app.handle(documentMessage(440,Number(UPLOADER)));
      assert.equal(r.status,'DENIED');assert.equal((await c.store.snapshot()).importRuns.length,0);
    } finally {await c.close();}
  }
});

test('B3 rechecks upload authorization after download and rejects revoked grants',async()=>{
  const c=await setup();
  try {
    const port:TelegramDocumentPort={ async download(){await c.policy.revokeGrant(OWNER,UPLOADER,'content.upload',GROUP);return bytes;} };
    const app=new TelegramUpdateApplication({store:c.store,policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',documentDownload:port});
    const r=await app.handle(documentMessage(450,Number(UPLOADER)));
    assert.equal(r.status,'DENIED');assert.equal((await c.store.snapshot()).importRuns.length,0);
  } finally {await c.close();}
});

test('B3 duplicate Telegram document never downloaded twice, including after restart',async()=>{
  const g=fake(),c=await setup(g.port);
  try {
    const msg=documentMessage(460,Number(UPLOADER));
    assert.equal((await c.app.handle(msg)).status,'APPLIED');
    assert.equal((await c.app.handle(msg)).status,'DUPLICATE');
    const after=new TelegramUpdateApplication({store:new BotStore(c.file),policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',documentDownload:g.port});
    assert.equal((await after.handle(msg)).status,'DUPLICATE');
    assert.equal(g.calls,1);
  } finally {await c.close();}
});

test('B3 poisoned forwards, sender_chat and forged private scope cannot trigger download',async()=>{
  const g=fake(),c=await setup(g.port);
  try {
    for(const [i,field] of [{forward_origin:{type:'user'}},{sender_chat:{id:-1234}},{via_bot:{id:123}}].entries()){
      const v=documentMessage(470+i,Number(UPLOADER));
      assert.equal((await c.app.handle({...v,message:{...v.message,...field}})).status,'DENIED');
    }
    assert.equal((await c.app.handle(documentMessage(474,Number(UPLOADER),Number(UPLOADER),`/upload -900999`))).status,'DENIED');
    assert.equal(g.calls,0);
  } finally {await c.close();}
});

test('B3 document gateway errors do not leak user-controlled messages',async()=>{
  const c=await setup({async download(){throw new Error('PRIVATE_BOT_TOKEN_LEAK');}});
  try {
    const r=await c.app.handle(documentMessage(480,Number(UPLOADER)));
    assert.equal(r.status,'DENIED');assert.equal(JSON.stringify(r).includes('PRIVATE_BOT_TOKEN_LEAK'),false);
  } finally {await c.close();}
});

test('B3 document formats MD, TXT and JSON import as candidate records, not as official publications',async()=>{
  const cases:[string,string,string][]= [
    ['records.md','text/markdown','# Sample Scholarship\nuniversity: Mountain University'],
    ['records.txt','text/plain','title: Sample Scholarship\nuniversity: Mountain University'],
    ['records.json','application/json','[{"title":"Sample Scholarship","university":"Mountain University"}]'],
  ];
  for(const [filename,mime,data] of cases){
    const body=new TextEncoder().encode(data),g=fake(body),c=await setup(g.port);
    try {
      const msg=documentMessage(490,Number(UPLOADER),Number(UPLOADER),`/upload ${GROUP}`,{file_name:filename,file_size:body.length,mime_type:mime});
      const response=await c.app.handle(msg);
      assert.equal(response.status,'APPLIED',filename);
      assert.equal((await c.store.snapshot()).importRuns[0]?.report.opportunities,1);
      assert.equal((await c.store.snapshot()).educationResources.length,0);
    }finally{await c.close();}
  }
});

test('B3 signed local webhook forwards document to gated handler, but never sends Telegram replies',async()=>{
  const {createServer}=await import('node:http');
  const {once}=await import('node:events');
  const {telegramWebhookListener}=await import('../src/telegram-transport.js');
  const g=fake(),c=await setup(g.port);
  const webhookSecret='FAKE_LOCAL_WEBHOOK_ONLY_1234567890';
  const server=createServer(telegramWebhookListener(c.app,webhookSecret));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const addr=server.address();if(!addr||typeof addr==='string')throw Error('missing local port');
    const resp=await fetch(`http://127.0.0.1:${addr.port}/telegram/webhook`,{
      method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':webhookSecret},
      body:JSON.stringify(documentMessage(495,Number(UPLOADER))),
    });
    assert.deepEqual(await resp.json(),{ok:true,status:'APPLIED'});
    assert.equal(g.calls,1);
    assert.equal((await c.store.snapshot()).importRuns.length,1);
  } finally {server.close();await once(server,'close');await c.close();}
});
