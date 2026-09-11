import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const worktree = process.env.PROJECT_GOVERNANCE_RELEASE_WORKTREE ?? process.cwd();
const result = await exec('npm', ['pack', '--json'], { cwd: worktree, env: process.env });
const packed = JSON.parse(result.stdout);
const filename = packed[0]?.filename;
if (!filename) throw new Error('npm pack returned no artifact filename');
const artifactPath = join(worktree, filename);
const bytes = await readFile(artifactPath);
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
console.log(JSON.stringify({
  schema: 'project-governance.artifact-freeze.v1',
  artifacts: [{ name: filename, digest }],
}));
