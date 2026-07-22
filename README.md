# FASM2 Studio

A VS Code extension for [flat assembler g](https://flatassembler.net) (fasmg, distributed under
the name "fasm2"), with source compatibility for classic flat assembler 1. It gives you syntax
highlighting, autocomplete, hover docs, go-to-definition/references/rename/workspace-symbol-search
across your whole project, live error checking from the real compiler, and build/run/debug tasks —
on Linux, macOS and Windows, with nothing native bundled into the extension itself.

It does not ship a compiler or a debugger. It drives whatever `fasm2`/`fasm1` (and, for debugging,
`gdb` — or `lldb-mi` on macOS) you already have installed, the same way a C/C++ or Rust extension
drives your existing toolchain rather than bringing its own.

## Install this first

**Linux**
- `fasm2` (fasmg) and/or `fasm1`, on your `PATH`.
- `gdb`, if you want to debug — it's already installed on most distros; if not, `apt install gdb`,
  `dnf install gdb`, or `pacman -S gdb`.

**macOS**
- `fasm2` and/or `fasm1`, on your `PATH`.
- For debugging (experimental): Apple ships no gdb, and the `lldb` that comes with Xcode does
  *not* speak the GDB/MI protocol this extension's debug adapter uses. The MI-speaking frontend
  is [`lldb-mi`](https://github.com/lldb-tools/lldb-mi) — build it from source (Apple stopped
  bundling it with Xcode in 2019 and it isn't in Homebrew), then put it on `PATH` or point
  `fasm2Studio.gdbPath` at it.

**Windows**
- `fasm2` and/or `fasm1`, on your `PATH`.
- For debugging: a `gdb` build, most easily from MSYS2 (`pacman -S mingw-w64-x86_64-gdb`) or
  w64devkit. Windows has no built-in gdb, so this is the one genuinely extra step compared to
  Linux.

If a compiler isn't on `PATH`, set `fasm2Studio.fasm2CompilerPath` / `fasm2Studio.fasm1CompilerPath`
in your VS Code settings instead. The dialect (fasm2 vs. fasm1) is auto-detected per file from
syntax markers that only exist in one or the other; `fasm2Studio.defaultDialect` controls the
fallback when a file is ambiguous. If your project has a bare `include 'foo.inc'` that isn't found
next to the including file (common in fasmg's own bundled examples), set `fasm2Studio.includePath`
to the extra directories to search — the same directories you'd otherwise export via the
compiler's `INCLUDE` environment variable.

## What you get

Open a `.asm`/`.inc`/`.fasm`/`.fas` file and it's highlighted and editable immediately. Behind
that, a language server parses your project, walks `include` chains, and gives you completion and
hover for instructions/registers/directives, `format`/`segment`/`section` sub-keywords (`ELF64`,
`executable`, `DLL`, ...), operand-size/addressing qualifiers (`byte`, `dword`, `ptr`, `near`,
...), and your own labels/macros/constants; go-to-definition, find-references, rename, and
workspace symbol search that work across your whole workspace (not just the open file — files
are indexed once in the background and kept in sync as you edit, so this stays fast on real
projects); and signature help while you're filling in a macro call.

Errors and warnings come from actually running the compiler in the background as you type — not a
hand-rolled approximation of fasm's rules, the real thing, parsed from its actual output. This
works for unsaved buffers too.

`FASM: Build`, `FASM: Build and Run`, and `FASM: Run` compile and execute the active file. The
extension finds your compiler automatically; a status bar item shows which one it picked and lets
you override it.

`FASM: Debug` assembles the active file with an injected listing macro (your source file is never
modified) and launches it under gdb (or lldb-mi). Breakpoints, step, and continue all work; since fasm2
doesn't emit DWARF/CodeView debug info, source-line mapping comes from that listing rather than a
standard debug format, and there's no call-stack unwinding or typed variables — what you get
instead is a live register view and gdb-expression evaluation (`$eax`, `*(dword*)$esp`, and so
on), which is the right level of detail for raw assembly anyway. Currently fasm2/fasmg sources
only; fasm1 uses a different native listing format this extension doesn't parse. The gdb backend
is exercised end to end locally (Linux) against a real, live compiled binary; CI runs the
listing/MI-parser unit tests against pre-captured fixtures on every push, but doesn't install
fasm2 itself, so the live end-to-end session test skips there rather than verifying a real gdb
session on any platform. Debugging on Windows (gdb) and macOS (lldb-mi, which implements the same
MI protocol — its command coverage was checked against its source, but no real session has been
run) hasn't been verified end to end either way — if you hit something there, please open an
issue.

## Repository layout

npm workspaces, three packages:

- `server/` — the language server. Not a full assembler: a fast, single-pass tokenizer and symbol
  index built for editor tooling, plus a diagnostics engine that shells out to the real compiler.
- `debug/` — the debug adapter: parses the listing fasm2 produces into an address/source-line map,
  drives gdb (or lldb-mi) over its machine interface, and exposes it all as a standard DAP session.
- `extension/` — the VS Code extension itself: grammar, language configuration, snippets, the
  language client, the build/run/debug task and configuration providers, and compiler discovery.

All three build to a single bundled file with esbuild, so the packaged `.vsix` carries no
`node_modules` and behaves the same on every platform VS Code runs on.

## Building it yourself

```sh
npm install
npm run build            # bundles all three packages
npm run typecheck
npm run lint
npm run test:server      # unit tests plus a real-compiler integration test
npm run test:debug       # listing/MI parser unit tests plus a real gdb+fasm2 integration test
npm run test:extension   # launches a real VS Code instance and drives the live extension
npm run package          # produces extension/*.vsix
```

`test:extension` downloads a VS Code build the first time and needs a display; on headless Linux
run it as `xvfb-run -a npm run test:extension`.

To try a build locally: `npm run package`, then `code --install-extension extension/*.vsix`.

## Licensing

This extension is MIT-licensed — see `LICENSE`. flat assembler itself is a separate project with
its own license, held by its author, Tomasz Grysztar; the compiler and debugger are never shipped
or redistributed — the extension just invokes whatever copy you have installed. The one exception
is `debug/debug-support/listing.inc`, a small, unmodified fasmg macro file redistributed under its
own BSD-style license (see `LICENSE-fasm.txt`/`NOTICE.md` alongside it) and injected during `FASM:
Debug` builds to generate the address/source-line listing — see "What you get" above.
