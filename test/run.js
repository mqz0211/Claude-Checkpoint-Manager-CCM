#!/usr/bin/env node
'use strict';

/**
 * Minimal, dependency-free smoke test. Not a substitute for a full
 * test suite (contributions welcome!) but enough to catch a broken
 * release: it exercises init -> save -> save -> restore against a
 * throwaway git repo and asserts the file contents end up correct.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const CCM_BIN = path.join(__dirname, '..', 'bin', 'ccm.js');

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-test-'));
  console.log(`test workspace: ${dir}`);

  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'test@example.com'], dir);
  sh('git', ['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-qm', 'init'], dir);

  sh('node', [CCM_BIN, 'init'], dir);
  assert.ok(fs.existsSync(path.join(dir, '.ccm', 'checkpoints.json')), 'store created');

  sh('node', [CCM_BIN, 'save', 'first'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
  sh('node', [CCM_BIN, 'save', 'second'], dir);

  const statusOut = sh('node', [CCM_BIN, 'status'], dir);
  assert.ok(statusOut.includes('first'), 'status shows checkpoint 1');
  assert.ok(statusOut.includes('second'), 'status shows checkpoint 2');

  sh('node', [CCM_BIN, 'restore', '--step', '1'], dir);
  const content = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
  assert.strictEqual(content, 'v1', 'file content restored to checkpoint 1');

  const log = sh('git', ['log', '--oneline'], dir).trim().split('\n');
  assert.strictEqual(log.length, 1, 'visible git log untouched by ccm');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ALL TESTS PASSED');
}

main();
