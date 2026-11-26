import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { themedDialogsOnFirstRun } from '../../src/core/presentation/dialogStyle';

describe('themed dialogs on the first run', () => {
  it('turns them on only when the user never chose a dialog style', () => {
    assert.equal(themedDialogsOnFirstRun('win32', undefined), true);
    assert.equal(themedDialogsOnFirstRun('linux', undefined), true);
    assert.equal(themedDialogsOnFirstRun('win32', 'native'), false, 'a style the user chose stays');
    assert.equal(themedDialogsOnFirstRun('win32', 'custom'), false);
  });

  it("leaves macOS alone: its own dialogs already fit", () => {
    assert.equal(themedDialogsOnFirstRun('darwin', undefined), false);
  });
});
