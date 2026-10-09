// Builds and deploys PRIV8 Studio to your own Cloudflare account: D1 migrations, Worker, assets and secrets.
// Usage: set the variables below (see DEPLOY.md), then `node scripts/deploy-cloudflare.mjs [--dry-run]`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
env.CF_D1_DATABASE_NAME ||= "priv8studio";

const required = ["CF_D1_DATABASE_ID", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_EMAIL",
  ...(dryRun ? [] : ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])];
const missing = required.filter((name) => !env[name]?.trim());
if (missing.length) {
  console.error(`Faltam variáveis: ${missing.join(", ")}. Veja DEPLOY.md.`);
  process.exit(1);
}

const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
function run(label, file, args) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(process.execPath, [file, ...args], { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`✖ Falhou: ${label}`);
    process.exit(result.status ?? 1);
  }
}

run("Build", path.join(root, "scripts/run-framework.mjs"), ["build"]);
const workerConfig = path.join(root, "dist/server/wrangler.json");

// The Worker keeps CREDENTIAL_ENCRYPTION_KEY across deploys. Create one only when the Worker has none yet;
// replacing an existing key would make the saved RunningHub/OpenAI keys unreadable.
function encryptionKeyToCreate() {
  if (dryRun || env.CREDENTIAL_ENCRYPTION_KEY) return env.CREDENTIAL_ENCRYPTION_KEY || "";
  const result = spawnSync(process.execPath, [wrangler, "secret", "list", "--format", "json", "--config", workerConfig], { cwd: root, env, encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    const names = JSON.parse(result.stdout.slice(result.stdout.indexOf("["))).map((secret) => secret.name);
    if (names.includes("CREDENTIAL_ENCRYPTION_KEY")) return "";
  } else if (!/10007|does not exist|not found/i.test(output)) {
    console.error(output);
    console.error("✖ Não foi possível conferir os segredos do Worker.");
    process.exit(1);
  }
  console.log("\n▶ Criando CREDENTIAL_ENCRYPTION_KEY (primeira publicação)");
  return randomBytes(32).toString("base64");
}

const temp = path.join(root, ".wrangler/deploy");
mkdirSync(temp, { recursive: true });
try {
  if (!dryRun) {
    // Wrangler applies drizzle/*.sql in order and records them in the d1_migrations table.
    const migrations = path.join(temp, "migrations.json");
    writeFileSync(migrations, JSON.stringify({
      name: env.CF_WORKER_NAME || "priv8studio",
      d1_databases: [{ binding: "DB", database_name: env.CF_D1_DATABASE_NAME, database_id: env.CF_D1_DATABASE_ID, migrations_dir: path.join(root, "drizzle") }],
    }));
    run("Migrações do banco D1", wrangler, ["d1", "migrations", "apply", "DB", "--remote", "--config", migrations]);
  }
  const deploy = ["deploy", "--config", workerConfig];
  if (dryRun) deploy.push("--dry-run");
  const key = encryptionKeyToCreate();
  if (key && !dryRun) {
    const secrets = path.join(temp, "secrets.json");
    writeFileSync(secrets, JSON.stringify({ CREDENTIAL_ENCRYPTION_KEY: key }), { mode: 0o600 });
    deploy.push("--secrets-file", secrets);
  }
  run(dryRun ? "Verificação do Worker (sem publicar)" : "Publicação do Worker", wrangler, deploy);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(dryRun ? "\n✔ Verificação concluída." : "\n✔ Publicado.");
