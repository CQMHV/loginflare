import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newerVersion, stableVersion, updateRepository, upstreamRepository } from '../src/shared/releases.ts';

const provenancePath = '.loginflare-upstream.json';
const actionsBot = 'github-actions[bot]';
const hash = /^[a-f0-9]{40}$/;
const releaseTag = (value) => typeof value === 'string' && value.startsWith('v') && stableVersion(value.slice(1));

function command(program, args, cwd, { encoding = 'utf8', maxBuffer = 8 * 1024 * 1024, env, input } = {}) {
    return spawnSync(program, args, { cwd, encoding, timeout: 120_000, maxBuffer,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, input });
}

function output(result, description) {
    if (result.status !== 0) throw new Error(`${description} failed${result.error ? `: ${result.error.code}` : ''}.`);
    return result.stdout.trim();
}

const git = (root, args, options) => command('git', args, root, options);
const readGit = (root, args, options) => output(git(root, args, options), `git ${args[0]}`);
const showJson = (root, tree, path) => JSON.parse(readGit(root, ['show', `${tree}:${path}`]));

export function verifyRelease(release, provenance, commit, taggedManifest) {
    if (!releaseTag(release?.tag_name) || release.draft !== false || release.prerelease !== false || !release.published_at) {
        throw new Error('The selected version must be a published stable release.');
    }
    const version = release.tag_name.slice(1);
    if (!hash.test(commit) || provenance?.format !== 1 || provenance.commit !== commit || provenance.version !== version || taggedManifest.version !== version) {
        throw new Error('The release tag, provenance and source version do not agree.');
    }
    if (!Array.isArray(taggedManifest.migrations) || taggedManifest.migrations.some(({ name, digest }) => !/^\d+_[\w.-]+\.sql$/.test(name) || !/^[a-f0-9]{64}$/.test(digest))) {
        throw new Error('The release migration list is invalid.');
    }
    return { tag: release.tag_name, commit, version, migrations: taggedManifest.migrations };
}

export function verifyBaseline(root, head, baseline) {
    const local = showJson(root, head, 'release.json');
    if (local.version !== baseline.version) throw new Error('The installation manifest does not match its upstream baseline.');
    const marker = git(root, ['show', `${head}:${provenancePath}`]);
    if (marker.status === 0) {
        const recorded = JSON.parse(marker.stdout);
        if (recorded.tag !== baseline.tag || recorded.commit !== baseline.commit) throw new Error('The recorded upstream baseline does not match the published release.');
        return;
    }
    if (git(root, ['merge-base', '--is-ancestor', baseline.commit, head]).status === 0) return;
    const roots = readGit(root, ['rev-list', '--max-parents=0', head]).split(/\s+/);
    if (roots.length === 1 && !readGit(root, ['diff', '--name-only', baseline.commit, roots[0], '--', '.', ':(exclude)wrangler.jsonc'])) return;
    throw new Error('The source baseline could not be verified. Review and merge the fixed upstream tag manually.');
}

function migrationFiles(root, tree) {
    return readGit(root, ['ls-tree', '-r', tree, '--', 'migrations']).split('\n')
        .filter((line) => /\tmigrations\/\d+_.+\.sql$/.test(line));
}

export function candidateTree(root, head, baseline, target) {
    verifyBaseline(root, head, baseline);
    if (!newerVersion(target.version, baseline.version)) throw new Error('The upstream target must be newer than the installed version.');
    const merge = git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '--allow-unrelated-histories',
        `--merge-base=${baseline.commit}`, head, target.commit]);
    if (merge.status === 1) throw new Error(`Resolve these merge conflicts before updating:\n${merge.stdout.trim().split(/\r?\n/).slice(1).filter(Boolean).join('\n')}`);
    const merged = output(merge, 'Three-way merge');
    if (showJson(root, merged, 'release.json').version !== target.version || showJson(root, merged, 'package.json').version !== target.version) {
        throw new Error('The merged source does not declare the target version.');
    }
    const previous = migrationFiles(root, head);
    const next = migrationFiles(root, merged);
    if (previous.some((entry, index) => entry !== next[index])) throw new Error('The update would rewrite or reorder existing migrations. Review the migration history manually.');

    const directory = mkdtempSync(join(tmpdir(), 'loginflare-update-'));
    const options = { env: { GIT_INDEX_FILE: join(directory, 'index') } };
    try {
        readGit(root, ['read-tree', merged], options);
        const contents = JSON.stringify({ tag: target.tag, commit: target.commit }, null, 4) + '\n';
        const blob = readGit(root, ['hash-object', '-w', '--stdin'], { ...options, input: contents });
        readGit(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${provenancePath}`], options);
        return readGit(root, ['write-tree'], options);
    } finally {
        rmSync(join(directory, 'index'), { force: true });
        rmdirSync(directory);
    }
}

function remoteRelease(root, requested) {
    if (requested && !releaseTag(requested)) throw new Error('Use a stable version tag such as v0.1.1.');
    const suffix = requested ? `tags/${requested}` : 'latest';
    const release = JSON.parse(output(command('gh', ['api', `repos/${upstreamRepository}/releases/${suffix}`], root), 'Reading the published upstream release'));
    if (!releaseTag(release.tag_name) || (requested && requested !== release.tag_name) || release.draft || release.prerelease || !release.published_at) {
        throw new Error('No matching published stable release was found.');
    }
    readGit(root, ['fetch', '--no-tags', `https://github.com/${upstreamRepository}.git`, `refs/tags/${release.tag_name}`]);
    const commit = readGit(root, ['rev-parse', 'FETCH_HEAD^{commit}']);
    const provenance = JSON.parse(output(command('gh', ['release', 'download', release.tag_name, '--repo', upstreamRepository, '--pattern', 'provenance.json', '--output', '-'], root), 'Reading upstream provenance'));
    return verifyRelease(release, provenance, commit, showJson(root, commit, 'release.json'));
}

function findPullRequest(root, repository, branch) {
    const result = command('gh', ['pr', 'list', '--repo', repository, '--base', 'main', '--head', branch, '--state', 'all', '--json', 'url,state', '--limit', '2'], root);
    return JSON.parse(output(result, 'Checking for an existing upgrade pull request'))[0];
}

function githubApi(root, endpoint, { body, jq } = {}) {
    const args = ['api', endpoint];
    if (body) args.push('--method', 'POST', '--input', '-');
    if (jq) args.push('--jq', jq);
    const response = command('gh', args, root, { input: body && JSON.stringify(body) });
    if (response.status !== 0 && /workflow.*(refus|permission)|refus.*workflow/i.test(response.stderr ?? '')) {
        throw new Error('GitHub denied writing workflow files. Merge the fixed upstream tag in a signed review branch using an authorized maintainer account.');
    }
    return JSON.parse(output(response, `GitHub ${endpoint}`));
}

function fileChanges(root, head, tree) {
    const result = git(root, ['diff-tree', '-r', '--no-commit-id', '--raw', '--no-renames', '--no-abbrev', '-z', head, tree], { encoding: null });
    if (result.status !== 0) throw new Error('Could not read the update diff.');
    const entries = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout).split('\0');
    const additions = [], deletions = [];
    for (let index = 0; index < entries.length - 1; index += 2) {
        const [oldMode, newMode, , blob, status] = entries[index].slice(1).split(' ');
        const path = entries[index + 1];
        if (status === 'D') {
            deletions.push({ path });
            continue;
        }
        if (!['A', 'M'].includes(status) || newMode !== '100644' || !['000000', '100644'].includes(oldMode)) {
            throw new Error(`GitHub's signing API cannot reproduce the file type or mode for ${path}. Merge the fixed upstream tag in a signed review branch.`);
        }
        const contents = git(root, ['cat-file', 'blob', blob], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
        if (contents.status !== 0) throw new Error(`Could not read the update file ${path}.`);
        additions.push({ path, contents: contents.stdout.toString('base64') });
    }
    return { additions, deletions };
}

function createSignedCommit(root, api, repository, branch, head, changes, tag) {
    const query = `mutation ($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
    }`;
    const input = { branch: { repositoryNameWithOwner: repository, branchName: branch }, expectedHeadOid: head,
        message: { headline: `chore: update Loginflare to ${tag}` }, fileChanges: changes };
    const response = api(root, 'graphql', { body: { query, variables: { input } } });
    const oid = response.data?.createCommitOnBranch?.commit?.oid;
    if (response.errors?.length || !hash.test(oid)) throw new Error('GitHub did not confirm creation of the signed update commit. Check the update branch before retrying.');
    return oid;
}

function verifySignedCommit(root, api, repository, commit, head, tree) {
    const [owner, name] = repository.split('/');
    const query = `query ($owner: String!, $name: String!, $oid: GitObjectID!) {
        repository(owner: $owner, name: $name) {
            object(oid: $oid) { ... on Commit {
                oid
                tree { oid }
                parents(first: 2) { nodes { oid } }
                signature { isValid wasSignedByGitHub }
            } }
        }
    }`;
    const response = api(root, 'graphql', { body: { query, variables: { owner, name, oid: commit } } });
    const object = response.data?.repository?.object;
    if (response.errors?.length || object?.oid !== commit || object.tree?.oid !== tree
        || object.parents?.nodes?.length !== 1 || object.parents.nodes[0]?.oid !== head) {
        throw new Error('The upgrade branch does not match the expected source and parent. Review it before retrying.');
    }
    const actor = api(root, `repos/${repository}/commits/${commit}?per_page=1`, { jq: '{login:.author.login,type:.author.type}' });
    if (object.signature?.isValid !== true || object.signature.wasSignedByGitHub !== true
        || actor.login !== actionsBot || actor.type !== 'Bot') {
        throw new Error('The upgrade commit lacks a Verified GitHub Actions signature. Review the branch before retrying.');
    }
}

function createPullRequest(root, repository, branch, title, body) {
    const created = command('gh', ['pr', 'create', '--repo', repository, '--base', 'main', '--head', branch, '--title', title, '--body-file', '-'], root, { input: body });
    return created.status === 0 ? created.stdout.trim() : null;
}

export function prepareUpdate(root, repository, requested = '', {
    getRelease = remoteRelease, find = findPullRequest, api = githubApi, create = createPullRequest,
    getRefs = (root, branch) => readGit(root, ['ls-remote', 'origin', 'refs/heads/main', `refs/heads/${branch}`]),
} = {}) {
    const origin = readGit(root, ['config', '--get', 'remote.origin.url']);
    if (!updateRepository(repository) || origin.replace(/\.git$/i, '').toLowerCase() !== `https://github.com/${repository}`.toLowerCase()) {
        throw new Error('Run this workflow from the downstream GitHub repository.');
    }
    const head = readGit(root, ['rev-parse', 'HEAD']);
    const local = showJson(root, head, 'release.json');
    if (!stableVersion(local.version)) throw new Error('The installation does not declare a stable version.');
    const target = getRelease(root, requested);
    if (!newerVersion(target.version, local.version)) return `No newer stable release than v${local.version}.`;
    const branch = `loginflare-update/${target.tag}`;
    const existing = find(root, repository, branch);
    if (existing) return `An update pull request already exists (${existing.state}): ${existing.url}`;
    const baseline = getRelease(root, `v${local.version}`);
    const tree = candidateTree(root, head, baseline, target);
    const previousNames = new Set(baseline.migrations.map(({ name }) => name));
    const pending = target.migrations.filter(({ name }) => !previousNames.has(name));

    const readRefs = () => new Map(getRefs(root, branch).split(/\r?\n/).map((line) => line.split(/\t/).reverse()));
    const remote = readRefs();
    if (remote.get('refs/heads/main') !== head) throw new Error('Downstream main has advanced. Run Prepare Loginflare update again.');
    const ref = `refs/heads/${branch}`;
    let commit = remote.get(ref);
    if (!commit || commit === head) {
        const changes = fileChanges(root, head, tree);
        if (!commit) api(root, `repos/${repository}/git/refs`, { body: { ref, sha: head } });
        commit = createSignedCommit(root, api, repository, branch, head, changes, target.tag);
    }
    verifySignedCommit(root, api, repository, commit, head, tree);
    const checked = readRefs();
    if (checked.get('refs/heads/main') !== head || checked.get(ref) !== commit) {
        throw new Error('The downstream main or signed upgrade branch moved during verification. Rerun the update workflow.');
    }

    const body = [`Update Loginflare from ${baseline.tag} to [${target.tag}](https://github.com/${upstreamRepository}/releases/tag/${target.tag}).`,
        '', `Upstream source: ${target.commit}`, '', 'Official migrations in this update:',
        ...(pending.length ? pending.map(({ name }) => `- ${name}`) : ['- None']), '',
        'Review the changes and run the downstream checks before merging. GitHub may require approval for the CI run. Merging into main publishes through the existing Workers Builds configuration.'].join('\n');
    const url = create(root, repository, branch, `Update Loginflare to ${target.tag}`, body);
    if (url) return url;
    const found = find(root, repository, branch);
    if (!found) throw new Error('The branch is ready. Allow GitHub Actions to create pull requests in repository settings, then run the workflow again.');
    return found.url;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try { console.log(prepareUpdate(process.cwd(), process.env.GITHUB_REPOSITORY, (process.env.LOGINFLARE_TARGET_TAG ?? '').trim())); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
