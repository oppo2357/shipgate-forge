import type { ReleaseContextInput } from "../../../src/scoring";

export const SAMPLE_ISSUES: ReleaseContextInput[] = [
  {
    issueKey: "PAY-412",
    summary: "Migrate settlement webhook ledger schema to Postgres v16",
    priority: "Highest",
    status: "In Review",
    assignee: "Kenji Takahashi",
    labels: ["billing", "migration", "prod-us-west"],
    description:
      "Applies expand-and-contract ALTER TABLE on payout ledger and upgrades webhook idempotency worker. Acceptance Criteria: zero duplicate settlements under retry storm.",
    subtasksTotal: 4,
    subtasksDone: 3,
    blockers: [
      {
        key: "SEC-109",
        summary: "Verify Redis idempotency TTL lock before production cutover",
        status: "In Progress",
        done: false,
        priority: "Highest",
      },
    ],
    runbooks: [
      {
        id: "9901",
        title: "Settlement Webhook Worker Runbook",
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
    waiver: null,
  },
  {
    issueKey: "AUTH-208",
    summary: "Enforce OAuth PKCE & rotating refresh tokens on mobile gateway",
    priority: "High",
    status: "QA Verified",
    assignee: "Elena Vance",
    labels: ["auth", "security", "api-v2"],
    description:
      "Enforces strict PKCE verification and 15-minute JWT rotation across v2 gateway endpoints. Verification: iOS/Android regression suite passes.",
    subtasksTotal: 3,
    subtasksDone: 3,
    blockers: [
      {
        key: "INFRA-88",
        summary: "Provision secondary KMS signing key alias in eu-central-1",
        status: "Done",
        done: true,
        priority: "High",
      },
    ],
    runbooks: [
      {
        id: "7412",
        title: "OAuth Gateway Key Rotation Runbook",
        url: "https://example.atlassian.net/wiki/spaces/SEC/pages/7412",
        daysSinceUpdate: 72,
        hasRollbackSection: true,
      },
    ],
    checklist: {
      featureFlagGuarded: true,
      rollbackVerified: true,
      monitoringAlertsConfigured: false,
      canaryPlanApproved: true,
    },
    waiver: null,
  },
  {
    issueKey: "UI-889",
    summary: "Fix Safari payment sheet layout clipping on 390px viewports",
    priority: "Medium",
    status: "Ready for Deploy",
    assignee: "Sora Watanabe",
    labels: ["frontend", "safari"],
    description:
      "Adjusts sticky footer safe-area padding on iOS Safari checkout drawer. Given viewport 390x844, When checkout opens, Then Pay button remains fully visible.",
    subtasksTotal: 2,
    subtasksDone: 2,
    blockers: [],
    runbooks: [
      {
        id: "5210",
        title: "Storefront Web Rollout & Revert Guide",
        url: "https://example.atlassian.net/wiki/spaces/WEB/pages/5210",
        daysSinceUpdate: 6,
        hasRollbackSection: true,
      },
    ],
    checklist: {
      featureFlagGuarded: true,
      rollbackVerified: true,
      monitoringAlertsConfigured: true,
      canaryPlanApproved: true,
    },
    waiver: null,
  },
];
