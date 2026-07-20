# Changelog

## 0.2.1

- No functional changes; fixes the publish workflow (previous tag failed CI validation).

## 0.2.0

- Completion, hover, go-to-definition, and diagnostics now recognize `format`/`segment`/`section`
  sub-keywords (e.g. `ELF64`, `executable`, `readable`, `DLL`) and operand-size/addressing
  qualifiers (e.g. `byte`, `dword`, `ptr`, `near`) as first-class symbols.

## 0.1.0

Initial release.

- Syntax highlighting, language configuration, and snippets for fasm2/fasmg, with source
  compatibility for classic fasm1.
- Completion and hover for instructions, registers, directives, and your own labels/macros/
  constants; go-to-definition, find-references, rename, and workspace symbol search, backed by a
  background workspace index that stays fast on real-sized projects.
- Live diagnostics from the real fasm2/fasm1 compiler, including for unsaved buffers.
- Signature help for macro calls.
- `FASM: Build`, `FASM: Build and Run`, `FASM: Run`, and automatic compiler discovery with a
  status-bar picker.
- `FASM: Debug` — a real debugger for fasm2 binaries, driving gdb/lldb over their machine
  interface, with an address-to-source-line map built from an injected listing macro (fasm2 emits
  no DWARF/CodeView by default). Breakpoints, stepping, and register inspection; fasm1 isn't
  supported by the debugger yet (its native listing format differs and wasn't verified against a
  real fasm1 install).
