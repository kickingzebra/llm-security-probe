'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  runPromptfoo,
  PROMPTFOO_VERSION
} = require('../src/promptfoo-runner');

// ─────────────────────────────────────────────────────────────────────────────
// Spawn stub helpers — mimic the child_process.spawn API surface we use.
// ─────────────────────────────────────────────────────────────────────────────

function makeChild({ stdout = '', stderr = '', exitCode = 0, throwAt = null, hangForever = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.emit('exit', null, signal || 'SIGTERM');
  };

  if (hangForever) return child;

  setImmediate(() => {
    if (throwAt === 'error') {
      child.emit('error', new Error('spawn ENOENT npx'));
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('exit', exitCode);
  });

  return child;
}

function makeSpawnStub(behavior = {}) {
  const calls = [];
  function spawnStub(command, args, options) {
    calls.push({ command, args, options });
    return makeChild(behavior);
  }
  spawnStub.calls = calls;
  return spawnStub;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PROMPTFOO_VERSION is a non-empty pinned string (no @latest drift)', () => {
  assert.equal(typeof PROMPTFOO_VERSION, 'string');
  assert.ok(PROMPTFOO_VERSION.length > 0, 'PROMPTFOO_VERSION must be set');
  assert.notEqual(PROMPTFOO_VERSION, 'latest', 'must be pinned, not @latest');
  assert.match(PROMPTFOO_VERSION, /^\d+\.\d+\.\d+$/, 'must look like semver x.y.z');
});

test('happy path: spawns npx promptfoo@<pin> eval --config <path> --output <path>', async () => {
  const spawnStub = makeSpawnStub({ stdout: 'eval done\n', exitCode: 0 });
  const result = await runPromptfoo({
    configPath: 'redteam.yaml',
    outputPath: 'local-data/runs/output.json',
    spawnImpl: spawnStub
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputPath, 'local-data/runs/output.json');
  assert.equal(result.stdout, 'eval done\n');

  assert.equal(spawnStub.calls.length, 1);
  const call = spawnStub.calls[0];
  assert.equal(call.command, 'npx');
  assert.deepEqual(call.args.slice(0, 2), [`promptfoo@${PROMPTFOO_VERSION}`, 'eval']);
  assert.ok(call.args.includes('--config'));
  assert.ok(call.args.includes('redteam.yaml'));
  assert.ok(call.args.includes('--output'));
  assert.ok(call.args.includes('local-data/runs/output.json'));
});

test('with providers: appends --providers <p1> <p2> for each provider', async () => {
  const spawnStub = makeSpawnStub({ exitCode: 0 });
  await runPromptfoo({
    configPath: 'redteam.yaml',
    outputPath: 'out.json',
    providers: ['ollama:chat:gemma3:12b', 'ollama:chat:qwen3.5:27b'],
    spawnImpl: spawnStub
  });

  const args = spawnStub.calls[0].args;
  const providersIdx = args.indexOf('--providers');
  assert.notEqual(providersIdx, -1, '--providers flag must be present');
  assert.equal(args[providersIdx + 1], 'ollama:chat:gemma3:12b');
  assert.equal(args[providersIdx + 2], 'ollama:chat:qwen3.5:27b');
});

test('non-zero exit code: returns ok=false with the exit code', async () => {
  const spawnStub = makeSpawnStub({ stderr: 'plugin not found\n', exitCode: 2 });
  const result = await runPromptfoo({
    configPath: 'redteam.yaml',
    outputPath: 'out.json',
    spawnImpl: spawnStub
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, 'plugin not found\n');
});

test('spawn throws (ENOENT npx): returns ok=false with code=spawn_failed', async () => {
  const spawnStub = makeSpawnStub({ throwAt: 'error' });
  const result = await runPromptfoo({
    configPath: 'redteam.yaml',
    outputPath: 'out.json',
    spawnImpl: spawnStub
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'spawn_failed');
  assert.match(result.error.message, /ENOENT|npx|spawn/);
});

test('captures multi-chunk stdout and stderr', async () => {
  // Custom factory that emits multiple chunks before exit
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('chunk1 '));
      child.stdout.emit('data', Buffer.from('chunk2'));
      child.stderr.emit('data', Buffer.from('warn1 '));
      child.stderr.emit('data', Buffer.from('warn2'));
      child.emit('exit', 0);
    });
    return child;
  }

  const result = await runPromptfoo({
    configPath: 'redteam.yaml',
    outputPath: 'out.json',
    spawnImpl
  });

  assert.equal(result.stdout, 'chunk1 chunk2');
  assert.equal(result.stderr, 'warn1 warn2');
});

test('missing configPath: returns ok=false with code=missing_param', async () => {
  const result = await runPromptfoo({
    outputPath: 'out.json',
    spawnImpl: makeSpawnStub()
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_param');
  assert.match(result.error.message, /configPath/);
});

test('missing outputPath: returns ok=false with code=missing_param', async () => {
  const result = await runPromptfoo({
    configPath: 'redteam.yaml',
    spawnImpl: makeSpawnStub()
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_param');
  assert.match(result.error.message, /outputPath/);
});

test('timeout: kills child and returns code=timeout', async () => {
  const spawnStub = makeSpawnStub({ hangForever: true });
  const result = await runPromptfoo({
    configPath: 'redteam.yaml',
    outputPath: 'out.json',
    timeoutMs: 30,
    spawnImpl: spawnStub
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.match(result.error.message, /30ms|timeout/i);
});
