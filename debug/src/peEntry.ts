// Reads the entry point address directly out of a PE header — the Windows counterpart to
// elfEntry.ts, needed for exactly the same reason: gdb's own `start` command needs a symbol table
// to resolve "main", and a fasm2 binary built without extra tooling has none. Without this, a
// Windows launch with stopOnEntry could only fail with "not a recognized ELF file" — not because
// anything was actually wrong, but because nothing here had ever read a PE header at all.
//
// The PE entry point in the file is a *relative* virtual address (RVA), unlike ELF's e_entry —
// meaning the address gdb needs to break at is ImageBase + AddressOfEntryPoint, not the raw field.
// That is a correctness risk if Windows relocates the image at load time (ASLR), which would make
// a breakpoint computed from the file alone land in the wrong place — but fasm2's PE output sets no
// IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE flag and writes no base relocation table, so Windows always
// loads it at exactly the ImageBase on disk; confirmed against a real launch, not just read from the
// header (a breakpoint set this way was hit at the expected address every time).
import * as fs from 'fs';

const MZ_MAGIC = Buffer.from([0x4d, 0x5a]); // "MZ"
const E_LFANEW_OFFSET = 0x3c;
const PE_MAGIC = Buffer.from([0x50, 0x45, 0x00, 0x00]); // "PE\0\0"
const COFF_HEADER_SIZE = 20;

// Offsets below are all relative to the start of the Optional Header (immediately after the COFF
// File Header). AddressOfEntryPoint sits at the same offset in both layouts — BaseOfData, present
// only in PE32, is the one field between it and the layouts diverging.
const OPTIONAL_MAGIC_OFFSET = 0;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const ADDRESS_OF_ENTRY_POINT_OFFSET = 16;
const IMAGE_BASE_OFFSET_PE32 = 28; // 4-byte ImageBase, after BaseOfCode + BaseOfData
const IMAGE_BASE_OFFSET_PE32_PLUS = 24; // 8-byte ImageBase, right after BaseOfCode (no BaseOfData)

/** Returns the PE entry point's runtime address (ImageBase + AddressOfEntryPoint), or undefined if
 * `fsPath` isn't a recognizable PE32/PE32+ file. */
export function readPeEntryPoint(fsPath: string): bigint | undefined {
  try {
    const fd = fs.openSync(fsPath, 'r');
    try {
      const dosHeader = Buffer.alloc(64);
      if (fs.readSync(fd, dosHeader, 0, dosHeader.length, 0) < 64 || !dosHeader.subarray(0, 2).equals(MZ_MAGIC)) return undefined;

      const peHeaderOffset = dosHeader.readUInt32LE(E_LFANEW_OFFSET);
      const peSignature = Buffer.alloc(4);
      if (fs.readSync(fd, peSignature, 0, 4, peHeaderOffset) < 4 || !peSignature.equals(PE_MAGIC)) return undefined;

      const optionalHeaderOffset = peHeaderOffset + 4 + COFF_HEADER_SIZE;
      // Enough to cover either layout's ImageBase, whichever this file turns out to have.
      const optional = Buffer.alloc(32);
      if (fs.readSync(fd, optional, 0, optional.length, optionalHeaderOffset) < optional.length) return undefined;

      const magic = optional.readUInt16LE(OPTIONAL_MAGIC_OFFSET);
      const entryRva = optional.readUInt32LE(ADDRESS_OF_ENTRY_POINT_OFFSET);
      if (magic === PE32_PLUS_MAGIC) return optional.readBigUInt64LE(IMAGE_BASE_OFFSET_PE32_PLUS) + BigInt(entryRva);
      if (magic === PE32_MAGIC) return BigInt(optional.readUInt32LE(IMAGE_BASE_OFFSET_PE32)) + BigInt(entryRva);
      return undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
