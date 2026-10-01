-- DROP SCHEMA public CASCADE; CREATE SCHEMA public;

CREATE TABLE users
(
    id                 UUID PRIMARY KEY     DEFAULT uuidv7(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    passkey_identifier TEXT        NOT NULL UNIQUE,
    passkey_public_key TEXT        NOT NULL,
    public_key         TEXT        NOT NULL UNIQUE -- derived from passkey public key
);

CREATE TABLE webauthn_challenges
(
    challenge   TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN ('registration', 'authentication')),
    identifier  TEXT        NOT NULL,
    user_handle UUID        NOT NULL
);