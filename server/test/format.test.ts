import * as assert from 'assert';
import { DEFAULT_FORMAT_OPTIONS, formatLines, lineShape, visualWidth } from '../src/features/format';

function format(text: string, options = DEFAULT_FORMAT_OPTIONS): string {
  return formatLines(text, options).join('\n');
}

describe('lineShape', () => {
  it('splits a label, mnemonic, operands and comment', () => {
    assert.deepStrictEqual(lineShape('start:  mov eax, 1   ; set it'), {
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
    assert.deepStrictEqual(lineShape("msg db 'hi', 0"), {
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
