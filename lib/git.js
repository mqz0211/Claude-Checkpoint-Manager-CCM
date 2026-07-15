'use strict';

/**
 * lib/git.js
 *
 * All git interaction goes through *plumbing* commands (write-tree,
 * commit-tree, update-ref, checkout-index) rather than porcelain
 * (commit, checkout, stash). This matters for two reasons:
 *
 *   1. We use a scratch index file (GIT_INDEX_FILE pointed at a temp
 *      path) for every staging operation, so `git add` here never
 *      touches the developer's real staging area or working index.
 *   2. Checkpoints are stored as commit objects reachable only from
 *      custom refs under `refs/ccm/checkpoints/*`, not from any
 *      branch. `git log`, `git status`, and `git branch` on the
 *      developer's actual branches are completely unaffected —
 *      the objects are invisible to normal porcelain until you
 *      explicitly ask git to look at that ref.
 *
 * A checkpoint is a normal git commit object under the hood, so it
 * benefits from git's content-addressable storage: unchanged files
 * across checkpoints cost effectively zero extra disk space.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CCM_REF_NAMESPACE = 'refs/ccm/checkpoints';

class GitError extends Error {}

function run(args, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 64,
    }).trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    throw new GitError(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

function isGitRepo(cwd) {
  try {
    run(['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}

function initRepoIfNeeded(cwd) {
  if (!isGitRepo(cwd)) {
    run(['init', '--quiet'], { cwd });
  }
}

function currentHeadSha(cwd) {
  try {
    return run(['rev-parse', 'HEAD'], { cwd });
  } catch {
    return null; // unborn branch, no commits yet
  }
}

/**
 * Snapshot the current working tree (tracked + untracked, respecting
 * .gitignore) into a git tree object, using an isolated scratch index
 * so the developer's real staging area is never touched.
 *
 * Returns { treeSha, fileCount }.
 */
function snapshotWorkingTree(cwd) {
  const scratchIndex = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-index-')),
    'index'
  );
  const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };

  try {
    // Seed the scratch index from HEAD if it exists, so files that
    // are unchanged and already committed don't need rehashing.
    const head = currentHeadSha(cwd);
    if (head) {
      run(['read-tree', head], { cwd, env });
    }
    // -A stages tracked modifications, new files, and deletions,
    // while still honoring .gitignore for untracked files.
    run(['add', '-A'], { cwd, env });

    const treeSha = run(['write-tree'], { cwd, env });
    const fileCountRaw = run(['ls-tree', '-r', '--name-only', treeSha], {
      cwd,
      env,
    });
    const fileCount = fileCountRaw ? fileCountRaw.split('\n').length : 0;
    return { treeSha, fileCount };
  } finally {
    fs.rmSync(path.dirname(scratchIndex), { recursive: true, force: true });
  }
}

/**
 * Wrap a tree into a commit object. The commit is NOT attached to any
 * branch — it is only reachable once we point a refs/ccm/* ref at it.
 */
function commitTree(cwd, treeSha, message, parentSha) {
  const args = ['commit-tree', treeSha, '-m', message];
  if (parentSha) args.push('-p', parentSha);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'ccm',
    GIT_AUTHOR_EMAIL: 'ccm@local',
    GIT_COMMITTER_NAME: 'ccm',
    GIT_COMMITTER_EMAIL: 'ccm@local',
  };
  return run(args, { cwd, env });
}

function refName(checkpointId) {
  return `${CCM_REF_NAMESPACE}/${checkpointId}`;
}

function updateRef(cwd, checkpointId, commitSha) {
  run(['update-ref', refName(checkpointId), commitSha], { cwd });
}

function deleteRef(cwd, checkpointId) {
  try {
    run(['update-ref', '-d', refName(checkpointId)], { cwd });
  } catch {
    /* ref may not exist; ignore */
  }
}

/**
 * Restore a checkpoint's tree into the working directory.
 *
 * Strategy: extract the tree into an isolated temp directory with
 * `git archive`, then sync it on top of the working tree using a
 * write-temp-then-rename pattern per file, which avoids leaving
 * half-written files behind if the process is interrupted.
 *
 * Files present in the working tree but absent from the checkpoint
 * are left untouched by default (safer for a "restore" than a hard
 * `git reset --hard`, which could delete work the user made after
 * forking outside of ccm). Pass { prune: true } for exact-match
 * (delete extras) behavior.
 */
function restoreTree(cwd, commitSha, opts = {}) {
  const treeSha = run(['rev-parse', `${commitSha}^{tree}`], { cwd });
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-restore-'));

  try {
    const archivePath = path.join(extractDir, 'snapshot.tar');
    run(['archive', '--format=tar', '-o', archivePath, treeSha], { cwd });

    const untarDir = path.join(extractDir, 'tree');
    fs.mkdirSync(untarDir);
    execFileSync('tar', ['-xf', archivePath, '-C', untarDir]);

    const restoredFiles = [];
    walkAndCopy(untarDir, cwd, untarDir, restoredFiles);

    if (opts.prune) {
      pruneExtraFiles(cwd, treeSha, untarDir);
    }

    return { restoredFiles };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function walkAndCopy(baseDir, destRoot, dir, restoredFiles) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const srcPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, srcPath);
    const destPath = path.join(destRoot, relPath);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      walkAndCopy(baseDir, destRoot, srcPath, restoredFiles);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const tmpDest = `${destPath}.ccm-tmp-${process.pid}`;
      fs.copyFileSync(srcPath, tmpDest);
      fs.renameSync(tmpDest, destPath); // atomic on same filesystem
      restoredFiles.push(relPath);
    }
  }
}

function pruneExtraFiles(cwd, treeSha, untarDir) {
  const trackedNow = new Set(
    run(['ls-tree', '-r', '--name-only', treeSha], { cwd })
      .split('\n')
      .filter(Boolean)
  );
  const currentTracked = run(['ls-files'], { cwd })
    .split('\n')
    .filter(Boolean);
  for (const f of currentTracked) {
    if (!trackedNow.has(f)) {
      const abs = path.join(cwd, f);
      if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    }
  }
}

function diffStat(cwd, shaA, shaB) {
  if (!shaA) {
    return run(['diff', '--stat', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', shaB], {
      cwd,
    });
  }
  return run(['diff', '--stat', shaA, shaB], { cwd });
}

module.exports = {
  GitError,
  isGitRepo,
  initRepoIfNeeded,
  currentHeadSha,
  snapshotWorkingTree,
  commitTree,
  updateRef,
  deleteRef,
  restoreTree,
  diffStat,
  refName,
  CCM_REF_NAMESPACE,
};
