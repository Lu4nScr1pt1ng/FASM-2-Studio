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
in your VS Code settings instead. Everything else — which dialect a project is, and where a fasmg
project's instruction set comes from — is covered next.

## Setting up a project

Two things decide how your project is handled: which assembler binary gets run, and where your
instruction set comes from. Both are plain VS Code settings, so keep them in the project's
`.vscode/settings.json` and they stay scoped to that project.

One fact makes the rest of this section easier to follow: `fasm2` is not a separate assembler. It
is the `fasmg` binary plus a wrapper script that preloads the standard x86 package — the executables
are byte-identical and print the same banner. Every apparent difference between "fasm2" and "fasmg"
is really a difference in what was preloaded.

### A fasm1 project

```json
{
  "fasm2Studio.defaultDialect": "fasm1"
}
```

Set this even though a dialect is detected automatically, because detection only recognizes
fasm2-only syntax (`end macro`, `calminstruction`, `iterate`, `namespace`). There is no fasm1
counterpart by design: the obvious candidates — `use32`, `rept`, `endp` — are all legitimate macro
names in fasmg's own packages, and matching them classified real fasmg files as fasm1. So a fasm1
project that uses none of the fasm2 markers falls back to `defaultDialect`, which ships as `fasm2`,
and every file is then checked against the wrong assembler. It is a loud failure — errors on code
that builds fine from the command line — but a confusing one, because nothing points at the cause.

`FASM: Select Dialect` in the command palette writes the same setting, and creates
`.vscode/settings.json` for you if the project has none yet.

If you skip this entirely, the first file that fails will offer to set it. That offer is only made
after the other assembler has compiled the same file cleanly, so it is a fact rather than a guess.

### A fasm2 project

Nothing to configure, as long as `fasm2` is on your `PATH`. That is what the defaults assume.

If it lives somewhere unusual, point at it and leave the rest alone:

```json
{
  "fasm2Studio.fasm2CompilerPath": "/path/to/fasm2"
}
```

### A fasmg project

fasmg has no instruction set of its own — x86, or anything else, arrives through an `include`. How
you configure it depends on where that include happens.

**When your source includes the instruction set itself**, point the compiler setting at the raw
`fasmg` binary and stop there:

```json
{
  "fasm2Studio.fasm2CompilerPath": "fasmg"
}
```

**When a wrapper script preloads it instead** — the same arrangement `fasm2` uses for x86, and the
usual way an instruction-set port ships — the source has no `include` to follow, so the editor
would see no instructions at all. Tell it what the wrapper passes:

```json
{
  "fasm2Studio.fasm2CompilerPath": "fasmg",
  "fasm2Studio.fasm2Preload": "myisa.inc",
  "fasm2Studio.includePath": "/path/to/includes;/path/to/more/includes"
}
```

`fasm2Preload` is handed to the compiler as `-i "include '...'"`, exactly as such a wrapper does,
and the language server follows the same file — so those instructions get hover, completion and
go-to-definition rather than being invisible. `includePath` is a `;`-separated list, and it is what
the compiler receives as its `INCLUDE` environment variable; mirror whatever your build script sets.

The settings are named for fasm2 because that is the common case, but nothing about them is
x86-specific: `fasm2Preload` will load a 68000 or Z80 instruction set just as readily.

The same mechanism turns a raw `fasmg` into a fasm2: set `fasm2Preload` to `fasm2.inc` and point
`includePath` at fasm2's `include` directory. Forget it and every line comes back `illegal
instruction`, since a bare fasmg knows no mnemonics at all — the extension recognizes that specific
failure and says so, rather than handing you hundreds of errors that never name the cause.

### What the editor does with this

The instruction set is worked out from your project's include graph, not assumed to be x86. Include
a non-x86 package and you get hover, completion and go-to-definition for *its* mnemonics and
registers, and you are not offered x86 ones. Nothing per-architecture is bundled with the extension;
it all comes from what you include.

Highlighting follows from the same information. A TextMate grammar sees one file at a time and has
to commit to a single instruction set for the whole language, so the language server layers semantic
tokens over it: a name like `bl` is coloured as an instruction where your package defines one, and
stays a register in x86 files, which no grammar can decide on its own. This needs a theme that opts
into semantic highlighting, as VS Code's built-in ones do. The extension ships no theme of its own
and never changes the one you use: its scopes and token types are the standard ones, so whatever
theme you already have colours FASM.

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
