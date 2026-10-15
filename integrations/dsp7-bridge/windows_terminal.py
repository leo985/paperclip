"""ConPTY and authenticated loopback terminal transport for native Windows."""
from __future__ import annotations
import base64
import codecs
import ctypes
import hmac
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import socket
import subprocess
import sys
import time
from platform_support import private_directory, terminate_tree


def endpoint_path(run_id):
    import uuid
    if str(uuid.UUID(run_id)) != run_id:raise RuntimeError('Invalid run ID')
    return private_directory(Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'ZhiyanSeat'/'terminals')/(run_id+'.json')


def listen(path):
    from pilot import atomic_json
    listener=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
    listener.bind(('127.0.0.1',0));listener.listen(4)
    token=secrets.token_hex(32)
    atomic_json(path,{'port':listener.getsockname()[1],'token':token})
    return listener,token


def accept(listener,token):
    client,_=listener.accept();client.settimeout(3)
    try:
        # Exactly one auth line, no raw input frames before authentication.
        raw=b''
        while len(raw)<=256 and not raw.endswith(b'\n'):
            value=client.recv(1)
            if not value:raise ValueError('No terminal authentication')
            raw+=value
        data=json.loads(raw)
        if not hmac.compare_digest(str(data.get('token','')),token):raise ValueError('Invalid terminal authentication')
        client.settimeout(10);return client
    except (OSError,ValueError,TypeError):client.close();return None


class ConPtyChild:
    def __init__(self,command,cwd,env):
        from winpty import PtyProcess
        from platform_support import windows_git_bash
        if len(subprocess.list2cmdline(command))>=32760:raise RuntimeError('Claude startup context exceeds the Windows command-line limit; reduce the task startup context')
        env=dict(env);env.setdefault('CLAUDE_CODE_GIT_BASH_PATH',windows_git_bash())
        # ConPTY is the Windows 10 1809+ native pseudoconsole backend.
        self.pty=PtyProcess.spawn(command,cwd=cwd,env=env,dimensions=(32,120),backend=1)
        self.pid=self.pty.pid
    @property
    def returncode(self):return None if self.pty.isalive() else self.pty.exitstatus
    def poll(self):return self.returncode
    def wait(self,timeout=None):
        until=time.monotonic()+timeout if timeout is not None else float('inf')
        while self.poll() is None:
            if time.monotonic()>=until:raise subprocess.TimeoutExpired('Claude ConPTY',timeout)
            time.sleep(.05)
        return self.returncode
    def kill(self):self.pty.terminate(force=True)


class ConPtyMaster:
    def __init__(self,child):self.child=child;self.decoder=codecs.getincrementaldecoder('utf-8')()
    def fileno(self):return self.child.pty.fileno()
    def read(self,size):
        try:
            data=self.child.pty.read(size)
            return data.encode('utf-8') if data else None
        except EOFError:return b''
    def write(self,data):
        text=self.decoder.decode(bytes(data))
        if text:self.child.pty.write(text)
        return len(data)
    def resize(self,rows,cols):self.child.pty.setwinsize(rows,cols)
    def close(self):self.child.pty.close(force=True)


def attach(run_id):
    from pilot import read_json
    import msvcrt
    endpoint=read_json(endpoint_path(run_id))
    port=endpoint.get('port')
    if type(port) is not int or not 1<=port<=65535:raise RuntimeError('Invalid terminal endpoint')
    conn=socket.create_connection(('127.0.0.1',port),timeout=10)
    conn.sendall(json.dumps({'token':endpoint['token']}).encode()+b'\n')
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.GetStdHandle.argtypes=[ctypes.c_uint32];kernel.GetStdHandle.restype=ctypes.c_void_p
    kernel.GetConsoleMode.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)]
    kernel.SetConsoleMode.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
    stdin=kernel.GetStdHandle(-10 & 0xffffffff);stdout=kernel.GetStdHandle(-11 & 0xffffffff)
    in_mode=ctypes.c_uint32();out_mode=ctypes.c_uint32()
    if not kernel.GetConsoleMode(stdin,ctypes.byref(in_mode)) or not kernel.GetConsoleMode(stdout,ctypes.byref(out_mode)):
        conn.close();raise RuntimeError('Run harness in an interactive PowerShell or Windows Terminal console')
    def send(value):conn.sendall(json.dumps(value).encode()+b'\n')
    keys={'H':'\x1b[A','P':'\x1b[B','M':'\x1b[C','K':'\x1b[D','G':'\x1b[H','O':'\x1b[F','S':'\x1b[3~','R':'\x1b[2~','I':'\x1b[5~','Q':'\x1b[6~'}
    decoder=codecs.getincrementaldecoder('utf-8')(errors='replace');last_size=None
    print('Connected to '+run_id+'. Ctrl+] detaches; harness attach reconnects. Keep this window for approvals.',flush=True)
    try:
        if not kernel.SetConsoleMode(stdout,out_mode.value|0x0004):raise OSError('Cannot enable ANSI terminal output')
        if not kernel.SetConsoleMode(stdin,(in_mode.value & ~(0x0001|0x0002|0x0004|0x0040))|0x0080):raise OSError('Cannot enable terminal input')
        while True:
            size=shutil.get_terminal_size()
            if size!=last_size:send({'op':'resize','rows':size.lines,'cols':size.columns});last_size=size
            ready,_,_=select.select([conn],[],[],.03)
            if ready:
                data=conn.recv(65536)
                if not data:break
                sys.stdout.write(decoder.decode(data));sys.stdout.flush()
            if msvcrt.kbhit():
                char=msvcrt.getwch()
                if char=='\x1d':break
                if char in ('\x00','\xe0'):char=keys.get(msvcrt.getwch(),'')
                elif 0xD800<=ord(char)<=0xDBFF:
                    pair=char+msvcrt.getwch();char=pair.encode('utf-16','surrogatepass').decode('utf-16')
                if char:send({'op':'input','data':base64.b64encode(char.encode('utf-8')).decode()})
    finally:
        kernel.SetConsoleMode(stdin,in_mode.value);kernel.SetConsoleMode(stdout,out_mode.value);conn.close()
        print('\nTerminal detached. Check harness status for the task result.')
