'use strict';

const chalk = require('chalk');

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Rough, provider-agnostic token estimate (chars / 4), clearly labeled
// as an estimate everywhere it's shown — never presented as exact.
function estimateTokens(charCount) {
  return Math.round(charCount / 4);
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function printTimeline(checkpoints) {
  if (checkpoints.length === 0) {
    console.log(chalk.dim('No checkpoints yet. Run `ccm save "message"` to create one.'));
    return;
  }

  console.log(chalk.bold('\n  Claude Checkpoint Timeline\n'));

  const ordered = [...checkpoints].sort((a, b) => a.number - b.number);
  for (let i = 0; i < ordered.length; i++) {
    const cp = ordered[i];
    const isLast = i === ordered.length - 1;
    const connector = isLast ? '└─' : '├─';
    const stem = isLast ? '  ' : '│ ';

    const tag = chalk.cyan(`#${cp.number}`);
    const idShort = chalk.dim(cp.id.slice(0, 8));
    const when = chalk.dim(`${relativeTime(cp.createdAt)}`);
    const filesChanged = chalk.yellow(`${cp.filesChanged} files`);
    const tokenInfo = chalk.magenta(`~${cp.sessionTokenEstimate} tok`);

    console.log(`  ${connector} ${tag} ${chalk.bold(cp.message)}`);
    console.log(
      `  ${stem}   ${idShort}  ${when}  ${filesChanged}  ${tokenInfo}  ${chalk.dim(
        formatBytes(cp.sessionSizeBytes)
      )}`
    );
    if (cp.autoSafety) {
      console.log(`  ${stem}   ${chalk.dim('(auto safety checkpoint)')}`);
    }
    if (!isLast) console.log(`  │`);
  }
  console.log('');
}

module.exports = { formatBytes, estimateTokens, relativeTime, printTimeline };
