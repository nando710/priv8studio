export async function readApiResponse(response: Response) {
 const text = await response.text(); let data: any;
 try { data = JSON.parse(text); } catch {
  throw new Error(response.ok ? "O servidor devolveu uma resposta inválida. Confira Execuções antes de tentar novamente." : `O servidor interrompeu a solicitação (HTTP ${response.status}). Confira Execuções antes de tentar novamente.`);
 }
 if (!response.ok) throw Object.assign(new Error(data.error || "Não foi possível concluir."), {status:response.status});
 return data;
}
