import { randomBytes } from 'crypto';

const PUBLIC_ID_LENGTH = 11;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// 8 random bytes → 11 base64url chars (64 bits of entropy, no padding).
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url').slice(0, PUBLIC_ID_LENGTH);
}

export function isValidPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
