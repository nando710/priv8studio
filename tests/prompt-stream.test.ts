import test from "node:test";
import assert from "node:assert/strict";
import { readPromptStream, readChatStream, parsePrompt, eventStream } from "../lib/prompt-stream";
import { readApiStream } from "../lib/http-response";

const sse=(events:any[],newline="\n")=>events.map(e=>`event: ${e.type}${newline}data: ${JSON.stringify(e)}${newline}${newline}`).join("");
// Splits the text into irregular chunks, including inside multi-byte characters and event separators.
function chunked(text:string,size=7){const bytes=new TextEncoder().encode(text);let offset=0;return new ReadableStream<Uint8Array>({pull(c){if(offset>=bytes.length)return c.close();c.enqueue(bytes.slice(offset,offset+size));offset+=size;}});}
const answer="<prompt>\nbody_swap: Use <image1> — ação.\n\nhead_swap: start with <image1>. high quality, sharp details, 4k\n</prompt>\n<notas>\n- Cena espelhada.\n</notas>";
const message=(text:string)=>[{type:"message",content:[{type:"output_text",text}]}];

test("reads deltas and the final response across irregular chunks and CRLF separators",async()=>{
 for(const newline of ["\n","\r\n"]){
  const seen:number[]=[];
  const events=[{type:"response.created",response:{status:"in_progress"}},{type:"response.output_text.delta",delta:answer.slice(0,40)},{type:"response.output_text.delta",delta:answer.slice(40)},{type:"response.completed",response:{status:"completed",output:message(answer)}}];
  const r=await readPromptStream(chunked(sse(events,newline)),n=>seen.push(n));
  assert.equal(r.status,"completed");assert.equal(r.text,answer);assert.deepEqual(seen,[40,answer.length]);
 }
});

test("reports truncated and failed answers instead of hanging",async()=>{
 const incomplete=await readPromptStream(chunked(sse([{type:"response.output_text.delta",delta:"<prompt>body"},{type:"response.incomplete",response:{status:"incomplete",incomplete_details:{reason:"max_output_tokens"},output:[]}}])));
 assert.equal(incomplete.status,"incomplete");assert.equal(incomplete.reason,"max_output_tokens");assert.equal(incomplete.text,"<prompt>body");
 const failed=await readPromptStream(chunked(sse([{type:"error",message:"model overloaded"}])));
 assert.equal(failed.status,"failed");assert.equal(failed.error,"model overloaded");
 assert.equal((await readPromptStream(chunked(""))).status,"unknown");
});

test("splits the body and head prompts and keeps the notes",()=>{
 const r=parsePrompt(answer)!;
 assert.equal(r.prompt,"body_swap: Use <image1> — ação.");assert.equal(r.headPrompt,"head_swap: start with <image1>. high quality, sharp details, 4k");assert.equal(r.notes,"- Cena espelhada.");
 assert.equal(parsePrompt("<prompt>sem fim"),null);
});

test("event stream sends heartbeats, progress and a final event the browser can read",async()=>{
 const stream=eventStream(async send=>{await new Promise(r=>setTimeout(r,35));send({type:"progress",phase:"writing",chars:12});return {state:"SUCCESS",result:{prompt:"ok"}};},10);
 const events:any[]=[];const done=await readApiStream(new Response(stream,{headers:{"Content-Type":"application/x-ndjson"}}),e=>events.push(e));
 assert.ok(events.filter(e=>e.type==="wait").length>=2);assert.deepEqual(events.at(-1),{type:"progress",phase:"writing",chars:12});
 assert.equal(done.state,"SUCCESS");assert.equal(done.result.prompt,"ok");
});

test("cancelling the browser stream aborts the work, and a dropped stream is an explicit error",async()=>{
 let workSignal:AbortSignal|undefined;
 const stream=eventStream(async(_send,signal)=>{workSignal=signal;await new Promise(r=>signal.addEventListener("abort",r));return {state:"interrupted"};});
 const reader=stream.getReader();await reader.read();await reader.cancel();assert.equal(workSignal?.aborted,true);
 const cut=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"type":"wait"}\n'));c.close();}});
 await assert.rejects(()=>readApiStream(new Response(cut,{headers:{"Content-Type":"application/x-ndjson"}}),()=>{}),/conexão caiu/);
 await assert.rejects(()=>readApiStream(Response.json({error:"Selecione a cena e a modelo."},{status:400}),()=>{}),/Selecione a cena/);
});

const chat=(events:any[])=>events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join("")+"data: [DONE]\n\n";
const delta=(content:string,finish:string|null=null)=>({choices:[{index:0,delta:{content},finish_reason:finish}]});
test("reads chat completions streams from gateways",async()=>{
 const seen:number[]=[];
 const r=await readChatStream(chunked(chat([{choices:[{delta:{role:"assistant",reasoning_content:"pensando"}}]},delta(answer.slice(0,30)),delta(answer.slice(30)),delta("","stop")])),n=>seen.push(n));
 assert.equal(r.status,"completed");assert.equal(r.text,answer);assert.deepEqual(seen,[30,answer.length]);
 const cut=await readChatStream(chunked(chat([delta("<prompt>body"),delta("","length")])));
 assert.equal(cut.status,"incomplete");assert.equal(cut.reason,"max_output_tokens");
 const failed=await readChatStream(chunked(chat([{error:{message:"quota exceeded"}}])));
 assert.equal(failed.status,"failed");assert.equal(failed.error,"quota exceeded");
 assert.equal((await readChatStream(chunked(""))).status,"unknown");
});
