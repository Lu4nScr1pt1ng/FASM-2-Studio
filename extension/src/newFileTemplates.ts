// The programs "FASM: New File" writes, and the pure choices around them. Kept apart from the
// command itself (newFile.ts) so the templates can be assembled by a real compiler in a unit test
// without a running VS Code — the only way to know they still work is to build them.
//
// Both are laid out to the formatter's own default columns (mnemonics at 8, operands at 16, no
// trailing comments to align), so Format Document on a freshly created file changes nothing.

import * as path from 'path';

export interface FasmTemplate {
  /** QuickPick label. */
  label: string;
  /** QuickPick detail line. */
  detail: string;
  /** Platform this template targets, as reported by process.platform. */
  platform: NodeJS.Platform;
  /** Default file name offered for it. */
  fileName: string;
  content: string;
}

const LINUX_HELLO = `; Hello world for Linux, in flat assembler syntax.
; Build and run it with the play button in the editor title bar, or "FASM: Build and Run".
; Set a breakpoint in the margin and press F5 to step through it.

format ELF64 executable 3
entry start

segment readable executable

start:
; write(STDOUT_FILENO, message, message_len)
        mov     eax, 1
        mov     edi, 1
        mov     esi, message
        mov     edx, message_len
        syscall

; exit(0)
        mov     eax, 60
        xor     edi, edi
        syscall

segment readable writeable

message db 'Hello, world!', 10
message_len = $ - message
`;

const WINDOWS_HELLO = `; Hello world for Windows, in flat assembler syntax.
; Build and run it with the play button in the editor title bar, or "FASM: Build and Run".
;
; win64a.inc ships with the assembler itself and supplies the "invoke" macro. fasm2 finds it
; without any configuration; fasm1 needs its own include directory on INCLUDE, or in the
; fasm2Studio.includePath setting.

format PE64 console
entry start

include 'win64a.inc'

section '.text' code readable executable

start:
; Reserve the shadow space every win64 call expects, then write to the console and exit.
        sub     rsp, 8*5
        invoke  GetStdHandle, STD_OUTPUT_HANDLE
        invoke  WriteFile, rax, message, message_len, written, 0
        invoke  ExitProcess, 0

section '.data' data readable writeable

message db 'Hello, world!', 13, 10
message_len = $ - message
written dq ?

section '.idata' import data readable writeable

library kernel32, 'KERNEL32.DLL'
import kernel32, GetStdHandle, 'GetStdHandle', WriteFile, 'WriteFile', ExitProcess, 'ExitProcess'
`;

export const TEMPLATES: readonly FasmTemplate[] = [
  {
    label: 'Linux — hello world',
    detail: 'format ELF64 executable 3, writing to stdout with raw syscalls. No includes needed.',
    platform: 'linux',
    fileName: 'hello.asm',
    content: LINUX_HELLO,
  },
  {
    label: 'Windows — hello world',
    detail: "format PE64 console, calling WriteFile through win64a.inc's invoke macro.",
    platform: 'win32',
    fileName: 'hello.asm',
    content: WINDOWS_HELLO,
  },
];

/**
 * The templates on offer, the one matching `platform` first — it is the only one that produces a
 * binary this machine can actually run, and the point of the command is a program the user can
 * build and run in the next breath. The other stays on the list rather than being hidden, since
 * cross-assembling is something fasm does perfectly well and people do it deliberately.
 *
 * macOS has no entry: fasmg can emit Mach-O, but a current Mac runs an x86-64 binary only under
 * Rosetta and wants it signed, so a hello world that cannot be run would be a worse answer than
 * offering the two that can.
 */
export function templatesFor(platform: NodeJS.Platform): FasmTemplate[] {
  return [...TEMPLATES].sort((a, b) => Number(b.platform === platform) - Number(a.platform === platform));
}

/**
 * `fileName`, with a numeric suffix if it is taken (hello.asm, hello2.asm, ...). Creating a file
 * is not the place to ask a "really overwrite?" question — the user asked for a new file, and
 * silently replacing the one they wrote yesterday would be the worst possible reading of that.
 */
export function uniqueFileName(taken: ReadonlySet<string>, fileName: string): string {
  if (!taken.has(fileName)) return fileName;
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
