# FASM2 Studio

A VS Code extension for [flat assembler g](https://flatassembler.net) (fasmg, distributed under
the name "fasm2"), with source compatibility for classic flat assembler 1. It gives you syntax
highlighting, autocomplete, hover docs, go-to-definition/references/rename across your whole
project, live error checking from the real compiler, and build/run/debug tasks — on Linux, macOS
and Windows, with nothing native bundled into the extension itself.

It does not ship a compiler or a debugger. It drives whatever `fasm2`/`fasm1` (and, for debugging,
`gdb`/`lldb`) you already have installed, the same way a C/C++ or Rust extension drives your
existing toolchain rather than bringing its own.

## Install this first

**Linux**
- `fasm2` (fasmg) and/or `fasm1`, on your `PATH`.
- `gdb`, if you want to debug — it's already installed on most distros; if not, `apt install gdb`,
  `dnf install gdb`, or `pacman -S gdb`.

**macOS**
- `fasm2` and/or `fasm1`, on your `PATH`.
- Xcode Command Line Tools, if you want to debug (`xcode-select --install`) — this is what
  provides `lldb`. Most machines that have ever built anything already have it.

**Windows**
- `fasm2` and/or `fasm1`, on your `PATH`.
- For debugging: a `gdb` build, most easily from MSYS2 (`pacman -S mingw-w64-x86_64-gdb`) or
  w64devkit. Windows has no built-in equivalent to gdb/lldb, so this is the one genuinely extra
  step compared to the other two platforms.

If a compiler isn't on `PATH`, set `fasm2Studio.fasm2CompilerPath` / `fasm2Studio.fasm1CompilerPath`
in your VS Code settings instead. The dialect (fasm2 vs. fasm1) is auto-detected per file from
syntax markers that only exist in one or the other; `fasm2Studio.defaultDialect` controls the
fallback when a file is ambiguous.

## What you get

Open a `.asm`/`.inc`/`.fasm`/`.fas` file and it's highlighted and editable immediately. Behind
that, a language server parses your project, walks `include` chains, and gives you completion and
hover for instructions/registers/directives, `format`/`segment`/`section` sub-keywords (`ELF64`,
`executable`, `DLL`, ...), operand-size/addressing qualifiers (`byte`, `dword`, `ptr`, `near`,
...), and your own labels/macros/constants; go-to-definition,
find-references, and rename that work across your whole workspace (not just the open file — files
are indexed once in the background and kept in sync as you edit, so this stays fast on real
projects); and signature help while you're filling in a macro call.

Errors and warnings come from actually running the compiler in the background as you type — not a
hand-rolled approximation of fasm's rules, the real thing, parsed from its actual output. This
works for unsaved buffers too.

`FASM: Build`, `FASM: Build and Run`, and `FASM: Run` compile and execute the active file. The
extension finds your compiler automatically; a status bar item shows which one it picked and lets
you override it.

`FASM: Debug` assembles the active file with an injected listing macro (your source file is never
modified) and launches it under gdb/lldb. Breakpoints, step, and continue all work; since fasm2
doesn't emit DWARF/CodeView debug info, source-line mapping comes from that listing rather than a
standard debug format, and there's no call-stack unwinding or typed variables — what you get
instead is a live register view and gdb-expression evaluation (`$eax`, `*(dword*)$esp`, and so
on), which is the right level of detail for raw assembly anyway. Currently fasm2/fasmg sources
only; fasm1 uses a different native listing format this extension doesn't parse. The gdb backend
(Linux, Windows) is exercised end to end in CI and locally against a real compiled binary; the
lldb path (macOS) shares the same MI-protocol driver but hasn't been verified on an actual Mac —
if you hit something there, please open an issue.

## Repository layout

npm workspaces, three packages:

- `server/` — the language server. Not a full assembler: a fast, single-pass tokenizer and symbol
  index built for editor tooling, plus a diagnostics engine that shells out to the real compiler.
- `debug/` — the debug adapter: parses the listing fasm2 produces into an address/source-line map,
  drives gdb (or lldb) over its machine interface, and exposes it all as a standard DAP session.
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
its own license, held by its author, Tomasz Grysztar; this extension doesn't redistribute it and
just invokes whatever copy you have installed.
