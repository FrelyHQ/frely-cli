import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const version = process.env.PROJECT_GOVERNANCE_RELEASE_VERSION;
if (!version) throw new Error('PROJECT_GOVERNANCE_VERSION is required');
const cache = '/private/tmp/frely-cli-npm-cache';
const { stdout } = await exec('npm', ['view', `frely-cli@${version}`, 'version', '--json'], {
  cwd: process.cwd(),
  env: { ...process.env, npm_config_cache: cache },
});
const published = JSON.parse(stdout.trim());
if (published !== version) throw new Error(`registry returned ${published}, expected ${version}`);
console.log(`frely-cli@${version} is published`);
