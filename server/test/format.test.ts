import * as assert from 'assert';
import { DEFAULT_FORMAT_OPTIONS, formatLines, lineShape, visualWidth } from '../src/features/format';

function format(text: string, options = DEFAULT_FORMAT_OPTIONS): string {
  return formatLines(text, options).join('\n');
}

/** The statement a line was read as, without the brace/continuation bookkeeping alongside it. */
function statement(text: string): Record<string, unknown> {
  const { label, mnemonic, operands, comment, verbatim } = lineShape(text);
  return { label, mnemonic, operands, comment, verbatim };
}

describe('lineShape', () => {
  it('splits a label, mnemonic, operands and comment', () => {
    assert.deepStrictEqual(statement('start:  mov eax, 1   ; set it'), {
      label: 'start:',
      mnemonic: 'mov',
      operands: 'eax, 1',
      comment: '; set it',
      verbatim: false,
    });
  });

  it('recognizes an area label written with "::"', () => {
    const shape = lineShape('area:: db 0');
    assert.strictEqual(shape.label, 'area::');
    assert.strictEqual(shape.mnemonic, 'db');
  });

  it('treats a blank line and a comment-only line as verbatim', () => {
    assert.strictEqual(lineShape('').verbatim, true);
    assert.strictEqual(lineShape('   ').verbatim, true);
    assert.strictEqual(lineShape('   ; a banner comment').verbatim, true);
  });

  it('does not mistake a ";" inside a string for a comment', () => {
    // The single most important thing a regex-based formatter gets wrong here.
    const shape = lineShape("msg db 'hello ; world', 0");
    assert.strictEqual(shape.comment, undefined);
    assert.strictEqual(shape.operands, "'hello ; world', 0");
  });

  it('reads a colon-less data label as a label, not as a mnemonic', () => {
    assert.deepStrictEqual(statement("msg db 'hi', 0"), {
      label: 'msg',
      mnemonic: 'db',
      operands: "'hi', 0",
      comment: undefined,
      verbatim: false,
    });
  });

  it('reads "NAME = value" and "NAME := value" as definitions rather than mnemonics', () => {
    const assigned = lineShape('COUNT = 10');
    assert.strictEqual(assigned.label, 'COUNT');
    assert.strictEqual(assigned.mnemonic, '=');
    assert.strictEqual(assigned.operands, '10');

    const declared = lineShape('COUNT := 10');
    assert.strictEqual(declared.label, 'COUNT:');
    assert.strictEqual(declared.mnemonic, '=');
    assert.strictEqual(declared.operands, '10');
  });

  it('leaves a line starting with punctuation verbatim rather than guessing at it', () => {
    // "." is deliberately not used here: it is a legal fasm identifier start (local labels are
    // written ".name"), so a line beginning with it is an identifier, not punctuation.
    assert.strictEqual(lineShape('  , foo').verbatim, true);
    assert.strictEqual(lineShape('  ] end').verbatim, true);
  });
});

describe('formatLines', () => {
  it('aligns mnemonics and operands into columns', () => {
    const input = ['start:', 'mov eax,1', '   add    eax,   ebx', 'ret'].join('\n');
    assert.strictEqual(format(input), ['start:', '        mov     eax,1', '        add     eax,   ebx', '        ret'].join('\n'));
  });

  it('keeps a label on the same line as its instruction', () => {
    assert.strictEqual(format('start: mov eax, 1'), 'start:  mov     eax, 1');
  });

  it('pushes the mnemonic one space right when the label overruns the column', () => {
    assert.strictEqual(format('a_very_long_label: mov eax, 1'), 'a_very_long_label: mov eax, 1');
  });

  it('keeps structural keywords at the margin and indents the code inside them', () => {
    // "structure on the left, instructions indented" — sending `macro` to the mnemonic column too
    // would put it to the right of its own body's labels.
    const input = ['macro save reg', 'push reg', 'end macro'].join('\n');
    assert.strictEqual(format(input), ['macro save reg', '            push    reg', 'end macro'].join('\n'));
  });

  it('indents nested blocks cumulatively', () => {
    const input = ['if defined X', 'while 1', 'nop', 'end while', 'end if'].join('\n');
    assert.strictEqual(format(input), ['if defined X', '    while 1', '                nop', '    end while', 'end if'].join('\n'));
  });

  it('dedents "else" and re-indents the branch after it', () => {
    const input = ['if X', 'nop', 'else', 'ret', 'end if'].join('\n');
    assert.strictEqual(format(input), ['if X', '            nop', 'else', '            ret', 'end if'].join('\n'));
  });

  it('closes a struct with "ends", aligning its fields as label/directive pairs', () => {
    const input = ['struct Point', 'x dd ?', 'y dd ?', 'ends'].join('\n');
    assert.strictEqual(format(input), ['struct Point', '    x       dd      ?', '    y       dd      ?', 'ends'].join('\n'));
  });

  it('lays out a whole program the way fasm source is conventionally written', () => {
    const input = ['format ELF64 executable 3', 'entry start', 'segment readable executable', 'start:', 'mov eax, 60', 'syscall'].join('\n');
    assert.strictEqual(
      format(input),
      ['format ELF64 executable 3', 'entry start', 'segment readable executable', 'start:', '        mov     eax, 60', '        syscall'].join('\n'),
    );
  });

  it('never reorders, drops or rewrites a token', () => {
    const input = ["msg db 'a ; b', 0Dh, 0Ah, 0", 'lea rsi, [msg]', 'mov rdx, msg_len'].join('\n');
    const output = format(input);
    for (const token of ["'a ; b'", '0Dh', '0Ah', '[msg]', 'msg_len', 'lea', 'db']) {
      assert.ok(output.includes(token), `formatting lost ${token}`);
    }
  });

  it('leaves comment-only lines exactly where their author put them', () => {
    const input = ['; ------------------', ';  A banner comment', '; ------------------', 'nop'].join('\n');
    assert.strictEqual(format(input), ['; ------------------', ';  A banner comment', '; ------------------', '        nop'].join('\n'));
  });

  it('normalizes a whitespace-only line to empty but keeps the line itself', () => {
    assert.strictEqual(format('nop\n   \nret'), '        nop\n\n        ret');
  });

  it('is idempotent: formatting formatted output changes nothing', () => {
    const input = [
      'format ELF64 executable 3',
      'entry start',
      'segment readable executable',
      'start:',
      'mov edi, 0',
      'if defined DEBUG',
      "msg db 'hi ; there', 0",
      'end if',
      'mov eax, 60',
      'syscall',
    ].join('\n');
    const once = format(input);
    assert.strictEqual(format(once), once, 'second pass changed the output');
  });

  it('honours a tab indent without misaligning the columns after it', () => {
    const withTabs = { ...DEFAULT_FORMAT_OPTIONS, useTabs: true, tabSize: 8 };
    const output = format(['macro m', 'nop', 'end macro'].join('\n'), withTabs);
    const body = output.split('\n')[1];
    assert.ok(body.startsWith('\t'), `expected a tab indent, got ${JSON.stringify(body)}`);
    // One tab is 8 columns wide, and the mnemonic column is measured from there — so the mnemonic
    // lands at 8 + 8. Counting the tab as a single character would have put it at 9.
    assert.strictEqual(visualWidth(body.slice(0, body.indexOf('nop')), 8), 16);
  });

  it('leaves alignment off entirely when the columns are set to 0', () => {
    const off = { ...DEFAULT_FORMAT_OPTIONS, mnemonicColumn: 0, operandColumn: 0, commentColumn: 0 };
    assert.strictEqual(format('start: mov eax, 1 ; go', off), 'start: mov eax, 1 ; go');
  });

  it('aligns trailing comments to a column when one is configured', () => {
    const withComments = { ...DEFAULT_FORMAT_OPTIONS, commentColumn: 32 };
    const output = format(['mov eax, 1 ; one', 'nop ; two'].join('\n'), withComments);
    const [first, second] = output.split('\n');
    assert.strictEqual(visualWidth(first.slice(0, first.indexOf('; one')), 4), 32);
    assert.strictEqual(visualWidth(second.slice(0, second.indexOf('; two')), 4), 32);
  });

  it('keeps the column an author aligned their trailing comments to', () => {
    // The whole point of the comment column: a file laid out by hand comes back unchanged, rather
    // than with every comment yanked to one space after the code and the alignment destroyed.
    const input = [
      'main:',
      '        mov     rbp, rsp        ; freeze the argument vector before pushing',
      '                                ; anything; see includes/args.inc for offsets',
      '',
      '        call    check_args      ; rax = path, or the program ends right here',
      '        mov     r12, rax        ; keep it: callee-saved, survives the syscalls',
    ].join('\n');
    assert.strictEqual(format(input), input);
  });

  it('carries a wrapped comment continuation along with the column it belongs to', () => {
    const input = ['mov eax, 1     ; the first line of the note', '               ; and the rest of it'].join('\n');
    const [first, second] = format(input).split('\n');
    assert.strictEqual(visualWidth(second.slice(0, second.indexOf(';')), 4), visualWidth(first.slice(0, first.indexOf(';')), 4));
  });

  it('aligns a run of comments to one column once the code has outgrown their old one', () => {
    const input = ['mov eax, 1 ; one', 'nop', 'lea rsi, [a_rather_long_symbol] ; two', 'ret ; three'].join('\n');
    const columns = format(input)
      .split('\n')
      .filter((line) => line.includes(';'))
      .map((line) => visualWidth(line.slice(0, line.indexOf(';')), 4));
    assert.deepStrictEqual(columns, [columns[0], columns[0], columns[0]], 'comments in one run should share a column');
    assert.ok(columns[0] % 4 === 0, `expected a tab stop, got column ${columns[0]}`);
  });

  it('leaves a banner comment at the margin out of the run below it', () => {
    const input = ['mov eax, 1      ; note', '; a banner', 'nop             ; other'].join('\n');
    assert.strictEqual(format(input).split('\n')[1], '; a banner');
  });

  it('indents a fasm 1 brace block once and closes it on the "}"', () => {
    const input = ['macro save reg {', 'push reg', '}', 'ret'].join('\n');
    assert.strictEqual(format(input), ['macro save reg {', '            push    reg', '}', '        ret'].join('\n'));
  });

  it('does not count a brace opening the body on the line after its keyword twice', () => {
    // fasm 1's own include tree is written this way; counting both cost a level per macro and
    // never gave it back.
    const input = ['macro stdcall proc', '{', 'push proc', '}', 'ret'].join('\n');
    assert.strictEqual(format(input), ['macro stdcall proc', '{', '            push    proc', '}', '        ret'].join('\n'));
  });

  it('leaves the depth alone for a block opened and closed on one line', () => {
    assert.strictEqual(format(['rept 4 { db 0 }', 'ret'].join('\n')), ['rept 4 { db 0 }', '        ret'].join('\n'));
  });

  it('closes a nested macro definition written with escaped braces', () => {
    const input = ['macro outer {', 'macro inner \\{', 'nop', '\\}', '}', 'ret'].join('\n');
    assert.strictEqual(format(input).split('\n').at(-1), '        ret');
  });

  it('passes a "\\"-continued line through instead of reading it as a new statement', () => {
    // "hlt,0F4h" on a continuation line is a wrapped operand list, not a mnemonic and an operand
    // starting with a comma — fasmg's own 80386.inc wraps its iterate headers exactly this way.
    const input = ['iterate <instr,opcode>, daa,27h, \\', '\t\thlt,0F4h, cmc,0F5h', 'nop'].join('\n');
    const output = format(input).split('\n');
    assert.strictEqual(output[1], '\t\thlt,0F4h, cmc,0F5h');
    assert.strictEqual(output[2], '        nop', 'the continuation line must not have opened anything');
  });

  it('treats a calminstruction body as the flat instruction list it is', () => {
    // calm's `match` tests its arguments; it opens nothing and has no `end match`. Reading it as a
    // block gave fasmg's own 80386.inc 96 columns of indentation.
    const input = ['calminstruction dd? definitions&', 'local n', 'match =dup? value, definitions', 'jyes duplicate', 'end calminstruction', 'ret'].join('\n');
    assert.strictEqual(
      format(input),
      [
        'calminstruction dd? definitions&',
        '            local   n',
        '            match   =dup? value, definitions',
        '            jyes    duplicate',
        'end calminstruction',
        '        ret',
      ].join('\n'),
    );
  });

  it('does not indent a file on the strength of a block it never closes', () => {
    // Every codebase has these: a `endif equ end if` alias, a macro pair a project invented, a
    // fragment meant to be included inside a construct it never opens. One of them used to indent
    // every line after it, to 288 columns in KolibriOS' uFMOD.
    const input = ['if DEBUG', 'nop', 'ret'].join('\n');
    assert.strictEqual(format(input), ['if DEBUG', '        nop', '        ret'].join('\n'));
  });

  it('reads "endif" as the "end if" alias that fasm 1 projects define it to be', () => {
    const input = ['if DEBUG', 'nop', 'endif', 'ret'].join('\n');
    assert.strictEqual(format(input), ['if DEBUG', '            nop', 'endif', '        ret'].join('\n'));
  });

  it('is idempotent over blocks, continuations and comment columns together', () => {
    const input = [
      'macro save reg {',
      'push reg  ; keep it',
      '}',
      'calminstruction emit? bytes&',
      'match a=,b, bytes',
      'end calminstruction',
      'iterate x, 1, \\',
      '        2, 3',
      'start:',
      'mov eax, 1        ; go',
      '                  ; and keep going',
      'end iterate',
    ].join('\n');
    const once = format(input);
    assert.strictEqual(format(once), once, 'second pass changed the output');
  });

  it('does not indent past zero when a file starts with a block terminator', () => {
    // A fragment meant to be `include`d mid-construct: it must not end up with negative indent.
    assert.strictEqual(format(['end if', 'nop'].join('\n')), ['end if', '        nop'].join('\n'));
  });
});

describe('visualWidth', () => {
  it('advances a tab to the next tab stop rather than counting it as one column', () => {
    assert.strictEqual(visualWidth('\t', 4), 4);
    assert.strictEqual(visualWidth('ab\t', 4), 4);
    assert.strictEqual(visualWidth('abcd\t', 4), 8);
    assert.strictEqual(visualWidth('abc', 4), 3);
  });
});
