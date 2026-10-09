import test from "node:test";
import assert from "node:assert/strict";
import { verifyAccessToken, teamDomain } from "../lib/access-auth";

const algorithm={name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"};
const b64url=(data:Uint8Array|string)=>Buffer.from(data).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const team="priv8.cloudflareaccess.com",aud="aud-tag",now=1_800_000_000_000;
async function setup(){
 const pair=await crypto.subtle.generateKey(algorithm,true,["sign","verify"]) as CryptoKeyPair;
 const jwk={...await crypto.subtle.exportKey("jwk",pair.publicKey),kid:"k1"};
 let fetches=0;const keys=async()=>{fetches++;return [jwk];};
 const sign=async(payload:any,kid="k1",key=pair.privateKey)=>{const head=b64url(JSON.stringify({alg:"RS256",kid}))+"."+b64url(JSON.stringify(payload));return head+"."+b64url(new Uint8Array(await crypto.subtle.sign(algorithm,key,new TextEncoder().encode(head))));};
 const claims={iss:`https://${team}`,aud:[aud],sub:"user-1",email:"Dona@Exemplo.com",exp:now/1000+600,nbf:now/1000-10};
 return {sign,keys,claims,fetches:()=>fetches};
}

test("accepts a valid Access token and normalizes the identity",async()=>{
 const {sign,keys,claims}=await setup();
 assert.deepEqual(await verifyAccessToken(await sign(claims),team,aud,keys,now),{userId:"access:user-1",email:"dona@exemplo.com"});
 assert.equal(teamDomain("https://Priv8.cloudflareaccess.com/"),team);assert.equal(teamDomain("priv8"),team);
});

test("rejects forged, foreign, expired and email-less tokens",async()=>{
 const {sign,keys,claims}=await setup();
 const other=(await crypto.subtle.generateKey(algorithm,true,["sign","verify"]) as CryptoKeyPair).privateKey;
 const check=async(token:string)=>verifyAccessToken(token,team,aud,keys,now);
 assert.equal(await check(await sign(claims,"k1",other)),null,"signed by another key");
 const good=await sign(claims);const [h,,s]=good.split(".");
 assert.equal(await check(`${h}.${b64url(JSON.stringify({...claims,email:"intruso@x.com"}))}.${s}`),null,"tampered payload");
 assert.equal(await check(await sign({...claims,aud:["other-app"]})),null,"other application");
 assert.equal(await check(await sign({...claims,iss:"https://evil.cloudflareaccess.com"})),null,"other team");
 assert.equal(await check(await sign({...claims,exp:now/1000-120})),null,"expired");
 assert.equal(await check(await sign({...claims,email:undefined})),null,"service token");
 assert.equal(await check("not.a.token"),null);
 const none=b64url(JSON.stringify({alg:"none",kid:"k1"}))+"."+b64url(JSON.stringify(claims))+".";
 assert.equal(await check(none),null,"alg none");
});

test("refetches keys once when Access rotates them",async()=>{
 const {sign,keys,claims,fetches}=await setup();
 assert.equal(await verifyAccessToken(await sign(claims,"unknown"),team,aud,keys,now),null);
 assert.equal(fetches(),2);
});
