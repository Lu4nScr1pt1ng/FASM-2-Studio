## What's broken or missing, and why this fixes it

<!--
Not just "what changed" -- a reviewer can read the diff for that. Explain the problem you hit
and why this is the right fix for it, not just a fix. If there's an issue for this, link it
(e.g. "Fixes #123"); if not, a couple of sentences of context is fine.
-->

## Testing

<!--
This project tests against real tools (fasm2, gdb) rather than mocks wherever possible -- see
CONTRIBUTING.md if you haven't yet. Tell us what you actually ran, not just what exists.
-->

- [ ] I added or updated a test that fails without this change and passes with it
- [ ] If a test wasn't practical here, I've explained why below
- [ ] `npm run lint && npm run typecheck` pass locally
- [ ] I ran the relevant test suite(s) locally: <!-- test:server / test:debug / test:extension -->

## Scope check

- [ ] This PR does one thing (no unrelated refactors, renames, or dependency bumps bundled in)
