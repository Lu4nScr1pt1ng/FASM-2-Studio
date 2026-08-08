# FASM2 Studio

Editor tooling for [flat assembler g](https://flatassembler.net) (fasmg, distributed as "fasm2"),
with source compatibility for classic flat assembler 1. This extension drives whatever
`fasm2`/`fasm1` (and, for debugging, `gdb` — or `lldb-mi` on macOS) you already have installed — it doesn't bundle
a compiler or a debugger, the same way a C/C++ or Rust extension works with your existing
toolchain rather than shipping its own.

## What you get

Open a `.asm`, `.inc`, `.fasm`, `.fas`, or `.alm` file and it's syntax-highlighted immediately. Behind
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
modified) and launches it under gdb (or lldb-mi), with real breakpoints, stepping, and a live register
view. fasm2 doesn't emit standard debug info by default, so source-line mapping comes from that
listing instead — which also means there's no call-stack unwinding or typed variables; register
and memory inspection via gdb's own expression evaluator (`$eax`, `*(dword*)$esp`, ...) is the
right level of detail for raw assembly anyway. Currently fasm2/fasmg sources only.

## Setting up a project

`fasm2` is not a separate assembler: it is the `fasmg` binary plus a wrapper script that preloads
the standard x86 package. Which settings you need follows from that.

**A fasm2 project** needs nothing, as long as `fasm2` is on your `PATH`.

**A fasm1 project** needs the dialect pinned:

```json
{ "fasm2Studio.defaultDialect": "fasm1" }
```

`FASM: Select Dialect` writes the same setting from the command palette, creating
`.vscode/settings.json` if the project has none.

Dialect detection only recognizes fasm2-only syntax, so a fasm1 project using none of it falls back
to the default of `fasm2` and every file gets checked against the wrong assembler. If you skip this,
the first file that fails offers to set it for you — but only once the other assembler has compiled
that same file cleanly, so the suggestion is never a guess.

**A fasmg project** points at the raw binary:

```json
{ "fasm2Studio.fasm2CompilerPath": "fasmg" }
```

That is enough when your source includes its own instruction set. When a wrapper script preloads it
instead, the source has no `include` to follow and the editor would see no instructions at all, so
say what the wrapper passes:

```json
{
  "fasm2Studio.fasm2CompilerPath": "fasmg",
  "fasm2Studio.fasm2Preload": "myisa.inc",
  "fasm2Studio.includePath": "/path/to/includes;/path/to/more/includes"
}
```

Nothing about those two settings is x86-specific — they will load a 68000 or Z80 instruction set
just as readily, and the language server reads the same files the compiler does, so you get hover,
completion and go-to-definition for whatever they define.

## Requirements

Install `fasm2`/`fasmg` (and/or classic `fasm1`) yourself and make sure it's on `PATH`, or point
`fasm2Studio.fasm2CompilerPath` / `fasm2Studio.fasm1CompilerPath` at it in your settings.

To use the debugger:

- **Linux** — `gdb` (already installed on most distros; otherwise `apt install gdb`,
  `dnf install gdb`, or `pacman -S gdb`).
- **macOS** (experimental) — Apple ships no gdb, and Xcode's `lldb` does not speak the GDB/MI
  protocol this extension's debug adapter uses. The MI-speaking frontend is
  [`lldb-mi`](https://github.com/lldb-tools/lldb-mi) — build it from source (Apple stopped
  bundling it in 2019 and it isn't in Homebrew), then put it on `PATH` or point
  `fasm2Studio.gdbPath` at it.
- **Windows** — a `gdb` build, most easily from MSYS2 (`pacman -S mingw-w64-x86_64-gdb`) or
  w64devkit. There's no built-in gdb on Windows, so this is the one genuinely
  extra step compared to Linux.

## Settings

| Setting | Description |
| --- | --- |
| `fasm2Studio.defaultDialect` | Dialect assumed when it can't be auto-detected from a file's contents. |
| `fasm2Studio.fasm2CompilerPath` | Path to fasm2/fasmg. Leave empty to auto-detect on PATH. |
| `fasm2Studio.fasm1CompilerPath` | Path to fasm1. Leave empty to auto-detect on PATH. |
| `fasm2Studio.includePath` | Semicolon-separated extra directories to search for a bare `include 'foo.inc'` not found next to the including file (passed as the compiler's `INCLUDE` environment variable). Many real fasmg projects need this to build at all. |
| `fasm2Studio.fasm2Preload` | Include file assembled before the source itself (fasmg's `-i` flag), for projects whose instruction set is preloaded by a wrapper script rather than written in the source — how `fasm2` supplies x86, and how instruction-set ports commonly supply theirs. The language server follows it too, so those instructions get hover and completion. Use `fasm2.inc` (with `includePath` pointing at fasm2's `include` directory) to drive a bare `fasmg` binary as if it were `fasm2`. |
| `fasm2Studio.gdbPath` | Path to gdb, used by `FASM: Debug`. Leave empty to use `gdb` from PATH. |
| `fasm2Studio.diagnosticsEnabled` | Compile in the background to show errors/warnings as you edit. |
| `fasm2Studio.diagnosticsDebounceMs` | How long to wait after you stop typing before re-running diagnostics. |
| `fasm2Studio.buildOutputPath` | Output path for Build/Run/Debug, relative to the source file's directory (e.g. `../bin/cc`) — keeps build output out of the source tree. Leave empty to build next to the source. |

## Source and issues

[github.com/Lu4nScr1pt1ng/FASM-2-Studio](https://github.com/Lu4nScr1pt1ng/FASM-2-Studio) — bug
reports, feature requests, and contributions welcome; see `CONTRIBUTING.md` in the repository.

## Licensing

This extension is MIT-licensed. flat assembler itself is a separate project with its own license,
held by its author, Tomasz Grysztar; the compiler and debugger are never shipped or redistributed
— this extension just invokes whatever copy you have installed. The one exception is a small,
unmodified fasmg macro file redistributed under its own BSD-style license and injected during
`FASM: Debug` builds to generate the listing used for source-line mapping (see this repository's
`debug/debug-support/NOTICE.md`).
