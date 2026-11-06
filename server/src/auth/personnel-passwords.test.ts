import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { initializePersonnelPasswords } from "./personnel-passwords.js";
vi.mock("better-auth/crypto",()=>({hashPassword:async()=>"hashed-fixture-password"}));
function fixture(member:boolean){
 const person={id:"person",sourceId:"source",companyId:"origin-a",userId:"account",active:true,managedAccount:true};
 const results:unknown[][]=[[{id:"person"}],[person],[{id:"source",enabled:true}],member?[{companyId:"member-b"}]:[],...(member?[[{id:"account"}],[]]:[])];
 const predicates:Array<{sql:string;params:unknown[]}>=[],writes:Array<{table:string;value:any}>=[];
 const db:any={
  select:()=>{const result=results.shift();if(!result)throw Error("Unexpected select");const q:any={then:(yes:any,no:any)=>Promise.resolve(result).then(yes,no)};for(const name of ["from","innerJoin","for"])q[name]=()=>q;q.where=(condition:any)=>{predicates.push(new PgDialect().sqlToQuery(condition));return q;};return q;},
  insert:(table:any)=>({values:async(value:any)=>{writes.push({table:getTableName(table),value});}}),
  update:(table:any)=>({set:(value:any)=>({where:async()=>{writes.push({table:getTableName(table),value});}})}),
  transaction:async(fn:any)=>fn(db),
 };
 return {db:db as Db,predicates,writes};
}
describe("shared identity password initialization",()=>{
 it("accepts membership outside the directory's legacy origin without granting new access",async()=>{
  const {db,predicates,writes}=fixture(true);expect(await initializePersonnelPasswords(db,"source")).toEqual({initialized:1});
  const membership=predicates.find(p=>p.sql.includes('"company_memberships"'))!;
  expect(membership.sql).not.toContain('"company_id"');expect(membership.params).toEqual(["user","account","active"]);
  expect(writes.find(w=>w.table==="account")?.value).toMatchObject({userId:"account",password:"hashed-fixture-password"});
  expect(writes.some(w=>w.table==="company_memberships")).toBe(false);
 });
 it("does not initialize login credentials for unassigned shared directory identities",async()=>{
  const {db,writes}=fixture(false);expect(await initializePersonnelPasswords(db,"source")).toEqual({initialized:0});expect(writes).toEqual([]);
 });
});
