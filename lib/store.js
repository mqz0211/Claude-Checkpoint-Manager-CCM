'use strict';

/**
 * lib/store.js
 *
 * Checkpoint metadata lives in .ccm/checkpoints.json as a flat JSON
 * array. This is intentionally not SQLite: the data volume is small
 * (one record per checkpoint), a plain JSON file is trivially
 * diff-able and human-readable, and it removes any native-module /
 * cross-platform build dependency from the tool. All writes go
 * through writeFileAtomic to avoid a corrupted store if the process
 * is killed mid-write.
 */

const fs = require('fs');
const path = require('path');

const CCM_DIR_NAME = '.ccm';
const STORE_FILE = 'checkpoints.json';
const CONFIG_FILE = 'config.json';

function ccmDir(cwd) {
  return path.join(cwd, CCM_DIR_NAME);
}

function storePath(cwd) {
  return path.join(ccmDir(cwd), STORE_FILE);
}

function configPath(cwd) {
  return path.join(ccmDir(cwd), CONFIG_FILE);
}

function isInitialized(cwd) {
  return fs.existsSync(ccmDir(cwd)) && fs.existsSync(storePath(cwd));
}

function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function initStore(cwd, config = {}) {
  fs.mkdirSync(ccmDir(cwd), { recursive: true });
  fs.mkdirSync(path.join(ccmDir(cwd), 'sessions'), { recursive: true });

  if (!fs.existsSync(storePath(cwd))) {
    writeFileAtomic(storePath(cwd), JSON.stringify([], null, 2));
  }
  const finalConfig = {
    createdAt: new Date().toISOString(),
    nextCheckpointNumber: 1,
    ...config,
  };
  if (!fs.existsSync(configPath(cwd))) {
    writeFileAtomic(configPath(cwd), JSON.stringify(finalConfig, null, 2));
  }
  return finalConfig;
}

function readConfig(cwd) {
  return JSON.parse(fs.readFileSync(configPath(cwd), 'utf8'));
}

function writeConfig(cwd, config) {
  writeFileAtomic(configPath(cwd), JSON.stringify(config, null, 2));
}

function readCheckpoints(cwd) {
  if (!fs.existsSync(storePath(cwd))) return [];
  return JSON.parse(fs.readFileSync(storePath(cwd), 'utf8'));
}

function writeCheckpoints(cwd, checkpoints) {
  writeFileAtomic(storePath(cwd), JSON.stringify(checkpoints, null, 2));
}

function addCheckpoint(cwd, record) {
  const checkpoints = readCheckpoints(cwd);
  checkpoints.push(record);
  writeCheckpoints(cwd, checkpoints);

  const config = readConfig(cwd);
  config.nextCheckpointNumber = record.number + 1;
  writeConfig(cwd, config);

  return record;
}

function findCheckpoint(cwd, idOrNumber) {
  const checkpoints = readCheckpoints(cwd);
  const asNumber = Number(idOrNumber);
  return (
    checkpoints.find((c) => c.id === idOrNumber) ||
    (Number.isFinite(asNumber)
      ? checkpoints.find((c) => c.number === asNumber)
      : undefined)
  );
}

function sessionDir(cwd, checkpointId) {
  return path.join(ccmDir(cwd), 'sessions', checkpointId);
}

module.exports = {
  CCM_DIR_NAME,
  ccmDir,
  isInitialized,
  initStore,
  readConfig,
  writeConfig,
  readCheckpoints,
  writeCheckpoints,
  addCheckpoint,
  findCheckpoint,
  sessionDir,
  writeFileAtomic,
};
