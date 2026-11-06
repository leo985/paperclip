#!/usr/bin/env python3
"""Private managed-session collection. Stdlib only, SQLite WAL, no model invocation.

Only verified native session files and their own subagent directory are read.
Raw Claude JSONL/PTY logs never enter the queue. Billing remains usage_ledger's job.
"""
from __future__ import annotations
import argparse
import base64
import contextlib
import datetime as dt
import fnmatch
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid

PART_BYTES=32768
BATCH_BYTES=256*1024
PARSER_VERSION=1
MAX_LINE=128*1024*1024
SECRET_KEY=re.compile(r'(?:api[_-]?key|appsecret|access[_-]?token|password|passwd|authorization|secret|pat[_-]?token)',re.I)
SECRET_VALUE=re.compile(r'((?:api[_-]?key|appsecret|access[_-]?token|password|passwd|authorization|secret|pat[_-]?token)["\']?\s*[:=]\s*["\']?)(?!\[REDACTED\])[^\s"\',;}]+',re.I)
KNOWN_TOKEN=re.compile(r'(?:sk-ant-|sk-proj-|ghp_|glpat-)[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+\/-]{10,}',re.I)
PRIVATE_KEY=re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
CREDENTIAL_PATH=re.compile(r'(?:^|[\\/\s"\'])\.(?:env(?:\.[\w.-]+)?|mcp(?:\.local)?\.json)|settings(?:\.local)?\.json|(?:id_rsa|id_ed25519)(?:$|[\s"\'])',re.I)

def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def epoch(value):
    try:return dt.datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()
    except (ValueError,TypeError):return 0
def sha(value):return hashlib.sha256(value if isinstance(value,bytes) else value.encode()).hexdigest()
def dump(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
def config_path():
    from pilot import DEFAULT_CONFIG
    return DEFAULT_CONFIG

def connect(cfg):
    folder=Path(cfg['database']).parent
    folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    path=folder/'managed-sessions.sqlite3'
    if path.is_symlink():raise ValueError('采集队列不能使用符号链接')
    fd=os.open(path,os.O_CREAT|os.O_WRONLY,0o600);os.close(fd)
    with contextlib.suppress(OSError):path.chmod(0o600)
    db=sqlite3.connect(path,timeout=20);db.row_factory=sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA secure_delete=ON');db.execute('PRAGMA busy_timeout=20000')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS sessions(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,server_id TEXT,info TEXT NOT NULL,collection_paused INTEGER NOT NULL DEFAULT 0,upload_paused INTEGER NOT NULL DEFAULT 0,ended INTEGER NOT NULL DEFAULT 0,finalized INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_policy REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS streams(run_id TEXT,stream_id TEXT,sequence INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run_id,stream_id));
      CREATE TABLE IF NOT EXISTS outbox(run_id TEXT,stream_id TEXT,sequence INTEGER,event_id TEXT UNIQUE,event TEXT NOT NULL,acked_at REAL,PRIMARY KEY(run_id,stream_id,sequence));
      CREATE TABLE IF NOT EXISTS cursors(run_id TEXT,path TEXT,generation TEXT,offset INTEGER,identity TEXT,prefix TEXT,PRIMARY KEY(run_id,path));
      CREATE TABLE IF NOT EXISTS revisions(run_id TEXT,stream_id TEXT,content_id TEXT,revision TEXT,PRIMARY KEY(run_id,stream_id,content_id));
      CREATE TABLE IF NOT EXISTS metadata(run_id TEXT,key TEXT,value TEXT,PRIMARY KEY(run_id,key));
    ''')
    with contextlib.suppress(OSError):path.chmod(0o600)
    return db

class Redactor:
    def __init__(self,cfg):
        self.rules=cfg.get('managed_collection') or {}
        self.values=set(v for k,v in os.environ.items() if SECRET_KEY.search(k) and len(v)>=8)
        self.values.update(v for k,v in self.rules.get('secret_values',{}).items() if isinstance(v,str) and len(v)>=5)
        # Load only registered settings env for exact-value masking; never queue settings.
        settings=(cfg.get('seat_runtime') or {}).get('claudeSettingsFile')
        if settings:
            try:
                for k,v in json.loads(Path(settings).read_text()).get('env',{}).items():
                    if SECRET_KEY.search(k) and isinstance(v,str) and len(v)>=5:self.values.add(v)
            except (OSError,ValueError):pass
    def excluded(self,value):
        return bool(CREDENTIAL_PATH.search(value)) or any(fnmatch.fnmatch(value,'*'+p+'*') for p in self.rules.get('excluded_paths',[]))
    def text(self,value):
        original=value
        for secret in sorted(self.values,key=len,reverse=True):value=value.replace(secret,'[REDACTED]')
        value=PRIVATE_KEY.sub('[REDACTED PRIVATE KEY]',value)
        value=KNOWN_TOKEN.sub('[REDACTED]',value)
        value=SECRET_VALUE.sub(lambda m:m.group(1)+'[REDACTED]',value)
        return value,value!=original
    def value(self,value):
        if isinstance(value,dict):return {k:('[REDACTED]' if SECRET_KEY.fullmatch(k) else self.value(v)) for k,v in value.items()}
        if isinstance(value,list):return [self.value(v) for v in value]
        if isinstance(value,str):return self.text(value)[0]
        return value

class QueueCapacity(Exception):pass

class Collector:
    def __init__(self,cfg,run_id):
        self.cfg=cfg;self.run_id=str(uuid.UUID(run_id));self.db=connect(cfg);self.redactor=Redactor(cfg)
        row=self.db.execute('SELECT * FROM sessions WHERE run_id=?',(self.run_id,)).fetchone()
        if not row:raise ValueError('会话尚未登记到本机采集队列')
        self.info=json.loads(row['info']);self.folder=Path(self.info['folder'])
        self.quota=max(1024*1024,int((cfg.get('managed_collection') or {}).get('queue_bytes',1024**3)))
        self.queued_bytes=self.queue_size()
    def queue_size(self):return self.db.execute('SELECT coalesce(sum(length(cast(event AS BLOB))),0) FROM outbox WHERE acked_at IS NULL').fetchone()[0]
    def row(self):return self.db.execute('SELECT * FROM sessions WHERE run_id=?',(self.run_id,)).fetchone()
    def meta(self,key,default=None):
        row=self.db.execute('SELECT value FROM metadata WHERE run_id=? AND key=?',(self.run_id,key)).fetchone()
        return json.loads(row['value']) if row else default
    def setmeta(self,key,value):self.db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?,?)',(self.run_id,key,dump(value)))
    def event(self,stream,kind,payload,generation='runtime',offset=0,at=None):
        stamp=now()
        self.db.execute('INSERT OR IGNORE INTO streams(run_id,stream_id) VALUES(?,?)',(self.run_id,stream))
        seq=self.db.execute('SELECT sequence FROM streams WHERE run_id=? AND stream_id=?',(self.run_id,stream)).fetchone()[0]+1
        event_id=str(uuid.uuid5(uuid.UUID(self.run_id),stream+':'+str(seq)))
        event={'eventId':event_id,'streamId':stream,'sequence':seq,'eventType':kind,'occurredAt':at or stamp,'observedAt':stamp,'sourceGeneration':generation,'sourceOffset':max(0,offset),'parserVersion':PARSER_VERSION,'payload':self.redactor.value(payload)}
        encoded=dump(event)
        length=len(encoded.encode())
        if self.queued_bytes+length>self.quota:raise QueueCapacity()
        self.queued_bytes+=length
        self.db.execute('INSERT INTO outbox VALUES(?,?,?,?,?,NULL)',(self.run_id,stream,seq,event_id,encoded))
        self.db.execute('UPDATE streams SET sequence=? WHERE run_id=? AND stream_id=?',(seq,self.run_id,stream))
    def coverage(self,reason,source='collector',offset=0):
        key='gap:'+sha(source+':'+str(offset)+':'+reason)
        if self.meta(key):return
        self.event('collector','coverage',{'reason':reason,'source':source},offset=offset)
        self.setmeta(key,True)
    def content(self,stream,content_id,kind,text,*,message_id='',tool_id=None,name=None,parent=None,mime=None,unavailable=None,truncated=False,offset=0,generation='runtime',at=None):
        if self.redactor.excluded(text):text='';unavailable='命中凭据文件或路径排除规则'
        text,redacted=self.redactor.text(text)
        if '-----BEGIN ' in text and 'PRIVATE KEY-----' in text:
            text='';unavailable='私钥内容无法安全处理，已排除'
        raw=text.encode('utf-8')
        if len(raw)>100*1024*1024:text='';raw=b'';unavailable='单条内容超过 100 MiB，保留范围缺口'
        redacted=redacted or '[REDACTED' in text;revision=sha(raw+(unavailable or '').encode())
        prior=self.db.execute('SELECT revision FROM revisions WHERE run_id=? AND stream_id=? AND content_id=?',(self.run_id,stream,content_id)).fetchone()
        if prior and prior['revision']==revision:return
        if self.row()['collection_paused']:return
        pieces=[];current=bytearray()
        # Character chunks preserve UTF-8 boundaries and never truncate the logical message.
        for char in text:
            data=char.encode()
            if len(current)+len(data)>PART_BYTES:pieces.append(bytes(current).decode());current.clear()
            current.extend(data)
        if current:pieces.append(bytes(current).decode())
        for i,part in enumerate(pieces):self.event(stream,'content.part',{'contentId':content_id,'revision':revision,'partIndex':i,'data':part,'encoding':'utf8'},generation,offset,at)
        manifest={'contentId':content_id,'revision':revision,'kind':kind,'parentStreamId':parent,'messageId':str(message_id)[:200],'toolCallId':str(tool_id)[:200] if tool_id else None,'name':str(name)[:200] if name else None,'mime':mime,'parts':len(pieces),'bytes':len(raw),'sha256':sha(raw),'redacted':redacted,'sourceTruncated':truncated,'unavailableReason':unavailable}
        self.event(stream,'content.manifest',manifest,generation,offset,at)
        self.db.execute('INSERT OR REPLACE INTO revisions VALUES(?,?,?,?)',(self.run_id,stream,content_id,revision))
    def attachment(self,stream,content_id,path,parent=None,at=None):
        file=Path(path).expanduser();roots=[Path(self.info.get('source_cwd',self.info['cwd'])).resolve(),Path(self.info['state_path']).parent.resolve()]
        if not file.is_absolute():file=Path(self.info['cwd'])/file
        resolved=file.resolve()
        reason=None;text='';mime=mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        if file.is_symlink() or not any(resolved.is_relative_to(root) for root in roots):reason='附件不在受管任务允许目录'
        elif self.redactor.excluded(str(file)):reason='附件命中排除规则'
        elif not resolved.is_file():reason='附件来源已不可用'
        elif resolved.stat().st_size>100*1024*1024:reason='附件超过单文件 100 MiB 上限'
        elif self.meta('attachment_bytes',0)+resolved.stat().st_size>1024**3:reason='附件累计超过每会话 1 GiB 上限'
        else:
            try:
                data=resolved.read_bytes()
                text=data.decode('utf-8')
                if '\x00' in text:raise UnicodeError()
                if not self.meta('attachment:'+content_id,False):
                    self.setmeta('attachment_bytes',self.meta('attachment_bytes',0)+len(data));self.setmeta('attachment:'+content_id,True)
            except UnicodeError:reason='二进制附件尚无可用脱敏适配器，仅上报元数据'
            except OSError:reason='附件读取失败'
        self.content(stream,content_id,'attachment',text,name=file.name,parent=parent,mime=mime,unavailable=reason,at=at)
    def parse_record(self,record,stream,generation,offset):
        typ=record.get('type');message=record.get('message') or {};parent='main' if stream.startswith('sub:') else None
        at=record.get('timestamp') or now()
        try:dt.datetime.fromisoformat(at.replace('Z','+00:00'))
        except (ValueError,TypeError):at=now()
        if typ in ('user','assistant'):
            mid=str(message.get('id') or record.get('uuid') or generation+':'+str(offset))
            blocks=message.get('content',[])
            if isinstance(blocks,str):blocks=[{'type':'text','text':blocks}]
            if not isinstance(blocks,list):self.coverage('消息内容结构未知',stream,offset);return
            for i,block in enumerate(blocks):
                if not isinstance(block,dict):self.coverage('消息块格式未知',stream,offset);continue
                btype=block.get('type');cid=sha(mid+':'+str(i))
                if btype in ('thinking','redacted_thinking'):continue
                if btype=='text':self.content(stream,cid,'compaction' if record.get('isCompactSummary') else typ,block.get('text',''),message_id=mid,parent=parent,generation=generation,offset=offset,at=at)
                elif btype in ('tool_use','tool_result'):
                    name=block.get('name');is_call=btype=='tool_use';tool_id=block.get('id') if is_call else block.get('tool_use_id')
                    if is_call:
                        self.setmeta('tool:'+str(tool_id),name)
                    else:name=self.meta('tool:'+str(tool_id))
                    value=block.get('input',{}) if is_call else block.get('content','')
                    excluded=name in self.redactor.rules.get('excluded_tools',[]) or (self.redactor.excluded(dump(value)) if is_call else self.meta('tool-excluded:'+str(tool_id),False))
                    if is_call:self.setmeta('tool-excluded:'+str(tool_id),excluded)
                    if not is_call and isinstance(value,list):
                        visible=[]
                        for nested in value:
                            if isinstance(nested,dict) and nested.get('type')=='text':visible.append(nested.get('text',''))
                            elif isinstance(nested,dict) and nested.get('type') not in ('thinking','redacted_thinking'):
                                self.content(stream,cid+':attachment','attachment','',message_id=mid,parent=parent,unavailable='工具内嵌附件暂不支持脱敏',at=at)
                        value='\n'.join(visible)
                    self.content(stream,cid,'tool_call' if is_call else 'tool_result','' if excluded else dump(self.redactor.value(value)),message_id=mid,tool_id=tool_id,name=name,parent=parent,generation=generation,offset=offset,at=at,unavailable='工具被排除' if excluded else None,truncated=bool(block.get('truncated')))
                elif btype in ('image','document'):
                    source=block.get('source') or {}
                    if source.get('path') or source.get('file_path'):self.attachment(stream,cid,source.get('path') or source['file_path'],parent,at)
                    else:self.content(stream,cid,'attachment','',message_id=mid,parent=parent,mime=source.get('media_type'),unavailable='内嵌附件格式暂不支持脱敏；保留来源缺口',at=at)
                else:self.coverage('未支持的可见消息块：'+str(btype)[:80],stream,offset)
        elif typ=='system' and record.get('subtype') in ('compact_boundary','microcompact_boundary'):
            self.content(stream,'compact:'+generation+':'+str(offset),'compaction',dump(record.get('compactMetadata') or {'subtype':record.get('subtype')}),parent=parent,at=at)
        elif typ in ('system','progress','summary','file-history-snapshot','queue-operation','last-prompt'):
            # Internal bookkeeping is not automatically user-visible content.
            if typ=='system' and isinstance(record.get('content'),str):self.content(stream,'control:'+generation+':'+str(offset),'control',record['content'],parent=parent,at=at)
        else:self.coverage('未支持的来源记录类型：'+str(typ)[:80],stream,offset)
    def read_source(self,file,stream,parser,final=False):
        if not file.is_file() or file.is_symlink():return
        stat=file.stat();key=str(file.resolve());identity=str(stat.st_dev)+':'+str(stat.st_ino)+':'+str(getattr(stat,'st_birthtime_ns',0))
        prior=self.db.execute('SELECT * FROM cursors WHERE run_id=? AND path=?',(self.run_id,key)).fetchone()
        generation=prior['generation'] if prior else str(uuid.uuid4());offset=prior['offset'] if prior else 0
        with file.open('rb') as source:
            prefix=source.read(min(128,offset))
            if prior and (prior['identity']!=identity or stat.st_size<offset or (offset and sha(prefix)!=prior['prefix'])):
                self.coverage('来源替换或截断，已建立新代次',stream,offset);generation=str(uuid.uuid4());offset=0
            source.seek(offset)
            # A pause may end in the middle of a source line. Never parse its tail.
            if self.meta('discard-tail:'+key,False):
                tail=source.readline(MAX_LINE+1)
                offset=source.tell()
                if tail.endswith(b'\n') or final:self.setmeta('discard-tail:'+key,False)
                else:
                    self.db.execute('UPDATE cursors SET offset=? WHERE run_id=? AND path=?',(offset,self.run_id,key))
                    return
            count=0
            while count<500:
                begin=source.tell();line=source.readline(MAX_LINE+1)
                if not line:break
                if len(line)>MAX_LINE:
                    self.coverage('单行超过 128 MiB，暂停该来源；未跳过',stream,begin);break
                if not line.endswith(b'\n') and not final:break
                record_bytes=self.queued_bytes
                self.db.execute('SAVEPOINT source_record')
                try:
                    parser(line.decode('utf-8'),stream,generation,begin)
                except QueueCapacity:
                    self.db.execute('ROLLBACK TO source_record');self.db.execute('RELEASE source_record');self.queued_bytes=record_bytes
                    self.setmeta('capacity_paused',True);break
                except (ValueError,TypeError,KeyError,UnicodeError):
                    self.db.execute('ROLLBACK TO source_record');self.queued_bytes=record_bytes
                    self.coverage('解析失败，保留位置缺口',stream,begin)
                self.db.execute('RELEASE source_record')
                offset=source.tell();count+=1
            source.seek(0);prefix=source.read(min(128,offset))
        self.db.execute('INSERT OR REPLACE INTO cursors VALUES(?,?,?,?,?,?)',(self.run_id,key,generation,offset,identity,sha(prefix)))
    def skip_current_sources(self):
        # Persist exclusion boundaries by moving cursors; future rescans cannot backfill them.
        for file,_stream,_parser in self.sources():
            if not file.is_file() or file.is_symlink():continue
            st=file.stat();offset=st.st_size
            with file.open('rb') as f:
                prefix=f.read(min(128,offset))
                if offset:f.seek(offset-1);partial=f.read(1)!=b'\n'
                else:partial=False
            self.setmeta('discard-tail:'+str(file.resolve()),partial)
            prior=self.db.execute('SELECT generation FROM cursors WHERE run_id=? AND path=?',(self.run_id,str(file.resolve()))).fetchone()
            generation=prior[0] if prior else str(uuid.uuid4())
            identity=str(st.st_dev)+':'+str(st.st_ino)+':'+str(getattr(st,'st_birthtime_ns',0))
            self.db.execute('INSERT OR REPLACE INTO cursors VALUES(?,?,?,?,?,?)',(self.run_id,str(file.resolve()),generation,offset,identity,sha(prefix)))
    def sources(self):
        projects=Path(os.environ.get('CLAUDE_CONFIG_DIR',str(Path.home()/'.claude')))/'projects'
        mains=list(projects.glob('*/'+self.run_id+'.jsonl'))
        result=[]
        if len(mains)==1:
            main=mains[0]
            result.append((main,'main',lambda line,stream,gen,pos:self.parse_record(json.loads(line),stream,gen,pos)))
            for sub in sorted((main.parent/self.run_id/'subagents').glob('*.jsonl')):
                if sub.resolve().is_relative_to((main.parent/self.run_id).resolve()):result.append((sub,'sub:'+sub.stem,lambda line,stream,gen,pos:self.parse_record(json.loads(line),stream,gen,pos)))
        elif len(mains)>1:self.coverage('原生会话来源不唯一')
        result.append((self.folder/'terminal.log','terminal',self.parse_terminal))
        result.append((self.folder/'collector-hooks.jsonl','hooks',self.parse_hook))
        state=Path(self.info['state_path'])
        effort=state.parent/'effort'/'events.jsonl'
        result.append((effort,'harness',self.parse_effort))
        result.append((state.parent/'platform-events.jsonl','gates',self.parse_gate))
        return result
    def parse_terminal(self,line,stream,generation,offset):
        text=re.sub(r'\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])','',line)
        text=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]','',text)
        # Only text with a complete line is emitted; secrets split across PTY writes stay together.
        self.content(stream,generation+':'+str(offset),'terminal',text,offset=offset,generation=generation)
    def parse_hook(self,line,stream,generation,offset):
        item=json.loads(line);state=item.get('state')
        if state in ('executing','waiting','unknown'):
            self.event(stream,'execution',{'state':state,'source':item.get('hook'),'monotonic':item.get('monotonic')},generation,offset,item.get('at'))
            self.setmeta('runtime_state',{'state':state,'at':item.get('at') or now()})
    def parse_effort(self,line,stream,generation,offset):
        item=json.loads(line);kind=item.get('type');phase=item.get('phase') or 'unknown';at=item.get('ts')
        if at and epoch(at)<epoch(self.info['createdAt']):return
        if kind in ('phase-enter','phase-exit'):
            self.event(stream,'phase',{'phase':phase,'status':'started' if kind=='phase-enter' else 'observed','source':'Harness effort','evidence':'effort/events.jsonl:'+str(offset),'note':'阶段退出不等于门禁通过'},generation,offset,at)
        elif kind in ('engage-asked','engage-started','engage-answer','engage-void'):
            self.event(stream,'execution',{'state':'waiting' if kind in ('engage-asked','engage-started') else 'unknown','source':'Harness '+kind,'engagementId':item.get('engagement_id')},generation,offset,at)
    def parse_gate(self,line,stream,generation,offset):
        item=json.loads(line)
        if item.get('runId')!=self.run_id:return
        if item.get('type')=='phase' and item.get('status') in ('started','passed','failed','reopened','skipped'):
            if item.get('status') in ('passed','skipped') and not (item.get('evidence') and item.get('gateVersion')):
                self.coverage('门禁证据缺失，不能确认阶段完成',stream,offset);return
            self.event(stream,'phase',{k:item.get(k) for k in ('phase','status','gateVersion','evidence','flowVersion')},generation,offset,item.get('at'))
    def scan(self,final=False):
        row=self.row()
        if row['finalized']:return
        queued=self.queue_size();self.queued_bytes=queued
        with self.db:
            if queued>=self.quota:
                self.setmeta('capacity_paused',True);return
            self.setmeta('capacity_paused',False)
            if row['collection_paused']:
                self.skip_current_sources();self.coverage('用户暂停采集区间不补采');return
            for file,stream,parser in self.sources():
                self.read_source(file,stream,parser,final)
                if self.meta('capacity_paused',False):return
            if self.queued_bytes>self.quota-65536:
                self.setmeta('capacity_paused',True);return
            state_file=Path(self.info['state_path'])
            if state_file.is_file():
                try:
                    state=json.loads(state_file.read_text());phase=state.get('当前Phase') or (state.get('phase') if state.get('schema_version')==1 else None)
                    if phase and self.meta('phase')!=phase:
                        self.event('harness','phase',{'phase':str(phase),'status':'observed','source':'Harness state','note':'尚未收到阶段门禁证据'});self.setmeta('phase',phase)
                except (OSError,ValueError):self.coverage('Harness state 无法读取')
            runtime=self.meta('runtime_state',{'state':'unknown','at':now()})
            self.setmeta('current_state',runtime['state']);self.setmeta('waiting_resume',False)
            wait=self.folder/'wait.json'
            if wait.is_file():
                try:
                    value=json.loads(wait.read_text());status=value.get('status')
                    if status in ('waiting_confirmation','waiting_terminal','rejected','resuming') and epoch(value.get('updated_at'))>epoch(runtime['at']):
                        # resuming means approved, not yet executing; only runtime hook confirms execution.
                        self.setmeta('current_state','waiting')
                        self.setmeta('waiting_resume',status=='resuming')
                except (OSError,ValueError):pass
            if time.time()-self.meta('last_runtime_pulse',0)>=15:
                self.event('collector','observation',{'queuedBytes':queued,'policy':'full-visible-redacted-v1','sourceFiles':len(self.sources()),'queueWarning':queued>=self.quota*.8,'waitingResume':self.meta('waiting_resume',False)})
                self.event('clock','execution',{'state':self.meta('current_state','unknown'),'source':'last explicit runtime boundary'})
                self.setmeta('last_runtime_pulse',time.time())
    def finish_scan(self):
        for _ in range(10):
            before=self.db.execute('SELECT coalesce(sum(offset),0) FROM cursors WHERE run_id=?',(self.run_id,)).fetchone()[0]
            self.scan(final=True)
            after=self.db.execute('SELECT coalesce(sum(offset),0) FROM cursors WHERE run_id=?',(self.run_id,)).fetchone()[0]
            if after==before:break
        complete=True
        with self.db:
            for file,stream,_parser in self.sources():
                cursor=self.db.execute('SELECT offset FROM cursors WHERE run_id=? AND path=?',(self.run_id,str(file.resolve()))).fetchone()
                if file.is_file() and (not cursor or cursor[0]<file.stat().st_size):complete=False
            known=self.db.execute('SELECT path FROM cursors WHERE run_id=?',(self.run_id,)).fetchall()
            for cursor in known:
                if not Path(cursor['path']).exists():self.coverage('已登记来源已消失，无法继续补采')
            self.setmeta('scan_complete',complete)
        return complete

    def status(self,error=None):
        row=self.row();streams=self.db.execute('SELECT stream_id,sequence,acked FROM streams WHERE run_id=?',(self.run_id,)).fetchall()
        info={'sessionId':row['server_id'],'policy':'full-visible-redacted-v1','pendingEvents':sum(s['sequence']-s['acked'] for s in streams),'collectionPaused':bool(row['collection_paused']),'uploadPaused':bool(row['upload_paused']),'finalized':bool(row['finalized']),'updatedAt':now(),'error':error,'capacityPaused':self.meta('capacity_paused',False),'sourceScanComplete':self.meta('scan_complete',False)}
        from pilot import atomic_json
        atomic_json(self.folder/'collection-status.json',info)
    def upload(self,max_batches=3):
        from pilot import Bridge
        from seats import seat_api,identity
        bridge=Bridge(Path(self.info['config_path']));api=seat_api(bridge);ident=identity(bridge);row=self.row()
        if not row['server_id']:
            result=api.request('POST','/agents/'+self.cfg['agent_id']+'/managed-sessions',{**ident,'protocolVersion':1,'runId':self.run_id,'nativeSessionId':self.run_id,'taskId':row['task_id']})
            with self.db:self.db.execute('UPDATE sessions SET server_id=? WHERE run_id=?',(result['sessionId'],self.run_id))
            row=self.row()
        endpoint='/agents/'+self.cfg['agent_id']+'/managed-sessions/'+row['server_id']
        receipt=api.request('POST',endpoint+'/receipts',ident)
        if receipt.get('deleted'):
            with self.db:
                for table in ('outbox','revisions','metadata','cursors'):
                    self.db.execute('DELETE FROM '+table+' WHERE run_id=?',(self.run_id,))
                self.db.execute('UPDATE sessions SET finalized=1,collection_paused=1,upload_paused=1 WHERE run_id=?',(self.run_id,))
            self.status('平台正文已删除；本机原生 Claude 历史由 Claude 自身管理');return
        with self.db:
            old=bool(row['collection_paused']);paused=bool(receipt['collectionPaused'])
            if old or paused:self.skip_current_sources()
            self.db.execute('UPDATE sessions SET collection_paused=?,upload_paused=?,last_policy=? WHERE run_id=?',(int(paused),int(receipt['uploadPaused']),time.time(),self.run_id))
            for stream in receipt['streams']:
                self.db.execute('UPDATE outbox SET acked_at=? WHERE run_id=? AND stream_id=? AND sequence<=? AND acked_at IS NULL',(time.time(),self.run_id,stream['streamId'],stream['ackSequence']))
                self.db.execute('UPDATE streams SET acked=? WHERE run_id=? AND stream_id=?',(stream['ackSequence'],self.run_id,stream['streamId']))
        if receipt.get('finalized'):
            with self.db:self.db.execute('UPDATE sessions SET finalized=1 WHERE run_id=?',(self.run_id,))
            self.status();return
        if receipt['uploadPaused']:self.status();return
        for _ in range(max_batches):
            rows=self.db.execute('SELECT event FROM outbox WHERE run_id=? AND acked_at IS NULL ORDER BY rowid LIMIT 100',(self.run_id,)).fetchall()
            events=[];size=0
            for item in rows:
                data=json.loads(item['event']);length=len(item['event'].encode())
                if size+length>BATCH_BYTES-2048:break
                events.append(data);size+=length
            if not events:break
            response=api.request('POST',endpoint+'/events',{**ident,'protocolVersion':1,'events':events})
            with self.db:
                for stream in response['streams']:
                    self.db.execute('UPDATE outbox SET acked_at=? WHERE run_id=? AND stream_id=? AND sequence<=? AND acked_at IS NULL',(time.time(),self.run_id,stream['streamId'],stream['ackSequence']))
                    self.db.execute('UPDATE streams SET acked=? WHERE run_id=? AND stream_id=?',(stream['ackSequence'],self.run_id,stream['streamId']))
        pending=self.db.execute('SELECT 1 FROM outbox WHERE run_id=? AND acked_at IS NULL LIMIT 1',(self.run_id,)).fetchone()
        if self.row()['ended'] and self.meta('scan_complete',False) and not pending:
            streams=[{'streamId':s['stream_id'],'sequence':s['sequence']} for s in self.db.execute('SELECT stream_id,sequence FROM streams WHERE run_id=?',(self.run_id,))]
            api.request('POST',endpoint+'/finalize',{**ident,'streams':streams})
            with self.db:self.db.execute('UPDATE sessions SET finalized=1 WHERE run_id=?',(self.run_id,))
        with self.db:
            self.db.execute('UPDATE sessions SET last_error=NULL WHERE run_id=?',(self.run_id,))
            self.db.execute('DELETE FROM outbox WHERE acked_at<?',(time.time()-7*86400,))
        self.status()

def register_local(cfg,run_id,task_id,cwd,state_path,folder,config,source_cwd=None):
    db=connect(cfg)
    info={'cwd':str(cwd),'state_path':str(state_path),'folder':str(folder),'config_path':str(config),'createdAt':now(),'parent_pid':os.getpid(),'source_cwd':str(source_cwd or cwd)}
    with db:db.execute('INSERT OR IGNORE INTO sessions(run_id,task_id,info) VALUES(?,?,?)',(run_id,task_id,dump(info)))
    db.close()

def launch(bridge,run_id,task_id,cwd,state_path,folder,source_cwd=None):
    import subprocess
    register_local(bridge.cfg,run_id,task_id,cwd,state_path,folder,bridge.config_path,source_cwd=source_cwd)
    # Bind before Claude starts; registration failure is visible but doesn't kill the domain task.
    collector=Collector(bridge.cfg,run_id)
    with collector.db:collector.event('collector','lifecycle',{'state':'started','policy':'full-visible-redacted-v1'})
    try:collector.upload(1)
    except Exception:collector.status('采集绑定或同步失败，记录暂存本机；接入桥将重试')
    collector.db.close()
    child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'watch','--config',str(bridge.config_path),'--run',run_id,'--parent',str(os.getpid())],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    return child

def write_hook(folder,state,hook,**metadata):
    # Single append per hook, no user text or tool input in this channel.
    safe={key:metadata[key] for key in ('wait_kind','tool_use_id') if key in metadata}
    line=dump({'at':now(),'monotonic':time.monotonic(),'state':state,'hook':hook,'run_id':Path(folder).name,**safe})+'\n'
    path=Path(folder)/'collector-hooks.jsonl'
    fd=os.open(path,os.O_CREAT|os.O_APPEND|os.O_WRONLY,0o600)
    try:os.write(fd,line.encode())
    finally:os.close(fd)

def drain(bridge):
    db=connect(bridge.cfg)
    rows=db.execute('SELECT run_id FROM sessions WHERE finalized=0 ORDER BY rowid DESC LIMIT 3').fetchall();db.close()
    for row in rows:
        collector=Collector(bridge.cfg,row['run_id'])
        try:
            from platform_support import fcntl,process_alive
            with (collector.folder/'collector.lock').open('a') as lock:
                try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);available=True
                except OSError:available=False
                if available and not collector.row()['finalized'] and ((collector.folder/'summary.json').is_file() or (collector.info.get('parent_pid',0)<=0 or not process_alive(collector.info['parent_pid']))):
                    collector.finish_scan()
                    if not collector.row()['ended']:
                        with collector.db:
                            collector.coverage('采集器恢复补采，请核对源端结束与缺口')
                            collector.event('collector','lifecycle',{'state':'exited','boundary':'recovered_after_interruption'})
                            collector.db.execute('UPDATE sessions SET ended=1 WHERE run_id=?',(collector.run_id,))
            collector.upload(1)
        except Exception:collector.status('等待补传；请检查服务器连接、设备权限或采集规则')
        finally:collector.db.close()

def watch(cfg,run_id,parent):
    from platform_support import process_alive,fcntl
    collector=Collector(cfg,run_id);last_scan=0;next_upload=0;delay=1
    lock=(collector.folder/'collector.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:collector.db.close();lock.close();return
    try:
        while process_alive(parent) and not (collector.folder/'summary.json').is_file():
            if time.monotonic()-last_scan>=1:
                collector.scan();last_scan=time.monotonic()
            if time.monotonic()>=next_upload:
                try:collector.upload();delay=1
                except Exception:collector.status('同步失败，已保留本地队列');delay=min(60,delay*2)
                next_upload=time.monotonic()+delay
            time.sleep(.3)
        collector.finish_scan()
        with collector.db:
            if not collector.db.execute('SELECT 1 FROM cursors WHERE run_id=? AND path LIKE ?', (run_id,'%'+run_id+'.jsonl')).fetchone():collector.coverage('未找到本次原生会话记录')
            if not (collector.folder/'summary.json').is_file():collector.coverage('监督进程异常退出，原生结束边界未知')
            collector.event('collector','lifecycle',{'state':'exited','boundary':'wrapper_exit_observed'})
            collector.db.execute('UPDATE sessions SET ended=1 WHERE run_id=?',(run_id,))
        with contextlib.suppress(Exception):collector.upload(20)
    finally:collector.db.close();lock.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['watch']);parser.add_argument('--config',type=Path,default=config_path());parser.add_argument('--run',required=True);parser.add_argument('--parent',type=int,required=True)
    args=parser.parse_args();cfg=json.loads(args.config.read_text());watch(cfg,args.run,args.parent)
