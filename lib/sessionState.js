'use strict';

/**
 * lib/sessionState.js
 *
 * "AI session state" here means whatever local, on-disk artifacts
 * represent your current AI-assisted coding session: Claude Code's
 * local project/session files, plus (optionally) a conversation
 * export you point ccm at directly.
 *
 * Design note on honesty: Claude Code's internal storage format is
 * not a published, stable API, so this module deliberately does NOT
 * try to parse or "hot-swap" any internal database schema. Instead it
 * treats known state directories as opaque file trees and does a
 * safe, generic copy-and-restore of them, the same way it treats your
 * source code. This is slower to "understand" the state but far safer
 * — it can't corrupt a database it doesn't have to interpret, and it
 * keeps working even if the internal format changes.
 *
 * Anything that looks like a credential/secret is skipped on
 * principle, and any file above SIZE_LIMIT_BYTES is referenced
 * (path + size + checksum) rather than copied, so a checkpoint can't
 * silently balloon because of a large local cache/database file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SIZE_LIMIT_BYTES = 5 * 1024 * 1024; // 5MB per file
const SECRET_NAME_PATTERN = /(credential|secret|token|apikey|api_key|\.pem$|\.key$|password)/i;

function candidateStatePaths(cwd) {
  const home = os.homedir();
  return [
    path.join(home, '.claude'),
    path.join(home, '.config', 'claude'),
    path.join(cwd, '.claude'),
  ].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function listFilesRecursive(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks out of the tree
    if (entry.isDirectory()) {
      listFilesRecursive(full, base, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(base, full));
    }
  }
  return acc;
}

/**
 * Capture whatever is available into `destDir`:
 *  - manifest.json: what we found and what we did with it
 *  - files/: shallow, size-limited, secret-filtered copies
 *  - context.*: an optional user-supplied conversation export
 */
function captureSessionState(cwd, destDir, { contextFile } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const manifest = {
    capturedAt: new Date().toISOString(),
    sources: [],
    contextFile: null,
  };

  if (contextFile) {
    const abs = path.resolve(contextFile);
    if (fs.existsSync(abs)) {
      const ext = path.extname(abs) || '.txt';
      const destName = `context${ext}`;
      fs.copyFileSync(abs, path.join(destDir, destName));
      manifest.contextFile = {
        originalPath: abs,
        storedAs: destName,
        sizeBytes: fs.statSync(abs).size,
        sha256: sha256(abs),
      };
    }
  }

  const filesRoot = path.join(destDir, 'files');
  for (const sourceDir of candidateStatePaths(cwd)) {
    const sourceRecord = { sourcePath: sourceDir, files: [], skipped: [] };
    let relFiles = [];
    try {
      relFiles = listFilesRecursive(sourceDir);
    } catch (err) {
      sourceRecord.error = err.message;
      manifest.sources.push(sourceRecord);
      continue;
    }

    for (const rel of relFiles) {
      const srcPath = path.join(sourceDir, rel);
      if (SECRET_NAME_PATTERN.test(rel)) {
        sourceRecord.skipped.push({ path: rel, reason: 'looks-like-secret' });
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(srcPath);
      } catch {
        continue;
      }

      if (stat.size > SIZE_LIMIT_BYTES) {
        sourceRecord.files.push({
          path: rel,
          mode: 'reference-only',
          sizeBytes: stat.size,
          sha256: sha256(srcPath),
        });
        continue;
      }

      const destSubdir = path.join(
        filesRoot,
        crypto.createHash('sha1').update(sourceDir).digest('hex').slice(0, 8)
      );
      const destPath = path.join(destSubdir, rel);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      sourceRecord.files.push({
        path: rel,
        mode: 'copied',
        sizeBytes: stat.size,
        sha256: sha256(srcPath),
      });
    }
    manifest.sources.push(sourceRecord);
  }

  fs.writeFileSync(
    path.join(destDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  return manifest;
}

/**
 * Restore previously captured files back to their original locations.
 * Only files that were actually copied (mode: 'copied') are restored;
 * reference-only entries are reported so the user can reconcile large
 * state files by hand if needed.
 */
function restoreSessionState(checkpointDir, { dryRun = false } = {}) {
  const manifestPath = path.join(checkpointDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { restored: [], referenceOnly: [], warnings: ['no session-state manifest found for this checkpoint'] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = [];
  const referenceOnly = [];
  const warnings = [];

  for (const source of manifest.sources) {
    const subdirHash = crypto
      .createHash('sha1')
      .update(source.sourcePath)
      .digest('hex')
      .slice(0, 8);
    for (const f of source.files) {
      if (f.mode === 'reference-only') {
        referenceOnly.push({ ...f, sourcePath: source.sourcePath });
        continue;
      }
      const srcPath = path.join(checkpointDir, 'files', subdirHash, f.path);
      const destPath = path.join(source.sourcePath, f.path);
      if (!fs.existsSync(srcPath)) {
        warnings.push(`missing captured file: ${srcPath}`);
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const tmp = `${destPath}.ccm-tmp-${process.pid}`;
        fs.copyFileSync(srcPath, tmp);
        fs.renameSync(tmp, destPath);
      }
      restored.push(destPath);
    }
  }

  return { restored, referenceOnly, warnings };
}

module.exports = {
  candidateStatePaths,
  captureSessionState,
  restoreSessionState,
  SIZE_LIMIT_BYTES,
};
