# Extension 9.3.0 — merge / integration plan

**Not executed.** No merge, deploy or production ZIP replacement until separately approved.

## Branches and base
| Item | Value |
|---|---|
| Release branch (this work) | `extension-9.3.0` in worktree `/root/newrep-extension-ux` |
| Approved UX base | tag `ux-approved-baseline-68a0c7a` (commit `68a0c7a`, branch `extension-ux-redesign`) |
| Fork point | `f5e73a5` = current HEAD of `release/4.13.0-hybrid` (the production line) |
| `main` | 91 commits behind `f5e73a5`; not the integration target |

The extension commits sit directly on `f5e73a5`, so as long as `release/4.13.0-hybrid` has no new commits the
integration is a **fast-forward** of committed history.

## Commits that belong to the extension release
`git log --oneline f5e73a5..extension-9.3.0` — all of them are extension-only:
1. `68a0c7a` UX/performance redesign (approved base).
2. The 9.3.0 release-candidate commit(s) on `extension-9.3.0` (version, trust/permissions, Results polish, e2e
   suite update, release docs). Exact hashes: see the final report.

## Files that move (all paths)
- `extension/**` (runtime + `extension/test/**`)
- `browser-host/**` (moved out of `extension/`; optional helper, packaged separately)
- `tools/ux/**`, `tools/release-audit.py`, `tools/package-release.py`, `tools/e2e/extension-suite.mjs`
- `docs/EXTENSION-UX-9.3.md`, `docs/WEB-TAURI-UI-HANDOFF.md`, `docs/RELEASE-NOTES-9.3.0.md`,
  `docs/KNOWN-LIMITATIONS-9.3.0.md`, `docs/AV-TRUST-REPORT-9.3.0.md`, `docs/MERGE-PLAN-9.3.0.md`
- `README.md` (two lines: extension version, browser-host row), `eslint.config.mjs` (one glob: `tools/ux/*.mjs`)

**No file under `server/` is changed.** Server version stays 4.15.1.

## Must NOT be carried over
- Anything from the main worktree's uncommitted state: HTTP telemetry/research work (`server/src/*forensics*`,
  `server/src/http-forensics.js`, `server/src/results.js`, `server/src/utils.js`, `docs/DIRECT-HTTP-TELEMETRY.md`,
  `docs/MINIMAL-DIRECT-HTTP-TELEMETRY-DESIGN.md`, `docs/benchmarks/`, `research-export-tools/`,
  `production-background-*`, `tools/*http-forensics*`, `GGBET-MAINTENANCE-RESTORE.md`, `NEXT-INCIDENT-SNAPSHOT.sh`,
  `SAFE-RECOVERY-LADDER.md`).
- Local, git-ignored items of this worktree: `node_modules` and `server/node_modules` symlinks, `dist/` (artifacts are
  copied deliberately, see below).

## Expected conflicts
- With the committed `release/4.13.0-hybrid` (`f5e73a5`): **none** (fast-forward).
- With the main worktree's *uncommitted* files: no path overlap today (they are all under `server/`, `docs/` with other
  names, and new `tools/` files). Git would still refuse a checkout/merge in a dirty tree only for overlapping paths;
  none overlap. Re-check with `git diff --name-only` right before integrating.
- If the release branch gets new commits first, only `README.md`, `eslint.config.mjs`, `tools/package-release.py` or
  `tools/e2e/extension-suite.mjs` could conflict (shared files); resolve by keeping both sides.

## Recommended procedure (when approved)
1. Ask the telemetry/research agent to commit (on its own branch) or confirm its working tree is parked — never
   stash/reset its files.
2. In the main worktree: `git fetch` (local) and verify `git rev-parse release/4.13.0-hybrid` is still `f5e73a5`.
3. `git merge --ff-only extension-9.3.0` on `release/4.13.0-hybrid` (or open a PR from `extension-9.3.0`).
   If not fast-forward: `git rebase release/4.13.0-hybrid` on `extension-9.3.0` in this worktree, rerun all tests,
   rebuild, then fast-forward.
4. Run `npm run test:extension`, `node tools/e2e/extension-suite.mjs` (needs `server/node_modules`),
   `node tools/ux/ux-harness.mjs verify`, `python3 tools/release-audit.py <zip>`.
5. Copy the approved artifacts (do not rebuild unless the version is bumped):
   `dist/Esports-Monitor-extension-9.3.0.zip` (+ its SHA256) and, optionally,
   `dist/Esports-Monitor-browser-host-9.3.0-optional.zip` into the release location. Keep
   `Esports-Monitor-extension-9.2.0.zip` (rollback) untouched.
6. Deployment/distribution is a separate, explicitly approved step.

## Rollback
Reinstall `Esports-Monitor-extension-9.2.0.zip`
(SHA256 `f9dd08aa82af5ff3c140f3d14c607cf21ad96f2b402c1468a8f3d7e5bedb8236`). No server change to undo. User
preferences stay compatible (9.3 only adds keys: `theme`, `lineClosedGames`, `ux930`; 9.2 ignores them; the 9.2
DataBet choice was migrated to GGBET and would have to be re-selected in 9.2 if wanted).
