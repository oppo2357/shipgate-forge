export type GateVerdict = "GO" | "HOLD" | "BLOCK";

export type BlastCategory = "DB_MIGRATION" | "API_BREAKING" | "AUTH_SECURITY" | "BILLING_PAYMENTS" | "INFRA_CONFIG";

export interface LinkedBlocker {
  key: string;
  summary: string;
  status: string;
  done: boolean;
  priority: "Highest" | "High" | "Medium" | "Low";
}

export interface LinkedRunbook {
  id: string;
  title: string;
  url: string;
  daysSinceUpdate: number;
  hasRollbackSection: boolean;
}

export interface ReleaseContextInput {
  issueKey: string;
  summary: string;
  priority: "Highest" | "High" | "Medium" | "Low";
  status: string;
  assignee: string;
  labels: string[];
  description: string;
  subtasksTotal: number;
  subtasksDone: number;
  blockers: LinkedBlocker[];
  runbooks: LinkedRunbook[];
  checklist: {
    featureFlagGuarded: boolean;
    rollbackVerified: boolean;
    monitoringAlertsConfigured: boolean;
    canaryPlanApproved: boolean;
  };
  waiver?: {
    approvedBy: string;
    reason: string;
    expiresAt: string;
  } | null;
  policy?: {
    maxRunbookAgeDays: number;
    requireRollbackForHighPriority: boolean;
  };
}

export interface GateCheckFinding {
  id: string;
  severity: "BLOCKER" | "WARNING" | "PASS";
  title: string;
  detail: string;
  pointsDelta: number;
}

export interface GateAuditReport {
  issueKey: string;
  score: number;
  verdict: GateVerdict;
  blastCategories: BlastCategory[];
  findings: GateCheckFinding[];
  rollbackSteps: string[];
  waiverActive: boolean;
  auditedAt: string;
}

export function detectBlastCategories(summary: string, description: string, labels: string[]): BlastCategory[] {
  const hay = `${summary} ${description} ${labels.join(" ")}`.toLowerCase();
  const out: BlastCategory[] = [];
  if (/(migration|schema|alter table|postgres|prisma|index|backfill)/.test(hay)) out.push("DB_MIGRATION");
  if (/(breaking|deprecat|v2|openapi|graphql|webhook|contract)/.test(hay)) out.push("API_BREAKING");
  if (/(auth|oauth|jwt|rbac|permission|token|kms|secret)/.test(hay)) out.push("AUTH_SECURITY");
  if (/(stripe|billing|invoice|payout|settlement|charge|refund|ledger)/.test(hay)) out.push("BILLING_PAYMENTS");
  if (/(terraform|k8s|kubernetes|redis|ttl|cdn|cloudflare|nginx|worker)/.test(hay)) out.push("INFRA_CONFIG");
  return out;
}

export function evaluateReleaseReadiness(input: ReleaseContextInput): GateAuditReport {
  const maxRunbookAge = input.policy?.maxRunbookAgeDays ?? 60;
  const requireRollbackHigh = input.policy?.requireRollbackForHighPriority ?? true;

  let score = 100;
  const findings: GateCheckFinding[] = [];
  let hardBlockerCount = 0;
  let warningCount = 0;

  const blastCategories = detectBlastCategories(input.summary, input.description, input.labels);

  // 1. Linked Jira Blockers
  const openBlockers = input.blockers.filter((b) => !b.done);
  if (openBlockers.length > 0) {
    const penalty = Math.min(45, openBlockers.length * 22);
    score -= penalty;
    hardBlockerCount += 1;
    findings.push({
      id: "open-blockers",
      severity: "BLOCKER",
      title: `${openBlockers.length} unresolved blocking issue(s)`,
      detail: openBlockers.map((b) => `${b.key} (${b.status}): ${b.summary}`).join("; "),
      pointsDelta: -penalty,
    });
  } else {
    findings.push({
      id: "open-blockers",
      severity: "PASS",
      title: "Zero unresolved Jira blockers",
      detail: input.blockers.length > 0 ? `All ${input.blockers.length} linked blocker(s) resolved.` : "No blocking links attached.",
      pointsDelta: 0,
    });
  }

  // 2. Sub-tasks Completion
  const openSubtasks = Math.max(0, input.subtasksTotal - input.subtasksDone);
  if (openSubtasks > 0) {
    const penalty = Math.min(24, openSubtasks * 8);
    score -= penalty;
    if (input.priority === "Highest" || input.priority === "High") {
      hardBlockerCount += 1;
    } else {
      warningCount += 1;
    }
    findings.push({
      id: "subtasks",
      severity: input.priority === "Highest" || input.priority === "High" ? "BLOCKER" : "WARNING",
      title: `${openSubtasks}/${input.subtasksTotal} sub-task(s) incomplete`,
      detail: "Complete or explicitly descope remaining implementation sub-tasks before deploy.",
      pointsDelta: -penalty,
    });
  } else {
    findings.push({
      id: "subtasks",
      severity: "PASS",
      title: "All sub-tasks complete",
      detail: `${input.subtasksDone}/${input.subtasksTotal} sub-tasks done.`,
      pointsDelta: 0,
    });
  }

  // 3. Linked Confluence Runbook Freshness & Rollback Section
  if (input.runbooks.length === 0) {
    const isCritical = blastCategories.length > 0 || input.priority === "Highest" || input.priority === "High";
    const penalty = isCritical ? 20 : 10;
    score -= penalty;
    if (isCritical && requireRollbackHigh) hardBlockerCount += 1;
    else warningCount += 1;
    findings.push({
      id: "confluence-runbook",
      severity: isCritical && requireRollbackHigh ? "BLOCKER" : "WARNING",
      title: "No linked Confluence runbook or release doc",
      detail: "Attach an up-to-date Confluence runbook covering rollback steps and service owners.",
      pointsDelta: -penalty,
    });
  } else {
    const freshest = [...input.runbooks].sort((a, b) => a.daysSinceUpdate - b.daysSinceUpdate)[0];
    if (freshest.daysSinceUpdate > maxRunbookAge) {
      score -= 12;
      warningCount += 1;
      findings.push({
        id: "confluence-runbook",
        severity: "WARNING",
        title: `Linked Confluence runbook is stale (${freshest.daysSinceUpdate}d old)`,
        detail: `"${freshest.title}" exceeds the ${maxRunbookAge}-day freshness policy.`,
        pointsDelta: -12,
      });
    } else if (!freshest.hasRollbackSection && requireRollbackHigh && (input.priority === "Highest" || input.priority === "High")) {
      score -= 15;
      hardBlockerCount += 1;
      findings.push({
        id: "confluence-runbook",
        severity: "BLOCKER",
        title: "Confluence runbook missing Rollback section",
        detail: `"${freshest.title}" was updated ${freshest.daysSinceUpdate}d ago but lacks explicit rollback commands.`,
        pointsDelta: -15,
      });
    } else {
      findings.push({
        id: "confluence-runbook",
        severity: "PASS",
        title: `Confluence runbook fresh (${freshest.daysSinceUpdate}d ago)`,
        detail: `"${freshest.title}" verified with rollback procedure.`,
        pointsDelta: 0,
      });
    }
  }

  // 4. Acceptance Criteria presence
  const hasAC = /(acceptance criteria|given .* when .* then|done when|verification)/i.test(input.description);
  if (!hasAC) {
    score -= 10;
    warningCount += 1;
    findings.push({
      id: "acceptance-criteria",
      severity: "WARNING",
      title: "Acceptance criteria not detected in description",
      detail: "Add explicit verification or Given/When/Then acceptance criteria for QA sign-off.",
      pointsDelta: -10,
    });
  } else {
    findings.push({
      id: "acceptance-criteria",
      severity: "PASS",
      title: "Acceptance criteria present",
      detail: "Explicit verification language detected in ticket description.",
      pointsDelta: 0,
    });
  }

  // 5. Blast-Radius Operator Sign-offs
  if (blastCategories.length > 0 && !input.checklist.rollbackVerified) {
    score -= 15;
    if (blastCategories.includes("DB_MIGRATION") || blastCategories.includes("BILLING_PAYMENTS")) {
      hardBlockerCount += 1;
    } else {
      warningCount += 1;
    }
    findings.push({
      id: "rollback-signoff",
      severity:
        blastCategories.includes("DB_MIGRATION") || blastCategories.includes("BILLING_PAYMENTS")
          ? "BLOCKER"
          : "WARNING",
      title: `High blast-radius change (${blastCategories.join(", ")}) missing rollback sign-off`,
      detail: "Confirm expand-and-contract or revert steps before production cutover.",
      pointsDelta: -15,
    });
  } else if (input.checklist.rollbackVerified) {
    findings.push({
      id: "rollback-signoff",
      severity: "PASS",
      title: "Rollback procedure verified",
      detail: "Release owner signed off on tested rollback path.",
      pointsDelta: 0,
    });
  }

  if (!input.checklist.monitoringAlertsConfigured) {
    score -= 8;
    warningCount += 1;
    findings.push({
      id: "monitoring-alerts",
      severity: "WARNING",
      title: "Post-deploy SLO / alert verification unchecked",
      detail: "Verify error-rate and latency dashboards before enabling 100% traffic.",
      pointsDelta: -8,
    });
  } else {
    findings.push({
      id: "monitoring-alerts",
      severity: "PASS",
      title: "Observability & alert thresholds verified",
      detail: "Dashboards and pager alerts confirmed active.",
      pointsDelta: 0,
    });
  }

  if (!input.checklist.featureFlagGuarded && blastCategories.length > 0) {
    score -= 6;
    warningCount += 1;
    findings.push({
      id: "feature-flag",
      severity: "WARNING",
      title: "Feature flag / gradual canary rollout unchecked",
      detail: "Wrap high-blast paths behind a kill-switch flag for instant mitigation.",
      pointsDelta: -6,
    });
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const waiverActive = Boolean(input.waiver && input.waiver.reason.trim().length >= 8);

  let verdict: GateVerdict = "GO";
  if (hardBlockerCount > 0 || boundedScore < 60) {
    verdict = waiverActive ? "HOLD" : "BLOCK";
  } else if (warningCount > 0 || boundedScore < 85) {
    verdict = "HOLD";
  }

  const rollbackSteps: string[] = [
    `1. Freeze rollout for ${input.issueKey} and toggle feature flag OFF (target < 60s mitigation).`,
  ];
  if (blastCategories.includes("DB_MIGRATION")) {
    rollbackSteps.push("2. Confirm schema migration is backward-compatible (expand-only); do NOT run destructive down-migration until read traffic drains.");
  }
  if (blastCategories.includes("BILLING_PAYMENTS")) {
    rollbackSteps.push("3. Pause settlement/billing worker queue and run idempotency reconciliation ledger check before re-enabling.");
  }
  if (blastCategories.includes("API_BREAKING")) {
    rollbackSteps.push("4. Restore previous API gateway routing rule / version header pin for downstream consumers.");
  }
  if (blastCategories.includes("AUTH_SECURITY")) {
    rollbackSteps.push("5. Revoke any newly minted signing keys and verify session validation fallback.");
  }
  rollbackSteps.push(
    `${rollbackSteps.length + 1}. Verify error rate < 0.1% and p99 latency baseline for 15 minutes, then post incident status back on ${input.issueKey}.`
  );

  return {
    issueKey: input.issueKey,
    score: boundedScore,
    verdict,
    blastCategories,
    findings,
    rollbackSteps,
    waiverActive,
    auditedAt: new Date().toISOString(),
  };
}

export function formatJiraGateComment(report: GateAuditReport): string {
  const icon = report.verdict === "GO" ? "GREEN" : report.verdict === "HOLD" ? "AMBER" : "RED";
  const lines = [
    `[ShipGate Release Audit] Verdict: ${report.verdict} (${icon}) | Score: ${report.score}/100`,
    `Issue: ${report.issueKey} | Blast Radius: ${report.blastCategories.length > 0 ? report.blastCategories.join(", ") : "Standard"}`,
    "",
    "Findings:",
    ...report.findings.map((f) => `- [${f.severity}] ${f.title} — ${f.detail}`),
    "",
    "Rollback Checklist:",
    ...report.rollbackSteps.map((s) => `- ${s}`),
  ];
  return lines.join("\n");
}
