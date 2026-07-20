`listing.inc` in this directory is copied unmodified from the fasmg (flat assembler g)
distribution by Tomasz Grysztar, redistributed here under fasm's own BSD-style license (see
`LICENSE-fasm.txt` in this directory). It is injected into debug builds via fasm2's `-i` flag to
generate an address/source-text listing (`.lst`) without modifying the user's own source files —
see `debug/src/listingMap.ts` for how that listing is parsed and correlated back to source lines.
