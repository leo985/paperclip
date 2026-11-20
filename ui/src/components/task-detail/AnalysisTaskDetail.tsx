import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AnalysisDecision, AnalysisReviewMaterials } from "@paperclipai/shared";
import { analysisApi, type AnalysisDetail } from "@/api/analysis-executions";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { AnalysisReportFile, analysisReportName } from "@/components/AnalysisReportFile";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Input } from "@/components/ui/input";
import { AnalysisQingzhouWriteback } from "@/components/AnalysisQingzhouWriteback";
import { ManagedSessionPanel } from "@/components/ManagedSessionPanel";
import { TaskIdentitySummary } from "./TaskIdentitySummary";
import { TaskDetailLayout } from "./TaskDetailLayout";
const stateNames: Record<string, string> = {
  interrupted: "会话已结束 · 分析未交付，可核验后恢复",
  draft: "未派发",
  queued: "已授权排队",
  running: "分析执行中",
  waiting: "等待人工决定",
  local_completed: "本地分析完成 · 待正式发布",
  published: "已登记正式发布",
};
const runNames: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  scheduled_retry: "等待重试",
  succeeded: "已结束",
  failed: "运行失败",
  cancelled: "已停止",
  timed_out: "运行超时",
};
const decisionNames: Record<string, string> = {
  open: "待回答",
  answered: "已保存 · 等待送达",
  delivered: "已送达 · 领域门禁独立核验",
  stale: "已失效",
};
function RequirementValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  const names: Record<string, string> = { items: "需求清单", questions: "业务问题与答复", id: "编号", statement: "需求描述", acceptance: "验收要求", evidence_ids: "引用证据", question: "问题", answer: "答复", status: "状态", blocking: "是否阻塞" };
  if (depth > 8) return <pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(value)}</pre>;
  if (Array.isArray(value)) return <div className="space-y-3">{value.map((v, i) => <div key={i} className="rounded-md border border-border p-3"><RequirementValue value={v} depth={depth + 1} /></div>)}</div>;
  if (value && typeof value === "object") return <dl className="space-y-2">{Object.entries(value).map(([key, v]) => <div key={key}><dt className="font-medium">{names[key] ?? key}</dt><dd className="whitespace-pre-wrap break-words"><RequirementValue value={v} depth={depth + 1} /></dd></div>)}</dl>;
  return String(value ?? "未填写");
}
function RequirementsContent({ content }: { content: string }) {
  try { return <RequirementValue value={JSON.parse(content)} />; }
  catch { return <pre className="whitespace-pre-wrap break-words text-sm">{content}</pre>; }
}

function ReviewMaterials({ materials, reportName }: { materials: AnalysisReviewMaterials; reportName: string }) {
  const labels = { "analysis.md": "分析正文", "requirements.json": "需求清单与业务答复", "intake.md": "需求背景与分析范围" };
  return <section className="space-y-3" aria-label="当前版本评审材料">
    <p className="text-xs text-muted-foreground">采集时间：{new Date(materials.capturedAt).toLocaleString()} · 以下材料对应本次评审的输入指纹。</p>
    {materials.documents.find(file => file.path === "analysis.md") && <AnalysisReportFile
      name={reportName}
      content={materials.documents.find(file => file.path === "analysis.md")!.content}
      sha256={materials.documents.find(file => file.path === "analysis.md")!.sha256}
      inputDigest={materials.inputDigest}
    />}
    <details className="space-y-3"><summary className="cursor-pointer font-medium">辅助材料：需求清单、业务答复与需求背景</summary>
    {(["requirements.json", "intake.md"] as const).map(path => {
      const file = materials.documents.find(f => f.path === path);
      return file && <details key={path} className="space-y-2 rounded-md border border-border p-3">
        <summary className="cursor-pointer font-medium">{labels[path]}</summary>
        {path.endsWith(".md") ? <MarkdownBody>{file.content}</MarkdownBody> : <RequirementsContent content={file.content} />}
        <p className="break-all font-mono text-xs text-muted-foreground">文件校验：{file.sha256}</p>
      </details>;
    })}
    </details>
    <details className="space-y-2 rounded-md border border-border p-3">
      <summary className="cursor-pointer font-medium">证据索引与引用附件（{materials.evidence.length} 项）</summary>
      <p className="text-sm text-muted-foreground">用于核对分析引用。附件原件保留在执行席位，本页展示来源、定位信息及文件校验。</p>
      {materials.evidence.map((item, i) => <article key={item.id + i} className="space-y-1 border-b border-border py-2 text-sm">
        <p className="font-medium">{item.id} · {item.kind}</p>
        <p className="break-all">{item.source}</p><p className="break-all">{item.locator}</p>
        <p className="break-all">{item.path}</p><p className="break-all font-mono text-xs text-muted-foreground">{item.sha256}</p>
      </article>)}
    </details>
  </section>;
}

function Answer({
  d,
  onAnswer,
  busy,
  canAnswer,
  materials,
  reportName,
}: {
  d: AnalysisDecision;
  onAnswer: (d: AnalysisDecision, a: string) => void;
  busy: boolean;
  canAnswer: boolean;
  materials?: AnalysisReviewMaterials;
  reportName: string;
}) {
  const [text, setText] = useState("");
  const reviewReady = materials?.runId === d.runId && materials?.inputDigest === d.inputDigest;
  return (
    <article className="space-y-2 rounded-md border border-border p-3">
      <p className="font-medium">
        {d.kind === "review" ? "当前版本质量评审" : "业务问题"} · {d.key} ·{" "}
        {decisionNames[d.status] ?? d.status}
      </p>
      <p className="whitespace-pre-wrap text-sm">{d.text}</p>
      <p className="break-all font-mono text-xs text-muted-foreground">
        输入指纹：{d.inputDigest}
      </p>
      {d.kind === "review" && (reviewReady && materials ? (
        <ReviewMaterials materials={materials} reportName={reportName} />
      ) : (
        <p role="alert" className="text-sm text-muted-foreground">当前版本评审材料尚未上传或已变化，暂不能批准。客户端上传后会自动展示。</p>
      ))}
      {d.status === "open" && canAnswer ? (
        <>
          <label className="block text-sm">
            {d.kind === "review"
              ? "退回原因（请先阅读上方当前版本评审材料）"
              : "明确答复"}
            <textarea
              aria-label={`答复 ${d.key}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="block w-full rounded-md border border-border bg-background p-2"
              rows={3}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            {d.kind === "review" ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy || !text.trim()}
                  onClick={() => onAnswer(d, "reject: " + text)}
                >
                  退回修改
                </Button>
                <Button disabled={busy || !reviewReady} onClick={() => onAnswer(d, "approve")}>
                  批准此输入版本
                </Button>
              </>
            ) : (
              <Button
                disabled={busy || !text.trim()}
                onClick={() => onAnswer(d, text)}
              >
                保存并发送给同一会话
              </Button>
            )}
          </div>
        </>
      ) : (
        d.answer && (
          <p className="whitespace-pre-wrap text-sm">
            答复：{d.answer === "approve" ? "批准当前输入版本" : d.answer} ·{" "}
            {d.answeredBy} ·{" "}
            {d.answeredAt ? new Date(d.answeredAt).toLocaleString() : ""}
          </p>
        )
      )}
    </article>
  );
}
export function AnalysisTaskDetail({
  detail,
  listHref,
  platformDeliverables,
}: {
  detail: AnalysisDetail;
  listHref: string;
  platformDeliverables?: ReactNode;
}) {
  const e = detail.execution,
    c = e.companyId,
    run = detail.run;
  const { canManage } = useManagementAccess();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [pubUrl, setPubUrl] = useState(""),
    [pubNote, setPubNote] = useState(""),
    [attest, setAttest] = useState(false);
  const [attestedVersion, setAttestedVersion] = useState("");
  const deliveryVersion = e.delivery
    ? `${e.delivery.inputDigest}:${e.delivery.handoffDigest}`
    : "";
  // Clear version-bound drafts when a refreshed delivery changes underneath an open form.
  useEffect(() => {
    setPubUrl("");
    setPubNote("");
    setAttest(false);
  }, [e.delivery?.inputDigest, e.delivery?.handoffDigest]);
  const active =
    !!run && ["queued", "running", "scheduled_retry"].includes(run.status);
  const revisionHref =
    "/issues?taskType=analysis&" +
    new URLSearchParams({ projectId: e.projectId, supersedesId: e.id });
  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setMessage(ok);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["analysis-list", c] }),
        qc.invalidateQueries({ queryKey: ["analysis-detail", c] }),
        qc.invalidateQueries({ queryKey: ["task-analysis", c, e.id] }),
        qc.invalidateQueries({ queryKey: ["issues"] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作未完成，请刷新重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <TaskDetailLayout
      overview={
        <>
          <header className="space-y-2">
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {e.title} · 修订 {e.revision}
              </h2>
              <Button variant="ghost" asChild>
                <Link to={listHref}>返回分析列表</Link>
              </Button>
            </div>
            <p>
              {stateNames[e.state] ?? e.state}
              {run ? ` · 运行：${runNames[run.status] ?? run.status}` : ""}
            </p>
            {detail.dispatchProblem && <p role="alert" className="text-sm text-destructive">{detail.dispatchProblem}</p>}
            {run?.error && (
              <p className="text-sm text-destructive">{run.error}</p>
            )}
            <p className="whitespace-pre-wrap text-sm">{e.brief}</p>
            <p className="text-sm">关联需求：{e.demandNo ?? "独立平台分析"}</p>
            <TaskIdentitySummary
              companyId={c}
              seatId={e.seatId}
              ownerUserId={e.ownerUserId}
            />
            <p className="text-xs text-muted-foreground">
              本地任务：pc-{e.id}-r{e.revision} · 负责人 {e.ownerUserId}
            </p>
          </header>
        </>
      }
      actions={
        <>
          <div aria-busy={busy}>
            <div className="flex flex-wrap gap-2">
              {canManage && !e.delivery && !active && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () =>
                        analysisApi.dispatch(
                          c!,
                          e.id,
                          !e.activeRunId && e.dispatchId
                            ? e.dispatchId
                            : crypto.randomUUID(),
                        ),
                      "派发请求已受理，请以最新运行状态为准。",
                    )
                  }
                >
                  {run || detail.dispatchProblem || e.state === "interrupted" ? "核验并恢复分析" : "授权并派发分析"}
                </Button>
              )}
              {active && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => analysisApi.stop(c!, e.id),
                      "停止请求已登记，等待本机进程树退出回执。",
                    )
                  }
                >
                  停止本次运行
                </Button>
              )}
              {canManage && e.delivery && (
                <Button variant="outline" asChild>
                  <Link to={revisionHref}>建立新修订</Link>
                </Button>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}{" "}
          <section className="space-y-3">
            {e.delivery?.analysisMarkdown && <AnalysisReportFile name={analysisReportName(e.demandNo, e.id)} content={e.delivery.analysisMarkdown} inputDigest={e.delivery.inputDigest} sha256={e.delivery.artifacts.find(file => file.path === "analysis.md")?.sha256} />}
            <h3 className="font-semibold">待决定问题与质量评审</h3>
            {detail.decisions.map((d) => (
              <Answer
                key={d.id + d.contentDigest + d.inputDigest}
                d={d}
                materials={e.snapshot?.reviewMaterials}
                reportName={analysisReportName(e.demandNo, e.id)}
                canAnswer={run?.status === "running" && !e.delivery}
                busy={busy}
                onAnswer={(d, a) =>
                  void act(
                    () => analysisApi.answer(c!, e.id, d, a),
                    "答复已保存，等待同一会话领取；不代表领域门禁已通过。",
                  )
                }
              />
            ))}
            {!detail.decisions.length && (
              <p className="text-sm text-muted-foreground">
                尚无上报问题；本机权限确认仍需在 Claude 终端处理。
              </p>
            )}
          </section>
        </>
      }
      progress={
        <>
          <section className="space-y-2">
            <h3 className="font-semibold">原生阶段与门禁</h3>
            <p>
              阶段 {e.snapshot?.phase ?? "未知"} · 已完成{" "}
              {e.snapshot?.completedPhases.join("、") || "尚无完成阶段"}
            </p>
            {e.snapshot?.gateErrors.length ? (
              <ul className="list-disc pl-5 text-sm">
                {e.snapshot.gateErrors.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {e.snapshot
                  ? "当前上报无门禁错误；本地完成与正式发布分别核验。"
                  : "等待本机状态回报；不把未上报当作通过。"}
              </p>
            )}
          </section>
          <ManagedSessionPanel companyId={c} taskId={e.id} view="progress" />
        </>
      }
      deliverables={
        <>
          <AnalysisQingzhouWriteback
            key={e.id}
            execution={e}
            canManage={canManage}
            busy={busy}
            onRetry={(options) =>
              void act(
                () => analysisApi.qingzhouWriteback(c!, e.id, options),
                "轻舟回写请求已处理，请查看回写状态。",
              )
            }
          />
          {e.delivery && (
            <section className="space-y-3">
              <h3 className="font-semibold">本地交付索引</h3>
              <p className="text-sm">
                已核验原生
                P0–P4；关联轻舟条目时分析正文会上传至平台并自动回写，其余原始客户材料留在本机，索引不等于共享交接包。
              </p>
              <p className="break-all font-mono text-xs">
                输入：{e.delivery.inputDigest}
                <br />
                交接：{e.delivery.handoffDigest}
              </p>
              <ul className="space-y-1 text-xs">
                {e.delivery.artifacts.map((a) => (
                  <li className="break-all font-mono" key={a.path}>
                    {a.path} · {a.sha256}
                  </li>
                ))}
              </ul>
              {e.publication ? (
                <div className="space-y-2 rounded-md bg-muted p-3 text-sm">
                  <a
                    className="underline"
                    href={e.publication.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看正式发布记录
                  </a>
                  <p>
                    人工核验登记 · {e.publication.verifiedBy} ·{" "}
                    {new Date(e.publication.verifiedAt).toLocaleString()}
                  </p>
                  <p>{e.publication.note}</p>
                  <p>
                    此记录为人工核验，尚无来源接口自动回读，不自动派发研发工单。
                  </p>
                </div>
              ) : canManage ? (
                <form
                  className="space-y-3"
                  onSubmit={(v) => {
                    v.preventDefault();
                    if (!attest || attestedVersion !== deliveryVersion || busy)
                      return;
                    void act(
                      () =>
                        analysisApi.publication(c!, e.id, {
                          inputDigest: e.delivery!.inputDigest,
                          handoffDigest: e.delivery!.handoffDigest,
                          url: pubUrl,
                          note: pubNote,
                          attest,
                        }),
                      "已登记当前交付版本的人工正式发布记录。",
                    );
                  }}
                >
                  <h4 className="font-medium">登记正式发布</h4>
                  <p className="text-sm text-muted-foreground">
                    先按正式流程发布材料并核对可访问的版本，再登记 Jira
                    或轻舟链接。此操作不是调用上游发布接口。
                  </p>
                  <Input
                    aria-label="正式发布链接"
                    type="url"
                    placeholder="Jira 或轻舟正式记录链接"
                    value={pubUrl}
                    required
                    onChange={(v) => setPubUrl(v.target.value)}
                  />
                  <textarea
                    aria-label="发布核验说明"
                    className="block w-full rounded-md border border-border bg-background p-2"
                    rows={3}
                    minLength={10}
                    required
                    value={pubNote}
                    onChange={(v) => setPubNote(v.target.value)}
                    placeholder="核验的正式活动、交接包位置、共享权限和对应版本"
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={attest && attestedVersion === deliveryVersion}
                      onChange={(v) => {
                        setAttest(v.target.checked);
                        setAttestedVersion(deliveryVersion);
                      }}
                    />
                    我已在正式来源核对上述版本及交接材料访问权限
                  </label>
                  <div className="flex justify-end">
                    <Button
                      disabled={
                        busy || !attest || attestedVersion !== deliveryVersion
                      }
                      type="submit"
                    >
                      登记已核验发布
                    </Button>
                  </div>
                </form>
              ) : (
                <p>待管理员核验正式发布。</p>
              )}
            </section>
          )}
          {!e.delivery && (
            <p className="text-sm text-muted-foreground">
              分析尚未形成已核验交付；会话结束不代表交付完成。
            </p>
          )}
          {platformDeliverables}
        </>
      }
      records={
        <ManagedSessionPanel companyId={c} taskId={e.id} view="records" />
      }
    />
  );
}
