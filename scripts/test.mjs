import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync(".sites-runtime",{recursive:true});
await build({entryPoints:["tests/core.test.ts","tests/prompt-body.test.ts","tests/prompt-stream.test.ts"],bundle:true,platform:"node",format:"cjs",outdir:".sites-runtime",outExtension:{".js":".cjs"}});
const result=spawnSync(process.execPath,["--max-old-space-size=64","--test",".sites-runtime/core.test.cjs",".sites-runtime/prompt-body.test.cjs",".sites-runtime/prompt-stream.test.cjs"],{stdio:"inherit"});process.exitCode=result.status??1;
