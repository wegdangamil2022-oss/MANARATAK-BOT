import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramBotApiDocumentDownloader} from '../src/telegram-document-download.js';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {BotStore} from '../src/store.js';
import {createLiveTelegramServer,loadLiveTelegramConfig,stopLiveTelegramServer} from '../src/telegram-live-server.js';
const TOKEN='123456:'+ 'a'.repeat(35),ID='TelegramFile123',PATH='documents/file_123.json';
const metadata=(extra:Record<string,unknown>={})=>Response.json({ok:true,result:{file_id:ID,file_size:3,file_path:PATH,...extra}});
test('document adapter defaults to STOP and rejects invalid inputs before any request',async()=>{
 let calls=0;const request=(async()=>{calls++;return metadata();}) as typeof fetch;
 await assert.rejects(new TelegramBotApiDocumentDownloader(TOKEN,request).download(ID,100),/TELEGRAM_DOCUMENT_UNAVAILABLE/);
 const port=new TelegramBotApiDocumentDownloader(TOKEN,request,async()=>true);for(const [id,max] of [['short',100],[ID,0],[ID,262145]] as const)await assert.rejects(port.download(id,max));assert.equal(calls,0);
});
test('document adapter uses only official endpoints with bounded body and no redirects',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];
 const request=(async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),init});return calls.length===1?metadata():new Response('abc');}) as typeof fetch;
 const bytes=await new TelegramBotApiDocumentDownloader(TOKEN,request,async()=>true).download(ID,100);assert.equal(new TextDecoder().decode(bytes),'abc');
 assert.equal(calls[0]!.url,'https://api.telegram.org/bot'+TOKEN+'/getFile');assert.deepEqual(JSON.parse(calls[0]!.init.body as string),{file_id:ID});assert.equal(calls[1]!.url,'https://api.telegram.org/file/bot'+TOKEN+'/'+PATH);assert.equal(calls[1]!.init.method,'GET');assert.ok(calls.every(c=>c.init.redirect==='error'&&c.init.signal instanceof AbortSignal));
});
test('document metadata rejects mismatched IDs, unsafe paths, absent or excessive sizes without downloading',async()=>{
 for(const extra of [{file_id:'other'},{file_size:undefined},{file_size:101},{file_path:'https://evil.invalid/x'},{file_path:'../x'},{file_path:'/x'},{file_path:'documents/%2e%2e/x'},{file_path:'documents/file?secret'},{file_path:'documents\\file'}]){
  let calls=0;const request=(async()=>{calls++;return metadata(extra);}) as typeof fetch;await assert.rejects(new TelegramBotApiDocumentDownloader(TOKEN,request,async()=>true).download(ID,100));assert.equal(calls,1);
 }
 for(const response of [new Response('x'.repeat(17000)),new Response('{invalid'),Response.json({ok:false,description:TOKEN}),Response.json({ok:true,result:null})]){
  let calls=0;const request=(async()=>{calls++;return response;}) as typeof fetch;await assert.rejects(new TelegramBotApiDocumentDownloader(TOKEN,request,async()=>true).download(ID,100),{message:'TELEGRAM_DOCUMENT_UNAVAILABLE'});assert.equal(calls,1);
 }
});
test('document downloader bounds streaming bytes and masks all provider errors and safety changes',async()=>{
 for(const response of [new Response('ab'),new Response('abcd'),new Response('abc',{status:302}),new Response('abc',{headers:{'content-length':'1000'}}),new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(200));c.close();}}))]){
  let calls=0;const request=(async()=>++calls===1?metadata():response) as typeof fetch;await assert.rejects(new TelegramBotApiDocumentDownloader(TOKEN,request,async()=>true).download(ID,100),{message:'TELEGRAM_DOCUMENT_UNAVAILABLE'});
 }
 let calls=0,checks=0;const request=(async()=>{calls++;return metadata();}) as typeof fetch;await assert.rejects(new TelegramBotApiDocumentDownloader(TOKEN,request,async()=>++checks===1).download(ID,100));assert.equal(calls,1);
 await assert.rejects(new TelegramBotApiDocumentDownloader(TOKEN,(async()=>{throw Error(TOKEN);}) as typeof fetch,async()=>true).download(ID,100),{message:'TELEGRAM_DOCUMENT_UNAVAILABLE'});
 calls=0;checks=0;const stoppedAfterRead=(async()=>++calls===1?metadata():new Response('abc')) as typeof fetch;await assert.rejects(new TelegramBotApiDocumentDownloader(TOKEN,stoppedAfterRead,async()=>++checks<3).download(ID,100));assert.equal(calls,2);
});
for(const stopDuring of [false,true])test('runtime document adapter is wired through authenticated local HTTP; stop during metadata='+stopDuring,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'telegram-document-runtime-')),stateFile=join(dir,'state.sqlite'),safetyFile=join(dir,'safety.flag'),secret='abcdefghijklmnopqrstuvwx_123456789ABCDE';
 let server:Awaited<ReturnType<typeof createLiveTelegramServer>>|undefined;
 try{
  const store=new BotStore(stateFile,{engine:'sqlite'});await store.transaction(s=>{s.privateFeatures['content.upload']=true;});await chmod(stateFile,0o600);await writeFile(safetyFile,'RUN\n',{mode:0o600});
  const bytes=new TextEncoder().encode(JSON.stringify([{title:'منحة جديدة',university:'جامعة',cycle:'2026',degree:'بكالوريوس'}]));let downloaded=0,metadataCalls=0;
  const request=(async(url:unknown,init:RequestInit)=>{
   if(String(url).endsWith('/getFile')){metadataCalls++;if(stopDuring)await writeFile(safetyFile,'STOP\n');return metadata({file_size:bytes.length});}
   if(String(url)==='https://api.telegram.org/file/bot'+TOKEN+'/'+PATH){downloaded++;return new Response(bytes);}
   assert.ok(String(url).endsWith('/sendMessage'));const body=JSON.parse(String(init.body));return Response.json({ok:true,result:{message_id:99,chat:{id:Number(body.chat_id)}}});
  }) as typeof fetch;
  server=await createLiveTelegramServer(loadLiveTelegramConfig({BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',BOT_OWNER_ID:'100',BOT_ID:'documents-test',BOT_USERNAME:'ManaratakBot',BOT_STATE_FILE:stateFile,TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_WEBHOOK_SECRET:secret,TELEGRAM_LISTEN_PORT:'8787',TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',TELEGRAM_SAFETY_FILE:safetyFile}),request);
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const response=await fetch('http://127.0.0.1:'+address.port+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify({update_id:1,message:{message_id:1,from:{id:100,is_bot:false},chat:{id:100,type:'private'},caption:'/upload private',document:{file_id:ID,file_name:'new.json',file_size:bytes.length,mime_type:'application/json'}}})});
  assert.equal(response.status,200);assert.equal(metadataCalls,1);assert.equal(downloaded,stopDuring?0:1);assert.equal((await store.snapshot()).importRuns.length,stopDuring?0:1);assert.equal((await store.snapshot()).educationResources.length,0);
 }finally{if(server?.listening)await stopLiveTelegramServer(server);await rm(dir,{recursive:true,force:true});}
});
