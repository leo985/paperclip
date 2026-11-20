import { parse } from '@babel/parser';
import generateModule from '@babel/generator';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const generate = generateModule.default ?? generateModule;
export const deliveryRouteFiles = ['analysis-executions','delivery-connections','delivery-insights','delivery-intake','delivery-workflows','dsp7-jira-dispatch','dsp7-quick-seats','dsp7-seat-control','dsp7-seat-groups','dsp7-seat-owners','dsp7-seat-qingzhou','dsp7-seats','harness-capabilities','jira-intake-sync','jira-requirements','managed-session-reports','managed-sessions','management-follow-ups','personnel-federation'];
function walk(node, visit) {
 if (!node || typeof node !== 'object') return;
 if (typeof node.type === 'string') visit(node);
 for (const [key,value] of Object.entries(node)) if (!['loc','start','end','extra','comments','tokens'].includes(key)) {
  if (Array.isArray(value)) value.forEach(n => walk(n,visit)); else if (value && typeof value==='object') walk(value,visit);
 }
}
function context(source, file, cache) {
 if(cache.has(file))return cache.get(file);
 const ast=parse(source,{sourceType:'module',plugins:['typescript']});
 const c={source,file,ast,bindings:new Map(),ambiguous:new Set(),imports:new Map(),cache};cache.set(file,c);
 walk(ast,n=>{if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init){if(c.bindings.has(n.id.name))c.ambiguous.add(n.id.name);c.bindings.set(n.id.name,n.init);}if(n.type==='FunctionDeclaration'&&n.id)c.bindings.set(n.id.name,n);if(n.type==='ImportDeclaration')for(const s of n.specifiers)if(s.type==='ImportSpecifier')c.imports.set(s.local.name,{name:s.imported.name,source:n.source.value});});
 return c;
}
function imported(c,name){const i=c.imports.get(name);if(!i||!i.source.startsWith('.'))return null;const file=resolve(dirname(c.file),i.source.replace(/\.js$/,'.ts'));return {c:context(readFileSync(file,'utf8'),file,c.cache),name:i.name};}
function values(node,c,env={}) {
 if(node.type==='StringLiteral')return [node.value];
 if(node.type==='Identifier'){if(env[node.name])return env[node.name];if(c.ambiguous.has(node.name))throw Error('Ambiguous route binding '+node.name);const n=c.bindings.get(node.name);if(n)return values(n,c,env);}
 if(node.type==='TSAsExpression'||node.type==='TSSatisfiesExpression')return values(node.expression,c,env);
 if(node.type==='ArrayExpression')return node.elements.flatMap(n=>values(n,c,env));
 if(node.type==='BinaryExpression'&&node.operator==='+')return values(node.left,c,env).flatMap(a=>values(node.right,c,env).map(b=>a+b));
 if(node.type==='TemplateLiteral'){let out=[''];for(let i=0;i<node.quasis.length;i++){out=out.map(v=>v+node.quasis[i].value.cooked);if(node.expressions[i])out=out.flatMap(a=>values(node.expressions[i],c,env).map(b=>a+b));}return out;}
 throw Error('Unresolved route path in '+c.file+': '+generate(node).code);
}
export function discoverDeliveryRoutes(source,file='<fixture>') {
 const c=context(source,file,new Map()),out=[];
 function visit(node,env={}){
  if(!node||typeof node!=='object')return;
  if(node.type==='ForOfStatement' && /router\.(get|post|put|patch|delete)\(/.test(c.source.slice(node.body.start,node.body.end))){
   const declaration=node.left.declarations?.[0];if(declaration?.id.type==='Identifier'){const loopEnv={...env,[declaration.id.name]:values(node.right,c,env)};visit(node.body,loopEnv);return;}
  }
  if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.object.type==='Identifier'&&node.callee.object.name==='router'&&['get','post','put','patch','delete'].includes(node.callee.property.name)){
   for(const path of values(node.arguments[0],c,env))out.push({method:node.callee.property.name,path,node,handler:node.arguments.at(-1),context:c});
  }
  for(const [k,v] of Object.entries(node))if(!['loc','start','end','extra','comments','tokens'].includes(k)){if(Array.isArray(v))v.forEach(n=>visit(n,env));else if(v&&typeof v==='object')visit(v,env);}
 }
 visit(c.ast);return out;
}
const globalNames=new Set(['z','Date','Number','String','Boolean','URL','Math','JSON','undefined','Infinity','NaN']);
function expand(node,c,stack=new Set(),locals=new Set()) {
 if(!node||typeof node!=='object')return node;
 if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&['refine','superRefine','transform','check'].includes(node.callee.property.name))return expand(node.callee.object,c,stack,locals);
 if(node.type==='Identifier'&&!locals.has(node.name)&&!globalNames.has(node.name)){
  const i=c.imports.get(node.name);
  if(i?.source.startsWith('@paperclipai/shared'))return {type:'MemberExpression',object:{type:'Identifier',name:'shared'},property:{type:'Identifier',name:i.name},computed:false};
  const token=c.file+':'+node.name;
  if(c.ambiguous.has(node.name))throw Error('Ambiguous schema binding '+token);
  if(stack.has(token))throw Error('Recursive schema '+token);
  const next=new Set([...stack,token]);
  if(c.bindings.has(node.name))return expand(c.bindings.get(node.name),c,next,locals);
  const ref=imported(c,node.name);if(ref&&ref.c.bindings.has(ref.name))return expand(ref.c.bindings.get(ref.name),ref.c,next,locals);
  throw Error('Unresolved schema identifier '+token);
 }
 const result={...node};
 const scoped=new Set(locals);
 if(['ArrowFunctionExpression','FunctionExpression'].includes(node.type))for(const p of node.params)if(p.type==='Identifier')scoped.add(p.name);
 for(const [k,v] of Object.entries(node)){
  if(['loc','start','end','extra','comments','tokens','typeAnnotation'].includes(k)){delete result[k];continue;}
  if(k==='key'&&!node.computed||k==='property'&&node.type==='MemberExpression'&&!node.computed||k==='params')continue;
  if(Array.isArray(v))result[k]=v.map(n=>n&&typeof n==='object'?expand(n,c,stack,scoped):n);
  else if(v&&typeof v==='object')result[k]=expand(v,c,stack,scoped);
 }
 if(result.type==='ObjectProperty')result.shorthand=false;
 return result;
}
function requestPath(node,aliases){
 if(node?.type==='Identifier')return aliases[node.name]??null;
 if(node?.type==='MemberExpression'&&!node.computed){const p=requestPath(node.object,aliases);return p?[...p,node.property.name]:null;}
 return null;
}
function collectSchemas(handler,c){
 const found={body:[],query:[]},errors=[];
 const visited=new Set();
 function inspect(fn,aliases={req:['req']},depth=0){
  if(depth>8)return;
  const tag=fn.start+JSON.stringify(aliases);if(visited.has(tag))return;visited.add(tag);
  walk(fn,n=>{
   if(n.type!=='CallExpression')return;
   if(n.callee.type==='MemberExpression'&&['parse','safeParse'].includes(n.callee.property.name)){
    let p=requestPath(n.arguments[0],aliases),omit=[];
    if(!p&&n.arguments[0]?.type==='ObjectExpression'){
     const arg=n.arguments[0];const spread=arg.properties.find(x=>x.type==='SpreadElement'&&requestPath(x.argument,aliases)?.[1]==='body');
     if(spread){p=requestPath(spread.argument,aliases);omit=arg.properties.filter(x=>x.type==='ObjectProperty').map(x=>x.key.name??x.key.value);}
    }
    if(p?.[0]==='req'&&['body','query'].includes(p[1])){
     try{
      let code=generate(expand(n.callee.object,c),{compact:true,comments:false}).code;
      if(omit.length)code+=' .omit({'+omit.map(k=>JSON.stringify(k)+':true').join(',')+'})';
      for(const key of p.slice(2).reverse())code='z.object({'+JSON.stringify(key)+':'+code+'})';
      found[p[1]].push(code);
     }catch(e){errors.push(String(e.message));}
    }
   }
   if(n.callee.type==='Identifier'){
    const target=c.bindings.get(n.callee.name);
    if(target&&['FunctionDeclaration','ArrowFunctionExpression','FunctionExpression'].includes(target.type)){
     const bound={};for(let i=0;i<target.params.length;i++){const p=target.params[i],value=requestPath(n.arguments[i],aliases);if(p.type==='Identifier'&&value)bound[p.name]=value;}
     if(Object.keys(bound).length)inspect(target,bound,depth+1);
    }
   }
  });
 }
 inspect(handler);return {body:[...new Set(found.body)],query:[...new Set(found.query)],errors:[...new Set(errors)]};
}
export function deliveryContractInventory(root){
 const routes=[];
 for(const name of deliveryRouteFiles){const file=resolve(root,'server/src/routes',name+'.ts');for(const r of discoverDeliveryRoutes(readFileSync(file,'utf8'),file)){
  if(r.path==='/issues/:id/checkout')continue; // Existing generic checkout contract owns this middleware path.
  const contract=collectSchemas(r.handler,r.context),statuses=new Set();
  walk(r.handler,n=>{
   if(n.type!=='CallExpression'||n.callee.type!=='MemberExpression')return;
   if(n.callee.property.name==='status'&&n.arguments[0]?.type==='NumericLiteral'&&n.arguments[0].value>=200&&n.arguments[0].value<300)statuses.add(n.arguments[0].value);
   if(n.callee.object.type==='Identifier'&&n.callee.object.name==='res'&&['json','send','end','redirect'].includes(n.callee.property.name))statuses.add(n.callee.property.name==='redirect'?302:200);
  });
  routes.push({method:r.method,path:'/api'+r.path.replace(/:([A-Za-z0-9_]+)/g,'{$1}'),source:'server/src/routes/'+name+'.ts',...contract,statuses:[...statuses].sort()});
 }}
 return routes;
}
