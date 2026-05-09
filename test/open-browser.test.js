'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildOpenCommand, openBrowser } = require('../src/open-browser');

test('buildOpenCommand: darwin uses open', () => {
  assert.deepEqual(buildOpenCommand('http://127.0.0.1:3025/live.html', 'darwin'), {
    command: 'open',
    args: ['http://127.0.0.1:3025/live.html']
  });
});

test('buildOpenCommand: linux uses xdg-open', () => {
  assert.deepEqual(buildOpenCommand('http://127.0.0.1:3025/live.html', 'linux'), {
    command: 'xdg-open',
    args: ['http://127.0.0.1:3025/live.html']
  });
});

test('buildOpenCommand: win32 uses cmd /c start', () => {
  assert.deepEqual(buildOpenCommand('http://127.0.0.1:3025/live.html', 'win32'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'http://127.0.0.1:3025/live.html']
  });
});

test('buildOpenCommand: unsupported platform throws', () => {
  assert.throws(
    () => buildOpenCommand('http://127.0.0.1:3025/live.html', 'plan9'),
    /unsupported platform/i
  );
});

test('openBrowser: spawns platform opener and unrefs child', async () => {
  let seen;
  let unrefCalled = false;

  await openBrowser('http://127.0.0.1:3025/live.html', {
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      seen = { command, args, options };
      const child = new EventEmitter();
      child.unref = () => {
        unrefCalled = true;
      };
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });

  assert.deepEqual(seen, {
    command: 'xdg-open',
    args: ['http://127.0.0.1:3025/live.html'],
    options: { detached: true, stdio: 'ignore' }
  });
  assert.equal(unrefCalled, true);
});
