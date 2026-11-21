// Sets the desktop version in the three files that carry it: apps/desktop/package.json,
// src-tauri/Cargo.toml and the jouzu-desktop entry of src-tauri/Cargo.lock. The stable
// release workflow uses it to build X.Y.Z from the commit of X.Y.Z-rc.N (#86); the
// change is never committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion } from './release-guard.mjs';

// Paths are relative to the repository root, as git names them.
export const VERSION_FILES = [
	{ path: 'apps/desktop/package.json', pattern: /("version":\s*")[^"]+(")/ },
	{ path: 'apps/desktop/src-tauri/Cargo.toml', pattern: /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m },
	{ path: 'apps/desktop/src-tauri/Cargo.lock', pattern: /(name = "jouzu-desktop"\r?\nversion = ")[^"]+(")/ },
];

function stamp(text, pattern, version, path) {
	if (!pattern.test(text)) throw new Error(`No version found in ${path}`);
	return text.replace(pattern, `$1${version}$2`);
}

export function setVersion(root, version) {
	parseVersion(version);
	for (const { path, pattern } of VERSION_FILES) {
		const file = join(root, path);
		writeFileSync(file, stamp(readFileSync(file, 'utf8'), pattern, version, path));
	}
}

// True when every changed file is one of VERSION_FILES and differs from the commit only
// by `version`, i.e. the tree is the commit as setVersion stamped it (#205). `changed`
// lists the tracked files that differ from the commit; `committed(path)` and
// `working(path)` read a file as committed and as it is now.
export function onlyVersionStamped(changed, version, committed, working) {
	const lines = (text) => text.replace(/\r\n/g, '\n');
	return changed.every((path) => {
		const entry = VERSION_FILES.find((file) => file.path === path);
		if (!entry) return false;
		const before = committed(path);
		const now = working(path);
		if (before == null || now == null || !entry.pattern.test(before)) return false;
		return lines(stamp(before, entry.pattern, version, path)) === lines(now);
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const version = process.argv[2];
	if (!version) throw new Error('Usage: node set-version.mjs <X.Y.Z or X.Y.Z-rc.N>');
	setVersion(resolve(fileURLToPath(import.meta.url), '..', '..', '..'), version);
	console.log(`version set to ${version}`);
}
