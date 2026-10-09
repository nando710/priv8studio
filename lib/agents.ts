import moldes from "./source/moldes.json";

// System prompts of the prompt-writing agents. Each starts from the extension's template in moldes.json;
// an administrator may replace it, and the saved text is used from then on.
export type AgentId = keyof typeof moldes;
export type Agent = {id:AgentId;name:string;description:string;group:"active"|"pending"};
export const AGENTS:Agent[] = [
 {id:"PROMPT_SISTEMA",name:"Body swap",description:"Escreve o prompt de 13 parágrafos do Body swap e do Body swap em lote.",group:"active"},
 {id:"SWAP_VISTAS",name:"Body swap em lote · fotos extras da modelo",description:"Acrescentado ao Body swap quando há fotos de costas ou de lado.",group:"active"},
 {id:"SWAP_CABECA",name:"Body swap em lote · etapa 2 (cabeça)",description:"Acrescentado quando a etapa de cabeça está ligada; escreve o parágrafo head_swap.",group:"active"},
 {id:"REFINO_REGRAS",name:"Refino de prompt",description:"Acrescentado ao agente do Body swap quando você refina uma imagem.",group:"active"},
 {id:"INSTRUCOES_CENARIO",name:"Troca de cenário",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_CORPO",name:"Corpo inteiro",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_CORPO_SEM",name:"Corpo inteiro · sem tatuagem",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_ROSTO",name:"Rosto",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_ROSTO_INSPIRADA",name:"Rosto inspirado",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_ROUPA",name:"Troca de roupa",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_VISTAS",name:"Oito vistas",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_UGC",name:"Vídeo UGC",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
 {id:"INSTRUCOES_REACT",name:"Vídeo React",description:"Ferramenta ainda não integrada ao estúdio.",group:"pending"},
];
export const MAX_AGENT_PROMPT = 200_000;
export const agentSettingKey = (id:AgentId) => `agent_prompt:${id}`;
export const defaultAgentPrompt = (id:AgentId):string => (moldes as Record<string,string>)[id] || "";
export const findAgent = (id:unknown) => AGENTS.find(a=>a.id===id);
