import { partContentLength, partCount } from './upload-parts.util';

const PART_SIZE = 5_242_880;

describe('upload-parts util', () => {
  describe('partCount', () => {
    it.each([
      ['an exact multiple of the part size', PART_SIZE * 3, 3],
      ['a size with a remainder', PART_SIZE * 2 + 1, 3],
      ['a file smaller than one part', 1_000, 1],
    ])('handles %s', (_case, size, expected) => {
      expect(partCount(size, PART_SIZE)).toBe(expected);
    });
  });

  describe('partContentLength', () => {
    it('gives every part the full part size when the size is an exact multiple', () => {
      const size = PART_SIZE * 3;
      expect(
        [1, 2, 3].map((n) => partContentLength(n, size, PART_SIZE)),
      ).toEqual([PART_SIZE, PART_SIZE, PART_SIZE]);
    });

    it('gives the last part the remainder', () => {
      const size = PART_SIZE + 1_048_576;
      expect(partContentLength(1, size, PART_SIZE)).toBe(PART_SIZE);
      expect(partContentLength(2, size, PART_SIZE)).toBe(1_048_576);
    });

    it('gives the only part the whole file when it is smaller than one part', () => {
      expect(partContentLength(1, 1_000, PART_SIZE)).toBe(1_000);
    });

    it('adds up to the file size across all parts', () => {
      const size = PART_SIZE * 4 + 12_345;
      const count = partCount(size, PART_SIZE);
      let total = 0;
      for (let n = 1; n <= count; n++) {
        total += partContentLength(n, size, PART_SIZE);
      }
      expect(total).toBe(size);
    });
  });
});
