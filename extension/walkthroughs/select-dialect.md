## Why fasm1 cannot be auto-detected

Detection only recognises syntax that is exclusive to fasm2: `end macro`, `calminstruction`,
`iterate`, `namespace`. There is deliberately no fasm1 marker set — the obvious candidates
(`use32`, `rept`, `endp`) are all legitimate macro names in fasmg's own packages, and matching
them classified real fasmg files as fasm1.

So a fasm1 project that uses none of the fasm2 markers falls back to `fasm2Studio.defaultDialect`,
which ships as `fasm2`, and every file is then checked against the wrong assembler.

## The setting is per folder

`fasm2Studio.defaultDialect` is `resource`-scoped, so a workspace holding a fasm1 project *and* a
fasm2 project can give each folder its own answer.

## If you skip this

The first file that fails to assemble will offer to fix it — but only after the *other* assembler
has compiled that same file cleanly, so the offer is a fact rather than a guess.
