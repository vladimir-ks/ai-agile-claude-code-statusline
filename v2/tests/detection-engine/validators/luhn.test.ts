/**
 * Luhn Checksum Validator Tests
 */

import { describe, test, expect } from 'bun:test';
import { luhnCheck, isTriviallyCreditCard, creditCardValidator } from '../../../src/lib/detection-engine/validators/luhn';

describe('luhnCheck', () => {
  test('valid Visa test card passes', () => {
    expect(luhnCheck('4111111111111111')).toBe(true);
  });

  test('valid Mastercard test card passes', () => {
    expect(luhnCheck('5500000000000004')).toBe(true);
  });

  test('valid Amex test card passes', () => {
    expect(luhnCheck('378282246310005')).toBe(true);
  });

  test('invalid checksum fails', () => {
    expect(luhnCheck('4111111111111112')).toBe(false);
  });

  test('too short fails', () => {
    expect(luhnCheck('123456')).toBe(false);
  });

  test('strips spaces and dashes', () => {
    expect(luhnCheck('4111 1111 1111 1111')).toBe(true);
    expect(luhnCheck('4111-1111-1111-1111')).toBe(true);
  });

  test('too long (>19 digits) fails', () => {
    expect(luhnCheck('41111111111111111111')).toBe(false);
  });
});

describe('isTriviallyCreditCard', () => {
  test('all zeros is trivial', () => {
    expect(isTriviallyCreditCard('0000000000000000')).toBe(false);
  });

  test('all same digit is trivial', () => {
    expect(isTriviallyCreditCard('5555555555555555')).toBe(false);
  });

  test('sequential ascending is trivial', () => {
    expect(isTriviallyCreditCard('1234567890123456')).toBe(false);
  });

  test('real-looking card number is not trivial', () => {
    expect(isTriviallyCreditCard('4111111111111111')).toBe(true);
  });
});

describe('creditCardValidator', () => {
  test('valid Visa returns 1.0', () => {
    expect(creditCardValidator('4111111111111111', '')).toBe(1.0);
  });

  test('invalid checksum returns 0.0', () => {
    expect(creditCardValidator('4111111111111112', '')).toBe(0.0);
  });

  test('all zeros returns 0.0', () => {
    expect(creditCardValidator('0000000000000000', '')).toBe(0.0);
  });

  test('sequential returns 0.0', () => {
    expect(creditCardValidator('1234567890123456', '')).toBe(0.0);
  });

  test('card with separators validates', () => {
    expect(creditCardValidator('4111 1111 1111 1111', '')).toBe(1.0);
  });
});
