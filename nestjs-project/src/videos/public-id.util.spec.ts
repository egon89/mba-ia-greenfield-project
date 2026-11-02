import { generatePublicId, isValidPublicId } from './public-id.util';

describe('public-id util', () => {
  describe('generatePublicId', () => {
    it('should produce 11-char base64url ids accepted by isValidPublicId', () => {
      for (let i = 0; i < 10_000; i++) {
        const id = generatePublicId();
        expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
        expect(isValidPublicId(id)).toBe(true);
      }
    });

    it('should not repeat ids across many calls', () => {
      const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));
      expect(ids.size).toBe(10_000);
    });
  });

  describe('isValidPublicId', () => {
    it('should accept an 11-char id using every base64url character class', () => {
      expect(isValidPublicId('aZ09-_bY8xW')).toBe(true);
    });

    it.each([
      ['too short', 'abc123XYZ_'],
      ['too long', 'abc123XYZ_-q'],
      ['empty', ''],
      ['plus sign (standard base64)', 'abc123XYZ+q'],
      ['slash (standard base64)', 'abc123XYZ/q'],
      ['padding', 'abc123XYZq='],
      ['whitespace', 'abc123XYZ q'],
      ['path traversal', '../../etc/p'],
    ])('should reject %s', (_label, value) => {
      expect(isValidPublicId(value)).toBe(false);
    });
  });
});
