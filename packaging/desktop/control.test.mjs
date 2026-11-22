import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsFailure, serializeControlError } from './control-errors.mjs';

const messages = {
  'default-model': 'Could not save the default model. Refresh the model list and retry.',
  'catalog-accept': 'The held catalog could not be applied. Refresh the model list and retry.',
  'catalog-reject': 'The held catalog could not be discarded. Refresh the model list and retry.',
};

function settingsFailure(action) {
  return serializeControlError(action, new SettingsFailure([{
    path: 'agent/settings.json',
    error: Object.assign(new Error('fixture'), { code: 'EISDIR', syscall: 'open' }),
  }]), messages);
}

test('control failure serialization reports the local cause for default-model', () => {
  assert.equal(settingsFailure('default-model'), 'agent/settings.json: EISDIR (open)');
});

test('control failure serialization reports the local cause for catalog accept and reject', () => {
  assert.equal(settingsFailure('catalog-accept'), 'agent/settings.json: EISDIR (open)');
  assert.equal(settingsFailure('catalog-reject'), 'agent/settings.json: EISDIR (open)');
});

test('control failure serialization keeps the generic catalog fallback without a local cause', () => {
  assert.equal(serializeControlError('catalog-accept', new Error('not a file fact'), messages), messages['catalog-accept']);
});

test('control failure serialization preserves the generic prefix for other local causes', () => {
  const error = Object.assign(new Error('fixture'), { code: 'EISDIR', syscall: 'open', path: 'agent/settings.json' });
  assert.equal(serializeControlError('provider-key', error, { 'provider-key': 'Could not save the provider key.' }), 'Could not save the provider key.\nagent/settings.json: EISDIR (open)');
});
