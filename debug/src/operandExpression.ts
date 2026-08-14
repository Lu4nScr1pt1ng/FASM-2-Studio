// Turns a fasm memory operand — `dword [rsp+8]`, `[buffer+rcx*4]`, `byte [msg]` — into an
// expression gdb's own evaluator accepts.
//
// This is what makes hovering a memory reference in the source do anything. Without it VS Code's
// debug hover falls back to the word under the cursor, so hovering `[rsp+8]` asks about `rsp` and
// hovering `dword [count]` asks about `count` — never about the thing being dereferenced, which in
// assembly is the whole point of the operand.
//
// Three separate translations have to happen, and none of them is optional:
//
//   Registers. gdb spells them `$rsp`; the source spells them `rsp`. A bare `rsp` reaches gdb as a
//   symbol name, and a binary fasmg produced has no symbol table for it to be absent from, so the
//   error is the misleading "No symbol table is loaded".
//
//   Labels. Same problem, no fix available from gdb's side: fasmg emits no DWARF/CodeView at all,
//   which is why session.ts resolves labels out of the .lst listing instead. So a label inside an
//   operand has to be substituted for its address *before* gdb ever sees the expression.
//
//   Numbers. `0FFh`, `1010b` and `$FF` are fasm literals, not C ones — gdb reads `0FFh` as a
//   symbol and `$FF` as one of its own convenience variables. Every literal is re-emitted in
//   decimal.
//
// What comes back is the *address* expression plus the width to read it at, not a finished
// dereference, so the caller reads it through the same cast-and-parse helper every other scalar
// read already uses. That matters because the source's own size specifier is not a type gdb has:
// verified against real gdb 16.3, `p *(dword*)$rsp` answers "No symbol table is loaded" (its error
// for an unknown type name) while `p *(unsigned int*)$rsp` reads the memory. Keeping the cast in
// one place keeps this file from having a second opinion about it.
//
// Anything this cannot translate with certainty returns undefined rather than a guess, and the
// caller falls through to the behaviour that existed before. A wrong answer about memory is worse
// than no answer: it is indistinguishable from a real value.

import { parseNumericLiteral } from '@fasm2-studio/server/src/features/numericLiteral';
import { Token, TokenType, tokenizeLine } from '@fasm2-studio/server/src/parser/tokenizer';
import { gdbRegisterName, REGISTER_WIDTH_BITS, RegisterBits } from './registers';

/** fasm size specifiers that name a width a single cast-read can return as one scalar. Deliberately
 * the same domain as session.ts's READABLE_VALUE_BITS: `fword`/`tbyte`/`dqword` and friends are
 * real fasm sizes but have no scalar C type to cast to, so an operand explicitly written with one
 * is declined below rather than silently read at some other width. */
const SIZE_BITS: Record<string, RegisterBits> = { byte: 8, word: 16, dword: 32, qword: 64 };

/** The wider specifiers, recognized only so an operand carrying one is declined as "explicitly
 * sized, just not to a width this can read" instead of being mistaken for an unsized operand. */
const NON_SCALAR_SIZES = new Set(['fword', 'pword', 'tbyte', 'tword', 'dqword', 'xword', 'qqword', 'yword', 'dqqword', 'zword']);

/** Operators legal inside an x86 effective address that also mean the same thing to gdb. `*` is the
 * index scale (`[buf+rcx*4]`), which C multiplication reproduces exactly. Anything else — a comma,
 * a colon, a segment override — is declined. */
const ALLOWED_PUNCT = new Set(['+', '-', '*', '(', ')']);

/** How the pieces of an operand that are not registers or numbers get their values. Both come from
 * the .lst listing (see symbols.ts), which is the only symbol information a fasmg binary has. */
export interface OperandResolver {
  /** Runtime address of a source label, or undefined if it is not one. */
  symbolAddress(name: string): bigint | undefined;
  /** Value of a compile-time constant (`FD_STDERR = 2`), which has no address at all. */
  constantValue(name: string): bigint | undefined;
}

export interface TranslatedOperand {
  /** The gdb expression for the *address*, e.g. `($rsp+8)` — deliberately not the dereference, so
   * the caller reads it through the same cast-and-parse helper every other scalar read uses. */
  address: string;
  /** Width the operand is read at, from its own size specifier or the caller's inference. */
  bits: RegisterBits;
  /** The operand as it was written, for labelling the value. */
  text: string;
}

/** Splits `dword [rsp+8]` into its size specifier and its bracketed address expression. Returns
 * undefined for anything that is not a single bracketed memory operand — the caller's other
 * branches (bare register, bare label, raw gdb expression) already cover those. */
function splitOperand(text: string): { size: string | undefined; inner: string } | undefined {
  const trimmed = text.trim();
  const open = trimmed.indexOf('[');
  if (open < 0 || !trimmed.endsWith(']')) return undefined;

  const inner = trimmed.slice(open + 1, -1);
  // A second `]` before the end means this is not one operand but several (`[a], [b]`), which has
  // no single value to report.
  if (inner.includes(']') || inner.includes('[')) return undefined;

  // fasm also accepts the masm-style `dword ptr [x]`, so `ptr` is dropped as noise if present.
  const prefix = trimmed
    .slice(0, open)
    .trim()
    .toLowerCase()
    .replace(/\bptr\b/, '')
    .trim();
  if (prefix.includes(' ')) return undefined;
  return { size: prefix || undefined, inner };
}

/** Rewrites one token of the address expression into its gdb equivalent, or undefined if it has
 * none — which declines the whole operand. */
function translateToken(token: Token, resolve: OperandResolver): string | undefined {
  switch (token.type) {
    case TokenType.Punct:
      return ALLOWED_PUNCT.has(token.text) ? token.text : undefined;

    case TokenType.Number: {
      const literal = parseNumericLiteral(token.text);
      return literal ? literal.value.toString() : undefined;
    }

    case TokenType.Ident: {
      const lower = token.text.toLowerCase();
      // Registers first: an x86 register name is never also a label in a program that assembles,
      // since fasm would not let you define one.
      if (REGISTER_WIDTH_BITS[lower] !== undefined) return `$${gdbRegisterName(lower)}`;

      // Constants before labels: a constant has a value but no address, so substituting its
      // address (there isn't one) would be the wrong operation, not merely a different one.
      const constant = resolve.constantValue(token.text);
      if (constant !== undefined) return constant.toString();

      const address = resolve.symbolAddress(token.text);
      if (address !== undefined) return `0x${address.toString(16)}`;

      // An unresolvable name — a macro parameter, a `local`, or a name the listing never recorded.
      // gdb cannot resolve it either, so there is nothing to hand it.
      return undefined;
    }

    // A string inside an address expression, or a comment: neither is part of one.
    default:
      return undefined;
  }
}

/**
 * The gdb expression for a fasm memory operand, or undefined if it is not one this can translate.
 *
 * `bits` supplies the width for an operand written without a size specifier (`mov eax, [x]`, where
 * x86 takes the size from the other operand) — the caller infers it from the instruction, which is
 * context this function does not have. An operand that names its own size always uses that instead.
 */
export function translateMemoryOperand(text: string, resolve: OperandResolver, bits?: RegisterBits): TranslatedOperand | undefined {
  const split = splitOperand(text);
  if (!split) return undefined;

  let width: RegisterBits | undefined = bits;
  if (split.size !== undefined) {
    if (NON_SCALAR_SIZES.has(split.size)) return undefined;
    width = SIZE_BITS[split.size];
    // A prefix that is neither a size nor `ptr` means this was never a plain memory operand.
    if (width === undefined) return undefined;
  }
  if (width === undefined) return undefined;

  const tokens = tokenizeLine(split.inner, 0);
  if (tokens.length === 0) return undefined;

  const parts: string[] = [];
  for (const token of tokens) {
    const translated = translateToken(token, resolve);
    if (translated === undefined) return undefined;
    parts.push(translated);
  }

  // Parenthesized as a whole so that the caller's cast binds to all of it: without it,
  // `*(unsigned int*)$rsp+8` is "read at $rsp, then add 8" rather than "read at $rsp+8".
  return { address: `(${parts.join('')})`, bits: width, text: text.trim() };
}
