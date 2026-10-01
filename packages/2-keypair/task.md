Creiamo una demo in 2-keypair.

Obiettivi:
- enrollment e authentication
- l'utente deve potersi autenticare su un dispositivo diverso da quello con cui ha fatto enrollment
- l'utente puo usare device di diversi tipi, di diversi sistemi operativi, con diversi browser (eg. macos + windows, android + ios), per fare enrollment e poi authentication
- l'utente può fare authentication su dispositivi diversi da quelli con cui ha fatto enrollment e quindi da questi deve poter recuperare
  la pubkey e privkey (cifrata) con una passphrase che ha generato e fornito in fase di enrollment
- l'utente deve poter cambiare la passphrase con la propria passphrase attuale
- l'utente deve poter cambiare la passphrase con il recoverycode che ha generato e fornito in fase di enrollment

Niente passkey, niente webauthn.

--

Nel flusso di enrollment onaig, il browser genera una coppia di chiavi webcryptokey.
Il cliente invia al server:
- faces
- pubkey
- signature
- privkey cifrata
- recoverycode

```json
{
  "faces": [],
  "pubkey": "<pubkey>",
  "signature": "<signature>",
  "privkey_enc": "<private key cifrata con DEK>", 
  "passphrase_enc": "<DEK cifrata con chiave derivata dalla password>", 
  "recovery_enc": "<DEK cifrata con chiave derivata dal recovery code>" 
}
```

La pubkey è l'id univoco dell'utente; il server registra solo se la signature è stata generata dalla pubkey.

Dopo la registrazione, la privkey viene importata in una nuova cryptokey non esportabile e viene cancellata dalla memoria. 

--

Nel flusso di autenticazione onaig, il browser invia le 3 faces (still e le due random), il server deve ritornare:
- pubkey
- privkey cifrata

Il client decifra la privkey e la importa come non estraibile in cryptokey.  
Il client è autenticato.

--

La privkey viene cifrata con una chiave derivata da una passphrase, non dai `faces`.
La cryptokey viene esportata sia per pubkey che privkey in formato JWK.  
La cryptokey viene usata per generare signature di payload con secp256r1 (P256).

Il client non invia:
- password/passphrase;
- recovery code;
- `DEK` in chiaro;
- private key in chiaro.

### Dati generati dal client

1. **Coppia di chiavi P-256**

```
privateKey
publicKey
```

La public key viene esportata in JWK e diventa l’identificatore dell’utente.

2. **Recovery code**

Generato casualmente con `crypto.getRandomValues()`, mostrato all’utente e mai inviato al server.

3. **DEK**

Una chiave casuale AES-256 usata per cifrare la private key.

4. **Salt dell’account**

Un salt casuale, usato sia per la password sia per il recovery code:

```
KDF(password, salt + "password")
KDF(recoveryCode, salt + "recovery")
```

5. **Password e recovery wrapping**

La DEK viene cifrata due volte:

```
DEK → chiave derivata dalla password
DEK → chiave derivata dal recovery code
```

6. **Private key cifrata**

```
privateKey → DEK
```

Ogni cifratura AES-GCM usa un IV casuale. Gli IV possono essere inclusi direttamente all’inizio dei blob:

```
blob = iv || ciphertext
```

7. **Signature**

La private key firma un payload canonico contenente almeno:

```
{
  "pubkey": "...",
  "faces": ["..."]
}
```

Il server verifica la firma con la public key ricevuta.

### Payload inviato al server

```
{
  "faces": [],
  "pubkey": "<public key JWK>",
  "signature": "<signature>",
  "salt": "<account salt>",
  "privkey_enc": "<iv + private key ciphertext>",
  "password_enc": "<iv + DEK ciphertext>",
  "recovery_enc": "<iv + DEK ciphertext>"
}
```

Il client **non invia**:

- password/passphrase;
- recovery code;
- DEK in chiaro;
- private key in chiaro.

Dopo l’invio, il client può importare la private key in una nuova `CryptoKey` con `extractable: false` e rimuovere i riferimenti ai dati temporanei.
