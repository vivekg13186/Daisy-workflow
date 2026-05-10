// AWS KMS provider.
//
// Uses the v3 AWS SDK (`@aws-sdk/client-kms`). The SDK is imported
// LAZILY inside `create()` so the dependency stays optional — local
// dev (KMS_PROVIDER=local, the default) doesn't need it installed at
// all. The first time you run with KMS_PROVIDER=aws, npm will yell if
// the package isn't there; install with:
//
//     npm install @aws-sdk/client-kms
//
// Required env vars:
//
//     KMS_KEY_ID       arn:aws:kms:us-east-1:123:key/abcd-...
//                      (or an alias like alias/daisy-prod)
//     AWS_REGION       us-east-1
//
// Auth uses the standard AWS credential chain — IAM role on EC2 / ECS
// / EKS, or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY as a fallback
// for local prod-style testing. Daisy doesn't ship its own IAM
// boilerplate; that lives in your Terraform / CDK.
//
// The IAM role attached to your runtime needs three actions on the
// key (or four if you ever call ReEncrypt):
//
//     kms:GenerateDataKey   (write path)
//     kms:Decrypt           (read path)
//     kms:DescribeKey       (boot-time sanity check, optional)
//
// EncryptionContext:
//   We pass `{ "app": "daisy-dag" }` on every call so a leaked
//   wrapped-DEK can't be replayed against this KMS key from another
//   app that happens to share the same IAM role. Callers can extend
//   this map per-row (e.g. `config_id`, `tenant_id`) if they want
//   stricter binding — see secrets/kms.js for the hook.
//
// Latency:
//   AWS KMS is ~5-15ms per call in-region. With per-execution caching
//   in loadConfigsMap a 50-node workflow that touches 5 configs makes
//   5 calls total, not 50.

import { log } from "../../utils/logger.js";

const APP_CONTEXT = { app: "daisy-dag" };

export async function create() {
  const keyId  = process.env.KMS_KEY_ID;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!keyId) {
    throw new Error(
      "KMS_PROVIDER=aws requires KMS_KEY_ID (an AWS KMS key ARN or alias)",
    );
  }
  if (!region) {
    throw new Error(
      "KMS_PROVIDER=aws requires AWS_REGION (or AWS_DEFAULT_REGION)",
    );
  }

  // Lazy import — keep @aws-sdk out of the dev install.
  let SDK;
  try {
    SDK = await import("@aws-sdk/client-kms");
  } catch (e) {
    throw new Error(
      "KMS_PROVIDER=aws requires @aws-sdk/client-kms. Install with " +
      "`npm install @aws-sdk/client-kms`. Original: " + e.message,
    );
  }
  const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = SDK;

  const client = new KMSClient({ region });
  log.info("[kms:aws] client ready", { region, keyId });

  return {
    id:    "aws",
    kekId: keyId,

    async generateDataKey() {
      const cmd = new GenerateDataKeyCommand({
        KeyId:   keyId,
        KeySpec: "AES_256",
        EncryptionContext: APP_CONTEXT,
      });
      const out = await client.send(cmd);
      // Plaintext arrives as a Uint8Array; tighten to Node Buffer for
      // our crypto APIs and ergonomic .fill(0) zeroing.
      return {
        plaintextDek: Buffer.from(out.Plaintext),
        wrappedDek:   Buffer.from(out.CiphertextBlob),
        kekId:        out.KeyId || keyId,
      };
    },

    async decrypt(wrappedDek, _kekId) {
      // KMS resolves the right KEK from the ciphertext blob itself —
      // we don't have to hand it the kekId. We pass the same
      // EncryptionContext we used at GenerateDataKey time; if it
      // doesn't match, KMS rejects.
      const cmd = new DecryptCommand({
        CiphertextBlob:    Buffer.isBuffer(wrappedDek) ? wrappedDek : Buffer.from(wrappedDek),
        EncryptionContext: APP_CONTEXT,
      });
      const out = await client.send(cmd);
      return Buffer.from(out.Plaintext);
    },

    async shutdown() {
      try { client.destroy(); } catch { /* sdk version dependent */ }
    },
  };
}
