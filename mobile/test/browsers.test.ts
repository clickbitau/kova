import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, codeComplete, formatCode, sessionIcon } from '../src/logic/browsers.ts';

test('a browser code as it is typed; how long ago; which icon', () => {
  assert.equal(formatCode('qnby'), 'QNBY');
  assert.equal(formatCode('qnbyt'), 'QNBY-T');
  assert.equal(formatCode('qnby tjzh!'), 'QNBY-TJZH');
  assert.equal(formatCode('QNBY-TJZH-EXTRA'), 'QNBY-TJZH');
  assert.equal(codeComplete('QNBY-TJZH'), true);
  assert.equal(codeComplete('QNBY-TJ'), false);
  assert.equal(ago(0, 60_000), 'just now');
  assert.equal(ago(0, 30 * 60_000), '30 min ago');
  assert.equal(ago(0, 3 * 3600_000), '3 h ago');
  assert.equal(sessionIcon('Safari on iPhone'), 'smartphone');
  assert.equal(sessionIcon('Chrome on Mac'), 'computer');
});
