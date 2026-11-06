import {describe,expect,it,vi} from "vitest";
import {readQingzhouOrganizations} from "./qingzhou-organizations.js";
function source(options:{incomplete?:boolean;malformed?:boolean;empty?:boolean}={}) {
  return vi.fn(async(target:any,init?:RequestInit)=>{
    if(String(target).includes('/api/auth/login'))return new Response(JSON.stringify({accessToken:'fixture-token'}));
    expect(new URL(String(target)).searchParams.get('uc')).toBe('UC_PROJ2_ALLOT_ORG_SEARCH');
    const kind=(init?.body as URLSearchParams).get('code');expect(['researchGroup','testGroup']).toContain(kind);
    const rows=options.empty?[]:[{urid:'2027066154865016833',orgName:'企金开发七组',orgCode:'D00011608',deleted:0},{urid:'99',orgName:'已删除组织',deleted:1},...(kind==='testGroup'?[{urid:12,orgName:'测试组',orgCode:'QA'}]:[])];
    if(options.malformed)rows[0].urid='rounded-invalid';
    return new Response(JSON.stringify({success:true,code:'0',rows,total:rows.length+(options.incomplete?1:0)}));
  });
}
describe('Qingzhou organization selection',()=>{
  const input={credentials:async()=>({username:'fixture-user',password:'fixture-password'})};
  it('reads both dictionary contracts, preserves long ids and merges shared identities',async()=>{
    const fetcher=source();const r=await readQingzhouOrganizations(input,fetcher as typeof fetch);
    expect(r.items).toHaveLength(2);expect(r.items.find(i=>i.id==='2027066154865016833')).toMatchObject({name:'企金开发七组',code:'D00011608',kinds:['researchGroup','testGroup']});
    expect(fetcher).toHaveBeenCalledTimes(3);expect(JSON.stringify(r)).not.toMatch(/fixture-token|fixture-password|fixture-user/);
  });
  it('distinguishes empty choices from incomplete or malformed upstream data',async()=>{
    expect((await readQingzhouOrganizations(input,source({empty:true}) as typeof fetch)).items).toEqual([]);
    await expect(readQingzhouOrganizations(input,source({incomplete:true}) as typeof fetch)).rejects.toMatchObject({code:'incomplete_response'});
    await expect(readQingzhouOrganizations(input,source({malformed:true}) as typeof fetch)).rejects.toMatchObject({code:'invalid_response'});
  });
});
