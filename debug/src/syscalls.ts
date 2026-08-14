// Linux syscall number -> name, for both x86 calling conventions.
//
// This exists because of what a fasm2 program mostly *is*. A program with no libc — which is the
// normal shape for the binaries this debugger is built for — talks to the kernel directly, so the
// interesting moments in it are almost all `syscall` instructions, and the entire meaning of one is
// carried by a bare number in rax. "rax = 1" at a breakpoint is `write`; "rax = 60" is `exit`. That
// translation is a thing you either have memorised for the dozen you use, or look up in a table on
// another screen, for every call you did not write today.
//
// The numbers themselves are a stable kernel ABI — Linux does not renumber a syscall once released,
// because doing so would break every binary in existence — so a table is a legitimate thing to
// carry rather than something to ask the target for at runtime. The data file was generated from
// the kernel's own uapi headers (`/usr/include/asm/unistd_64.h` and `unistd_32.h`), which are the
// authority the assembler-side constants come from too.
//
// The two tables are genuinely different, not one table with an offset: on i386 `write` is 4 and
// `exit` is 1, on x86-64 `write` is 1 and `exit` is 60. Picking the wrong one does not fail, it
// silently names the wrong call — which is why the caller passes the target's own width rather than
// this module guessing.
import syscallData from './data/syscalls.json';

const TABLES: Record<'x86_64' | 'i386', Record<string, string>> = syscallData;

export type SyscallAbi = 'x86_64' | 'i386';

/** The name of syscall `number` under `abi`, or undefined for a number no syscall has — including
 * the -1 Linux reports in `orig_rax` when the program is not in a syscall at all, and any number
 * past the end of the table, which a program can perfectly well put in rax and would get ENOSYS
 * for. Naming one of those anyway would be inventing a call that does not exist. */
export function syscallName(abi: SyscallAbi, number: bigint): string | undefined {
  if (number < 0n || number > 0xffffn) return undefined;
  return TABLES[abi][number.toString()];
}

/** The syscall register conventions, which differ from the C function-call ones and are the source
 * of a specific, very common bug: the fourth argument goes in `r10`, not `rcx`, because the
 * `syscall` instruction itself overwrites rcx with the return address. Code that passes it in rcx
 * assembles fine and silently passes garbage. */
export const SYSCALL_ARGUMENT_REGISTERS: Record<SyscallAbi, readonly string[]> = {
  x86_64: ['rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9'],
  i386: ['ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp'],
};

/** Where the syscall number is read from, and where its result comes back. */
export const SYSCALL_NUMBER_REGISTER: Record<SyscallAbi, string> = { x86_64: 'rax', i386: 'eax' };
