import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters. The defaults are OWASP-recommended and deliberately
 * slow; at a handful of logins per session that cost is invisible.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS);
  } catch {
    // A malformed hash must read as a failed login, never as an error.
    return false;
  }
}
