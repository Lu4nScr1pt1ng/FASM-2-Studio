# Changelog

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
