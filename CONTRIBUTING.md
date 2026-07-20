# Contributing to FASM2 Studio

Thanks for looking at this. The short version: fork the repo, make your change on a branch, make
sure it's tested, open a pull request that explains what problem you're solving and why your
approach solves it. The rest of this document is detail on how to do that well in this particular
codebase.

## Before you write any code

If you're fixing a bug, open an issue first only if you're not also opening the PR — if you're
sending a fix right away, the PR description can carry all the context and a separate issue is
just overhead. If you're proposing something bigger (a new command, a new language feature, a
change to how the debugger or the indexer works), open an issue first. Some of these have real
tradeoffs baked in — the debugger's `-i`-injected listing approach, the decision to scope
completion/hover to a file's `include` graph rather than the whole workspace, fasm1 not being
supported by the debugger — and it's better to find out before you've written five hundred lines
that the maintainers see it differently than to find out in review.

For small, obviously-correct fixes (typo in a message, off-by-one in a range, a missing null
check), just send the PR.

## Setting up

```sh
npm install
npm run build       # bundles server/, debug/, and extension/ with esbuild
npm run typecheck
npm run lint
```

To try your change in a real VS Code window: `npm run build`, then in `extension/`, `F5` from
VS Code (or `code --extensionDevelopmentPath=<repo>/extension`) launches an Extension Development
Host with your build loaded.

## Where things live

- `server/` is the language server. It's a lightweight, hand-written tokenizer and symbol index —
  not a real assembler — that backs completion, hover, go-to-definition, references, rename, and
  workspace symbols. `server/src/features/diagnostics.ts` is the exception: it shells out to the
  real `fasm2`/`fasm1` compiler and parses its actual output, rather than reimplementing fasm's
  error checking.
- `debug/` is the debug adapter. `debug/src/listingMap.ts` correlates machine addresses back to
  source lines using a listing macro injected via fasm2's `-i` flag (fasm2 doesn't emit DWARF or
  CodeView by default, so there's no standard debug format to lean on).
  `debug/src/gdbDriver.ts`/`miParser.ts` drive gdb (or lldb) over its machine interface.
- `extension/` is the VS Code glue: the grammar, snippets, task providers, and the bits that wire
  the language server and debug adapter into the editor.

If you're not sure which package your change belongs in, say so in the PR description — that's a
completely fine thing to be unsure about, and it's a five-second answer in review.

## Testing

This is the part we actually care about, so read it.

Nothing in this codebase is tested against a mock of `fasm2` or `gdb`. Every test that can run
against the real tool does — `server/test/diagnostics.test.ts` builds a broken `.asm` file and
runs the real compiler on it; `debug/test/gdbDriver.test.ts` compiles a real ELF binary and drives
a real `gdb` process against it; `extension/test/suite/*.test.ts` launches an actual VS Code
instance. If you're touching code that talks to an external tool, your test should too. A test
that asserts on a hand-written string standing in for what fasm2 "probably" outputs is worse than
no test, because it'll keep passing after fasm2's actual behavior changes underneath it.

Some of these tests need `fasm2` and/or `gdb` installed to run at all — they check for the tool at
the top of the suite and call `this.skip()` if it's missing, so CI and contributors without those
tools installed don't get spurious failures. Follow that pattern if you're adding a test that
needs an external tool: check for it, skip cleanly if it's absent, don't fail the build over a
missing dependency that isn't yours to provide.

If your PR fixes a bug, the test should fail without your fix and pass with it — that's what
"explain why this fixes it" means in practice. If it's not obvious how to write that test, that's
worth mentioning in the PR description rather than skipping it silently.

```sh
npm run test:server      # tokenizer/parser/diagnostics unit tests + a real-fasm2 integration test
npm run test:debug       # listing/MI parser tests + a real gdb+fasm2 integration test
npm run test:extension   # real VS Code instance, real language features
```

`test:extension` needs a display; on headless Linux, `xvfb-run -a npm run test:extension`.

Changes to `server/src/parser/tokenizer.ts` or `symbolIndex.ts` are the ones most likely to have
subtle regressions that don't show up until real-world source hits them — if you're touching
either, run the full suite, not just the test file you added.

## Code style

`npm run lint` and `npm run typecheck` both have to be clean; CI checks this and won't let a PR
merge otherwise.

Beyond that: this codebase tries to avoid comments that explain *what* the code does (the code
already says that) in favor of comments that explain *why*, when the why isn't obvious from
reading it — a workaround for a specific fasm2/gdb quirk, a constraint that would otherwise look
arbitrary. If you're adding a comment, ask whether a reader six months from now would be confused
without it. If not, leave it out.

Don't add abstraction for a single call site. Don't add a settings/config knob for something that
could just be a sensible fixed default. If you're fixing a bug, fix the bug — resist the urge to
refactor the surrounding code in the same PR; it makes the change harder to review and harder to
revert if something's wrong with it. Separate cleanup PRs are welcome on their own.

## Sending the pull request

The PR template will ask for this, but to save you a round trip: explain what was broken (or
missing) and why your change is the right fix, not just a fix. "This throws when X" is a good
start; "this throws when X because Y assumes Z, which isn't true when W" is what actually helps a
reviewer trust the change instead of just trusting you. Link an issue if there is one.

Keep PRs scoped to one thing. A bug fix plus an unrelated dependency bump plus a rename is three
PRs, not one — it's not about being pedantic, it's that if CI catches a problem, an isolated PR
tells you immediately what caused it and a bundled one doesn't.

Once it's open, expect actual review comments rather than a quick merge — this project would
rather take a bit longer to get something right than merge something that quietly breaks the
`fasm1` dialect detection or the address-to-line correlation for someone six months from now.

## License

By submitting a change, you're agreeing it can be distributed under this project's MIT license
(see `LICENSE`). If you're porting in code from somewhere else — another extension, a Stack
Overflow answer, a gist — say so in the PR and make sure its license is actually compatible;
`debug/debug-support/listing.inc` is the one exception in this repo (it's fasmg's own listing
macro, redistributed under fasm's BSD-style license with attribution — see the `NOTICE.md` next to
it), and that's the level of care we'd want for anything else brought in from outside.
