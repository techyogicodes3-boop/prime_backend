import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSmtpPassword} from '../notifications.js';

test('removes display separators from Google app passwords', () => {
  assert.equal(normalizeSmtpPassword('smtp.gmail.com', 'abcd-efgh ijkl-mnop'), 'abcdefghijklmnop');
});

test('does not alter passwords for other SMTP providers', () => {
  assert.equal(normalizeSmtpPassword('smtp.example.com', 'pass-word'), 'pass-word');
});
