import test from "node:test";
import assert from "node:assert/strict";
import { promptBody } from "../lib/prompt-body";
import { readApiResponse } from "../lib/http-response";

test("streamed request preserves image bytes across irregular chunk boundaries and escapes text",async()=>{
 const input=Uint8Array.from({length:100003},(_,i)=>i%251);let offset=0;
 const body=promptBody("test-model",'Instruções "ação"',"Notas\n<notas>",[{label:"Cena",mime:"image/png",open:async()=>new ReadableStream({pull(c){if(offset===input.length)return c.close();const size=1+offset%8191;c.enqueue(input.slice(offset,offset+size));offset=Math.min(input.length,offset+size);}})}]);
 const data=JSON.parse(await new Response(body).text());
 assert.equal(data.instructions,'Instruções "ação"');assert.equal(data.input[0].content[2].text,"Notas\n<notas>");
 assert.deepEqual(Buffer.from(data.input[0].content[1].image_url.split(",")[1],"base64"),Buffer.from(input));
 assert.equal(data.store,false);
});

test("five 15 MB references stream sequentially with bounded output under a 64 MB heap",async()=>{
 let active=0,maxActive=0,opened=0,byteCount=0,maxChunk=0;
 const images=Array.from({length:5},(_,index)=>({label:`Reference ${index}`,mime:"image/jpeg",open:async()=>{opened++;active++;maxActive=Math.max(maxActive,active);let remaining=15_000_000;return new ReadableStream<Uint8Array>({pull(c){if(!remaining){active--;c.close();return;}const size=Math.min(65537,remaining);remaining-=size;c.enqueue(new Uint8Array(size).fill(127));}});}}));
 const reader=promptBody("test-model","instructions","note",images).getReader();assert.equal(opened,0);
 while(true){const {value,done}=await reader.read();if(done)break;byteCount+=value.length;maxChunk=Math.max(maxChunk,value.length);}
 assert.equal(opened,5);assert.equal(maxActive,1);assert.ok(maxChunk<=32768);assert.ok(byteCount>100_000_000&&byteCount<100_002_000);
});

test("aborted request cancels the active source and does not open remaining images",async()=>{
 let cancelled=false,opened=0;
 const entry={label:"test",mime:"image/png",open:async()=>{opened++;return new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}});}};
 const reader=promptBody("test","","",[entry,entry]).getReader();while(!opened)await reader.read();await reader.cancel();assert.equal(cancelled,true);assert.equal(opened,1);
});

test("HTML crash responses produce a useful error without leaking server markup",async()=>{
 await assert.rejects(()=>readApiResponse(new Response("<html>Worker exceeded memory limit</html>",{status:500})),/HTTP 500.*Execuções/);
 await assert.rejects(()=>readApiResponse(Response.json({error:"Entre para acessar."},{status:401})),(e:any)=>e.status===401);
 assert.deepEqual(await readApiResponse(Response.json({result:{prompt:"ok"}})),{result:{prompt:"ok"}});
});

test("chat completions body carries the system prompt, labels and images for gateways",async()=>{
 const input=Uint8Array.from({length:3001},(_,i)=>i%251);
 const body=promptBody("grok-4.7",'Sistema "ação"',"Pedido",[{label:"Cena",mime:"image/jpeg",open:async()=>new ReadableStream({start(c){c.enqueue(input);c.close();}})}],"chat");
 const data=JSON.parse(await new Response(body).text());
 assert.equal(data.model,"grok-4.7");assert.equal(data.stream,true);assert.equal(data.input,undefined);
 assert.deepEqual(data.messages[0],{role:"system",content:'Sistema "ação"'});
 const parts=data.messages[1].content;
 assert.deepEqual(parts[0],{type:"text",text:"Cena"});assert.equal(parts[2].text,"Pedido");
 assert.equal(parts[1].type,"image_url");assert.ok(parts[1].image_url.url.startsWith("data:image/jpeg;base64,"));
 assert.deepEqual(Buffer.from(parts[1].image_url.url.split(",")[1],"base64"),Buffer.from(input));
});
