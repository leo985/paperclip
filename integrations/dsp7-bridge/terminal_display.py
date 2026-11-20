"""Stream complete UTF-8/VT tokens; restore presentation without replaying raw history."""
from __future__ import annotations
import codecs
import json
import re


# Restore shell presentation even when Claude exits before writing its epilogue.
CLEANUP = (b'\x18\x1b\\'  # Cancel a truncated CSI / terminate an unfinished OSC first.
           b'\x1b[?2026l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'
           b'\x1b[?1004l\x1b[?2004l\x1b[?2031l\x1b[?1l\x1b>'
           b'\x1b[0m\x1b[r\x1b[?25h\x1b[?1049l')


def initial_terminal(client):
    """Both old and new clients send resize first. Do not consume later input."""
    raw = bytearray()
    while len(raw) < 4096:
        data = client.recv(1)
        if not data:
            raise ValueError('终端在尺寸协商完成前断开')
        if data == b'\n':
            break
        raw.extend(data)
    else:
        raise ValueError('终端尺寸协商帧过大')
    frame = json.loads(raw)
    if frame.get('op') != 'resize':
        raise ValueError('终端未提供初始窗口尺寸，请更新客户端')
    rows, cols = frame.get('rows'), frame.get('cols')
    if any(type(n) is not int or not 1 <= n <= 1000 for n in (rows, cols)):
        raise ValueError('终端窗口尺寸无效')
    env = {}
    for field, name in [('term', 'TERM'), ('term_program', 'TERM_PROGRAM'), ('colorterm', 'COLORTERM')]:
        value = frame.get(field)
        if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.+ -]{1,80}', value):
            env[name] = value
    return rows, cols, env


def size_frame(rows, cols):
    import os
    return {'op': 'resize', 'rows': rows, 'cols': cols,
            'term': os.environ.get('TERM', 'xterm-256color'),
            'term_program': os.environ.get('TERM_PROGRAM', ''),
            'colorterm': os.environ.get('COLORTERM', '')}


class TerminalDisplay:
    """Keep mode state and incomplete tokens only, never an arbitrary byte tail."""
    MODES = {1, 7, 25, 1000, 1002, 1003, 1004, 1006, 1049, 2004, 2031}

    def __init__(self):
        self.decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        self.state = 'text'
        self.pending = ''
        self.oversize = False
        self.modes = {7: True, 25: True}

    def feed(self, data):
        output = []
        for char in self.decoder.decode(data):
            if self.state == 'text':
                if char == '\x1b':
                    self.pending = char
                    self.state = 'escape'
                else:
                    output.append(char)
                continue
            if not self.oversize:
                self.pending += char
                if len(self.pending) > 65536:
                    self.pending = ''
                    self.oversize = True
            complete = False
            if self.state == 'escape':
                if char == '[':
                    self.state = 'csi'
                elif char in ']PX^_':
                    self.state = 'string'
                elif ' ' <= char <= '/':
                    self.state = 'intermediate'
                else:
                    complete = True
            elif self.state == 'csi':
                if '@' <= char <= '~':
                    match = re.fullmatch(r'\x1b\[\?([0-9;]+)([hl])', self.pending)
                    if match:
                        for mode in match[1].split(';'):
                            if mode.isdigit() and len(mode)<=4 and int(mode) in self.MODES:
                                self.modes[int(mode)] = match[2] == 'h'
                    complete = True
            elif self.state == 'intermediate':
                complete = '0' <= char <= '~'
            elif self.state == 'string':
                if char == '\x07':
                    complete = True
                elif char == '\x1b':
                    self.state = 'string_escape'
            elif self.state == 'string_escape':
                complete = char == '\\'
                self.state = 'string' if char != '\x1b' else 'string_escape'
            if complete:
                if not self.oversize:
                    output.append(self.pending)
                self.pending = ''
                self.oversize = False
                self.state = 'text'
        return ''.join(output).encode('utf-8')

    def restore(self):
        # A new viewer needs the current modes, then a fresh render requested
        # through PTY resize. Replaying a cut byte tail corrupts VT/UTF-8 state.
        parts = ['\x1b[?2026l', '\x1b[?1049' + ('h' if self.modes.get(1049) else 'l'),
                 '\x1b[0m', '\x1b[r', '\x1b[2J', '\x1b[H']
        parts += ['\x1b[?' + str(mode) + ('h' if self.modes.get(mode, False) else 'l')
                  for mode in sorted(self.MODES - {1049})]
        return ''.join(parts).encode('ascii')


def clean_prompt(prompt, platform_dispatch=False):
    # Remove only bridge-owned protocol comments. Keep business text, code,
    # approval constraints and the authoritative server/local records intact.
    prompt = re.sub(r'<!-- DSP7-(?:JIRA-INTAKE(?:-AUTH)?|INTAKE-RESULT)\s.*?-->',
                    '', prompt, flags=re.DOTALL)
    if platform_dispatch:
        prompt = re.sub(r'接入已完成。在所选席位 [^\r\n]*`harness start [^`]*`[^\r\n]*',
                        '本次已由智研协同平台明确派单；接入桥已核验本机启动授权。', prompt)
    return prompt
