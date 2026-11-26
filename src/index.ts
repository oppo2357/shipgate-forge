import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import Resolver from "@forge/resolver";
import { fetchLiveIssueContext } from "./rovoActions";
import { evaluateReleaseReadiness, formatJiraGateComment, type ReleaseContextInput } from "./scoring";

const resolver = new Resolver();

resolver.define("getIssueAudit", async ({ context }) => {
  const issueKey = String((context.extension as { issue?: { key?: string } } | undefined)?.issue?.key ?? "");
  if (!issueKey) {
    return { mode: "project", issueKey: null, report: null };
  }
  const issueCtx = await fetchLiveIssueContext(issueKey);
  const report = evaluateReleaseReadiness(issueCtx);
  return { mode: "issue", issueKey, context: issueCtx, report };
});

resolver.define("saveChecklist", async ({ payload }) => {
  const p = payload as {
    issueKey: string;
    checklist: ReleaseContextInput["checklist"];
    waiver?: ReleaseContextInput["waiver"];
  };
  await kvs.set(`shipgate:issue:${p.issueKey}`, {
    checklist: p.checklist,
    waiver: p.waiver ?? null,
  });
  const issueCtx = await fetchLiveIssueContext(p.issueKey);
  const report = evaluateReleaseReadiness(issueCtx);
  return { ok: true, context: issueCtx, report };
});

resolver.define("postAuditComment", async ({ payload }) => {
  const p = payload as { issueKey: string };
  const issueCtx = await fetchLiveIssueContext(p.issueKey);
  const report = evaluateReleaseReadiness(issueCtx);
  const commentText = formatJiraGateComment(report);
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${p.issueKey}/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: commentText }] }],
      },
    }),
  });
  return { ok: res.ok, status: res.status, commentText };
});

export const handler = resolver.getDefinitions();
