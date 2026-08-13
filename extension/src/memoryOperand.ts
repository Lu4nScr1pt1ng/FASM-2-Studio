// Finding the fasm memory operand under a cursor, and deciding how wide it is.
//
// Kept free of any `vscode` import — the way statusBarMenuItems.ts is — so the part with actual
// behaviour in it can be asserted without a running editor; evaluatableExpression.ts turns what
// this returns into the vscode.EvaluatableExpression the debug hover asks for.
//
// Why this exists at all: with no EvaluatableExpressionProvider registered, VS Code falls back to
// the word under the cursor. For most languages a word is a variable and that guess is fine. For
// assembly it is the wrong unit almost every time — in `mov eax, dword [rsp+8]` the word under
// `rsp` is `rsp`, so the editor asks the debugger about the register and never about the memory
// the instruction actually reads. The operand *is* the value here, and it was unreachable.
//
// Translating the operand into something gdb accepts is deliberately not done here: that needs the
// listing's symbol addresses, which live in the debug adapter (see debug/src/operandExpression.ts).
// All this decides is where the operand starts and stops, and how wide it is — the width because
// only this side can see the instruction the operand belongs to.

import { Token, TokenType, tokenizeLine } from '@fasm2-studio/server/src/parser/tokenizer';

/** Size specifiers the debugger can read back as a single scalar. Matches debug/src/
 * operandExpression.ts's own SIZE_BITS: a `dqword` operand is valid fasm but has no scalar value
 * to report, so it is left to the word-under-cursor fallback. */
const SIZE_SPECIFIERS = new Set(['byte', 'word', 'dword', 'qword']);

/** The wider fasm sizes, recognized only so an operand that names one is declined outright instead
 * of falling through to inference — which would otherwise answer `mov eax, dqword [x]` with a
 * 4-byte read, quietly overruling the width the source actually wrote. */
const NON_SCALAR_SIZES = new Set(['fword', 'pword', 'tbyte', 'tword', 'dqword', 'xword', 'qqword', 'yword', 'dqqword', 'zword']);

/** Register name -> the size specifier naming its width. Used to recover the operand size for the
 * common form that does not write one, because x86 takes it from the other operand: `mov eax, [x]`
 * is a 4-byte read and `mov al, [x]` a 1-byte one, and reading either at the wrong width reports a
 * value that is simply not the one the instruction uses. Only widths a scalar read can return are
 * listed, so an xmm/st operand infers nothing and is declined. */
const REGISTER_SIZE: Record<string, string> = {
  rax: 'qword', rbx: 'qword', rcx: 'qword', rdx: 'qword', rsi: 'qword', rdi: 'qword', rbp: 'qword', rsp: 'qword', rip: 'qword',
  r8: 'qword', r9: 'qword', r10: 'qword', r11: 'qword', r12: 'qword', r13: 'qword', r14: 'qword', r15: 'qword',
  eax: 'dword', ebx: 'dword', ecx: 'dword', edx: 'dword', esi: 'dword', edi: 'dword', ebp: 'dword', esp: 'dword', eip: 'dword',
  r8d: 'dword', r9d: 'dword', r10d: 'dword', r11d: 'dword', r12d: 'dword', r13d: 'dword', r14d: 'dword', r15d: 'dword',
  ax: 'word', bx: 'word', cx: 'word', dx: 'word', si: 'word', di: 'word', bp: 'word', sp: 'word',
  r8w: 'word', r9w: 'word', r10w: 'word', r11w: 'word', r12w: 'word', r13w: 'word', r14w: 'word', r15w: 'word',
  al: 'byte', bl: 'byte', cl: 'byte', dl: 'byte', ah: 'byte', bh: 'byte', ch: 'byte', dh: 'byte',
  sil: 'byte', dil: 'byte', bpl: 'byte', spl: 'byte',
  r8b: 'byte', r9b: 'byte', r10b: 'byte', r11b: 'byte', r12b: 'byte', r13b: 'byte', r14b: 'byte', r15b: 'byte',
};

export interface MemoryOperand {
  /** Start of the operand in the line, size specifier included when the source wrote one — so the
   * hover highlights the operand as it reads rather than only its bracketed part. */
  startChar: number;
  /** End of the operand, always the closing `]`. */
  endChar: number;
  /** What to send the debugger: the operand with its size always spelled out, even where the
   * source left it implicit. The adapter only ever sees one operand, never the instruction around
   * it, so this is the only place that inference can happen. */
  expression: string;
}

/** The `[` ... `]` pair containing `character`, as token indices. Hovering the brackets themselves
 * counts as being inside. Returns undefined when the position is not in a bracket group, or when
 * the brackets are unbalanced (a line mid-edit), which is not something to guess about. */
function bracketGroupAt(tokens: Token[], character: number): { open: number; close: number } | undefined {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== TokenType.Punct || tokens[i].text !== '[') continue;
    for (let j = i + 1; j < tokens.length; j++) {
      // A nested `[` means this is not the innermost group; let the inner one be found instead.
      if (tokens[j].type === TokenType.Punct && tokens[j].text === '[') break;
      if (tokens[j].type !== TokenType.Punct || tokens[j].text !== ']') continue;
      if (character >= tokens[i].startChar && character <= tokens[j].endChar) return { open: i, close: j };
      break;
    }
  }
  return undefined;
}

/**
 * The size specifier written immediately before the operand, as a token index. Steps over the
 * optional masm-style `ptr` that fasm also accepts between the two.
 *
 * `'non-scalar'` distinguishes "the source named a width, just not one that can be read back as a
 * single value" from "the source named no width at all" — only the latter may be inferred from.
 */
function sizeSpecifierBefore(tokens: Token[], open: number): number | 'non-scalar' | undefined {
  let index = open - 1;
  if (index >= 0 && tokens[index].type === TokenType.Ident && tokens[index].text.toLowerCase() === 'ptr') index--;
  if (index < 0 || tokens[index].type !== TokenType.Ident) return undefined;
  const name = tokens[index].text.toLowerCase();
  if (NON_SCALAR_SIZES.has(name)) return 'non-scalar';
  return SIZE_SPECIFIERS.has(name) ? index : undefined;
}

/**
 * The operand size implied by the instruction's *other* operand.
 *
 * Only registers outside the brackets count: in `mov eax, [buf+rcx*4]` the `rcx` is part of the
 * address, not of the value's width, so counting it would read 8 bytes where the instruction
 * reads 4.
 */
function inferredSize(tokens: Token[], open: number, close: number): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    if (i >= open && i <= close) continue;
    if (tokens[i].type !== TokenType.Ident) continue;
    const size = REGISTER_SIZE[tokens[i].text.toLowerCase()];
    if (size) return size;
  }
  return undefined;
}

/** The memory operand at `character` in `lineText`, or undefined if there isn't one there. */
export function memoryOperandAt(lineText: string, character: number): MemoryOperand | undefined {
  const tokens = tokenizeLine(lineText, 0).filter((t) => t.type !== TokenType.Comment);

  const group = bracketGroupAt(tokens, character);
  if (!group) return undefined;

  const sizeIndex = sizeSpecifierBefore(tokens, group.open);
  if (sizeIndex === 'non-scalar') return undefined;

  const size = sizeIndex !== undefined ? tokens[sizeIndex].text.toLowerCase() : inferredSize(tokens, group.open, group.close);
  // No size specifier and no register to take one from — `cmp [x], 5` and the like. fasm itself
  // rejects that as ambiguous, so it is not a shape real source arrives in, and guessing a width
  // would be inventing the one piece of information nobody supplied.
  if (!size) return undefined;

  const startChar = sizeIndex !== undefined ? tokens[sizeIndex].startChar : tokens[group.open].startChar;
  const endChar = tokens[group.close].endChar;
  const brackets = lineText.slice(tokens[group.open].startChar, endChar);
  return { startChar, endChar, expression: `${size} ${brackets}` };
}
