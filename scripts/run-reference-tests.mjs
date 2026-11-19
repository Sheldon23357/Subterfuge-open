import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {sourcePath,readReference} from './reference-functions.mjs';
// Fail closed: missing private fixtures are not a passing or skipped comparison.
if (!fs.existsSync(sourcePath)) {
 console.error(`Reference suite NOT RUN: missing prerequisite ${sourcePath}. Restore the authorized locked sample described in docs/development/regression-suites.md. Default regression does not establish original-client parity.`);
 process.exit(2);
}
try { readReference(); } catch (error) {
 console.error('Reference suite NOT RUN: locked sample validation failed:', error.message);
 process.exit(2);
}
// Select current sources explicitly; deleted reference cases can still have
// stale build products in dist and must not reintroduce removed mechanics.
const files=fs.readdirSync('tests/reference').filter(name=>name.endsWith('.test.ts')).sort().map(name=>`dist/tests/reference/${name.replace(/\.ts$/,'.js')}`);
if(!files.length)throw Error('No current reference tests');
const result=spawnSync(process.execPath,['scripts/run-tests.mjs',...files],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
