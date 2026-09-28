import * as fs from 'fs';
import * as path from 'path';

/**
 * The default agent id, duplicated here rather than imported from
 * settings-store: this module is Electron-free by design (so smokes can
 * import it directly), and settings-store imports this module.
 */
const FALLBACK_SEGMENT = 'main';

/**
 * Filesystem-safe single path segment for an agent id or profile name.
 *
 * Agent ids are user-authored profile slugs, so they get the same
 * treatment as model-supplied filenames: anything outside
 * `[A-Za-z0-9._-]` becomes a dash, runs collapse, leading dots go (no
 * `..`, no hidden dirs), and the result is length-capped. An id that
 * sanitizes away to nothing falls back to the default agent rather than
 * writing into the parent directory itself.
 *
 * Lives here because both the artifact index and the per-agent workspace
 * need the same rule, and those two modules must not import each other.
 */
export function sanitizeAgentSegment(agentId: string): string {
  const cleaned = String(agentId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64);
  return cleaned || FALLBACK_SEGMENT;
}

/**
 * Crash-safe write: dump to a sibling temp file, fsync, then rename
 * atomically over the target. A crash partway through leaves either
 * the old file intact or the new file complete — never a half-written
 * file. Important for the key store especially: corruption there
 * wipes the user's saved API keys.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, data, 0, 'utf-8');
      // Flush to disk before renaming so a post-rename crash doesn't
      // leave us with a renamed-but-empty file on some platforms.
      try { fs.fsyncSync(fd); } catch { /* not all filesystems support fsync */ }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort if chmod unsupported */ }
  } catch (err) {
    // Best-effort cleanup of the temp file if rename failed.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
