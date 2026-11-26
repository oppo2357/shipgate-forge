import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  detectBlastCategories,
  evaluateReleaseReadiness,
  formatJiraGateComment,
} from "../src/scoring.ts";

test("fail-closed BLOCK when high-priority billing/DB issue has open blocker and missing rollback sign-off", () => {
  const report = evaluateReleaseReadiness({
    issueKey: "PAY-412",
    summary: "Migrate settlement webhook ledger schema to Postgres v16",
    priority: "Highest",
    status: "In Review",
    assignee: "Kenji Takahashi",
    labels: ["billing", "migration"],
    description: "Applies ALTER TABLE on payout ledger. Acceptance Criteria: zero duplicate settlements.",
    subtasksTotal: 4,
    subtasksDone: 3,
    blockers: [
      {
        key: "SEC-109",
        summary: "Verify idempotency TTL lock before production cutover",
        status: "In Progress",
        done: false,
        priority: "Highest",
      },
    ],
    runbooks: [
      {
        id: "9901",
        title: "Settlement Worker Runbook",
        url: "https://example.atlassian.net/wiki/spaces/ENG/pages/9901",
        daysSinceUpdate: 84,
        hasRollbackSection: false,
      },
    ],
    checklist: {
      featureFlagGuarded: false,
      rollbackVerified: false,
      monitoringAlertsConfigured: false,
      canaryPlanApproved: false,
    },
  });

  assert.equal(report.verdict, "BLOCK");
  assert.ok(report.score < 60);
  assert.ok(report.blastCategories.includes("DB_MIGRATION"));
  assert.ok(report.blastCategories.includes("BILLING_PAYMENTS"));
  assert.ok(report.rollbackSteps.length >= 4);
});

test("verdict transitions to GO (100/100) when blockers resolved, runbook fresh with rollback, and checklist signed", () => {
  const report = evaluateReleaseReadiness({
    issueKey: "PAY-412",
    summary: "Migrate settlement webhook ledger schema",
    priority: "High",
    status: "Ready for Deploy",
    assignee: "Kenji Takahashi",
    labels: ["migration"],
    description: "Given staging verification passes, When canary deploys at 5%, Then error rate stays <0.1%.",
    subtasksTotal: 4,
    subtasksDone: 4,
    blockers: [
      {
        key: "SEC-109",
        summary: "Verify idempotency TTL lock",
        status: "Done",
        done: true,
        priority: "High",
      },
    ],
    runbooks: [
      {
        id: "9901",
        title: "Settlement Worker Runbook",
        url: "https://example.atlassian.net/wiki/spaces/ENG/pages/9901",
        daysSinceUpdate: 5,
        hasRollbackSection: true,
      },
    ],
    checklist: {
      featureFlagGuarded: true,
      rollbackVerified: true,
      monitoringAlertsConfigured: true,
      canaryPlanApproved: true,
    },
  });

  assert.equal(report.verdict, "GO");
  assert.equal(report.score, 100);
  const comment = formatJiraGateComment(report);
  assert.match(comment, /Verdict: GO/);
  assert.match(comment, /PAY-412/);
});

test("manifest.yml declares official Atlassian Forge jira, rovo:agent, and action modules", () => {
  const mf = fs.readFileSync(new URL("../manifest.yml", import.meta.url), "utf8");
  assert.match(mf, /jira:issuePanel:/);
  assert.match(mf, /jira:projectPage:/);
  assert.match(mf, /rovo:agent:/);
  assert.match(mf, /audit-issue-readiness/);
  assert.match(mf, /nodejs22\.x/);
  assert.deepEqual(detectBlastCategories("Update OAuth JWT token rotation", "", ["auth"]), ["AUTH_SECURITY"]);
});
