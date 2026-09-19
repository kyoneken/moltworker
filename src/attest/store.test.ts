import { describe, expect, it } from 'vitest';
import {
  assertMonotonicCounter,
  consumeChallenge,
  getCredential,
  issueChallenge,
  putCredential,
} from './store';
import { createAttestEnv } from './test-utils';

describe('challenge lifecycle', () => {
  it('issues a one-time challenge and consumes it exactly once', async () => {
    const env = createAttestEnv();
    const issued = await issueChallenge(env);

    expect(issued.challengeId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    const consumed = await consumeChallenge(env, issued.challengeId);
    expect(consumed.challenge).toBe(issued.challenge);
    await expect(consumeChallenge(env, issued.challengeId)).rejects.toThrow(/not found or expired/);
  });

  it('rejects unknown challenge ids', async () => {
    const env = createAttestEnv();
    await expect(consumeChallenge(env, 'missing')).rejects.toThrow(/not found or expired/);
  });
});

describe('counter monotonicity', () => {
  it('accepts a strictly increasing counter and rejects replay', () => {
    expect(() => assertMonotonicCounter(0, 1)).not.toThrow();
    expect(() => assertMonotonicCounter(4, 9)).not.toThrow();
    expect(() => assertMonotonicCounter(5, 5)).toThrow(/not increasing/);
    expect(() => assertMonotonicCounter(5, 4)).toThrow(/not increasing/);
    expect(() => assertMonotonicCounter(1, -1)).toThrow(/invalid sign counter/);
  });

  it('persists credentials with an advancing counter', async () => {
    const env = createAttestEnv();
    await putCredential(env, {
      keyId: 'abc',
      publicKey: 'pubkey',
      signCounter: 2,
      env: 'sandbox',
      updatedAt: new Date().toISOString(),
    });
    const stored = await getCredential(env, 'abc');
    expect(stored?.signCounter).toBe(2);
    assertMonotonicCounter(stored!.signCounter, 3);
  });
});
