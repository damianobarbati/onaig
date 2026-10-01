# ONAIG

Giano (reverse). Passkey authentication for blockchain.

## Development

Setup:
```sh
fnm install
npm install -g corepack
corepack enable
corepack install
pnpm install
```

Linting:
```sh
pnpm lint # lint
pnpm tsc # typecheck
```

Testing:
```sh
pnpm -r test
```

## Face enrollment compatibility

The face-only pipeline neutralizes background pixels before alignment and resizing, with an inward
margin to exclude uncertain face contours.
The default local provider uses `oath-face-demo-embedding-v5`; previous local
registrations remain stored but require a new enrollment to use this pipeline.
If you use a custom storage key or an HTTP authentication provider, invalidate
previous face templates and enroll again before comparing new embeddings with them.
