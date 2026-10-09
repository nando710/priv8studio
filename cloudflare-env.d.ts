declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    CREDENTIAL_ENCRYPTION_KEY?: string;
    ALLOW_PRIVATE_BOOTSTRAP?: string;
    AUTH_MODE?: string;
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_AUD?: string;
    ADMIN_EMAIL?: string;
  }
}
