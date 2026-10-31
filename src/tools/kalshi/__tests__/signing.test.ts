import { describe, it, expect } from 'bun:test';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { signMessage } from '../api.js';

const MESSAGE = '1700000000000GET/trade-api/v2/portfolio/balance';

describe('signMessage', () => {
  it('signs Ed25519 keys directly', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const sig = Buffer.from(signMessage(MESSAGE, pem), 'base64');

    expect(sig.length).toBe(64);
    expect(verify(null, Buffer.from(MESSAGE), publicKey, sig)).toBe(true);
  });

  it('signs RSA keys with PSS + SHA-256', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

    const sig = Buffer.from(signMessage(MESSAGE, pem), 'base64');

    const ok = verify(
      'sha256',
      Buffer.from(MESSAGE),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      sig,
    );
    expect(ok).toBe(true);
  });
});
