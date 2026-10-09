import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { AppError } from "./core";
import { teamDomain, verifyAccessToken } from "./access-auth";

export type User = {userId:string;email:string;displayName:string};
// "access" on a self-hosted Worker behind Cloudflare Access; otherwise the Sites dispatch (or the local mock) signs users in.
export const authMode = () => env.AUTH_MODE === "access" ? "access" : "chatgpt";

export async function currentUser():Promise<User|null> {
 if(authMode()==="chatgpt"){const u=await getChatGPTUser();return u&&{userId:u.userId,email:u.email,displayName:u.displayName};}
 if(!env.ACCESS_TEAM_DOMAIN||!env.ACCESS_AUD)throw new AppError(503,"Configure ACCESS_TEAM_DOMAIN e ACCESS_AUD no servidor.");
 const token=(await headers()).get("cf-access-jwt-assertion");
 const identity=token?await verifyAccessToken(token,teamDomain(env.ACCESS_TEAM_DOMAIN),env.ACCESS_AUD.trim()).catch(()=>null):null;
 if(!identity)throw new AppError(403,"Acesso não autorizado. Entre pelo login do Cloudflare Access e tente novamente.");
 return {...identity,displayName:identity.email};
}
// The first account becomes admin. With ADMIN_EMAIL set, only that email may claim it.
export function mayBootstrap(email:string) {
 if(env.ADMIN_EMAIL)return email.toLowerCase()===env.ADMIN_EMAIL.trim().toLowerCase();
 return env.ALLOW_PRIVATE_BOOTSTRAP==="true";
}
