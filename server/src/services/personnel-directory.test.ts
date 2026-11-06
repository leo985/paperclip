import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personnelDirectoryService } from "./personnel-directory.js";
vi.mock("./secrets.js",()=>({secretService:()=>({resolveSecretValue:async()=>"fixture-secret"})}));
vi.mock("../auth/personnel-passwords.js",()=>({initializePersonnelPasswords:async()=>({initialized:0})}));
afterEach(()=>vi.unstubAllGlobals());
describe("shared directory synchronization",()=>{
 it("imports identities and departments without granting membership in the legacy origin or any other organization",async()=>{
  const source={id:"source",companyId:"legacy-origin",type:"DingTalk",corpId:"corp",appKey:"key",secretId:"secret",syncScope:"1",enabled:true,updatedAt:new Date()};
  const writes:Array<{table:string;value:any}>=[];
  const rows:unknown[][]=[[source],[],[],[]];
  const db:any={
   select:()=>{const result=rows.shift();if(!result)throw Error("Unexpected select");const q:any={then:(yes:any,no:any)=>Promise.resolve(result).then(yes,no)};for(const name of ["from","where","for"])q[name]=()=>q;return q;},
   update:(table:any)=>({set:(value:any)=>({where:()=>({returning:async()=>[source],then:(yes:any)=>Promise.resolve(writes.push({table:getTableName(table),value})).then(yes)})})}),
   insert:(table:any)=>({values:(value:any)=>{writes.push({table:getTableName(table),value});return {then:(yes:any)=>Promise.resolve().then(yes),onConflictDoUpdate:async()=>{}};}}),
   transaction:async(fn:any)=>fn(db),
  };
  vi.stubGlobal("fetch",vi.fn()
   .mockResolvedValueOnce(Response.json({errcode:0,access_token:"token"}))
   .mockResolvedValueOnce(Response.json({errcode:0,id:1,name:"Development"}))
   .mockResolvedValueOnce(Response.json({errcode:0,userlist:[{userid:"external",name:"Developer"}],hasMore:false}))
   .mockResolvedValueOnce(Response.json({errcode:0,result:[]})));
  const result=await personnelDirectoryService(db as Db).sync("source","admin");
  expect(result).toMatchObject({newUsers:1,syncUserCount:1,departmentCount:1});
  expect(writes.some(w=>w.table==="user")).toBe(true);
  expect(writes.find(w=>w.table==="personnel_people")?.value).toMatchObject({active:true,externalId:"external"});
  expect(writes.some(w=>["company_memberships","principal_permission_grants"].includes(w.table))).toBe(false);
  expect(writes.find(w=>w.table==="activity_log")?.value).toMatchObject({action:"personnel.federation.synced",companyId:"legacy-origin"});
 });
});
