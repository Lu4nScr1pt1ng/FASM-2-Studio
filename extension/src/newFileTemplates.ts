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
  /**
   * Platform whose loader runs this template's output, as reported by process.platform — or
   * undefined for output that no operating system loads at all (a boot sector, a flat binary),
   * which is therefore neither native to the host nor foreign to it.
   */
  platform?: NodeJS.Platform;
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

const LINUX_HELLO_32 = `; Hello world for 32-bit Linux, in flat assembler syntax.
; Build and run it with the play button in the editor title bar, or "FASM: Build and Run".
;
; The 64-bit template is the one to start from on a modern machine; this exists for following
; along with the large body of x86 material written against the 32-bit interface, which is a
; different one — the call number goes in eax either way, but the arguments are ebx/ecx/edx rather
; than rdi/rsi/rdx, and it is entered with "int 0x80" rather than "syscall".

format ELF executable 3
entry start

segment readable executable

start:
; write(STDOUT_FILENO, message, message_len)
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, message
        mov     edx, message_len
        int     0x80

; exit(0)
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

segment readable writeable

message db 'Hello, world!', 10
message_len = $ - message
`;

const WINDOWS_HELLO_32 = `; Hello world for 32-bit Windows, in flat assembler syntax.
; Build and run it with the play button in the editor title bar, or "FASM: Build and Run".
;
; win32a.inc ships with the assembler itself and supplies the "invoke" macro. fasm2 finds it
; without any configuration; fasm1 needs its own include directory on INCLUDE, or in the
; fasm2Studio.includePath setting.
;
; The 32-bit calling convention is what makes this shorter than the 64-bit template: arguments go
; on the stack and the callee cleans them up, so there is no shadow space to reserve.

format PE console
entry start

include 'win32a.inc'

section '.text' code readable executable

start:
        invoke  GetStdHandle, STD_OUTPUT_HANDLE
        invoke  WriteFile, eax, message, message_len, written, 0
        invoke  ExitProcess, 0

section '.data' data readable writeable

message db 'Hello, world!', 13, 10
message_len = $ - message
written dd ?

section '.idata' import data readable writeable

library kernel32, 'KERNEL32.DLL'
import kernel32, GetStdHandle, 'GetStdHandle', WriteFile, 'WriteFile', ExitProcess, 'ExitProcess'
`;

const WINDOWS_DLL = `; A 64-bit Windows DLL exporting one function, in flat assembler syntax.
; "FASM: Build" assembles it; there is nothing to run, since a DLL is loaded by something else.
;
; Name an export after an instruction and it will not assemble: fasmg's x86 package defines
; mnemonics case-insensitively, so a procedure called "Add" is read as the "add" instruction.
;
; The .reloc section is what makes the DLL relocatable. Without it the loader has to place the
; image at its preferred base address or fail, which under ASLR it generally cannot.

format PE64 DLL
entry DllMain

include 'win64a.inc'

section '.text' code readable executable

proc DllMain hinstDLL, fdwReason, lpvReserved
        mov     eax, TRUE
        ret
endp

proc AddNumbers first, second
; The first two integer arguments arrive in rcx and rdx, and the result goes back in rax.
        mov     rax, rcx
        add     rax, rdx
        ret
endp

section '.edata' export data readable

export 'EXAMPLE.DLL', AddNumbers, 'AddNumbers'

section '.reloc' fixups data readable discardable
`;

const BOOT_SECTOR = `; A boot sector: 512 bytes the BIOS loads at 0x7C00 and jumps to, with no operating system
; underneath and no loader to help. "FASM: Build" produces a raw image you can write to a USB
; stick or hand to an emulator (qemu-system-i386 -fda <output>, or -hda for a disk image).
;
; There is nothing to run with the play button here, and no debugging either — the debugger drives
; a process, and this is not one.
;
; The CPU starts in 16-bit real mode, hence "use16": every instruction below assembles to the
; 16-bit encoding, and the BIOS teletype call is the only output available before you have written
; a driver of your own.

format binary as 'bin'
use16
org 0x7C00

start:
; Set 80x25 text mode, which also clears the screen.
        mov     ax, 0x0003
        int     0x10

        mov     si, message
        call    print

; Nothing to return to: halt, and stay halted through any interrupt that wakes us.
.halt:
        hlt
        jmp     .halt

; Writes the null-terminated string at ds:si through the BIOS teletype call.
print:
        lodsb
        test    al, al
        jz      .done
        mov     ah, 0x0E
        mov     bx, 0x0007
        int     0x10
        jmp     print
.done:
        ret

message db 'Hello from the boot sector!', 0

; Pad to 510 bytes, then the signature the BIOS checks for before it will boot the sector at all.
        db      (510 - ($ - $$)) dup 0
        dw      0xAA55
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
  {
    label: 'Linux — hello world (32-bit)',
    detail: 'format ELF executable 3, using the int 0x80 syscall interface.',
    platform: 'linux',
    fileName: 'hello32.asm',
    content: LINUX_HELLO_32,
  },
  {
    label: 'Windows — hello world (32-bit)',
    detail: "format PE console, calling WriteFile through win32a.inc's invoke macro.",
    platform: 'win32',
    fileName: 'hello32.asm',
    content: WINDOWS_HELLO_32,
  },
  {
    label: 'Windows — DLL',
    detail: 'format PE64 DLL, exporting one function. Builds, but has nothing to run.',
    platform: 'win32',
    fileName: 'library.asm',
    content: WINDOWS_DLL,
  },
  {
    label: 'Boot sector — no operating system',
    detail: 'format binary, 16-bit real mode, padded to 512 bytes ending in 55 AA.',
    fileName: 'boot.asm',
    content: BOOT_SECTOR,
  },
];

/**
 * The templates on offer, the ones matching `platform` first — they are what produces a binary this
 * machine can actually run, and the point of the command is a program the user can build and run in
 * the next breath. The rest stay on the list rather than being hidden, since cross-assembling is
 * something fasm does perfectly well and people do it deliberately.
 *
 * macOS has no entry of its own: fasmg can emit Mach-O, but a current Mac runs an x86-64 binary
 * only under Rosetta and wants it signed, so a hello world that cannot be run would be a worse
 * answer than offering the ones that can. The boot sector is a real answer there, which is part of
 * why it is not ranked last.
 */
export function templatesFor(platform: NodeJS.Platform): FasmTemplate[] {
  return [...TEMPLATES].sort((a, b) => rank(a, platform) - rank(b, platform));
}

/**
 * Sort key for the list above: what this machine can run, then what no machine is expected to run
 * in the first place, then what belongs to some other operating system.
 *
 * The boot sector sits in the middle rather than last because "you cannot double-click this" is a
 * property it has everywhere — it is not the wrong choice for this host the way a PE binary is on
 * Linux, and demoting it below a template that this machine genuinely cannot execute would say
 * otherwise. Array.prototype.sort is stable, so templates of equal rank keep their declared order.
 */
function rank(template: FasmTemplate, platform: NodeJS.Platform): number {
  if (template.platform === platform) return 0;
  return template.platform === undefined ? 1 : 2;
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
