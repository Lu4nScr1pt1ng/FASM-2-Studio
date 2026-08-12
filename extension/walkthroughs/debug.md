## How it works without a symbol table

fasm emits no DWARF and no symbol table, so the debugger cannot rely on either. Instead, a debug
build injects a bundled listing macro that emits a `.lst` address→line map, and the adapter uses
that to place breakpoints, map the program counter back to your source, and resolve your data
labels by name.

## What you get

- Source breakpoints, plus conditional, hit-count and log points
- Function breakpoints on any label name
- Watchpoints (break when a memory location changes)
- Registers grouped by kind, with decoded flags
- Data labels with string/array previews, and a raw memory view
- A disassembly view with instruction-level stepping and instruction breakpoints
- Set next statement, to jump the program counter to another line
- A terminal of the program's own, so one that reads stdin can be typed at — `"console"` in
  `launch.json` switches between `integratedTerminal`, `externalTerminal` and `debugConsole`

## Requirements

gdb on Linux/Windows, `lldb-mi` on macOS (experimental — Apple's own lldb does not speak the MI
protocol). Point `fasm2Studio.gdbPath` at it if it is not on PATH.
