import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverDeliveryRoutes} from './delivery-api-contracts.mjs';
test('discovers composed, template and loop routes without treating handler loops or comments as routes',()=>{
 const source='const base="/companies/:companyId/source"; /* router.post("/fake",()=>{}); */ for(const operation of ["test","sync"] as const) router.post(base+"/"+operation,async(req,res)=>{for(const item of req.body.items) console.log(item)}); router.get(`${base}/:id`,()=>{});';
 assert.deepEqual(discoverDeliveryRoutes(source).map(({method,path})=>({method,path})),[
  {method:'post',path:'/companies/:companyId/source/test'}, {method:'post',path:'/companies/:companyId/source/sync'}, {method:'get',path:'/companies/:companyId/source/:id'},
 ]);
});
test('rejects unresolved runtime route expressions instead of silently losing coverage',()=>{
 assert.throws(()=>discoverDeliveryRoutes('router.post(runtimePath(),()=>{})'),/Unresolved route path/);
});

test('rejects ambiguous shadowed route bindings rather than choosing the last declaration',()=>{
 assert.throws(()=>discoverDeliveryRoutes('const base="/first"; function nested(){const base="/second";router.get(base,()=>{});}'),/Ambiguous route binding/);
});
