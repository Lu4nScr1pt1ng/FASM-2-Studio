// Parser for the GDB/LLDB "Machine Interface" (MI) text protocol. One line in, one record out;
// a small recursive-descent parser for the value grammar (quoted C-strings, {tuples}, [lists] of
// either bare values or key=value pairs — GDB mixes both forms, e.g. thread-groups=["i1"] vs
// register-values=[{number="0",value="0x1"}]).

export type MIValue = string | MIValue[] | { [key: string]: MIValue };

export type MIRecordType = 'result' | 'exec-async' | 'status-async' | 'notify-async' | 'console' | 'target' | 'log' | 'prompt' | 'unknown';

export interface MIRecord {
  type: MIRecordType;
  token?: number;
  /** The result class ("done", "running", "error", ...) or async/notify class ("stopped", "thread-created", ...). */
  klass?: string;
  /** Parsed key=value payload for result/async records; the decoded string for stream records. */
  data?: Record<string, MIValue> | string;
}

class ValueParser {
  private pos = 0;
  constructor(private readonly s: string) {}

  private eof(): boolean {
    return this.pos >= this.s.length;
  }

  private peek(): string {
    return this.s[this.pos];
  }

  private expect(ch: string): void {
    if (this.s[this.pos] !== ch) {
      throw new Error(`MI parse error: expected '${ch}' at offset ${this.pos} in: ${this.s}`);
    }
    this.pos++;
  }

  parseCString(): string {
    this.expect('"');
    let out = '';
    while (!this.eof() && this.peek() !== '"') {
      const ch = this.s[this.pos++];
      if (ch === '\\' && !this.eof()) {
        const esc = this.s[this.pos++];
        switch (esc) {
          case 'n':
            out += '\n';
            break;
          case 't':
            out += '\t';
            break;
          case 'r':
            out += '\r';
            break;
          case '\\':
          case '"':
            out += esc;
            break;
          default:
            out += esc;
        }
      } else {
        out += ch;
      }
    }
    this.expect('"');
    return out;
  }

  private parseIdentifier(): string {
    const start = this.pos;
    while (!this.eof() && /[A-Za-z0-9_.-]/.test(this.peek())) this.pos++;
    return this.s.slice(start, this.pos);
  }

  parseValue(): MIValue {
    const c = this.peek();
    if (c === '"') return this.parseCString();
    if (c === '{') return this.parseTuple();
    if (c === '[') return this.parseList();
    // Defensive fallback: a bare identifier where a quoted value was expected.
    return this.parseIdentifier();
  }

  /** A single "key=value" pair, or (defensively) a bare value with no key. */
  private parseResultPair(): [string | undefined, MIValue] {
    const save = this.pos;
    if (/[A-Za-z_]/.test(this.peek())) {
      const key = this.parseIdentifier();
      if (this.peek() === '=') {
        this.pos++;
        return [key, this.parseValue()];
      }
      this.pos = save;
    }
    return [undefined, this.parseValue()];
  }

  parseTuple(): Record<string, MIValue> {
    this.expect('{');
    const out: Record<string, MIValue> = {};
    if (this.peek() === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      const [key, value] = this.parseResultPair();
      if (key) out[key] = value;
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      break;
    }
    this.expect('}');
    return out;
  }

  parseList(): MIValue[] {
    this.expect('[');
    const out: MIValue[] = [];
    if (this.peek() === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      const [key, value] = this.parseResultPair();
      out.push(key ? ({ [key]: value } as MIValue) : value);
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      break;
    }
    this.expect(']');
    return out;
  }

  /** Parses a top-level ",key=value,key=value" tail (as follows a result/async class marker)
   * into a flat object — this is the same shape as a tuple's body, just without braces. */
  parseTopLevelPairs(): Record<string, MIValue> {
    const out: Record<string, MIValue> = {};
    while (!this.eof()) {
      if (this.peek() === ',') this.pos++;
      if (this.eof()) break;
      const [key, value] = this.parseResultPair();
      if (key) out[key] = value;
      else break; // malformed trailing content; stop rather than loop forever
    }
    return out;
  }
}

const RESULT_RE = /^(\d*)\^([a-zA-Z-]+)(?:,(.*))?$/;
const EXEC_ASYNC_RE = /^(\d*)\*([a-zA-Z-]+)(?:,(.*))?$/;
const STATUS_ASYNC_RE = /^(\d*)\+([a-zA-Z-]+)(?:,(.*))?$/;
const NOTIFY_ASYNC_RE = /^(\d*)=([a-zA-Z-]+)(?:,(.*))?$/;

function parseToken(raw: string): number | undefined {
  return raw.length > 0 ? parseInt(raw, 10) : undefined;
}

/** Parses a single line of raw MI output. Never throws: a line this doesn't understand comes
 * back as `{ type: 'unknown' }` rather than aborting the whole session over one odd line — GDB's
 * own console chatter is free-form and not worth being fragile against. */
export function parseMILine(line: string): MIRecord {
  const trimmed = line.replace(/\r$/, '');
  if (trimmed.length === 0) return { type: 'unknown' };
  if (trimmed === '(gdb)' || trimmed.startsWith('(gdb)')) return { type: 'prompt' };

  try {
    let m = RESULT_RE.exec(trimmed);
    if (m) return { type: 'result', token: parseToken(m[1]), klass: m[2], data: m[3] ? new ValueParser(m[3]).parseTopLevelPairs() : {} };

    m = EXEC_ASYNC_RE.exec(trimmed);
    if (m) return { type: 'exec-async', token: parseToken(m[1]), klass: m[2], data: m[3] ? new ValueParser(m[3]).parseTopLevelPairs() : {} };

    m = STATUS_ASYNC_RE.exec(trimmed);
    if (m) return { type: 'status-async', token: parseToken(m[1]), klass: m[2], data: m[3] ? new ValueParser(m[3]).parseTopLevelPairs() : {} };

    m = NOTIFY_ASYNC_RE.exec(trimmed);
    if (m) return { type: 'notify-async', token: parseToken(m[1]), klass: m[2], data: m[3] ? new ValueParser(m[3]).parseTopLevelPairs() : {} };

    if (trimmed.startsWith('~')) return { type: 'console', data: new ValueParser(trimmed.slice(1)).parseCString() };
    if (trimmed.startsWith('@')) return { type: 'target', data: new ValueParser(trimmed.slice(1)).parseCString() };
    if (trimmed.startsWith('&')) return { type: 'log', data: new ValueParser(trimmed.slice(1)).parseCString() };
  } catch {
    return { type: 'unknown' };
  }

  return { type: 'unknown' };
}
