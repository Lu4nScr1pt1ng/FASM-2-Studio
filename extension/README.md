# FASM2 Studio

Editor tooling for [flat assembler g](https://flatassembler.net) (fasmg, distributed as "fasm2"),
with source compatibility for classic flat assembler 1. This extension drives whatever
`fasm2`/`fasm1` (and, for debugging, `gdb`/`lldb`) you already have installed — it doesn't bundle
a compiler or a debugger, the same way a C/C++ or Rust extension works with your existing
toolchain rather than shipping its own.

## What you get

Open a `.asm`, `.inc`, `.fasm`, or `.fas` file and it's syntax-highlighted immediately. Behind
that, a language server parses your project and gives you:

- **Completion and hover** for instructions, registers, directives, `format`/`segment`/`section`
  sub-keywords (`ELF64`, `executable`, `DLL`, ...), operand-size/addressing qualifiers (`byte`,
  `dword`, `ptr`, `near`, ...), and your own labels/macros/constants.
- **Go to definition, find references, rename, and workspace symbol search** that work across
  your whole project — not just the open file. Files are indexed once in the background and kept
  in sync as you edit, so this stays fast on real-sized projects.
- **Signature help** while you're filling in a macro call.
- **Live diagnostics from the real compiler** — errors and warnings come from actually running
  fasm2/fasm1 in the background as you type, parsed from its real output, not a hand-rolled
  approximation of its rules. Works for unsaved buffers too.

`FASM: Build`, `FASM: Build and Run`, and `FASM: Run` compile and execute the active file. The
extension finds your compiler automatically; a status bar item shows which one it picked and lets
you override it.

`FASM: Debug` assembles the active file with an injected listing macro (your source is never
modified) and launches it under gdb/lldb, with real breakpoints, stepping, and a live register
view. fasm2 doesn't emit standard debug info by default, so source-line mapping comes from that
listing instead — which also means there's no call-stack unwinding or typed variables; register
and memory inspection via gdb's own expression evaluator (`$eax`, `*(dword*)$esp`, ...) is the
right level of detail for raw assembly anyway. Currently fasm2/fasmg sources only.

## Requirements

Install `fasm2`/`fasmg` (and/or classic `fasm1`) yourself and make sure it's on `PATH`, or point
`fasm2Studio.fasm2CompilerPath` / `fasm2Studio.fasm1CompilerPath` at it in your settings.

To use the debugger:

- **Linux** — `gdb` (already installed on most distros; otherwise `apt install gdb`,
  `dnf install gdb`, or `pacman -S gdb`).
- **macOS** — Xcode Command Line Tools (`xcode-select --install`), which provides `lldb`.
- **Windows** — a `gdb` build, most easily from MSYS2 (`pacman -S mingw-w64-x86_64-gdb`) or
  w64devkit. There's no built-in equivalent to gdb/lldb on Windows, so this is the one genuinely
  extra step compared to the other two platforms.

## Settings

| Setting | Description |
| --- | --- |
| `fasm2Studio.defaultDialect` | Dialect assumed when it can't be auto-detected from a file's contents. |
| `fasm2Studio.fasm2CompilerPath` | Path to fasm2/fasmg. Leave empty to auto-detect on PATH. |
| `fasm2Studio.fasm1CompilerPath` | Path to fasm1. Leave empty to auto-detect on PATH. |
| `fasm2Studio.gdbPath` | Path to gdb, used by `FASM: Debug`. Leave empty to use `gdb` from PATH. |
| `fasm2Studio.diagnosticsEnabled` | Compile in the background to show errors/warnings as you edit. |
| `fasm2Studio.diagnosticsDebounceMs` | How long to wait after you stop typing before re-running diagnostics. |
| `fasm2Studio.buildOutputPath` | Output path for Build/Run/Debug, relative to the source file's directory (e.g. `../bin/cc`) — keeps build output out of the source tree. Leave empty to build next to the source. |

## Source and issues

[github.com/Lu4nScr1pt1ng/FASM-2-Studio](https://github.com/Lu4nScr1pt1ng/FASM-2-Studio) — bug
reports, feature requests, and contributions welcome; see `CONTRIBUTING.md` in the repository.

## Licensing

This extension is MIT-licensed. flat assembler itself is a separate project with its own license,
held by its author, Tomasz Grysztar; this extension doesn't redistribute it and just invokes
whatever copy you have installed.
