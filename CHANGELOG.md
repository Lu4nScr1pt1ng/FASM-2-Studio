# Changelog

## 1.27.1

### Fixed: a Windows build task failed with "symbol 'c' is undefined or out of scope"

`fasm2Studio.fasm2Preload` and a debug build's listing include were injected as one shell argument,
`-i include "<path>"`, wrapped in `vscode.ShellQuoting.Strong` so the space after `include` couldn't
split it into two. Strong quoting wraps a value in `'` on bash and PowerShell but in `"` on cmd.exe —
with no escaping of anything already inside it. On cmd, that outer `"..."` landed on top of the
fasm-level `"..."` already in the string: a `""` at the boundary just toggles quoted state twice and
cancels out, so both layers of quoting vanished before fasmg ever saw the line. It received the bare
path, `c:/Users/...`, tried to parse it as an expression, and failed on the first token it found:
`Error: symbol 'c' is undefined or out of scope.`

The task's shell is now pinned to cmd.exe on Windows rather than left to whatever
`terminal.integrated.defaultProfile.windows` happens to resolve to (commonly PowerShell these days),
and the fasm-level quote character is chosen to be whichever one the shell isn't using — so the two
can no longer collide.

### Fixed: live error checking silently stopped working on Windows

The official fasm2 distribution for Windows ships as a `fasm2.cmd` wrapper script, not a bare `.exe`.
`compilerDiscovery.ts`'s own probes already knew this and ran through a shell for exactly that
reason, but the diagnostics compile itself spawned the compiler directly — Node cannot launch a
`.cmd` that way. Every compile failed before reaching the assembler, and diagnostics went dark with
"spawn fasm2 ENOENT" in the output channel, easy to miss unless you went looking for it. The
diagnostics compile now goes through a shell on Windows too, the same way the probes always have.

### Fixed: inlay hints never appeared on Windows

Uncovered while verifying the fix above: once compiles actually started succeeding, the
address/size hints `fasm2Studio.inlayHints` adds inline still never showed up. The document's URI
was decoded into a filesystem path by hand, and that path kept the URI's own `/` regardless of
platform; every other path this feature keys its maps by comes from `.fsPath`, which uses `\` on
Windows. Two spellings of the same file never compared equal, so the lookup always missed. The URI
is now resolved through that same `.fsPath` machinery everywhere.

## 1.27.0

### The `${workspaceFolder}` in your launch.json

A launch configuration written the way every VS Code launch configuration is written:

```json
{ "type": "fasm", "request": "launch", "name": "Debug FASM program",
  "asmFile": "${workspaceFolder}/hexdump/main.asm", "args": ["/bin/ls"] }
```

never started a session. It was turned away with

```
FASM2 Studio: no such source file: ${workspaceFolder}/hexdump/main.asm.
```

— the path reported back as the literal text that was typed, because that is exactly what the
extension was given. VS Code substitutes `${...}` in a debug configuration *between* the two hooks
an extension can hang off: `resolveDebugConfiguration` runs before substitution and sees what you
wrote, `resolveDebugConfigurationWithSubstitutedVariables` runs after it and sees what you meant.
Everything here lived in the first one — the existence check, the entry-point resolution, the build,
the listing, gdb — so `${workspaceFolder}`, `${file}`, `${fileDirname}`, `${env:HOME}` and
`${command:...}` all reached the filesystem as themselves.

The only configuration that could start a session was one with an absolute path written out in full,
which is what `FASM: Debug`, the code lens and the status bar all pass — which is how this went
unnoticed. It also means the two configurations *this extension writes for you* were among the
casualties: both the entries offered by "create a launch.json file" and the ones in the Run and
Debug dropdown use `"asmFile": "${file}"`, as does every `attach` example in the README, right down
to `"coreFile": "${workspaceFolder}/core"`.

Resolution now happens after substitution, and a real debug session is driven end to end from
`${workspaceFolder}/…`, from `${file}`, and from a relative path, so this cannot come back quietly.

### Relative paths, resolved against something you can point at

`"asmFile": "../hexdump/main.asm"` was resolved against neither the workspace folder nor the
`.vscode` directory the file is written in, but against the working directory the extension host
happens to have been started with — for a launch from the desktop, `/`. Relative paths in
`asmFile`, `program`, `listingFile`, `coreFile` and `cwd` are now anchored to the workspace folder
the configuration came from, and a path that still resolves to nothing is reported as the place it
actually looked rather than as what was typed.

## 1.26.0

### The column your comments were aligned to

Format Document put every trailing comment one space after the code:

```
        mov     rbp, rsp        ; freeze the argument vector before pushing
                                ; anything; see includes/args.inc for offsets
```

came back as

```
        mov     rbp, rsp ; freeze the argument vector before pushing
                                ; anything; see includes/args.inc for offsets
```

with the first line collapsed and the second — a comment on a line of its own, which the formatter
would not touch — left at column 32, so the two halves of one comment no longer lined up with each
other or with anything else. A formatter that destroys a column an author aligned by hand is worse
than no formatter, and this one was documented as being conservative precisely because in assembly
the visual column of a thing is load-bearing.

Trailing comments are now placed as a column. Each run of commented lines gets one, and the column
the author gave it is kept whenever it still clears the code — so a file laid out by hand comes back
byte for byte. It moves only when the code has outgrown it, to the next tab stop past the longest
line in the run, which is also what a run of comments that were never aligned gets. A comment
continuing the one above it at the same column travels with that column; a banner comment on its own
line still stays exactly where it was put. `fasm2Studio.format.commentColumn` still pins comments to
one absolute column across the whole file if that is what you want.

### The half of fasm's block syntax that was missing

fasm has two ways to write a block and both are in daily use: fasmg's `macro` ... `end macro`, and
fasm 1's `macro name {` ... `}`, which fasmg accepts too. Only the first was understood. A `}` ended
nothing, so every braced macro in a file added a level of indentation that was never given back —
fasm 1's own `proc32.inc` came out with 144 columns of leading whitespace, and KolibriOS' uFMOD with
288. Braces now open and close blocks, counted off the tokenizer so a `}` inside a string or a
comment is not one, including fasm 1's escaped `\{`/`\}` and the `{` written on the line after its
keyword, which is a body delimiter rather than a level of its own.

Three other things drove the same runaway:

- **`calminstruction` bodies.** calm's `match` tests its arguments; it opens nothing and there is no
  `end match`. Read as a block opener, it indented fasmg's own `80386.inc` to 96 columns. A calm body
  is now laid out as the flat instruction list it is.
- **Lines continued with a trailing `\`.** Only the first physical line of one of those is a
  statement; the rest carry wrapped operands. Reading each as a fresh statement turned
  `hlt,0F4h, cmc,0F5h` into a mnemonic whose operand began with a comma. They are passed through.
- **Blocks the file never closes.** Every project has a construct this cannot know — an
  `endif equ end if` alias, a macro pair of its own invention, a fragment meant to be included inside
  something it never opens. The file is now surveyed before it is laid out, and an opener nothing
  ever closes indents nothing. `endif` itself is recognized as the `end if` alias 74 KolibriOS files
  define it to be, rather than flattening the nesting out of all of them.

`match =dup? value, definitions` — ordinary fasmg, out of fasm2's own `dd.inc` — was read as the
definition of a symbol called `match`, because the `=` that begins a match pattern looks like the one
in `COUNT = 10`.

Checked against 4,599 real fasm files — fasm2 and fasmg's own sources and packages, fasm 1's
examples and includes, and KolibriOS — with no token in any of them reordered, dropped or rewritten,
and every file unchanged by a second pass. Against how those files' authors actually laid them out,
the formatter now agrees with 28% of lines in fasm2/fasmg sources where it agreed with 12%.

## 1.25.0

### The feature nobody could find

`fasm2Studio.inlayHints` annotates every line that produces code with the address it lands at and
the bytes it encodes to — the single most fasm-specific thing this extension does, and the one
feature with no presence in the UI at all. It is off by default, it is a six-valued enum rather than
a switch, and until now the only place it appeared was its own row in the settings editor. Anyone
who never went looking for it had no way to learn that the encoding of every instruction was one
setting away.

`FASM: Annotate Instructions Inline` is now a command, and the fourth entry in the status bar menu —
which is the part that matters, since that menu is what a click on the always-visible item opens.
The entry says which mode is in effect, so it doubles as the answer to "is this on?". It sits after
whatever is currently broken and before the log and restart entries: it offers something rather than
fixing something, so it must never displace an entry that names a standing problem.

The picker shows each mode as what it renders rather than as a description of it, against the same
instruction throughout:

```
Address                mov eax, 60   →   0x00401000
Encoding               mov eax, 60   →   B8 3C 00 00 00
Address and encoding   mov eax, 60   →   0x00401000 · B8 3C 00 00 00
```

Off is last rather than first. The list is reached from an entry that already says what the current
mode is, so someone opening it has decided to change something, and leading with the one answer that
removes the feature would put it under the cursor.

The hints ride on the listing from the background compile behind live error checking, so three
things have to hold for them to appear: a trusted workspace, `fasm2Studio.diagnosticsEnabled`, and a
fasm2/fasmg project. Choosing a mode when one of them is missing now names the missing one. Without
that the feature simply appears not to work — the setting reads as the mode you picked and the
editor shows nothing, with nothing to distinguish the three causes. The untrusted workspace is
reported ahead of the diagnostics switch, since an untrusted workspace runs no compiler at all and
flipping that switch there changes nothing.

The setup walkthrough gains a fifth step for it, and the mode is written globally rather than into
the project: it is a preference about how you read assembly rather than a fact about the code, so it
should follow you between projects, and writing it per-workspace would put a personal display choice
into a `.vscode/settings.json` diff.

### Settings that render as written

Every setting whose description quotes fasm syntax now uses `markdownDescription`, so the backticks
around `include 'foo.inc'`, `["-p", "300"]` and `B8 3C 00 00 00` render as code instead of as
literal backtick characters — which is what the settings editor had been showing. The descriptions
here are unusually prose-heavy and quote the assembler constantly, so the markup was load-bearing
rather than decorative. Where one setting names another, it is now a link to that setting's own row:
`fasm2Studio.inlayHints` points at `diagnosticsEnabled`, and `fasm2Preload` and `compilerArgs` point
at each other and at `includePath`.

`fasm2Studio.defaultDialect` had a two-value dropdown with nothing explaining either value, found by
a new test asserting every enum setting describes all of its values. It now carries the same wording
`FASM: Select Dialect` has always used.

## 1.24.0

### How you got here

gdb reports one stack frame for a fasm2 program, however deep it actually is. That is not gdb being
unhelpful: a fasmg binary carries no DWARF, no `.eh_frame` and no symbol table, so there is nothing
to unwind with. "What called this" was the question a large project asked most often and the one
thing the debugger could not answer at all.

It can now, and the answer comes from the listing that was already being read for source-line
mapping. A listing entry records an address *and the bytes that statement assembled to*, which
between them name the exact address every `call` in the program pushes. Collected once at launch,
that is a closed set of the only values a return address can have — so recognising one on the stack
is an exact membership test rather than the "does this look like it points into the text segment"
guess a scanning unwinder normally has to make.

```
inner+0x2      demo.asm:23
outer+0x9      demo.asm:19
start+0x21     demo.asm:12
```

Frames are named by the label they are executing inside, because there is no function symbol to name
them after and naming every frame after its *file* — which is what the single-frame version did —
says nothing once there is more than one.

Detection reads the encoding, not the listing's statement text, and that is load-bearing rather than
fastidious: a `call` emitted from inside a macro shows the **macro invocation** as its text. Against
a real listing, a statement reading `emitcall outer` assembles to `E8 12 00 00 00` — a direct near
call that any text-matching rule would miss, in exactly the macro-heavy code this extension exists
for. The `FF` opcode group is decoded down to its ModRM reg field for the same reason in reverse:
`inc`, `dec`, `jmp` and `push` are all spelled `FF` too, and calling one of them a call would invent
a return site and then invent whole frames out of leftover stack.

Routines that keep a frame pointer are walked through their saved-`rbp` chain, which gives the calls
in their true nesting order. Frameless ones — most hand-written assembly, since nothing makes a
prologue necessary — are recovered by scanning for those known return addresses instead. Both are
needed, and the end-to-end test is what established it: a leaf that skips its prologue leaves `rbp`
still addressing its *caller's* frame, so a chain walk starting there steps straight over the caller
and reports it as though the leaf had been called from one level higher. Its return address is
sitting between `rsp` and `rbp`, in the one region the chain never looks at. That region is scanned
first and the chain walked from `rbp` up; they are disjoint by construction.

Every frame records which of the two found it, because they do not carry the same confidence: a scan
cannot tell a live frame from a dead one left behind by a call that already returned.

### The changed-register summary now covers the whole machine

The group headers said which registers the last step moved, and they were computed by diffing two
consecutive reads — which quietly meant "the registers with an integer reading to diff", i.e. the
general-purpose and pointer ones. Every class where "did that instruction touch it" is *hardest* to
answer by eye was excluded.

gdb can simply be asked instead, and now is. A single `fld` reports `st0`, `fstat` and `ftag`
changed; a `movdqu xmm0` reports `xmm0`. Neither was visible before, and every group carries the
summary now rather than two of them:

```
Flags               [ CF AF IF ]  changed
Vector (SSE/AVX)    16 x 256-bit  changed: ymm0
x87 FPU             st0 = R7  [ ]  changed: st0
```

Two properties of that query shape everything around it, both confirmed against real gdb rather than
assumed. It is *consuming* — asking twice in a row returns an empty list the second time, because
answering resets gdb's own baseline — so it is asked at most once per stop and its answer cached,
since VS Code reads the panel more than once at a single stop and the second read would otherwise
report that nothing had moved. And reading register *values* does not consume it, which is what lets
the value snapshot be taken first.

The Vector group needed one more thing. gdb answers in terms of the target's *raw* registers, and
`ymm0` is not one: on a machine with AVX the raw registers are `xmm0` and a separate `ymm0h` upper
half, and the `ymm0` on screen is a pseudo-register gdb assembles from the two. A `movdqu xmm0`
reports xmm0 and never ymm0, so matching on the displayed name alone left the header claiming
nothing had moved while the row beneath it visibly changed.

### The Stack group as a picture of a frame

The words at and above `rsp` were already resolved against your labels. They are now annotated with
the two things that make them a structure rather than a column of numbers — where the frame pointer
points, and which words are return addresses, using the same listing-derived set the call stack is
built from:

```
[rsp+0x0]     0x4000e3  → outer+0x9  return address
[rsp+0x8]     0x7fffffffd0d8  ← rbp
[rsp+0x10]    0x4000d1  → start+0x21  return address
```

`stackWords` sets how deep it goes. `stackRedZone` adds the 128 bytes *below* `rsp` — the System V
scratch area a leaf routine may use without moving the stack pointer, off by default because for
most code those words are leftovers rather than data, and available because when you do need them
nothing else shows them at all. They are listed after the words at and above `rsp` rather than in
address order: putting them first is the obvious thing and it opens the group with sixteen rows of
untouched scratch, pushing the return address off the bottom.

### The branches that read no flag

**Conditions** listed every conditional jump that tests EFLAGS. `jrcxz` and the `loop` family test
the counter register instead, and were missing — the only conditional branches not covered.

`loop` is the one worth having computed. It decrements *first* and branches while the result is
non-zero, so what decides it is `rcx-1` rather than `rcx`: at `rcx = 1` this is the last iteration
and at `rcx = 2` it is not, a reading nothing else on screen performs. And a `loop` reached with
`rcx` at zero decrements to all-ones and branches, running 2^64 more times — the worst outcome this
instruction has, reached from the most innocent-looking register value, and invisible in a display
showing `rcx = 0x0`. The row says so in words.

The header also now says out loud that the same conditions govern `cmovcc` and `setcc`: a `cmovg`
moves exactly when a `jg` would jump.

### One batched read behind the panel

Every register row fetched its own value, one `-data-evaluate-expression` at a time, while a batched
read of all of them had just been taken at the top of the same panel refresh. The rows are served
from that snapshot now — one MI command covers every register with an integer reading, which is all
of them but the SIMD ones, where gdb answers with a struct of lane vectors instead of a number.

This is a tidiness fix rather than a speed one, and worth saying so: measured against a local gdb,
seventeen sequential reads cost 0.59 ms against 0.13 ms batched. It matters over a remote gdbserver
and not much otherwise.

Correctness needed more care than the batching did. A snapshot is only good for the stop it was
taken at, and three things can invalidate it: the program running, a register edited in the panel,
and — the one that is easy to miss — `set $orig_rax = 59` typed into the Debug Console, which is a
register write that never passes through the panel's own write path. Rather than trying to tell a
reading expression from a writing one, any evaluated expression drops the snapshot. Two end-to-end
tests caught the first two cases before this shipped; both now guard them.

### Test fixtures that are what gdb actually says

`registers.test.ts` carried a hand-trimmed copy of gdb's `-data-list-register-names` output, keeping
only the entries its assertions mentioned. That quietly weakened the test named "leaves no register
gdb reports out of every group at once" into a check against a list no gdb ever produces: the real
one has 223 entries, including every sub-register (`al`, `ah`, `ax`, `eax`, `r8l`, `r8w`, `r8d`) and
the `ymm` upper halves as top-level entries of their own.

The fixtures are now verbatim, with the runs of unnamed padding written as counts so the register
*numbers* stay exact — `fs_base` is the 152nd slot, not the 59th it looked like with the empty ones
dropped. The coverage test checks each unplaced name against an explicit allowlist of what is
reachable as a child view, so a register gdb starts reporting that genuinely is not covered still
fails it. Two facts only the real list can carry now have tests of their own: that a 64-bit target
reports `eax` *as well as* `rax`, so slot order rather than mere presence is what picks the right
one, and that the low byte of `r8`-`r15` is spelled `r8l` by gdb where fasm spells it `r8b`.

## 1.23.0

### Which registers that step actually changed

The panel showed you sixteen registers. It did not show you the one thing you stepped in order to
find out — which of them the instruction touched. That answer was sitting in the difference between
two consecutive reads, and nothing was taking it.

Now the **General Purpose** and **Pointers** headers carry it, so it is readable with every group
collapsed:

```
General Purpose    changed: rcx
Pointers
```

Collapsed is the point. VS Code already highlights a *row* whose value changed, which requires the
group to be open — and the reason to open a group is usually that you already suspect the answer.

`rip` is never named there. It changes at essentially every stop, because that is what executing an
instruction is, so a summary that included it would read `changed: rip` forever and stop being read
at all. Its own row still shows what it moved by, where that is a fact about this step rather than
a constant.

A register that moved also gains a `previous` row, with the arithmetic already done:

```
rsp    0x7fffffffd1b8
  previous    0x00007fffffffd1c0  (-8 = -0x8)
```

That is the reading being asked for. `-8` is a push, `-0x28` is a prologue reserving space, and
deriving either from two twelve-digit hex addresses is precisely the arithmetic nobody should be
doing by hand at a breakpoint. The subtraction is signed, so a stack pointer moving *down* reads as
`-8` rather than as the `+18446744073709551608` an unsigned wrap would report.

The comparison is against the last time the panel was read, and it is taken there rather than at
every stop — so a session where nobody opens the panel pays nothing for it, and one where somebody
does pays a single batched register read per stop, whatever the target's register count.

### `pkru` was reported by gdb and shown nowhere

It had a width, it resolved in hover and in Watch, and it appeared in no group in the panel — the
one register gdb reports for a live x86-64 target that had no way to be discovered by looking. It
now sits in **Thread / Syscall**, read as the rights it actually grants rather than as a number.

Which half of that gets spelled out depends on which is shorter, and that is not cosmetic: the value
a Linux process genuinely starts with is `0x55555554` — every key but key 0 access-disabled — so
naming the restricted keys, the obvious way round, makes the ordinary case a fifteen-item list that
buries its only fact. It reads `key0 unrestricted, 15 restricted` instead. A test now asserts that
every non-padding name gdb reports lands in some group, so the next one cannot go missing quietly.

### Mask registers read as masks

`k0`-`k7` were being formatted as though they might be addresses or packed text — annotated with
whatever label happened to sit at `0xff`, and offered to the hex editor. A mask register is neither.
Its value is *positional*: bit *n* says whether lane *n* of the next vector operation is written. It
now leads with binary, where that can be counted off directly, and says how many lanes are set:
`0b1111_1111  8 lanes`. How many lanes a mask *covers* is deliberately not claimed — a `k` register
is 8 lanes to a `vaddpd` and 64 to a `vpaddb`, which is a property of the code, not of the register.

### Smaller

- Expanding a register no longer shows `signed` repeating `unsigned` digit for digit. It appears
  when the two readings actually differ — that is, when the sign bit is set — and not otherwise.

## 1.22.0

### Half of the machine was not in the Registers panel

The panel showed the general-purpose registers, the pointers, EFLAGS and the segment selectors. That
is the whole of what an x86 program had in 1985, and about half of what one has now. Asked what it
actually has, gdb answers with a list more than three times as long — and everything it named that
was missing is now a group of its own, appearing only when the connected target really reports it.

**Vector — `xmm0`-`xmm15`, and `ymm`/`zmm` where the CPU has them.** This is the serious omission.
On x86-64 the SysV ABI puts *every* floating-point argument and return value in `xmm0`-`xmm7`, so a
program that calls `printf("%f")` was passing a value through a register the debugger would not
show. Each physical register is listed once, at its widest name, with the narrower aliases as
children the way `al`/`ax`/`eax` sit under `rax` — `xmm0` is the low half of `ymm0`, and listing
both would be listing one register twice.

Expanding one gives every reading of the same bits at once:

```
ymm1    0xc0020000000000003ff8000000000000
  hex           0x00000000000000000000000000000000c0020000000000003ff8000000000000
  4 x double    1.5, -2.25, 0, 0
  8 x float     0, 1.9375, 0, -2.03125, 0, 0, 0, 0
  4 x qword     0x3ff8000000000000, 0xc002000000000000, 0x0, 0x0
  8 x dword     0x0, 0x3ff80000, 0x0, 0xc0020000, 0x0, 0x0, 0x0, 0x0
  16 x word     16 lanes
  32 x byte     32 lanes
  xmm1          0xc0020000000000003ff8000000000000
```

(that program did `movupd xmm1, dqword [pair]` over a `dq 1.5, -2.25`, so the doubles are the
reading it meant — but the debugger has no way to know that, which is the point)

All of them, rather than a guess at which one this program meant, because the guess is not
available: nothing in the register records whether a `movaps` put four floats or sixteen bytes
there. A register loaded with text by a `movdqu` reads as that text — `'SIMD/x86-64!!!!!'` — which
no numeric base shows. Every lane is derived from one value read once, so the whole expansion costs a
single round trip.

**x87 FPU — `st0`-`st7` and the environment words.** For 32-bit code x87 is the only floating-point
path there is, and plenty of 64-bit fasm still uses it. The 80-bit extended format is taken apart
rather than left as the decimal gdb prints, because the states that cause trouble are invisible in a
decimal: an *unnormal* is a value no FPU since the 387 can produce, so seeing one means something
wrote raw bytes over the x87 state, and it prints as an ordinary number. Two further things the
decimal cannot say:

- A register nothing was pushed into is not zero. It holds whatever the last code to use the FPU
  left, and reads as a perfectly plausible value. The tag word is the only authority on that, so an
  untouched register now says `<empty>` instead.
- The x87 registers are a *stack*, and `st0` names whichever physical register `TOP` points at. One
  `fld` too many wraps it, and every `st(n)` after that quietly means a different register than the
  source says. The group header now reads `st0 = R6`.

**MXCSR**, decoded exactly the way EFLAGS is. Worth the same glance, too: its low six bits are
sticky exception flags that hardware sets and never clears, so a program producing a NaN out of
nowhere has the cause — `IE` for an invalid operation, `ZE` for a divide by zero — still sitting
there whenever you get around to looking. `RC` is named rather than numbered, since "rounding
control = 3" and "toward zero (truncate)" are not equally useful readings.

**Thread / Syscall.** `fs_base` and `gs_base` are what `[fs:0x28]` — the stack canary, and
thread-local storage generally — actually reads from; in 64-bit mode the `fs` *selector* is ignored
for addressing entirely and reads as a zero that says nothing. And `orig_rax` is named, not just
numbered: a fasm program with no libc is essentially a sequence of syscalls, so the number is the
whole meaning of the instruction, and Linux keeps it there precisely because `rax` itself has been
overwritten with the return value by the time you can look.

```
orig_rax    59  execve
```

Its tooltip carries the argument registers with it, including the one that causes a genuinely silent
bug: the fourth syscall argument goes in `r10`, not `rcx`, because the `syscall` instruction
overwrites `rcx` with the return address. Code that passes it in `rcx` assembles fine and passes
garbage.

### A Stack group, because nothing else could answer that question

There is one frame in this debugger and nothing to unwind with — a fasmg binary carries no CFI — so
"what called this" and "what did the prologue just push" had no answer anywhere in the UI. The words
at and above `rsp` do answer it, and each one goes through the same label resolution every register
row gets:

```
[rsp+0x0]     0x4000e7  → start+0x37
[rsp+0x8]     0x40111f  → msg
```

The first is the return address the `call` pushed. One register read and one memory read for the
whole group, however deep it goes.

### rip says which instruction it is about to run

```
rip    0x4000f4  → helper  nop
```

It is the one register whose value has a better reading than any number, and the only one where the
address alone was never the thing being asked for.

### A segment selector is not a number

`cs = 0x33` is not a quantity and not an address; it is thirteen bits of descriptor-table index, one
bit choosing the table, and two bits of privilege level. Read as hex it says nothing at all, and read
as a selector it is the ordinary user-mode 64-bit code segment. It now says so — `0x33  GDT[6] ring
3` — and `fs`/`gs` carry their base alongside, which is the half of those two that means anything.

The decimal column is gone from every register that is a bit pattern rather than a quantity: a
control word, a status word, a selector. Nothing in a program ever adds one to `mxcsr`, and
`0x1f80  8064` spent a column saying the same thing twice in a base nobody asked for.

### Fixed: AVX registers were invisible on every machine that has them

gdb is asked which registers the target has once the binary is loaded. The answer at that point comes
from the *architecture*; the answer after the process starts comes from the process, and only that
one has been through the CPU's actual XSAVE state. On a machine with AVX the first list has
`xmm0`-`xmm15` and no `ymm` registers whatsoever; the second has all sixteen of them, plus `pkru`.

Resolving only at launch — which is all this did — therefore hid every AVX register permanently, for
the whole session, on hardware that has them. The set is now re-read at the first stop, and the
Registers panel waits for that read rather than racing it, so the vector group is right on the first
stop and not just the second.

### Writing the new registers

A vector register is written lane by lane, since gdb offers no whole-register assignment for one and
the field that reads as a single 128-bit integer is not writable. An x87 register is written as the
float it holds — `-2.5`, not a bit pattern — and the string is handed to gdb unchanged rather than
parsed on the way past, because an 80-bit significand has more precision than this extension's own
numbers do and rounding the value someone typed would be a strange way to honor it.

Hover and Watch reach all of it too. One ordering detail is deliberate and worth stating: a name fasm
reserves (`xmm0`, `st0`, `rax`) resolves as a register *before* your program's symbols, because the
symbol cannot exist — fasm would not let you define it. The names gdb adds on top of the ISA
(`fs_base`, `orig_rax`, `mxcsr`) get no such precedence, because a fasm program is perfectly free to
define a label called `orig_rax`, and answering with the register instead would describe the wrong
thing entirely.

## 1.21.1

### Fixed: writing `r8b`-`r15b` changed nothing and said it had

The low byte of `r8`-`r15` is `r12b` in fasm's syntax and `r12l` in gdb's, and gdb does not reject
the name it does not know — `$r12b` is read as a *convenience variable*, which is a legal thing to
invent on the spot. So the write went to that invented variable, reported success, and left the
register exactly as it was. The panel then showed the value that had been asked for while the CPU
still held the old one, which is the worst way for this to fail: you step on believing a value you
never set. The name is now translated before it reaches gdb, everywhere one is used — the register
view, hover, Watch, and inside a memory operand.

### Fixed: setting a 32-bit register left the upper half of its 64-bit parent alone

There is no x86-64 instruction that writes `eax` and preserves the high half of `rax` — every one of
them zeroes it. gdb's own `$eax = 1` does not, leaving `rax` at `0xffffffff00000001`, a state the
program could not have reached by executing anything. Setting a 32-bit view now goes to its 64-bit
parent, so it zero-extends the way the instruction it stands for does. The 8- and 16-bit views are
deliberately unchanged: `mov al, 1` really does leave everything above it alone.

### Fixed: a mistyped hex literal set the register to zero

`0xzz` is not a number, but it contains one — the leading `0` — and the parser that pulls a value out
of a partially-edited display row found it and used it. A typo in a hex digit silently zeroed the
register. Input that is not a recognizable display row now has to be a number outright, or it is
refused.

## 1.21.0

### Registers you can read at a glance

A register row used to be its own name, then the value zero-padded to the register's full width,
then the value again in decimal, then the value a third time as binary. On a 64-bit target that is
about a hundred characters, and for `r15` — a register the program never touched — every one of them
was spent saying "empty":

```
r15    r15 = 0x0000000000000000  0  0b0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000
```

The name was the row's own name column, repeated. The padding was sixteen characters of nothing. And
the binary expansion pushed everything that actually distinguishes one register from another off the
visible width of the panel, on every row, whether or not anyone was reading bits that day. The same
row now reads:

```
r15    0x0
```

What a row carries now is what is being scanned for. Hex always — it is the assembly-native base and
pastes straight back into a Watch expression. A decimal reading only where it says something the hex
does not: `0x2a  42`, but not `0x9  9`, and not twenty digits of unsigned reading for a stack
pointer. The two's-complement reading where the sign bit is set, so `-1` and `-2` are legible
instead of being `18446744073709551615`. Then the two things only assembly needs:

- `0x48544150  1213481296  'PATH'` — the value is printable text end to end, which is what a packed
  character literal looks like and what no numeric base makes readable.
- `0x4010e2  → msg` — the value lands inside one of your own labels, resolved from the listing (there
  is no symbol table to ask). `rip` reads as `→ start+0x25`; a pointer into an array reads as
  `→ table+0xc`. A sized label ends where its declared size ends, so an address one byte past a
  `dd 1,2,3,4` is reported as outside it rather than as `table+0x10`.

### Everything the row dropped, one level down

A register row now expands. Its children are the readings the row is too narrow to carry, and none
of them costs anything until the row is opened:

- `hex` zero-padded to the full width, for comparing two registers digit by digit
- `binary` grouped into bytes and nibbles — `0b0000_0000 0100_0000 0001_0000 1110_0010` — so a bit
  position can be counted off against an operand size
- `bytes` in memory order, `e2 10 40 00 00 00 00 00`, which makes an endianness mistake visible
- `unsigned` and `signed` in full, with no readability threshold applied
- the sub-register slices: `eax`, `ax`, `al`, `ah` under `rax`, `r12d`/`r12w`/`r12b` under `r12`.
  Derived from the value already read, so they cost no round trip — and each one is a real register,
  so setting `al` from there writes just the low byte.
- `[rsi]`, what the register points at: the qword at that address, plus the string if that is what is
  there — `0x77202c6f6c6c6548  "Hello, world!"`. One memory read, paid on expansion.

Hovering a register gives the same thing as a block, since a tooltip has room for all of it at once.
Sub-registers included: hovering `al` in source that only ever loaded `rax` now answers.

### Flags say which jumps would be taken

The **Flags** group's own row is the set flags — `[ CF PF SF IF ]` — rather than the number they
came from, and it no longer costs a second round trip to gdb to produce, so the names can never
disagree with the value beside them. Each bit reads `1  set` / `0  clear` rather than a bare digit,
which is the difference between scanning a column of sixteen ones and zeroes and reading one.

Added under it: **Conditions**, which answers the question EFLAGS is actually read for.

```
Conditions   jne, jb, jbe, jl, jle, js, jno, jp
    je / jz          not taken
    jne / jnz        taken
    jb / jc / jnae   taken
    ja / jnbe        not taken
    jl / jnge        taken
    jg / jnle        not taken
    ...
```

Every conditional jump, with the flag test that decided it. This is memorised bit algebra — "jg is
taken when ZF=0 and SF=OF" — that gets re-derived at every single breakpoint and mis-remembered in
exactly the places it matters, which are the signed/unsigned pairs: `jb` against `jl`, `ja` against
`jg`. The flags were already read to display them, so deriving it costs nothing.

The `eflags` register itself is now a row in that group too. It always was the only thing there gdb
could actually write — there is no MI command for setting one EFLAGS bit in isolation — and there
was previously no way to reach it from the panel at all.

### Editing a register value knows what it is editing

VS Code pre-fills its in-place editor with the whole current row, not a bare number, so editing one
column submits every column back. Which one moved used to be inferred from the other two agreeing
with each other, and that inference needs exactly three columns — the shorter rows above do not have
them. The register's current value is now read before parsing instead: every column that still
agrees with it was left alone, so whatever is left is the edit. Re-submitting a row unchanged is a
no-op rather than a guess, and a register name with a digit in it (`r15`) or an annotation with one
(`→ msg+0x8`) is no longer mistaken for the value.

### Watch and inline values stop saying the name twice

An evaluate result that VS Code is going to render next to the expression that produced it — a Watch
row, an inline decoration at the end of the stopped line — now comes back as the value alone. The
Debug Console and the clipboard, which have no such column, still get the labelled form.

### Run, on a program that had not been built yet, opened a terminal and ran nothing

The "FASM" terminal appeared, showed a prompt, and that was the end of it. It looked like a failure
of the build that had just happened, and it was not: the program was built, and the command to run
it was handed over — to the terminal's shell, as text, the way `Terminal.sendText` does.

A shell that is still starting up discards whatever was typed before it was ready. Both readline and
fish switch the terminal to raw mode with `TCSAFLUSH`, which throws away pending input, and a
terminal profile that reaches the host through a helper (`host-spawn` under a flatpak VS Code, for
instance) widens that window to seconds. The command was typed into it and dropped on the floor.

Only a *fresh* terminal is in that state, which is what made this look like a rule about compiling:
a project that had already been run had a warm terminal to reuse and worked, while a project that
had just been built for the first time got a new terminal and lost the command. The same reuse hid a
second version of it — a run started while the previous program was still going typed the new
command into *that program's* stdin.

The program is now the terminal's own process instead of a line typed into a shell running in one.
There is no shell in the way to be raced, and no command line to be escaped for one: the path and
`fasm2Studio.runArgs` arrive as argv, so an argument with a space, a quote or a `$` in it reaches
the program as written. This is the same route the debugged program's terminal has always taken, and
for the same reason.

Consequences worth knowing about:

- The terminal stays open when the program ends, and says how it ended — `exited with code 3`, or
  `was killed by SIGSEGV`, which is the more useful half for assembly. Press a key to close it. A
  program that prints and returns no longer takes its own output off the screen with it.
- It is the program's terminal, not a shell prompt, so a new run replaces it rather than adding a
  tab. It opens focused, since a program that reads stdin is waiting to be typed into.
- The program runs in the editor's own environment rather than under the shell profile configured
  in `terminal.integrated.profiles` — the environment the debugger has always run it in.

### "Build it now" builds the file you asked about

The warning shown when Run finds nothing built offers to build. It used to build whatever the active
editor held, which is not necessarily the file Run was invoked on: Run also comes from the Explorer
context menu and the Entry Points view. It now names the file explicitly.

## 1.20.0

### The include line you would have counted `../` levels to write

Dragging a file in from the explorer now writes the `include` line for it.

fasm has no module system: a path inside a string literal is the only thing tying two files
together, and writing one means counting directory levels by hand against a search order that is not
written down anywhere in the project. The gesture people already try — drag the file in — previously
fell through to VS Code's own default, which inserts the raw path as plain text. That is neither
valid syntax here nor even the right path: it is spelled against the workspace root rather than
against the file being edited.

The path is spelled the way fasmg resolves one. Relative to the including file first, which is both
what the assembler looks at first and what keeps the reference correct after the project moves. A
configured `fasm2Studio.includePath` directory is preferred only when the relative path would have
to climb out of the tree — `'../../../vendor/fasm/include/win64a.inc'` encodes the layout of one
machine, where `'win64a.inc'` against a search directory is shorter and survives someone else's
checkout. The deepest matching search directory wins, since it spells the shortest path. An absolute
path is the last resort, for a file on another Windows drive where no relative path exists at all.

Separators are forward slashes whatever the host uses: fasm accepts them on Windows, and a backslash
written into a source file makes it non-portable in a way nothing later warns about. A quote in a
file name is doubled, which is how both fasm1 and fasmg escape one — left raw, the literal would end
early and the rest of the path would be parsed as code.

Dropping several files writes one `include` per line, in the order dragged. A file dropped onto its
own tab is skipped rather than turned into a self-include, and anything an `include` has no business
naming — a `.png`, a `Makefile` — is handed back to VS Code untouched rather than blocking the rest
of the selection.

### Which signals stop you, as checkboxes rather than as gdb trivia

The Breakpoints panel now has an exception section: SIGSEGV, SIGILL, SIGFPE, SIGBUS, SIGABRT,
SIGPIPE.

Every DAP capability is gated on the client seeing it declared, so an undeclared
`exceptionBreakpointFilters` is not a graceful degradation — it is an empty section, and gdb's
stop-on-everything default as the only reachable behaviour. Changing it meant knowing the `handle`
command and typing it into the Debug Console.

All six start checked, because that is what `info handle` reports before anyone asks; a default
disagreeing with the debugger would make the panel describe a session other than the one running.
The value is in being able to turn one off. A program that installs its own SIGSEGV handler is a
real technique rather than a curiosity, and it could not previously be run under this debugger
without gdb interrupting every fault the program was written to handle itself.

The signal is passed to the program in both states. Whether the *debugger* pauses is a separate
question from whether the program ever receives it, and swallowing one would make the program behave
differently under the debugger than outside it — the one thing a debugger must not do.

Two things about the wiring are worth recording, because both are silent when wrong. The base
class dispatches to `setExceptionBreakPointsRequest`, with the capital P it also spells
`setBreakPointsRequest` with; named the natural way the method compiles, typechecks and is never
called, leaving the base class's no-op to answer every request — checkboxes that render, respond,
and do nothing. And the launch-time replay onto a newly created gdb races the client's own request,
each issuing one command per signal: interleaved, whichever lands last wins, which is not
necessarily the one holding the user's choice. Applications are queued, and read the current
selection when they run rather than when they were scheduled.

gdb only. lldb-mi has no `handle`, so the toggles are inert on macOS rather than failing the launch,
the same way the `disassembly-flavor` set already is.

### Four more programs to start from, including a boot sector

`FASM: New File` offered two hello worlds. It now offers six.

Added: the 32-bit ELF and PE hello worlds, since the interfaces are genuinely different — `int 0x80`
takes its arguments in ebx/ecx/edx where `syscall` takes them in rdi/rsi/rdx — and a large share of
the x86 material people learn from is written against the older one; a PE64 DLL with an export; and
a boot sector.

The boot sector is the one that most rewards being written for you, and the case fasm is arguably
best known for: 512 bytes exactly, `format binary`, 16-bit real mode, BIOS teletype for output
because nothing else exists yet, and the `55 AA` signature the firmware checks before it will boot
the sector at all. Nothing about a wrong one looks wrong — it simply does not boot.

Templates are assembled by the real compiler on every test run, and the boot sector is additionally
asserted to be exactly one sector ending in those two bytes. Naming the DLL's export `Add` is what
turned up the reason to say so in its own header comment: fasmg's x86 package defines mnemonics
case-insensitively, so a procedure called `Add` is read as the `add` instruction and the file does
not assemble.

`platform` on a template is now optional, meaning output no operating system loads at all. Those
rank between the host's own templates and another platform's: "you cannot double-click this" is
true of a boot sector everywhere, so it is not the wrong choice for this host the way a PE binary is
on Linux. It is also the only real answer on macOS, which has no template of its own.

### An empty Entry Points list that says why it is empty

The **FASM Entry Points** view was gated on there being an entry point in it, which made its most
confusing case the one case it said nothing about. A project of `.inc` fragments, or one whose
`format` directive is missing or misspelled, produced no view at all — and an absent section reads
as "this extension has nothing to say here", which is indistinguishable from it being broken.

The view is now gated on the workspace holding fasm sources, with a welcome view explaining the
empty state and offering `FASM: New File` and a refresh. A workspace with no fasm files in it still
grows nothing, which is what the original gate existed for. The search behind the new key only runs
when there are no entry points, and asks for one result rather than a listing.

### Smaller things

`FASM: Show Listing` is bound to `Ctrl+Alt+L` and added to the editor title bar's run menu;
`FASM: Check All Entry Points` is bound to `Ctrl+Alt+Shift+B`. Both are things you reach for
repeatedly while working on one file, and both previously needed the palette every time.

The status bar shows the compiler's file name rather than its full path. It is this extension's one
permanent piece of status bar real estate, and a configured compiler is routinely an absolute path —
an unshortened `C:\Users\...\fasm2\fasm2.cmd` crowded out every other extension's item to say
something the tooltip already said in full.

## 1.19.0

### The programs you did not have open

`FASM: Check All Entry Points` assembles every program in the workspace and puts what the compiler
says into the Problems panel — including for files no editor has ever shown.

Live error checking is driven entirely by the open-editor set: the server compiles a document when
it is opened, changed or saved, and nothing else ever triggers it. That is right for what it does —
it answers "what is wrong with the file in front of you", against the unsaved buffer — but it left
the Problems panel only ever as complete as the tabs that happened to be open. In a language built
on `include` trees that is a real gap rather than a theoretical one: editing one shared `.inc` can
break four of the five programs that include it, and the four keep looking clean until the day each
is opened.

It is one assembler run per program, which is why it is a command rather than something on a timer,
and why it is cancellable. It assembles into a temp directory, so checking a project never writes a
binary into it. Programs already open are skipped rather than re-checked: their live compile sees
the unsaved text and is the better answer for them. A cancelled run keeps what it found and retracts
nothing — the programs it never reached are not programs it found clean — and a run that could not
assemble anything at all says so, instead of reporting zero errors for work nothing looked at.

The marks it leaves belong to the file rather than to an editor, so closing a tab no longer clears
them: a file's problems are not a statement about whether you are looking at it.

### The listing the extension was already generating

`FASM: Show Listing` opens the assembler's own listing for the program the active file belongs to —
every statement with the address it lands at, its offset in the output file, and the exact bytes it
assembled to.

The listing has been here all along without being reachable: a debug build needs one to map addresses
back to source, and the inlay hints are built from one. Both consume a parsed subset — address,
statement text, byte count — which drops the file-offset column and every entry the correlator could
not tie back to a source line. Getting the listing itself meant knowing that a fasmg macro exists,
finding it inside the installed extension, and passing an `-i` flag by hand.

It opens as a read-only document rather than a file written next to your source: a listing describes
one moment of one build, so it is something to read, not a build artifact something else then has to
clean up. Re-running it updates the tab that is already open. It is a fresh compile every time,
deliberately — nothing in a listing's contents says which version of the source it describes, and a
stale one is worse than none. A build that failed part-way still shows the listing it managed to
write, with the error count named alongside it, since a listing that stops where the error did reads
otherwise as a program that assembles to less than it does.

fasm2/fasmg only. The listing is generated by a fasmg `calminstruction` macro; fasm1 can neither load
nor run it, and its own `-s` output is a different format entirely.

## 1.18.2

### A compiler that outlived the server that started it

A server process on its way out now takes its compilers with it.

The assembler is spawned detached, which is what lets a timed-out compile be killed as a whole
process tree — the official fasm2 distribution wraps the real binary in a shell script, so killing
only the direct child leaves the compiler itself holding the stdout pipe open. The same arrangement
means nothing in that process group dies with the server, and the ten-second timer that would have
killed a runaway one belongs to the process that is leaving. A compile still in flight when the
editor closed kept running with nobody to stop it and nobody to read its answer, and
`while 1` / `end while` is three lines and a genuine thing to have half-typed, so the orphan is not
always one that ends by itself.

Cleanup is now attached to every way this process can end, not just the polite one: the `shutdown`
request, the `exit` notification that calls `process.exit` as soon as its handler returns, and the
signal a client sends when it gives up waiting and kills the server outright — which is what follows
the `Stopping server timed out` line in the output channel. The shutdown request also cancels the
pending debounce timers, so a keystroke from a second ago cannot start a fresh compile in a process
that is closing.

The shutdown request itself was never the slow part: it is answered in about a millisecond even with
a compile hung in flight, since nothing here blocks on one. What the two-second timeout cost was the
cleanup on the other side of it.

### Temp files the compile wrote without being asked

Every artifact a compile leaves in the temp directory is now removed, matched by the name prefix
this module gives it, rather than only the two paths the command line named.

What a compile writes is decided by the source, not by the flags: `virtual as 'lst'` produces a
listing beside the output whether or not diagnostics asked for one, and the listing macro that does
it is bundled with fasm2 for any project to `include`. For such a project every compile left a file
behind — and diagnostics recompile on every pause in typing, so an afternoon of editing was
thousands of them.

## 1.18.1

### The error a macro frame was hiding

An error raised from inside a macro is reported on the line that wrote it, instead of silently
turning off diagnostics for the whole file.

fasmg prints a macro call stack between the header that locates an error and the message itself:

```
main.asm [38]:
        mov [message], ax
mov? [38]
Custom error: operand sizes do not match.
```

That third line is a call-stack frame, but a single-frame one is shaped exactly like the colon-less
header fasmg uses when it has no source line to quote — same "name [number]", no trailing colon.
Read as a header, it moved the error out of `main.asm` and into a file called `mov?`, which exists
nowhere; an error the editor cannot place anywhere becomes the status-bar sentence "Build failed in
mov? line 38", and the document's own diagnostics are cleared to make room for it.

The x86 package validates operand sizes, addressing modes and unknown mnemonics through `err` inside
its instruction macros, so this frame is present on essentially every everyday mistake — `? [4]` when
no macro matches the mnemonic at all. The effect was that the first real typo took the file's
diagnostics down and every later edit kept them down, since each new error arrived the same way. It
recovered only once the file assembled cleanly again, which is precisely when there was nothing left
to show.

Shape alone cannot separate a frame from a header, so position does: only a header the parser was
not already awaiting a message for opens a new error block. That also settles the frames that do
carry a trailing colon and a quoted line of macro body (`macro wrap [1]:`), which were mis-read the
same way.

## 1.18.0

### The memory a register points at

A register row in the Registers view now carries the address it holds, which is the field that
decides whether VS Code offers "View Binary Data" on that row at all. Data labels have had it since
raw memory reading landed; registers did not — leaving the hex editor reachable from a buffer you
declared by name and not from the `rsi` a syscall just filled in with one, which is the more common
way to arrive at memory worth looking at.

Segment registers are deliberately left without one. `cs` holding `0x33` is a descriptor-table
selector, not an address, and an offer to open a memory view at byte `0x33` could only ever lead
somewhere unmapped.

It costs no extra work: the row already had to ask gdb what the register held in order to print it,
and that same answer now serves both.

### Watching a register change

"Break on Value Change" on a register sets a real watchpoint instead of refusing.

The menu entry was already there, because VS Code gates that action on the debug session declaring
`supportsDataBreakpoints` rather than on anything about the row — so a register got the offer and
could only be answered with `"rsp" is not a data label this listing knows an address for`, which is
true and useless. gdb watches a register directly, so that is what it now does.

Only "on write" is offered, because that is all gdb can implement: `rwatch $rsp` is rejected
outright with "Expression cannot be implemented with read/access watchpoint." Offering the other two
would put entries in the menu that fail at the moment they are chosen.

What is watched is the register itself, not the memory it addresses — a watchpoint on `rsi` stops
when the pointer is reassigned, not when the buffer it points at is written. The row's "View Binary
Data" is what leads to the other one, and the description says which is which, because the two are
easy to confuse and expensive to confuse for long.

A register that shares a name with one of your data labels is not ambiguous: which one is meant
comes from the row the action was invoked on, not from the name.

### Opening a folder is enough

The extension now activates on a workspace that contains `.asm`, `.fasm`, `.fas` or `.alm` files,
rather than waiting for one of them to be opened as a tab. Until now a window opened on a project
folder had no sign of this extension in it — no status bar, and no list of the programs the folder
holds — until you happened to click a file, which is the wrong order for the one feature whose
entire job is to tell you what is in a project you haven't opened anything in yet.

`.inc` is deliberately not on that list, though the language claims it. It is a fragment extension
shared with several unrelated ecosystems, and a fasm fragment is only ever reached through the entry
point that includes it — which is one of the four above. Matching it would start a language server
in every project that happens to contain an include file, to look for programs that are not there.

### The FASM Entry Points section appears

The Explorer section added in 1.17.0 is gated on a context key, and that key was written from
exactly one place: the view's own `getChildren`. A view gated off is not rendered, and a view that
is not rendered is never asked for its children — so the single call that could turn the key on was
reachable only once the key was already on.

The list is now fetched by the refresh that already ran at the end of activation and after every
save, and that refresh is what sets the key; the view renders from what it fetched rather than
fetching on its own. Nothing about the section's contents or behaviour changed.

## 1.17.0

### What each instruction does to the flags

Hovering an instruction now says which flags it writes, which it only tests, and which it leaves
alone. This is the question assembly programmers actually interrupt themselves to look up, and
until now the hover answered everything except it.

The phrasing is deliberately prose rather than a set of letters, because the true answer is
routinely qualified in ways a letter set cannot carry. `inc` writes `OF SF ZF AF PF` and leaves
`CF` untouched — which is the entire reason it exists alongside `add …, 1`, and the entire reason a
multi-precision loop written with the wrong one is broken. `mul` writes `OF` and `CF` and leaves
four more *undefined*, which is not the same as leaving them alone. A shift by zero writes none of
them at all. `div` leaves every status flag undefined.

An instruction that touches nothing says so explicitly — `**Flags:** unchanged` — instead of
staying silent, because silence would be indistinguishable from an instruction this extension has
no data for. "Does `lea` affect the flags?" deserves an answer, and the answer is no.

304 mnemonics carry this: the base x86/x87 set, the conditional jump/set/move families (generated
from one condition-to-flags table, so `jbe`, `setbe` and `cmovbe` can never disagree about what
`be` tests), the string operations that read `DF`, and the x87 comparisons that report into EFLAGS.
The data is keyed by mnemonic, which is why it is also gated on the instruction set: `movsd` and
`cmpsd` are string operations in x86 and scalar-double float operations in SSE2, and the SSE2 forms
must not inherit "reads DF" from the names they happen to share. An AVX instruction carries no flag
phrase at all rather than a wrong default.

### The bytes an instruction assembles to

`fasm2Studio.inlayHints` gains `bytes` and `addressAndBytes`. Where the existing modes annotate a
line with where it lands and how large it is, these show the encoding itself — `B8 3C 00 00 00`
next to `mov eax, 60` — which is the thing a `.lst` file is usually opened to find.

It costs nothing new. The listing behind the address and size modes already contained the bytes;
the parser counted them and threw the values away. It now keeps them, and `byteLength` is gone as a
separate field, since a count and the thing counted are one source of truth or they are two that
can disagree. A wrapped byte dump — a `format` directive emitting a 120-byte ELF header across
sixteen listing lines — is folded into one encoding, the same way its length always was.

An encoding longer than 16 bytes is elided inline with its real length, since x86's longest legal
instruction is 15 bytes and anything past that is a header or a string whose point is that it is
large, not what its four hundredth byte is. Every hint carries its full, un-elided dump as a
tooltip regardless of the mode — including in the address-only modes.

### The programs in your workspace, as a list

A new **FASM Entry Points** section in the Explorer lists the files that are programs in their own
right, with Build and Debug on each row and Build / Clean / Open Build Output behind the context
menu.

Everything else in this extension addresses whatever file is currently focused, which is right for
editing but leaves a project's shape invisible: which of forty `.asm`/`.inc` files are programs and
which are fragments is knowledge the server already has — a top-level `format` directive is what
distinguishes them, the same fact behind the Run/Debug code lenses — and the only way to see it was
to open files one at a time and look for a lens.

It sits in the Explorer rather than in an activity-bar container of its own: these are build
targets, they belong next to the files, and a whole activity bar icon is more presence than a list
of usually two or three items has earned. A workspace with no fasm program in it does not grow the
section at all.

### `Ctrl+Shift+B` in a workspace whose files it knows how to build

The task provider returned nothing at all unless a fasm file happened to be the focused editor. So
`Ctrl+Shift+B` from a focused README — or straight after opening a folder, before any source file
has been clicked — reported the workspace as having no build task configured, in a workspace full
of files this extension builds.

With no fasm editor focused it now offers one Build task per entry point instead. Entry points
only, for the same reason the code lenses appear on entry points alone: a fragment cannot be
assembled standalone. An entry point whose own build task cannot be constructed — a dialect whose
compiler is not installed — drops out on its own rather than removing the rest of the workspace's
from the picker.

### A multi-file selection, acted on as one

VS Code hands an explorer context-menu command two things: the item that was right-clicked, and —
when the click lands inside a multi-file selection — that whole selection. This extension read only
the first. Selecting four files and choosing **Clean Build Output** cleaned one of them and said
nothing about the other three, which reads as the command half-working rather than as it only ever
having been given one file.

Build and Clean now act on the whole selection. Resolved entry points are de-duplicated first,
since several selected fragments routinely belong to one program and would otherwise assemble — or
clean — it once per fragment. Builds run one after another and stop at the first failure, rather
than burying the error that matters under the builds that followed it. Cleaning reports the whole
gesture once instead of a popup per file.

Run and Debug start a single program, so they have nothing sensible to do with four files. They
keep acting on the right-clicked one and now name it when the selection held more, which is the
part that was actually missing: doing the right thing silently is what looked like the other three
failing.

### The build output, in hex

`FASM: Open Build Output in Hex Editor` opens the binary a build produced. Assembly is the one
language where the output file is routinely something you need to read — a hand-built PE/ELF
header, a boot sector that has to be exactly 512 bytes ending in `55 AA`, a table laid out by hand
— and the extension already knew exactly where a build writes, honouring `fasm2Studio.buildOutputPath`.
What stood between the user and those bytes was knowing the path and finding the right "Open With".

It resolves through the same entry point Build does, so asking for the output of an included
fragment shows the binary its program produced rather than looking for output beside a file that
never wrote any. Output that has not been built yet offers to build it. The hex editor itself is
Microsoft's and is not built into VS Code, so a machine without it gets an offer to install rather
than a raw "no editor for this file".

### Smaller

Word-based suggestions are off for FASM files now. With a language server supplying completions
from the instruction set and the project's own symbols, the editor's fallback — every word in every
other open file — only dilutes the list.

### A skipped test that failed the run

The `debug-tests` CI job failed on a machine with no `fasm2` installed, which is every CI runner
here: the end-to-end suites correctly skipped themselves, and then the teardown of one of them
threw `TypeError: Cannot read properties of undefined (reading 'dir')` and failed the job anyway.

Mocha runs a suite's `after` hook even when its `before` called `this.skip()`. That hook read
`.dir` off two fixtures that `before` had returned without building. Teardown now removes whatever
was actually built, tracked as it is created, which also covers the half-built case the old code
never handled: when the second fixture's build throws, the first one's directory used to be left
behind. The declaration that claimed both fixtures always existed is what hid this from the type
checker, and the tracking list is honest about it being empty.

### Arguments for the assembler, everywhere it runs

Some projects do not assemble without a flag. fasmg gives up after 100 passes, which a macro-heavy
project genuinely exceeds, and a build-time definition is spelled `-i "define TARGET_LINUX 1"`,
since fasmg has no `-d` the way fasm1 does. The only place to put one was a hand-written
`tasks.json` — a path `FASM: Build`, `FASM: Run` and `FASM: Debug` do not take, since they build
the task definition themselves. Live error checking had no path at all: nothing in the settings
could reach that compile. A project of this kind therefore reported an error on every keystroke, on
a line that is not wrong, and the fix existed nowhere in the UI.

`fasm2Studio.compilerArgs` reaches every invocation of the assembler — the three commands, the
debug build that produces the listing, and the background compile behind diagnostics and inlay
hints. It is `resource`-scoped like the rest, so one folder's flags stay that folder's, and it is
listed in `untrustedWorkspaces.restrictedConfigurations`: it chooses what a spawned process is told
to do, which is not something a cloned repo gets to decide before you have trusted it.

Where the flags land in the command line is the whole of the ordering rule. After
`fasm2Studio.fasm2Preload`, because a `-i` line of yours may use the instruction set the preload
defines while nothing the preload does can depend on yours. Before the listing macro a debug build
injects, which stays last for the same reason it always did. Being last among the flags that carry
a value also means a repeated one wins, since fasmg takes the final occurrence — so `["-e", "5"]`
genuinely replaces the `-e 200` a diagnostics compile passes rather than being quietly outranked by
it. Both of those are asserted against the real assembler now, not left as claims in a comment.

The build and the diagnostics compile assemble the same argument list in the same order, which is
the point of doing it in both places rather than only where it was noticed: a compile whose
arguments differ from the build's is a compile whose errors are not the build's errors.

One caller deliberately does not get them. The dialect probe — the compile that decides whether to
suggest "this project is probably fasm1" — runs the *other* assembler, and the two share almost no
option set: handing fasmg's `-e 200` to fasm1 makes it print its usage banner and exit, which parses
as zero diagnostics and reads as "it assembles cleanly as fasm1". That is the probe's entire
evidence, so passing your flags there could turn a correct fasm2 project into a prompt to convert it.
A project whose build needs flags now simply gets no unsolicited suggestion.

The value is treated as the untrusted text it is. `"fasm2Studio.compilerArgs": "-p 300"` — a string
where an array belongs, which VS Code flags but still delivers as written — would spread into one
argument per character, and a blank entry reaches the assembler as a second positional parameter,
i.e. as an output file named `""`, failing a build for a reason invisible in the settings that
caused it. Both are dropped on each side of the wire.

### A Windows test that failed after proving its point

The extension's integration suite could fail in teardown on the Windows leg of the matrix, with
`EPERM` removing a temp directory (and `EBUSY` on another one earlier in the same run) — a green
test reported as a failure because of the cleanup that came after it.

Windows will not delete a file while a handle to it is open, and the handles belong to the editor
rather than to the test: a document stays loaded for a moment after `closeAllEditors` resolves, and
VS Code's own watcher holds the directory. POSIX unlinks an open file without complaint, which is
why nothing showed up on the Linux or macOS legs.

`fs.promises.rm`'s `maxRetries`/`retryDelay` is the remedy, and specifically the asynchronous form:
the synchronous one blocks the very event loop that releases those handles, so a synchronous retry
loop guarantees all of its attempts observe the identical locked state. Every temp directory across
all three packages now goes through one helper per package that retries and, if the directory still
survives, warns and leaves it to the operating system's own temp cleanup — teardown failing the test
it just finished is the worst of both outcomes, since it reports a passing feature as broken over a
few kilobytes the OS already knows how to reclaim.

## 1.15.0

### Hovering a memory operand during a debug session now reads the memory

With no `EvaluatableExpressionProvider` registered, VS Code falls back to the word under the cursor.
For most languages a word is a variable and that guess is fine. For assembly it is the wrong unit
almost every time you hover the thing you actually care about: in `mov eax, dword [rsp+8]` the word
under `rsp` is `rsp`, so the editor asked the debugger about the register and never about the memory
the instruction reads. The operand *is* the value at this level, and it was the one thing unreachable.

The work splits along the line the two packages already draw. `extension/src/memoryOperand.ts`
decides where the operand starts and stops — kept free of any `vscode` import, the way
`statusBarMenuItems.ts` is, so the part with behaviour in it can be asserted without a running
editor. `debug/src/operandExpression.ts` turns it into something gdb accepts, which has to happen
there because that is where the listing's symbol addresses live.

None of the operand is gdb syntax, and all four differences bite. Registers are spelled `$rsp`, and
a bare `rsp` reaches gdb as a symbol name — in a binary fasmg produced, which has no symbol table,
giving the misleading "No symbol table is loaded". Labels have the same problem with no fix
available from gdb's side, since fasmg emits no DWARF/CodeView at all, so a label is substituted for
its address out of the `.lst` before gdb sees the expression. `0FFh`, `1010b` and `$FF` are fasm
literals, not C ones, and are re-emitted in decimal. And gdb has no `dword` type: verified against
real gdb 16.3, `p *(dword*)$rsp` answers "No symbol table is loaded" — its error for an unknown type
name — while `p *(unsigned int*)$rsp` reads the memory. The README had been advertising the `dword`
form since debugging landed; it never worked, and now says `*(unsigned int*)$esp`.

The width is the one piece neither side can read off the operand alone, because x86 takes it from
the *other* operand: `mov eax, [x]` is a 4-byte read and `mov al, [x]` a 1-byte one, and reading
either at the wrong width reports a number that is not the one the instruction uses. So the editor
side, which can see the whole line, always spells the size out before sending it. Index registers
inside the brackets are excluded from that inference — the `rcx` in `[buf+rcx*4]` is part of the
address, not of the value's width.

Anything that cannot be translated with certainty is declined rather than guessed, and the word
fallback takes over unchanged — a bare register or label already resolved well through it, since the
adapter special-cases both. That covers a name the listing never recorded, an operand with no width
to be had (`cmp [x], 5`, which fasm rejects as ambiguous itself), and a size with no scalar to report
(`dqword` and wider). An explicit non-scalar size is declined outright rather than falling through to
inference, which would otherwise answer `mov eax, dqword [x]` with a 4-byte read and quietly overrule
the width the source wrote.

Typing `dword [rsp+8]` into the Watch panel now works too, which is the natural thing to write while
reading assembly.

### Converting a numeric literal between bases, as an edit

Hover has shown a literal in every other base for some time. Acting on it meant reading the value
off a tooltip and retyping it, so it is now offered as a refactor: hex, decimal, binary, octal, and
the character form for printable ASCII, skipping whichever base the literal is already written in.

`RefactorRewrite`, not `QuickFix` — nothing about a literal written in the "wrong" base is wrong; it
assembles to the same bytes either way. The server advertises the new kind, since a client that
filters by kind only offers what it was told about.

Hex is emitted as `0x1F` rather than `1Fh` purely to sidestep that form's leading-zero trap: a hex
literal beginning with a letter has to be written `0FFh`, because a token starting with a letter is a
name. Binary is emitted grouped (`1111_1111b`). A comment in `numericLiteral.ts` had claimed fasmg
rejects `_` inside a literal and that the grouping was display-only; assembling every generated form
against fasm2/fasmg g.kp60 and fasm1 1.73.32 says otherwise — all 34 round-trip to the right value on
both — so the comment was wrong and the grouping ships.

A literal is now also terminal for code actions, which fixes a latent oddity: a short one like `255`
could previously reach the misspelling quick fix and draw a lightbulb offering to "correct" it into
whatever similarly-spelled symbol happened to be in scope.

### Format on type, and arguments for Run

`editor.formatOnType` (off by default, so this is opt-in) now aligns each line the moment Enter
finishes it. Only ever the line just left, never the one being typed on — text moving under the
cursor mid-word is what makes on-type formatting hostile elsewhere, and it is avoidable here because
assembly is line-oriented. The whole document is still formatted to find that one line, for the same
reason range formatting does it: a line's indent depth is decided by every block opened above it.

`fasm2Studio.runArgs` gives `FASM: Run` and `FASM: Build and Run` the command line the debugger has
taken all along as `"args"` in `launch.json` — a program that reads argv could be debugged but not
simply run, which is the more common of the two.

That turned up a real bug in `quoteForShell`, which quoted only on whitespace or an embedded quote.
A path rarely contains anything else; an argument routinely does, and `*.txt` or `a;b` would have
been expanded and split by the shell instead of reaching the program as written. It now quotes
anything outside a conservative safe set, escapes what a POSIX shell still expands inside double
quotes, and renders an empty argument as an explicit empty word rather than letting it vanish and
shift every argument after it.

## 1.14.0

### Renaming a file no longer breaks every `include` that named it

The editor's own rename gesture was the one operation that could silently break a project. Nothing
in the source looks wrong afterwards — every `include` still reads as a plausible path — and the
first sign of trouble is the assembler failing on a file that is not there. fasm has no module
system to fall back on: a path in a string literal is the only thing tying two files together.

`features/includeRename.ts` computes the edits from the include graph the server already holds, and
treats both ends of an edge as one problem rather than two. Something else includes the moved file,
so its path has to follow; and the moved file's own relative includes are now resolved from a
different directory, so they have to change too. Formulating it as "for every include edge, where is
each end going to be?" is also what makes a rename that moves *both* ends — dragging two files into
a folder, or renaming the folder itself — come out with no edits at all, which handling the two
directions separately would not.

The client hooks `onWillRenameFiles`, not `onDidRenameFiles`, and both reasons are about asking
while the question still has an answer. The index describes where the files are *now*; after the
rename the watcher has begun retracting the old path, and "who includes this file?" starts coming
back empty for the very file being moved. And an edit returned from `waitUntil` is applied *before*
the rename, so a fragment carrying its own includes into a new directory is edited where it still is
and then moved with the correction already in it — which is why the edits are keyed by each file's
pre-rename uri.

Three things are deliberately left alone. An include that does not resolve today: there is no way to
tell which renamed file it was reaching for, and rewriting it would replace a broken line the user
can recognize with one they cannot. An include that resolves through `fasm2Studio.includePath`, when
its target is still under a search directory: those paths are written against that directory rather
than against the including file, so neither end moving invalidates them, and a `../../..` rewrite
would be a strictly worse line than the one already there. And the separator and quote character the
author used, both of which are put back as written — fasmg accepts `'` and `"`, and either path
separator on any host, so a Windows-authored `include 'api\kernel32.inc'` does not become the one
line in that file spelled the other way round.

A renamed *directory* arrives as a single rename of the folder, and no `include` resolves to a
folder, so `expandDirectoryRename` stats the old path (which still exists at this point) and expands
it into the fasm files inside via the same glob the workspace indexer uses.

`IncludeDirective` gained a `quote` field. The parser had been discarding which quote character was
used, and `range` covers the quotes as well as the path, so rewriting one meant re-emitting a quote
it could only have guessed at.

No workspace-trust gate: this reads the index and writes text into the user's own files. Nothing
here spawns the assembler, which is what trust exists to withhold.

`fasm2Studio.updateIncludesOnFileMove` picks between `prompt` (the default), `always` and `never`.
The prompt names how many paths in how many files would change, because it is shown for the moment
a rename is held open and is all the user has to judge an edit they are accepting sight unseen.

### Someone with no assembler installed is told so, once

Every other piece of extension state is reported in the status bar rather than in a popup, and for
good reason: a standing condition that a notification would re-announce on every keystroke belongs
somewhere it can be stated permanently and quietly. "There is no assembler on this machine at all"
is the exception, and it was getting the same silent treatment as everything else.

It is the first thing a new user hits and the only one they cannot act on from what they can see.
The status bar says "compiler not found", which reads as a setting to correct — but for someone who
has just installed this extension and has never installed flat assembler, nothing is misconfigured,
there is no path to fix, and the answer is to go and download something. Without a word about it,
the features that need a compiler simply do nothing, and the extension looks broken rather than
unequipped.

`missingCompilerNotice.ts` shows one notification, ever, offering the setup walkthrough and
`FASM: Select Compiler`. It leads with what still works, since an unequipped install is a perfectly
good reader of assembly and someone who only wanted highlighting should be able to dismiss it and
carry on.

It is raised from the status bar's own "compiler not found" branch rather than from activation, so
it cannot fire on a hunch: that point is reached only with an open fasm file, a trusted workspace,
and a finished search that found nothing. The flag is written to `globalState` *before* the user's
answer is awaited — a notification that is ignored or dismissed has still been shown, and "once"
must not quietly become "until you click something" — and it is latched synchronously per state
store as well, because two status bar renders in one tick would otherwise each raise one.

`globalState`, not workspace state: whether an assembler exists on `PATH` is a property of the
machine, and someone who has been told once does not need telling again in the next folder they
open.

## 1.13.0

### An unsaved buffer asked which project it belonged to

`isFasmDocument` classifies by language id, deliberately, so that a scratch buffer with the language
set to FASM still highlights and completes. Everything that spawns a compiler needs strictly more
than that, and nothing checked for it: an untitled document's `uri.fsPath` is its *label*
(`"Untitled-1"`), not a path.

That label went into `resolveEntryPointFsPath` as if it were a file. The server found nothing named
that, which is indistinguishable from a fragment no entry point reaches, so resolution fell through
to its last resort — `listEntryPoints` — and the user was shown the "which project is this for?"
quick pick, offering unrelated `.asm` files from elsewhere in the workspace as candidates for a
buffer that had never been written anywhere. No error, no timeout: Build silently became a prompt
about other people's files.

`buildableFsPath` now gates every path from an editor to a compiler, and offers `Save As…` rather
than only refusing. It uses `workspace.saveAs`, not `TextDocument.save()`, because saving an
untitled buffer replaces it with a *different* document backed by the chosen path — the original
stays untitled, and only the returned uri names where the contents actually landed.

`resolveDebugConfiguration` gets the same guard plus an `existsSync` check on the final `asmFile`,
which also catches the two ways a launch.json reaches the same state: `${file}` substituted while an
unsaved buffer is focused, and a hand-written relative path, which `Uri.file` resolves against the
filesystem root rather than the workspace.

### Run, Debug and Build above the `format` directive

The affordances for starting a build were a chord, a palette search, and a ▷ button that looks the
same in every language — none of which say *what* they will act on. That gap is wider here than
elsewhere: `include` graphs mean the file on screen is frequently not the file that gets assembled,
and the extension resolves that silently.

`codeLens.ts` anchors the three commands to the one line that identifies an entry point. Which files
those are comes from the server (`fasm2Studio/listEntryPoints`), not from a local scan for `format`
— a directive can arrive through an include, and a client-side regex would disagree with the entry
point the commands actually build. Each lens passes its own document's uri as an argument, so a lens
clicked in a split editor acts on the file it is drawn in rather than on whatever tab has focus.

Fragments get nothing. They build fine, through whichever entry point includes them, but an `.inc`
shared by four programs has no single answer to put in a label, and "Run" on a file that cannot run
standalone would misdescribe what happens. `fasm2Studio.codeLens` turns the whole thing off.

### The Run and Debug panel offers FASM without a launch.json

`FasmDebugConfigurationProvider` was registered for the `Initial` trigger kind only, which means its
two configurations existed solely as something to copy *into* a launch.json that had to be created
first. A workspace without one saw "create a launch.json file" and nothing else.

The pair now also registers for `Dynamic`, as `FasmDynamicDebugConfigurationProvider` — a separate,
resolve-less object rather than the same instance registered twice. VS Code documents that the
trigger kind applies only to `provideDebugConfigurations`, and that "registering a single provider
with resolve methods for different trigger kinds results in the same resolve methods called multiple
times". `resolveDebugConfiguration` is what assembles the program and opens the inferior terminal,
so sharing one object would have built every launch twice and stranded a terminal. A test asserts
the dynamic provider has no resolve methods, since that absence is the entire point.

Both now come from `debugConfigurations.ts`, which imports no language client — the reason the
dynamic provider can be exercised directly instead of only through a running extension host.

### Ctrl+Alt+R builds before it runs

`fasm2Studio.buildAndRun` is the ▷ button in the editor title bar and the first entry in the editor
context menu; it is what "run this" means here, and it had no keybinding at all. `Ctrl+Alt+R` was
bound to `fasm2Studio.run`, which executes the last build without assembling — the specialist of the
two, holding the shorter chord.

They swap: `Ctrl+Alt+R` builds and runs, `Ctrl+Alt+Shift+R` runs whatever was built last. **This
changes an existing binding**; rebind either in Keyboard Shortcuts.

### macOS integration tests were failing on a renamed binary, not on flaky extraction

Every `package-matrix (macos-latest)` run failed three times over with
`spawn .../Visual Studio Code.app/Contents/MacOS/Electron ENOENT`, which the workflow attributed to
`@vscode/test-electron`'s zip extraction dropping files and wrapped in a three-attempt retry.

The extraction was fine. VS Code 1.110 renamed the macOS bundle's main binary from `Electron` to the
product name, and 1.133 removed the compatibility symlink that had kept the old name resolving:
extracting the real 1.133.0 `darwin-arm64` archive yields a `Contents/MacOS/` holding exactly one
file, `Code`, with `CFBundleExecutable` to match. `@vscode/test-electron` 3.0.0 hardcodes the old
name, so every attempt spawned a path no current build ships and all three failed identically.

3.1.0 reads the name from the bundle's `Info.plist`. The declared floor moves to `^3.1.0` — the
range already permitted it, and `npm ci` was pinning 3.0.0 from the lockfile — and the retry loop is
gone, since it only ever converted a deterministic failure into three of them.

## 1.12.0

### Path completion inside `include '...'`

The include graph this whole server is built on was the one thing it could not help you type.
`documentLink.ts` made an existing include clickable and `codeActions.ts` would *write* one for a
symbol you had already used, but a path typed from scratch got nothing — `completionContext()`
knew only `statement` and `operand`, and the trigger characters were `.` and `#`.

`server/src/features/includePathCompletion.ts` resolves the directory exactly as
`Workspace.resolveIncludePath` (and fasmg itself) does: the including file's own directory first,
then each `fasm2Studio.includePath` entry. Offering a name the assembler would not then find would
be worse than offering nothing. A name present in two bases is offered once, for the base that wins.
Directories re-trigger the suggestion so a nested path completes in one pass; the text edit replaces
only the partial name, never the `sub/` already committed. Both separators count as a boundary,
since fasmg accepts either on any host.

`'`, `"`, `/` and `\` join the trigger characters, and the handler is what keeps them from becoming
noise: inside any *other* string literal completion now returns nothing at all (a mnemonic was never
a plausible completion for the contents of `db 'hello'`), and a path trigger typed outside a string
— a division, an apostrophe in a comment — returns nothing rather than the identifier list.

### "Did you mean" quick fixes

`codeActions.ts` had one fix, for a name that exists but is unreachable. The other thing that can be
wrong with an unresolved name is that it is misspelled, and the ~1600-entry keyword table holding
the right spelling was already in memory.

`features/spelling.ts` is a length-bounded Levenshtein with a row-minimum early exit; the candidate
pool is `staticKeywords(dialect, isa)` — newly exported from `completion.ts` so the two cannot drift
— unioned with every symbol reachable through the include graph. Three guards keep it quiet:

- **Exact membership is checked first**, which is also what keeps the cost off the common path: a
  correctly-spelled `mov` returns on a Set lookup rather than scanning the table.
- **Macro parameters count as known.** They are used like symbols but never defined as one, so every
  reference to a parameter inside its own macro body looks unresolvable. Without this, `mov dest,
  src` drew a lightbulb offering to "correct" a perfectly good parameter.
- **Distance scales with length**: one edit at three characters or more, two only from eight. `ax`
  and `al` are not typos of each other.

A pure case difference ranks as certain and suppresses the edit-distance runners-up entirely —
fasmg is case-sensitive where fasm1 is not, so `MOV` in a fasm2 file has exactly one right answer,
and listing `movd`/`movq` beside it would bury it.

Neither fix is bound to a compiler diagnostic, for a reason now stated correctly in that file's
header: diagnostics need a trusted workspace, a compiler that was found and a compile that
finished, so binding to one would withdraw the fix in exactly the cases where nothing else points at
the mistake.

### A lone fasm1 error now says that it is hiding the next one

fasm2 is run with `-e 200` and reports up to that many problems at once. fasm1 takes no such flag and
stops dead at its first error, so a file with three mistakes shows one, then one, then one, across
three edit-and-save cycles — which reads exactly like a linter that is slow or broken.

`noteFirstErrorOnly` attaches that fact as `relatedInformation`, and only when there is exactly one
error: a run that reported several plainly did not stop at the first, and the note would be false.
Warnings neither trigger it nor suppress it, since fasm1 carries on past those.

### The workspace scan reports progress, and failure

`indexWorkspace` was `void`ed with a `console.error` catch. Every cross-file feature answers from
that index, so a scan that failed left go-to-definition, find-references, rename and symbol search
quietly answering from a partial one — indistinguishable from those features being wrong.

The server now sends `fasm2Studio/workspaceIndexed` on completion (and on failure, with the reason);
without it a progress indicator would be meaningless, since sending the scan notification returns
the moment it is written. The client shows window progress for the real duration, and records the
outcome in the status bar (`index incomplete`, with what went wrong) rather than a console. When
that is the standing problem, the status bar menu promotes "Restart language server" — the one entry
that rebuilds it — to the front.

### Selection ranges and call hierarchy

`selectionRangeProvider`: token → operand → statement → line → each enclosing block → file. The
editor's own fallback grows by word, then by bracket pair, then by the whole document, which in
assembly means it jumps from `eax` to the file. Blocks come from the same matched-pair walk folding
uses (`END_KEYWORD_BLOCKS`/`DEDICATED_CLOSERS`/`labelPrefixLength` are now shared rather than copied),
but cover the closing line too: half a `macro` is not a construct. Bracket depth keeps the comma in
`[ebx + 4]` from splitting an operand, and steps identical to the one before them are dropped.

`callHierarchyProvider`: incoming and outgoing edges over labels and macros, with a routine's body
delimited by the next definition of the same rank — assembly has no closing brace, so that is what
makes "which routine is this reference inside" answerable. An edge is *any* reference, not one under
a `call`: restricting to a mnemonic list means picking one, and `call` alone misses every tail call
written as `jmp` while the full set of x86 conditional jumps is wrong for every other instruction
set fasmg can assemble. The cost is that a jump table's `dd handler` appears as an edge, which is
honest — that is how it is reached.

### FASM: Report Issue

Almost every bug worth reporting against this extension depends on facts only the reporter's machine
has: which of two byte-identical fasmg builds is on PATH, whether a preload is configured, which gdb,
which platform. Asking for those one round-trip at a time is how a bug report takes a week.

The command collects them — versions, resolved tool paths and where each came from, the settings
actually changed from their defaults, and any standing diagnostics/index problem — and opens the
result as a document. It is never sent anywhere on its own: it carries absolute paths from the
user's machine, so what leaves it is their decision, made while looking at what they would send. In
an untrusted workspace the version probes are skipped and say so, since spawning a binary named by
workspace settings is precisely what that mode forbids.

### Smaller

- `editor.defaultFormatter` is pinned for `[fasm]`. Several general-purpose assembly extensions also
  claim `.asm`, and with more than one formatter registered and no default named, Format Document
  stops to ask which one — every time — instead of formatting.
- `FASM: Debug` and `FASM: Clean Build Output` have keybindings, alongside the existing Build and
  Run. The manifest tests now assert every binding is scoped to a focused fasm editor, carries a mac
  chord, and does not collide with another.

## 1.11.0

### A missing debugger is now found before the launch, not from inside it

The assembler and the debugger were held to very different standards. A missing assembler gets a
status bar warning, a "Find a compiler" quick pick and a walkthrough step. A missing debugger got
`gdb error: spawn gdb ENOENT` written to the Debug Console — after a successful build, in a panel
that may not be focused, with nothing anywhere saying gdb is a separate install this extension
deliberately does not bundle.

`extension/src/gdbDiscovery.ts` resolves what a launch will actually spawn (the config's `gdbPath`,
the setting, then the platform default — `lldb-mi` on macOS) and checks it can be run at all. The
check runs in `resolveDebugConfiguration` *before* the build, so a missing debugger costs no compile,
no listing and no terminal. `FASM: Select Debugger` is the recovery path, shaped like the compiler's.

Presence is what's probed, not identity. `compilerDiscovery.ts` matches on a banner because `fasm2`
and `fasmg` are byte-identical and differ only in behaviour; nothing here has to tell two debuggers
apart, and a banner check would be actively *wrong* — the shell's own "gdb: command not found"
contains the very name a name-matching probe would search for. An explicit path is answered from the
filesystem; a bare name is spawned without a shell, where Node's ENOENT is the same PATH lookup the
adapter's own spawn performs. A probe that times out reports *present*: a slow filesystem is not
evidence of a missing debugger, and a spurious modal in front of a working setup is worse than the
silence it replaces.

### Reverse debugging

`supportsStepBack` — which is the one capability gating both Step Back and Reverse Continue — backed
by gdb's execution recording. You clobber a register, notice three instructions later, and step back
to see what it held. In assembly this answers a question a forward-only debugger cannot answer at all.

- **Opt-in** (`"reverseDebugging": true`). `record full` makes gdb single-step the program and
  journal every register and memory write; that is a fine trade for one investigation and a bad one
  for every other launch.
- **Announced by a `CapabilitiesEvent`, not in `initialize`.** Whether it works is not known that
  early: the launch arguments have not arrived, and lldb-mi has no execution recording at all. The
  Step Back button appears only once gdb has actually accepted the command, and a failure degrades to
  a message — the session still runs forwards, which is what every other feature needs.
- **Implies `stopOnEntry`.** Recording can only start while stopped, and it has to start before the
  code being investigated runs, which leaves the entry point as the only place it can begin.
- **The stop is subscribed to before `-exec-run`, not after.** gdb's `^running` and the `*stopped`
  that follows can arrive in a single read from the stream, so subscribing after the await can miss
  the very stop being waited for and leave recording permanently off. Restart re-establishes it the
  same way, since a restart takes the recorded history with the process.

Verified end to end against real gdb (`debug/test/reverse.e2e.test.ts`): stepping back over
`mov eax, 222` restores `eax` to 111.

### Inlay hints: the address and encoded size of every instruction

`fasm2Studio.inlayHints` annotates each line that produces machine code with where it lands and how
many bytes it encodes to — what you would otherwise build and read a `.lst` file to see by eye.

The data is a by-product of the compile live error checking already runs: one extra `-i` flag and one
file read, rather than a second pass. With hints off, nothing is added to the compile at all.

- `listingMap.ts` moved from `debug/` to `server/src/listing/` — it already imported the server's
  tokenizer, so the dependency direction was preserved and the server can now reach it.
- `parseListingFile` kept the byte dump it previously discarded. **A statement whose dump wraps has
  its continuation lines folded in:** a `format ELF64 executable` emits a 120-byte ELF header spread
  over sixteen listing lines, and counting only the first reported it as 8 — a wrong number, worse
  than none. Caught by the end-to-end test, not by inspection.
- **The listing lands at `<stem>.lst`, not `<output>.lst`.** `virtual as 'lst'` *replaces* the output
  file's extension. The debug build's `getListingPath` appends and is right to — the output it names
  has no extension, so the two coincide there. For a temp `foo.out` they do not, and the file was
  simply never found until a real compile proved it.
- Correlated against the tree actually compiled (the live shadow, when there is one), with candidates
  translated back to real paths so the map is keyed by paths the editor knows.

### Keybindings

`ctrl+alt+b` builds and `ctrl+alt+r` runs, scoped to a focused fasm editor. Deliberately only these
two: `Ctrl+F5` already reaches Build and Run through the `noDebug` branch, and `Ctrl+Shift+B` already
reaches the build task because it carries `TaskGroup.Build` — binding either again would have added a
second way to do what already worked.

### The program's terminal opened, showed an escaped shell script, and ran nothing

`holderCommand` handed the client a `/bin/sh -c 'tty > …; while [ -e … ]; do sleep 1; done'` to run
in the terminal. DAP's `runInTerminal` does not run a command vector: VS Code opens a terminal on the
user's own shell and *types* the vector into it, escaped for that shell. Two things go wrong with a
shell script in that position, and both were reported at once — a fish terminal showing a wall of
backslashes, and a program whose output never arrived:

- **A shell busy starting up discards what was typed at it.** readline and fish both switch the
  terminal to raw mode with `TCSAFLUSH`, which throws away input received before they were ready — so
  the command sits echoed on screen, never run, and the launch waits out its handshake timeout and
  falls back to the Debug Console. Reproduced by typing the command at a freshly spawned `fish -i`
  under a pty: echoed in full, never executed.
- **Every shell escapes it differently**, and the escaping is the client's, not ours.

The command run in the terminal is now the adapter's own binary, re-invoked as `--terminal-agent
<endpoint>` (`debug/src/terminalAgent.ts`): an argv of a path, a flag and an endpoint, with no
character in it any shell needs to quote. It reports the tty (`/proc/self/fd/0`, or `tty(1)` where
there is no `/proc`) and holds the terminal until the session ends.

- **The extension opens the terminal itself** (`extension/src/inferiorTerminal.ts`), with
  `createTerminal({ shellPath, shellArgs })` naming the agent directly — no shell is started at all,
  so there is nothing to escape for and nothing to race. The endpoint is passed to the session as a
  new `terminalEndpoint` launch attribute; `runInTerminal` remains for other DAP clients and for
  `externalTerminal`.
- **The handshake is a socket, not a temp file.** A unix socket (named pipe on Windows) carries
  liveness the file never did: the agent's connection drops when the adapter exits *for any reason*,
  including a crash, so `HOLDER_MAX_SECONDS`' 12-hour cap on an orphaned `sleep` loop is gone. A
  terminal closed under a waiting launch now ends the wait immediately instead of timing out.
- **The agent waits for a keypress before exiting**, because an extension-owned terminal closes with
  its process, and a program that printed its answer and finished deserves better than the answer
  vanishing. It never reads stdin while the session is live — the program is reading that same tty.

Covered by an e2e test per route (real `adapter.js`, real gdb, real pty) and a real-VS-Code test that
launches a session and asserts the fallback to the Debug Console never fires.

## 1.10.0

### Errors are reported in the file that holds them

`runDiagnostics` filtered the compiler's output down to the document being edited and collapsed
everything else into a single `toolError` string, which the client showed as a status-bar
"diagnostics unavailable". For an include tree — which is what a fasm project is — that meant the
common case had no squiggle anywhere: the file with the mistake was never marked, and the file being
edited looked clean.

- `CompileResult` gained `foreignDiagnostics`, a map of absolute path to `Diagnostic[]`, and the
  server publishes each entry against that file's own URI.
- **Compiler paths are translated back through the shadow tree.** Diagnostics compile a live buffer
  from a positional copy under `/tmp` (`liveShadow.ts`), so every location the compiler prints for an
  included file names a directory about to be deleted. `LiveShadowRoot` now exposes `toRealPath`,
  which swaps the shadow root prefix for the real one; without it the published URIs pointed at
  temp files.
- **A file must exist *and* be inside a workspace folder to be marked up.** Existence rules out the
  path in `include 'does/not/exist.inc'`. The workspace check rules out the assembler's own library:
  a single missing include leaves a package macro holding an impossible value, and fasmg reports
  that consequence against `<fasm2>/include/format/elfexe.inc` — a file the user cannot fix.
  Anything failing either test still goes to the `toolError` summary, so the invariant that a
  failing build never looks clean is unchanged.
- **Retraction is ownership-tracked.** A file nobody has open has no event that would ever clear its
  diagnostics, so `foreignDiagnosticOwners` records who published what; a mark is retracted only
  when no other open document still reports it, and open documents are skipped entirely since each
  compiles the project itself.

### Numeric literal hover

Hovering a numeric literal converts it — decimal, hex, bit pattern grouped into nibbles, the signed
reading when the value's sign bit is set for its narrowest machine width, and the ASCII character
for a printable byte. The base the literal is already written in is omitted.

The accepted grammar is fasmg's own `convert_number` (`source/expressions.inc`), cross-checked by
assembling every form against fasm2/fasmg g.kp60 and fasm1 1.73.32:

- Two prefixes only, `$` and `0x`. The `0x` test is `cmp word [edx],'0x'` — a two-byte literal
  compare — so it is case-sensitive: `0X1F` is not a number.
- Bases otherwise come from a trailing `h`/`b`/`o`/`q`/`d`, folded case-insensitively.
- **`0b1010` and `0o17` are not binary and octal.** There is no `0b`/`0o` prefix in that routine, so
  they reach the decimal path and are rejected for the embedded letter. Reading them the C way would
  have reported a value for source that does not assemble.
- `_` and `'` are digit separators in every base.

### Run Without Debugging actually ran the debugger

`noDebug` was handled nowhere, so Ctrl+F5 on a fasm file started gdb and stopped the program on its
first instruction. `resolveDebugConfiguration` now builds, runs it in a terminal, and returns
`undefined` to cancel the session. Checked before the fasm2-only dialect gate, since fasm1 builds and
runs perfectly well and only *debugging* is fasm2-only.

### Run and Debug disagreed about the working directory

`runOutputBinary` created its terminal with no `cwd`, inheriting the workspace root, while a debug
launch defaults `cwd` to the source file's directory — so a program opening a relative data file
worked under F5 and failed under Run. Both now use the source directory. A terminal's cwd is fixed at
creation, so a leftover `FASM` terminal rooted elsewhere is replaced rather than reused.

### Debug Console completion

`supportsCompletionsRequest`, answered from gdb's own `-complete`. The console is a raw gdb command
line, which is only usable if you already know gdb's command set; the completions come from the gdb
actually in use rather than a list baked into the adapter. Failure — an older gdb, or lldb-mi, which
never had `-complete` — yields an empty list rather than an error on a keystroke.

### Also

- `onTaskType:fasm` activation, so a `tasks.json` with `"type": "fasm"` resolves before any `.asm`
  tab has been opened.

## 1.9.0

### Attach: debugging a program you did not start

The adapter was launch-only, so the debugger had nothing to say about the two situations an
assembly program most often puts you in — a process already running somewhere else, and a fault
that already happened. An `attach` request now covers both.

- **A live process.** `-target-attach <pid>` stops it and gdb reports that stop as its own
  `*stopped` record, so it arrives through the existing `onStopped` path with no special handling;
  from there every launch-path feature (breakpoints, stepping, memory, watchpoints) applies
  unchanged. `processId` accepts a string as well as a number, because a `${command:...}` picker
  substitution produces one.
- **A core dump.** `-target-select core <file>` answers `^connected` and — verified against real
  gdb — emits *no* `*stopped` record at all, so the adapter synthesizes one; without it the session
  sits at "attached" showing no frame, no registers and no source line, which is the entire content
  of a post-mortem session. The signal is recovered from gdb's console stream
  (`Program terminated with signal SIGSEGV, Segmentation fault.`), since there is no
  signal-name/signal-meaning field the way a live stop has, and it feeds the same `exceptionInfo`
  path that makes a live fault read as `SIGSEGV (Segmentation fault)`.
- **A core is never resumable**, and says so in those terms. Left to gdb, continue/step/pause on a
  core answer "The program is not being run", which describes a program that failed to start and
  sends the reader looking for a launch problem that does not exist.
- **Ending the session leaves an attached process running**, per the protocol's own default —
  you attached to something you did not start, possibly long-running, and closing a debugger is not
  a request to end it. Both directions have to be explicit: quitting gdb while attached *always*
  detaches, so `terminateDebuggee` kills through the console `kill` command with confirm off. gdb
  has no MI command for that — `-exec-abort` answers "Undefined MI command" — which only a real
  session tells you; the end-to-end test is what pinned it down.
- **Restart is withdrawn on attach** via a capabilities event. Capabilities are answered at
  `initialize`, before anything knows which request is coming, and `-exec-run` against an attached
  target starts a fresh copy of the binary while leaving the process being debugged untouched.
  `restartRequest` refuses as a backstop for a client that asks anyway.
- **The listing is never rebuilt for an attach.** It has to describe the binary that is already
  running, and a rebuild from since-edited source maps addresses onto lines they never belonged to —
  a debugger confidently pointing at the wrong place. A missing listing prompts, stating that
  assumption, instead of silently rebuilding or dead-ending.
- `${command:fasm2Studio.pickProcess}` lists processes (`ps` / `tasklist`), most recently started
  first — pids ascend, so the program you just started is nearly always the highest, rather than
  something to scroll a few hundred system daemons to find.
- Verified end to end on Linux against real gdb and real fasm2 binaries
  (`debug/test/attach.e2e.test.ts`): attaching to a running process maps its PC to a source line and
  steps; disconnect leaves it alive; `terminateDebuggee` kills it; a core dump reports SIGSEGV,
  resolves the faulting instruction to its line, reads back the frozen registers, and refuses to
  continue. Two details the fixtures exist for — the spin program sets `PR_SET_PTRACER_ANY` on
  itself, since yama's `ptrace_scope` is 1 on most distributions and gdb here is a sibling rather
  than an ancestor, so without it the test would only ever exercise the refusal path; and the core
  is produced by driving gdb (`run` + `generate-core-file`) rather than by faulting and hoping,
  since `core_pattern` routes cores to systemd-coredump on most modern systems. The "process is
  gone" assertions watch the child's own exit event rather than probing with `kill(pid, 0)`, which
  answers "still there" for a zombie and would have passed a debuggee that was never killed.

### "Compiler not found" is no longer a dead end

Every entry in `FASM: Select Compiler` opened a file dialog, so the one user guaranteed to arrive
there — the status bar says "compiler not found" because they have never installed an assembler —
was sent to browse a filesystem with nothing on it. There was not a single URL anywhere in
`extension/src` or the walkthrough media.

- Two entries added: where to get one (the setup walkthrough, falling back to the download page if
  it cannot be opened), and "Look again", which drops the session-long detection cache. That cache
  is why installing an assembler in another window and coming back still reported "not found", with
  the only recoveries being a language server restart or a window reload.
- Ordered like the status bar menu, on the same principle: with nothing installed those two lead,
  since browsing cannot help; with a working install they go last. The prompt changes too — asking
  someone who has no assembler which executable they want to point at is a question they cannot
  answer.
- `flatassembler.net/download.php` is now linked from the walkthrough step and both READMEs, rather
  than named as unlinked text in one step description.

### Added

- **`FASM: New File` appears in File > New File...**, populated from `contributes.menus`. It was
  reachable only from the command palette, which is not where VS Code teaches people to create a
  file — and that command exists specifically for someone who has no source file yet. Given a
  `shortTitle`, since that picker renders one and a bare "New File" is indistinguishable from the
  built-in entry beside it.
- `extensionKind: ["workspace"]`. VS Code infers a kind when none is declared; stating it keeps a
  UI-side host from ever being chosen for an extension whose every feature spawns a process against
  files on disk.
- The `Formatters` marketplace category, which a shipped Format Document had never claimed.

### Internal

- `launchRequest`'s setup is extracted to `startTarget`, shared with `attachRequest` — the address
  map, the driver wiring, the register-name lookup and the Intel disassembly flavour are identical
  either way, and what differs is only how the target starts existing.
- `processList.ts` and `attachTarget.ts` hold the parsing and validation for the above, importing
  nothing from `vscode`/the adapter respectively so both can be asserted directly. The extension's
  own integration suite caught the first attempt at this: it loads the esbuild output, and a
  contributed command that is never registered fails a test written for exactly that.

## 1.8.0

### The debugged program gets a terminal

Its output went to the Debug Console as DAP output events, and the Debug Console has no stdin to
offer. A program blocked in a `read` syscall therefore sat there with nothing to say why, and
"read a value, print it back" is most of what anyone writes while learning assembly.

A `console` launch attribute now chooses where the program's own input and output live —
`integratedTerminal` (the new default), `externalTerminal`, or `debugConsole` for the old
behaviour. The terminal is a real one: the adapter sends DAP's `runInTerminal` reverse request, the
client opens a terminal and runs a holder command in it, that command reports its tty back through
a temp file, and gdb's `-inferior-tty-set` points the inferior's stdin/stdout/stderr at the same
tty. From then on the program talks to the terminal directly and the adapter is not in the middle.

- The holder exits by itself when the adapter deletes the handshake file at the end of the session,
  rather than being killed: killing it would close an integrated terminal panel and take the
  program's output with it. It also gives up after 12 hours, so an adapter that dies without
  cleaning up cannot leave an `sh` sleeping until the machine is rebooted.
- Every failure degrades to the Debug Console and says why — a client that never declared
  `supportsRunInTerminalRequest`, a client that refuses the request, a terminal that never reports a
  tty, a gdb that rejects the command. The program still runs; only its input stops working.
- The handshake is started during `launch` but awaited in `configurationDone`, immediately before
  `-exec-run`. Awaiting it inside `launchRequest` delays the launch response by however long the
  client takes to open a terminal — seconds, since it is a real UI action — and a launch response
  that lands after the first `stopped` event is one VS Code silently drops. That is the same
  regression the register-name lookup in `launchRequest` is deliberately written to avoid; it was
  caught here by the extension's own real-VS-Code debug tests, which timed out waiting for a session
  that had already stopped.
- Windows has no pty to hand to gdb, so a terminal setting there issues `-gdb-set new-console on`
  instead, giving the program its own console window. Best-effort and unverified, like the rest of
  the Windows debug path.
- Verified end to end on Linux: `debug/test/inferiorTerminal.e2e.test.ts` runs the real adapter
  against real gdb and a real fasm2 binary, plays the client's half of `runInTerminal` with
  util-linux's `script` (whose entire job is running a command under a pty), types a line at the
  program, and asserts the program's answer comes back on the terminal and *not* through the Debug
  Console. The test program prefixes its output with `got: ` precisely because a pty echoes what is
  typed at it, so asserting on the input text alone would pass without the program ever running.

### Added

- `FASM: New File` writes a hello world that already builds and runs — ELF64 for Linux, PE64 for
  Windows, ordered with the running platform first. The walkthrough's "build and run" step told the
  user to open a `.asm` file and press play, which assumes they have one; someone installing this to
  learn fasm has neither the file nor the boilerplate. Both templates are laid out to the
  formatter's own default columns, so Format Document on a fresh file is a no-op, and both are
  checked by assembling them with the real compiler rather than by inspection — a starter program
  that does not build is worse than none, since the reader has no way to tell their setup from our
  typo.
- `FASM: Clean Build Output` removes the binary and the `.lst` listing a build wrote, resolved
  through the same entry-point logic as Build so cleaning an included fragment cleans the program it
  belongs to. Deletion goes through the trash: these are derived files, but `buildOutputPath` is
  user-configurable and a mistyped one should be recoverable.
- `FASM: Show Language Server Log` opens the client's output channel. `fasm2Studio.trace.server` was
  added in 1.7.0 so bug reports could carry a protocol trace, but reading it still meant knowing to
  open the Output panel and pick the right entry from a dropdown.
- Clicking the status bar item opens a menu instead of jumping straight to the compiler picker. It
  displays the dialect as well as the compiler, and `FASM: Select Dialect` — the setting most likely
  to be wrong, since a fasm1 project is not auto-detectable by design — was reachable only from the
  command palette. The menu leads with whatever is currently broken: a missing compiler first, then
  live error checking that has stopped running, otherwise the dialect. It also carries an in-place
  toggle for `diagnosticsEnabled`, the log, and the server restart.

### Fixed

- Build tasks are in the Build group. `taskProvider` never set `task.group`, which filed both
  contributed tasks under "other tasks": Ctrl+Shift+B offered them only behind an extra "no build
  task is configured" step, and "Configure Default Build Task" could not pin one.
- The explorer context menu offers Build and Run, Debug and Clean, not just Build — right-clicking a
  `.asm` file to run it is at least as natural a gesture as right-clicking it to assemble it.

### Tests

- `npm run test --workspace extension` now runs the unit suite as well as the integration one. The
  manifest tests added in 1.7.0 lived under `test/unit`, which only `test:unit` ran and nothing in
  CI called — so they had never actually run on a pull request.
- A new integration test asserts every command in `contributes.commands` is registered by the
  running extension. The manifest declares them and `extension.ts` registers them with nothing
  connecting the two, so a command contributed but never registered reaches the user as "command not
  found" from the palette entry the manifest put there.
- The raw-DAP client the end-to-end debug tests are built on moved into `debug/test/dapClient.ts`.
  It was copied into two suites, which had already drifted apart in small ways, and the terminal
  test needed a third copy — plus reverse-request handling, which is what makes a `runInTerminal`
  test possible at all.

## 1.7.0

### Fixed

- The extension activates on a debug launch, not only on opening a `.asm` file. `activationEvents`
  listed `onLanguage:fasm` alone, on the assumption that `contributes.debuggers` generates its own
  implicit activation event the way `contributes.taskDefinitions` does. It does not — VS Code
  registers an `activationEventsGenerator` for task definitions, languages, commands and a dozen
  other contribution points, and none for debuggers, while `activateDebuggers` fires only
  `onDebug`, `onDebugResolve` and `onDebugResolve:<type>`. So F5 against a `launch.json` entry did
  nothing at all in a window where no fasm file had been opened yet: the adapter descriptor factory
  is registered during activation, and activation never happened. Now declared as
  `onDebugResolve:fasm`, with a manifest test that derives the expectation from the debugger
  contributions themselves.
- A breakpoint on a line that produces no machine code lands on the next line that does, instead of
  reporting itself unverified and doing nothing. Comments, blank lines, bare labels, `include`
  directives and everything in a data section have no listing entry, and they are the majority of
  lines in a real source file — including, routinely, the line a user clicks when they mean the
  instruction below it. `AddressLineMap` now carries a sorted per-file index of the lines that did
  produce code, `nextMappedLineAtOrAfter` binary-searches it, and the adjusted line travels back in
  the `setBreakpoints` response, which is what moves the marker in the gutter rather than leaving it
  silently somewhere else. The adapter also declares `supportsBreakpointLocationsRequest` and
  answers it from the same index, so the inline gutter affordances only offer lines that can hold a
  breakpoint in the first place. Sliding stops at the end of the file rather than wrapping, and
  never crosses into another file, where a line number means something else entirely.
- `fasm2Studio.trace.server` is contributed. `vscode-languageclient` reads `<clientId>.trace.server`
  regardless, but an undeclared setting does not appear in the settings UI and is marked "Unknown
  Configuration Setting" when typed into `settings.json` — leaving no way to capture a protocol
  trace for a bug report about hover, completion, navigation or diagnostics.
- The integration suite's document-link assertion compares paths rather than strings. The two sides
  disagree about drive-letter case on Windows and only there: `os.tmpdir()` yields `C:\…`, while
  anything round-tripped through a `file:` URI — every path the language server returns, since LSP
  speaks URIs — comes back from `Uri.fsPath` as `c:\…`. Only the drive letter is folded, so a
  genuine mismatch still prints readably.
- That suite's `after` hook no longer hangs. The formatting test applies a `WorkspaceEdit` and never
  saves it, so `closeAllEditors` met a dirty editor and put up a modal "save your changes?" that
  nothing in a test host answers; the run stalled to its timeout and the temp directory was never
  removed. It saves first, and a cleanup failure is now warned about rather than thrown, since
  mocha attributes a throw there to the suite and buries whichever assertion actually failed.

### Workspace trust

`untrustedWorkspaces.supported` was `false`, which disables the extension outright — no
highlighting, no hover, no completion, no navigation — on any folder the user has not trusted. That
is the wrong trade for this extension in particular, where "clone an unfamiliar asm project and read
it" is a large share of why it gets installed, and where none of those features run anything.

It is now `"limited"`, with two guards in place of the blanket refusal:

- `restrictedConfigurations` lists `fasm2CompilerPath`, `fasm1CompilerPath`, `gdbPath`,
  `fasm2Preload` and `includePath`, so VS Code ignores the workspace's own values for every setting
  that resolves to a program path or feeds one. A cloned repository cannot choose what would be
  executed.
- That alone only governs *which* binary would run, not whether one runs at all, so everything that
  spawns a process is gated on trust as well: diagnostics in the server, and Build/Run/Debug in the
  client. Debug is gated in `resolveDebugConfiguration` rather than in the `FASM: Debug` command,
  since that is the only point every launch passes through.

Trust is not a setting, so it cannot ride the configuration sync: the client sends it in
`initializationOptions` and pushes a `fasm2Studio/workspaceTrust` notification if it is granted
later, on which the server runs the first diagnostics for every open document. Granting trust
restores everything without a window reload. The status bar states the condition and links to
workspace trust, rather than showing the generic "diagnostics unavailable — click to change the
compiler", which would send the user to fix something that is not broken.

## 1.6.0

### Fixed

- The status bar refreshes when anything it displays changes. It only ever listened for the active
  editor changing, so after `FASM: Select Compiler` it kept naming the *previous* compiler, after
  `FASM: Select Dialect` the previous dialect, and while typing the very marker that flips a file's
  detected dialect (`end macro`, `namespace`, `iterate`) it kept reporting the pre-edit answer —
  until you happened to switch tabs. It now also re-detects from the live buffer rather than from
  what is last saved to disk.
- Diagnostics that cannot run now say so. A compiler that failed to spawn, or timed out on a large
  project, cleared the document's diagnostics silently — on screen that is indistinguishable from
  "your code is fine". The status bar states the condition, once, rather than as a notification that
  returns on every keystroke.
- `FASM: Run` on a file that was never built explains that, and offers to build, instead of sending
  an absolute path to the shell and surfacing its "no such file or directory".
- Build/Run/Debug invoked from the explorer act on the file that was right-clicked. The commands
  read the active editor and ignored the resource argument a menu passes them.

### Settings are now per folder

Every setting was `window`-scoped, so folder-level values were silently ignored: a workspace holding
a fasm1 project and a fasm2 project got one dialect for both, and whichever folder lost reported
errors across code that assembles perfectly. `defaultDialect`, `includePath`, `fasm2Preload`,
`buildOutputPath`, the diagnostics settings and the new formatter settings are now `resource`-scoped,
and the executable paths `machine-overridable`.

The client passes the file it is acting on behalf of to every configuration read, and the server
resolves settings through `workspace/configuration` per workspace folder, falling back to the pushed
window-wide value. `FASM: Select Dialect` writes to the specific folder's settings in a multi-root
workspace instead of the shared `.code-workspace`. The workspace index takes the union of every
folder's include paths, since an index answers across folders at once.

### New editor features

- **Document highlight** for the symbol under the cursor. A macro-`local` name highlights only
  within the macro that declares it, not every same-named local in the file.
- **Folding ranges** computed with a stack over real tokens, replacing the line-local
  `folding.markers` regexes: nested `macro`/`if`/`while` pairs now match their own terminators, a
  block keyword inside a string or comment opens nothing, an unclosed block does not fold to
  end-of-file, and `;region`/`;endregion` and runs of comment lines fold too.
- **Document links** on `include` paths. Only offered when the path resolves, which makes their
  absence the diagnostic for the most common fasmg setup failure.
- **A quick fix that inserts a missing `include`** for a symbol defined elsewhere in the workspace
  but unreachable from this file. The insertion point is after the last existing include, else after
  the header directives.
- **Format Document / Format Selection.** Aligns labels, mnemonics, operands and trailing comments
  into columns and indents block bodies. Structural keywords stay at the margin, so `struct` is not
  laid out to the right of its own fields' labels. Driven by the tokenizer, so a `;` inside a string
  is not a comment; a line it cannot confidently parse is returned verbatim; colon-less data labels
  (`msg db 'hi',0`) and `NAME = value` are recognized as labels rather than mnemonics. It never
  reorders, inserts or rewrites a token, and it preserves the file's existing line endings.
- Completion declares `resolveProvider` and ships the ~1600-entry static tables without their
  documentation strings, filling each in only for the row the client highlights. Items are ranked by
  cursor context (statement vs operand position) via `sortText`; nothing is filtered, since a wrong
  guess would hide the one item that was wanted.

### Debug adapter

- Conditional, hit-count and log-point breakpoints. Conditions pass to gdb's `-break-insert -c`;
  hit counts map to `-break-after`. Log points are handled in the adapter rather than via `dprintf`,
  because a DAP log message interpolates `{expression}` in the debugger's own expression syntax,
  which has no faithful translation to a printf format string.
- Function breakpoints on a label name, resolved through the listing-derived symbol map, since fasm
  emits no symbol table for gdb to consult.
- Instruction breakpoints, so the breakpoint gutter in the disassembly view works.
- Data breakpoints (gdb watchpoints), plus `memoryReference` on data-label rows, which is what makes
  "Break on Value Change" and "View Binary Data" reachable at all.
- `readMemory`/`writeMemory` behind VS Code's hex editor.
- `gotoTargets`/`goto` (set next statement) and `restart` in place, which keeps every breakpoint and
  watchpoint instead of tearing the session down.
- Signals are named. `signal-name`/`signal-meaning` were parsed and discarded, so every fault
  surfaced as the bare word "exception"; a null dereference now reads as `SIGSEGV (Segmentation
  fault)`, with `exceptionInfo` behind it. Watchpoint stops report as `data breakpoint` rather than
  falling through to the generic `pause`.
- `args` and `env` in the launch configuration.

### Manifest

- `contributes.menus`: Build/Run/Debug on the editor title bar, the editor context menu and the
  explorer context menu.
- A four-step `contributes.walkthroughs` for the toolchain setup this extension cannot bundle.
- `capabilities.untrustedWorkspaces` (unsupported: the assembler and gdb paths come from workspace
  settings) and `virtualWorkspaces`.
- `fasm2Studio.restartLanguageServer`, and 14 more snippets (ELF32/PE32 skeletons, Linux syscall
  stubs, `proc`/`endp`, `namespace`, `iterate`, `match`, `calminstruction`, and others).
- A terminal link provider makes fasm's `file.asm [12]:` headers clickable in any terminal.

## 1.5.0

- Semantic tokens now cover *references*, not just definitions. The grammar can scope `start:`, but
  `jmp start`, `dd table` and `mov ecx, BUF_SIZE` are identifiers in operand position to it, and
  whether each one names a label, a constant, a struct or nothing at all is a question about the
  whole include graph. It was by far the largest hole: measured across real x86 and non-x86 sources
  ranging from 300 to 4500 lines, with the actual vscode-textmate engine and the theme's own colour
  resolution, unscoped `source.fasm` was consistently the single biggest block of text in a file —
  half of all non-whitespace characters in the worst case. The provider now indexes the graph's
  labels, constants, structs, qualified struct fields and confirmed struct instances alongside the
  macros and elements it already collected, and emits `function`, `variable`+`readonly`, `struct`
  and `property` for them.

  Share of characters left at (or visually indistinguishable from) the editor's default foreground,
  under the built-in dark theme: 24–59 % before, 7–23 % after, and 13 % on the largest sample once
  its include directory is configured. A theme that paints the whole `variable` family in the
  body-text colour — a common choice — sees less of the gain on constants, which is what the
  README's new customization section is for. `tools/measure-color-coverage.ts` is the harness, kept
  out of the test suite because it measures against source trees outside this repo.

- Scoping follows the compiler's own rules rather than spelling alone. A `.local` label is coloured
  only under the global label it was declared beneath (and in its qualified `parent.local` form),
  a name declared `local` in a macro body is coloured only inside that body — the `local neg` case
  from fasmg's own `macro/if.inc`, which the mnemonic table used to shadow — and matching is
  case-sensitive for user symbols while staying case-blind for mnemonics and registers, since
  folding label names would light up every `start` because something in the graph defines `Start`.
  A qualified `Point.x` arrives as one token (the tokenizer treats `.` as an identifier character)
  and leaves as two, so the type and the field are coloured separately.

- Instruction-like names are still gated on statement position; labels, constants, structs and
  fields deliberately are not, operand position being exactly where they are normally written.

- Fixed mnemonics rendering in the *directive* colour under the default dark themes. With no
  `semanticTokenScopes` contribution, VS Code falls back to its own probe table, where
  `keyword.defaultLibrary` resolves through `keyword.control` — purple in Dark+, contradicting the
  blue the grammar gives the same word. The manifest now maps every emitted type onto this
  grammar's own scopes, with a standard scope last as the fallback. Since resolution stops at the
  first probe the theme styles, this also means one `editor.tokenColorCustomizations` entry
  recolours the grammar layer and the semantic layer together.

- Semantic highlighting is now on by default for `fasm` files only, via `configurationDefaults`.
  Roughly half of published themes never set `semanticHighlighting: true` — including one of the
  two measured above — and were silently discarding everything the server computed. This does not
  reintroduce a bundled theme: it turns a feature on for one language and paints exclusively with
  the user's own theme colours, and is overridable like any other default.

- Rescoped the grammar where the previous name was one no mainstream theme styles, or one that put
  two unrelated things in the same colour. Labels move from `entity.name.label` (which Dark+ paints
  `#C8C8C8` against a `#D4D4D4` default foreground — a distance of 20.8, i.e. no distinction at all)
  to the `entity.name.function` family, which is also what a label behaves like. Word operators
  split off as `keyword.operator.expression`, the scope the default themes single out, leaving the
  punctuation operators where they were. Struct names become `entity.name.type.struct` and macro
  names `entity.name.function.macro`, matching what VS Code's `struct` and `macro` token types
  probe. Struct fields become `variable.other.property`, matching the `property` type. `format`
  arguments become `constant.language`, which is what PE/ELF64/GUI are. CALM commands move to
  `keyword.control.calm`, since sharing `keyword.other` with mnemonics made them look like the one
  thing they are not. Size specifiers become `support.type.size`/`support.type.addressing`: unlike
  `db`/`dq` they are not core fasmg but come from the instruction-set package (`8086.inc`'s own
  `define x86.byte? :1`), the same category as `proc`/`invoke`, already scoped `support.*` here.

- Added a grammar rule for a whitespace-separated `.name` operand. `#member-access` deliberately
  requires no space before the dot, so that `PLANE_POINTER.offset` is told apart from a local-label
  reference — which meant every `jmp .exit` fell through completely unscoped.

- Semantic-token requests cost 0.65 ms on a 341-line file, 4.45 ms on a 1700-line one with its real
  include graph, and 7.33 ms on a 4500-line file whose graph spans 129 documents.

## 1.4.1

- Fixed signature help popping open where no call is being written — most visibly on
  `test rax, rax          ; ...`, where typing the alignment padding or the comment brought the
  box back on an operand list already finished, with the comment's own comma advancing the
  highlight onto a parameter the cursor was nowhere near. Space is one of the trigger characters
  (it has to be: it is what follows a mnemonic), and the handler read only the line's first
  identifier, so any space anywhere on the line re-answered for that mnemonic. Two gates now
  apply: everything from a `;` on is prose, and whitespace after an argument the user has finished
  is not the start of the next one, fasmg separating arguments with commas. Neither closes the box
  while the argument is still being written — inside an unclosed `(`/`[`/`<`/quote, or after a
  dangling operator (`dd 1 + `), the cursor has not left the argument.

## 1.4.0

- Removed the two bundled color themes. A language extension has no business deciding what the
  whole editor looks like, and "FASM2 Studio Dark"/"Light" were full workbench themes: selecting
  one to see FASM colours replaced everything else too, and the theme picker has no "none" entry to
  get back with. They were never needed for the highlighting to work — the grammar emits standard
  TextMate scopes and the server emits standard semantic token types (`keyword`, `variable`,
  `macro`, `defaultLibrary`) precisely so any theme colours FASM correctly. Semantic highlighting
  still requires a theme that opts in, which VS Code's built-in themes and most popular ones do.

## 1.3.0

- Added **FASM: Select Dialect**. Telling the extension which assembler a project is written for
  used to mean knowing that `defaultDialect` exists and editing settings by hand. The command
  writes it at workspace scope, which is what makes VS Code create the project's
  `.vscode/settings.json`, so the choice is recorded in the project and travels with it.
- **FASM: Select Compiler** no longer looks like it selects the dialect. Its first step picks which
  of the two compiler-path settings to write, but asked "Which dialect are you configuring a
  compiler path for?", which is close enough to "which dialect is this project?" to be read as it.
  It now asks about executables, shows what each dialect currently resolves to, names the setting
  each choice writes, and points at Select Dialect for the question it does not answer.
- Fixed the command palette showing every command twice over — "FASM: FASM: Build" and so on. Each
  command repeated its own category inside its title, and VS Code renders a command as
  "category: title". The launch.json "Add Configuration..." dropdown had the same fault, from the
  debugger label being repeated in a snippet label.

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
  reach the Marketplace listing, which had been stale since 0.19.0 and so never showed thirteen
  releases' worth of changes.
- Fixed two compiler-discovery tests that depended on the machine running them. Discovery probes a
  few well-known install directories by absolute path — for editors launched from a desktop
  environment, whose PATH lacks what an interactive shell's rc file adds — so overriding PATH alone
  never isolated the tests, and "no compiler found" silently assumed fasm was not installed in the
  very location this project recommends. The preload integration test also locates fasm2's bundled
  `include` directory from wherever `fasm2` resolves to instead of skipping without an environment
  variable, so the full suite now runs with nothing skipped.

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
