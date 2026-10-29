'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

function withElectron(mock, load) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return mock;
    return original.call(this, request, parent, isMain);
  };
  try {
    return load();
  } finally {
    Module._load = original;
  }
}

function loadFresh(file) {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  return require(resolved);
}

test('API keys fail closed if OS encryption is unavailable', () => {
  const setup = withElectron({
    app: {},
    safeStorage: { isEncryptionAvailable: () => false },
  }, () => loadFresh('../src/main/setup.js'));

  assert.throws(() => setup.sealKey('secret'), /secure-storage-unavailable/);
  assert.deepEqual(setup.protectKeys({ openai: 'secret' }), {
    apiKeys: {}, changed: true, blocked: true,
  });
  assert.equal(setup.openKeys({ openai: 'secret' }).openai, '');
});

test('legacy plaintext API keys are encrypted before being returned to a provider', () => {
  const setup = withElectron({
    app: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`test:${plain}`),
      decryptString: (encrypted) => encrypted.toString().replace(/^test:/, ''),
    },
  }, () => loadFresh('../src/main/setup.js'));

  const result = setup.protectKeys({ openai: 'secret' });
  assert.equal(result.changed, true);
  assert.equal(result.blocked, false);
  assert.notEqual(result.apiKeys.openai, 'secret');
  assert.equal(setup.openKeys(result.apiKeys).openai, 'secret');
});

test('old installs receive safer opt-in defaults and keep unrelated preferences', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-config-test-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    possess: true, pcReact: true, jealous: true, watchScreen: true, scale: 0.8,
  }));

  const config = withElectron({ app: { getPath: () => userData } }, () => loadFresh('../src/main/config.js'));
  const loaded = config.load(true);
  assert.equal(loaded.possess, false);
  assert.equal(loaded.pcReact, false);
  assert.equal(loaded.jealous, false);
  assert.equal(loaded.watchScreen, false);
  assert.equal(loaded.scale, 0.8);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).safeDefaultsVersion, 1);
});
