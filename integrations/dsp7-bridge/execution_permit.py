"""Monotonic, fail-closed supervision for server-issued run permits.
The watchdog continues while HTTP calls block. It never restarts a process.
"""
import subprocess
import threading
import time
from pilot import BridgeError
from platform_support import terminate_tree


class ExecutionPermit:
    def __init__(self, terminate=terminate_tree, clock=time.monotonic):
        self.clock = clock
        self.terminate = terminate
        self.lock = threading.Lock()
        self.deadline = None
        self.child = None
        self.expired = False
        self.closed = threading.Event()
        self.thread = None
        self.permit_id = None

    def renew(self, permit, request_started):
        ttl = permit.get('validForMs') if isinstance(permit, dict) else None
        if (not isinstance(permit, dict) or permit.get('protocolVersion') != 1
                or type(ttl) is not int or not 0 < ttl <= 60000
                or permit.get('mode') != 'observed_cost' or not isinstance(permit.get('permitId'), str)):
            raise BridgeError('执行许可合同无效，停止本机执行')
        with self.lock:
            if self.expired or self.deadline is not None and self.clock() >= self.deadline:
                self.expired = True
                raise BridgeError('执行许可已经到期，不能续验复活')
            if self.permit_id and self.permit_id != permit['permitId']:
                raise BridgeError('运行许可身份发生变化')
            # Starting at request dispatch is deliberately conservative: wall
            # clock rollback and network delay cannot extend server validity.
            deadline = request_started + ttl / 1000
            if deadline <= self.clock():
                raise BridgeError('执行许可响应已过期，不能启动或继续执行')
            self.permit_id = permit['permitId']
            self.deadline = deadline

    def check(self):
        child = None
        with self.lock:
            if self.expired or self.deadline is not None and self.clock() >= self.deadline:
                self.expired = True
                child = self.child
        if child is not None: self.terminate(child)
        if self.expired: raise BridgeError('执行许可到期，已要求停止受管进程')

    def attach(self, child):
        with self.lock: self.child = child
        self.check()

    def start(self):
        def watch():
            while not self.closed.wait(.25):
                try: self.check()
                except BridgeError:
                    # Expiry is irreversible, but keep retrying a failed stop.
                    # The caller can still be blocked in a network operation.
                    continue
                except (OSError, subprocess.SubprocessError):
                    continue
        self.thread = threading.Thread(target=watch, name='execution-permit-watchdog', daemon=True)
        self.thread.start()

    def close(self):
        self.closed.set()
        if self.thread: self.thread.join(timeout=15)
