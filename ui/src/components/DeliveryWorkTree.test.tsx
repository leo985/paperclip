import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeliveryPlan } from "@paperclipai/shared";
import { DeliveryWorkTree } from "./DeliveryWorkTree";
const plan: DeliveryPlan = { demandId:"1",demandNo:"SHYH-00043",title:"测试条目",status:"",roles:[],mains:[],scheduleCount:0,differences:[],fingerprint:"tree-test",sourceMode:"online_readonly",executionAllowed:false,items:[
  {key:"ATSES-1",parentKey:null,title:"待办主需求",type:"产品功能需求",status:"已发版",assignee:"负责人",scheduled:false},
  {key:"ATSES-2",parentKey:"ATSES-1",title:"设计评审",type:"设计评审",status:"待受理",assignee:"评审人",scheduled:true},
  {key:"ATSES-3",parentKey:"ATSES-1",title:"编码",type:"编码",status:"已完成",assignee:"研发",scheduled:true},
  {key:"ATSES-4",parentKey:null,title:"已完成主需求",type:"产品功能需求",status:"已发版",assignee:"负责人",scheduled:false},
  {key:"ATSES-5",parentKey:"ATSES-4",title:"测试",type:"功能测试",status:"已完成",assignee:"测试",scheduled:false},
] };
describe("delivery work tree",()=>{
  it("keeps pending review visible even when the parent is released, and collapses completed branches",()=>{
    const html=renderToStaticMarkup(<DeliveryWorkTree plan={plan}/>);
    expect(html).toContain('aria-label="收起 ATSES-1 的子工单" aria-expanded="true"');
    expect(html).toContain('aria-label="展开 ATSES-4 的子工单" aria-expanded="false"');
    expect(html).toContain('子单 1/2 已完成');expect(html).toContain('子单 1/1 已完成');
    expect(html.indexOf('ATSES-1')).toBeLessThan(html.indexOf('ATSES-2'));
    expect(html).not.toContain('<th scope="col" class="p-3">主工单</th>');
    expect(html).toContain('全部展开');expect(html).toContain('全部收起');
  });
  it("does not hide orphaned source work and explains empty snapshots",()=>{
    const html=renderToStaticMarkup(<DeliveryWorkTree plan={{...plan,items:[{...plan.items[1]!,parentKey:"MISSING-1"}]}}/>);
    expect(html).toContain("未匹配主工单的子单");expect(html).toContain("ATSES-2");
    expect(renderToStaticMarkup(<DeliveryWorkTree plan={{...plan,items:[]}}/>)).toContain("该来源版本暂无工单");
  });
});
