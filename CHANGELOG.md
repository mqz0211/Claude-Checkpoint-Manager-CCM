# Changelog

## 1.1.0

- Initial public release.
- `ccm init` — sets up `.ccm/`, adds it to `.gitignore`, detects local Claude Code session-state paths.
- `ccm save "<message>" [--context <file>]` — snapshots the working tree via isolated git plumbing and captures session state, secret-filename-aware.
- `ccm status` — chronological checkpoint timeline with file counts, size, and token estimates.
- `ccm restore --step <id> [--dry-run] [--prune]` — restores files and session state, with an automatic pre-restore safety checkpoint.
- Checkpoint commits live under `refs/ccm/checkpoints/*`, never touching the visible branch history.
