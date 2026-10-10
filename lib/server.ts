import { env } from "cloudflare:workers";
import { currentUser, mayBootstrap, adminEmails, authMode } from "./auth";
import { AppError, ACTIVE, month, integer, cleanOptions, price, parseOutput, taskId, RESERVE_SQL, WORKFLOW_ID, RECOVER_PROMPTS_SQL, PROMPT_RECOVERY_MS, PROMPT_TIMEOUT_MS, PROMPT_HEARTBEAT_MS } from "./core";
import { buildGraph, validateGraph } from "./workflow";
import { AGENTS, MAX_AGENT_PROMPT, agentSettingKey, defaultAgentPrompt, findAgent, type AgentId } from "./agents";
import { promptBody, PROMPT_IMAGE_BYTES, type PromptImage, type PromptFormat } from "./prompt-body";
import { eventStream, parsePrompt, readPromptStream, readChatStream } from "./prompt-stream";
import { parseAdjustments, refineNote } from "./refine";
type Account={id:string;user_id:string;email:string;name:string;role:string;active:number;budget:number;concurrent:number};
const db=()=>{if(!env.DB)throw new AppError(503,"Banco de dados indisponível.");return env.DB;};
const bucket=()=>{if(!env.BUCKET)throw new AppError(503,"Acervo indisponível.");return env.BUCKET;};
const now=()=>Date.now(),uuid=()=>crypto.randomUUID();
async function setting(key:string,fallback=""){return (await db().prepare("SELECT value FROM settings WHERE key=?").bind(key).first<any>())?.value??fallback;}
async function putSetting(key:string,value:string){await db().prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key,value).run();}
async function audit(actor:string,action:string,target:string){await db().prepare("INSERT INTO audit(id,actor,action,target,created) VALUES(?,?,?,?,?)").bind(uuid(),actor,action,target,now()).run();}
const b64=(bytes:Uint8Array)=>{let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
const unb64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function encryptionKey(){if(!env.CREDENTIAL_ENCRYPTION_KEY)throw new AppError(503,"Configure CREDENTIAL_ENCRYPTION_KEY no servidor.");return crypto.subtle.importKey("raw",unb64(env.CREDENTIAL_ENCRYPTION_KEY),"AES-GCM",false,["encrypt","decrypt"]);}
async function encrypt(s:string){const iv=crypto.getRandomValues(new Uint8Array(12));const result=await crypto.subtle.encrypt({name:"AES-GCM",iv},await encryptionKey(),new TextEncoder().encode(s));return b64(iv)+"."+b64(new Uint8Array(result));}
async function secret(name:string){const s=await setting(name);if(!s)throw new AppError(503,"Integração ainda não configurada pelo administrador.");const [iv,cipher]=s.split(".");return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(iv)},await encryptionKey(),unb64(cipher)));}
export async function account():Promise<Account>{
 const u=await currentUser();if(!u)throw new AppError(401,"Entre para acessar o estúdio.");
 // The identity provider verified this email, so a listed administrator is (re)linked and promoted here.
 if(adminEmails().includes(u.email.toLowerCase()))await db().prepare("INSERT INTO accounts(id,user_id,email,name,role,active,budget,concurrent,created) VALUES(?,?,?,?,'admin',1,1000,2,?) ON CONFLICT(email) DO UPDATE SET role='admin',active=1,user_id=excluded.user_id").bind(uuid(),u.userId,u.email.toLowerCase(),u.displayName,now()).run();
 let a=await db().prepare("SELECT * FROM accounts WHERE user_id=?").bind(u.userId).first<Account>();
 if(!a){
  if(mayBootstrap())await db().prepare("INSERT INTO accounts(id,user_id,email,name,role,active,budget,concurrent,created) SELECT ?,?,?,?,'admin',1,1000,2,? WHERE NOT EXISTS(SELECT 1 FROM accounts) AND NOT EXISTS(SELECT 1 FROM settings WHERE key='bootstrap_closed')").bind(uuid(),u.userId,u.email.toLowerCase(),u.displayName,now()).run();
  a=await db().prepare("SELECT * FROM accounts WHERE user_id=?").bind(u.userId).first<Account>();
  if(a)await putSetting("bootstrap_closed","true");
  else{await db().prepare("UPDATE accounts SET user_id=? WHERE email=? AND user_id IS NULL AND active=1").bind(u.userId,u.email.toLowerCase()).run();a=await db().prepare("SELECT * FROM accounts WHERE user_id=?").bind(u.userId).first<Account>();}
 }
 if(!a)throw new AppError(403,"Acesso pendente. Peça ao administrador para cadastrar seu e-mail.");
 if(!a.active)throw new AppError(403,"Conta pausada. Fale com o administrador.");return a;
}
function admin(a:Account){if(a.role!=="admin")throw new AppError(403,"Apenas administradores.");}
async function json(req:Request,max=3_000_000){if(Number(req.headers.get("content-length")||0)>max)throw new AppError(413,"Solicitação muito grande.");const s=await req.text();if(s.length>max)throw new AppError(413,"Solicitação muito grande.");try{return JSON.parse(s);}catch{throw new AppError(400,"JSON inválido.");}}
async function rh(path:string,payload:any,form?:FormData){
 const key=await secret("runninghub_key");let res:Response;
 try{if(form)form.set("apiKey",key);res=await fetch(`https://www.runninghub.ai${path}`,{method:"POST",headers:{Authorization:`Bearer ${key}`,...(!form?{"Content-Type":"application/json"}:{})},body:form||JSON.stringify({...payload,apiKey:key}),signal:AbortSignal.timeout(55000)});}catch{throw new AppError(502,"Resposta do RunningHub não confirmada.");}
 if(!res.ok)throw new AppError(502,`RunningHub respondeu HTTP ${res.status}.`);try{return await res.json() as any;}catch{throw new AppError(502,"Resposta inválida do RunningHub.");}
}
// Prompt writers speak the OpenAI Responses API; xAI (Grok) serves the same API at its own base URL.
const PROMPT_PROVIDERS={openai:{key:"openai_key",url:"https://api.openai.com/v1/responses",model:"gpt-6.1-sol"},xai:{key:"xai_key",url:"https://api.x.ai/v1/responses",model:"grok-4.7"},custom:{key:"custom_key",url:"",model:"grok-4.7"}} as const;
type ProviderId=keyof typeof PROMPT_PROVIDERS;
async function promptProvider(){const id=await setting("prompt_provider","openai");return (id in PROMPT_PROVIDERS?id:"openai") as ProviderId;}
// "custom" is any OpenAI-compatible gateway: the admin gives its base URL and the API format it speaks.
async function promptEndpoint(provider:ProviderId):Promise<{url:string;format:PromptFormat}>{
 if(provider!=="custom")return {url:PROMPT_PROVIDERS[provider].url,format:"responses"};
 const base=await setting("custom_base_url"),format=await setting("custom_format","responses")==="chat"?"chat":"responses";
 return {url:base&&`${base}/${format==="chat"?"chat/completions":"responses"}`,format};
}
function cleanBaseUrl(value:string){
 let url:URL;try{url=new URL(value.trim());}catch{throw new AppError(400,"Base URL inválida.");}
 if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||value.length>300)throw new AppError(400,"A Base URL precisa começar com https:// e não pode ter usuário, senha ou parâmetros.");
 return (url.origin+url.pathname).replace(/\/+$/,"").replace(/\/(responses|chat\/completions)$/,"");
}
async function configuration(){const provider=await promptProvider(),endpoint=await promptEndpoint(provider);return {runninghub:!!await setting("runninghub_key"),provider,keys:{openai:!!await setting("openai_key"),xai:!!await setting("xai_key"),custom:!!await setting("custom_key")},baseUrl:await setting("custom_base_url"),format:await setting("custom_format","responses"),prompts:!!await setting(PROMPT_PROVIDERS[provider].key)&&!!endpoint.url,template:!!await setting("workflow_template"),workflowId:WORKFLOW_ID,baseCost:Number(await setting("base_cost","10")),promptCost:Number(await setting("prompt_cost","1")),globalLimit:Number(await setting("global_limit","2")),model:await setting(`prompt_model:${provider}`,await setting(provider==="openai"?"prompt_model":"",PROMPT_PROVIDERS[provider].model))};}
async function ownMedia(a:Account,id:string){const row=await db().prepare("SELECT * FROM media WHERE id=? AND owner=?").bind(id,a.id).first<any>();if(!row)throw new AppError(404,"Arquivo não encontrado no seu acervo.");return row;}
async function object(a:Account,id:string){const row=await ownMedia(a,id);const obj=await bucket().get(row.object_key);if(!obj)throw new AppError(404,"Arquivo indisponível.");return {row,obj};}
async function reserve(a:Account,b:any,kind:string,cost:number,title:string){
 await recoverPrompts();
 if(typeof b.requestKey!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(b.requestKey))throw new AppError(400,"Identificador de solicitação inválido.");
 const id=uuid(),t=now(),period=month();const result=await db().prepare(RESERVE_SQL).bind(id,b.requestKey,kind,title,cost,period,JSON.stringify(b),t,t,a.id,cost,period,integer(await setting("global_limit","2"),1,20)).run();
 const job=await db().prepare("SELECT * FROM jobs WHERE owner=? AND request_key=?").bind(a.id,b.requestKey).first<any>();
 if(!job)throw new AppError(429,"Limite de créditos ou de execuções simultâneas atingido.");return {job,fresh:result.meta.changes===1};
}
async function update(id:string,state:string,o:{error?:string;remote?:string;result?:any;refund?:boolean}={}){await db().prepare("UPDATE jobs SET state=?,updated=?,error=?,remote_id=COALESCE(?,remote_id),result=COALESCE(?,result),charged=CASE WHEN ?=1 THEN 0 ELSE charged END WHERE id=?").bind(state,now(),o.error||null,o.remote||null,o.result?JSON.stringify(o.result):null,o.refund?1:0,id).run();}
async function recoverPrompts(){const t=now();await db().prepare(RECOVER_PROMPTS_SQL).bind(t,"Esta tentativa foi interrompida e já não ocupa uma vaga. Você pode iniciar uma nova geração. O crédito permanece reservado até conferência da cobrança pelo administrador.",t-PROMPT_RECOVERY_MS).run();}
async function upload(a:Account,id:string){const {row,obj}=await object(a,id);const form=new FormData();form.set("fileType","input");form.set("file",new Blob([await obj.arrayBuffer()],{type:row.mime}),row.name);const r=await rh("/task/openapi/upload",null,form);if(r.code!==0||typeof r.data?.fileName!=="string")throw new AppError(502,`Upload recusado (código ${r.code??"desconhecido"}).`);return r.data.fileName;}
async function submit(a:Account,b:any){
 const c=await configuration();if(!c.runninghub||!c.template)throw new AppError(409,"Configure a chave e importe o workflow em formato API.");
 const options=cleanOptions(b.options),prompt=String(b.prompt||"").slice(0,50000),selected:Record<string,string>={};
 for(const k of ["scene","front","face","back","left","right"])if(b.files?.[k]){selected[k]=String(b.files[k]);await ownMedia(a,selected[k]);}
 const template=validateGraph(await setting("workflow_template"));buildGraph(template,selected,prompt,String(b.headPrompt||""),String(b.tattooPrompt||""),options);
 const {job,fresh}=await reserve(a,{...b,options},"image",price(options,c.baseCost),"Body swap · 28C");if(!fresh)return {id:job.id,state:job.state};
 let sent=false;
 try{
  const files:Record<string,string>={},cache:Record<string,string>={};for(const [k,id]of Object.entries(selected)){cache[id]??=await upload(a,id);files[k]=cache[id];}
  const graph=buildGraph(template,files,prompt,String(b.headPrompt||""),String(b.tattooPrompt||""),options);
  await update(job.id,"submitting");sent=true;
  const r=await rh("/task/openapi/create",{workflowId:WORKFLOW_ID,workflow:JSON.stringify(graph),nodeInfoList:[],addMetadata:false,instanceType:"default"});
  if(Number.isInteger(r?.code)&&r.code!==0){await update(job.id,"rejected",{error:`Solicitação recusada (código ${r.code}).`,refund:true});return {id:job.id,state:"rejected"};}
  if(r?.code!==0||!taskId(r.data?.taskId)){await update(job.id,"unknown",{error:"Envio sem ID confirmado. Solicite conciliação ao administrador."});return {id:job.id,state:"unknown"};}
  await update(job.id,["QUEUED","RUNNING"].includes(r.data?.taskStatus)?r.data.taskStatus:"QUEUED",{remote:String(r.data.taskId)});return {id:job.id,state:"QUEUED"};
 }catch(e){const message=e instanceof AppError?e.message:"Falha ao preparar a geração.";await update(job.id,sent?"unknown":"rejected",{error:message,refund:!sent});return {id:job.id,state:sent?"unknown":"rejected",error:message};}
}
// Labels follow the moldes: SWAP_VISTAS expects BACK VIEW / LEFT SIDE VIEW / RIGHT SIDE VIEW.
async function promptImages(a:Account,files:any){
 if(!files?.scene||!files?.front)throw new AppError(400,"Selecione a cena e a modelo.");
 const images:PromptImage[]=[],labels:Record<string,string>={scene:"<image1>: base scene, preserve outfit and pose",front:"<image2>: adult model, FRONT VIEW",back:"BACK VIEW of the same model",left:"LEFT SIDE VIEW of the same model (her anatomical left side)",right:"RIGHT SIDE VIEW of the same model (her anatomical right side)"};
 let bytes=0;const views:string[]=[];
 for(const [k,label]of Object.entries(labels))if(files[k]){const row=await ownMedia(a,String(files[k]));bytes+=Number(row.bytes)||0;if(!["scene","front"].includes(k))views.push(label.split(" of ")[0]);images.push({label,mime:row.mime,open:async()=>{const obj=await bucket().get(row.object_key);if(!obj)throw new AppError(404,"Arquivo indisponível.");return obj.body;}});}
 return {images,bytes,views};
}
const tooLarge=(bytes:number)=>new AppError(413,`As fotos somam ${(bytes/1e6).toFixed(1)} MB e o gerador aceita até ${PROMPT_IMAGE_BYTES/1e6} MB por vez. Use fotos menores ou menos vistas extras.`);
// The administrator's saved text wins; otherwise the extension's template.
async function agentPrompt(id:AgentId){return (await setting(agentSettingKey(id)))||defaultAgentPrompt(id);}
async function systemPrompt(views:string[],head:boolean){
 let instructions=await agentPrompt("PROMPT_SISTEMA");if(!instructions.trim())throw new AppError(503,"Agente do Body swap sem instruções.");
 if(views.length)instructions+="\n\n"+await agentPrompt("SWAP_VISTAS");if(head)instructions+="\n\n"+await agentPrompt("SWAP_CABECA");return instructions;
}
// Streams one reserved prompt job to the browser: progress events, then the final result.
function streamPromptJob(job:any,c:{provider:ProviderId;model:string},instructions:string,note:string,images:PromptImage[],parse:(text:string)=>any){
 const provider=PROMPT_PROVIDERS[c.provider],model=c.model;
 const stream=eventStream(async(send,signal)=>{
  let sent=false;
  // A live attempt refreshes its timestamp; one killed with the connection goes stale and is recovered.
  const alive=setInterval(()=>{db().prepare("UPDATE jobs SET updated=? WHERE id=? AND state='submitting'").bind(now(),job.id).run().catch(()=>{});},PROMPT_HEARTBEAT_MS);
  const fail=async(state:string,error:string,refund=false)=>{await update(job.id,state,{error,refund});return {id:job.id,state,error};};
  try{
   const key=await secret(provider.key),endpoint=await promptEndpoint(c.provider);await update(job.id,"submitting");sent=true;
   const res=await fetch(endpoint.url,{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:promptBody(model,instructions,note,images,endpoint.format),signal:AbortSignal.any([signal,AbortSignal.timeout(PROMPT_TIMEOUT_MS)])});
   if(!res.ok||!res.body){let detail="";try{const body=await res.json() as any;detail=String(body?.error?.message||body?.message||(typeof body?.error==="string"?body.error:"")).slice(0,300);}catch{}return fail("rejected",`Gerador respondeu HTTP ${res.status}${detail?`: ${detail}`:"."}`,true);}
   send({type:"progress",phase:"thinking"});
   const r=await (endpoint.format==="chat"?readChatStream:readPromptStream)(res.body,chars=>send({type:"progress",phase:"writing",chars}));
   // Known outcomes are final: they must not keep holding a concurrency slot like "unknown" does.
   if(r.status==="incomplete")return fail("failed",r.reason==="max_output_tokens"?"O gerador atingiu o limite de tamanho da resposta antes de terminar o prompt. Tente de novo ou use um modelo mais rápido em Configurações.":`O gerador parou antes de terminar (${r.reason||"motivo não informado"}).`);
   if(r.status==="failed")return fail("failed",`O gerador falhou: ${r.error.slice(0,300)||"erro não informado"}.`);
   const result=parse(r.text);if(r.status!=="completed"||!result)return fail("failed","O gerador não devolveu um prompt completo. Confira o histórico antes de tentar novamente.");
   await update(job.id,"SUCCESS",{result});return {id:job.id,state:"SUCCESS",result};
  }catch(e){
   const error=e instanceof AppError?e.message:signal.aborted?"A geração foi interrompida porque a página foi fechada ou a conexão caiu.":e instanceof Error&&e.name==="TimeoutError"?`O gerador não respondeu em ${PROMPT_TIMEOUT_MS/60000} minutos.`:"Resposta do gerador não confirmada.";
   return fail(sent?"interrupted":"rejected",error,!sent);
  }finally{clearInterval(alive);}
 });
 return new Response(stream,{headers:{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
async function generate(a:Account,b:any){
 const c=await configuration();if(!c.prompts)throw new AppError(409,"Conecte o gerador de prompts em Configurações.");
 const {images,bytes,views}=await promptImages(a,b.files);if(bytes>PROMPT_IMAGE_BYTES)throw tooLarge(bytes);
 const instructions=await systemPrompt(views,b.options?.head!==false);
 const note=`${views.length?`Extra views sent: ${views.join(", ")}.\n`:""}Operator request: ${String(b.note||"").slice(0,4000)}\nWrite the required <prompt> and <notas> blocks. Describe only the supplied images.`;
 const {job,fresh}=await reserve(a,b,"prompt",c.promptCost,"Prompt · Body swap");if(!fresh)return {id:job.id,state:job.state,result:job.result?JSON.parse(job.result):null,error:job.error||undefined};
 return streamPromptJob(job,c,instructions,note,images,parsePrompt);
}
// Revises the prompt of a finished creation: the model sees the references, the generated image and the operator's request.
async function refine(a:Account,b:any){
 const c=await configuration();if(!c.prompts)throw new AppError(409,"Conecte o gerador de prompts em Configurações.");
 const request=String(b.instructions||"").trim().slice(0,4000);if(!request)throw new AppError(400,"Descreva o que deve melhorar.");
 const prompt=String(b.prompt||"").slice(0,50000);if(!prompt.trim())throw new AppError(400,"O prompt atual está vazio.");
 const options=cleanOptions(b.options);
 // Only an output of the caller's own finished job is fetched, never an arbitrary URL.
 const source=await db().prepare("SELECT result FROM jobs WHERE id=? AND owner=? AND kind='image' AND state='SUCCESS'").bind(String(b.jobId||""),a.id).first<any>();
 const outputs=(()=>{try{return JSON.parse(source?.result||"[]");}catch{return [];}})();
 const output=Array.isArray(outputs)?outputs[Number(b.output)||0]:null;
 if(!source||typeof output?.url!=="string"||!output.url.startsWith("https://"))throw new AppError(404,"Criação não encontrada.");
 const {images,bytes,views}=await promptImages(a,b.files);
 let res:Response;try{res=await fetch(output.url,{signal:AbortSignal.timeout(30000)});}catch{throw new AppError(502,"Não foi possível baixar a imagem gerada do provedor.");}
 const mime=(res.headers.get("content-type")||"").split(";")[0].trim().toLowerCase(),size=Number(res.headers.get("content-length")||0);
 const drop=()=>{res.body?.cancel().catch(()=>{});};
 if(!res.ok||!res.body){drop();throw new AppError(410,"A imagem gerada não está mais disponível no provedor.");}
 if(!/^image\/(png|jpeg|webp)$/.test(mime)){drop();throw new AppError(415,"O formato da imagem gerada não é aceito pelo gerador.");}
 if(bytes+size>PROMPT_IMAGE_BYTES){drop();throw tooLarge(bytes+size);}
 const body=res.body;images.unshift({label:"<result1>: the result image produced by the current blocks (for your analysis only)",mime,open:async()=>body});
 const instructions=await systemPrompt(views,options.head)+"\n\n"+await agentPrompt("REFINO_REGRAS");
 const note=refineNote({prompt,headPrompt:String(b.headPrompt||"").slice(0,20000),instructions:request,views,options});
 const {job,fresh}=await reserve(a,{...b,options},"prompt",c.promptCost,"Prompt · Refino");
 if(!fresh){drop();return {id:job.id,state:job.state,result:job.result?JSON.parse(job.result):null,error:job.error||undefined};}
 return streamPromptJob(job,c,instructions,note,images,text=>{const r=parsePrompt(text);return r&&{...r,ajustes:parseAdjustments(text)};});
}
// The settings a finished job used, so the user can review, refine or repeat it.
async function jobDetails(a:Account,id:string){
 const job=await db().prepare("SELECT id,kind,state,payload,result,created FROM jobs WHERE id=? AND owner=?").bind(id,a.id).first<any>();if(!job)throw new AppError(404,"Execução não encontrada.");
 let p:any={};try{p=JSON.parse(job.payload||"{}");}catch{}
 const files:Record<string,string>={};for(const k of ["scene","front","face","back","left","right"])if(typeof p.files?.[k]==="string")files[k]=p.files[k];
 const ids=Object.values(files),present=new Set<string>();
 if(ids.length)for(const row of (await db().prepare(`SELECT id FROM media WHERE owner=? AND id IN (${ids.map(()=>"?").join(",")})`).bind(a.id,...ids).all<any>()).results)present.add(row.id);
 return {id:job.id,kind:job.kind,state:job.state,created:job.created,files,missing:Object.keys(files).filter(k=>!present.has(files[k])),options:p.options||{},prompt:String(p.prompt||""),headPrompt:String(p.headPrompt||""),note:String(p.note||"")};
}
// Saved models: one row per model with her reference photos by view.
const MODEL_VIEWS=["front","back","left","right","face"] as const;
// "left" and "right" are SQL keywords, so their aliases are quoted.
const MODEL_SELECT=`SELECT id,name,front_id AS front,back_id AS back,left_id AS "left",right_id AS "right",face_id AS face,updated FROM models`;
async function saveModel(a:Account,b:any){
 const name=String(b.name||"").trim().slice(0,80);if(!name)throw new AppError(400,"Dê um nome para a modelo.");
 const files:Record<string,string|null>={};
 for(const v of MODEL_VIEWS){const id=b.files?.[v];files[v]=id?String(id):null;if(files[v])await ownMedia(a,files[v]!);}
 if(!files.front)throw new AppError(400,"Adicione a foto de frente da modelo.");
 const t=now(),values=[name,files.front,files.back,files.left,files.right,files.face,t];
 if(b.id){const r=await db().prepare("UPDATE models SET name=?,front_id=?,back_id=?,left_id=?,right_id=?,face_id=?,updated=? WHERE id=? AND owner=?").bind(...values,String(b.id),a.id).run();if(!r.meta.changes)throw new AppError(404,"Modelo não encontrada.");return {id:String(b.id)};}
 const id=uuid();await db().prepare("INSERT INTO models(name,front_id,back_id,left_id,right_id,face_id,updated,id,owner,created) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(...values,id,a.id,t).run();return {id};
}
export async function route(req:Request,path:string[]){
 if(req.method!=="GET"&&req.headers.get("origin")!==new URL(req.url).origin)throw new AppError(403,"Origem inválida.");
 const a=await account(),key=path.join("/");
 if(req.method==="GET"&&key==="init"){
  await recoverPrompts();
  const usage=await db().prepare("SELECT COALESCE(SUM(cost),0) AS used FROM jobs WHERE owner=? AND period=? AND charged=1").bind(a.id,month()).first<any>();
  return {account:a,auth:authMode(),used:usage?.used||0,config:await configuration(),jobs:(await db().prepare("SELECT id,kind,title,state,cost,charged,remote_id,result,error,created,updated,CASE WHEN json_valid(payload) THEN json_extract(payload,'$.files.scene') END AS scene FROM jobs WHERE owner=? ORDER BY created DESC LIMIT 100").bind(a.id).all()).results,media:(await db().prepare("SELECT id,name,mime,bytes,model,category,created FROM media WHERE owner=? ORDER BY created DESC LIMIT 500").bind(a.id).all()).results,models:(await db().prepare(`${MODEL_SELECT} WHERE owner=? ORDER BY updated DESC LIMIT 200`).bind(a.id).all()).results};
 }
 if(key==="media"&&req.method==="POST"){
  if(Number(req.headers.get("content-length")||0)>16_000_000)throw new AppError(413,"Limite de 15 MB por imagem.");const f=await req.formData(),file=f.get("file");
  if(!(file instanceof File)||file.size>15_000_000||!file.size||!["image/png","image/jpeg","image/webp"].includes(file.type))throw new AppError(400,"Envie JPG, PNG ou WebP de até 15 MB.");
  const total=await db().prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM media WHERE owner=?").bind(a.id).first<any>();if(Number(total?.total)+file.size>500_000_000)throw new AppError(413,"Acervo atingiu 500 MB.");
  const id=uuid(),objectKey=`${a.id}/${id}`,name=file.name.replace(/[\r\n\\/]/g,"_").slice(0,160);await bucket().put(objectKey,file.stream(),{httpMetadata:{contentType:file.type}});
  await db().prepare("INSERT INTO media(id,owner,name,mime,bytes,model,category,object_key,created) VALUES(?,?,?,?,?,?,?,?,?)").bind(id,a.id,name,file.type,file.size,String(f.get("model")||"Referências").slice(0,80),String(f.get("category")||"Outras").slice(0,30),objectKey,now()).run();return {id,name};
 }
 if(path[0]==="media"&&path[1]&&req.method==="GET"){const {row,obj}=await object(a,path[1]);return new Response(obj.body,{headers:{"Content-Type":row.mime,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});}
 if(path[0]==="media"&&path[1]&&req.method==="DELETE"){const row=await ownMedia(a,path[1]);await bucket().delete(row.object_key);await db().prepare("DELETE FROM media WHERE id=? AND owner=?").bind(row.id,a.id).run();return {ok:true};}
 if(key==="models"&&req.method==="POST")return saveModel(a,await json(req));
 if(path[0]==="models"&&path[1]&&req.method==="DELETE"){await db().prepare("DELETE FROM models WHERE id=? AND owner=?").bind(path[1],a.id).run();return {ok:true};}
 if(key==="jobs"&&req.method==="POST")return submit(a,await json(req));
 if(key==="prompts"&&req.method==="POST")return generate(a,await json(req));
 if(key==="prompts/refine"&&req.method==="POST")return refine(a,await json(req));
 if(path[0]==="jobs"&&path[1]&&!path[2]&&req.method==="GET")return jobDetails(a,path[1]);
 if(path[0]==="jobs"&&path[1]&&req.method==="POST"){
  const job=await db().prepare("SELECT * FROM jobs WHERE id=? AND owner=?").bind(path[1],a.id).first<any>();if(!job)throw new AppError(404,"Execução não encontrada.");
  if(job.remote_id&&ACTIVE.includes(job.state)){const r=await rh("/task/openapi/outputs",{taskId:job.remote_id}),parsed=parseOutput(r);if(parsed.state!=="unconfirmed")await update(job.id,parsed.state,{result:parsed.state==="SUCCESS"?parsed.outputs:undefined});else await db().prepare("UPDATE jobs SET error=?,updated=? WHERE id=?").bind(`Estado não confirmado (código ${r.code??"desconhecido"}). Créditos mantidos até conciliação.`,now(),job.id).run();}return {ok:true};
 }
 if(path[0]==="admin"){
  admin(a);
  if(key==="admin/accounts"&&req.method==="GET")return {accounts:(await db().prepare("SELECT a.*,COALESCE((SELECT SUM(j.cost) FROM jobs j WHERE j.owner=a.id AND j.period=? AND j.charged=1),0) AS used FROM accounts a ORDER BY created").bind(month()).all()).results,review:(await db().prepare("SELECT j.id,j.owner,a.email,j.title,j.state,j.cost,j.remote_id,j.error,j.created FROM jobs j JOIN accounts a ON a.id=j.owner WHERE j.state IN ('unknown','submitting','preparing') OR (j.error IS NOT NULL AND j.state IN ('RUNNING','QUEUED')) ORDER BY j.created DESC LIMIT 100").all()).results};
  if(key==="admin/accounts"&&req.method==="POST"){
   const b=await json(req),email=String(b.email||"").trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>150)throw new AppError(400,"E-mail inválido.");const existing=await db().prepare("SELECT * FROM accounts WHERE email=?").bind(email).first<Account>();if(existing?.role==="admin"&&b.active===false)throw new AppError(400,"Não é possível pausar o administrador.");
   await db().prepare("INSERT INTO accounts(id,email,name,role,active,budget,concurrent,created) VALUES(?,?,?,'member',?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,active=excluded.active,budget=excluded.budget,concurrent=excluded.concurrent").bind(uuid(),email,String(b.name||email).slice(0,100),b.active===false?0:1,integer(b.budget,0,1000000),integer(b.concurrent,1,10),now()).run();await audit(a.id,"account_updated",email);return {ok:true};
  }
  if(key==="admin/config"&&req.method==="POST"){
   const b=await json(req);for(const [field,name]of [["runninghubKey","runninghub_key"],["openaiKey","openai_key"],["xaiKey","xai_key"],["customKey","custom_key"]])if(b[field]){const value=String(b[field]).trim();if(value.length<16||value.length>1000)throw new AppError(400,"Chave inválida.");await putSetting(name,await encrypt(value));}
   if(b.template)await putSetting("workflow_template",JSON.stringify(validateGraph(b.template)));
   if(b.baseUrl)await putSetting("custom_base_url",cleanBaseUrl(String(b.baseUrl)));
   if(b.format!=null){if(b.format!=="responses"&&b.format!=="chat")throw new AppError(400,"Formato inválido.");await putSetting("custom_format",b.format);}
   if(b.provider!=null){if(!(b.provider in PROMPT_PROVIDERS))throw new AppError(400,"Provedor inválido.");await putSetting("prompt_provider",b.provider);}
   // Each provider remembers its own model name.
   if(b.model){if(!/^[a-zA-Z0-9._-]{1,100}$/.test(b.model))throw new AppError(400,"Modelo inválido.");await putSetting(`prompt_model:${await promptProvider()}`,b.model);}
   for(const [field,name,min,max]of [["baseCost","base_cost",1,10000],["promptCost","prompt_cost",1,1000],["globalLimit","global_limit",1,20]] as const)if(b[field]!=null)await putSetting(name,String(integer(b[field],min,max)));
   await audit(a.id,"integration_updated","configuration");return {ok:true,config:await configuration()};
  }
  if(key==="admin/agents"&&req.method==="GET"){
   const rows=(await db().prepare("SELECT key,value FROM settings WHERE key LIKE 'agent_prompt:%'").all<any>()).results,saved=new Map(rows.map((r:any)=>[r.key,r.value]));
   return {agents:AGENTS.map(g=>{const custom=saved.get(agentSettingKey(g.id));return {...g,prompt:custom||defaultAgentPrompt(g.id),custom:!!custom,defaultLength:defaultAgentPrompt(g.id).length};})};
  }
  if(key==="admin/agents"&&req.method==="POST"){
   const b=await json(req,MAX_AGENT_PROMPT*4),agent=findAgent(b.id);if(!agent)throw new AppError(404,"Agente inexistente.");
   if(b.reset===true){await db().prepare("DELETE FROM settings WHERE key=?").bind(agentSettingKey(agent.id)).run();await audit(a.id,"agent_prompt_reset",agent.id);return {ok:true,prompt:defaultAgentPrompt(agent.id),custom:false};}
   const prompt=String(b.prompt??"").replace(/\r\n/g,"\n");if(!prompt.trim())throw new AppError(400,"O system prompt não pode ficar vazio. Use “Restaurar padrão” para voltar ao original.");
   if(prompt.length>MAX_AGENT_PROMPT)throw new AppError(413,`Use até ${MAX_AGENT_PROMPT.toLocaleString("pt-BR")} caracteres.`);
   // Saving the default text keeps following future template updates instead of freezing a copy.
   if(prompt===defaultAgentPrompt(agent.id))await db().prepare("DELETE FROM settings WHERE key=?").bind(agentSettingKey(agent.id)).run();else await putSetting(agentSettingKey(agent.id),prompt);
   await audit(a.id,"agent_prompt_updated",agent.id);return {ok:true,prompt,custom:prompt!==defaultAgentPrompt(agent.id)};
  }
  if(key==="admin/reconcile"&&req.method==="POST"){
   const b=await json(req),job=await db().prepare("SELECT * FROM jobs WHERE id=?").bind(b.id).first<any>();if(!job)throw new AppError(404,"Tarefa inexistente.");
   if(b.action==="refund"&&b.confirmed===true&&ACTIVE.includes(job.state)){await update(job.id,"refunded",{refund:true,error:"Estorno administrativo após conferência no provedor."});await audit(a.id,"job_refunded",job.id);return {ok:true};}
   if(b.action==="attach"&&job.kind==="image"&&ACTIVE.includes(job.state)&&/^\d{8,30}$/.test(String(b.remoteId))){const other=await db().prepare("SELECT id FROM jobs WHERE remote_id=? AND id<>?").bind(String(b.remoteId),job.id).first();if(other)throw new AppError(409,"ID já associado a outra execução.");await update(job.id,"QUEUED",{remote:String(b.remoteId)});await audit(a.id,"job_remote_attached",job.id);return {ok:true};}throw new AppError(400,"Conciliação inválida.");
  }
 }
 throw new AppError(404,"Rota não encontrada.");
}
