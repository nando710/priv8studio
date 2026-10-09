import { AppError, cleanOptions } from "./core";
import visual from "./source/28c.json";
import specsJSON from "./source/specs.json";
type Node = {class_type:string; inputs:Record<string,any>; _meta?:{title:string}};
export type Graph = Record<string,Node>;
const specs:any=specsJSON;
const source:any=visual;
const REQUIRED:Record<string,[string,string[]]> = {"2":["LoadImage",["image"]],"19":["LoadImage",["image"]],"30":["LoadImage",["image"]],"32":["TextEncodeQwenImage21",["prompt"]],"39":["TextEncodeQwenImage21",["prompt"]],"46":["TextEncodeQwenImage21",["prompt"]],"23":["PrimitiveBoolean",["value"]],"25":["PrimitiveBoolean",["value"]],"28":["PrimitiveBoolean",["value"]],"29":["PrimitiveBoolean",["value"]],"35":["KSampler",["seed","steps"]],"41":["KSampler",["seed"]],"48":["KSampler",["seed"]],"61":["SaveImageAdvanced",["images"]]};
export function validateGraph(raw:any):Graph {
  const g = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!g || Array.isArray(g.nodes) || typeof g !== "object") throw new AppError(400,"Use o JSON em formato API (class_type/inputs), não o arquivo visual do editor.");
  for(const [id,[type,fields]] of Object.entries(REQUIRED)) {
    if(g[id]?.class_type!==type) throw new AppError(400,`O workflow não corresponde ao 28C: confira o nó ${id} (${type}).`);
    for(const field of fields) if(!(field in g[id].inputs)) throw new AppError(400,`Falta ${id}.${field} no formato API.`);
  }
  for(const [id,node] of Object.entries(g) as [string,any][]) {
    if(!/^\d+$/.test(id)||!node?.class_type||!node?.inputs) throw new AppError(400,"Formato de workflow inválido.");
    for(const value of Object.values(node.inputs)) if(Array.isArray(value) && value.length===2 && typeof value[0]==="string" && Number.isInteger(value[1]) && !g[value[0]]) throw new AppError(400,`Conexão inválida no nó ${id}: ${value[0]}.`);
  }
  return g;
}
// Only these simple types may be reconstructed from the audited visual source.
// V3 dynamic widgets (notably SaveImageAdvanced) are kept verbatim from the real API export.
const ADDABLE = new Set(["LoadImage","ImageResizeKJv2","LoraLoaderModelOnly","SeedVR2LoadDiTModel","SeedVR2LoadVAEModel","SeedVR2VideoUpscaler","ImageScaleToTotalPixels","SaveImage"]);
function addNode(g:Graph,id:string) {
  if(g[id]) return;
  const n=source.nodes.find((n:any)=>String(n.id)===id); const s=specs[n?.type];
  if(!n||!s||!ADDABLE.has(n.type)) throw new AppError(400,`O formato API precisa incluir o nó ${id}.`);
  const inputs:Record<string,any>={}; let index=0; const values=n.widgets_values;
  for(const section of ["required","optional"]) for(const name of s.input_order?.[section]||Object.keys(s.input?.[section]||{})) {
    const [type,opts={}]=s.input[section][name];
    if(opts.forceInput) continue;
    if(Array.isArray(type)||["INT","FLOAT","STRING","BOOLEAN","COMBO"].includes(type)) {
      if(index>=values.length) throw new AppError(400,`Widgets incompletos no nó ${id}.`);
      inputs[name]=values[index++];
      if(type==="INT" && (opts.control_after_generate||["seed","noise_seed"].includes(name))) index++;
      if(opts.image_upload||opts.video_upload||opts.audio_upload) index++;
    }
  }
  // LoadImage has an upload-button value after the image filename.
  if(n.type==="LoadImage" && index===1 && values.length===2) index++;
  if(index!==values.length) throw new AppError(400,`O catálogo de nós divergiu do nó ${id}; importe uma versão API atualizada.`);
  for(const input of n.inputs||[]) if(input.link!=null) {
    const link=source.links.find((l:any)=>l[0]===input.link);
    if(!link) throw new AppError(400,"Conexão ausente no workflow local.");
    inputs[input.name]=[String(link[1]),link[2]];
  }
  g[id]={class_type:n.type,inputs,_meta:{title:n.title||n.type}};
}
export function buildGraph(template:Graph, files:Record<string,string>, prompt:string, headPrompt:string, tattooPrompt:string, options:ReturnType<typeof cleanOptions>):Graph {
  const g=structuredClone(validateGraph(template));
  if(!files.scene||!files.front) throw new AppError(400,"Selecione a cena e a modelo de frente.");
  if(!prompt.trim()) throw new AppError(400,"Escreva ou gere o prompt do corpo.");
  const set=(id:string,key:string,value:any)=>{if(!g[id])throw new AppError(400,`Nó ${id} ausente no formato API.`);g[id].inputs[key]=value;};
  set("30","image",files.scene); set("2","image",files.front); set("19","image",files.face||files.front);
  set("32","prompt",prompt); if(headPrompt.trim())set("39","prompt",headPrompt); if(tattooPrompt.trim())set("46","prompt",tattooPrompt);
  set("23","value",options.head);set("25","value",options.tattoo);set("28","value",options.mask);set("29","value",options.color);
  set("4","value",options.count);set("3","megapixels",2.1);set("35","steps",options.steps);
  ["35","41","48"].forEach((id,i)=>set(id,"seed",options.seed+i));
  // Resolve the optional view on the server; never send a frontend group/mode to RunningHub.
  const viewMap:Record<string,[string,string]>={back:["13","14"],left:["15","16"],right:["17","18"]};
  for(const id of ["32","46"]) delete g[id].inputs["images.image_3"];
  if(options.view!=="none") {
    if(!files[options.view])throw new AppError(400,"Adicione a referência da vista selecionada.");
    const [load,resize]=viewMap[options.view];addNode(g,load);addNode(g,resize);set(load,"image",files[options.view]);
    for(const id of ["32","46"])set(id,"images.image_3",[resize,0]);
  }
  // Route the optional LoRA explicitly, including exports where it was in bypass.
  if(options.bust>0){addNode(g,"11");set("11","strength_model",options.bust);set("12","model",["11",0]);}
  else {set("12","model",["10",0]);delete g["11"];}
  if(options.quality!=="1080p") {
    for(const id of ["62","63","64","65","66"])addNode(g,id);
    set("64","resolution",options.quality==="4K"?2160:1440);set("64","seed",options.seed);set("65","megapixels",options.quality==="4K"?8.3:3.7);
  } else for(const id of ["62","63","64","65","66"])delete g[id];
  // Materialize boolean branch choices to avoid needless inactive generations.
  const choices:Record<string,boolean>={"43":options.head,"50":options.tattoo,"58":options.color,"60":options.mask};
  function resolve(value:any,seen=new Set<string>()):any {
    if(!Array.isArray(value)||value.length!==2||typeof value[0]!=="string")return value;
    const id=value[0];if(!(id in choices))return value;
    if(seen.has(id))throw new AppError(400,"Ciclo no workflow.");seen.add(id);
    return resolve(g[id].inputs[choices[id]?"on_true":"on_false"],seen);
  }
  for(const n of Object.values(g)) for(const [key,value]of Object.entries(n.inputs))n.inputs[key]=resolve(value);
  // Only request the intended outputs. Prune their unused ancestors, including absent reference files.
  const outputIds=["61",...(options.head?["37"]:[]),...(options.mask?["51"]:[]),...(options.tattoo&&g["44"]?["44"]:[]),...(options.quality!=="1080p"?["66"]:[])];
  const keep=new Set<string>(); const visit=(id:string)=>{if(keep.has(id))return;if(!g[id])throw new AppError(400,`Conexão aponta para nó ausente: ${id}.`);keep.add(id);for(const v of Object.values(g[id].inputs))if(Array.isArray(v)&&v.length===2&&typeof v[0]==="string"&&Number.isInteger(v[1]))visit(v[0]);};
  outputIds.forEach(visit);return Object.fromEntries(Object.entries(g).filter(([id])=>keep.has(id)));
}
