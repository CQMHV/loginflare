import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { candidateTree, prepareUpdate, verifyRelease } from './prepare-update.mjs';

const migration = (name) => ({ name, digest: 'a'.repeat(64) });
const repository = 'fixture/installation';

function fixture(t, { snapshot = false, conflict = false, reorder = false, unknown = false } = {}) {
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
        write('migrations/0001_base.sql', 'CREATE TABLE base(id);\n');
    };
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'core.autocrlf', 'false');
    git('config', 'commit.gpgsign', 'false');
    source('0.1.0');
    const baseline = { tag: 'v0.1.0', version: '0.1.0', commit: commit('Initial release'), migrations: [migration('0001_base.sql')] };
    git('switch', '-c', 'upstream');
    source('0.1.1');
    write('src/login.js', 'Upstream release change\n');
    const next = reorder ? '0002_before_fork.sql' : '0003_release.sql';
    write(`migrations/${next}`, 'CREATE TABLE upgraded(id);\n');
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

test('manual dispatch creates one candidate PR and a repeated invocation returns the same PR', (t) => {
    const { root, git, head, baseline, target } = fixture(t);
    const url = 'https://github.com/fixture/installation/pull/1';
    let pr, pushed = 0, created = 0;
    const host = {
        getRelease: (_, tag) => tag === baseline.tag ? baseline : target,
        getRefs: () => `${head}\trefs/heads/main`,
        find: () => pr,
        push: (_, repo, commit, branch) => {
            assert.equal(repo, repository);
            assert.equal(branch, 'loginflare-update/v0.1.1');
            assert.equal(git('rev-parse', `${commit}^`), head);
            assert.equal(git('show', `${commit}:wrangler.jsonc`), 'Installation bindings');
            pushed++;
        },
        create: (_, repo, branch, title, body) => {
            assert.equal(repo, repository);
            assert.equal(branch, 'loginflare-update/v0.1.1');
            assert.equal(title, 'Update Loginflare to v0.1.1');
            assert.match(body, /0003_release\.sql/);
            created++;
            pr = { state: 'OPEN', url };
            return url;
        },
    };
    assert.equal(prepareUpdate(root, repository, target.tag, host), url);
    assert.match(prepareUpdate(root, repository, target.tag, host), /already exists/);
    assert.equal(pushed, 1);
    assert.equal(created, 1);
    assert.equal(git('rev-parse', 'main'), head);
});

test('a PR permission failure leaves a recoverable review branch bound to the same main commit', (t) => {
    const { root, git, head, baseline, target } = fixture(t);
    const url = 'https://github.com/fixture/installation/pull/1';
    const branch = 'loginflare-update/v0.1.1';
    const ref = `refs/heads/${branch}`;
    git('config', `url.${pathToFileURL(root).href}.insteadOf`, `https://github.com/${repository}.git`);
    let shouldCreate = false, pushes = 0;
    const host = {
        getRelease: (_, tag) => tag === baseline.tag ? baseline : target,
        getRefs: () => git('ls-remote', 'origin', 'refs/heads/main', ref),
        find: () => null,
        push: (_, __, commit) => { git('update-ref', ref, commit); pushes++; },
        create: () => shouldCreate ? url : null,
    };
    assert.throws(() => prepareUpdate(root, repository, target.tag, host), /Allow GitHub Actions/);
    shouldCreate = true;
    assert.equal(prepareUpdate(root, repository, target.tag, host), url);
    assert.equal(pushes, 1);
    assert.equal(git('rev-parse', 'main'), head);
    assert.throws(() => prepareUpdate(root, 'another/repo', target.tag, host), /downstream GitHub repository/);
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
