// Shows live debug values right next to the code they belong to (e.g. "argc" reading "= 1" at
// the end of "mov [argc], ecx") instead of requiring a hover or a manual Watch entry — VS Code's
// built-in "inline values" feature, which (unlike hover) has no generic fallback for a language
// that hasn't registered its own provider.
//
// Deliberately scoped to just the stopped line, not the whole visible viewport: every returned
// InlineValue is resolved via a real "evaluate" DAP request to the debug adapter (session.ts),
// one gdb round-trip each — offering every identifier in the whole visible file on every single
// step would multiply that cost for little benefit, since the stopped line is overwhelmingly
// where you actually want to look.
import * as vscode from 'vscode';
import { TokenType, tokenizeLine } from '@fasm2-studio/server/src/parser/tokenizer';

// mov/add/db/dword/... can never be a register or a source label's value — asking gdb to evaluate
// one always fails ("No symbol table is loaded"/"No symbol \"mov\" in current context"). VS Code
// silently drops a failed InlineValueEvaluatableExpression, so this filter is a pure noise/cost
// reduction, not a correctness fix — but it also means the debug adapter and gdb's own stderr
// don't get a wall of expected-but-noisy rejections every single step, which is confusing to see
// even when harmless. Register names (eax, ebx, ...) are deliberately *not* in this list — those
// are exactly what should still be evaluated.
//
// Built lazily (on the first actual inline-values request, i.e. the first time a debug session
// stops at a breakpoint) rather than at module scope: the four data files behind it total ~250KB
// of JSON, and building this eagerly would mean every extension activation — including ones that
// never start a debug session — pays that parse/Set-construction cost as part of startup.
let neverAValue: Set<string> | undefined;

function getNeverAValue(): Set<string> {
  if (!neverAValue) {
    const directivesData = require('@fasm2-studio/server/src/data/directives.json') as Array<{ name: string }>;
    const formatKeywordsData = require('@fasm2-studio/server/src/data/formatKeywords.json') as Array<{ name: string }>;
    const instructionsData = require('@fasm2-studio/server/src/data/instructions.json') as Array<{ mnemonic: string }>;
    const sizeSpecifiersData = require('@fasm2-studio/server/src/data/sizeSpecifiers.json') as Array<{ name: string }>;
    neverAValue = new Set<string>([
      ...instructionsData.map((i) => i.mnemonic.toLowerCase()),
      ...directivesData.flatMap((d) => d.name.toLowerCase().split(' ')),
      ...formatKeywordsData.map((k) => k.name.toLowerCase()),
      ...sizeSpecifiersData.map((s) => s.name.toLowerCase()),
    ]);
  }
  return neverAValue;
}

export class FasmInlineValuesProvider implements vscode.InlineValuesProvider {
  provideInlineValues(document: vscode.TextDocument, _viewPort: vscode.Range, context: vscode.InlineValueContext): vscode.InlineValue[] {
    // "Typically the end position of the range denotes the line where the inline values are
    // shown" (vscode.d.ts's own doc comment on InlineValueContext.stoppedLocation).
    const line = context.stoppedLocation.end.line;
    if (line < 0 || line >= document.lineCount) return [];

    const neverAValue = getNeverAValue();
    const tokens = tokenizeLine(document.lineAt(line).text, line).filter((t) => t.type === TokenType.Ident && !neverAValue.has(t.text.toLowerCase()));
    return tokens.map((t) => new vscode.InlineValueEvaluatableExpression(new vscode.Range(line, t.startChar, line, t.endChar)));
  }
}
