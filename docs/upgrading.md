# Updating and recovering Loginflare

[简体中文](upgrading.zh-CN.md)

The upstream repository maintains source, CI and releases; it does not deploy an account service. Downstream maintainers can modify their Fork and connect it to Cloudflare Workers Builds. After [initial installation](deployment.md), pushes to downstream `main` automatically build, preflight, apply compatible migrations, publish and verify. Routine updates require no separate version confirmation or manual upgrade command.

## Follow a version

The first official release is **0.1.0**. Supported sources have managed release records and private instance storage: the 23-migration baseline `aa10563825c7d7669e8be6d0ebab6aa35c84acf4` and the 27-migration baseline `3d721f99ee7de2cbf9471df298263fec9c9fb6a9`. Older source used the same version number. Identify an installation by its Git commit and migration ledger. Select a fixed tag after the upstream release is published.

## Prepare an update from the admin console

**Version updates** shows the installed version and the latest upstream release. Select **Prepare update on GitHub**, choose downstream `main`, then select **Run workflow**. Enter the version tag shown in the console, or leave it blank for the latest stable release at the time of the run. The workflow creates a pull request for review. Merging triggers deployment.

For first use, enable GitHub Actions in the downstream repository and select **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Approve CI for the bot pull request if GitHub prompts you. The Worker reads public release information and needs no GitHub credential. If the build cannot detect the GitHub repository, set `LOGINFLARE_UPDATE_REPOSITORY` to `owner/repo` in the Wrangler `vars` used by the build.

The workflow verifies the published tag and provenance before merging the version delta. If it reports conflicts, a changed migration order, an unknown baseline or denied workflow-file changes, use a review branch to merge the same tag manually. If the branch exists but PR creation was blocked, correct the repository setting and rerun. Review downstream CI results and instance preflight before merging.

## Synchronize manually

1. Merge the selected upstream version into a development branch. Preserve downstream source, branding, deployment settings and migrations. Resolve conflicts and run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:upgrade` and `pnpm test:e2e`.
2. Optionally run the read-only remote preflight below. Retain a D1 Time Travel recovery point and confirm that the original PRIVATE and AVATARS buckets remain recoverable. These tools do not export accounts or keys.
3. Merging into downstream `main` accepts the update. Workers Builds runs `pnpm build:deploy` and `pnpm run deploy`. The build validates the selected configuration. Publication checks resource ownership and history, takes the release lock, migrates and publishes. Operations regression tests run in GitHub CI and through `pnpm check`.
4. Confirm a successful build and the `verified` publication stage. An installed service must return readiness from the intended build; an initial installation checks that build's liveness before the operator completes setup.

Full GitHub CI gates upstream releases. Downstream GitHub CI and Workers Builds run independently by default: an automatic Cloudflare deployment does not imply that all GitHub tests have finished. No waiting workflow is introduced. Downstreams wanting checks before merges should protect `main` with the appropriate required PR checks.

## Optional tools

Tools ship with the selected source version. Read credentials only from `CLOUDFLARE_API_TOKEN`; never put them in arguments, Git or reports. Use the account-read, Workers, D1 and R2 permissions required by your deployment. Read-only commands do not add permissions or create resources.

```sh
pnpm upgrade:status --remote --account ACCOUNT_ID --worker WORKER
pnpm upgrade:plan --remote --account ACCOUNT_ID --worker WORKER --json
pnpm upgrade:verify --remote --account ACCOUNT_ID --worker WORKER
```

`status` reports blockers; `plan` exits unsuccessfully if blocked. Read-only D1 SELECT statements use the query API's HTTP POST, without write SQL. Reports contain target resource IDs, source commit, version, applied count, pending migrations and digests, last publication stage and blockers. They contain no account profiles or instance secrets.

`targetVersion` identifies the source target; `activeWorker` describes version and commit metadata from live bindings, with unavailable older metadata shown as `null`. Verification from a Git checkout also matches its committed HEAD. Verification from an archive without Git history checks version, migrations, publication records and service consistency only, and reports `sourceVerification: archive-version-only`.

Remote reports list the Wrangler file and environment used in `configuration`. Use the same `LOGINFLARE_CONFIG` and `CLOUDFLARE_ENV` values for planning, building and applying. The default file is `wrangler.jsonc`. Rebuild if the selected configuration or environment changes.

To retry a complete publication manually, use a clean committed checkout matching `origin/main`:

```sh
pnpm build:deploy
pnpm upgrade:apply --remote --account ACCOUNT_ID --worker WORKER
```

Manual and automatic publication share the same implementation and protections. Wrangler `--dry-run` remains a packaging simulation, not a remote preflight.

Use an explicit isolated directory for a local database simulation:

```sh
pnpm upgrade:plan --local --state work/upgrade-demo --json
pnpm upgrade:apply --local --state work/upgrade-demo
pnpm upgrade:verify --local --state work/upgrade-demo
```

Local `apply` exercises database release only: it does not start or publish a Worker. Run `pnpm build` followed by `pnpm test:upgrade` for real old/new Worker protocol tests. The matrix reads immutable Git history; shallow clones must fetch the baseline commits listed in `release.json`. Source archives contain no Git history, so run the historical matrix from a source checkout.

## Migrations and Fork changes

`release.json` pins official version and migration digests. `migrations/online.json` records reviewed compatible online migrations. For 0.1.0, applying 0024–0027 was tested with the 23-migration Worker still serving password login, retained sessions, OIDC PKCE, UserInfo and refresh tokens. The 27-migration baseline passed the same regression. `scripts/upgrade-compatibility.mjs` maintains this evidence. Deeply customized forks require their own validation.

Keep downstream migration names, digests and approvals intact. The acceptance-only `0024_acceptance_probe.sql`, for example, is not official. Append new custom migrations to the complete history, test representative data with your own previous Worker, and register their SHA-256 approvals. Conflicting order or modified applied files block publication; tools do not rename, reorder or delete history. Unreviewed or incompatible changes need a separate maintenance procedure.

Databases from the retired browser-maintenance flow are not automatically adopted. A new Worker refuses business processing if required migrations or instance keys are incomplete. Setup and liveness remain available. Migration checks are cached per instance for 30 seconds; readiness forces a fresh check rather than scanning history on every business request. The target database structure is verified separately before publication.

## Recovery

| Stage or issue | Next step |
| --- | --- |
| Preflight blocked | Check the original Worker, D1, two buckets and migration history. Do not empty the database or regenerate keys. |
| `migrating` | Each migration and ledger entry commit in one D1 transaction. Earlier successful migrations remain. Fix unapplied issues and retry. |
| `publishing` / uncertain upload | Publication may have been accepted; its lock remains until lease expiry. Check active Cloudflare deployments before retrying; do not delete the lock. |
| `published` / `post-processing` | New code is published, but post-processing may be incomplete. Retry publication to resume idempotent work. Applied migrations are retained. |
| `verifying` | New code may be live but its health is unconfirmed. Check active builds and logs, then run `upgrade:verify`. Read-only verification does not rewrite the previous stage; a complete successful retry records `verified`. |
| Worker rollback | Changes code only, not D1 or R2. Restore D1 with Time Travel and verify consistency with original PRIVATE keys and image metadata. |

Public image domains, PRIVATE isolation, issuer and existing bindings remain protected. Synchronizing source does not enable R2 direct delivery. Real upgrades and recovery remain downstream operator actions.

## Upstream releases

After notes, compatibility evidence and CI are ready, create the version tag at the exact `main` commit and manually run **Prepare source release**. It reruns full CI, the historical upgrade matrix and browser tests for that commit, then creates a source archive, `SHA256SUMS`, provenance and a draft Release. It never deploys a service or overwrites an existing Release. Review and publish the draft separately.
