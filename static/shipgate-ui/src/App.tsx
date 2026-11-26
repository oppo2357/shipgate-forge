import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FileText,
  GitBranch,
  MessageSquarePlus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  evaluateReleaseReadiness,
  formatJiraGateComment,
  type ReleaseContextInput,
} from "../../../src/scoring";
import { SAMPLE_ISSUES } from "./samples";

async function safeForgeInvoke<T>(fnName: string, payload?: Record<string, unknown>): Promise<T | null> {
  if (typeof window === "undefined" || window === window.parent) {
    return null;
  }
  try {
    const bridge = await import("@forge/bridge");
    return (await bridge.invoke(fnName, payload)) as T;
  } catch {
    return null;
  }
}

export default function App() {
  const [forgeConnected, setForgeConnected] = useState(false);
  const [issues, setIssues] = useState<ReleaseContextInput[]>(() =>
    SAMPLE_ISSUES.map((x) => ({
      ...x,
      blockers: x.blockers.map((b) => ({ ...b })),
      runbooks: x.runbooks.map((r) => ({ ...r })),
      checklist: { ...x.checklist },
    }))
  );
  const [activeKey, setActiveKey] = useState<string>(SAMPLE_ISSUES[0].issueKey);
  const [maxRunbookAgeDays, setMaxRunbookAgeDays] = useState<number>(60);
  const [waiverReason, setWaiverReason] = useState("");
  const [rovoOutput, setRovoOutput] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const probeForge = async () => {
      const res = await safeForgeInvoke<{ mode?: string; context?: ReleaseContextInput }>("getIssueAudit");
      if (active && res?.context) {
        setForgeConnected(true);
        setIssues([res.context]);
        setActiveKey(res.context.issueKey);
      }
    };
    void probeForge();
    return () => {
      active = false;
    };
  }, []);

  const currentIssue = useMemo(
    () => issues.find((i) => i.issueKey === activeKey) ?? issues[0],
    [issues, activeKey]
  );

  const report = useMemo(
    () =>
      evaluateReleaseReadiness({
        ...currentIssue,
        policy: { maxRunbookAgeDays, requireRollbackForHighPriority: true },
      }),
    [currentIssue, maxRunbookAgeDays]
  );

  const updateCurrentIssue = (updater: (prev: ReleaseContextInput) => ReleaseContextInput) => {
    setIssues((prev) =>
      prev.map((item) => (item.issueKey === currentIssue.issueKey ? updater(item) : item))
    );
  };

  const toggleChecklist = async (field: keyof ReleaseContextInput["checklist"]) => {
    const nextChecklist = {
      ...currentIssue.checklist,
      [field]: !currentIssue.checklist[field],
    };
    updateCurrentIssue((prev) => ({ ...prev, checklist: nextChecklist }));
    if (forgeConnected) {
      await safeForgeInvoke("saveChecklist", {
        issueKey: currentIssue.issueKey,
        checklist: nextChecklist,
        waiver: currentIssue.waiver,
      });
    }
  };

  const toggleBlockerDone = (blockerKey: string) => {
    updateCurrentIssue((prev) => ({
      ...prev,
      blockers: prev.blockers.map((b) =>
        b.key === blockerKey ? { ...b, done: !b.done, status: !b.done ? "Done" : "In Progress" } : b
      ),
    }));
  };

  const completeAllSubtasks = () => {
    updateCurrentIssue((prev) => ({ ...prev, subtasksDone: prev.subtasksTotal }));
  };

  const refreshRunbook = (runbookId: string) => {
    updateCurrentIssue((prev) => ({
      ...prev,
      runbooks: prev.runbooks.map((r) =>
        r.id === runbookId ? { ...r, daysSinceUpdate: 1, hasRollbackSection: true } : r
      ),
    }));
  };

  const handleApplyWaiver = (e: FormEvent) => {
    e.preventDefault();
    if (waiverReason.trim().length < 8) return;
    updateCurrentIssue((prev) => ({
      ...prev,
      waiver: {
        approvedBy: "Release Manager",
        reason: waiverReason.trim(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }));
    setWaiverReason("");
    setNotice(`24h signed exception waiver attached to ${currentIssue.issueKey} (BLOCK downgraded to HOLD).`);
  };

  const handleRunRovoAction = (actionKey: "audit-issue-readiness" | "generate-rollback-plan" | "post-gate-comment") => {
    if (actionKey === "audit-issue-readiness") {
      setRovoOutput(
        `// rovo:agent -> action: audit-issue-readiness({ issueKey: "${currentIssue.issueKey}" })\n` +
          JSON.stringify(
            {
              issueKey: report.issueKey,
              verdict: report.verdict,
              score: report.score,
              blastCategories: report.blastCategories,
              blockers: report.findings.filter((f) => f.severity === "BLOCKER").map((f) => f.title),
            },
            null,
            2
          )
      );
      setNotice(`Rovo Agent audited ${currentIssue.issueKey}: Verdict ${report.verdict} (${report.score}/100).`);
    } else if (actionKey === "generate-rollback-plan") {
      setRovoOutput(
        `// rovo:agent -> action: generate-rollback-plan({ issueKey: "${currentIssue.issueKey}" })\n` +
          report.rollbackSteps.join("\n")
      );
      setNotice(`Rovo Agent generated ${report.rollbackSteps.length}-step rollback runbook for ${currentIssue.issueKey}.`);
    } else {
      const comment = formatJiraGateComment(report);
      setRovoOutput(
        `// rovo:agent -> action: post-gate-comment({ issueKey: "${currentIssue.issueKey}" })\n` + comment
      );
      if (forgeConnected) {
        void safeForgeInvoke("postAuditComment", { issueKey: currentIssue.issueKey });
      }
      setNotice(`Prepared signed ShipGate audit comment for Jira issue ${currentIssue.issueKey}.`);
    }
  };

  return (
    <div className="sg-shell">
      <header className="sg-header">
        <div className="sg-brand">
          <div className="sg-logo">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h1 className="sg-title">ShipGate</h1>
            <div className="sg-subtitle">
              Context-Aware Release Readiness &amp; Blast-Radius Guard · Atlassian Forge + Rovo Agent
            </div>
          </div>
        </div>

        <div className="sg-badges">
          <span className="pill blue">
            <GitBranch size={13} />
            Jira + Confluence + Rovo
          </span>
          <span className={`pill ${forgeConnected ? "go" : "neutral"}`}>
            {forgeConnected ? "Live Jira Cloud Forge Context" : "Interactive Judge Sandbox"}
          </span>
          <label className="pill neutral" style={{ cursor: "pointer" }}>
            Runbook SLA:
            <select
              value={maxRunbookAgeDays}
              onChange={(e) => setMaxRunbookAgeDays(Number(e.target.value))}
              aria-label="Runbook freshness policy days"
              style={{ border: "none", background: "transparent", fontWeight: 700, color: "inherit" }}
            >
              <option value={30}>30d</option>
              <option value={60}>60d</option>
              <option value={90}>90d</option>
            </select>
          </label>
        </div>
      </header>

      {/* Release Queue Switcher */}
      <div className="sg-issue-bar">
        <div className="sg-tabs" role="tablist" aria-label="Release candidate issues">
          {issues.map((item) => {
            const evalItem = evaluateReleaseReadiness({
              ...item,
              policy: { maxRunbookAgeDays, requireRollbackForHighPriority: true },
            });
            return (
              <button
                key={item.issueKey}
                type="button"
                role="tab"
                aria-selected={item.issueKey === currentIssue.issueKey}
                className={`sg-tab ${item.issueKey === currentIssue.issueKey ? "active" : ""}`}
                onClick={() => {
                  setActiveKey(item.issueKey);
                  setNotice(null);
                  setRovoOutput("");
                }}
              >
                <span className="mono">{item.issueKey}</span>
                <span
                  className={`pill ${
                    evalItem.verdict === "GO" ? "go" : evalItem.verdict === "HOLD" ? "hold" : "block"
                  }`}
                  style={{ padding: "2px 7px", fontSize: 11 }}
                >
                  {evalItem.verdict} · {evalItem.score}
                </span>
              </button>
            );
          })}
        </div>

        <span className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          Priority: {currentIssue.priority} · Owner: {currentIssue.assignee}
        </span>
      </div>

      {notice && (
        <div className="pill blue" style={{ borderRadius: 8, padding: "8px 12px", justifyContent: "space-between" }}>
          <span>{notice}</span>
        </div>
      )}

      <main className="sg-grid">
        {/* Column 1: Aggregated Jira + Confluence Context */}
        <section className="card" aria-label="Cross-Product Release Context">
          <div>
            <div className="card-eyebrow">Stage 1 · Cross-Product Context</div>
            <h2 className="card-title">
              <span className="mono">{currentIssue.issueKey}</span> — {currentIssue.summary}
            </h2>
          </div>

          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-sub)", lineHeight: 1.5 }}>
            {currentIssue.description}
          </p>

          <div>
            <div className="card-eyebrow" style={{ marginBottom: 6 }}>
              Detected Blast-Radius Signals
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {report.blastCategories.length === 0 ? (
                <span className="pill go">Standard UI / Low Blast</span>
              ) : (
                report.blastCategories.map((cat) => (
                  <span key={cat} className="pill hold mono" style={{ fontSize: 11 }}>
                    {cat}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Linked Jira Blockers */}
          <div>
            <div className="card-eyebrow" style={{ marginBottom: 6 }}>
              Linked Jira Blockers ({currentIssue.blockers.length})
            </div>
            {currentIssue.blockers.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--go)" }}>No blocking Jira links attached.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {currentIssue.blockers.map((b) => (
                  <div key={b.key} className="finding-row">
                    <div className="finding-head">
                      <span className="mono">
                        {b.key} · {b.status}
                      </span>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => toggleBlockerDone(b.key)}
                      >
                        {b.done ? "Reopen" : "Mark Resolved"}
                      </button>
                    </div>
                    <div className="finding-detail">{b.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Subtasks */}
          <div className="finding-row">
            <div className="finding-head">
              <span>
                Sub-tasks: {currentIssue.subtasksDone}/{currentIssue.subtasksTotal} complete
              </span>
              {currentIssue.subtasksDone < currentIssue.subtasksTotal && (
                <button type="button" className="btn sm" onClick={completeAllSubtasks}>
                  Complete Remaining
                </button>
              )}
            </div>
          </div>

          {/* Linked Confluence Runbooks */}
          <div>
            <div className="card-eyebrow" style={{ marginBottom: 6 }}>
              Linked Confluence Runbooks
            </div>
            {currentIssue.runbooks.map((rb) => (
              <div key={rb.id} className="finding-row">
                <div className="finding-head">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <FileText size={13} />
                    {rb.title}
                  </span>
                  {(rb.daysSinceUpdate > maxRunbookAgeDays || !rb.hasRollbackSection) && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => refreshRunbook(rb.id)}
                    >
                      <RefreshCw size={12} />
                      Verify &amp; Refresh
                    </button>
                  )}
                </div>
                <div className="finding-detail">
                  Updated {rb.daysSinceUpdate}d ago · Rollback section:{" "}
                  <strong>{rb.hasRollbackSection ? "Present" : "Missing"}</strong>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Column 2: Fail-Closed Gate Verdict & Findings */}
        <section className="card" aria-label="Release Gate Verdict">
          <div>
            <div className="card-eyebrow">Stage 2 · Fail-Closed Gate Engine</div>
            <h2 className="card-title">Release Readiness Verdict</h2>
          </div>

          <div className={`verdict-banner ${report.verdict}`} data-testid="verdict-banner">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 18 }}>
                {report.verdict === "GO" && <CheckCircle2 size={20} />}
                {report.verdict === "HOLD" && <AlertTriangle size={20} />}
                {report.verdict === "BLOCK" && <ShieldAlert size={20} />}
                {report.verdict} TO SHIP
              </div>
              <div style={{ fontSize: 12, marginTop: 3 }}>
                {report.verdict === "GO"
                  ? "All release guards passed. Safe for production rollout."
                  : report.verdict === "HOLD"
                  ? "Warnings or active waiver present. Review before cutover."
                  : "Hard release blockers detected. Deploy gated fail-closed."}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="score-ring" data-testid="readiness-score">
                {report.score}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700 }}>/ 100</div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {report.findings.map((f) => (
              <div key={f.id} className="finding-row">
                <div className="finding-head">
                  <span>{f.title}</span>
                  <span
                    className={`pill ${
                      f.severity === "PASS" ? "go" : f.severity === "WARNING" ? "hold" : "block"
                    }`}
                    style={{ fontSize: 10.5, padding: "2px 7px" }}
                  >
                    {f.severity} {f.pointsDelta !== 0 ? f.pointsDelta : ""}
                  </span>
                </div>
                <div className="finding-detail">{f.detail}</div>
              </div>
            ))}
          </div>

          {/* Forge Storage Operator Checklist */}
          <div>
            <div className="card-eyebrow" style={{ marginBottom: 6 }}>
              Operator Sign-Offs (Persisted in @forge/kvs)
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {(
                [
                  ["rollbackVerified", "Rollback / backout procedure verified in staging"],
                  ["featureFlagGuarded", "Guarded behind runtime feature flag / kill switch"],
                  ["monitoringAlertsConfigured", "SLO dashboards & pager alerts verified"],
                  ["canaryPlanApproved", "5% -> 25% -> 100% canary rollout approved"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="check-item">
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={currentIssue.checklist[key]}
                    onChange={() => void toggleChecklist(key)}
                  />
                </label>
              ))}
            </div>
          </div>

          {report.verdict === "BLOCK" && (
            <form onSubmit={handleApplyWaiver} style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                className="input"
                placeholder="Emergency waiver reason (min 8 chars)..."
                value={waiverReason}
                onChange={(e) => setWaiverReason(e.target.value)}
              />
              <button type="submit" className="btn sm">
                Sign Waiver
              </button>
            </form>
          )}
        </section>

        {/* Column 3: Rovo Agent Actions & Rollback Plan */}
        <section className="card" aria-label="Rovo Agent and Rollback Plan">
          <div>
            <div className="card-eyebrow">Stage 3 · Rovo Agent &amp; Rollback Runbook</div>
            <h2 className="card-title">ShipGate Rovo Release Auditor</h2>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={() => handleRunRovoAction("audit-issue-readiness")}
            >
              <Bot size={15} />
              Run Rovo: audit-issue-readiness
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => handleRunRovoAction("generate-rollback-plan")}
            >
              <ShieldCheck size={15} />
              Run Rovo: generate-rollback-plan
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => handleRunRovoAction("post-gate-comment")}
            >
              <MessageSquarePlus size={15} />
              Post Signed Gate Comment to Jira
            </button>
          </div>

          {rovoOutput && (
            <pre className="rovo-box mono" data-testid="rovo-output">
              {rovoOutput}
            </pre>
          )}

          <div>
            <div className="card-eyebrow" style={{ marginBottom: 6 }}>
              Generated Blast-Radius Rollback Checklist
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {report.rollbackSteps.map((step, idx) => (
                <div key={idx} className="finding-row" style={{ fontSize: 12, color: "var(--ink-sub)" }}>
                  {step}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
