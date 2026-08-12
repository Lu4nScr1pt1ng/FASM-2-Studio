# Changelog

## 1.6.0

### Fixed

- The status bar no longer goes stale. It kept showing the previous compiler after `FASM: Select
  Compiler`, the previous dialect after `FASM: Select Dialect`, and the pre-edit dialect while you
  typed the very line that changes it — until you switched tabs.
- When live error checking cannot actually run (a compiler that will not start, or a compile that
  times out on a large project), the status bar now says so. Previously the Problems panel simply
  went empty, which looks exactly like success.
- `FASM: Run` on something you have not built yet offers to build it, instead of showing a shell
  error about a path you never typed.
- Build/Run/Debug from the explorer's right-click menu act on the file you clicked, not on whichever
  tab happened to be focused.

### Settings now work per folder

If you open a workspace containing both a fasm1 project and a fasm2 project, each folder can now
have its own dialect, include path and preload in its own `.vscode/settings.json`. Previously one
value applied to the whole window, so one of the two projects reported errors on code that
assembles perfectly. `FASM: Select Dialect` writes to the right folder.

### New in the editor

- **Format Document.** Aligns labels, mnemonics, operands and trailing comments into columns and
  indents block bodies, with the columns configurable. It never reorders or rewrites a token, never
  touches what is inside a string, and leaves your line endings alone.
- **A quick fix that adds the missing `include`** when you use a macro or constant that exists
  elsewhere in your workspace but is not reachable from the file you are in.
- **Occurrence highlighting** for the symbol under the cursor, scoped properly — a name declared
  `local` in a macro highlights only within that macro.
- **Folding that matches real block structure.** Nested `macro`/`if`/`while` pairs now fold to their
  own terminators, a block keyword inside a string or comment no longer opens a fold, and
  `;region`/`;endregion` works.
- **Clickable `include` paths.** A path that does not underline is one your project cannot actually
  resolve — which is the usual cause of a fasmg project that will not build.
- fasm's `file.asm [12]:` error headers are clickable in any terminal.
- Completion is lighter and better ordered: mnemonics rank first where an instruction goes,
  registers where an operand goes.

### New in the debugger

- Conditional breakpoints (`$ebx == 4`), hit-count breakpoints, and log points.
- Function breakpoints on any label name.
- Watchpoints — break when a data label is read or written.
- Breakpoints in the disassembly view.
- Raw memory read and write, so "View Binary Data" opens a data label in the hex editor.
- Set next statement, to move the program counter to another line.
- Restart, which keeps your breakpoints instead of starting a whole new session.
- Faults are named: a null dereference now reads `SIGSEGV (Segmentation fault)` instead of
  "exception".
- `args` and `env` in `launch.json`, for passing arguments and environment to your program.

### Elsewhere

- Build/Run/Debug are on the editor title bar, the editor context menu and the explorer.
- A Get Started walkthrough covering the assembler and gdb this extension drives but does not ship.
- 14 more snippets: ELF32/PE32 skeletons, Linux syscall stubs, `proc`/`endp`, `namespace`,
  `iterate`, `match`, `calminstruction`, and more.
- A `FASM: Restart Language Server` command.

## 1.5.0

- Your own labels, constants, structs and struct fields are now coloured everywhere you *use* them,
  not only where you define them. Operands used to be the flattest part of a FASM file — in a large
  real project, more than half the visible characters came out in the plain text colour. That is now
  under a quarter under the default dark theme, and about a seventh once the project's include
  directory is configured.
- A `.local` label is coloured only under the label it actually belongs to, and a `local` name only
  inside its own macro body — so a local named after an instruction stops being mistaken for one.
- Instructions no longer take the directive colour under VS Code's default dark themes.
- Labels, struct names, struct fields, `format` arguments (`PE`, `ELF64`, `GUI`), word operators
  (`defined`, `eq`, `lengthof`) and CALM commands all pick up colours they previously didn't get, or
  no longer share a colour with something unrelated. A jump to a local label (`jmp .exit`) is
  coloured at all for the first time.
- Semantic highlighting is now on by default for FASM files. Many themes never opt into it and were
  quietly ignoring everything the language server worked out about your project. Nothing about your
  theme changes — set `"[fasm]": { "editor.semanticHighlighting.enabled": false }` to turn it back
  off.
- Still no bundled theme, and yours is never touched. The root README now lists every FASM scope
  with what it represents, ready to paste into `editor.tokenColorCustomizations` if you want to
  recolour any of it — one entry covers both the definition and every use.

## 1.4.1

- Fixed the parameter-hint box appearing where you are not writing a call. On a line like
  `test rax, rax          ; zero, or not`, typing the padding or the comment popped it back open
  over operands you had already finished, highlighting a parameter you were nowhere near. It now
  stays shut past a `;` and in the whitespace after a finished argument, while still following you
  through a bracketed or quoted argument and past a dangling operator.

## 1.4.0

- Removed the two bundled color themes. Keep whatever theme you already use: the extension's
  highlighting is built on standard scopes and token types, so it colours correctly under any
  theme. If you had "FASM2 Studio Dark" or "Light" selected, pick your previous theme again with
  **Preferences: Color Theme**.

## 1.3.0

- Added **FASM: Select Dialect**, which records which assembler your project is written for in the
  project's own settings rather than leaving you to find the setting by hand.
- **FASM: Select Compiler** no longer reads as though it selects the dialect. It now asks about
  executables, shows what each dialect currently resolves to, and points at Select Dialect for the
  question it does not answer.
- Fixed the command palette showing every command twice over — "FASM: FASM: Build" and so on — and
  the same fault in the launch.json "Add Configuration..." dropdown.

- The extension now offers to fix a misconfigured dialect instead of leaving you to find the
  setting. Dialect auto-detection only recognizes fasm2-only syntax, so a fasm1 project whose
  sources carry none of those markers falls back to `fasm2Studio.defaultDialect` and reports errors
  across code that assembles perfectly -- of 120 KolibriOS files, 84 assemble under fasm1 and only 9
  under fasm2. When a file fails under the configured dialect and the other assembler compiles it
  cleanly, a prompt offers to set the dialect for that workspace. Nothing is guessed from syntax:
  the hint is raised only after one assembler has actually rejected the file and the other has
  actually accepted it, it costs one extra compile once per session, and it never fires for a file
  that simply has a real error.

## 1.2.1

- No change to how the extension behaves. This release exists so that the 1.2.0 notes actually
  reach this listing, which had been stale since 0.19.0 and so never showed thirteen releases'
  worth of changes.

## 1.2.0

- **Fixed diagnostics being completely broken for fasm1.** Every compiler run passed fasmg's `-e`
  flag, which fasm1 does not have (its whole option set is `-m`/`-p`/`-d`/`-s`) — so fasm1 printed
  its usage banner, assembled nothing, and the empty output parsed as zero problems. Compounding
  it, fasm1 writes `error:`/`warning:` in lowercase where fasmg writes `Error:`, and the message
  pattern only matched the capitalized form, so even a correctly invoked fasm1 reported nothing.
  Both are fixed; the integration tests now cover fasm1, fasm2 and raw fasmg rather than fasm2
  alone, which is how this went unnoticed.
- **Fixed x86 support switching itself off in macro-heavy x86 projects.** Instruction-set
  detection judged a file by what its include graph defines, which cannot tell a foreign
  instruction set from an ordinary helper-macro library: KolibriOS's `macros.inc` defines 73 macros
  of which only 5 spell x86 mnemonics, so files across a large, entirely x86 project lost `mov`
  hover and every x86 register in completion. Detection now also weighs what the file actually
  executes — an x86 mnemonic in instruction position that the graph never defines can only come
  from an instruction set loaded outside the source, which is exactly how fasm2 and fasm1 work.
  Measured against 749 hand-labelled real files, this classifies 743 correctly.
- **A failing build no longer looks clean.** When the assembler stops on an error inside an
  `include` it never reaches a line of the file you have open, and filtering errors down to that
  file left nothing at all to show — a red build with a green editor. The real cause is now
  reported, naming the failing file and line. Two parsing bugs fed the same silence: an error
  header with no trailing colon (which fasmg emits when it has no source line to quote, e.g.
  "Custom error: NO OUTPUT FILE.") was skipped entirely, and an include-chain header
  ("prog.asm [18] support/win64.inc [14]:") was attributed to the outer file instead of the
  innermost one where the error actually is. Found by checking the extension's verdict against the
  real assembler's on 279 entry points across 20 real projects; agreement went from 249/279 to
  279/279.
- **Hover, completion and signature help no longer assume x86.** fasmg has no built-in instruction
  set — every mnemonic comes from an `include`d package — so applying this extension's hardcoded
  x86 tables to, say, an aarch64 file was not merely unhelpful but wrong: `mov` was answered with
  x86's meaning instead of the macro actually in scope, and completion offered all ~1400 x86
  mnemonics plus `rax`/`eax`/`xmm0`, none of which exist on that CPU. The instruction set is now
  derived from the file's own include graph, so any ISA package works — fasmg's bundled aarch64,
  or a private in-house one — with no per-ISA data shipped. Ordinary x86 files are unaffected.
- Fixed the 23 mnemonics that fasmg's x86 and aarch64 packages spell identically (`mov`, `add`,
  `cmp`, `ret`, `nop`, `str`, `sub`, ...) always resolving to x86. Completion was worse: it
  silently *dropped* a package's own `mov`/`add`/`ret` for colliding with a built-in entry, so a
  non-x86 file could not complete its most common instructions at all.
- A definition in the file you are looking at now outranks the built-in x86 table, so your own
  `macro mov` wrapper hovers as your macro instead of as x86's instruction.
- `element` declarations are now indexed, and the `repeat N, i:0` + `element NAME#i` idiom that
  instruction-set packages use to generate register names in bulk is expanded — so an ISA
  package's registers (`x0`–`x30`, `w0`–`w30`, ... in aarch64's case) get hover, completion and
  go-to-definition even though those names appear nowhere literally in the source.
- Pointing the extension at a bare `fasmg` binary no longer produces a wall of up to 200
  "illegal instruction" errors that never name the cause. `fasm2` is only `fasmg` plus a wrapper
  that preloads the x86 package, and the two ship byte-identical executables printing identical
  banners, so they are now told apart by a functional probe. The single real cause is reported
  instead, and the new `fasm2Studio.fasm2Preload` setting supplies the preload for anyone who
  wants fasm2 behaviour from a raw `fasmg`. The preload is never applied automatically — fasmg's
  own aarch64 and webassembly examples are valid projects that must not have x86 forced into them.
- **ISA-aware syntax highlighting**, via LSP semantic tokens. A TextMate grammar matches one file
  at a time with no knowledge of what it includes, so it has to pick a single answer for the whole
  language — but `bl` is a register in x86 and a branch-with-link instruction in aarch64, and `mov`
  is a different instruction on every CPU that has one. The server already knows the include graph,
  so it now colours identifiers accordingly: `bl` reads as an instruction in an aarch64 file and as
  a register in an x86 one. The grammar stays the fallback for everything else, so nothing that
  highlighted before stops highlighting. Both bundled themes opt in (`semanticHighlighting`), as do
  VS Code's built-in themes.
- **Whole instruction families are indexed for the first time.** fasmg packages generate names in
  bulk by naming a macro after a loop variable — `iterate <instr,opcode>, jo,70h, jno,71h, ...` with
  a `calminstruction instr?` body is how 8086.inc defines all 30 conditional jumps, and
  `macro instr#ps?` is how sse.inc builds `addps`/`mulps`/`subps`/… — so none of those names appear
  literally in the source and none of them had a definition. Expanding this idiom (including
  headers wrapped across lines with a trailing `\`) took the x86 package from 267 recognized macros
  to 1,649, and closed the last ISA-detection gap: fasmg's webassembly package is now correctly
  recognized as non-x86 rather than falling back to x86.
- `fasm2Studio.fasm2Preload` is honoured by the language server, not just the compiler. Real fasmg
  projects don't write their instruction set into the source — a wrapper script preloads it, which
  is how `fasm2` supplies x86 and how ISA ports like fasm68k (`fasmg -i"Include 'm68k.inc'"`)
  supply theirs. Setting this alongside `fasm2Studio.includePath` now gives hover, completion and
  go-to-definition for the preloaded instruction set, which was previously invisible to the editor
  entirely. Validated against fasm68k and fasmg-ebc: `move`/`moveq`/`MOVREL` resolve, and the
  projects are correctly recognized as non-x86.

## 1.1.0

- Added 114 real x86 mnemonics/prefixes that hover, completion, and syntax highlighting had never
  heard of, found by exhaustively diffing every instruction table in fasmg's own
  `packages/x86/include/cpu/*.inc` against this extension's mnemonic list. Includes the `jna`/
  `jnae`/`jnb`/`jnbe`/`jng`/`jnge`/`jnl`/`jnle`/`jpe`/`jpo` conditional-jump synonyms, the
  `loop`/`loope`/`loopne` "z"/"nz" synonyms and explicit 16/32/64-bit counter-size variants,
  explicit operand-size variants of `push`/`pop`/`pushf`/`popf`/`ret`/`retn`/`retf`/`iret`,
  privileged/system instructions (`clts`, `invd`, `wbinvd`, `rdpmc`, `rsm`, `lgdt`, `lidt`, `sgdt`,
  `sidt`, `lldt`, `sldt`, `ltr`, `str`, `verr`, `verw`, `lmsw`, `smsw`, `lar`, `lsl`, `int1`,
  `swapgs`, `sysexit`/`sysexitq`, `sysret`/`sysretq`), prefix synonyms (`repnz`/`repz`, `lahf`/
  `sahf`, `lds`/`les`/`lfs`/`lgs`/`lss`), and several x87 FPU instructions (`fchs`, `fcos`,
  `fdecstp`, `fld1`/`fldl2e`/`fldlg2`/`fldz`, `fpatan`, `fprem`, `fscale`, `fsincos`, `fsqrt`,
  `ftst`, `fwait`, `fyl2x`, and more).

## 1.0.0

- Fixed `"repeat"`/`"end repeat"`/`"irp"`/`"irpv"` hover and completion being withheld under the
  fasm1 dialect — they're native fasm1 directives too, not fasm2-only.
- Fixed `"end irpv"` never dedenting or folding the editor.
- Fixed the syntax highlighter splitting a name into a false name-plus-number pair whenever it
  contained `"$"`/`"%"`/`"@"` followed by something that looked like a number (e.g. `"note$AB"`,
  `"flag@0x1F"`) — neither character ends a token in fasmg.
- Documented the `"priorequ"`/`"priormacro"`/`"priorstruc"` wildcard modifiers in `match`'s hover
  text.

## 0.29.0

- Fixed `"$FF"`-style hex literals (fasmg's `"$"` immediately followed by a hex digit) not being
  recognized as numbers by the language server, unlike the syntax highlighter which already handled
  them correctly — could pollute find-references/rename-symbol results with a bogus, never-defined
  entry for the literal itself.
- Fixed hover and syntax highlighting mislabeling `match` and `emit` as CALM-instruction-only
  commands, when both are primarily ordinary directives (a `match`/`end match` control block; the
  `emit`/`dbx` data directive) that only additionally have a distinct CALM-specific form. Syntax
  highlighting had the same issue for `element`, `postpone`, and `rawmatch`/`rmatch`.
- Documented the `postpone ?` variant (defers a block even later than a plain `postpone`, e.g. for
  computing a final checksum of the assembled output) in its hover text.
- Fixed signature help miscounting which argument the cursor is in when a macro call used fasmg's
  `<...>` syntax to group an argument containing a comma (e.g. `data example, <'abc',10>`).
- Fixed the editor not auto-indenting, auto-dedenting, or offering a fold arrow for `struc`,
  `match`, `rawmatch`/`rmatch`, and `postpone` blocks.
- Fixed the debugger (hover/Watch during a debug session) not resolving the address or size of a
  label defined via the `emit`/`dbx` data directive (e.g. `counter emit 2: 0,1000,2000`).

## 0.28.0

- Fixed bogus "symbol undefined"/"bits64 or higher required" errors appearing on a fragment file
  (no `format` directive of its own) when it was opened after its own entry point/includer had
  been closed — most commonly hit by single-clicking a source file (opening it in VS Code's reused
  "preview" tab) and then debug-stepping into a fragment it includes, which replaces that preview
  tab and closes it. Closing a document that happened to be open during the very first workspace
  scan used to erase its parsed state entirely, since that initial scan trusts an already-open
  document's live buffer instead of also keeping a disk-read fallback copy of it — so once closed,
  nothing else in the workspace was known to include the fragment anymore, and it got compiled
  standalone instead of through the real program. Closing a document now always falls back to
  re-indexing it from disk.

## 0.27.0

- Fixed diagnostics on a fragment file (no `format` directive of its own) opened moments after VS
  Code starts sometimes reporting bogus "symbol undefined"/"bits64 or higher required" errors that
  vanished again once the initial workspace scan caught up and re-diagnosed it — the scan hadn't
  reached the fragment's includer yet, so it was compiled standalone in the meantime.
- Fixed error messages from a failed build, "fasm" task, or entry-point resolution occasionally
  showing "undefined" instead of the actual failure, when the underlying error wasn't a real
  `Error` instance.
- Documented `.alm` as a supported extension in the README (already recognized by the extension,
  just not mentioned there).
- CI now retries the macOS/Windows extension integration test job on failure, working around a
  known `@vscode/test-electron` flaky-zip-extraction issue instead of failing the whole run on it.
- Internal cleanup: split `extension.ts` and `taskProvider.ts`'s shared "active FASM editor",
  "build output path", and "workspace config" helpers out into their own modules
  (`activeEditor.ts`, `buildPaths.ts`, `config.ts`), and centralized the `fasm2Studio.` config
  section name, message prefix, and compiler-path setting keys that were previously hand-copied
  as literal strings across several files. The fasm2/fasm1 dialect list and labels are now defined
  in one place too, instead of three separately hand-maintained copies that had already drifted
  (the compiler-picker's labels no longer matched the status bar's).

## 0.26.0

- Fixed a real syntax-highlighting bug: the built-in `$`/`$%`/`$%%` pseudo-variable rule had a
  guard against firing inside an ordinary name for `%`/`%%` (e.g. `BackupRead%`) but never applied
  the same guard to `$`/`$%`/`$%%` — so a name ending in one of those (e.g. fasm2's own
  `source/listing.inc`: `collected_$`, `collected_$%`, `collected_$%%`) had its tail wrongly
  recolored as the unrelated built-in of the same spelling.
- Fixed rename and find-references ignoring `local`-scoped macro variables' own scoping, unlike
  hover/go-to-definition which already respected it: renaming or finding references to a common
  `local` name (e.g. `value`, declared `local` in dozens of unrelated macros in real fasmg code)
  used to touch every macro's own private variable across the whole workspace instead of just the
  one actually in scope at the cursor.
- Completion now offers a struct field whose name happens to spell a real directive/register (e.g.
  `segment`), matching the carve-out hover already had — such a field used to never appear in
  completion at all.
- `FASM: Debug` no longer builds the program twice — the command used to build once itself and
  then have the debug configuration resolver build a second time.
- Fixed a debugger race where a second step (Next/Step In/Step Out) fired before the first had
  finished stepping could have its stop consumed by the wrong step, desyncing where the debugger
  reported landing.
- The debug console/target output now correctly decodes GDB's `\ooo` octal escapes for
  non-printable/high bytes, instead of corrupting everything after one.
- Build/debug tasks with a relative `file`/`output` path now resolve against the correct workspace
  folder in a multi-root workspace, instead of always guessing the first one.
- A malformed `tasks.json` "fasm" task or `launch.json` field now shows a clear error instead of a
  confusing downstream shell-execution failure.

## 0.25.0

- Hover and go-to-definition now resolve struct *instances*, not just the struct type itself:
  `assembly_workspace Workspace` (fasmg's struct package dynamically generates a command literally
  named after a struct once it's defined, so this is ordinary label-prefixed-instruction syntax)
  declares `assembly_workspace` as an instance, and `assembly_workspace.memory_start` — the actual
  way real code references a field — now resolves to the field's own definition, and the bare
  instance name resolves too. This shape is syntactically identical to an ordinary macro call with
  one bare-identifier argument, so it's only ever trusted after confirming the second word is a
  real, reachable struct — never guessed from a single file's own tokens alone.

## 0.24.0

- `sizeof.StructName` and `StructName.field` (the *actual* names fasmg's own struct package
  generates — every field's real, canonically-referenced name is fully qualified, and the total
  size is a real auto-generated companion constant) now resolve in hover and go-to-definition,
  instead of finding nothing at all. Nested/anonymous sub-structs are handled correctly too.
- `calminstruction NAME params` now highlights its declared name the same way `macro NAME`/
  `struct NAME` already did, while `calminstruction` itself stays tagged as a CALM command.
- Fixed a real syntax-highlighting bug found validating against fasmg's own standard
  `packages/x86/include/macro/import64.inc`: an `iterate <label,string>, ...`-bound loop variable
  literally named `label`, written back unexpanded in the macro body as e.g. `label dq ...`, used
  to be misread as the real `label NAME at EXPR` directive — stealing `dq` away from its own
  data-directive highlight.
- Added two bundled color themes, "FASM2 Studio Dark" and "FASM2 Studio Light", with a palette
  designed specifically for FASM's own token categories (mnemonics, registers, directives, CALM
  commands, structs, labels, ...), each checked against WCAG contrast ratios. The underlying
  grammar scope names were also spot-checked against several popular built-in VS Code themes
  (Dark/Light Modern, Dark/Light+, Monokai, Solarized Light, ...) for reasonable out-of-the-box
  compatibility even without switching to the bundled themes.

## 0.23.0

- Fixed a regression from 0.22.0's macro-hover fix: hovering an instruction mnemonic (e.g. `js`)
  while debugging now shows the language server's own hover documentation again, instead of this
  debug adapter's "has no runtime value here" message stepping on it. A *failed* debug hover is
  silently dropped by VS Code, letting the language hover stand on its own — but 0.22.0's fix
  returned a *successful* response for any unresolved bare word, mnemonics included, and a
  successful one actually gets shown. Now scoped to only macro invocations and other genuinely
  undocumented words, not anything the language server already has real docs for.

## 0.22.0

- Hovering/watching a macro invocation's own name (e.g. `write_msg` in `write_msg write_stderr,
  usage_text, usage_text_len`) now gets a clear "has no runtime value here" message instead of
  gdb's raw `No symbol table is loaded. Use the "file" command.` — a macro vanishes entirely at
  compile time, so gdb never had anything to resolve there in the first place. Applies to any bare
  identifier (macro name, instruction mnemonic, or any other stray word) that isn't a register,
  label, or constant, not just this one macro.
- Fixed a real bug where stepping the exact instruction that ends a program (its own exit
  syscall) could produce a spurious `step failed: The program is not being run.` right after the
  program had already terminated cleanly. The stepping loop was treating *any* stop the same way,
  including the inferior exiting, so it tried to keep single-stepping a process that no longer
  existed.

## 0.21.0

- Step Over and Step Into now actually differ: Step Over runs straight through a `call` (landing
  right after it returns) instead of diving into it, so stepping over a macro invocation whose
  body ends in a real call — a `write_msg`-style helper macro, for instance — advances past the
  whole macro in one step instead of jumping into the callee. This is a plain ISA-level
  distinction gdb already knows how to make without any symbol table, so it applies uniformly to
  every macro, not just a specific one.
- Added VS Code's Disassembly View support (instruction-granularity stepping and a `disassemble`
  request), so a macro's expansion can actually be watched happening one raw instruction at a
  time instead of a whole statement silently stepping past it. Disassembly is shown in Intel
  syntax (matching FASM's own convention, not gdb's AT&T default) and is byte-accurate even when
  asked for instructions *before* the current one, reconstructed from the nearest known-good
  instruction boundary rather than guessed at from an arbitrary byte offset.

## 0.20.0

- The Debug Console now works as a real gdb/lldb-mi console: any input that isn't a register,
  source label, or symbolic constant (e.g. `info registers`, `x/10i $pc`, `disassemble`, `bt`, or
  even `continue`/`next` typed directly) is run as a raw CLI command instead of being rejected as a
  failed value expression. A `ContinuedEvent` is emitted when such a command actually resumes the
  target, so the Variables/Call Stack views don't stay stuck showing stale, stopped-at-the-old-line
  data until the next stop.
- An empty Debug Console line or blank Watch entry now resolves to a clean empty result instead of
  surfacing gdb's own raw `Argument required (expression to compute)` error.

## 0.19.0

- `fasm2Studio.gdbPath` now defaults to `lldb-mi` on macOS instead of `gdb`, which Apple doesn't
  ship at all. Real debugging on macOS is still experimental and unverified end to end (Apple's
  own `lldb` doesn't speak the GDB/MI protocol this extension's debug adapter uses — the
  MI-speaking frontend is the separate, self-built [`lldb-mi`](https://github.com/lldb-tools/lldb-mi)
  project), but the driver now launches it with its own correct argument form: lldb-mi's option
  parser is not gdb's, and passing it gdb's `--nx`/`-q`/`--args` flags could get `--args` itself
  misparsed as the program path, since lldb-mi scans the command line for anything filename-shaped.
- Corrected README/manifest text that implied Xcode's bundled `lldb` already works as the debug
  backend on macOS — it doesn't; documented the actual `lldb-mi` requirement instead.

## 0.18.0

- Large performance pass over the language server's hot paths, each change verified with
  before/after benchmarks on a 300-file synthetic workspace:
  - Hover, completion, go-to-definition and signature help no longer re-scan every known document
    (with a filesystem existence check per `include`) at every step of the entry-point walk —
    include resolution is memoized (invalidated on watcher/setting changes) and backed by a
    reverse-include index rebuilt lazily after edits. With 10-deep include chains: ~12 ms →
    ~0.05 ms per request, and the full edit+hover cycle ~12 ms → ~0.6 ms.
  - The tokenizer classifies characters with integer comparisons instead of per-character regex
    tests — it re-runs over the whole document on every keystroke: ~3.1 ms → ~1.3 ms on a
    5000-line file.
  - Hover/signature-help lookups against the static data (instructions, registers, directives,
    format keywords, size specifiers) are Map lookups now, not linear scans over the ~1300-entry
    instruction list on every request.
  - The live-buffer shadow tree that diagnostics compile from is built with concurrent symlink
    creation instead of one-at-a-time awaits: ~26 ms → ~14 ms per diagnostics pass on a large
    directory tree.
- Fixed a real parser bug: `end struc` never popped the struc's macro frame, so after any
  `struc ... end struc` the parser kept attributing later definitions to the dead frame — a
  `local` name declared inside the struc could wrongly scope-capture an unrelated same-named
  constant defined after it, and the struc's own locals never got their scope recorded at all.
  Found while unifying the three near-identical `macro`/`calminstruction`/`struc` parsing blocks
  into one (which is also what fixed it, since all three now share the same frame handling).

## 0.17.0

- Symbolic constants (e.g. `FD_STDERR = 2`, `FD_STDOUT equ 1`, `define`/`redefine`, `:=`/`=:`) now
  resolve to their value when hovered or watched during a debug session, entirely from the
  listing — these have no runtime address at all (fasmg substitutes them at compile time), so
  asking gdb about one used to fail with a raw, confusing `No symbol table is loaded. Use the
  "file" command.` error instead of showing anything useful.
- Fixed a real bug in editing a register's value from the Registers panel: VS Code pre-fills the
  edit box with the *entire* current display string (`"eax = 0x0000002a  42  0b0000...0010"`), not
  a bare number, so editing only the decimal or binary column and submitting the whole string back
  used to silently do nothing — only editing the hex column ever actually took effect. Now detects
  which of the three columns was actually changed and uses that.

## 0.16.0

- The Registers view is now organized into expandable groups (General Purpose / Pointers / Flags /
  Segment) instead of one flat list, and Flags decodes into every individual named bit (CF, ZF, IF,
  IOPL, ...) with its own description, not just the raw eflags number.
- Added a "Data Labels" scope alongside Registers, listing every resolvable source-level data label
  (e.g. `argc dd ?`) with its live value — previously the only way to see one was to hover it or
  type it into Watch by name.
- Data labels now understand arrays (`table dd 1,2,3,4` shows every element, expandable by index)
  and strings (`msg db 'Hello',0` reads back as `"Hello"`, not just its first byte) — both are real
  memory reads via gdb's own `-data-read-memory-bytes`, not guesses from the static declaration.
- Added live inline value decorations in the editor during a debug session (e.g. `argc` reading
  `= 1` right next to `mov [argc], ecx`), via VS Code's inline-values API — filtered against the
  same mnemonic/directive/size-keyword data hover already uses, so it only ever asks gdb about
  things that could plausibly be a register or a label, not every word on the line.
- Fixed a real regression introduced while building the above: the debug adapter's 'launch'
  response was briefly delayed by an extra gdb round-trip (added to detect the target's real
  register set), which could race against the client's own session bookkeeping and silently drop
  the very first `stopped` event on a fast target — found via a real VS Code integration test, not
  just the adapter's own DAP-level tests, which never depend on that particular timing.

## 0.15.0

- Fixed a real dialect-detection bug: `end repeat`, `irp`, and `irpv` were treated as unambiguous
  fasm2 markers, but flat assembler 1 has its own native `repeat ... end repeat` and `irp`/`irpv`
  directives too (confirmed against fasm1's own manual) — so an ordinary fasm1 file using any of
  them was silently misclassified as fasm2, serving the wrong hover/directive content. Only
  `end macro`, `calminstruction`, `iterate`, and `namespace` remain as markers.
- Added several core directives that had no hover documentation at all, found on a line-by-line
  pass through manual.txt: `dup` (the `db`/`dw`/... value-repeat keyword), `reequ` (the
  overwriting counterpart to `equ`, mirroring how `redefine` relates to `define`),
  `retaincomments`/`removecomments` and `isolatelines`/`combinelines` (comment/line-splicing
  control), `else if`, and `end match`.
- Corrected and completed several existing directive summaries that were subtly wrong or missing
  a documented form: `equ`/`define` didn't explain the one thing that actually distinguishes them
  (whether symbolic variables in the assigned text get evaluated); `restore` only mentioned
  undoing `=:`, not `equ`/`define`; `label`'s syntax implied `at expr` was mandatory when it's
  optional; `virtual` was missing its third form (reopening an existing area by label); `file` was
  missing its `:offset,length` partial-copy form; `load`/`store` were missing their third
  "raw output-file offset" form (`from :`/`at :`); `match` didn't mention its fasm1 form, the
  `else match` chaining, or its CALM-only third argument; `outscope` overstated what it redirects
  (only parameter-definition context, not general command execution); `local` didn't document its
  distinct CALM-instruction-definition-time meaning; `emit` conflated its base-directive `dbx`
  synonym with the unrelated, synonym-less CALM command; `publish` was missing its `:` stack/
  constant modifiers; `transform` was missing its optional namespace argument; `call` overstated
  itself as "the only way" to invoke another CALM instruction.
- Extension grammar: added the four new comment/line-splicing directives above to the core
  keyword list.

## 0.14.0

- Fixed a real, potentially file-wide corruption bug: a number using a single quote as a digit
  separator (manual.txt's own documented `1'000'000`, since `'` is otherwise the string-quote
  character) split into `1` + a fake string `'000'` + `000` — and a number with an *odd* count of
  embedded quotes would open an unterminated string that corrupts syntax highlighting for the rest
  of the file, since TextMate's string state persists across lines. Fixed in both the tokenizer
  (server-side symbol indexing) and the grammar. Also added the two documented `f`-suffixed float
  forms that don't require a `.` (`5e10`, and `5f` — the *only* way to mark a dot-less,
  exponent-less literal as floating-point), and an explicit `d` suffix on plain decimals (`123d`,
  analogous to `h`/`b`/`o`/`q` on the other bases), none of which matched any pattern before.
- Added the `relativeto` logical operator and `rawmatch`/`rmatch` (a synonym), `esc`,
  `elementsof`, `float`, and `trunc` — all real, documented core directives/operators found on a
  full line-by-line pass through manual.txt that had no hover documentation or grammar highlight
  at all.
- Fixed `completion.ts` never suggesting any of the logical/value operators documented in
  `hover.ts` (`defined`, `definite`, `used`, `eq`, `eqtype`, `relativeto`, `scale`, `metadata`,
  `elementof`, `scaleof`, `metadataof`, `elementsof`, `string`, `lengthof`, `bappend`, `float`,
  `trunc`) — every other keyword family (directives, mnemonics, ...) already flowed into
  autocomplete; this one silently didn't.
- Added `struc NAME params ... end struc` (the core "labeled macroinstruction" directive that
  `struct` is itself built on top of, per manual.txt section 9) as a real indexed symbol — hover/
  go-to-definition/workspace-symbol-search previously found nothing for a raw `struc`, unlike its
  `struct` wrapper.
- Fixed signature help never recognizing a labeled-instruction call (`LABEL struc-name args`, e.g.
  `wc WNDCLASS`) — it only ever looked at the first word of the line as the callee name. Now falls
  back to the second word (treating the first as a label) when the first doesn't resolve to
  anything, without changing behavior for an ordinary macro/instruction call.
- Documented the per-parameter `?` case-insensitivity modifier (e.g. `macro foo x?,y`) in macro/
  struct hover — a different `?` from the one marking the macro's own name weak/overridable, and
  previously not mentioned at all.
- Stress-tested the syntax grammar and symbol indexer against the full real fasmg example/package
  corpus (307 files, ~100k lines) with zero crashes, confirming the fixes above hold up beyond
  synthetic test cases.

## 0.13.0

- Fixed live diagnostics (the buffer-aware compile used while editing) failing on any `include`
  that climbs above its own file's directory with `..` — confirmed against fasm2's own IDE source
  (`source/windows/dll/fasmg.asm`'s `include '../../version.inc'`, `source/ide/windows/fasmgw.asm`'s
  backslash `include '..\..\version.inc'`), which used to report those files as "not found" only
  under live diagnostics, not a plain compile. The shadow compile root now mirrors a bounded chain
  of ancestor directories, not just the entry file's own directory.
- Added `proc NAME params` (the standard `proc32.inc`/`proc64.inc` package used by virtually every
  real fasmg Windows program, e.g. fasm2's own `fasmgw.asm`: `proc MainWindow hwnd,wmsg,wparam,
  lparam`) as a real symbol definition — its own macro body turns NAME into a genuine label
  (`if used name / name:`), but hover/go-to-definition/workspace-symbol-search previously found
  nothing for it at all, arguably the single most common way to define a function.
- Fixed the tokenizer splitting a name containing "%" (e.g. `packages/x86/include/pcount/
  kernel32.inc`'s own `BackupRead% =  7`) into a shorter identifier plus a stray "%" token — fasmg
  does not treat "%" as a special character at all (only a bare "%"/"%%" is the repetition-count
  pseudo-variable), so the line was never recognized as a constant definition.
- Synced the syntax-highlight grammar with the above and closed several more real gaps found the
  same way: `format`-keywords (`PE`, `GUI`, `console`, `at`, `on`, ...) now only apply inside an
  actual `format ...` line instead of anywhere the same word appears (win32wx.inc's own
  `if ~ definite PE & ~ definite x86.mode` no longer lights up `PE` as the directive); the core
  `defined`/`definite`/`used`/`eq`/`eqtype` operators are now recognized (grammar + hover) instead
  of being completely unstyled/undocumented; `define`/`redefine NAME` now tags NAME as a constant,
  including a dotted weak name as one token (`win32wx.inc`'s own `define _winx.code? _code`); `#`
  (token-pasting) is now styled instead of falling through as plain punctuation; a `%` glued to an
  ordinary name no longer lights up as the repetition-count pseudo-variable; the mnemonic list is
  now generated from the full 1271-entry instruction set hover/completion already use instead of a
  159-entry hand-picked subset (`lodsb`/`cmpsb`/`scasb` and the entire SSE/AVX/legacy-FPU families
  had no color at all); and `library`/`import`/`export`/`directory`/`resource`/`dialog`/`enddialog`/
  `dialogitem` (the standard import/export/resource packages) get the same treatment already added
  for `proc`/`invoke`.

## 0.12.0

- Added `load NAME[:size] from ADDRESS` as a real symbol-defining construct (`proc64.inc`'s own
  `initlocal` uses it: `load value:byte from area:pointer`) — previously unrecognized entirely, so
  hovering `value` fell through every local lookup and landed on an unrelated symbol in a
  different file. Also recognized `::` ("area label", `proc64.inc`'s `area::`) as its own label
  form distinct from a plain `:` label, with its own local scoping; and fixed hovering a bare `?`
  (fasmg's most overloaded token — usually the `dd ?` reserve placeholder, but occasionally the
  name of an anonymous `macro ? args`) surfacing an unrelated anonymous macro instead of
  explaining both meanings directly.
- Recognized `calminstruction NAME params` as a real symbol definition, the same as `macro` — every
  real x86 instruction fasmg itself implements (`fld?`, `xcall`, and thousands more across the real
  fasmg tree) is a `calminstruction`, not a `macro`, so none of them had a `SymbolDefinition` before
  this and hover/go-to-definition found nothing unless the name was already hardcoded in this
  extension's own `instructions.json`. Also fixed `end?.frame?`-style dot-separated weak names only
  having their first `?` stripped, and detection of a CALM command extending itself via the
  `calminstruction.` namespace (`8086.inc`'s `calminstruction calminstruction?.xcall?`, called
  elsewhere as bare `xcall`).
- Fixed a struct field whose name spells an unrelated directive/register (e.g.
  `packages/x86/projects/challenger/challenger.asm`'s own `PLANE_POINTER.segment`/`.offset` fields)
  always resolving hover to that directive instead of the field itself, both at the field's own
  declaration and at every `IDENT.field` reference elsewhere in the file (including inside a
  `[...]` memory operand).
- Synced the syntax-highlight grammar with all of the above, plus two more: an `IDENT.field`
  struct-field reference now gets its own member styling instead of occasionally lighting up as
  the directive/keyword it happens to spell (same `PLANE_POINTER.segment` case); and the
  `proc`/`endp`/`locals`/`endl`/`uses`/`frame`/`endf`/`invoke`/`cinvoke`/`stdcall`/`ccall`/`fastcall`
  family from the standard `proc32.inc`/`proc64.inc` package — used in virtually every real fasmg
  Windows/Linux program — now gets its own distinct styling instead of none at all.

## 0.11.0

- Mapped the remaining constant-definition operators: `:=` (defined exactly once,
  forward-reference-safe), `=:` (preserves the previous value, restorable with `restore`),
  `reequ` (like `equ` but discards the previous value), and `define`/`redefine NAME EXPR`. Found
  by analyzing fasmg's own `packages/x86/include/macro/proc64.inc`, which uses all seven
  constant-defining forms side by side. Also fixed the `?` weak/overridable-name suffix only
  being stripped from macro/struct names and not from constants defined this way, and a macro's
  `!` (unconditional) suffix being mistaken for a parameter (`macro endp?!` showed a bogus `!`
  parameter).
- Fixed the block-nesting tracker desyncing for the rest of a file after a macro that
  deliberately leaves a block open across invocations (`proc64.inc`'s own `initlocal` opens a
  `virtual at` block only closed later by a separate macro) — a real, confirmed pattern this
  parser can't fully follow, now recovered from instead of corrupting every macro-local scope
  after it.
- Added hover documentation for fasmg's built-in pseudo-variables (`$`, `$$`, `$@`, `%`, `%%`)
  and its logical-expression operators (`~`, `&`, `|` — distinct from the word-form `not`/`and`/`or`
  used in ordinary arithmetic, and from `&` on a macro's last parameter, which means something
  else entirely). Verified the "logical-only, not arithmetic" distinction against the real
  compiler.
- Macro/struct hover now explains the parameter modifiers actually present (`*` required,
  `:` default value, `&` captures the rest of the line) and the name's own `?`/`!` suffixes,
  instead of showing the raw signature with no explanation.
- Fixed a macro defined *inside* another macro's body (e.g. `com64.inc`'s `cominvk`/`comcall`,
  each defining their own private `call` macro meant to shadow the real CALL instruction only for
  their own body) having no position-aware scoping at all — hovering `call` anywhere, even
  directly on one of these nested definitions, always fell through to the real x86 instruction.
- Synced the syntax-highlight grammar with all of the above: `:=`/`=:`/`reequ` now get the same
  treatment as `=`/`equ`; `$`/`$$`/`$@`/`%`/`%%` get their own scope instead of no styling (or,
  for `%`, generic operator styling); fasmg's `$1A`-style dollar-prefixed hex literal is now
  recognized as a number.

## 0.10.0

- Fixed `local` variables inside macros being tracked as one shared global constant instead of a
  fresh, private variable per macro — found via fasmg's own `core/examples/8051/8051.inc`, where
  40 different macros each declare their own `local value`. Hover and go-to-definition on such a
  name now resolve to the one macro actually in scope at the query position, instead of always
  the first same-named local anywhere in the file.
- Fixed hover always preferring an instruction mnemonic's description over an in-scope `local`
  variable of the same name (e.g. `local neg` in fasmg's own `packages/x86/include/macro/if.inc`
  permanently shadowed by the NEG instruction's hover).
- Fixed the `import` macro pattern not being recognized for its Mach-O/ELF shape
  (`import printf,'_printf'`, no library-nickname operand) — only the PE/Windows shape
  (`import kernel32,\ Name,'Name', ...`) was handled before.
- Fixed the extension's own copy of the fasm1/fasm2 dialect-detection heuristic, which still had
  the bug already fixed server-side in 0.8.0 (`endp`/`use16`/`use32`/`use64`/`rept` wrongly treated
  as fasm1-only markers) — this copy is what `FASM: Build`/`Run`/`Debug` uses to pick a compiler,
  so real fasmg files using those could still get built with the wrong compiler/dialect.
- Fixed struct field names being syntax-highlighted as the unrelated directive/keyword they
  happen to spell (e.g. a field literally named `segment` or `offset`, as in fasmg's own
  `packages/x86/projects/challenger/challenger.asm`).
- Refined syntax-highlight scope naming for better compatibility with color themes: CALM
  sub-language commands (`match`/`check`/`emit`/`jyes`/`exit`/...) now get their own scope instead
  of being lumped in with ordinary directives; data-declaring directives (`db`/`dw`/`dd`/...) now
  share the same `storage.type` family as size specifiers; instruction mnemonics moved to the
  properly-conventioned `keyword.other.mnemonic` scope.

## 0.9.0

- Fixed hover and go-to-definition for imported OS/kernel functions (e.g. Windows API calls via
  `kernel32.inc`/`user32.inc`), found by validating against fasmg's own real Windows examples.
  Three compounding gaps: the `import kernel32,\ Name,'Name', ...` macro pattern every one of
  fasmg's own API packages uses wasn't recognized as a symbol definition at all; `include
  'api\kernel32.inc'`-style Windows path separators never resolved on Linux/macOS, since Node's
  own path module treats a backslash as a literal filename character there, not a separator (the
  real compiler was unaffected, since it normalizes this itself); and static analysis had no
  equivalent of the `fasm2Studio.includePath` fallback just added for the compiler invocation.
  Together these meant hovering an imported API function showed nothing, or worse, the *wrong*
  definition — pulled from some unrelated project that happens to declare a same-named symbol the
  old-fashioned way. Verified end-to-end against several real examples: hover and go-to-definition
  on `ExitProcess`/`DialogBoxParam`/`SwapBuffers`/`GetClientRect` now each resolve to exactly one,
  correct location.

## 0.8.0

- Added `fasm2Studio.includePath`, forwarded as the compiler's `INCLUDE` environment variable.
  Fixed a real, significant gap found by validating against fasmg's own example projects: a bare
  `include 'foo.inc'` that isn't found next to the including file relies on `INCLUDE` as a search
  path — fasmg's own bundled `make.bat` scripts set this up themselves (e.g.
  `packages/x86/examples/windows/make.bat` does `set include=..\..\include` before building).
  Without an equivalent setting, any project structured this way — including anything importing
  Windows API declarations via `kernel32.inc`/`user32.inc`-style packages — failed to build or
  diagnose at all, with a misleading "source file not found" error despite being entirely correct
  code. Verified end-to-end: 44 false diagnostics on a real Windows example without the fix, 0
  with it.
- Fixed dialect detection wrongly classifying real fasmg files as classic fasm1: `endp`,
  `use16`/`use32`/`use64`, and `rept` were treated as fasm1-only markers, but all three are
  legitimate macro names defined by fasmg's own official x86 packages. This misclassified 18 of
  354 real fasmg files, hiding fasm2-only hover content and directive completions for them.
- Validated macro/symbol detection against fasmg's entire real example tree (354 files): zero
  crashes, 2,678 macros and 29,354 symbols correctly recognized.

## 0.7.0

- Massively expanded instruction coverage for hover/completion: from 197 to 1,273 entries,
  now spanning the entire x86 instruction set fasmg can assemble — AVX, AVX2, BMI1/BMI2, FMA,
  AES, ADX, F16C, RDRAND/RDSEED/RDTSCP, XSAVE, FSGSBASE, CET-SS, GFNI, VAES/VPCLMULQDQ,
  MOVDIRI/MOVDIR64B, PTWRITE, INVPCID, MPX, HLE, RTM, SMX, VMX, the full AVX-512 family
  (F/BW/DQ/CD/VL/ER/PF/VNNI/VBMI/VBMI2/IFMA/BITALG/VPOPCNTDQ/4VNNIW), and the legacy AMD
  3DNow! set. Also fixed a few real gaps found along the way: a missing `sqrtsd`, a missing
  `endbr32`/`vptest`, and a duplicate-mnemonic mixup where `vcmpsd`'s hover showed the
  unrelated string-compare instruction's description instead of its own.
- Fixed: `FASM: Build`/`Run`/`Debug` and the entry-point listing didn't recognize a file as its
  own entry point unless it had a `format` directive — but fasmg doesn't require one at all for
  flat-binary output (`org 100h` alone is a complete, directly-assemblable program, as in
  fasmg's own `hello.asm`/`life.asm`/`mandel.asm` examples). A top-level `org`/`section` now
  counts too, but only when nothing else `include`s that file, so a fragment that merely uses
  `org` internally as an implementation detail (e.g. a hand-written executable-format
  definition library meant only for inclusion) isn't mistaken for a standalone program.
- Validated multi-project workspace isolation against fasmg's own real compiler source tree
  (354 files, 9 platform-specific entry points sharing common fragments): confirmed shared
  fragments correctly resolve to every project that reaches them, with no cross-contamination
  from unrelated projects elsewhere in the same workspace.

## 0.6.0

- `FASM: Build`/`Run`/`Debug` now resolve the real entry point instead of always compiling
  whatever file happens to be active. Editing a shared fragment (no `format` directive of its
  own) auto-resolves to the one project that includes it; if it's genuinely reachable from more
  than one unrelated project, or from none at all, you're prompted to pick which entry point you
  meant instead of the wrong (or no) project silently getting built.
- Added `.alm` to the recognized file extensions (a real fasmg source extension, e.g.
  `packages/x86-2/iev.alm`, previously not treated as fasm at all).
- Fixed a crash: fasmg's anonymous-macro idiom (`macro ? args`, used throughout fasmg's own
  packages) made "Outline"/document symbols fail outright with "name must not be falsy".
- Added missing instructions found against the real fasmg source tree: `vaddpd` and the rest of
  its AVX arithmetic family, `loadall`, the full `lodsb`/`lodsw`/`lodsd`/`lodsq` and
  `cmps`/`scas` byte-width families, and the full `setcc`/`cmovcc` condition-code sets (previously
  incomplete compared to the already-complete `jcc` set).
- Documented several core CALM commands that had zero coverage despite being extremely common in
  real fasmg code (`jyes` alone appears thousands of times in fasmg's own source) — `jump`,
  `jyes`, `jno`, `exit`, `publish`, `transform`, `stringify`, `take`, `taketext`, `call`,
  `initsym`, plus `purge`/`restruc`/`mvmacro`/`mvstruc` and `load`/`store`.

## 0.5.0

- Fixed: hover, completion, and signature help only ever looked at symbols reachable via the
  current file's own `include` chain. A fragment with no `format` of its own (included only by a
  larger entry point) missed sibling fragments included by that same entry point but not by each
  other — e.g. a symbol from `io.asm` was reported as "not included" while editing `lexer.asm`,
  even though both are included by `cc.asm`. Fixed centrally, so all three features (and
  go-to-definition) benefit.
- More hover content upgrades: directives with a completion snippet (`virtual`, `macro`, `struct`,
  `if`, `while`, `repeat`, `include`) now show it as a code example; CALM sub-commands (`match`,
  `assemble`, `arrange`, `compute`, `check`, `emit`) get their own tag instead of "directive";
  format keywords show their real category (output format / PE subsystem / segment attribute /
  ...) instead of one generic label; size specifiers distinguish "size specifier" from
  "addressing qualifier"; `equ` constants show their real `NAME equ value` syntax with a note that
  it's textual substitution, not a stored value like `=`; size specifiers (`dword`, `byte`, ...)
  and same-width data directives (`dd`/`rd`, `db`/`rb`, ...) now cross-reference each other,
  since they're easy to conflate despite being genuinely different things.

## 0.4.0

- Hover is far richer now: instructions show a syntax-highlighted signature; registers show their
  full width family (`al` → `ax` → `eax` → `rax`, current one bolded) and calling-convention role
  (System V AMD64 ABI argument order, caller/callee-saved, syscall clobbers); non-GP registers
  (segment/control/debug/FPU/MMX/SSE/AVX/AVX-512) explain what that register class is; symbols
  show which file they're defined in and whether they're actually reachable via this file's own
  `include` chain.
- Fixed: a macro/struct whose body opens on the same line (e.g. `macro foo a, b {`) leaked a
  stray `{` into its recorded parameter list (affects hover, completion, and signature help).
- Fixed: `format`/`section`'s `executable` keyword only documented its meaning right after
  `format` (produce an ET_EXEC); its far more common use as a segment attribute
  (`segment readable executable`) wasn't mentioned at all.
- Fixed: `fasm2Studio.buildOutputPath` was declared as a setting but never actually read anywhere
  — Build/Run/Debug always output next to the source regardless of this setting. Now respected,
  resolved relative to the source file's own directory; missing output directories are created
  automatically.

## 0.3.0

- Registers now display as unsigned hex/decimal/binary (previously gdb's raw signed default,
  e.g. `0xffffffff` read as `-1`), and hovering any x86-64 register alias in source while
  debugging (`eax`, `al`, `r8w`, `sil`, etc.) shows its current value the same way.
- Register values can now be edited directly — from the Registers panel, or from a Watch entry.
  Accepts decimal, `0x../0b..`, and the asm-style `..h` hex suffix; a negative decimal wraps to
  the register's own two's-complement bit pattern.

## 0.2.4

- Compiler auto-detection now also checks well-known install directories not on `PATH`
  (`~/.local/bin` on Linux/macOS, plus Homebrew's paths on macOS and scoop/chocolatey's shim
  directories on Windows), fixing diagnostics/build/debug silently not finding fasm2/fasm1 when
  VS Code is launched in a way that doesn't inherit your shell's `PATH` additions.

## 0.2.3

- Fixed: `FASM: Debug` could fail with "Could not find the task 'fasm: Debug build (active file)'"
  when starting a session any way other than with the target `.asm` file focused (e.g. from the
  Run and Debug panel) — the debug build now runs directly instead of depending on VS Code's
  task-label lookup.
- Fixed: diagnostics silently produced nothing, with no explanation, when no fasm2/fasm1 compiler
  could be resolved on `PATH`; now logs a warning explaining what's missing.
- Fixed: a document diagnosed before workspace indexing finished (so its real entry point
  couldn't be found yet) was never re-diagnosed once indexing completed.

## 0.2.2

- Fixed: diagnostics for an already-saved file were compiling from last-saved disk content
  instead of the live editor buffer, so unsaved edits (including to a fragment included by a
  different entry file) wouldn't be flagged until the file was saved.

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
