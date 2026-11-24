import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopFeed, releaseAssets, writeDesktopFeed } from './desktop-feed.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'desktop-feed.mjs');
const signature = '  dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo  \n';
const base = {
	version: '1.0.1',
	notes: '- Desktop-only release',
	pubDate: '2026-10-23T04:00:00Z',
	repository: 'shisa-ai/jouzu-desktop',
	signatures: { 'windows-x86_64': signature, 'darwin-aarch64': `${signature}mac`, 'linux-x86_64': `${signature}linux`, 'linux-x86_64-deb': `${signature}deb` },
};

test('the feed names each platform\'s signed update bundle in the version release', () => {
	const feed = desktopFeed(base);
	assert.equal(feed.version, '1.0.1');
	assert.equal(feed.pub_date, '2026-10-23T04:00:00.000Z');
	const url = (name) => `https://github.com/shisa-ai/jouzu-desktop/releases/download/v1.0.1/${name}`;
	assert.deepEqual(feed.platforms, {
		'windows-x86_64': { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo', url: url('JouzuDesktop_1.0.1_x64-setup.exe') },
		'darwin-aarch64': { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo  \nmac', url: url('JouzuDesktop_1.0.1_aarch64.app.tar.gz') },
		'linux-x86_64': { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo  \nlinux', url: url('JouzuDesktop_1.0.1_amd64.AppImage') },
		'linux-x86_64-deb': { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo  \ndeb', url: url('JouzuDesktop_1.0.1_amd64.deb') },
	});
});

test('a feed that misses a shipped platform, or names an unknown one, is refused', () => {
	for (const key of Object.keys(base.signatures)) {
		const signatures = { ...base.signatures };
		delete signatures[key];
		assert.throws(() => desktopFeed({ ...base, signatures }), new RegExp(key));
		assert.throws(() => desktopFeed({ ...base, signatures: { ...base.signatures, [key]: '  ' } }), new RegExp(key));
	}
	assert.throws(() => desktopFeed({ ...base, signatures: { ...base.signatures, 'windows-aarch64': signature } }), /Unknown update platform/);
	assert.throws(() => desktopFeed({ ...base, signatures: undefined }), /Missing updater signatures/);
});

test('an invalid version, repository or date is refused', () => {
	const cases = [
		{ version: '1.0' },
		{ version: '1.0.1-beta' },
		{ repository: 'no-slash' },
		{ repository: 'owner/' },
		{ pubDate: 'not a date' },
	];
	for (const overrides of cases) {
		assert.throws(() => desktopFeed({ ...base, ...overrides }), Error, JSON.stringify(overrides));
	}
});

test('a release carries every installer, update bundle and signature, with names usable in a URL', () => {
	assert.deepEqual(releaseAssets('1.1.5-rc.3'), [
		'JouzuDesktop_1.1.5-rc.3_x64-setup.exe',
		'JouzuDesktop_1.1.5-rc.3_x64-setup.exe.sig',
		'JouzuDesktop_1.1.5-rc.3_aarch64.dmg',
		'JouzuDesktop_1.1.5-rc.3_aarch64.app.tar.gz',
		'JouzuDesktop_1.1.5-rc.3_aarch64.app.tar.gz.sig',
		'JouzuDesktop_1.1.5-rc.3_amd64.AppImage',
		'JouzuDesktop_1.1.5-rc.3_amd64.AppImage.sig',
		'JouzuDesktop_1.1.5-rc.3_amd64.deb',
		'JouzuDesktop_1.1.5-rc.3_amd64.deb.sig',
	]);
	for (const name of releaseAssets('1.1.5')) assert.match(name, /^[A-Za-z0-9._-]+$/);
});

test('the command line reads each signature from the release folder', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-feed-cli-'));
	for (const [key, name] of [['windows', 'JouzuDesktop_1.0.1_x64-setup.exe'], ['mac', 'JouzuDesktop_1.0.1_aarch64.app.tar.gz'], ['linux', 'JouzuDesktop_1.0.1_amd64.AppImage'], ['deb', 'JouzuDesktop_1.0.1_amd64.deb']]) {
		writeFileSync(join(directory, `${name}.sig`), `sig-${key}\n`);
	}
	const notes = join(directory, 'notes.md');
	writeFileSync(notes, '- Notes\n');
	const output = join(directory, 'latest.json');
	const run = spawnSync(process.execPath, [script, '1.0.1', notes, 'shisa-ai/jouzu-desktop', directory, output], { encoding: 'utf8' });
	assert.equal(run.status, 0, run.stderr);
	const feed = JSON.parse(readFileSync(output, 'utf8'));
	assert.equal(feed.platforms['darwin-aarch64'].signature, 'sig-mac');
	assert.equal(feed.platforms['linux-x86_64'].signature, 'sig-linux');
	assert.equal(feed.platforms['linux-x86_64-deb'].signature, 'sig-deb');
	const listed = spawnSync(process.execPath, [script, 'assets', '1.0.1'], { encoding: 'utf8' });
	assert.equal(listed.stdout, `${releaseAssets('1.0.1').join('\n')}\n`);
});

test('the feed file is UTF-8 without a byte order mark', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-feed-'));
	const path = join(directory, 'latest.json');
	writeDesktopFeed(path, desktopFeed(base));
	const bytes = readFileSync(path);
	assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
	assert.ok(bytes.toString('utf8').endsWith('\n'));
	assert.equal(JSON.parse(bytes.toString('utf8')).platforms['windows-x86_64'].signature, 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo');
});

// QA releases are release candidates (#86); their feed carries the rc version.
test('a release candidate version is accepted', () => {
	const feed = desktopFeed({ ...base, version: '1.1.3-rc.1' });
	assert.equal(feed.version, '1.1.3-rc.1');
	assert.equal(feed.platforms['windows-x86_64'].url, 'https://github.com/shisa-ai/jouzu-desktop/releases/download/v1.1.3-rc.1/JouzuDesktop_1.1.3-rc.1_x64-setup.exe');
});

// #206: older versions show each line of the notes as an item, so the feed has no wrapped lines.
test('the feed carries each paragraph and list item on one line', () => {
	const notes = [
		'Stable release. It follows 1.0.23 on the stable channel and contains everything from 1.1.0',
		'to 1.1.4-rc.1.',
		'',
		'- Chats keep running on their own. Closing or reloading the window no longer stops a reply,',
		'  and a window that reconnects catches up.',
		'- A new session can send at once.',
		'',
		'### Fixed',
		'- One',
		'',
		'QA (1.1.4-rc.1): passed',
	].join('\n');
	assert.equal(desktopFeed({ ...base, notes }).notes, [
		'Stable release. It follows 1.0.23 on the stable channel and contains everything from 1.1.0 to 1.1.4-rc.1.',
		'',
		'- Chats keep running on their own. Closing or reloading the window no longer stops a reply, and a window that reconnects catches up.',
		'- A new session can send at once.',
		'',
		'### Fixed',
		'',
		'- One',
		'',
		'QA (1.1.4-rc.1): passed',
	].join('\n'));
	assert.equal(desktopFeed(base).notes, '- Desktop-only release');
});
