# Changelog

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
- Corrected README/CONTRIBUTING/extension-manifest text that implied Xcode's bundled `lldb`
  already works as the debug backend on macOS — it doesn't; documented the actual `lldb-mi`
  requirement instead.

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
