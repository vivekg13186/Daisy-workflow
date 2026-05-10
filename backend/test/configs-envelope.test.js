// Round-trip test for envelope encryption (KMS_PROVIDER=local).
//
// This test exercises the registry-level encryptSecrets / decryptSecrets
// pair without touching Postgres or the API, so it runs in milliseconds
// and gives us a fast canary if the per-row DEK shape gets broken.
//
//     npm test
//
// Covers:
//   • A typed config (mail.smtp) with one secret field round-trips
//     plaintext → ciphertext → plaintext.
//   • The stored row carries data.__crypto with a wrapped_dek.
//   • The encrypted secret value is in v2 envelope shape
//     ({ __enc:true, v2:true, v:"..." }).
//   • A second encryptSecrets call on already-v2 data is a no-op
//     (no fresh DEK, same ciphertext) — saves a KMS call on idempotent
//     PATCHes.
//   • Rotating the row produces fresh ciphertext + fresh wrapped DEK.
//   • A row with no secrets stays at encryption_version=1 (no DEK).

import { test } from "node:test";
import assert from "node:assert/strict";

// Force the local provider regardless of what the dev's .env has set.
process.env.KMS_PROVIDER = "local";
process.env.CONFIG_SECRET = process.env.CONFIG_SECRET || "test-config-secret-12345678";

const { encryptSecrets, decryptSecrets } = await import("../src/configs/registry.js");

test("smtp config round-trips through envelope encryption", async () => {
  const plaintext = {
    host:     "smtp.example.com",
    port:     587,
    secure:   false,
    username: "user",
    password: "hunter2",
    from:     "noreply@example.com",
  };

  const enc = await encryptSecrets("mail.smtp", plaintext);
  assert.equal(enc.encryption_version, 2, "should be v2 (envelope)");
  assert.equal(typeof enc.kek_id, "string");
  assert.ok(enc.kek_id.startsWith("local:"), "local provider stamps a local: KEK id");

  // Non-secret fields stay plaintext.
  assert.equal(enc.data.host, "smtp.example.com");
  assert.equal(enc.data.port, 587);

  // Secret field is now a v2 envelope.
  assert.equal(enc.data.password.__enc, true);
  assert.equal(enc.data.password.v2, true);
  assert.equal(typeof enc.data.password.v, "string");
  assert.notEqual(enc.data.password.v, "hunter2");

  // Crypto block is present.
  assert.ok(enc.data.__crypto, "row has __crypto block");
  assert.equal(enc.data.__crypto.v, 2);
  assert.equal(enc.data.__crypto.kek_id, enc.kek_id);
  assert.equal(typeof enc.data.__crypto.dek, "string");

  // Decrypt round-trip.
  const dec = await decryptSecrets("mail.smtp", enc.data);
  assert.equal(dec.password, "hunter2", "password decrypts back to plaintext");
  assert.equal(dec.host, "smtp.example.com");
  assert.equal(dec.__crypto, undefined, "__crypto stripped from plaintext map");
});

test("re-encrypting an already-v2 row is a no-op (no fresh DEK)", async () => {
  const enc1 = await encryptSecrets("mail.smtp", {
    host: "h", port: 25, password: "p1",
  });
  const enc2 = await encryptSecrets("mail.smtp", enc1.data);
  // Same wrapped DEK → same ciphertext bytes for the unchanged secret.
  assert.equal(enc2.data.__crypto.dek, enc1.data.__crypto.dek,
    "wrapped DEK should be reused when secrets are unchanged");
  assert.equal(enc2.data.password.v, enc1.data.password.v,
    "ciphertext should be identical when re-encrypting unchanged data");
});

test("changing a secret triggers a fresh DEK and fresh ciphertext", async () => {
  const enc1 = await encryptSecrets("mail.smtp", {
    host: "h", port: 25, password: "p1",
  });
  // Caller supplies a new plaintext password (the v1 of the secret).
  const next = { ...enc1.data, password: "p2-rotated" };
  const enc2 = await encryptSecrets("mail.smtp", next);

  assert.notEqual(enc2.data.__crypto.dek, enc1.data.__crypto.dek,
    "rotating a secret allocates a fresh DEK");
  const dec = await decryptSecrets("mail.smtp", enc2.data);
  assert.equal(dec.password, "p2-rotated");
});

test("config with no secret values stays at v1 (no DEK overhead)", async () => {
  const enc = await encryptSecrets("mqtt", {
    url:      "mqtt://broker.local:1883",
    clientId: "daisy",
    // username + password omitted — no secrets to encrypt.
  });
  assert.equal(enc.encryption_version, 1, "v1 because no secrets");
  assert.equal(enc.kek_id, null);
  assert.equal(enc.data.__crypto, undefined, "no crypto block when nothing is encrypted");
});

test("freeform generic config encrypts only flagged keys", async () => {
  const enc = await encryptSecrets("generic", {
    apiUrl:    "https://api.example.com",
    apiToken:  "tok-abc",
    __secret:  { apiToken: true },
  });
  assert.equal(enc.encryption_version, 2);
  assert.equal(enc.data.apiUrl, "https://api.example.com", "non-secret keys stay plaintext");
  assert.equal(enc.data.apiToken.__enc, true, "flagged key is encrypted");
  assert.equal(enc.data.apiToken.v2, true);

  const dec = await decryptSecrets("generic", enc.data);
  assert.equal(dec.apiToken, "tok-abc");
  assert.equal(dec.apiUrl, "https://api.example.com");
});

test("legacy v1 envelopes decrypt through the back-compat path", async () => {
  // Build a synthetic v1 row by-hand using the legacy API.
  const { encryptValue } = await import("../src/configs/crypto.js");
  const legacyRow = {
    host:     "old-host",
    password: encryptValue("legacy-secret"),
  };
  const dec = await decryptSecrets("mail.smtp", legacyRow);
  assert.equal(dec.password, "legacy-secret",
    "rows written before envelope encryption still decrypt");
});

test("editing a v1 row through encryptSecrets upgrades it to v2", async () => {
  const { encryptValue } = await import("../src/configs/crypto.js");
  const v1 = {
    host:     "old-host",
    port:     25,
    password: encryptValue("legacy-secret"),
  };
  // First decrypt back to plaintext (simulating what the API does on edit).
  const plaintext = await decryptSecrets("mail.smtp", v1);
  // Then re-encrypt.
  const v2 = await encryptSecrets("mail.smtp", plaintext);
  assert.equal(v2.encryption_version, 2);
  assert.equal(v2.data.password.v2, true, "previously-v1 secret is now v2");
  const finalDec = await decryptSecrets("mail.smtp", v2.data);
  assert.equal(finalDec.password, "legacy-secret");
});
