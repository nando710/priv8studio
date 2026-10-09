export async function readApiResponse(response: Response) {
 const text = await response.text(); let data: any;
 try { data = JSON.parse(text); } catch {
  throw new Error(response.ok ? "O servidor devolveu uma resposta inválida. Confira Execuções antes de tentar novamente." : `O servidor interrompeu a solicitação (HTTP ${response.status}). Confira Execuções antes de tentar novamente.`);
 }
 if (!response.ok) throw Object.assign(new Error(data.error || "Não foi possível concluir."), {status:response.status});
 return data;
}
// Reads newline-delimited JSON events; returns the final "done" event and reports the others as they arrive.
export async function readApiStream(response: Response, onEvent: (event: any) => void) {
 if (!response.ok || !response.body || !(response.headers.get("content-type") || "").includes("ndjson")) return readApiResponse(response);
 const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", last: any = null;
 const line = (text: string) => { if (!text.trim()) return; let event: any; try { event = JSON.parse(text); } catch { return; } if (event.type === "done") last = event; else onEvent(event); };
 try {
  while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let index; while ((index = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); } }
 } catch { last = null; }
 line(buffer + decoder.decode());
 if (!last) throw new Error("A conexão caiu antes do fim da geração. Se o prompt ficar pronto, ele aparece em Execuções.");
 return last;
}
