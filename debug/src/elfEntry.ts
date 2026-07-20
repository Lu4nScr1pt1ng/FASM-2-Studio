// Reads the entry point address directly out of an ELF header. This exists because gdb's own
// `start` command (temporary breakpoint at the entry point, then run) requires a symbol table to
// resolve "main" — but fasm2 binaries built without extra tooling have none, so `start` fails
// with "No symbol table loaded" even though the entry address is sitting right there in the
// header. The ELF header layout is small and stable, so parsing it directly is simpler and more
// reliable than working around gdb's symbol requirement.
import * as fs from 'fs';

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // "\x7fELF"
const EI_CLASS_OFFSET = 4;
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const E_ENTRY_OFFSET = 24; // same offset in both ELF32 and ELF64 headers, differs only in width

/** Returns the ELF entry point address, or undefined if `fsPath` isn't a recognizable ELF file. */
export function readElfEntryPoint(fsPath: string): bigint | undefined {
  try {
    const fd = fs.openSync(fsPath, 'r');
    try {
      const header = Buffer.alloc(32);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      if (bytesRead < 32 || !header.subarray(0, 4).equals(ELF_MAGIC)) return undefined;

      const elfClass = header[EI_CLASS_OFFSET];
      if (elfClass === ELFCLASS64) return header.readBigUInt64LE(E_ENTRY_OFFSET);
      if (elfClass === ELFCLASS32) return BigInt(header.readUInt32LE(E_ENTRY_OFFSET));
      return undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
