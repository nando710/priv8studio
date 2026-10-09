import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync(".sites-runtime",{recursive:true});
await build({entryPoints:["tests/core.test.ts"],bundle:true,platform:"node",format:"cjs",outfile:".sites-runtime/core.test.cjs"});
const result=spawnSync(process.execPath,["--test",".sites-runtime/core.test.cjs"],{stdio:"inherit"});process.exitCode=result.status??1;
