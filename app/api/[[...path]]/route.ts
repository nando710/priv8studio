import { route } from "../../../lib/server";
import { AppError } from "../../../lib/core";
export const dynamic="force-dynamic";
async function handler(req:Request,ctx:{params:Promise<{path?:string[]}>}){
 try{const result=await route(req,(await ctx.params).path||[]);return result instanceof Response?result:Response.json(result,{headers:{"Cache-Control":"no-store"}});}
 catch(e){return Response.json({error:e instanceof AppError?e.message:"Não foi possível concluir a operação."},{status:e instanceof AppError?e.status:500,headers:{"Cache-Control":"no-store"}});}
}
export {handler as GET,handler as POST,handler as DELETE};
