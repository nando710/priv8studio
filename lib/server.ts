import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { AppError, ACTIVE, month, integer, cleanOptions, price, parseOutput, taskId, RESERVE_SQL, WORKFLOW_ID } from "./core";
import { buildGraph, validateGraph } from "./workflow";
import moldes from "./source/moldes.json";
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
 const u=await getChatGPTUser();if(!u)throw new AppError(401,"Entre para acessar o estúdio.");
 let a=await db().prepare("SELECT * FROM accounts WHERE user_id=?").bind(u.userId).first<Account>();
 if(!a){
  if(env.ALLOW_PRIVATE_BOOTSTRAP==="true")await db().prepare("INSERT INTO accounts(id,user_id,email,name,role,active,budget,concurrent,created) SELECT ?,?,?,?,'admin',1,1000,2,? WHERE NOT EXISTS(SELECT 1 FROM accounts) AND NOT EXISTS(SELECT 1 FROM settings WHERE key='bootstrap_closed')").bind(uuid(),u.userId,u.email.toLowerCase(),u.displayName,now()).run();
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
async function configuration(){return {runninghub:!!await setting("runninghub_key"),prompts:!!await setting("openai_key"),template:!!await setting("workflow_template"),workflowId:WORKFLOW_ID,baseCost:Number(await setting("base_cost","10")),promptCost:Number(await setting("prompt_cost","1")),globalLimit:Number(await setting("global_limit","2")),model:await setting("prompt_model","gpt-6.1-sol")};}
async function ownMedia(a:Account,id:string){const row=await db().prepare("SELECT * FROM media WHERE id=? AND owner=?").bind(id,a.id).first<any>();if(!row)throw new AppError(404,"Arquivo não encontrado no seu acervo.");return row;}
async function object(a:Account,id:string){const row=await ownMedia(a,id);const obj=await bucket().get(row.object_key);if(!obj)throw new AppError(404,"Arquivo indisponível.");return {row,obj};}
async function reserve(a:Account,b:any,kind:string,cost:number,title:string){
 if(typeof b.requestKey!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(b.requestKey))throw new AppError(400,"Identificador de solicitação inválido.");
 const id=uuid(),t=now(),period=month();const result=await db().prepare(RESERVE_SQL).bind(id,b.requestKey,kind,title,cost,period,JSON.stringify(b),t,t,a.id,cost,period,integer(await setting("global_limit","2"),1,20)).run();
 const job=await db().prepare("SELECT * FROM jobs WHERE owner=? AND request_key=?").bind(a.id,b.requestKey).first<any>();
 if(!job)throw new AppError(429,"Limite de créditos ou de execuções simultâneas atingido.");return {job,fresh:result.meta.changes===1};
}
async function update(id:string,state:string,o:{error?:string;remote?:string;result?:any;refund?:boolean}={}){await db().prepare("UPDATE jobs SET state=?,updated=?,error=?,remote_id=COALESCE(?,remote_id),result=COALESCE(?,result),charged=CASE WHEN ?=1 THEN 0 ELSE charged END WHERE id=?").bind(state,now(),o.error||null,o.remote||null,o.result?JSON.stringify(o.result):null,o.refund?1:0,id).run();}
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
async function generate(a:Account,b:any){
 const c=await configuration();if(!c.prompts)throw new AppError(409,"Conecte o gerador de prompts em Configurações.");
 const files=b.files||{};if(!files.scene||!files.front)throw new AppError(400,"Selecione a cena e a modelo.");
 const content:any[]=[],labels:Record<string,string>={scene:"<image1>: base scene, preserve outfit and pose",front:"<image2>: adult model, front view",back:"Extra reference: back view",left:"Extra reference: left side",right:"Extra reference: right side"};
 for(const [k,label]of Object.entries(labels))if(files[k]){const {row,obj}=await object(a,files[k]);if(row.bytes>8_000_000)throw new AppError(400,"Use referências de até 8 MB para gerar prompts.");content.push({type:"input_text",text:label},{type:"input_image",image_url:`data:${row.mime};base64,${b64(new Uint8Array(await obj.arrayBuffer()))}`,detail:"high"});}
 const m:any=moldes;let instructions=m.PROMPT_SISTEMA||"";if(!instructions)throw new AppError(503,"Molde indisponível.");if(files.back||files.left||files.right)instructions+="\n\n"+(m.SWAP_VISTAS||"");if(b.options?.head!==false)instructions+="\n\n"+(m.SWAP_CABECA||"");
 content.push({type:"input_text",text:`Operator request: ${String(b.note||"").slice(0,4000)}\nWrite the required <prompt> and <notas> blocks. Describe only the supplied images.`});
 const {job,fresh}=await reserve(a,b,"prompt",c.promptCost,"Prompt · Body swap");if(!fresh)return {id:job.id,state:job.state,result:job.result?JSON.parse(job.result):null};let sent=false;
 try{
  const key=await secret("openai_key");await update(job.id,"submitting");sent=true;const res=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:c.model,instructions,input:[{role:"user",content}],store:false,max_output_tokens:8000}),signal:AbortSignal.timeout(110000)});
  if(!res.ok){await update(job.id,"rejected",{error:`Gerador respondeu HTTP ${res.status}.`,refund:true});return {id:job.id,state:"rejected",error:`Gerador respondeu HTTP ${res.status}.`};}
  const r:any=await res.json();const text=(r.output||[]).filter((x:any)=>x.type==="message").flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==="output_text").map((x:any)=>x.text).join("\n");
  const raw=/<prompt>([\s\S]*?)<\/prompt>/.exec(text)?.[1]?.trim();if(r.status!=="completed"||!raw)throw new AppError(502,"O gerador não devolveu um prompt completo. Confira o histórico antes de tentar novamente.");
  const head=/\n\s*(head_swap:[\s\S]*)/i.exec(raw);const result={prompt:head?raw.slice(0,head.index).trim():raw,headPrompt:head?.[1]||"",notes:/<notas>([\s\S]*?)<\/notas>/.exec(text)?.[1]?.trim()||""};await update(job.id,"SUCCESS",{result});return {id:job.id,state:"SUCCESS",result};
 }catch(e){const error=e instanceof AppError?e.message:"Resposta do gerador não confirmada.";await update(job.id,sent?"unknown":"rejected",{error,refund:!sent});return {id:job.id,state:sent?"unknown":"rejected",error};}
}
export async function route(req:Request,path:string[]){
 if(req.method!=="GET"&&req.headers.get("origin")!==new URL(req.url).origin)throw new AppError(403,"Origem inválida.");
 const a=await account(),key=path.join("/");
 if(req.method==="GET"&&key==="init"){
  const usage=await db().prepare("SELECT COALESCE(SUM(cost),0) AS used FROM jobs WHERE owner=? AND period=? AND charged=1").bind(a.id,month()).first<any>();
  return {account:a,used:usage?.used||0,config:await configuration(),jobs:(await db().prepare("SELECT id,kind,title,state,cost,charged,remote_id,result,error,created,updated FROM jobs WHERE owner=? ORDER BY created DESC LIMIT 100").bind(a.id).all()).results,media:(await db().prepare("SELECT id,name,mime,bytes,model,category,created FROM media WHERE owner=? ORDER BY created DESC LIMIT 500").bind(a.id).all()).results};
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
 if(key==="jobs"&&req.method==="POST")return submit(a,await json(req));
 if(key==="prompts"&&req.method==="POST")return generate(a,await json(req));
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
   const b=await json(req);for(const [field,name]of [["runninghubKey","runninghub_key"],["openaiKey","openai_key"]])if(b[field]){const value=String(b[field]).trim();if(value.length<16||value.length>1000)throw new AppError(400,"Chave inválida.");await putSetting(name,await encrypt(value));}
   if(b.template)await putSetting("workflow_template",JSON.stringify(validateGraph(b.template)));
   if(b.model){if(!/^[a-zA-Z0-9._-]{1,100}$/.test(b.model))throw new AppError(400,"Modelo inválido.");await putSetting("prompt_model",b.model);}
   for(const [field,name,min,max]of [["baseCost","base_cost",1,10000],["promptCost","prompt_cost",1,1000],["globalLimit","global_limit",1,20]] as const)if(b[field]!=null)await putSetting(name,String(integer(b[field],min,max)));
   await audit(a.id,"integration_updated","configuration");return {ok:true,config:await configuration()};
  }
  if(key==="admin/reconcile"&&req.method==="POST"){
   const b=await json(req),job=await db().prepare("SELECT * FROM jobs WHERE id=?").bind(b.id).first<any>();if(!job)throw new AppError(404,"Tarefa inexistente.");
   if(b.action==="refund"&&b.confirmed===true&&ACTIVE.includes(job.state)){await update(job.id,"refunded",{refund:true,error:"Estorno administrativo após conferência no provedor."});await audit(a.id,"job_refunded",job.id);return {ok:true};}
   if(b.action==="attach"&&job.kind==="image"&&ACTIVE.includes(job.state)&&/^\d{8,30}$/.test(String(b.remoteId))){const other=await db().prepare("SELECT id FROM jobs WHERE remote_id=? AND id<>?").bind(String(b.remoteId),job.id).first();if(other)throw new AppError(409,"ID já associado a outra execução.");await update(job.id,"QUEUED",{remote:String(b.remoteId)});await audit(a.id,"job_remote_attached",job.id);return {ok:true};}throw new AppError(400,"Conciliação inválida.");
  }
 }
 throw new AppError(404,"Rota não encontrada.");
}
