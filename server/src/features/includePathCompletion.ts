// Filename completion inside `include '...'` and `file '...'`.
//
// The rest of completion.ts answers for identifiers — mnemonics, registers, the project's own
// symbols. None of those are ever what belongs inside a quoted path, so a string literal needs a
// completely different answer rather than a differently *ranked* one: the include graph this whole
// server is built on is typed by hand, one quoted path at a time, and until now that was the one
// thing it could not help with.
//
// Directories are resolved exactly the way Workspace.resolveIncludePath (and fasmg itself) resolves
// them: relative to the including file's own directory first, then each fasm2Studio.includePath
// entry in turn. Offering a name that the assembler would not then find would be worse than
// offering nothing.

import * as fs from 'fs';
import * as path from 'path';
import { CompletionItem, CompletionItemKind, Position, TextEdit } from 'vscode-languageserver/node';
import { TokenType, tokenizeLine } from '../parser/tokenizer';

/** Directives whose quoted argument is a path this can complete. `include` pulls in source; `file`
 * pastes a binary blob in place. Both take a path resolved the same way. */
const PATH_DIRECTIVES = new Set(['include', 'file']);

/** Extensions that rank above other files for `include`, since a path being typed there is
 * overwhelmingly a source file. Not a filter: fasmg imposes no extension convention at all, and a
 * project that includes an extensionless file is perfectly ordinary. */
const SOURCE_EXTENSIONS = new Set(['.inc', '.asm', '.fasm', '.fas', '.alm', '.i']);

/** Cap on entries read from one directory. A path completion pointed at something enormous (a build
 * output tree, a whole SDK) should degrade to a truncated list rather than stalling the request. */
const MAX_ENTRIES_PER_DIR = 500;

export interface StringContext {
  /** The quote character that opened the literal. */
  quote: string;
  /** Text between that quote and the cursor. */
  typed: string;
}

export interface IncludePathContext extends StringContext {
  /** The directive that owns this string, lowercased — see PATH_DIRECTIVES. */
  directive: string;
}

/**
 * Whether a string literal opened before the cursor and has not closed yet, mirroring the
 * tokenizer's own rule that a doubled quote is an escaped literal quote rather than a terminator.
 */
function stringIsTerminated(text: string, quote: string): boolean {
  let i = 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return true;
    }
    i++;
  }
  return false;
}

/**
 * The unterminated string literal the cursor sits inside, if any.
 *
 * Worth knowing on its own, separately from the include case below: completing mnemonics and
 * register names inside `db 'some text'` was never right, and this is what lets that be suppressed.
 */
export function stringContext(linePrefix: string): StringContext | undefined {
  const tokens = tokenizeLine(linePrefix, 0);
  const last = tokens[tokens.length - 1];
  if (!last || last.type !== TokenType.String) return undefined;
  // Anything after the literal (even whitespace) means the cursor has left it.
  if (last.endChar !== linePrefix.length) return undefined;
  const quote = last.text[0];
  if (stringIsTerminated(last.text, quote)) return undefined;
  return { quote, typed: last.text.slice(1) };
}

/** The keyword a line's statement starts with, skipping a leading `label:`/`label::` — the same
 * shape completionContext() has to look through for the same reason. */
function statementKeyword(linePrefix: string): string | undefined {
  const tokens = tokenizeLine(linePrefix, 0).filter((t) => t.type !== TokenType.Comment);
  if (tokens.length === 0) return undefined;
  let i = 0;
  if (tokens[0].type === TokenType.Ident && tokens[1]?.type === TokenType.Punct && tokens[1].text === ':') {
    i = tokens[2]?.type === TokenType.Punct && tokens[2].text === ':' ? 3 : 2;
  }
  return tokens[i]?.type === TokenType.Ident ? tokens[i].text.toLowerCase() : undefined;
}

/** The `include`/`file` path being typed at the cursor, or undefined if that isn't what this is. */
export function includePathContext(linePrefix: string): IncludePathContext | undefined {
  const str = stringContext(linePrefix);
  if (!str) return undefined;
  const directive = statementKeyword(linePrefix);
  if (!directive || !PATH_DIRECTIVES.has(directive)) return undefined;
  return { ...str, directive };
}

/** Splits what has been typed into the directory part (already committed) and the partial name the
 * completion should replace. fasmg accepts either separator on any host — Windows-authored sources
 * write `include 'api\kernel32.inc'` — so both count as a boundary. */
function splitTypedPath(typed: string): { dirPart: string; namePart: string } {
  const boundary = Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\'));
  return boundary < 0
    ? { dirPart: '', namePart: typed }
    : { dirPart: typed.slice(0, boundary + 1), namePart: typed.slice(boundary + 1) };
}

/** The directory a file URI lives in, or undefined for a buffer that isn't on disk yet (an untitled
 * document has no directory for a relative include to be relative *to*). */
function containingDir(fromFsPath: string | undefined): string | undefined {
  return fromFsPath ? path.dirname(fromFsPath) : undefined;
}

/**
 * Completions for the path being typed.
 *
 * `searchDirs` is fasm2Studio.includePath, already split — the same list Workspace holds, in the
 * same priority order, so what is offered here is what the assembler would resolve. A name found in
 * more than one base directory is offered once, for the first base that has it: that is the one the
 * compiler would pick, and a duplicate row would suggest a choice the user does not actually have.
 */
export function getIncludePathCompletions(
  ctx: IncludePathContext,
  position: Position,
  fromFsPath: string | undefined,
  searchDirs: readonly string[],
): CompletionItem[] {
  const { dirPart, namePart } = splitTypedPath(ctx.typed);
  const normalizedDirPart = dirPart.replace(/\\/g, '/');

  const bases = [containingDir(fromFsPath), ...searchDirs].filter((dir): dir is string => !!dir);
  if (bases.length === 0) return [];

  // Replaces only the partial name, never the directory part already typed — an edit spanning the
  // whole string would fight with the "/" the user just committed.
  const replaceRange = {
    start: { line: position.line, character: position.character - namePart.length },
    end: position,
  };

  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const rankFiles = ctx.directive === 'include';

  for (const base of bases) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.resolve(base, normalizedDirPart), { withFileTypes: true });
    } catch {
      continue; // a base that has no such subdirectory simply contributes nothing
    }

    for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
      // Dotfiles are configuration and version-control bookkeeping, never something a fasm source
      // includes, and ".git" alone would otherwise dominate the list in every project.
      if (entry.name.startsWith('.')) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);

      const isDir = entry.isDirectory();
      const isSource = SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
      const tier = isDir ? 0 : rankFiles && !isSource ? 2 : 1;

      const item: CompletionItem = {
        label: isDir ? `${entry.name}/` : entry.name,
        kind: isDir ? CompletionItemKind.Folder : CompletionItemKind.File,
        detail: base === bases[0] && fromFsPath ? undefined : `from ${base}`,
        sortText: `${tier}${entry.name.toLowerCase()}`,
        textEdit: TextEdit.replace(replaceRange, isDir ? `${entry.name}/` : entry.name),
      };
      if (isDir) {
        // Committing a directory leaves the path unfinished, so ask the client straight back for
        // what is inside it rather than making the user retype the trigger.
        item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
      }
      items.push(item);
    }
  }

  return items;
}
