import test from "node:test";
import assert from "node:assert/strict";
import { parseAdjustments, refineNote, settingsList } from "../lib/refine";

test("keeps only known settings with values inside their range",()=>{
 const text=`<prompt>x</prompt><notas>- ok</notas><ajustes>[{"id":"steps","valor":10,"motivo":"mais detalhe"},{"id":"bust","valor":0.6,"motivo":"busto exagerado"},{"id":"steps","valor":30},{"id":"seed","valor":1},{"id":"bust","valor":0.7}]</ajustes>`;
 assert.deepEqual(parseAdjustments(text),[{id:"steps",valor:10,motivo:"mais detalhe"},{id:"bust",valor:0.6,motivo:"busto exagerado"}]);
 assert.deepEqual(parseAdjustments("<ajustes>not json</ajustes>"),[]);
 assert.deepEqual(parseAdjustments("<ajustes>{\"id\":\"steps\"}</ajustes>"),[]);
 assert.deepEqual(parseAdjustments("sem bloco"),[]);
 assert.deepEqual(parseAdjustments(`<ajustes>[{"id":"steps","valor":7.5}]</ajustes>`),[],"steps must be an integer");
});

test("the refine request carries the current blocks, the request and the current settings",()=>{
 const note=refineNote({prompt:"body_swap: Use <image1>.",headPrompt:"head_swap: start with <image1>.",instructions:"a tatuagem do braço saiu simplificada",views:["BACK VIEW"],options:{steps:8,bust:0}});
 assert.match(note,/^Extra views sent: BACK VIEW\./);
 assert.match(note,/<prompt>\nbody_swap: Use <image1>\.\n\nhead_swap: start with <image1>\.\n<\/prompt>/);
 assert.match(note,/Operator request \(what to improve\): a tatuagem do braço saiu simplificada/);
 assert.match(note,/- steps: .*current value 8/);assert.match(note,/- bust: .*one of 0, 0.6, 1, 1.5, 2; current value 0/);
 assert.doesNotMatch(refineNote({prompt:"p",headPrompt:"",instructions:"x",views:[],options:{steps:8,bust:0}}),/Extra views|\n\n<\/prompt>/);
 assert.match(settingsList({steps:12,bust:2}),/an integer from 6 to 12; current value 12/);
});
