import test from 'node:test';
import assert from 'node:assert/strict';
import {enquiryValidationError} from '../enquiry-validation.js';

const valid = {name: 'Paresh', email: 'paresh@example.com', phone: '9876543210', message: 'Please contact me about this service.'};

test('accepts a valid enquiry', () => {
  assert.equal(enquiryValidationError(valid), '');
});

test('requires exactly ten numeric phone digits', () => {
  assert.equal(enquiryValidationError({...valid, phone: '987654321'}), 'Mobile number must contain exactly 10 digits.');
  assert.equal(enquiryValidationError({...valid, phone: '98765 43210'}), 'Mobile number must contain exactly 10 digits.');
  assert.equal(enquiryValidationError({...valid, phone: '98765432100'}), 'Mobile number must contain exactly 10 digits.');
});

test('rejects an invalid email address', () => {
  assert.equal(enquiryValidationError({...valid, email: 'paresh@gmail'}), 'Please enter a valid email address.');
});
