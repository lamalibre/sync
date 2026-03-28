/**
 * Sanitize rclone error messages to remove potential credential paths and config content.
 *
 * Shared between sync-server and sync-agent so that error sanitization is consistent.
 * rclone errors can include config file paths and partial credential information.
 */
export function sanitizeRcloneError(msg: string): string {
  return msg
    // Strip URL credentials (e.g. https://key:secret@endpoint/bucket)
    .replace(/:\/\/[^@\s]+@/g, '://***@')
    // Strip absolute file paths (Unix and Windows)
    .replace(/\/[^\x00-\x1f:*?"<>|]+\.(conf|cfg|ini|key|json|pem|env|bak|p12|toml)/g, '<redacted-path>')
    .replace(/[A-Z]:\\[\w.\\ -]+\.(conf|cfg|ini|key|json|pem|env|bak|p12|toml)/gi, '<redacted-path>')
    // Strip anything that looks like a credential key=value pair
    .replace(
      /(access_key_id|secret_access_key|password|access_token|refresh_token|session_token|client_secret|client_id|app_key|account_key|service_account_key|application_key|storage_account_key)\s*=\s*\S+/gi,
      '$1=<redacted>',
    )
    // Catch remaining key=value pairs where the key starts with a credential-related substring
    .replace(
      /\b(api_key|auth_token|bearer_token|private_key)\s*=\s*\S+/gi,
      '<redacted-credential>',
    )
    // Limit length to prevent excessive error storage
    .slice(0, 2048);
}
