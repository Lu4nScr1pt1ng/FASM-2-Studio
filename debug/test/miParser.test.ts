import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MIRecord, parseMILine } from '../src/miParser';

describe('parseMILine (against a real captured gdb --interpreter=mi3 session)', () => {
  it('parses every line of the captured session without throwing', () => {
    const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'gdb-mi-session.txt'), 'utf8');
    const records: MIRecord[] = [];
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      assert.doesNotThrow(() => records.push(parseMILine(line)), `failed to parse: ${line}`);
    }
    assert.ok(records.every((r) => r.type !== undefined));
  });

  it('parses a breakpoint-insert result, including a nested list', () => {
    const r = parseMILine(
      '1^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x0000000000400082",thread-groups=["i1"],times="0",original-location="*0x400082"}',
    );
    assert.strictEqual(r.type, 'result');
    assert.strictEqual(r.token, 1);
    assert.strictEqual(r.klass, 'done');
    const bkpt = (r.data as Record<string, unknown>).bkpt as Record<string, unknown>;
    assert.strictEqual(bkpt.number, '1');
    assert.strictEqual(bkpt.addr, '0x0000000000400082');
    assert.deepStrictEqual(bkpt['thread-groups'], ['i1']);
  });

  it('parses a *stopped async record with a nested frame tuple', () => {
    const r = parseMILine(
      '*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x0000000000400082",func="??",args=[],arch="i386:x86-64"},thread-id="1",stopped-threads="all",core="7"',
    );
    assert.strictEqual(r.type, 'exec-async');
    assert.strictEqual(r.klass, 'stopped');
    const data = r.data as Record<string, unknown>;
    assert.strictEqual(data.reason, 'breakpoint-hit');
    const frame = data.frame as Record<string, unknown>;
    assert.strictEqual(frame.addr, '0x0000000000400082');
    assert.deepStrictEqual(frame.args, []);
  });

  it('parses a list of tuples (register-values)', () => {
    const r = parseMILine('3^done,register-values=[{number="0",value="0x1"},{number="1",value="0x2"}]');
    const values = (r.data as Record<string, unknown>)['register-values'] as Array<Record<string, string>>;
    assert.strictEqual(values.length, 2);
    assert.strictEqual(values[0].value, '0x1');
    assert.strictEqual(values[1].number, '1');
  });

  it('decodes C-string escapes in console stream records', () => {
    const r = parseMILine('~"Breakpoint 1, 0x0000000000400082 in ?? ()\\n"');
    assert.strictEqual(r.type, 'console');
    assert.strictEqual(r.data, 'Breakpoint 1, 0x0000000000400082 in ?? ()\n');
  });

  it('treats "(gdb)" prompt lines as a distinct, harmless record type', () => {
    assert.strictEqual(parseMILine('(gdb) ').type, 'prompt');
  });

  it('recognizes notify-async records', () => {
    const r = parseMILine('=thread-group-started,id="i1",pid="73677"');
    assert.strictEqual(r.type, 'notify-async');
    assert.strictEqual(r.klass, 'thread-group-started');
    assert.strictEqual((r.data as Record<string, unknown>).pid, '73677');
  });

  it('handles escaped quotes and backslashes inside strings', () => {
    const r = parseMILine('1^done,msg="she said \\"hi\\" and used a \\\\ backslash"');
    assert.strictEqual((r.data as Record<string, unknown>).msg, 'she said "hi" and used a \\ backslash');
  });

  it('never throws on malformed or unexpected input', () => {
    for (const line of ['', 'garbage', '1^', '{unterminated', '"unterminated string', '1^done,key=']) {
      assert.doesNotThrow(() => parseMILine(line));
    }
  });
});
