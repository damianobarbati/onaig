import { describe, expect, it } from 'vitest';
import { cryptoService } from './crypto.ts';

describe('cryptoService', () => {
  it('create works', async () => {
    const identity = await cryptoService.create();
    expect(identity).toMatchObject({
      publicKey: expect.any(String),
      publicCryptoKey: expect.any(CryptoKey),
      privateKey: expect.any(String),
      privateCryptoKey: expect.any(CryptoKey),
    });
  });

  it('import works', async () => {
    const identity1 = await cryptoService.create();
    const identity2 = await cryptoService.import(identity1.privateKey);
    expect(identity2).toMatchObject(identity1);
    const signature1 = await cryptoService.sign(identity1.privateCryptoKey, 'xyz');
    const signature2 = await cryptoService.sign(identity2.privateCryptoKey, 'xyz');
    expect(await cryptoService.verify(identity1.publicCryptoKey, signature1, 'xyz')).toEqual(true);
    expect(await cryptoService.verify(identity2.publicCryptoKey, signature2, 'xyz')).toEqual(true);
  });

  it('sign and verify work', async () => {
    const identity = await cryptoService.create();
    const data = 'hello world';
    const signature = await cryptoService.sign(identity.privateCryptoKey, data);
    expect(signature).toEqual(expect.any(String));
    const isValid = await cryptoService.verify(identity.publicCryptoKey, signature, data);
    expect(isValid).toEqual(true);
  });

  it('sign and verify fail', async () => {
    const identity = await cryptoService.create();
    const data = 'hello world';
    const signature = await cryptoService.sign(identity.privateCryptoKey, data);
    const isValid = await cryptoService.verify(identity.publicCryptoKey, signature, 'wrong data');
    expect(isValid).toEqual(false);
  });

  it('import fails', async () => {
    await expect(cryptoService.import('invalid-base64')).rejects.toThrow();
  });
});
