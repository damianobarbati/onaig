/**
 * ECDSA (Identity) & ECDH (Encryption) Service
 * - Algorithm: ECDSA/ECDH with P-256
 * - Public Key: Base64 (Raw Uncompressed)
 * - Private Key: Base64 (JWK) - Exportable only on creation
 * - Signature: Base64
 */

const getCrypto = (): Crypto => {
  if (typeof window !== 'undefined' && window.crypto) return window.crypto;
  return (globalThis as any).crypto;
};

export const cryptoService = {
  create: async (): Promise<{ publicKey: string; publicCryptoKey: CryptoKey; privateKey: string; privateCryptoKey: CryptoKey }> => {
    const crypto = getCrypto();

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

    const publicCryptoKey = keyPair.publicKey;
    const publicKey = await cryptoService.serializePublicKey(publicCryptoKey);

    const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const privateKey = await cryptoService.serializePrivateKey(keyPair.privateKey);
    const privateCryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

    return { publicKey, publicCryptoKey, privateKey, privateCryptoKey };
  },

  import: async (privateKey: string): Promise<{ publicKey: string; publicCryptoKey: CryptoKey; privateKey: string; privateCryptoKey: CryptoKey }> => {
    const crypto = getCrypto();

    const jwk = JSON.parse(atob(privateKey));
    const privateCryptoKey = await cryptoService.deserializePrivateKey(privateKey);

    // reconstruct the public key, removing private part
    const publicJwk = { ...jwk, key_ops: ['verify'] };
    delete publicJwk.d;

    const publicCryptoKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const publicKey = await cryptoService.serializePublicKey(publicCryptoKey);

    return { publicKey, publicCryptoKey, privateKey, privateCryptoKey };
  },

  sign: async (privateKey: CryptoKey, message: string): Promise<string> => {
    const crypto = getCrypto();
    const signatureBuffer = await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey, new TextEncoder().encode(message));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    return signature;
  },

  verify: async (publicKey: CryptoKey, signature: string, message: string): Promise<boolean> => {
    const crypto = getCrypto();
    const signatureBuffer = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    return crypto.subtle.verify({ name: 'ECDSA', hash: { name: 'SHA-256' } }, publicKey, signatureBuffer, new TextEncoder().encode(message));
  },

  serializePublicKey: async (publicKey: CryptoKey): Promise<string> => {
    const crypto = getCrypto();
    const rawPubBuffer = await crypto.subtle.exportKey('raw', publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(rawPubBuffer)));
  },

  deserializePublicKey: async (publicKey: string): Promise<CryptoKey> => {
    const crypto = getCrypto();
    const pubBuffer = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', pubBuffer, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  },

  serializePrivateKey: async (privateKey: CryptoKey): Promise<string> => {
    const crypto = getCrypto();
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    return btoa(JSON.stringify(jwk));
  },

  deserializePrivateKey: async (privateKey: string): Promise<CryptoKey> => {
    const crypto = getCrypto();
    const jwk = JSON.parse(atob(privateKey));
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  },
};

export const sha256 = async (message: string): Promise<string> => {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const result = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return result;
};
