# Security policy

Report suspected vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/CQMHV/loginflare/security/advisories/new). Do not publish credentials, private account data or a working exploit in a public issue. If private reporting is unavailable, open an issue requesting a private contact without vulnerability details.

Include the affected commit or version, deployment configuration with secrets removed, reproduction steps, expected behavior and impact. Use isolated accounts and data. Do not test another operator's deployment without authorization.

This pre-1.0 project maintains the latest revision of `main`; older revisions do not have a separate security backport commitment. Follow repository security advisories and release notes. There is no guaranteed response time or production availability SLA.

Operators must preserve their issuer, D1 database, private R2 key material and media bucket together. Changing the authentication master secret without a reviewed migration can make encrypted credentials unreadable. Signing-key rotation is separate from master-secret rotation.
