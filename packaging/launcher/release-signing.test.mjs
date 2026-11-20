import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

// A cold PowerShell on a CI runner can take more than 10 s to start (#81).
test('release signing scripts parse without invoking signing services', {skip: process.platform !== 'win32', timeout: 90000}, () => {
 const files = ['sign-windows.ps1','finalize-windows-bundle.ps1','publish-launcher.ps1'];
 const paths = files.map(name => "'" + fileURLToPath(new URL(name, import.meta.url)).replaceAll("'", "''") + "'").join(',');
 const script = `foreach($file in @(${paths})){$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile($file,[ref]$null,[ref]$errors);if($errors.Count){$errors;exit 1}}`;
 const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8',timeout:60000,windowsHide:true});
 assert.equal(result.status, 0, result.stderr + result.stdout);
});
