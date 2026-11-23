import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Changelog notes are hard-wrapped Markdown. Versions up to 1.1.4 show each line of the feed's
 * notes as its own item (#206), so the feed carries each paragraph, heading and list item on one
 * line; it is still the same Markdown. The GitHub release keeps the changelog text as written. */
export function unwrapNotes(notes) {
	const blocks = [];
	let open = null;
	for (const raw of notes.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			if (open) blocks.push(open);
			open = null;
			continue;
		}
		const starts = /^(#{1,6}|[-*])\s/.test(line);
		if (starts || !open) {
			if (open) blocks.push(open);
			open = { line, list: /^[-*]\s/.test(line), heading: /^#/.test(line) };
			if (open.heading) { blocks.push(open); open = null; }
			continue;
		}
		open.line = `${open.line} ${line}`;
	}
	if (open) blocks.push(open);
	// Consecutive list items stay one list; everything else is its own paragraph.
	return blocks.map((block, index) => (index && !(block.list && blocks[index - 1].list) ? `\n${block.line}` : block.line)).join('\n');
}

/** Every platform the desktop ships, with the updater target key, the installer people download
 * and the update bundle the updater installs. A release carries all of them or is not published,
 * so the asset names are defined here once and the workflows only copy files to these names. */
export const PLATFORMS = [
	{ key: 'windows-x86_64', installer: (v) => `JouzuDesktop_${v}_x64-setup.exe`, update: (v) => `JouzuDesktop_${v}_x64-setup.exe` },
	{ key: 'darwin-aarch64', installer: (v) => `JouzuDesktop_${v}_aarch64.dmg`, update: (v) => `JouzuDesktop_${v}_aarch64.app.tar.gz` },
	{ key: 'linux-x86_64', installer: (v) => `JouzuDesktop_${v}_amd64.AppImage`, update: (v) => `JouzuDesktop_${v}_amd64.AppImage` },
	// The updater looks for `<os>-<arch>-<bundle>` before `<os>-<arch>`, so an installation from
	// the .deb updates with the next .deb (dpkg, after a password prompt) and not the AppImage.
	{ key: 'linux-x86_64-deb', installer: (v) => `JouzuDesktop_${v}_amd64.deb`, update: (v) => `JouzuDesktop_${v}_amd64.deb` },
];

/** Every file of a release, in upload order: installers, update bundles with their signatures. */
export function releaseAssets(version) {
	const names = new Set();
	for (const platform of PLATFORMS) {
		names.add(platform.installer(version));
		names.add(platform.update(version));
		names.add(`${platform.update(version)}.sig`);
	}
	return [...names];
}

/** The update feed is read by the Tauri updater, which looks a platform up by its target key.
 * Every shipped platform must have its signed update bundle: a feed that misses one would leave
 * that platform's users behind without saying so. The URL and signature are the only fields the
 * client trusts, so both are validated here rather than assembled in a shell script. */
export function desktopFeed({ version, notes, pubDate, repository, signatures }) {
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) throw new Error('Invalid release version');
	if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid release repository');
	if (!signatures || typeof signatures !== 'object') throw new Error('Missing updater signatures');
	const unknown = Object.keys(signatures).filter((key) => !PLATFORMS.some((platform) => platform.key === key));
	if (unknown.length) throw new Error(`Unknown update platform: ${unknown.join(', ')}`);
	const date = new Date(pubDate ?? Date.now());
	if (Number.isNaN(date.getTime())) throw new Error('Invalid publication date');
	const platforms = {};
	for (const platform of PLATFORMS) {
		const signature = signatures[platform.key];
		if (typeof signature !== 'string' || !signature.trim()) throw new Error(`Missing updater signature for ${platform.key}`);
		platforms[platform.key] = {
			signature: signature.trim(),
			url: `https://github.com/${repository}/releases/download/v${version}/${platform.update(version)}`,
		};
	}
	return {
		version,
		notes: typeof notes === 'string' ? unwrapNotes(notes) : '',
		pub_date: date.toISOString(),
		platforms,
	};
}

/** The updater reads the feed with a strict JSON parser and no BOM handling. */
export function writeDesktopFeed(path, feed) {
	writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv[2] === 'assets') {
		// One name per line: what a release uploads and what the workflows stage.
		process.stdout.write(`${releaseAssets(process.argv[3]).join('\n')}\n`);
		process.exit(0);
	}
	const [version, notesFile, repository, releaseDirectory, output] = process.argv.slice(2);
	if (!output) throw new Error('Usage: node desktop-feed.mjs <version> <notes-file> <owner/repo> <release-dir> <output> | assets <version>');
	const signatures = Object.fromEntries(PLATFORMS.map((platform) => [
		platform.key,
		readFileSync(join(releaseDirectory, `${platform.update(version)}.sig`), 'utf8'),
	]));
	writeDesktopFeed(output, desktopFeed({
		version,
		notes: readFileSync(notesFile, 'utf8').trim(),
		repository,
		signatures,
	}));
}
