import test from "node:test";
import assert from "node:assert/strict";
import { AGENTS, defaultAgentPrompt, findAgent, agentSettingKey } from "../lib/agents";

test("every agent starts from a non-empty extension template and has a unique setting key",()=>{
 for(const agent of AGENTS)assert.ok(defaultAgentPrompt(agent.id).trim().length>500,agent.id);
 assert.equal(new Set(AGENTS.map(a=>agentSettingKey(a.id))).size,AGENTS.length);
 assert.equal(findAgent("PROMPT_SISTEMA")?.group,"active");assert.equal(findAgent("../settings"),undefined);
});
