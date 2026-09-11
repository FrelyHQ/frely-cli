import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const tag = process.env.PROJECT_GOVERNANCE_RELEASE_TAG;
if (!tag) throw new Error('PROJECT_GOVERNANCE_TAG is required');
await exec('git', ['push', 'origin', tag], { cwd: process.cwd(), env: process.env });
