import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = join(import.meta.dir, 'vercel-ignore.sh');

let repo: string;

const git = (...args: string[]): string => {
	const run = Bun.spawnSync(['git', ...args], { cwd: repo });
	if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	return run.stdout.toString().trim();
};

/** Commits one file and returns the new commit's SHA. */
const commit = (file: string, content: string): string => {
	const path = join(repo, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	git('add', '-A');
	git('commit', '-q', '-m', `change ${file}`);
	return git('rev-parse', 'HEAD');
};

/** Runs the script the way Vercel does: from the project root, apps/web. */
const run = (previous?: string): number => {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env.VERCEL_GIT_PREVIOUS_SHA;
	if (previous) env.VERCEL_GIT_PREVIOUS_SHA = previous;
	return Bun.spawnSync(['bash', script], { cwd: join(repo, 'apps/web'), env }).exitCode;
};

// Its own repository in a temp dir, so this repo's history is never touched.
beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'vercel-ignore-'));
	git('init', '-q');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	git('config', 'commit.gpgsign', 'false');
	commit('apps/web/src/index.ts', 'a');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('vercel-ignore.sh', () => {
	test('a commit touching only apps/api is skipped', () => {
		const before = git('rev-parse', 'HEAD');
		commit('apps/api/src/server.ts', 'api');
		expect(run(before)).toBe(0);
	});

	test('with no previous SHA it compares against HEAD^', () => {
		expect(run()).toBe(0);
	});

	test('a commit touching packages/contracts is built', () => {
		const before = git('rev-parse', 'HEAD');
		commit('packages/contracts/src/room.ts', 'contract');
		expect(run(before)).toBe(1);
	});

	test('a commit touching apps/web is built', () => {
		const before = git('rev-parse', 'HEAD');
		commit('apps/web/src/page.ts', 'page');
		expect(run(before)).toBe(1);
	});

	test('a commit touching the shared enums or the lockfile is built', () => {
		let before = git('rev-parse', 'HEAD');
		commit('packages/lib/src/enums.ts', 'enums');
		expect(run(before)).toBe(1);

		before = git('rev-parse', 'HEAD');
		commit('bun.lock', 'lock');
		expect(run(before)).toBe(1);
	});

	test('other packages/lib files do not trigger a build', () => {
		const before = git('rev-parse', 'HEAD');
		commit('packages/lib/src/other.ts', 'other');
		expect(run(before)).toBe(0);
	});

	test('a previous SHA git does not know is built', () => {
		expect(run('0123456789abcdef0123456789abcdef01234567')).toBe(1);
	});
});
