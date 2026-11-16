import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInventory, compareInventories } from '../web/model.mjs';

test('compares lockfiles while preserving multiple installed versions', () => {
  const parse = packages => parseInventory(JSON.stringify({ lockfileVersion: 3, packages }), 'package-lock.json').packages;
  const old = parse({ '': {}, 'node_modules/a': { version: '1.0.0' },
    'node_modules/removed': { version: '1.0.0' }, 'node_modules/parent/node_modules/a': { version: '1.1.0' } });
  const current = parse({ '': {}, 'node_modules/a': { version: '2.0.0' },
    'node_modules/parent/node_modules/a': { version: '1.1.0' }, 'node_modules/new': { version: '3.0.0' } });
  const result = compareInventories(current, old);
  assert.deepEqual(current.map(row => [row.name, row.version, result.changes.get(row.key)]),
    [['a','1.1.0','unchanged'],['a','2.0.0','changed'],['new','3.0.0','added']]);
  assert.deepEqual(result.removed.map(row => [row.name,row.version,row.status]),
    [['a','1.0.0','version removed'], ['removed','1.0.0','package removed']]);
});

test('does not group identical names across package ecosystems', () => {
  const before = parseInventory('shared==1.0', 'requirements.txt').packages;
  const after = parseInventory(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/shared': { version: '1.0' } } }), 'package-lock.json').packages;
  const result = compareInventories(after, before);
  assert.equal(result.changes.get(after[0].key), 'added');
  assert.equal(result.removed[0].status, 'package removed');
});
