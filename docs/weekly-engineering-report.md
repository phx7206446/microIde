# microIDE Weekly Engineering Work Report

> **Repository:** `microIDE` (code-oss + Theia + Cline + Void integration with `microClaude` sidecar)
> **Report Week:** YYYY-MM-DD ~ YYYY-MM-DD (Week N)
> **Author:** <name>
> **Branch Focus:** `dev-0.3.3-dynamic-workflow` (or current active branch)
> **Release Track:** microClaude v0.x.x

---

## 1. Executive Summary

A 2–3 sentence snapshot of the week's biggest outcome. Tie it back to the release milestone and the dynamic workflow / agent-view roadmap.

- **Headline outcome:**
- **Release readiness:** 🟢 On track / 🟡 At risk / 🔴 Off track
- **Demo / artifact link (if any):**

---

## 2. Shipped Work

List features, fixes, and refactors that landed this week. Group by area.

### 2.1 microClaude (runtime / CLI / sidecar)

| Area | Change | Commit(s) | Notes |
| --- | --- | --- | --- |
| Workflow | <e.g. aligned dynamic workflow runtime with upstream> | `e462aefd` | … |
| Agent-view | <e.g. upgraded background session PTY multiplexer> | `68b34a88` | … |
| Hooks | <…> | `…` | … |
| Loop | <…> | `…` | … |
| Env | <…> | `…` | … |

### 2.2 microIDE (IDE shell — code-oss / Theia / Cline / Void)

| Area | Change | Commit(s) | Notes |
| --- | --- | --- | --- |
| UI | <…> | `…` | … |
| Build / packaging | <…> | `…` | … |
| Tooling | <…> | `…` | … |

### 2.3 Infrastructure / Tooling

- <item>

---

## 3. Pull Requests

| PR | Title | Author | Status | Reviewers | Linked Issue |
| --- | --- | --- | --- | --- | --- |
| #<num> | <title> | <name> | Open / Merged / Closed | <…> | #<num> |

### 3.1 PRs opened this week
- …

### 3.2 PRs merged this week
- …

### 3.3 PRs awaiting review (> 24h)
- …

---

## 4. Commits (full week)

> Generated via: `git log --since="<monday>" --until="<next monday>" --author="<me>" --oneline`

```text
<short-sha>  <subject>
<short-sha>  <subject>
…
```

### 4.1 Commit breakdown by area
- `microClaude` runtime: N
- `microIDE` IDE shell: N
- Build / release: N
- Docs: N
- Other: N

---

## 5. Quality, Tests, and Benchmarks

- **Unit tests added / updated:**
- **Integration / e2e tests:**
- **Parity benchmarks vs. upstream:**
- **Coverage delta:**
- **Lint / typecheck status:**
- **Bun / npm audit findings:**

---

## 6. Release / Versioning

| Item | Status | Notes |
| --- | --- | --- |
| microClaude version cut | v0.x.x — ✅ / ⏳ | … |
| `dev-0.3.3-dynamic-workflow` → `main` PR | ⏳ / ✅ | … |
| Sidecar release plan updated | ⏳ / ✅ | see `docs/microclaude-sidecar-release-plan.md` |
| Build & launch process verified | ⏳ / ✅ | see `docs/microide-build-and-launch-process.md` |

---

## 7. Blockers and Risks

| # | Blocker / Risk | Impact | Owner | Mitigation / ETA |
| --- | --- | --- | --- | --- |
| 1 | <…> | High / Med / Low | <name> | <…> |
| 2 | <…> | … | … | … |

### 7.1 Cross-team dependencies
- <item>

### 7.2 Upstream drift risk
- <item>

---

## 8. Decisions Made (ADRs / informal)

- **Decision:** <…>
  **Context:** <…>
  **Consequences:** <…>
- **Decision:** <…>

---

## 9. Learnings and Retrospective

- **What went well:**
  - …
- **What didn't go well:**
  - …
- **What to try next week:**
  - …

---

## 10. Next Week's Plan

### 10.1 Committed goals
- [ ] <goal> — owner: <name> — due: <date>
- [ ] <goal> — owner: <name> — due: <date>

### 10.2 PRs to open
- [ ] <PR title> — draft at: <branch>
- [ ] …

### 10.3 Releases planned
- [ ] <release name> — target: <date>

### 10.4 Carry-over from this week
- [ ] <item>

---

## 11. Metrics Dashboard

| Metric | This Week | Last Week | Δ |
| --- | --- | --- | --- |
| Commits (branch) | | | |
| PRs opened / merged | / | / | |
| Open PRs | | | |
| Open issues assigned | | | |
| Avg. PR time-to-first-review | | | |
| Avg. PR time-to-merge | | | |
| Test failures (CI) | | | |
| Open blockers | | | |

---

## 12. Appendix

### 12.1 Useful commands

```bash
# Commits for the week on the active branch
git log --since="<mon>" --until="<next mon>" --oneline

# Author-scoped commits
git log --since="<mon>" --author="$(git config user.name)" --pretty=format:"%h %s"

# Files changed summary
git diff --stat <last-week-tag>..HEAD

# Open PRs (requires gh CLI)
gh pr list --state open --author @me

# Unreleased changelog candidate
git log --since="<last-release-tag>" --pretty=format:"- %s (%h)" --no-merges
```

### 12.2 Related docs
- `docs/microide-build-and-launch-process.md`
- `docs/microclaude-sidecar-release-plan.md`
- `docs/microide-microclaude-integration-analysis.md`
- `docs/microide-release-staging.md`

### 12.3 Glossary
- **microIDE** — the integrated IDE shell (code-oss + Theia + Cline + Void).
- **microClaude** — the AI runtime / sidecar driving dynamic workflow and agent-view.
- **Dynamic workflow** — runtime that builds / adapts the workflow graph per request.
- **PTY multiplexer** — background-session terminal orchestration in `agent-view`.
- **Parity benchmark** — test suite that compares microClaude behaviour with upstream Claude Code.

---

*Template version: 0.1 — iterate each week; remove empty sections before publishing.*
