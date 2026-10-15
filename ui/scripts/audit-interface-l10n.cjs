const fs=require('fs'),path=require('path');const store=path.resolve(__dirname,'../../node_modules/.pnpm');const packageDir=fs.readdirSync(store).find(name=>name.startsWith('@babel+parser@'));if(!packageDir)throw Error('Install workspace dependencies before running the UI audit');const parser=require(path.join(store,packageDir,'node_modules/@babel/parser'));
const root=path.resolve(__dirname,'../..');const zh=JSON.parse(fs.readFileSync(root+'/ui/src/i18n/interface.zh-CN.json'));const found=[];let scanned=0;
function walkFiles(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walkFiles(p);else if(/\.tsx?$/.test(p)&&!/(?:test|spec|stories)\.[^/]+$/.test(p))scan(p)}}
const props=new Set(['label','title','description','placeholder','helperText','emptyMessage','triggerLabel','ariaLabel','confirmLabel','cancelLabel','loadingLabel','message','body','tooltip','hint','subtitle','text']);
function scan(file){let src=fs.readFileSync(file,'utf8'),ast;try{ast=parser.parse(src,{sourceType:'module',plugins:['typescript','jsx']})}catch(e){throw Error(file+e.message)}scanned++;
function visit(n,parent,anc){if(!n||typeof n!=='object')return;
let text=null,kind=null;
if(n.type==='JSXText'){text=n.value.replace(/\s+/g,' ').trim();kind='jsx'}
if(n.type==='TemplateLiteral'){
let k=anc.length-1;while(k>=0&&['ConditionalExpression','LogicalExpression','ParenthesizedExpression'].includes(anc[k].type))k--;
if((k>=0&&anc[k].type==='JSXExpressionContainer'&&!anc.some(a=>a.type==='BinaryExpression'))||(parent?.type==='ObjectProperty'&&parent.value===n&&props.has(parent.key?.name??parent.key?.value))||(parent?.type==='NewExpression'&&parent.callee?.name==='Error'&&parent.arguments[0]===n)){text=n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?'__PCVAR'+i+'__':'')).join('');kind='template';}
}
if(n.type==='StringLiteral'){
 if(parent?.type==='CallExpression'&&['uiText','uiTextFormat'].includes(parent.callee?.name)){text=n.value;kind='translated'}
 else if(parent?.type==='JSXAttribute'&&props.has(parent.name?.name)||parent?.type==='JSXAttribute'&&['aria-label','title','alt'].includes(parent.name?.name)){text=n.value;kind='attr'}
 else if(parent?.type==='ObjectProperty'&&parent.value===n&&props.has(parent.key?.name??parent.key?.value)){text=n.value;kind='prop'}
 else {let k=anc.length-1;while(k>=0&&['ConditionalExpression','LogicalExpression','ParenthesizedExpression'].includes(anc[k].type))k--;if(k>=0&&((anc[k].type==='JSXExpressionContainer'&&!anc.some(a=>a.type==='BinaryExpression'))||(anc[k].type==='ObjectProperty'&&props.has(anc[k].key?.name??anc[k].key?.value)))){text=n.value;kind='expression'}
if(parent?.type==='NewExpression'&&parent.callee?.name==='Error'&&parent.arguments[0]===n){text=n.value;kind='error'}
if(parent?.type==='CallExpression'&&['alert','confirm'].includes(parent.callee?.name??parent.callee?.property?.name)&&parent.arguments[0]===n){text=n.value;kind='dialog'}}
}
const attribute=anc.findLast(a=>a.type==='JSXAttribute');if(attribute&&!props.has(attribute.name?.name)&&!['aria-label','title','alt'].includes(attribute.name?.name))text=null;
if(anc.some(a=>a.type==='JSXElement'&&['code','pre','kbd','script','style'].includes(a.openingElement?.name?.name)))text=null;
if(text&&/[A-Za-z]{2}/.test(text.replace(/__PCVAR\d+__/g,''))&&!/[\u3400-\u9fff]/.test(text)){found.push({file:path.relative(root,file),line:n.loc.start.line,text,kind,start:n.start,end:n.end,known:!!zh[text],...(kind==='template'?{expressions:n.expressions.map(e=>src.slice(e.start,e.end))}:{})})}
for(const [key,v]of Object.entries(n)){if(['loc','start','end','extra','comments','tokens'].includes(key))continue;if(Array.isArray(v)){for(const c of v)if(c?.type)visit(c,n,[...anc,n])}else if(v?.type)visit(v,n,[...anc,n])}}
visit(ast,null,[])}
walkFiles(root+'/ui/src');
const exemptions=JSON.parse(fs.readFileSync(path.join(__dirname,'interface-l10n-exemptions.json')));
const skip=new Set(exemptions.map(r=>r.file+'\0'+r.text));
const identifier=/^(?:[a-z][a-z0-9_.:/@-]*|[A-Z][A-Z0-9_.:/@ -]*|[\w.-]+\.(?:json|md|txt|ts|js|yaml|toml|zip))$/;
const names=new Set('Claude Codex Gemini Grok Kimi Hermes OpenCode Pi Cursor OpenClaw Process HTTP API ACP ACPX GitHub GitLab Jira Paperclip Docker Kubernetes PostgreSQL Slack Teams OAuth OpenAI Anthropic Google AWS JSON YAML TOML Markdown JavaScript TypeScript Python Rust SQL HTML CSS MCP SDK CLI URL SSH PAT CPU GPU RAM PDF PNG JPEG SVG CSV ZIP XML CORS SSE IPC TCP UDP TLS HTTPS GET POST PATCH PUT DELETE HEAD OPTIONS ZDR HIPAA'.split(' '));
const pending=found.filter(r=>{
  if(r.kind==='translated')return !r.known;
  if(skip.has(r.file+'\0'+r.text)||r.file.includes('fixtures')||r.file.includes('preview-main'))return false;
  if(identifier.test(r.text)||names.has(r.text)||/^(?:https?:\/\/|\/[^ ]|\.\/|~[\/]|[\w.-]+@|[a-z]+:\/\/|npm |pnpm |npx |curl |git |chmod |ssh |node |python |claude |codex |SELECT |INSERT |export |--)/.test(r.text))return false;
  // A known string still needs an explicit rendering call, unless listed above.
  return true;
});
const report={scannedFiles:scanned,displayOccurrences:found.length,dictionaryEntries:Object.keys(zh).length,pending};
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({scannedFiles:scanned,displayOccurrences:found.length,dictionaryEntries:Object.keys(zh).length,pending:pending.length}));
for(const r of pending.slice(0,30))console.log(r.file+':'+r.line+' '+r.text);
if(pending.length)process.exitCode=1;
