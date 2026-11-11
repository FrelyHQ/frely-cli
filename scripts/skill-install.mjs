// postinstall: link frely CLI skill to ~/.agents/skills/frely/SKILL.md
// Runs automatically after `npm install -g frely-cli`.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SKILL_SRC = join(import.meta.dirname, '..', 'skills', 'frely-cli', 'SKILL.md');
const AGENTS_DIR = join(homedir(), '.agents', 'skills', 'frely');
const SKILL_DST = join(AGENTS_DIR, 'SKILL.md');

try {
  // 1. Validate source file
  if (!existsSync(SKILL_SRC)) {
    process.stderr.write(`postinstall: source skill not found at ${SKILL_SRC}\n`);
    process.exit(0); // non-fatal
  }

  // 2. Read source content
  const content = readFileSync(SKILL_SRC, 'utf-8');

  // 3. Create target directory (recursive)
  mkdirSync(AGENTS_DIR, { recursive: true });

  // 4. Write SKILL.md atomically (write to temp, then rename onto the target; only a failed write can leave the temp behind, so clean it up there)
  const tmp = join(AGENTS_DIR, `.SKILL.md.tmp.${Date.now()}`);
  try {
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, SKILL_DST);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }

} catch (err) {
  process.stderr.write(`postinstall: ${err.message}\n`);
  process.exit(0); // non-fatal
}
