# Changelog

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
