# ShipGate — Context-Aware Release Readiness & Blast-Radius Guard

Built on **Atlassian Forge** (`nodejs22.x`, `jira:issuePanel`, `jira:projectPage`, `rovo:agent`, `action`, `@forge/kvs`, Jira REST API v3, and Confluence REST API v2) for **Codegeist 2026** (*"Build with context. Ship with confidence"*).

## Live Interactive Judge Sandbox
- **Live Sandbox URL:** https://oppo2357.github.io/shipgate-forge/
- **Open-Source Repo (MIT):** https://github.com/oppo2357/shipgate-forge

## What ShipGate Solves
Shipping high-blast-radius changes (DB migrations, billing/settlement workers, OAuth token rotations) often fails because critical context is fragmented across Jira blockers, incomplete sub-tasks, stale Confluence runbooks, and undocumented rollback steps.

**ShipGate** aggregates cross-product context directly inside Jira and Rovo:
1. **Cross-Product Context Aggregator (`src/rovoActions.ts`)**: Reads live Jira issue fields, sub-tasks, inward `is blocked by` links, and remote-linked Confluence pages (verifying exact page age and presence of explicit rollback procedures via `/wiki/api/v2/pages/{id}`).
2. **Deterministic Fail-Closed Gate Engine (`src/scoring.ts`)**: Computes a transparent `0–100` readiness score, classifies blast-radius categories (`DB_MIGRATION`, `BILLING_PAYMENTS`, `API_BREAKING`, `AUTH_SECURITY`, `INFRA_CONFIG`), and enforces fail-closed `GO` / `HOLD` / `BLOCK` verdicts (with audited 24h emergency waivers persisted in `@forge/kvs`).
3. **Rovo Release Auditor Agent (`manifest.yml` `rovo:agent` + 3 Forge `action` modules)**: Engineers can ask Rovo directly in Jira/Confluence to run `audit-issue-readiness`, `generate-rollback-plan`, or `post-gate-comment` with live ticket citations.

## Local Verification & Forge Deployment
```bash
npm install
npm test                                    # Unit tests for scoring, blast-radius, and manifest schema
npm --prefix static/shipgate-ui install
npm run build                               # Typecheck Forge backend + build Custom UI

# Deploy to your Atlassian Cloud developer site:
npm install -g @forge/cli
forge login
forge register                              # Generates your app.id in manifest.yml
forge deploy
forge install
```
