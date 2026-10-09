// Refinement: the model compares a generated image with its references and revises the prompt that produced it.
// Only these workflow settings may be changed through the <ajustes> block that REFINO_REGRAS asks for.
type Setting = {id:"steps"|"bust";desc:string;min?:number;max?:number;values?:number[]};
export const ADJUSTABLE:Setting[] = [
 {id:"steps",desc:"sampling steps of the body pass (more steps: more detail, slower)",min:6,max:12},
 {id:"bust",desc:"weight of the body-proportions LoRA; 0 turns it off",values:[0,.6,1,1.5,2]},
];
export type Adjustment = {id:Setting["id"];valor:number;motivo:string};

export function settingsList(options:{steps:number;bust:number}) {
 return "## Adjustable workflow settings\n"+ADJUSTABLE.map(s=>`- ${s.id}: ${s.desc}; ${s.values?`one of ${s.values.join(", ")}`:`an integer from ${s.min} to ${s.max}`}; current value ${options[s.id]}`).join("\n");
}

export function refineNote(input:{prompt:string;headPrompt:string;instructions:string;views:string[];options:{steps:number;bust:number}}) {
 const blocks=[input.prompt.trim(),input.headPrompt.trim()].filter(Boolean).join("\n\n");
 return `${input.views.length?`Extra views sent: ${input.views.join(", ")}.\n`:""}Current blocks that produced <result1>:\n<prompt>\n${blocks}\n</prompt>\n\nOperator request (what to improve): ${input.instructions}\n\n${settingsList(input.options)}\n\nAnswer with the <prompt> and <notas> blocks, plus <ajustes> only when a setting must change.`;
}

// Never trust the model's JSON: unknown ids and out-of-range values are dropped.
export function parseAdjustments(text:string):Adjustment[] {
 const raw=/<ajustes>([\s\S]*?)<\/ajustes>/.exec(text)?.[1];if(!raw)return [];
 let list:unknown;try{list=JSON.parse(raw.trim());}catch{return [];}
 if(!Array.isArray(list))return [];
 return list.slice(0,3).flatMap((item:any)=>{
  const spec=ADJUSTABLE.find(s=>s.id===item?.id),value=Number(item?.valor);
  if(!spec||!Number.isFinite(value))return [];
  if(spec.values?!spec.values.includes(value):!Number.isInteger(value)||value<spec.min!||value>spec.max!)return [];
  return [{id:spec.id,valor:value,motivo:String(item.motivo||"").slice(0,200)}];
 });
}
