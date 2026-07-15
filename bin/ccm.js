#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Command } = require('commander');
const chalk = require('chalk');

const git = require('../lib/git');
const store = require('../lib/store');
const sessionState = require('../lib/sessionState');
const ui = require('../lib/ui');

const program = new Command();

program
  .name('ccm')
  .description('Claude Checkpoint Manager — git-native checkpoints for AI-assisted coding sessions')
  .version(require('../package.json').version);

function fail(message) {
  console.error(chalk.red(`✖ ${message}`));
  process.exitCode = 1;
}

function requireInitialized(cwd) {
  if (!store.isInitialized(cwd)) {
    fail('ccm has not been initialized here. Run `ccm init` first.');
    return false;
  }
  return true;
}

function shortId() {
  return crypto.randomBytes(8).toString('hex');
}

function directorySizeBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

/* ------------------------------- init ------------------------------- */

program
  .command('init')
  .description('Set up the local .ccm/ store and index active session paths')
  .action(() => {
    const cwd = process.cwd();

    git.initRepoIfNeeded(cwd);

    const alreadyInitialized = store.isInitialized(cwd);
    const config = store.initStore(cwd, {});

    const candidates = sessionState.candidateStatePaths(cwd);

    // Keep .ccm/ out of the visible git status/diff noise if a
    // .gitignore exists or can be created.
    const gitignorePath = path.join(cwd, '.gitignore');
    const ignoreLine = '.ccm/';
    try {
      const existing = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf8')
        : '';
      if (!existing.split('\n').includes(ignoreLine)) {
        fs.appendFileSync(
          gitignorePath,
          `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${ignoreLine}\n`
        );
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ could not update .gitignore: ${err.message}`));
    }

    console.log(
      alreadyInitialized
        ? chalk.yellow('ccm store already existed — re-verified setup.')
        : chalk.green('✔ Initialized .ccm/ checkpoint store')
    );
    console.log(chalk.dim(`  repo: ${cwd}`));
    console.log(chalk.dim(`  checkpoint refs live under: ${git.CCM_REF_NAMESPACE}/*`));
    if (candidates.length) {
      console.log(chalk.dim(`  detected session-state paths:`));
      candidates.forEach((p) => console.log(chalk.dim(`    - ${p}`)));
    } else {
      console.log(
        chalk.dim(
          '  no local Claude Code state directories detected (~/.claude, ~/.config/claude, ./.claude).'
        )
      );
      console.log(
        chalk.dim(
          '  you can still capture AI context manually with `ccm save "msg" --context <file>`.'
        )
      );
    }
    console.log(chalk.dim(`  next checkpoint number: ${config.nextCheckpointNumber}`));
  });

/* ------------------------------- save ------------------------------- */

program
  .command('save <message>')
  .description('Capture code diffs + AI session state as a new checkpoint')
  .option('-c, --context <file>', 'path to an exported conversation/context file to capture alongside the code')
  .option('--auto', 'mark this checkpoint as an automatic safety save (used internally by restore)', false)
  .action((message, opts) => {
    const cwd = process.cwd();
    if (!requireInitialized(cwd)) return;

    const config = store.readConfig(cwd);
    const checkpoints = store.readCheckpoints(cwd);
    const lastCheckpoint = checkpoints[checkpoints.length - 1];

    const id = shortId();
    const number = config.nextCheckpointNumber;

    const { treeSha, fileCount } = git.snapshotWorkingTree(cwd);
    const parentSha = lastCheckpoint ? lastCheckpoint.commitSha : git.currentHeadSha(cwd);
    const commitSha = git.commitTree(cwd, treeSha, `ccm checkpoint #${number}: ${message}`, parentSha);
    git.updateRef(cwd, id, commitSha);

    const sessDir = store.sessionDir(cwd, id);
    const manifest = sessionState.captureSessionState(cwd, sessDir, {
      contextFile: opts.context,
    });

    let contextChars = 0;
    if (manifest.contextFile) {
      try {
        contextChars = fs
          .readFileSync(path.join(sessDir, manifest.contextFile.storedAs), 'utf8')
          .length;
      } catch {
        /* binary or unreadable as utf8; leave estimate at 0 */
      }
    }
    const sessionSizeBytes = directorySizeBytes(sessDir);
    const sessionTokenEstimate = ui.estimateTokens(contextChars);

    const record = {
      id,
      number,
      message,
      createdAt: new Date().toISOString(),
      treeSha,
      commitSha,
      parentCommitSha: parentSha || null,
      filesChanged: fileCount,
      sessionSizeBytes,
      sessionTokenEstimate,
      autoSafety: !!opts.auto,
    };
    store.addCheckpoint(cwd, record);

    console.log(chalk.green(`✔ Checkpoint #${number} saved`) + chalk.dim(`  (${id.slice(0, 8)})`));
    console.log(chalk.dim(`  files tracked in snapshot: ${fileCount}`));
    console.log(chalk.dim(`  session state captured:    ${formatManifestSummary(manifest)}`));
    return record;
  });

function formatManifestSummary(manifest) {
  const copied = manifest.sources.reduce(
    (n, s) => n + s.files.filter((f) => f.mode === 'copied').length,
    0
  );
  const refOnly = manifest.sources.reduce(
    (n, s) => n + s.files.filter((f) => f.mode === 'reference-only').length,
    0
  );
  const parts = [];
  if (manifest.contextFile) parts.push('1 context export');
  if (copied) parts.push(`${copied} state file(s) copied`);
  if (refOnly) parts.push(`${refOnly} large file(s) referenced only`);
  return parts.length ? parts.join(', ') : 'none found';
}

/* ------------------------------ status ------------------------------ */

program
  .command('status')
  .description('Show the checkpoint timeline')
  .action(() => {
    const cwd = process.cwd();
    if (!requireInitialized(cwd)) return;
    const checkpoints = store.readCheckpoints(cwd);
    ui.printTimeline(checkpoints);
  });

/* ------------------------------ restore ------------------------------ */

program
  .command('restore')
  .description('Roll back files and AI session state to a saved checkpoint')
  .requiredOption('--step <id>', 'checkpoint number or id to restore')
  .option('--prune', 'also delete files not present in the target checkpoint', false)
  .option('--dry-run', 'show what would change without touching any files', false)
  .action((opts) => {
    const cwd = process.cwd();
    if (!requireInitialized(cwd)) return;

    const target = store.findCheckpoint(cwd, opts.step);
    if (!target) {
      fail(`No checkpoint matching "${opts.step}" was found. Run \`ccm status\` to see valid ids/numbers.`);
      return;
    }

    console.log(chalk.bold(`Restoring to checkpoint #${target.number}: ${target.message}`));

    // 1. Emergency safety auto-save of current (possibly "polluted")
    //    state, so restore is always reversible with `ccm restore`
    //    back to the auto-save that gets created here.
    if (!opts.dryRun) {
      const config = store.readConfig(cwd);
      const checkpoints = store.readCheckpoints(cwd);
      const lastCheckpoint = checkpoints[checkpoints.length - 1];
      const id = shortId();
      const number = config.nextCheckpointNumber;

      const { treeSha, fileCount } = git.snapshotWorkingTree(cwd);
      const parentSha = lastCheckpoint ? lastCheckpoint.commitSha : git.currentHeadSha(cwd);
      const commitSha = git.commitTree(
        cwd,
        treeSha,
        `ccm auto safety-save before restoring to #${target.number}`,
        parentSha
      );
      git.updateRef(cwd, id, commitSha);
      const sessDir = store.sessionDir(cwd, id);
      const manifest = sessionState.captureSessionState(cwd, sessDir, {});
      store.addCheckpoint(cwd, {
        id,
        number,
        message: `auto safety-save before restoring to #${target.number}`,
        createdAt: new Date().toISOString(),
        treeSha,
        commitSha,
        parentCommitSha: parentSha || null,
        filesChanged: fileCount,
        sessionSizeBytes: directorySizeBytes(sessDir),
        sessionTokenEstimate: 0,
        autoSafety: true,
      });
      console.log(chalk.dim(`  ✔ safety checkpoint #${number} created (${id.slice(0, 8)}) before restore`));
      void manifest;
    } else {
      console.log(chalk.dim('  (dry run: skipping safety checkpoint)'));
    }

    // 2. Restore filesystem state from the target checkpoint's tree.
    const { restoredFiles } = git.restoreTree(cwd, target.commitSha, {
      prune: opts.prune,
    });
    if (!opts.dryRun) {
      console.log(chalk.green(`  ✔ restored ${restoredFiles.length} file(s) from checkpoint #${target.number}`));
    } else {
      console.log(chalk.dim(`  would restore ${restoredFiles.length} file(s)`));
    }

    // 3. Clear the current (polluted) session-state capture area and
    //    replay the pristine one captured at the target checkpoint.
    //    This only touches the well-known, non-secret files ccm
    //    itself copied at save time — never a live database in place.
    const targetSessDir = store.sessionDir(cwd, target.id);
    const { restored, referenceOnly, warnings } = sessionState.restoreSessionState(
      targetSessDir,
      { dryRun: opts.dryRun }
    );

    if (restored.length) {
      console.log(
        chalk.green(
          `  ✔ ${opts.dryRun ? 'would restore' : 'restored'} ${restored.length} session-state file(s)`
        )
      );
    }
    if (referenceOnly.length) {
      console.log(
        chalk.yellow(
          `  ⚠ ${referenceOnly.length} large session file(s) were only referenced (not copied) at save time — restore these manually if needed:`
        )
      );
      referenceOnly.forEach((f) =>
        console.log(chalk.dim(`      ${path.join(f.sourcePath, f.path)}`))
      );
    }
    warnings.forEach((w) => console.log(chalk.yellow(`  ⚠ ${w}`)));

    console.log(chalk.bold.green(`\nDone. Working tree and captured session state now match checkpoint #${target.number}.`));
  });

program.parseAsync(process.argv);
