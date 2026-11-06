// @vitest-environment jsdom
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_DELIVERY_TEMPLATE,type DeliverySnapshot} from '@paperclipai/shared';
import {DeliveryWorkflowPanel} from './DeliveryWorkflowPanel';
const mocks=vi.hoisted(()=>({seats:[] as any[],start:vi.fn()}));
vi.mock('@/lib/router',()=>({Link:({children}:any)=><span>{children}</span>}));
vi.mock('./DeliveryRepairControls',()=>({DeliveryRepairControls:()=>null}));
vi.mock('@/api/delivery-workflows',()=>({deliveryWorkflowApi:{start:(...args:any[])=>mocks.start(...args),list:vi.fn(),seats:vi.fn()}}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:vi.fn()}),useQuery:({queryKey}:any)=>({data:queryKey[0]==='delivery-workflows'?[]:queryKey[0]==='delivery-workflow-seats'?mocks.seats:{effective:{id:'template',revision:1,definition}},refetch:vi.fn()}),useMutation:({mutationFn}:any)=>({mutate:()=>mutationFn(),isPending:false})}));
const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);for(const [key,value] of Object.entries(definition.stages))value.enabled=key==='coding';definition.stages.coding.taskSequence='work_only';delete definition.stages.coding.workExecution;
const snapshot={id:'snapshot',projectId:'project',plan:{items:[{key:'DEV-1',parentKey:'MAIN-1',type:'编码',title:'开发',status:'待受理',assignee:'张三'}]}} as DeliverySnapshot;
let cleanup=()=>{};afterEach(()=>{cleanup();mocks.start.mockClear();});
function mount(){const node=document.createElement('div');document.body.append(node);const root=createRoot(node);flushSync(()=>root.render(<DeliveryWorkflowPanel companyId="company" snapshot={snapshot} canManage/>));cleanup=()=>{flushSync(()=>root.unmount());node.remove();};const click=(text:string)=>{const b=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes(text));expect(b).toBeDefined();flushSync(()=>b!.click());};click('配置并启动');click('添加编码单');const key=node.querySelector('select[aria-label="编码单 1"]') as HTMLSelectElement;flushSync(()=>{key.value='DEV-1';key.dispatchEvent(new Event('change',{bubbles:true}));});return node;}
const seat=(id:string,keys=['DEV-1'])=>({id,name:id,jiraKeys:keys,online:false,clientReady:true,domains:[{kind:'development',roles:['coding']}]});
describe('workflow assignee seat selection',()=>{
 it('autoselects the sole assignee seat and excludes other assignees',()=>{
  mocks.seats=[seat('mine'),seat('other',[])];const node=mount();const select=node.querySelector('select[aria-label="编码席位 1"]') as HTMLSelectElement;expect(select.value).toBe('mine');expect([...select.options].map(o=>o.value)).not.toContain('other');
  flushSync(()=>node.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(mocks.start).toHaveBeenCalledWith('company',expect.objectContaining({codingTasks:[{jiraKey:'DEV-1',seatId:'mine'}]}));
 });
 it('requires a choice for multiple matching seats and explains an absent match',()=>{
  mocks.seats=[seat('a'),seat('b')];let node=mount();let select=node.querySelector('select[aria-label="编码席位 1"]') as HTMLSelectElement;expect(select.value).toBe('');expect(select.required).toBe(true);cleanup();cleanup=()=>{};
  mocks.seats=[seat('other',[])];node=mount();select=node.querySelector('select[aria-label="编码席位 1"]') as HTMLSelectElement;expect(select.options).toHaveLength(1);expect(select.textContent).toContain('无匹配席位');
 });
});
