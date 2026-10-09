// Verifies the identity Cloudflare Access attaches to each request (Cf-Access-Jwt-Assertion).
// Never trust the email header alone: only a token signed by the team's Access keys proves who the visitor is.
export type AccessIdentity = {userId:string;email:string};
type Jwk = JsonWebKey & {kid?:string};
const decoder = new TextDecoder();
const bytes = (s:string) => { const b=s.replace(/-/g,"+").replace(/_/g,"/"); return Uint8Array.from(atob(b+"===".slice((b.length+3)%4)),c=>c.charCodeAt(0)); };
const json = (s:string) => JSON.parse(decoder.decode(bytes(s)));
// Accepts "team", "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/".
export function teamDomain(value:string) { const host=value.trim().replace(/^https?:\/\//,"").replace(/\/.*$/,"").toLowerCase(); return host.includes(".")?host:`${host}.cloudflareaccess.com`; }

export type KeySource = (team:string,refresh:boolean)=>Promise<Jwk[]>;
let cached:{team:string;keys:Jwk[];at:number}|null=null;
export const accessKeys:KeySource = async (team,refresh) => {
 if(!refresh&&cached?.team===team&&Date.now()-cached.at<3600_000)return cached.keys;
 const res=await fetch(`https://${team}/cdn-cgi/access/certs`,{signal:AbortSignal.timeout(10_000)});
 if(!res.ok)throw new Error(`Access certs HTTP ${res.status}`);
 const keys=((await res.json() as any)?.keys||[]) as Jwk[];cached={team,keys,at:Date.now()};return keys;
};

export async function verifyAccessToken(token:string,team:string,audience:string,keySource:KeySource=accessKeys,now=Date.now()):Promise<AccessIdentity|null> {
 const parts=token.split(".");if(parts.length!==3)return null;
 let header:any,payload:any;try{header=json(parts[0]);payload=json(parts[1]);}catch{return null;}
 if(header?.alg!=="RS256"||typeof header.kid!=="string")return null;
 const domain=teamDomain(team);
 // Keys rotate: refetch once when the kid is unknown.
 let key=(await keySource(domain,false)).find(k=>k.kid===header.kid);
 if(!key)key=(await keySource(domain,true)).find(k=>k.kid===header.kid);
 if(!key)return null;
 const algorithm={name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"};
 const publicKey=await crypto.subtle.importKey("jwk",{kty:key.kty,n:key.n,e:key.e},algorithm,false,["verify"]);
 const valid=await crypto.subtle.verify(algorithm,publicKey,bytes(parts[2]),new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
 if(!valid)return null;
 const seconds=now/1000,skew=60,audiences=Array.isArray(payload.aud)?payload.aud:[payload.aud];
 if(payload.iss!==`https://${domain}`||!audiences.includes(audience))return null;
 if(typeof payload.exp!=="number"||payload.exp+skew<seconds||(typeof payload.nbf==="number"&&payload.nbf-skew>seconds))return null;
 // Service tokens carry no email; this app only admits people.
 if(typeof payload.email!=="string"||!payload.email.includes("@")||typeof payload.sub!=="string"||!payload.sub)return null;
 return {userId:`access:${payload.sub}`,email:payload.email.toLowerCase()};
}
