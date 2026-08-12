## Where output goes

By default, next to the source with the extension stripped: `prog.asm` → `prog`.

Set `fasm2Studio.buildOutputPath` (resolved relative to the source file's directory) to redirect
it, e.g. `"../bin/prog"` to keep build artefacts out of the source tree. Missing directories are
created for you; fasm will not create them itself.

## Fragments

Building an `.inc` — or any file with no `format` directive of its own — assembles the real entry
point that includes it, rather than failing on a file that was never meant to compile standalone.
When a fragment is reachable from several unrelated projects you are asked which one you meant.

## Errors

Compiler errors appear inline as you type. In terminal output, the `file.asm [12]:` header is
clickable.
