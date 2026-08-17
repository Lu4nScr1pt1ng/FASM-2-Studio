## The six modes

`FASM: Annotate Instructions Inline` picks between them, and the status bar item does too.

| Mode | What appears after the line |
| --- | --- |
| `address` | `0x00401000` |
| `size` | `5 bytes` |
| `addressAndSize` | `0x00401000 · 5 bytes` |
| `bytes` | `B8 3C 00 00 00` |
| `addressAndBytes` | `0x00401000 · B8 3C 00 00 00` |
| `off` | nothing |

## What it costs

The data comes from the listing the background compile already produces for live error checking, so
turning this on adds one flag to a compile that was happening anyway rather than a second pass.
With it off, nothing is added to that compile at all.

## What it needs

A trusted workspace, `fasm2Studio.diagnosticsEnabled`, and a fasm2/fasmg project — fasm1's listing
format is not supported. If any of those is missing you are told which, rather than left with a
setting that reads as on and an editor that shows nothing.

## Long encodings

An encoding longer than 16 bytes — a `format` directive emitting a whole ELF header, a `db` of a
string — is shortened inline and labelled with its real length. x86's longest legal instruction is
15 bytes, so anything past that is data whose point is that it is large. Every hint carries the full
dump on its tooltip whatever the mode.
