export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export const check = (condition: unknown, message: string, status = 400): asserts condition => { if (!condition) throw new AppError(status, message); };
export const WORKFLOW_ID = "2108613051860013058";
export const ACTIVE = ["preparing", "submitting", "unknown", "QUEUED", "RUNNING"];
// Prompts stream from the model for at most PROMPT_TIMEOUT_MS. A running attempt refreshes `updated`
// every PROMPT_HEARTBEAT_MS, so only an attempt that stopped refreshing is recovered.
export const PROMPT_TIMEOUT_MS = 9 * 60 * 1000;
export const PROMPT_HEARTBEAT_MS = 30 * 1000;
export const PROMPT_RECOVERY_MS = 2 * 60 * 1000;
// A crashed or disconnected prompt request must not hold a slot forever.
// Preserve both the charge and request key: recovery does not retry or imply a provider refund.
export const RECOVER_PROMPTS_SQL = `UPDATE jobs SET state='interrupted',updated=?,error=?
 WHERE kind='prompt' AND state IN ('preparing','submitting','unknown') AND updated<?`;
export function taskId(value: unknown): string | null {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  return /^\d{1,30}$/.test(String(value)) ? String(value) : null;
}
export function month(now = new Date()) { return new Intl.DateTimeFormat("en-CA", {timeZone:"America/Sao_Paulo", year:"numeric",month:"2-digit"}).format(now).slice(0,7); }
export function integer(value: unknown, min: number, max: number) {
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new AppError(400, `Use um inteiro entre ${min} e ${max}.`); return n;
}
export function cleanOptions(v: any = {}) {
  const quality = ["1080p", "2K", "4K"].includes(v.quality) ? v.quality : "1080p";
  return { quality, head: v.head !== false, tattoo: v.tattoo === true, mask: v.mask !== false, color: v.color === true,
    bust: [0,.6,1,1.5,2].includes(Number(v.bust)) ? Number(v.bust) : 0,
    count: integer(v.count ?? 1,1,2), steps: integer(v.steps ?? 8,6,12),
    seed: v.seed === "" || v.seed == null ? crypto.getRandomValues(new Uint32Array(1))[0] : integer(v.seed,0,4294967292),
    view: ["back","left","right"].includes(v.view) ? v.view : "none" };
}
export function price(options: ReturnType<typeof cleanOptions>, base = 10) {
  return base * options.count * (1 + Number(options.head) + Number(options.tattoo) + (options.quality === "4K" ? 2 : options.quality === "2K" ? 1 : 0));
}
export function parseOutput(response: any) {
  if (response?.code === 804) return { state: "RUNNING", outputs: [] };
  if (response?.code === 813) return { state: "QUEUED", outputs: [] };
  if (response?.code === 0 && Array.isArray(response.data) && response.data.length) {
    const outputs = response.data.filter((x: any) => typeof x.fileUrl === "string" && x.fileUrl.startsWith("https://")).map((x: any) => ({url:x.fileUrl, type:String(x.fileType||""),node:String(x.nodeId||"")}));
    if (outputs.length) return {state:"SUCCESS",outputs};
  }
  // An unknown provider response is NOT proof that an execution failed or deserves a refund.
  return {state:"unconfirmed",outputs:[]};
}
export const RESERVE_SQL = `INSERT INTO jobs (id,owner,request_key,kind,title,state,cost,charged,period,payload,created,updated)
 SELECT ?,a.id,?,?,?,'preparing',?,1,?,?,?,? FROM accounts a WHERE a.id=? AND a.active=1
 AND a.budget >= ? + COALESCE((SELECT SUM(j.cost) FROM jobs j WHERE j.owner=a.id AND j.period=? AND j.charged=1),0)
 AND (SELECT COUNT(*) FROM jobs j WHERE j.owner=a.id AND j.state IN ('preparing','submitting','unknown','QUEUED','RUNNING')) < a.concurrent
 AND (SELECT COUNT(*) FROM jobs j WHERE j.state IN ('preparing','submitting','unknown','QUEUED','RUNNING')) < ?
 ON CONFLICT(owner,request_key) DO NOTHING`;
