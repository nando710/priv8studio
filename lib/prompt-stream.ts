// Reads a streamed OpenAI Responses API answer (server-sent events) and extracts the prompt blocks.
type Event = {type?:string;[key:string]:any};
function parseBlock(block:string):Event|null {
 const data=block.split("\n").map(l=>l.replace(/\r$/,"")).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).replace(/^ /,"")).join("\n");
 if(!data||data==="[DONE]")return null;try{return JSON.parse(data);}catch{return null;}
}
export async function* sseEvents(body:ReadableStream<Uint8Array>):AsyncGenerator<Event> {
 const reader=body.getReader(),decoder=new TextDecoder();let buffer="",complete=false;
 try {
  while(true){
   const {value,done}=await reader.read();if(done){complete=true;break;}
   buffer+=decoder.decode(value,{stream:true});let match:RegExpExecArray|null;
   while((match=/\r?\n\r?\n/.exec(buffer))){const event=parseBlock(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);if(event)yield event;}
  }
  const event=parseBlock(buffer+decoder.decode());if(event)yield event;
 } finally { if(!complete)await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export function outputText(response:any):string {
 return (response?.output||[]).filter((x:any)=>x.type==="message").flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==="output_text").map((x:any)=>x.text).join("\n");
}
export type StreamResult = {status:string;text:string;reason:string;error:string};
// `progress` receives the number of characters written so far; it is never called during reasoning.
export async function readPromptStream(body:ReadableStream<Uint8Array>,progress:(chars:number)=>void=()=>{}):Promise<StreamResult> {
 let text="",final:any=null,error="";
 for await(const e of sseEvents(body)){
  if(e.type==="response.output_text.delta"&&typeof e.delta==="string"){text+=e.delta;progress(text.length);}
  else if(e.type==="response.completed"||e.type==="response.incomplete"||e.type==="response.failed")final=e.response;
  else if(e.type==="error")error=String(e.message||e.error?.message||"erro desconhecido");
 }
 // The final response object is authoritative; the deltas cover streams that end without one.
 return {status:final?.status||(error?"failed":"unknown"),text:outputText(final)||text,reason:String(final?.incomplete_details?.reason||""),error:error||String(final?.error?.message||"")};
}
// Chat Completions stream: the text arrives in choices[0].delta.content and finish_reason closes it.
export async function readChatStream(body:ReadableStream<Uint8Array>,progress:(chars:number)=>void=()=>{}):Promise<StreamResult> {
 let text="",finish="",error="";
 for await(const e of sseEvents(body)){
  if(e.error){error=String(e.error.message||e.error||"erro desconhecido");continue;}
  const choice=e.choices?.[0];if(!choice)continue;
  if(typeof choice.delta?.content==="string"&&choice.delta.content){text+=choice.delta.content;progress(text.length);}
  if(choice.finish_reason)finish=String(choice.finish_reason);
 }
 if(error)return {status:"failed",text,reason:"",error};
 if(finish==="length")return {status:"incomplete",text,reason:"max_output_tokens",error:""};
 if(finish==="content_filter")return {status:"failed",text,reason:"",error:"a resposta foi bloqueada pelo filtro de conteúdo"};
 // Some gateways drop finish_reason; the parser still rejects a prompt that was cut off.
 return {status:text?"completed":"unknown",text,reason:"",error:""};
}
export function parsePrompt(text:string) {
 const raw=/<prompt>([\s\S]*?)<\/prompt>/.exec(text)?.[1]?.trim();if(!raw)return null;
 const head=/\n\s*(head_swap:[\s\S]*)/i.exec(raw);
 return {prompt:head?raw.slice(0,head.index).trim():raw,headPrompt:head?.[1]?.trim()||"",notes:/<notas>([\s\S]*?)<\/notas>/.exec(text)?.[1]?.trim()||""};
}
// Newline-delimited JSON to the browser. Heartbeats keep proxies from closing an idle connection while the model reasons.
export function eventStream(work:(send:(event:Event)=>void,signal:AbortSignal)=>Promise<Event>,heartbeatMs=10_000) {
 const encoder=new TextEncoder(),abort=new AbortController();let timer:ReturnType<typeof setInterval>|undefined,open=true;
 return new ReadableStream<Uint8Array>({
  start(controller){
   const send=(event:Event)=>{if(open)try{controller.enqueue(encoder.encode(JSON.stringify(event)+"\n"));}catch{open=false;}};
   send({type:"wait"});timer=setInterval(()=>send({type:"wait"}),heartbeatMs);
   work(send,abort.signal).catch(()=>({state:"unknown",error:"Resposta do gerador não confirmada."})).then(result=>{clearInterval(timer);send({...result,type:"done"});if(open){open=false;try{controller.close();}catch{}}});
  },
  cancel(){open=false;clearInterval(timer);abort.abort();}
 });
}
