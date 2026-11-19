import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { candidateTree, prepareUpdate, verifyRelease } from './prepare-update.mjs';

const migration = (name) => ({ name, digest: 'a'.repeat(64) });
const repository = 'fixture/installation';

function fixture(t, { snapshot = false, conflict = false, reorder = false, unknown = false, executable = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'loginflare-upgrade-fixture-'));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).trim();
    const write = (path, content) => {
        const filename = join(root, path);
        mkdirSync(dirname(filename), { recursive: true });
        writeFileSync(filename, content);
    };
    const commit = (message) => { git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
    const source = (version, custom = false) => {
        write('package.json', JSON.stringify({ version }));
        write('release.json', JSON.stringify({ version }));
        write('wrangler.jsonc', custom ? 'Installation bindings\n' : 'Upstream defaults\n');
        write('src/login.js', 'Original code\n');
        write('obsolete.txt', 'Old file\n');
        write('migrations/0001_base.sql', 'CREATE TABLE base(id);\n');
    };
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'core.autocrlf', 'false');
    const signingKey = join(root, '.git', 'fixture-signing-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey], { stdio: 'pipe', timeout: 15_000 });
    git('config', 'gpg.format', 'ssh');
    git('config', 'gpg.ssh.program', 'ssh-keygen');
    git('config', 'user.signingkey', signingKey);
    git('config', 'commit.gpgsign', 'true');
    source('0.1.0');
    const baseline = { tag: 'v0.1.0', version: '0.1.0', commit: commit('Initial release'), migrations: [migration('0001_base.sql')] };
    git('switch', '-c', 'upstream');
    source('0.1.1');
    write('src/login.js', 'Upstream release change\n');
    write('src/image.bin', Buffer.from([0x00, 0xff, 0x80, 0x0a]));
    rmSync(join(root, 'obsolete.txt'));
    const next = reorder ? '0002_before_fork.sql' : '0003_release.sql';
    write(`migrations/${next}`, 'CREATE TABLE upgraded(id);\n');
    if (executable) {
        write('src/run.sh', '#!/bin/sh\n');
        git('add', 'src/run.sh');
        git('update-index', '--chmod=+x', 'src/run.sh');
        git('config', 'core.filemode', 'false');
    }
    const target = { tag: 'v0.1.1', version: '0.1.1', commit: commit('Next release'), migrations: [...baseline.migrations, migration(next)] };
    git('switch', 'main');
    if (snapshot) {
        git('switch', '--orphan', 'installation');
        source('0.1.0', true);
        if (unknown) write('src/login.js', 'Unknown imported source\n');
        commit('Import template with provisioned bindings');
    } else write('wrangler.jsonc', 'Installation bindings\n');
    write('migrations/0002_fork.sql', 'CREATE TABLE local_data(id);\n');
    write('local.txt', 'Downstream source\n');
    if (conflict) write('src/login.js', 'Downstream source change\n');
    const head = commit('Downstream customization');
    git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
    return { root, git, head, baseline, target };
}

test('a reviewed update preserves downstream configuration and works for both a fork and an installed snapshot', (t) => {
    for (const snapshot of [false, true]) {
        const { root, git, head, baseline, target } = fixture(t, { snapshot });
        const tree = candidateTree(root, head, baseline, target);
        assert.equal(git('show', `${tree}:wrangler.jsonc`), 'Installation bindings');
        assert.equal(git('show', `${tree}:local.txt`), 'Downstream source');
        assert.equal(git('show', `${tree}:src/login.js`), 'Upstream release change');
        assert.equal(git('show', `${tree}:migrations/0002_fork.sql`), 'CREATE TABLE local_data(id);');
        assert.deepEqual(JSON.parse(git('show', `${tree}:.loginflare-upstream.json`)), { tag: target.tag, commit: target.commit });
        assert.equal(git('rev-parse', 'HEAD'), head);
        assert.equal(git('status', '--porcelain'), '');
    }
});

test('conflicts, migration reordering and unknown installation baselines stop before creating an update branch', (t) => {
    for (const [options, message] of [[{ conflict: true }, /src\/login.js/], [{ reorder: true }, /rewrite or reorder/], [{ snapshot: true, unknown: true }, /could not be verified/]]) {
        const { root, git, head, baseline, target } = fixture(t, options);
        assert.throws(() => candidateTree(root, head, baseline, target), message);
        assert.equal(git('branch', '--list', 'loginflare-update/*'), '');
    }
});

function githubFixture({ root, head, baseline, target }) {
    const url = 'https://github.com/fixture/installation/pull/1';
    const branch = `loginflare-update/${target.tag}`;
    const ref = `refs/heads/${branch}`;
    const signed = '2'.repeat(40);
    const state = { main: head, tip: null, allowed: true, refWrites: 0, signedWrites: 0, requests: 0, pr: null,
        commit: { oid: signed, tree: { oid: candidateTree(root, head, baseline, target) }, parents: { nodes: [{ oid: head }] },
            signature: { isValid: true, wasSignedByGitHub: true } }, actor: { login: 'github-actions[bot]', type: 'Bot' } };
    const host = {
        getRelease: (_, tag) => tag === baseline.tag ? baseline : target,
        getRefs: () => `${state.main}\trefs/heads/main${state.tip ? `\n${state.tip}\t${ref}` : ''}`,
        find: () => state.pr,
        api: (_, endpoint, { body, jq }) => {
            if (endpoint === `repos/${repository}/git/refs`) {
                assert.equal(state.tip, null);
                assert.deepEqual(body, { ref, sha: head });
                state.tip = head;
                state.refWrites++;
                return {};
            }
            if (endpoint === `repos/${repository}/commits/${signed}?per_page=1`) {
                assert.match(jq, /author\.login/);
                return state.actor;
            }
            assert.equal(endpoint, 'graphql');
            if (body.query.includes('createCommitOnBranch')) {
                assert.equal(state.tip, head);
                const { fileChanges, ...commitInput } = body.variables.input;
                assert.deepEqual(commitInput, { branch: { repositoryNameWithOwner: repository, branchName: branch }, expectedHeadOid: head,
                    message: { headline: `chore: update Loginflare to ${target.tag}` } });
                state.changes = fileChanges;
                state.signedWrites++;
                state.tip = signed;
                return { data: { createCommitOnBranch: { commit: { oid: signed } } } };
            }
            assert.match(body.query, /signature\s*\{ isValid wasSignedByGitHub \}/);
            assert.deepEqual(body.variables, { owner: 'fixture', name: 'installation', oid: signed });
            state.onVerification?.();
            return { data: { repository: { object: state.commit } } };
        },
        create: (_, repo, headBranch, title, body) => {
            assert.equal(repo, repository);
            assert.equal(headBranch, branch);
            assert.equal(title, 'Update Loginflare to v0.1.1');
            assert.match(body, /0003_release\.sql/);
            state.requests++;
            if (!state.allowed) return null;
            state.pr = { state: 'OPEN', url };
            return url;
        },
    };
    return { url, host, state, signed };
}

test('manual dispatch uses the reviewed binary-safe diff to create one platform-signed bot commit and one PR', (t) => {
    const local = fixture(t);
    const { root, git, head, target } = local;
    const { url, host, state } = githubFixture(local);
    assert.equal(prepareUpdate(root, repository, target.tag, host), url);
    assert.match(prepareUpdate(root, repository, target.tag, host), /already exists/);
    assert.equal(state.refWrites, 1);
    assert.equal(state.signedWrites, 1);
    assert.equal(state.requests, 1);
    assert.deepEqual(state.changes.deletions, [{ path: 'obsolete.txt' }]);
    const additions = new Map(state.changes.additions.map(({ path, contents }) => [path, Buffer.from(contents, 'base64')]));
    assert.deepEqual([...additions.keys()].sort(), ['.loginflare-upstream.json', 'migrations/0003_release.sql', 'package.json', 'release.json', 'src/image.bin', 'src/login.js']);
    assert.deepEqual(additions.get('src/image.bin'), Buffer.from([0x00, 0xff, 0x80, 0x0a]));
    assert.equal(additions.get('src/login.js').toString(), 'Upstream release change\n');
    assert.deepEqual(JSON.parse(additions.get('.loginflare-upstream.json')), { tag: target.tag, commit: target.commit });
    assert.equal(git('rev-parse', 'main'), head);
});

test('a PR permission failure leaves a recoverable review branch bound to the same main commit', (t) => {
    const local = fixture(t);
    const { root, git, head, target } = local;
    const { url, host, state } = githubFixture(local);
    state.allowed = false;
    assert.throws(() => prepareUpdate(root, repository, target.tag, host), /Allow GitHub Actions/);
    state.allowed = true;
    assert.equal(prepareUpdate(root, repository, target.tag, host), url);
    assert.equal(state.refWrites, 1);
    assert.equal(state.signedWrites, 1);
    assert.equal(git('rev-parse', 'main'), head);
    assert.throws(() => prepareUpdate(root, 'another/repo', target.tag, host), /downstream GitHub repository/);
});

test('a retry signs a branch still at main without reserving the branch again', (t) => {
    const local = fixture(t);
    const { url, host, state } = githubFixture(local);
    state.tip = local.head;
    assert.equal(prepareUpdate(local.root, repository, local.target.tag, host), url);
    assert.equal(state.refWrites, 0);
    assert.equal(state.signedWrites, 1);
});

test('new and existing branches require the reviewed tree, exact parent, bot identity and GitHub signature', (t) => {
    const local = fixture(t);
    for (const change of [
        (state) => { state.commit.signature = null; },
        (state) => { state.commit.signature.isValid = false; },
        (state) => { state.commit.signature.wasSignedByGitHub = false; },
        (state) => { state.actor = { login: 'maintainer', type: 'User' }; },
        (state) => { state.commit.tree.oid = '3'.repeat(40); },
        (state) => { state.commit.parents.nodes.push({ oid: '3'.repeat(40) }); },
    ]) {
        for (const existing of [false, true]) {
            const { host, state, signed } = githubFixture(local);
            change(state);
            if (existing) state.tip = signed;
            assert.throws(() => prepareUpdate(local.root, repository, local.target.tag, host), /Verified GitHub Actions signature|expected source and parent/);
            assert.equal(state.requests, 0);
            assert.equal(state.signedWrites, existing ? 0 : 1);
        }
    }
});

test('advancing main or the update branch during verification blocks PR creation', (t) => {
    const local = fixture(t);
    for (const ref of ['main', 'tip']) {
        const { host, state } = githubFixture(local);
        state.onVerification = () => { state[ref] = '3'.repeat(40); };
        assert.throws(() => prepareUpdate(local.root, repository, local.target.tag, host), /moved during verification/);
        assert.equal(state.requests, 0);
    }
});

test('file modes that cannot be represented by the signing API stop before creating a branch', (t) => {
    const local = fixture(t, { executable: true });
    const { host, state } = githubFixture(local);
    assert.throws(() => prepareUpdate(local.root, repository, local.target.tag, host), /file type or mode for src\/run\.sh/);
    assert.equal(state.refWrites, 0);
    assert.equal(state.signedWrites, 0);
    assert.equal(state.requests, 0);
});

test('release selection verifies a published stable tag against its provenance and version', () => {
    const sha = '1'.repeat(40);
    const release = { tag_name: 'v0.1.1', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' };
    const provenance = { format: 1, version: '0.1.1', commit: sha };
    const manifest = { version: '0.1.1', migrations: [migration('0001_base.sql')] };
    assert.equal(verifyRelease(release, provenance, sha, manifest).commit, sha);
    for (const invalid of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.1.1-beta' }, { published_at: null }]) {
        assert.throws(() => verifyRelease({ ...release, ...invalid }, provenance, sha, manifest), /published stable release/);
    }
    assert.throws(() => verifyRelease(release, provenance, '2'.repeat(40), manifest), /do not agree/);
});
