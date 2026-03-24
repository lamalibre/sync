# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

If you discover a security vulnerability in Sync, please report it
responsibly through one of these channels:

1. **GitHub Security Advisory** (preferred):
   [Open a private advisory](https://github.com/lamalibre/sync/security/advisories/new)

2. **Email**: security@codelama.dev

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Affected component (sync-server, sync-agent, sync-cli, create-sync, rclone integration)
- Potential impact

### What to Expect

- **Acknowledgment** within 48 hours
- **Status update** within 7 days with an assessment and remediation timeline
- **Credit** in the release notes (unless you prefer to remain anonymous)

### What Qualifies

- rclone credential leakage (rclone.conf exposure, env var injection)
- Storage provider credential theft
- Encryption key leakage or bypass
- Agent enrollment token abuse
- Path traversal in archive/restore operations
- Unauthorized access to sync state or file metadata
- Command injection via rclone invocation
- Insecure default configurations

### Out of Scope

- Denial of service (resource exhaustion)
- Issues requiring physical access to the machine
- Social engineering attacks
- Vulnerabilities in upstream dependencies (report those to the upstream project)
- Vulnerabilities in upstream rclone (report to [rclone.org](https://rclone.org))
- Cloud provider-side issues

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us reasonable time to
address the issue before any public disclosure. We aim to release fixes within
30 days of a confirmed vulnerability.
