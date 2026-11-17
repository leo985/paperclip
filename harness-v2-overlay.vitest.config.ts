import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root=dirname(fileURLToPath(import.meta.url));
const overlay=process.env.HARNESS_SERVICE_OVERLAY;
const baseline=process.env.HARNESS_PRODUCTION_BASELINE;
if(!overlay||!baseline)throw new Error("Explicit overlay and captured baseline required");
const artifact=resolve(overlay),captured=resolve(baseline),prefix="node_modules/@paperclipai/";
const manifest=JSON.parse(readFileSync(resolve(artifact,"manifest.json"),"utf8"));
for(const file of manifest.files){
  const hash=createHash("sha256").update(readFileSync(resolve(artifact,file.path))).digest("hex");
  if(hash!==file.sha256)throw new Error("Overlay changed: "+file.path);
}
const digest=(data:Buffer)=>createHash("sha256").update(data).digest("hex");
if(digest(readFileSync(resolve(captured,"manifest.json")))!==manifest.baselineManifestSha256)throw new Error("Captured baseline manifest changed");
for(const file of JSON.parse(readFileSync(resolve(captured,"manifest.json"),"utf8")).files){
 if(!file.missing&&digest(readFileSync(resolve(captured,file.path)))!==file.sha256)throw new Error("Captured production file changed: "+file.path);
}
for(const [file,hash] of Object.entries(manifest.sourceHashes)){
 if(digest(readFileSync(resolve(root,file)))!==hash)throw new Error("Candidate source changed: "+file);
}
const mappings=new Map<string,string>();
for(const file of manifest.files){
  const suffix=file.path.slice(prefix.length);
  if(suffix.startsWith("server/dist/"))mappings.set(resolve(root,suffix.replace("server/dist/","server/src/").replace(/\.js$/,".ts")),resolve(artifact,file.path));
}
const sharedFiles=["managed-sessions","harness-observation","harness-bundles","harness-observer-binding"];
const shim="\0harness-overlay-shared";
const sharedShim='export * from '+JSON.stringify(resolve(root,"packages/shared/src/index.ts"))+';\n'+sharedFiles.map(name=>{
 const path=resolve(artifact,prefix+"shared/dist/"+name+".js");
 const names=[...readFileSync(path,"utf8").matchAll(/^export (?:const|function|class) (\w+)/gm)].map(m=>m[1]);
 return `export {${names.join(",")}} from ${JSON.stringify(path)};`;
}).join("\n");
const require=createRequire(resolve(root,"server/package.json"));
export default defineConfig({
 plugins:[{name:"verify-captured-runtime-overlay",enforce:"pre",
  resolveId(id,importer){
   if(id==="@paperclipai/shared")return shim;
   if(!importer||!id.startsWith("."))return null;
   const absolute=resolve(dirname(importer),id);
   const mapped=mappings.get(absolute.replace(/\.js$/,".ts"));
   if(mapped)return mapped;
   if(importer.startsWith(artifact)||importer.startsWith(captured)){
    if(existsSync(absolute))return absolute;
    const origin=importer.startsWith(artifact)?artifact:captured;
    const rel=relative(origin,absolute);
    if(existsSync(resolve(captured,rel)))return resolve(captured,rel);
    const local=rel.replace(/^node_modules\/@paperclipai\/server\/dist\//,"server/src/").replace(/\.js$/,".ts");
    if(existsSync(resolve(root,local)))return resolve(root,local);
   }
   return null;
  },load(id){if(id===shim)return sharedShim;
   if(id.startsWith(captured)&&id.endsWith(".js"))return readFileSync(id,"utf8").replace(/^\/\/# sourceMappingURL=.*$/gm,"");
   return null;}}],
 resolve:{alias:[
  {find:/^@paperclipai\/db$/,replacement:resolve(root,"packages/db/src/index.ts")},
  {find:/^@paperclipai\/db\/(.+)$/,replacement:resolve(root,"packages/db/src")+"/$1.ts"},
  ...["express","zod","drizzle-orm"].map(name=>({find:new RegExp("^"+name+"$"),replacement:require.resolve(name)})),
 ]},
 test:{server:{deps:{inline:[/service-(?:binding-)?overlay-/,/production-(?:binding-)?baseline-/]}},include:["server/src/routes/harness-observer-dispatch.test.ts","server/src/services/seat-execution-permits.test.ts","server/src/services/harness-observer-binding.test.ts","server/src/__tests__/harness-v2-rollout.test.ts","server/src/__tests__/harness-observation-routes.test.ts","server/src/routes/harness-bundles.test.ts","server/src/routes/harness-capabilities.test.ts"],
  environment:"node",setupFiles:["./server/src/__tests__/setup-supertest.ts"],testTimeout:30000,maxWorkers:1},
});
