import { Buffer } from "node:buffer";

export type PromptImage = { label: string; mime: string; open: () => Promise<ReadableStream<Uint8Array>> };
const encoder = new TextEncoder();
// Multiples of three preserve base64 alignment between streamed chunks.
const CHUNK_BYTES = 24 * 1024;
export const MAX_OUTPUT_TOKENS = 32000;
// The API caps the whole request near 50 MB; base64 adds a third, so raw images must stay below this.
export const PROMPT_IMAGE_BYTES = 36_000_000;
async function* imageBase64(stream: ReadableStream<Uint8Array>) {
 const reader = stream.getReader(); let carry = new Uint8Array(0); let complete = false;
 try {
  while (true) {
   const { value, done } = await reader.read(); if (done) { complete = true; break; }
   for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
    const part = value.subarray(offset, offset + CHUNK_BYTES);
    const bytes = new Uint8Array(carry.length + part.length); bytes.set(carry); bytes.set(part, carry.length);
    const end = bytes.length - bytes.length % 3;
    if (end) yield Buffer.from(bytes.buffer, bytes.byteOffset, end).toString("base64");
    carry = bytes.slice(end);
   }
  }
  if (carry.length) yield Buffer.from(carry).toString("base64");
 } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export type PromptFormat = "responses" | "chat";
// The Responses API (OpenAI, xAI) or Chat Completions, which almost every OpenAI-compatible gateway accepts.
const FORMATS = {
 responses: {
  open: (model: string, instructions: string) => JSON.stringify({ model, instructions, store: false, stream: true, max_output_tokens: MAX_OUTPUT_TOKENS }).slice(0,-1) + ',"input":[{"role":"user","content":[',
  text: (text: string) => JSON.stringify({type:"input_text",text}),
  image: (mime: string) => '{"type":"input_image","detail":"high","image_url":"data:' + mime + ';base64,',
  imageEnd: '"}',
 },
 chat: {
  open: (model: string, instructions: string) => JSON.stringify({ model, stream: true, max_tokens: MAX_OUTPUT_TOKENS }).slice(0,-1) + ',"messages":[' + JSON.stringify({role:"system",content:instructions}) + ',{"role":"user","content":[',
  text: (text: string) => JSON.stringify({type:"text",text}),
  image: (mime: string) => '{"type":"image_url","image_url":{"detail":"high","url":"data:' + mime + ';base64,',
  imageEnd: '"}}',
 },
};

export function promptBody(model: string, instructions: string, note: string, images: PromptImage[], format: PromptFormat = "responses") {
 const f = FORMATS[format];
 async function* chunks() {
  // Streaming keeps the connection active while the model reasons. Reasoning tokens count toward
  // max_output_tokens, so the budget must cover reasoning plus the long 13/14-paragraph prompt.
  yield f.open(model, instructions);
  let first = true;
  for (const image of images) {
   if (!/^image\/(png|jpeg|webp)$/.test(image.mime)) throw new Error("Unsupported image type");
   if (!first) yield ','; first = false;
   yield f.text(image.label) + ',' + f.image(image.mime);
   yield* imageBase64(await image.open());
   yield f.imageEnd;
  }
  if (!first) yield ',';
  yield f.text(note) + ']}]}';
 }
 const iterator = chunks();
 return new ReadableStream<Uint8Array>({
  async pull(controller) { try { const next = await iterator.next(); if(next.done)controller.close();else controller.enqueue(encoder.encode(next.value)); } catch(e) {controller.error(e);} },
  async cancel() { await iterator.return(undefined); }
 }, {highWaterMark:0});
}
