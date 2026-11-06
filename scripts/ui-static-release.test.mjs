import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUiStaticReleaseFile, uiStaticManifest, verifyUiStaticManifest } from "./ui-static-release.mjs";
test("includes all prefixed frontend chunks and browser support; excludes only root client artifacts", () => {
  for (const name of ["assets/dsp7-seats-016mYpz1.js", "assets/dsp7-execution-BET5YgQq.js", "dsp7-browser-uuid.js", "assets/dsp7-install.py"]) assert.equal(isUiStaticReleaseFile(name), true, name);
  for (const name of ["dsp7-install.py", "dsp7-install.ps1", "dsp7-bridge.zip", "dsp7-bridge-manifest.json"]) assert.equal(isUiStaticReleaseFile(name), false, name);
});
test("manifest traverses assets instead of filtering basenames", async () => {
  const root=await mkdtemp(join(tmpdir(),"ui-release-test-"));
  try {
    await mkdir(join(root,"assets"));
    for (const name of ["index.html","assets/dsp7-seats-test.js","dsp7-install.py","dsp7-browser-uuid.js"]) await writeFile(join(root,name),"fixture");
    const files=await uiStaticManifest(root);
    assert.deepEqual(Object.keys(files).sort(),["assets/dsp7-seats-test.js","dsp7-browser-uuid.js","index.html"]);
  } finally {await rm(root,{recursive:true,force:true});}
});
test("verifier catches missing transitive modules, HTML fallback and mismatched content", async () => {
  const sha=createHash("sha256").update("module").digest("hex");
  const names=["assets/Layout.js","assets/dsp7-missing.js","assets/html-fallback.js","assets/stale.js"];
  const result=await verifyUiStaticManifest(Object.fromEntries(names.map(name=>[name,sha])),"http://localhost:3100",async url=>{
    if(url.pathname.includes("missing"))return new Response("",{status:404});
    if(url.pathname.includes("html"))return new Response("module",{headers:{"content-type":"text/html"}});
    return new Response(url.pathname.includes("stale")?"old":"module",{headers:{"content-type":"text/javascript"}});
  });
  assert.equal(result.verified,1);assert.equal(result.failures.length,3);
  assert.ok(result.failures.some(f=>f.error==="HTTP 404"));
  assert.ok(result.failures.some(f=>f.error==="JavaScript MIME mismatch"));
  assert.ok(result.failures.some(f=>f.error==="SHA-256 mismatch"));
});
