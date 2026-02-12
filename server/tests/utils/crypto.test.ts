import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generateSeed } from '../../src/utils/crypto.js';

describe('crypto utilities', () => {
  describe('encrypt / decrypt', () => {
    it('should roundtrip encrypt and decrypt a string', () => {
      const original = 'my-secret-api-key-12345';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should produce different ciphertext for the same input (random IV)', () => {
      const original = 'same-input';
      const encrypted1 = encrypt(original);
      const encrypted2 = encrypt(original);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should both decrypt to the same value', () => {
      const original = 'same-input';
      const encrypted1 = encrypt(original);
      const encrypted2 = encrypt(original);
      expect(decrypt(encrypted1)).toBe(original);
      expect(decrypt(encrypted2)).toBe(original);
    });

    it('should handle empty strings', () => {
      const encrypted = encrypt('');
      expect(decrypt(encrypted)).toBe('');
    });

    it('should handle unicode strings', () => {
      const original = 'hello 世界 🌍';
      const encrypted = encrypt(original);
      expect(decrypt(encrypted)).toBe(original);
    });

    it('should return non-encrypted strings as-is (migration support)', () => {
      const plaintext = 'not-encrypted-value';
      expect(decrypt(plaintext)).toBe(plaintext);
    });
  });

  describe('generateSeed', () => {
    it('should return a hex string', () => {
      const seed = generateSeed(1, '2026-02-11T00:00:00.000Z');
      expect(seed).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should be deterministic (same input = same output)', () => {
      const seed1 = generateSeed(1, '2026-02-11T00:00:00.000Z');
      const seed2 = generateSeed(1, '2026-02-11T00:00:00.000Z');
      expect(seed1).toBe(seed2);
    });

    it('should produce different seeds for different channels', () => {
      const seed1 = generateSeed(1, '2026-02-11T00:00:00.000Z');
      const seed2 = generateSeed(2, '2026-02-11T00:00:00.000Z');
      expect(seed1).not.toBe(seed2);
    });

    it('should produce different seeds for different block times', () => {
      const seed1 = generateSeed(1, '2026-02-11T00:00:00.000Z');
      const seed2 = generateSeed(1, '2026-02-11T08:00:00.000Z');
      expect(seed1).not.toBe(seed2);
    });
  });
});
