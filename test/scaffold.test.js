'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Scaffold smoke test — proves the test runner + CI gate are wired.
// Real tests land in PR-A2 onward; each PR ships a failing test first.
test('scaffold: test runner is wired', () => {
  assert.equal(1, 1);
});
