import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import {
  evaluateReleaseReadiness,
  formatJiraGateComment,
  type LinkedBlocker,
  type LinkedRunbook,
  type ReleaseContextInput,
} from "./scoring";

interface StoredIssueState {
  checklist: ReleaseContextInput["checklist"];
  waiver: ReleaseContextInput["waiver"];
}

const DEFAULT_CHECKLIST: ReleaseContextInput["checklist"] = {
  featureFlagGuarded: false,
  rollbackVerified: false,
  monitoringAlertsConfigured: false,
  canaryPlanApproved: false,
};

function extractPlainText(adfOrStr: unknown): string {
  if (typeof adfOrStr === "string") return adfOrStr;
  if (!adfOrStr || typeof adfOrStr !== "object") return "";
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === "string") out.push(rec.text);
    if (Array.isArray(rec.content)) rec.content.forEach(walk);
  };
  walk(adfOrStr);
  return out.join(" ");
}

export async function fetchLiveIssueContext(issueKey: string): Promise<ReleaseContextInput> {
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description,priority,status,assignee,labels,subtasks,issuelinks`);
  const data = (await res.json()) as Record<string, unknown>;
  const fields = (data.fields ?? {}) as Record<string, unknown>;

  const subtasks = Array.isArray(fields.subtasks) ? (fields.subtasks as Array<Record<string, unknown>>) : [];
  const subtasksDone = subtasks.filter((st) => {
    const stFields = (st.fields ?? {}) as Record<string, unknown>;
    const stStatus = (stFields.status ?? {}) as Record<string, unknown>;
    const cat = (stStatus.statusCategory ?? {}) as Record<string, unknown>;
    return cat.key === "done";
  }).length;

  const links = Array.isArray(fields.issuelinks) ? (fields.issuelinks as Array<Record<string, unknown>>) : [];
  const blockers: LinkedBlocker[] = [];
  for (const lk of links) {
    const typeObj = (lk.type ?? {}) as Record<string, unknown>;
    const inward = (lk.inwardIssue ?? null) as Record<string, unknown> | null;
    if (inward && String(typeObj.inward ?? "").toLowerCase().includes("block")) {
      const bf = (inward.fields ?? {}) as Record<string, unknown>;
      const bs = (bf.status ?? {}) as Record<string, unknown>;
      const cat = (bs.statusCategory ?? {}) as Record<string, unknown>;
      const bp = (bf.priority ?? {}) as Record<string, unknown>;
      blockers.push({
        key: String(inward.key ?? "UNKNOWN"),
        summary: String(bf.summary ?? ""),
        status: String(bs.name ?? "Open"),
        done: cat.key === "done",
        priority: (String(bp.name ?? "Medium") as LinkedBlocker["priority"]),
      });
    }
  }

  // Query remote links to discover linked Confluence runbooks
  const runbooks: LinkedRunbook[] = [];
  try {
    const rlRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/remotelink`);
    const rls = (await rlRes.json()) as Array<Record<string, unknown>>;
    for (const rl of Array.isArray(rls) ? rls : []) {
      const obj = (rl.object ?? {}) as Record<string, unknown>;
      const url = String(obj.url ?? "");
      if (url.includes("/wiki/") || String(rl.application ?? "").toLowerCase().includes("confluence")) {
        const pageIdMatch = url.match(/pages\/(\d+)/);
        let daysSinceUpdate = 30;
        let hasRollbackSection = false;
        if (pageIdMatch?.[1]) {
          try {
            const cRes = await api
              .asApp()
              .requestConfluence(route`/wiki/api/v2/pages/${pageIdMatch[1]}?body-format=storage`);
            if (cRes.ok) {
              const cPage = (await cRes.json()) as Record<string, unknown>;
              const ver = (cPage.version ?? {}) as Record<string, unknown>;
              const created = Date.parse(String(ver.createdAt ?? ""));
              if (!Number.isNaN(created)) {
                daysSinceUpdate = Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
              }
              const bodyStr = JSON.stringify(cPage.body ?? "");
              hasRollbackSection = /rollback|revert|mitigation|backout/i.test(bodyStr);
            }
          } catch {
            // Preserve remote link metadata if Confluence scope not yet authorized
          }
        }
        runbooks.push({
          id: pageIdMatch?.[1] ?? String(rl.id ?? "rb"),
          title: String(obj.title ?? "Linked Confluence Runbook"),
          url,
          daysSinceUpdate,
          hasRollbackSection,
        });
      }
    }
  } catch {
    // Graceful fallback when no remote links exist
  }

  const stored = (await kvs.get<StoredIssueState>(`shipgate:issue:${issueKey}`)) ?? {
    checklist: { ...DEFAULT_CHECKLIST },
    waiver: null,
  };

  const priorityObj = (fields.priority ?? {}) as Record<string, unknown>;
  const statusObj = (fields.status ?? {}) as Record<string, unknown>;
  const assigneeObj = (fields.assignee ?? {}) as Record<string, unknown>;

  return {
    issueKey,
    summary: String(fields.summary ?? issueKey),
    priority: (String(priorityObj.name ?? "Medium") as ReleaseContextInput["priority"]),
    status: String(statusObj.name ?? "In Progress"),
    assignee: String(assigneeObj.displayName ?? "Unassigned"),
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    description: extractPlainText(fields.description),
    subtasksTotal: subtasks.length,
    subtasksDone,
    blockers,
    runbooks,
    checklist: stored.checklist,
    waiver: stored.waiver ?? null,
  };
}

export async function run(payload: { issueKey?: string; actionKey?: string }, context?: { moduleKey?: string }) {
  const issueKey = String(payload.issueKey ?? "").trim().toUpperCase();
  if (!issueKey) {
    return { error: "Missing required input: issueKey (e.g., PAY-412)" };
  }

  const issueCtx = await fetchLiveIssueContext(issueKey);
  const report = evaluateReleaseReadiness(issueCtx);
  const moduleKey = context?.moduleKey ?? payload.actionKey ?? "audit-issue-readiness";

  if (moduleKey === "generate-rollback-plan") {
    return {
      issueKey,
      verdict: report.verdict,
      blastCategories: report.blastCategories,
      rollbackSteps: report.rollbackSteps,
    };
  }

  if (moduleKey === "post-gate-comment") {
    const commentText = formatJiraGateComment(report);
    const commentRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: commentText }],
            },
          ],
        },
      }),
    });
    return {
      posted: commentRes.ok,
      status: commentRes.status,
      verdict: report.verdict,
      score: report.score,
    };
  }

  return report;
}
