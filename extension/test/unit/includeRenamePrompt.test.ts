// The prompt is read in the second before a rename completes, and it is all the user has to judge
// an edit they are accepting sight unseen — so it has to say how much changes, and say it in the
// singular when only one thing does.
import * as assert from 'assert';
import { updatePromptMessage } from '../../src/includeRenamePrompt';

describe('the include-update prompt says how much is about to change', () => {
  it('counts paths and files', () => {
    assert.ok(updatePromptMessage(3, 7).includes('7 `include` paths in 3 files'), updatePromptMessage(3, 7));
  });

  it('does not say "1 files"', () => {
    const message = updatePromptMessage(1, 1);
    assert.ok(message.includes('1 `include` path in 1 file'), message);
    assert.ok(!message.includes('files'), message);
  });

  it('pluralizes each count independently, since one file can hold several includes', () => {
    assert.ok(updatePromptMessage(1, 2).includes('2 `include` paths in 1 file'), updatePromptMessage(1, 2));
  });
});
