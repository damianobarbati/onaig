# PassKey

## Quick start

The PoC uses a dockerized `postgresql` database and `anvil` blockchain:
- Postgres available at: `postgresql://user:password@localhost:5432/onaig`
- RPC Anvil available at: `http://127.0.0.1:8545`

To start, install deps with `pnpm i` in the root folder, then:
```sh
pnpm -F passkey env:down
pnpm -F passkey env:up
pnpm -F passkey bc:compile
pnpm -F passkey dev
# start ngrok!
```

To demo:
```sh
pnpm -F passkey api
pnpm -F passkey build
pnpm -F passkey preview
```

## About

In this PoC we cover the following use case:
- The business operates a service blockchain-based using a private polygon chain
- Users can register to the service using a passkey, their derived public_key is used to identify them
- Users are created with a balance of 10_000 units
- Users can send funds to any other identified by his corresponding derived publickey
- The server is responsible for:
  - deploying the smart contract
  - acting as a relay for transactions issued directly from the browser

The client interface exposes the following sections.

Auth sections:
- registration button
- login button
- forget button

Contract section for the current user:
- button to register the user on the smart contract (if non esisting)
- balance of current user

Contract section with features:
- list of users in table format with their: passkey identifier (string), public_key (hex string), balance (int)
- users can send funds to any other user clicking on the action "send funds" on the user row, window.prompt will ask for the amount  
- amounts are refreshed on any change

## 1. Enrollment

The client:
- derives a deterministic PRF salt from `ONAIG/PRF/v1/<RP_ID>`, where `RP_ID` is the current hostname
- generates a Passkey with PRF extension.  
- generates a derived webcryptokey non-exportable, and exports the public key
- geneates a signature of the public key, signed with the derived webcryptokey

The client then registers on the server providing:
- passkey_identifier
- passkey_public_key
- other data to complete the passkey registration flow

## 2. Authentication

The client uses a discoverable passkey with a single WebAuthn assertion. The deterministic RP-scoped salt is known before authentication, so the PRF result and the same derived application key can be computed immediately on any device that provides the synced passkey.

## 3. Blockchain interaction

The user can interact with the blockchain using the derived pubkey.  
He generates transactions signed with the derived webcryptokey (using secp256r1), 
the server expose an endpoint /relay to relay the transaction to the blockchain.  
The blockchain can verify the signature using the address at 0x100 (RIP-7212).   


## Nota bene

In this MVP:
- The server has a funded wallet to pay for the gas fees of the transactions, we're not using ERC-4337.
- The server does not verify the signature of the transactions, it just relays them to the blockchain.
