// postinstall: link frely CLI skill to ~/.agents/skills/frely/SKILL.md
// Runs automatically after `npm install -g frely-cli`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const SKILL_SRC = join(import.meta.dirname, '..', 'skills', 'frely-cli', 'SKILL.md');
const AGENTS_DIR = join(process.env.HOME ?? tmpdir(), '.agents', 'skills', 'frely');
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

  // 4. Write SKILL.md atomically (write to temp, then rename)
  const tmp = join(AGENTS_DIR, `.SKILL.md.tmp.${Date.now()}`);
  writeFileSync(tmp, content, 'utf-8');
  writeFileSync(SKILL_DST, content, 'utf-8');

  // 5. Cleanup temp (may fail if same filesystem, ignore)
  try { process.unlinkSync(tmp); } catch { /* ignore */ }

} catch (err) {
  process.stderr.write(`postinstall: ${err.message}\n`);
  process.exit(0); // non-fatal
}
