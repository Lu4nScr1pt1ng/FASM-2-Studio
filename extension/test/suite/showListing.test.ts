// "FASM: Show Listing" end to end, against the real assembler: the command has to produce the
// assembler's own listing text for the program the active file belongs to, and open it somewhere
// that is not a file written into the project.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeTempDir, removeTempDir } from '../tempDir';

function fasm2Available(): boolean {
  const result = spawnSync('fasm2', [], { shell: true, timeout: 3000, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase().includes('flat assembler');
}

const PROGRAM_SRC = [
  'format ELF64 executable 3',
  'entry start',
  '',
  'segment readable executable',
  'start:',
  '\tmov eax, 60',
  '\txor edi, edi',
  '\tsyscall',
  '',
].join('\n');

describe('FASM: Show Listing', () => {
  it('opens the assembler\'s listing for the active program without writing one into the project', async function () {
    if (!fasm2Available()) {
      this.skip();
      return;
    }
    this.timeout(30000);

    const dir = makeTempDir('fasm2-studio-listing-test-');
    const asmPath = path.join(dir, 'prog.asm');
    fs.writeFileSync(asmPath, PROGRAM_SRC, 'utf8');

    try {
      const doc = await vscode.workspace.openTextDocument(asmPath);
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('fasm2Studio.showListing');

      const listing = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'fasm2-listing');
      assert.ok(listing, 'expected a listing document to have been opened');

      const text = listing.getText();
      // The listing's own shape: a bracketed 16-digit address, then the offset-and-bytes column.
      // "mov eax, 60" assembles to B8 3C 00 00 00, which is the encoding worth seeing here.
      assert.match(text, /^\[[0-9A-F]{16}\] [0-9A-F]{8}: B8 3C 00 00 00\s+mov eax, 60$/m);
      assert.match(text, /syscall/);

      // A listing is something to read, not a build artifact: nothing may appear next to the
      // source, and the binary the compile produced belongs in a temp directory too.
      assert.deepStrictEqual(fs.readdirSync(dir), ['prog.asm']);
    } finally {
      await removeTempDir(dir);
    }
  });
});
