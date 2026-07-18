# Claude Checkpoint Manager (`ccm`)

**Git-native checkpoints for AI-assisted coding sessions.** Save your code *and* your AI session context together, browse a clean timeline, and roll back instantly — without ever polluting your real `git log`.

> If you've ever had an AI coding assistant go sideways mid-task and wished you could rewind *both* the files and the conversation state to a known-good point, this is that rewind button.

**Status: beta.** Core commands (`init`, `save`, `status`, `restore`) are implemented and tested, but this hasn't seen much real-world use outside development testing yet. Expect rough edges, and back up anything critical before relying on `--prune` restores. Feedback and issue reports welcome.

---

## Why

Committing every experimental step to your real git history is noisy. Stashing loses context and doesn't survive session state. `ccm` solves this by storing checkpoints as ordinary git commit objects that live on **custom refs** (`refs/ccm/checkpoints/*`) — invisible to `git log`, `git status`, and your branches, but still backed by git's content-addressable storage, so unchanged files across checkpoints cost near-zero extra disk space.

## Features

- [x] `ccm init` — one-command setup, auto-detects local Claude Code state paths
- [x] `ccm save "<message>"` — snapshots code + session state, versioned & timestamped
- [x] `ccm status` — clean chronological timeline with file counts, size, and token estimates
- [x] `ccm restore --step <id>` — safe rollback with automatic pre-restore safety save
- [x] Zero pollution of your real `git log` / branches / reflog
- [x] Secret-aware capture (skips anything that looks like a credential/token/key)
- [x] Size-capped session-state capture (large files are referenced, not blindly copied)
- [x] `--dry-run` and `--prune` restore modes
- [x] Pure JSON metadata store — no native/SQLite build dependency
- [x] Cross-platform (macOS, Linux, Windows via Node.js)

## How it works

```
                         ┌────────────────────────────┐
                         │        ccm save "…"        │
                         └──────────────┬─────────────┘
                                        │
                 ┌──────────────────────┼──────────────────────┐
                 ▼                                              ▼
     ┌───────────────────────┐                      ┌───────────────────────┐
     │   Git Plumbing Layer   │                      │  Session State Layer  │
     │  (lib/git.js)          │                      │  (lib/sessionState.js)│
     │                         │                      │                       │
     │ 1. scratch GIT_INDEX_   │                      │ 1. scan ~/.claude,    │
     │    FILE  (never touches │                      │    ~/.config/claude,  │
     │    real staging area)   │                      │    ./.claude          │
     │ 2. git add -A           │                      │ 2. skip secret-looking│
     │ 3. git write-tree       │                      │    filenames          │
     │ 4. git commit-tree      │                      │ 3. copy small files,  │
     │    (parent = last       │                      │    hash+reference     │
     │     checkpoint)         │                      │    large ones         │
     │ 5. update-ref           │                      │ 4. copy optional      │
     │    refs/ccm/checkpoints/│                      │    --context export   │
     │    <id>   ◄─ NOT a      │                      └───────────┬───────────┘
     │    branch, invisible to │                                  │
     │    `git log`            │                                  │
     └────────────┬────────────┘                                  │
                  │                                                │
                  └──────────────────┬─────────────────────────────┘
                                     ▼
                         ┌───────────────────────┐
                         │   .ccm/checkpoints.json│
                         │   (lib/store.js)       │
                         │   atomic JSON writes   │
                         └───────────────────────┘


                       ccm restore --step <id>
                                 │
                 ┌───────────────┼────────────────┐
                 ▼                                 ▼
     ┌─────────────────────┐          ┌─────────────────────────┐
     │ 1. AUTO SAFETY SAVE   │          │ 2. git archive target    │
     │    (current state,    │          │    tree → temp dir →     │
     │    even if "polluted")│          │    write-then-rename      │
     │    → new checkpoint,  │          │    copy into working tree │
     │    always reversible  │          └────────────┬─────────────┘
     └───────────────────────┘                       │
                                                       ▼
                                     ┌─────────────────────────────┐
                                     │ 3. clear + replay captured   │
                                     │    session-state files back  │
                                     │    to their original paths   │
                                     └─────────────────────────────┘
```

**Design principles:**

- **Isolated git plumbing.** Every staging operation uses a scratch `GIT_INDEX_FILE`, and checkpoint commits are only reachable from `refs/ccm/checkpoints/*` — never a branch. Your visible `git log` graph never changes.
- **No corruption, no races.** Restores use write-to-temp-then-atomic-rename per file. A safety checkpoint of the *current* state is always taken automatically before a restore runs, so a restore is itself always undoable.
- **Honest about session state.** Claude Code's on-disk session format isn't a published, stable API, so `ccm` treats detected state directories as opaque file trees (safe generic copy/restore) rather than trying to parse or rewrite an internal database. You can also point `ccm save` at any exported conversation/context file with `--context`.
- **Secret-aware.** Filenames matching common credential/token/key patterns are never copied into a checkpoint.

## Installation

```bash
# From this repository
git clone https://github.com/mqz0211/Claude-Checkpoint-Manager-CCM.git
cd Claude-Checkpoint-Manager-CCM
npm install
npm link          # makes the `ccm` command available globally

# Or, once published:
npm install -g claude-checkpoint-manager
```

Requires Node.js >= 16 and `git` on your `PATH`.

## Usage

```bash
cd your-project

# One-time setup — also indexes any detected Claude Code state paths
ccm init

# Capture a checkpoint of your code + session state
ccm save "before refactoring the auth module"

# ...work with your AI assistant, things get messy...

# See your checkpoint timeline
ccm status

#   Claude Checkpoint Timeline
#
#   ├─ #1 before refactoring the auth module
#   │    4b8d36b4  12m ago  38 files  ~1204 tok  1.2 MB
#   │
#   └─ #2 mid-refactor, tests failing
#        f0472aff  3m ago   41 files  ~2110 tok  1.4 MB

# Roll back files + session state to checkpoint #1
ccm restore --step 1

# Preview a restore without changing anything
ccm restore --step 1 --dry-run

# Restore and also delete files that didn't exist at that checkpoint
ccm restore --step 1 --prune

# Attach an exported AI conversation/context file to a checkpoint
ccm save "clean baseline" --context ./exports/session-2026-07-15.json
```

### Commands

| Command | Description |
|---|---|
| `ccm init` | Set up `.ccm/`, add it to `.gitignore`, index detected session-state paths |
| `ccm save "<message>" [--context <file>]` | Create a new checkpoint |
| `ccm status` | Print the checkpoint timeline |
| `ccm restore --step <id> [--dry-run] [--prune]` | Roll back to a checkpoint, with an automatic pre-restore safety save |

## Repository layout

```
claude-checkpoint-manager/
├── bin/
│   └── ccm.js              # CLI entry point (commander-based)
├── lib/
│   ├── git.js               # Isolated git plumbing (snapshot/commit/restore)
│   ├── sessionState.js       # Session-state capture & restore
│   ├── store.js              # .ccm/checkpoints.json metadata store
│   └── ui.js                  # Timeline rendering
├── test/
│   └── run.js                  # Smoke test (init → save → save → restore)
├── bootstrap_repo.py            # Regenerates this entire repo + zips it
├── package.json
├── README.md
├── LICENSE
└── .gitignore
```

## Testing

```bash
npm test
```

## Contributing

Issues and PRs welcome. Areas that would particularly benefit from contributions: a `ccm diff --step <id>` command, checkpoint pruning/GC for `refs/ccm/*`, and richer session-state adapters as Claude Code's local state format evolves.

## License

MIT — see [LICENSE](./LICENSE).
