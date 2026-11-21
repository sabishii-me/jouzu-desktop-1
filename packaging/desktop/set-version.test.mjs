import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onlyVersionStamped, setVersion, VERSION_FILES } from './set-version.mjs';

function tree(version) {
	const root = mkdtempSync(join(tmpdir(), 'set-version-'));
	const tauri = join(root, 'apps', 'desktop', 'src-tauri');
	mkdirSync(tauri, { recursive: true });
	writeFileSync(join(root, 'apps', 'desktop', 'package.json'), `{\n  "name": "desktop",\n  "version": "${version}",\n  "private": true\n}\n`);
	writeFileSync(join(tauri, 'Cargo.toml'), `[package]\nname = "jouzu-desktop"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "1" }\n`);
	writeFileSync(join(tauri, 'Cargo.lock'), `[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "jouzu-desktop"\nversion = "${version}"\n`);
	return root;
}

// #86: the stable build is X.Y.Z, made from the commit of X.Y.Z-rc.N.
test('sets the version in package.json, Cargo.toml and Cargo.lock only', () => {
	const root = tree('1.1.3-rc.2');
	setVersion(root, '1.1.3');
	const tauri = join(root, 'apps', 'desktop', 'src-tauri');
	assert.match(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'), /"version": "1.1.3"/);
	const manifest = readFileSync(join(tauri, 'Cargo.toml'), 'utf8');
	assert.match(manifest, /^version = "1.1.3"$/m);
	assert.match(manifest, /serde = \{ version = "1" \}/, 'dependency versions are untouched');
	const lock = readFileSync(join(tauri, 'Cargo.lock'), 'utf8');
	assert.match(lock, /name = "jouzu-desktop"\nversion = "1.1.3"/);
	assert.match(lock, /name = "serde"\nversion = "1.0.0"/);
});

test('refuses a version that is not a release version', () => {
	assert.throws(() => setVersion(tree('1.1.3-rc.2'), '1.1'), /Not a release version/);
});

// #205: a stable build is the commit with its version stamped, not a dirty tree.
test('a tree that differs from the commit only by the stamped version is not dirty', () => {
	const root = tree('1.1.3-rc.2');
	const committed = Object.fromEntries(VERSION_FILES.map(({ path }) => [path, readFileSync(join(root, path), 'utf8')]));
	setVersion(root, '1.1.3');
	const working = (path) => readFileSync(join(root, path), 'utf8');
	const changed = VERSION_FILES.map(({ path }) => path);
	assert.equal(onlyVersionStamped(changed, '1.1.3', (path) => committed[path], working), true);
	assert.equal(onlyVersionStamped(changed, '1.1.4', (path) => committed[path], working), false, 'a different version is a change');
	assert.equal(onlyVersionStamped([...changed, 'apps/desktop/src/App.tsx'], '1.1.3', (path) => committed[path] ?? '', working), false, 'any other file is a change');
});

test('any other edit in a version file is a change', () => {
	const root = tree('1.1.3-rc.2');
	const path = 'apps/desktop/src-tauri/Cargo.toml';
	const committed = readFileSync(join(root, path), 'utf8');
	setVersion(root, '1.1.3');
	writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace('version = "1"', 'version = "2"'));
	assert.equal(onlyVersionStamped([path], '1.1.3', () => committed, (p) => readFileSync(join(root, p), 'utf8')), false);
});

test('line endings from checkout are not a change', () => {
	const path = 'apps/desktop/package.json';
	const committed = '{\n  "version": "1.1.3-rc.2"\n}\n';
	const working = '{\r\n  "version": "1.1.3"\r\n}\r\n';
	assert.equal(onlyVersionStamped([path], '1.1.3', () => committed, () => working), true);
});
