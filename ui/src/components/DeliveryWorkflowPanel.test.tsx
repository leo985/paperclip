// @vitest-environment jsdom
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_DELIVERY_TEMPLATE,type DeliverySavedAutomaticPlan,type DeliverySnapshot} from '@paperclipai/shared';
import {DeliveryWorkflowPanel} from './DeliveryWorkflowPanel';
const mocks=vi.hoisted(()=>({
 seats:[] as any[],workflows:[] as any[],start:vi.fn(),
 savedPlan: null as DeliverySavedAutomaticPlan | null,
 planPending: false, planError: false, refetchPlan: vi.fn(),
}));
vi.mock('@/lib/router',()=>({Link:({children}:any)=><span>{children}</span>}));
vi.mock("./AutomaticDeliveryStart",()=>({AutomaticDeliveryStart:()=> <div>自动计划预览</div>}));
vi.mock('./DeliveryRepairControls',()=>({DeliveryRepairControls:()=>null}));
vi.mock('@/api/delivery-workflows',async (importOriginal)=>({
 ...await importOriginal<typeof import("@/api/delivery-workflows")>(),
 deliveryWorkflowApi:{start:(...args:any[])=>mocks.start(...args),list:vi.fn(),seats:vi.fn()},
}));
vi.mock('@tanstack/react-query',()=>({
 useQueryClient:()=>({invalidateQueries:vi.fn()}),
 useQuery:({queryKey}:any)=>queryKey[0]==='delivery-plan-preview'
  ? {data:mocks.savedPlan,isPending:mocks.planPending,isError:mocks.planError,refetch:mocks.refetchPlan}
  : {data:queryKey[0]==='delivery-workflows'?mocks.workflows:queryKey[0]==='delivery-workflow-seats'?mocks.seats:{effective:{id:'template',revision:1,definition}},isSuccess:true,refetch:vi.fn()},
 useMutation:({mutationFn}:any)=>({mutate:()=>mutationFn(),isPending:false}),
}));
const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);for(const [key,value] of Object.entries(definition.stages))value.enabled=key==='coding';definition.stages.coding.taskSequence='work_only';delete definition.stages.coding.workExecution;
const snapshot={id:'snapshot',projectId:'project',plan:{items:[{key:'DEV-1',parentKey:'MAIN-1',type:'编码',title:'开发',status:'待受理',assignee:'张三'}]}} as DeliverySnapshot;
let cleanup=()=>{};afterEach(()=>{cleanup();mocks.start.mockClear();mocks.workflows=[];mocks.savedPlan=null;mocks.planPending=false;mocks.planError=false;mocks.refetchPlan.mockClear();definition.stages.coding.taskSequence="work_only";});
async function mountReview(extraItems: DeliverySnapshot["plan"]["items"] = []) {
 const reviewSnapshot={...snapshot,plan:{...snapshot.plan,items:[...snapshot.plan.items,...extraItems,{key:"REVIEW-1",parentKey:"MAIN-1",type:"代码评审",title:"独立评审",status:"待受理",assignee:"评审人"}]}} as DeliverySnapshot;
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 flushSync(()=>root.render(<DeliveryWorkflowPanel companyId="company" snapshot={reviewSnapshot} canManage startRequested initialReviewKey="REVIEW-1"/>));
 cleanup=()=>{flushSync(()=>root.unmount());node.remove();};
 return node;
}

it('explains a missing independent review policy without changing the template',async()=>{
 const node=await mountReview();expect(node.textContent).toContain('项目模板尚未启用该阶段的独立评审工单');
 expect(definition.stages.coding.taskSequence).toBe('work_only');expect(mocks.start).not.toHaveBeenCalled();
});
it('opens automatic review planning without configurable ticket or dependency fields',async()=>{
 definition.stages.coding.taskSequence='work_then_review';const node=await mountReview();
 await vi.waitFor(()=>expect(node.textContent).toContain('自动计划预览'));
 expect(node.textContent).toContain('同一主工单下对应阶段的全部工作子单完成');
 expect(node.textContent).not.toContain('高级：手动配置例外');
 expect(node.querySelectorAll('select')).toHaveLength(0);
 expect(node.querySelector('form')).toBeNull();
 expect(mocks.start).not.toHaveBeenCalled();
});
it('links the existing workflow review without creating a second execution',async()=>{
 mocks.workflows=[{id:'flow',state:'active',config:{template:{definition,revision:1}},stages:[{stage:'coding',intent:'code-review',jiraKey:'REVIEW-1',taskId:'review-task',state:'pending',seatId:'mine',ownerUserId:'owner'}]}];
 const node=await mountReview();expect(node.textContent).toContain('查看已有评审任务与处理记录');
 expect(node.textContent).toContain('已有评审沿用当前流程');expect(mocks.start).not.toHaveBeenCalled();
});

it('shows automatic planning as the sole start entry',async()=>{
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 flushSync(()=>root.render(<DeliveryWorkflowPanel companyId="company" snapshot={snapshot} canManage startRequested/>));
 cleanup=()=>{flushSync(()=>root.unmount());node.remove();};
 await vi.waitFor(()=>expect(node.textContent).toContain('自动计划预览'));
 for(const text of ['高级：手动配置例外','此前已完成','添加编码单','添加其他评审绑定']) expect(node.textContent).not.toContain(text);
 expect(node.querySelector('form')).toBeNull();
});

it('distinguishes human work submission from an approval verdict',async()=>{
 mocks.workflows=[{id:'flow',state:'active',config:{template:{definition,revision:1}},stages:[{stage:'coding',jiraKey:'REVIEW-1',taskId:'human-task',state:'review',executionMode:'human',seatId:'',ownerUserId:'owner',reviewerUserId:'owner',requiresReview:true,inputDigest:'a'.repeat(64)}]}];
 const node=await mountReview();
 expect(node.textContent).toContain('待人工办理');
 expect(node.querySelector('[aria-label="人工办理结果"]')).not.toBeNull();
 expect(node.querySelector('[aria-label="评审结论"]')).toBeNull();
 expect(node.querySelector('[id="delivery-node-human-task"]')).not.toBeNull();
});

it("reopens planning for the remaining mains from an existing partially delivered workflow", async () => {
 const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
 const entry = { ...snapshot, plan: { ...snapshot.plan, mains: [
  { key: "MAIN-1", sourceId: "1", title: "第一主单" }, { key: "MAIN-2", sourceId: "2", title: "第二主单" },
 ] } };
 mocks.workflows = [{ id: "flow", state: "active", config: { entryScope: { branches: { "MAIN-1": { digest: "scope", snapshotId: "snapshot" } } } },
  stages: [{ stage: "coding", jiraKey: "DEV-1", parentKey: "MAIN-1", taskId: "done-work", state: "done" }],
 }];
 flushSync(() => root.render(<DeliveryWorkflowPanel companyId="company" snapshot={entry} canManage />));
 cleanup = () => { flushSync(() => root.unmount()); node.remove(); };
 expect(node.textContent).toContain("部分交付");
 const button = [...node.querySelectorAll("button")].find(item => item.textContent === "查看计划")!;
 flushSync(() => button.click());
 await vi.waitFor(() => expect(node.textContent).toContain("自动计划预览"));
 expect(mocks.start).not.toHaveBeenCalled();
});

function mountPlanButton(viewPlanRequest?: string) {
 const node = document.createElement("div");
 document.body.append(node);
 const root = createRoot(node);
 const render = () => flushSync(() => root.render(
  <DeliveryWorkflowPanel companyId="company" snapshot={snapshot} canManage viewPlanRequest={viewPlanRequest} />,
 ));
 render();
 cleanup = () => { flushSync(() => root.unmount()); node.remove(); };
 const button = (label: string) => [...node.querySelectorAll("button")].find(item => item.textContent === label);
 return {node, render, button};
}

it("offers viewing an already saved delivery plan before a workflow is started", () => {
 mocks.savedPlan = {
  input: { snapshotId: snapshot.id, environmentReference: "" },
  plan: { digest: "saved-plan", ready: false } as DeliverySavedAutomaticPlan["plan"],
 };
 const {node, button} = mountPlanButton();
 expect(node.querySelector("h2")?.textContent).toBe("交付计划");
 expect(button("生成交付计划")).toBeUndefined();
 flushSync(() => button("查看计划")!.click());
 expect(node.textContent).toContain("自动计划预览");
 flushSync(() => button("收起计划")!.click());
 expect(button("查看计划")).toBeDefined();
});

it("opens an existing plan from a work link but waits for explicit generation if no plan exists", async () => {
 const {node, render, button} = mountPlanButton("work-link");
 expect(button("生成交付计划")).toBeDefined();
 expect(node.textContent).not.toContain("自动计划预览");
 mocks.savedPlan = {
  input: { snapshotId: snapshot.id, environmentReference: "" },
  plan: { digest: "saved-plan", ready: false } as DeliverySavedAutomaticPlan["plan"],
 };
 render();
 await vi.waitFor(() => expect(node.textContent).toContain("自动计划预览"));
 expect(button("收起计划")).toBeDefined();
});

it("only offers generation after the lookup confirms that there is no saved plan", () => {
 mocks.planPending = true;
 const {button, render} = mountPlanButton();
 expect(button("正在读取交付计划…")?.disabled).toBe(true);
 expect(button("生成交付计划")).toBeUndefined();
 mocks.planPending = false;
 mocks.planError = true;
 render();
 expect(button("生成交付计划")).toBeUndefined();
 flushSync(() => button("重试读取交付计划")!.click());
 expect(mocks.refetchPlan).toHaveBeenCalledOnce();
 mocks.planError = false;
 render();
 expect(button("生成交付计划")?.disabled).toBe(false);
});
