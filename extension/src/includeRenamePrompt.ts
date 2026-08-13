// What the include-update prompt says. Kept free of any `vscode` import — the pattern the other
// wording-only modules here follow — so the sentence can be asserted without a running editor.
//
// It carries more weight than its length suggests: it is shown for the moment a rename is held
// open, and it is all the user has to judge an edit they are accepting sight unseen. So it names
// how many paths, in how many files, rather than asking a vague "update includes?".

/** The question asked before rewriting anything, minus the MESSAGE_PREFIX its caller adds. */
export function updatePromptMessage(fileCount: number, editCount: number): string {
  const includes = `${editCount} \`include\` path${editCount === 1 ? '' : 's'}`;
  const files = `${fileCount} file${fileCount === 1 ? '' : 's'}`;
  return `update ${includes} in ${files} to match this rename?`;
}
