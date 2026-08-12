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

If it reads **compiler not found**, click it.
