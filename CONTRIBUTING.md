# Contributing

Describe the problem and intended behavior in an existing issue, or open one when none covers it. Keep unrelated changes separate. Report vulnerabilities through [the security policy](SECURITY.md).

Use the pinned Node and pnpm versions in `package.json`. Follow the README's local setup, then run `pnpm check` and the affected browser flows with `pnpm test:e2e`. Tests use isolated local data and simulated mail. Do not use production accounts, resources or credentials for tests.

Preserve the existing OIDC, account-security and administrator boundaries. Add regression coverage for changed behavior, including concurrency when changing grants, credentials or authority. Update both language variants of affected public documentation and UI text.

Append database migrations; never modify files already applied by another deployment. Online migrations must allow the previous Worker to continue serving, pass representative-data tests and have an independently reviewed digest in `migrations/online.json`. Incompatible migrations need a documented maintenance procedure.

Before a release, verify version metadata, migration checksums, generated third-party notices, build artifacts and release notes. Document behavior changes, supported upgrade sources, verification and recovery. A Worker rollback does not undo D1 or R2 changes. Publishing, tags and remote deployments are separate operator actions.
