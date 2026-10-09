declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    CREDENTIAL_ENCRYPTION_KEY?: string;
    ALLOW_PRIVATE_BOOTSTRAP?: string;
  }
}
