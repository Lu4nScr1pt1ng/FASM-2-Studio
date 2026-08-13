// Registers the memory-operand hover with VS Code. All the behaviour is in memoryOperand.ts, which
// is kept free of any `vscode` import so it can be tested without a running editor.

import * as vscode from 'vscode';
import { memoryOperandAt } from './memoryOperand';

export class FasmEvaluatableExpressionProvider implements vscode.EvaluatableExpressionProvider {
  provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.EvaluatableExpression | undefined {
    const operand = memoryOperandAt(document.lineAt(position.line).text, position.character);
    // Returning nothing restores VS Code's own word-under-cursor fallback exactly, which already
    // resolves a bare register or label well — the debug adapter special-cases both.
    if (!operand) return undefined;

    const range = new vscode.Range(position.line, operand.startChar, position.line, operand.endChar);
    return new vscode.EvaluatableExpression(range, operand.expression);
  }
}
