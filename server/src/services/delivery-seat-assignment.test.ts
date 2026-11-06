import {afterEach,describe,expect,it,vi} from 'vitest';
import type {agents,Db} from '@paperclipai/db';
vi.mock('./secrets.js',()=>({secretService:()=>({resolveSecretValue:async()=> 'private-test-token'})}));
vi.mock('./harness-execution-routing.js',()=>({resolveHarnessRoute:(s:any)=>({capability:{roles:s.testRoles??['coding']}})}));
import {chooseDeliverySeat,deliverySeatMatchesAssignee,deliverySeatCandidates,readDeliveryJiraAssignments} from './delivery-seat-assignment.js';
type Seat=typeof agents.$inferSelect;
const assignment={account:'user123',displayName:'张三',origin:'http://jira.fingard.com:6001'};
const seat=(id='seat',extra:any={}):Seat=>({id,status:'idle',adapterConfig:{dsp7Transport:'outbound',dsp7Seat:{ownerUserId:'owner'},dsp7JiraDispatch:{projectId:'project',jiraBaseUrl:assignment.origin,jiraAssignee:'user123',enabled:true}},...extra}) as Seat;
afterEach(()=>vi.unstubAllGlobals());
describe('delivery Jira assignee seat binding',()=>{
 it('uses exact account, project and origin, never the display name or seat availability',()=>{
  expect(deliverySeatMatchesAssignee(seat(),'project',assignment)).toBe(true);
  expect(deliverySeatMatchesAssignee(seat(),'other',assignment)).toBe(false);
  for(const account of ['', '张三','User123'])expect(deliverySeatMatchesAssignee(seat(),'project',{...assignment,account})).toBe(false);
  expect(deliverySeatMatchesAssignee(seat(),'project',{...assignment,origin:'https://other.example'})).toBe(false);
  const busy=seat();busy.adapterConfig.dsp7SeatPresence={state:'busy'};expect(deliverySeatMatchesAssignee(busy,'project',assignment)).toBe(true);
  expect(deliverySeatMatchesAssignee(seat('s',{status:'paused'}),'project',assignment)).toBe(false);
 });
 it('autobinds only a unique candidate, validates explicit choices and never chooses another person',()=>{
  const a=seat('a'),b=seat('b');expect(chooseDeliverySeat([a],undefined,'DEV-1')).toBe('a');
  expect(()=>chooseDeliverySeat([],undefined,'DEV-1')).toThrow('未配置');
  expect(()=>chooseDeliverySeat([a,b],undefined,'DEV-1')).toThrow('多个');
  expect(chooseDeliverySeat([a,b],'b','DEV-1')).toBe('b');
  expect(()=>chooseDeliverySeat([a],'b','DEV-1')).toThrow('不属于');
  expect(deliverySeatCandidates([a,seat('x',{testRoles:['functional-test']})],'project',assignment,'development','coding').map(s=>s.id)).toEqual(['a']);
 });
 it('reads complete current identities with the company project connection without returning credentials',async()=>{
  const db={select:()=>({from:()=>({where:async()=>[{jiraBaseUrl:assignment.origin,jiraSecretId:'secret'}]})})} as unknown as Db;
  const fetcher=vi.fn(async(_url:unknown)=>Response.json({startAt:0,total:1,issues:[{key:'DEV-1',fields:{assignee:{name:'user123',displayName:'张三'}}}]}));vi.stubGlobal('fetch',fetcher);
  const result=await readDeliveryJiraAssignments(db,'company','project',['DEV-1']);expect(result.get('DEV-1')).toEqual(assignment);
  const url=new URL(String(fetcher.mock.calls[0]?.[0]));expect(url.searchParams.get('jql')).toContain('DEV-1');
 });
 it('fails closed on incomplete or unrelated Jira records and retains unassigned identity as unmatched',async()=>{
  const db={select:()=>({from:()=>({where:async()=>[{jiraBaseUrl:assignment.origin,jiraSecretId:'secret'}]})})} as unknown as Db;
  for(const page of [{startAt:0,total:0,issues:[]},{startAt:0,total:1,issues:[{key:'OTHER-1',fields:{assignee:null}}]}]){
   vi.stubGlobal('fetch',async()=>Response.json(page));await expect(readDeliveryJiraAssignments(db,'company','project',['DEV-1'])).rejects.toThrow('未完整返回');
  }
  vi.stubGlobal('fetch',async()=>Response.json({startAt:0,total:1,issues:[{key:'DEV-1',fields:{assignee:null}}]}));
  const result=await readDeliveryJiraAssignments(db,'company','project',['DEV-1']);expect(deliverySeatMatchesAssignee(seat(),'project',result.get('DEV-1')!)).toBe(false);
 });
});
