import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { posix } from 'node:path';

const api = `${import.meta.dir}/..`;
const repo = `${api}/../..`;
const self = 'apps/api/test/structure.test.ts';

/**
 * Repo-relative paths of every .ts file under the given repo-relative globs. Each glob must find
 * at least one file: a rule over nothing passes whatever the code does, so a broken glob fails.
 */
const scan = (...patterns: string[]) => {
	const out = new Set<string>();
	for (const p of patterns) {
		let found = 0;
		for (const f of new Glob(p).scanSync({ cwd: repo })) {
			const rel = f.replaceAll('\\', '/');
			if (!rel.includes('node_modules/') && rel !== self) {
				out.add(rel);
				found++;
			}
		}
		expect(found, `"${p}" matched no files`).toBeGreaterThan(0);
	}
	return [...out].sort();
};
const read = (f: string) => Bun.file(`${repo}/${f}`).text();

const everywhere = () =>
	scan('apps/api/src/**/*.ts', 'apps/api/scripts/**/*.ts', 'apps/api/test/**/*.ts');

// Static `from`, side-effect `import "x"` and dynamic `import("x")`, either quote style.
const specifiers = (src: string) =>
	[...src.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

const importers = async (pattern: RegExp) => {
	const found: string[] = [];
	for (const f of everywhere()) {
		if (specifiers(await read(f)).some((s) => pattern.test(s))) found.push(f);
	}
	return found;
};

describe('structure', () => {
	test('a glob that matches nothing fails the rule instead of passing it', () => {
		expect(() => scan('apps/api/src/no-such-dir/**/*.ts')).toThrow('matched no files');
		expect(scan('apps/api/src/*.ts').length).toBeGreaterThan(0);
	});

	test("only container.ts imports InferDI's container", async () => {
		expect(await importers(/^@inferdi\/inferdi(\/|$)/)).toEqual(['apps/api/src/container.ts']);
	});

	// A module is a directory under modules/. Beside them sit module.ts, the contract every module
	// may import, and index.ts, the one file that knows every module: index.ts imports modules,
	// never the reverse.
	test('modules never import each other, nor the module list', async () => {
		const crossing: string[] = [];
		const moduleFiles = scan('apps/api/src/modules/*/**/*.ts', 'apps/api/test/modules/*/**/*.ts');
		for (const f of moduleFiles) {
			const own = /^apps\/api\/(?:src|test)\/modules\/([^/]+)\//.exec(f)?.[1];
			const dir = posix.dirname(f);
			for (const s of specifiers(await read(f))) {
				const target = s.startsWith('@/')
					? `apps/api/src/${s.slice(2)}`
					: s.startsWith('.')
						? posix.join(dir, s)
						: undefined;
				const under = target && /^apps\/api\/(?:src|test)\/modules(?:\/(.*))?$/.exec(target);
				if (!under) continue;
				// A bare `modules` path is a directory import, which resolves to index.ts.
				const rel = under[1] || 'index.ts';
				if (rel === 'module.ts' || rel === 'module') continue;
				const name = rel.split('/')[0];
				if (name !== own) crossing.push(`${f} -> ${rel}`);
			}
		}
		expect(crossing).toEqual([]);
	});

	// Test support is shared scaffolding: the app may not depend on it, and it may not reach into
	// a module's internals (module.ts is the contract every module may import).
	test('src never imports test code', async () => {
		const importing: string[] = [];
		for (const f of scan('apps/api/src/**/*.ts')) {
			const dir = posix.dirname(f);
			for (const s of specifiers(await read(f))) {
				const target = s.startsWith('@/')
					? `apps/api/src/${s.slice(2)}`
					: s.startsWith('.')
						? posix.join(dir, s)
						: s;
				if (/^apps\/api\/test(\/|$)/.test(target) || /^@\/?test(\/|$)/.test(s)) {
					importing.push(`${f} -> ${s}`);
				}
			}
		}
		expect(importing).toEqual([]);
	});

	test("test/support never imports a module's internals", async () => {
		const reaching: string[] = [];
		for (const f of scan('apps/api/test/support/**/*.ts')) {
			const dir = posix.dirname(f);
			for (const s of specifiers(await read(f))) {
				const target = s.startsWith('@/')
					? `apps/api/src/${s.slice(2)}`
					: s.startsWith('.')
						? posix.join(dir, s)
						: undefined;
				const under = target && /^apps\/api\/(?:src|test)\/modules(?:\/(.*))?$/.exec(target);
				if (!under) continue;
				const rel = under[1] || 'index.ts';
				if (rel !== 'module.ts' && rel !== 'module') reaching.push(`${f} -> ${rel}`);
			}
		}
		expect(reaching).toEqual([]);
	});

	test('module code replies through a view, never a raw response', async () => {
		const raw: string[] = [];
		for (const f of scan('apps/api/src/modules/**/*.ts')) {
			if (/\b\w+\.json\(|\.body\(|new Response\(|Response\.json\(/.test(await read(f))) raw.push(f);
		}
		expect(raw).toEqual([]);
	});

	// A module folder holds role files only (spec, "Inside a module"): <m>.module.ts, <m>.service.ts
	// or <m>.<area>.service.ts, <m>.routes.ts, <m>.consumer.ts, <m>.types.ts, and the future
	// transports <m>.grpc.ts and <m>.graphql.ts. No queries, rules or helper files.
	test('a module folder holds role files only', () => {
		const stray: string[] = [];
		for (const f of scan('apps/api/src/modules/*/*.ts')) {
			const [, name, file] = /^apps\/api\/src\/modules\/([^/]+)\/(.+)$/.exec(f)!;
			const role = new RegExp(
				`^${name}(\\.[a-z][a-z0-9-]*\\.service|\\.(module|service|routes|consumer|types|grpc|graphql))\\.ts$`,
			);
			if (!role.test(file!)) stray.push(f);
		}
		expect(stray).toEqual([]);
	});

	// An exported function names the types of its parameters and result; an inline object type
	// is for a local, unexported shape. A heuristic over the source text, not the type checker:
	// it reads each `export function` / `export const x = (...) =>` parameter list (balanced
	// parentheses) and flags a parameter typed `: {` and a return annotation that opens with
	// `{`, `Promise<{`, `Result<{` and the like. It does not look inside the body, at methods of
	// a returned object, at `Promise<A | { ... }>`, or at `Record<string, { ... }>`.
	test('exported functions use named types, not inline object types', async () => {
		const inline: string[] = [];
		const files = scan('apps/api/src/modules/**/*.ts', 'packages/contracts/src/**/*.ts');
		const head =
			/export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?)(?:<[^>(]*>)?\(/g;
		for (const f of files) {
			const src = await read(f);
			for (const m of src.matchAll(head)) {
				let depth = 1;
				let i = m.index + m[0].length;
				const start = i;
				while (i < src.length && depth > 0) {
					const ch = src[i++];
					if (ch === '(') depth++;
					else if (ch === ')') depth--;
				}
				const params = src.slice(start, i - 1);
				const result = src.slice(i, i + 80);
				if (/:\s*\{/.test(params) || /^\s*:\s*(?:[\w.]+<)*\{/.test(result)) {
					inline.push(`${f}: ${m[1] ?? m[2]}`);
				}
			}
		}
		expect(inline).toEqual([]);
	});

	// Errors are classes now (`new RealmNotFound(...)`); `fail.<kind>(code, ...)` is gone, and a
	// copy of it pasted back would build an untyped AppError. Comment lines are skipped.
	test('no source builds an error with fail.<kind>', async () => {
		const using: string[] = [];
		for (const f of scan('apps/api/src/**/*.ts', 'packages/*/src/**/*.ts')) {
			const lines = (await read(f)).split('\n');
			lines.forEach((line, n) => {
				if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
				if (/\bfail\.[A-Za-z_]/.test(line)) using.push(`${f}:${n + 1}`);
			});
		}
		expect(using).toEqual([]);
	});

	// A module's errors are named classes. AppError, the base every one of them extends, would
	// let any error through wherever it appears: in a result, or in a union alias in <m>.types.ts.
	// So module code never mentions it (comment lines aside).
	test('module code never mentions AppError', async () => {
		const mentions: string[] = [];
		for (const f of scan('apps/api/src/modules/**/*.ts')) {
			(await read(f)).split('\n').forEach((line, n) => {
				if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
				if (/\bAppError\b/.test(line)) mentions.push(`${f}:${n + 1}`);
			});
		}
		expect(mentions).toEqual([]);
	});

	// A module's results name their errors: `Result<T, JoinError>`, never `Result<T>` (the
	// compiler refuses that too, now `E` has no default), nor an error type that admits anything
	// (`unknown`, `any`, `Error`, `AppError`). A text heuristic: it reads each `Result<...>`
	// (balanced brackets, `=>` skipped) outside comment lines and splits its top-level arguments;
	// an alias is checked where it is defined, by the AppError rule above.
	test('module results name their error union, never a catch-all or nothing', async () => {
		const loose: string[] = [];
		const catchAll = new Set(['unknown', 'any', 'Error', 'AppError']);
		for (const f of scan('apps/api/src/modules/**/*.ts')) {
			const src = (await read(f))
				.split('\n')
				.map((line) => (/^\s*(?:\/\/|\/?\*)/.test(line) ? '' : line))
				.join('\n');
			for (const m of src.matchAll(/\bResult<\s*/g)) {
				let depth = 1;
				let i = m.index + m[0].length;
				const args: string[] = [''];
				while (i < src.length && depth > 0) {
					const ch = src[i++]!;
					if (ch === '=' && src[i] === '>') {
						args[args.length - 1] += '=>';
						i++;
						continue;
					}
					if ('<([{'.includes(ch)) depth++;
					else if ('>)]}'.includes(ch)) depth--;
					if (depth === 0) break;
					if (ch === ',' && depth === 1) args.push('');
					else args[args.length - 1] += ch;
				}
				const errors = args[1]?.trim();
				const members = errors?.split('|').map((part) => part.trim()) ?? [];
				if (!errors || members.some((member) => catchAll.has(member))) {
					const line = src.slice(0, m.index).split('\n').length;
					loose.push(`${f}:${line}: Result<${args.join(',').replace(/\s+/g, ' ').trim()}>`);
				}
			}
		}
		expect(loose).toEqual([]);
	});

	test('nothing but main.ts starts the process', async () => {
		const starting: string[] = [];
		// lifecycle.ts defines handleSignals; main.ts is the one place that calls it.
		const files = scan(
			'apps/api/src/**/*.ts',
			'apps/api/scripts/**/*.ts',
			'packages/*/src/**/*.ts',
		);
		for (const f of files) {
			if (f === 'apps/api/src/main.ts' || f === 'packages/lib/src/lifecycle.ts') continue;
			if (/Bun\.serve\(|handleSignals\(/.test(await read(f))) starting.push(f);
		}
		expect(starting).toEqual([]);
	});

	// One definition of each variable (`Env` in config.ts), so a script can't drift from the API's
	// default or validation. A heuristic: every `loadEnv(` in scripts must open with `v.pick(Env`.
	test('scripts load their environment as a pick of the API Env', async () => {
		const inline: string[] = [];
		for (const f of scan('apps/api/scripts/**/*.ts')) {
			const src = await read(f);
			for (const m of src.matchAll(/loadEnv\(\s*(?!\s|v\.pick\(Env\b)/g)) {
				inline.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
			}
		}
		expect(inline).toEqual([]);
	});

	// Routes validate first, then guard, so a malformed request is a 400 for everyone. A text
	// heuristic over each route's argument list (`.get(`, `.post(`, ... up to its handler arrow):
	// a `validate(` may not follow `realmContext`, `requirePermission(`, `requireModule(`,
	// `requireOn(`, or a name bound to one of those (`const eventsModule = requireModule(...)`).
	// It does not look inside handlers or across files. `platformAdmin` is not on the guard list, so
	// the admin surface (`/admin/*`, `/admin/proposals`, `POST /realms`), where it runs before
	// `validate` so a stranger gets the router's 404, passes without a special case.
	const guardPattern = (src: string) => {
		const aliases = [
			...src.matchAll(/const\s+(\w+)\s*=[^;\n]*\b(?:requireModule|requireOn|requirePermission)\b/g),
		].map((m) => m[1]!);
		return new RegExp(
			`\\b(?:realmContext|requirePermission|requireModule|requireOn|${aliases.join('|') || '(?!)'})\\b`,
		);
	};
	const orderViolations = (src: string) => {
		const guard = guardPattern(src);
		const bad: string[] = [];
		for (const route of src.matchAll(/\.(?:get|post|put|patch|delete)\(/g)) {
			// Walk to the matching paren, skipping string literals; the handler starts at its arrow.
			let depth = 0;
			let quote = '';
			let end = src.length;
			for (let i = route.index + route[0].length - 1; i < src.length; i++) {
				const ch = src[i]!;
				if (quote) {
					if (ch === quote) quote = '';
				} else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
				else if (ch === '(') depth++;
				else if (ch === ')' && --depth === 0) {
					end = i;
					break;
				}
			}
			const args = src.slice(route.index, end);
			const chain = args.slice(0, args.includes('=>') ? args.indexOf('=>') : undefined);
			const firstGuard = chain.search(guard);
			const lastValidate = chain.lastIndexOf('validate(');
			if (firstGuard !== -1 && lastValidate > firstGuard) {
				bad.push(`line ${src.slice(0, route.index).split('\n').length}`);
			}
		}
		return bad;
	};

	test('the route-order rule catches a validate after a guard, and lets platformAdmin lead', () => {
		const route = (args: string) => `new Hono().post(${args}, async (c) => c.json(validate('x')))`;
		expect(orderViolations(route("'/a', realmContext, validate('json', B)"))).toHaveLength(1);
		expect(
			orderViolations(route("'/a', requirePermission('x'), validate('json', B)")),
		).toHaveLength(1);
		expect(orderViolations(route("'/a', requireOn(a, r, t), validate('json', B)"))).toHaveLength(1);
		expect(
			orderViolations(
				'const inRealm = requireModule(1);\n' + route("'/a', inRealm, validate('json', B)"),
			),
		).toHaveLength(1);
		expect(orderViolations(route("'/a', validate('json', B), realmContext"))).toEqual([]);
		expect(orderViolations(route("'/a', sessions.platformAdmin, validate('json', B)"))).toEqual([]);
	});

	test('routes validate before they guard', async () => {
		const files = scan('apps/api/src/modules/*/*.routes.ts');
		const out: string[] = [];
		for (const f of files) for (const at of orderViolations(await read(f))) out.push(`${f}: ${at}`);
		expect(out).toEqual([]);
	});
});
