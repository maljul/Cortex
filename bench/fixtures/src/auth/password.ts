// Password hashing. Cost factor is low and has not been revisited.
// Part of the CORTEX benchmark fixture corpus. Not production code.

const COST = 8;

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'bcrypt', cost: COST });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}
