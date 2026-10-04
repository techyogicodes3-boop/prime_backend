import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSmtpPassword, smtpTransportOptions} from '../notifications.js';

test('removes display separators from Google app passwords', () => {
  assert.equal(normalizeSmtpPassword('smtp.gmail.com', 'abcd-efgh ijkl-mnop'), 'abcdefghijklmnop');
});

test('does not alter passwords for other SMTP providers', () => {
  assert.equal(normalizeSmtpPassword('smtp.example.com', 'pass-word'), 'pass-word');
});

test('creates consistent Gmail transport settings', () => {
  const options=smtpTransportOptions({SMTP_HOST:'smtp.gmail.com',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_USER:'mailbox@example.com',SMTP_PASSWORD:'abcd-efgh-ijkl-mnop'});
  assert.deepEqual(options.auth,{user:'mailbox@example.com',pass:'abcdefghijklmnop'});
  assert.equal(options.port,587);
  assert.equal(options.secure,false);
  assert.equal(options.requireTLS,true);
});
