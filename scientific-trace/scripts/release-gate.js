import {readFile} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root)));
const report = JSON.parse(await readFile(new URL('VERIFICATION.json', root)));
const required = ['unit_tests', 'host_integration', 'bat20_replay', 'bat20_numeric_verification',
  'atif_validation', 'clean_tarball_install', 'live_model_run', 'live_numeric_verification',
  'license_selected', 'npm_owner_confirmed'];
const missing = required.filter(key => report.checks[key]?.status !== 'passed');
if (manifest.private || manifest.license === 'UNLICENSED' || missing.length) {
  console.error(JSON.stringify({publish_allowed: false, private: manifest.private ?? false,
    license: manifest.license, incomplete_checks: missing}, null, 2));
  process.exitCode = 1;
} else console.log('Release checks passed.');
