# FASM2 Studio

Editor tooling for [flat assembler g](https://flatassembler.net) (fasmg, distributed as "fasm2"),
with source compatibility for classic flat assembler 1. This extension drives whatever
`fasm2`/`fasm1` (and, for debugging, `gdb` — or `lldb-mi` on macOS) you already have installed — it doesn't bundle
a compiler or a debugger, the same way a C/C++ or Rust extension works with your existing
toolchain rather than shipping its own.

## What you get

Open a `.asm`, `.inc`, `.fasm`, `.fas`, or `.alm` file and it's syntax-highlighted immediately. Behind
that, a language server parses your project and gives you:

- **Highlighting that follows your include graph.** Your own labels, constants, structs and struct
  fields are coloured everywhere you *use* them, not only where you define them, and a name means
  whatever your project's instruction set says it means — `bl` is a register in x86 and an
  instruction where your package defines one. No theme is bundled and yours is never changed: every
  scope is standard, and the root README shows how to recolour any of it.
- **Completion and hover** for instructions, registers, directives, `format`/`segment`/`section`
  sub-keywords (`ELF64`, `executable`, `DLL`, ...), operand-size/addressing qualifiers (`byte`,
  `dword`, `ptr`, `near`, ...), and your own labels/macros/constants.
- **Go to definition, find references, rename, and workspace symbol search** that work across
  your whole project — not just the open file. Files are indexed once in the background and kept
  in sync as you edit, so this stays fast on real-sized projects.
- **What each instruction does to the flags**, on hover — which it writes, which it only tests,
  which it leaves alone. Written out rather than given as a set of letters, because the answer is
  usually qualified: `inc` leaves `CF` alone where `add …, 1` doesn't, `mul` leaves four flags
  *undefined* rather than untouched, a shift by zero writes none. An instruction that touches
  nothing says so, so "does `lea` affect the flags?" has an answer.
- **Signature help** while you're filling in a macro call.
- **Live diagnostics from the real compiler** — errors and warnings come from actually running
  fasm2/fasm1 in the background as you type, parsed from its real output, not a hand-rolled
  approximation of its rules. Works for unsaved buffers too.
- **Occurrence highlighting, folding that matches real block structure** (nested
  `macro`/`if`/`while` pairs, not line-local guesses), and **clickable `include` paths** — a path
  that doesn't underline is one your project can't actually resolve.
- **Quick fixes for a name that doesn't resolve** — either it exists elsewhere in the workspace and
  this file can't reach it (writes the `include`), or it's misspelled (offers the names that do
  exist, drawn from your project's own instruction set and symbols). A name that's only wrong in
  its capitalization is called out as exactly that, since fasmg is case-sensitive where fasm1 isn't.
- **Completion for the path inside `include '...'`**, resolved the way the assembler resolves it:
  next to your source first, then `fasm2Studio.includePath`. Pick a folder and it offers what's
  inside.
- **Drag a file in from the Explorer to get its `include` line.** The path is spelled the way the
  assembler resolves one — relative to the file you dropped it into, or against
  `fasm2Studio.includePath` when the file lives outside your project and a relative path would have
  to climb out of the tree. Forward slashes, so the line stays portable. Drag several files and you
  get one `include` per line; drop something no `include` would name and it's left to VS Code's
  normal handling.
- **Converting a numeric literal between bases**, as a refactor on the literal: hex, decimal, binary
  (grouped, `1111_1111b`), octal, and the character form for printable ASCII. The same reading hover
  has always shown, as an edit rather than something to retype.
- **Renaming or moving a file fixes the `include` paths that named it** — and, when the file lands
  in another directory, its own relative paths, which are now resolved from somewhere else. Whole
  folders too. fasm has no module system, so a path in a string literal is the only thing tying two
  files together, and a stale one looks perfectly fine until the assembler fails on it. Asks first
  by default (`fasm2Studio.updateIncludesOnFileMove`).
- **Expand selection** (`Shift+Alt+Right`) grows by operand, instruction, line, enclosing
  `macro`/`if`/`while`, then file — rather than jumping from one word straight to the whole file.
- **Call hierarchy** on a label: what reaches it, and what it reaches, as a tree. Tail calls written
  as `jmp` and jump-table entries count, because that's how the routine is actually reached.
- **Format Document** aligns labels, mnemonics, operands and trailing comments into columns, and
  indents block bodies. It never reorders or rewrites a token, never touches string contents, and
  leaves your line endings alone. Turning on VS Code's own `editor.formatOnType` also aligns each
  line the moment Enter finishes it — only ever the line you just left, never the one you are
  still typing.

`FASM: New File` writes a program that already builds, with the `format` line, the entry point and
the exit filled in — so there is something to press play on straight away. Six to pick from: hello
world for Linux (ELF64) and Windows (PE64), the 32-bit version of each for following along with
material written against `int 0x80` or the stack calling convention, a PE64 DLL with an export, and
a **boot sector** — 512 bytes ending in `55 AA`, `format binary`, no operating system underneath,
ready for `qemu-system-i386`. Whatever this machine can run is offered first. It sits in
**File > New File…** alongside the built-in entries, as well as in the command palette.

`FASM: Build`, `FASM: Build and Run`, and `FASM: Run` compile and execute the active file, and are
ordinary build tasks, so `Ctrl+Shift+B` runs them too. The extension finds your compiler
automatically; a status bar item shows which one it picked, and clicking it opens a menu for the
dialect, the compiler, live error checking, the language server's log and a server restart. If it
finds no assembler at all, `FASM: Select Compiler` leads with where to get one and a re-detect —
detection is cached for the session, so installing one mid-session otherwise looks like nothing
happened.
The program gets a terminal it is the process of, with no shell in between — so it starts whatever
your terminal profile is, its arguments reach it exactly as written, and when it ends the terminal
says so (its exit code, or the signal that killed it) and waits for a key instead of closing and
taking its output with it.
`FASM: Clean Build Output` removes what a build wrote. `FASM: Open Build Output in Hex Editor` opens
the binary itself — for a header you laid out by hand, or a boot sector that has to be exactly 512
bytes ending in `55 AA` — finding it the same way Build does, and offering to build it first if it
is not built yet.

`FASM: Build`, `FASM: Build and Run`, `FASM: Run` and `FASM: Debug` are also on the editor title
bar, the editor context menu, and the explorer's right-click menu for a `.asm` file — and, for a
file that is a program in its own right, as Run/Debug/Build lenses above its `format` directive
(`fasm2Studio.codeLens`). `Ctrl+Alt+R` builds and runs; `Ctrl+Alt+Shift+R` runs the last build
without assembling first. Selecting several files in the explorer and choosing Build or Clean acts
on all of them, resolving each program once even when several selected fragments belong to the same
one; Run and Debug start a single program, so they act on the file you clicked and say so when the
selection held more.

A **FASM Entry Points** section in the Explorer lists the files that are programs in their own
right, with Build and Debug on each row and Build / Clean / Open Build Output in the context menu —
so which of your files are programs and which are fragments is visible without opening them one at a
time. With no fasm file focused, `Ctrl+Shift+B` offers one Build task per entry point instead of
reporting that the workspace has no build task configured. If your project has fasm files but none
of them is a program, the section says so and offers to write you one, rather than disappearing and
leaving you to guess whether anything looked.

`FASM: Show Listing` (`Ctrl+Alt+L`) opens the assembler's own listing for the program the active
file belongs to. `FASM: Check All Entry Points` (`Ctrl+Alt+Shift+B`) assembles every program in the
workspace and fills the Problems panel with what the compiler says, including for files you have
never opened.

`FASM: Annotate Instructions Inline` turns on the address/size/encoding annotations described under
`fasm2Studio.inlayHints` below, offering each mode as what it actually renders next to a line rather
than as a description of it. It is also in the status bar menu, which is where the feature is
findable without knowing it exists. Choosing a mode a project cannot produce — an untrusted
workspace, live error checking off, or a fasm1 project — says which of the three is in the way,
instead of leaving a setting that reads as on and an editor that shows nothing.

Debug configurations are offered in the Run and Debug panel's dropdown without needing a
`launch.json` — both a launch and an attach entry.

`FASM: Debug` assembles the active file with an injected listing macro (your source is never
modified) and launches it under gdb (or lldb-mi). fasm2 doesn't emit standard debug info by
default, so source-line mapping comes from that listing instead — which also means there's no
call-stack unwinding or typed variables; register and memory inspection via gdb's own expression
evaluator (`$eax`, `*(unsigned int*)$esp`, ...) is the right level of detail for raw assembly anyway.
Currently fasm2/fasmg sources only. You get:

- Source breakpoints, plus **conditional** (`$ebx == 4`), **hit-count** and **log points**
- **Function breakpoints** on any label name, resolved through the listing
- **Watchpoints** — break when a data label is read or written, or when a register is written
- **Instruction breakpoints** in the disassembly view, with instruction-level stepping
- **Registers that read at a glance** — each row is the value and nothing else, since the row
  already has the register's name on it: `0x2a  42`, `0x0`, `-1` for a value whose sign bit is set,
  `'PATH'` for a packed character literal, `→ msg+0x8` for a value that lands in one of your labels.
  Expand a register for the full-width hex, the binary, the bytes in memory order, its `eax`/`ax`/
  `al`/`ah` slices (each settable on its own) and what it points at. Under **Flags**, alongside the
  decoded bits, **Conditions** says which conditional jumps would be taken right now — `je`, `jb`,
  `jl` and the rest, so the signed/unsigned pairs never have to be re-derived at a breakpoint
- Data labels with string/array previews
- **Hovering a memory operand reads the memory** — `dword [rsp+8]`, `[buffer+rcx*4]`, `byte [msg]`.
  The registers, labels and fasm literals inside it are all translated into something gdb can
  evaluate, and the width comes from the operand's own size specifier or from the register it is
  paired with. Typing one into the Watch panel works the same way
- **Raw memory** read/write, so "View Binary Data" opens a data label — or the address a register
  holds — in the hex editor
- **Set next statement**, to move the program counter to another line
- **Restart** in place, keeping every breakpoint and watchpoint
- Faults named properly: a SIGSEGV reads as `SIGSEGV (Segmentation fault)`, not "exception"
- **Checkboxes in the Breakpoints panel for which signals stop you** — SIGSEGV, SIGILL, SIGFPE,
  SIGBUS, SIGABRT, SIGPIPE. All on by default, which is what gdb does anyway; the point is being
  able to turn one off. A program that installs its own SIGSEGV handler can then run under the
  debugger without being interrupted at every fault it was written to handle itself. The signal is
  always passed to the program either way — unchecking one means "don't stop me for this", never
  "hide it from the program"
- `args` and `env` in `launch.json` for the debugged program
- **A terminal of its own**, so a program that reads stdin can be typed at — `"console"` picks
  between `integratedTerminal` (default), `externalTerminal` and `debugConsole`. The terminal is
  opened directly on a small agent process, with no shell in between, so it works the same whatever
  your shell and terminal profile are

### Attaching to something you didn't start

An `attach` configuration debugs a program this editor did not launch — either a running process or
the core dump of one that already died:

```json
{ "type": "fasm", "request": "attach", "name": "Attach", "asmFile": "${file}",
  "processId": "${command:fasm2Studio.pickProcess}" }
```

```json
{ "type": "fasm", "request": "attach", "name": "Core", "asmFile": "${file}",
  "coreFile": "${workspaceFolder}/core" }
```

`processId` defaults to a picker, since a pid is different on every run. Attaching to a live process
stops it where it stands, and everything above works from there; ending the session leaves it
running unless you explicitly ask for the program to be terminated.

A core dump is post-mortem. Registers, memory, data labels and the faulting source line are all
readable, the signal that killed it is named up front (`SIGSEGV (Segmentation fault)`), and anything
that would resume it is refused in those terms rather than with gdb's misleading "The program is not
being run".

Both need the `.lst` listing from the build that produced *that* binary — a rebuilt listing would
map addresses onto source lines they never belonged to — so attach never rebuilds one behind your
back. If it's missing, it says so and asks first.

On Linux, attaching to a process this editor did not start also requires
`/proc/sys/kernel/yama/ptrace_scope` to be `0`. gdb says so plainly if it isn't.

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
| `fasm2Studio.compilerArgs` | Extra command-line arguments for the assembler, used by everything that runs it: Build, Run, Debug and live error checking. Some projects need one to assemble at all — `["-p", "300"]` past fasmg's 100-pass limit, or `["-i", "define TARGET_LINUX 1"]` for a build-time definition, since fasmg has no `-d`. Each entry is one argument and is quoted as written. Passed after `fasm2Preload` and before the listing macro a debug build injects; fasmg takes the last occurrence of a repeated flag, so one set here overrides the same flag set by this extension. |
| `fasm2Studio.gdbPath` | Path to gdb, used by `FASM: Debug`. Leave empty to use `gdb` from PATH. |
| `fasm2Studio.diagnosticsEnabled` | Compile in the background to show errors/warnings as you edit. |
| `fasm2Studio.codeLens` | Shows Run / Debug / Build above the `format` directive of a file that is a program in its own right. Included fragments get none — they build through whichever program includes them, which is not something a lens on the fragment could name. On by default. |
| `fasm2Studio.inlayHints` | Annotates each line that produces machine code with its address, its encoded size, and/or the encoding itself (`off`/`address`/`size`/`addressAndSize`/`bytes`/`addressAndBytes`) — what you would otherwise build and read a `.lst` to see. An encoding past 16 bytes is shortened inline, with the full dump on the hint's tooltip. Rides on the background compile that live error checking already runs, so it needs `diagnosticsEnabled`, a trusted workspace and a fasm2/fasmg project. Off by default. |
| `fasm2Studio.updateIncludesOnFileMove` | Keeps `include` paths correct when you rename or move a file in the explorer — both the paths that named it and, for a file that moved to another directory, its own relative paths (`prompt`/`always`/`never`). Prompts by default, naming how many paths in how many files would change. |
| `fasm2Studio.diagnosticsDebounceMs` | How long to wait after you stop typing before re-running diagnostics. |
| `fasm2Studio.buildOutputPath` | Output path for Build/Run/Debug, relative to the source file's directory (e.g. `../bin/cc`) — keeps build output out of the source tree. Leave empty to build next to the source. |
| `fasm2Studio.runArgs` | Command-line arguments `FASM: Run` and `FASM: Build and Run` pass to your program. Each entry is one argument and is quoted as written, so a value containing a space stays one argument. The debug side has taken these all along as `"args"` in `launch.json`. |
| `fasm2Studio.format.mnemonicColumn` | Column Format Document aligns mnemonics to, measured from the current indent. `0` disables mnemonic alignment. |
| `fasm2Studio.format.operandColumn` | Column Format Document aligns operands to, measured from the current indent. `0` leaves one space after the mnemonic. |
| `fasm2Studio.format.commentColumn` | Absolute column Format Document aligns trailing `;` comments to. `0` leaves them one space after the code. |
| `fasm2Studio.trace.server` | Logs the traffic between VS Code and the language server into its output channel (`off`/`messages`/`verbose`). Turn it on when reporting a bug about hover, completion, navigation or live error checking. |

Every setting except the executable paths and `trace.server` is `resource`-scoped, and the paths
are `machine-overridable` — so in a multi-root workspace a fasm1 project and a fasm2 project can
each carry their own dialect, include path and preload in their own folder's
`.vscode/settings.json`.

## Workspace trust

On a folder you haven't trusted, everything that only reads code keeps working: highlighting,
hover, completion, go-to-definition, references, folding and formatting. What is withheld is
everything that starts a process — live error checking, Build, Run and Debug — since those run an
assembler (and gdb) against source the folder controls. While untrusted, VS Code also ignores
`fasm2CompilerPath`, `fasm1CompilerPath`, `gdbPath`, `fasm2Preload` and `includePath` from that
workspace's own settings, so a cloned repository cannot choose which binary would be executed.
Trusting the folder restores all of it without a reload.

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
