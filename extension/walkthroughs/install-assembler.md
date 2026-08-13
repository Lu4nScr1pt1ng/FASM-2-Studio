## Where to get one

Everything is on the [flat assembler download page](https://flatassembler.net/download.php):

- **fasm2** — the current assembler, distributed as `fasmg` plus the standard x86 package.
- **fasm1** — classic flat assembler, if that is what your project is written for.

Unpack it and put the executable on your `PATH`. `~/.local/bin` on Linux/macOS is checked even when
your desktop session doesn't put it on `PATH`, so it is the safest place to drop the binary.

## Why this step exists

FASM2 Studio ships no compiler. It drives whatever `fasm2`/`fasm1` you have installed, the same
way the C/C++ and Rust extensions drive your existing toolchain.

`fasm2` is not a separate assembler from `fasmg` — it is the same binary plus a wrapper script
that preloads the standard x86 package. If you have a bare `fasmg`, point at it and set
`fasm2Studio.fasm2Preload` to `fasm2.inc` with `fasm2Studio.includePath` pointing at fasm2's
`include` directory, and it behaves identically.

## Checking it worked

The status bar shows the dialect and the resolved executable for the file you are editing:

```
$(tools) fasm2 (/home/you/.local/bin/fasm2)
```

If it reads **compiler not found**, click it. Detection runs once per session, so if you installed
an assembler after opening this window, pick **Look again** rather than reloading.
