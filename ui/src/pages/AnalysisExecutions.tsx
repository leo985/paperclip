import { HarnessEnrollmentGuide } from "@/components/HarnessEnrollmentGuide";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { AnalysisDecision } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { projectsApi } from "@/api/projects";
import { analysisApi } from "@/api/analysis-executions";
import { ManagedSessionPanel } from "@/components/ManagedSessionPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router";
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
const field = "rounded-md border border-border bg-background p-2 text-sm";
function Answer({
  d,
  onAnswer,
  busy,
  canAnswer,
}: {
  d: AnalysisDecision;
  onAnswer: (d: AnalysisDecision, a: string) => void;
  busy: boolean;
  canAnswer: boolean;
}) {
  const [text, setText] = useState("");
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
      {d.status === "open" && canAnswer ? (
        <>
          <label className="block text-sm">
            {d.kind === "review"
              ? "退回原因（批准前请在本机核对当前版本材料）"
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
                <Button disabled={busy} onClick={() => onAnswer(d, "approve")}>
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
export function AnalysisExecutions() {
  const { selectedCompanyId: c } = useCompany(),
    { setBreadcrumbs } = useBreadcrumbs(),
    { canManage } = useManagementAccess(),
    qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const project = params.get("projectId") ?? "",
    id = params.get("executionId") ?? "",
    page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const [createRequest, setCreateRequest] = useState(() => crypto.randomUUID()),
    [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [brief, setBrief] = useState(""),
    [seat, setSeat] = useState(""),
    [demand, setDemand] = useState(params.get("demandNo") ?? ""),
    [supersedes, setSupersedes] = useState<string | undefined>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [pubUrl, setPubUrl] = useState(""),
    [pubNote, setPubNote] = useState(""),
    [attest, setAttest] = useState(false);
  useEffect(() => {
    setBreadcrumbs([{ label: "独立需求分析" }]);
  }, [setBreadcrumbs]);
  useEffect(() => {
    setCreating(false);
    setError("");
    setMessage("");
    setSupersedes(undefined);
  }, [c]);
  useEffect(() => {
    setPubUrl("");
    setPubNote("");
    setAttest(false);
  }, [id]);
  const projects = useQuery({
    queryKey: ["analysis-projects", c],
    queryFn: () => projectsApi.list(c!),
    enabled: !!c,
  });
  const seats = useQuery({
    queryKey: ["analysis-seats", c],
    queryFn: () => analysisApi.seats(c!),
    enabled: !!c,
    refetchInterval: 15000,
  });
  const list = useQuery({
    queryKey: ["analysis-list", c, project, page],
    queryFn: () => analysisApi.list(c!, project, page),
    enabled: !!c,
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: ["analysis-detail", c, id],
    queryFn: () => analysisApi.detail(c!, id),
    enabled: !!c && !!id,
    refetchInterval: 3000,
    retry: false,
  });
  const e = detail.data?.execution;
  function change(key: string, value: string) {
    setParams((p) => {
      const n = new URLSearchParams(p);
      value ? n.set(key, value) : n.delete(key);
      if (key === "projectId") {
        n.delete("executionId");
        n.delete("page");
      }
      return n;
    });
    setError("");
    setMessage("");
  }
  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setMessage(ok);
      await qc.invalidateQueries({ queryKey: ["analysis-list", c] });
      await qc.invalidateQueries({ queryKey: ["analysis-detail", c] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作未完成，请刷新重试");
    } finally {
      setBusy(false);
    }
  }
  const run = detail.data?.run,
    active =
      !!run && ["queued", "running", "scheduled_retry"].includes(run.status);
  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">独立需求分析</h1>
        <p className="text-sm text-muted-foreground">
          无须 Jira 编号，由已登记的分析 Harness 执行
          P0–P4；必要决定在网页答复，同一可见 Claude 会话继续。
        </p>
        <div className="flex gap-4 text-sm">
          <Link className="underline" to="/delivery-workbench">
            交付工作台
          </Link>
          <Link className="underline" to={"/delivery?"+new URLSearchParams({...(project?{projectId:project}:{}),...(params.get("snapshotId")?{snapshotId:params.get("snapshotId")!}:{})})}>
            返回需求条目
          </Link>
          <a
            className="underline"
            href="/delivery-help.html"
            target="_blank"
            rel="noreferrer"
          >
            使用帮助
          </a>
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="text-sm">
          项目{" "}
          <select
            aria-label="分析项目"
            className={field}
            value={project}
            onChange={(v) => change("projectId", v.target.value)}
          >
            <option value="">全部项目</option>
            {projects.data
              ?.filter((p) => !p.archivedAt)
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        {canManage && !creating && (
          <Button
            onClick={() => {
              setCreateRequest(crypto.randomUUID());
              setCreating(true);
              setSupersedes(undefined);
              setTitle("");
              setBrief("");
              setDemand(params.get("demandNo") ?? "");
            }}
          >
            创建分析任务
          </Button>
        )}
      </div>
      {creating && canManage && (
        <form
          className="space-y-3 rounded-lg border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const created = await analysisApi.create(c!, {
                requestId: createRequest,
                projectId: project,
                seatId: seat,
                title,
                brief,
                demandNo: demand,
                ...(supersedes ? { supersedesId: supersedes } : {}),
              });
              setCreating(false);
              change("executionId", created.id);
            }, "分析记录已创建；尚未启动，核对后点击授权并派发。");
          }}
        >
          <h2 className="font-semibold">
            {supersedes ? "建立新修订（不覆盖原分析）" : "创建独立分析任务"}
          </h2>
          {!project && <p className="text-sm">请先选择具体项目。</p>}
          <label className="block text-sm">
            标题
            <Input
              aria-label="分析标题"
              value={title}
              maxLength={300}
              required
              onChange={(v) => setTitle(v.target.value)}
            />
          </label>
          <label className="block text-sm">
            分析诉求与材料定位（不要填写密钥）
            <textarea
              aria-label="分析诉求"
              value={brief}
              required
              minLength={10}
              maxLength={20000}
              rows={6}
              onChange={(v) => setBrief(v.target.value)}
              className="block w-full rounded-md border border-border bg-background p-2"
            />
          </label>
          <label className="block text-sm">
            轻舟条目号（可选）
            <Input
              aria-label="关联条目号"
              value={demand}
              maxLength={100}
              onChange={(v) => setDemand(v.target.value)}
            />
          </label>
          <label className="block text-sm">
            执行席位
            <select
              aria-label="分析执行席位"
              className={field}
              value={seat}
              onChange={(v) => setSeat(v.target.value)}
              required
            >
              <option value="">选择已登记分析能力的席位</option>
              {seats.data?.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.capabilityId}>
                  {s.name} · {s.capabilityId ? s.profile : "未登记分析能力"} ·{" "}
                  {s.clientReady
                    ? s.online
                      ? "在线"
                      : "离线"
                    : "需更新客户端"}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" disabled={seats.isFetching} onClick={() => void seats.refetch()}>刷新席位登记</Button>
          <p className="text-xs text-muted-foreground">没有可选席位时，先更新客户端并登记分析 Harness；无需重新创建席位。创建分析记录不会启动 Claude。</p>
          <details className="text-sm"><summary className="cursor-pointer">没有分析席位？选择本机 Harness 目录</summary><div className="mt-3"><HarnessEnrollmentGuide seats={seats.data ?? []} /></div></details>
          <div className="flex justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreating(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !project || !seat}>
              创建分析记录
            </Button>
          </div>
        </form>
      )}
      {(list.isError || projects.isError || seats.isError) && (
        <p role="alert" className="text-destructive">
          列表或配置加载失败，请刷新重试。
        </p>
      )}
      {list.isPending ? (
        <p role="status">正在读取分析任务…</p>
      ) : (
        <section className="space-y-2" aria-label="分析任务列表">
          {list.data?.items.map((t) => (
            <button
              key={t.id}
              className={`block w-full rounded-md border p-3 text-left hover:bg-accent ${id === t.id ? "border-primary bg-accent" : "border-border"}`}
              onClick={() => change("executionId", t.id)}
            >
              <span className="font-medium">
                {t.title} · 修订 {t.revision}
              </span>
              <p className="text-sm text-muted-foreground">
                {stateNames[t.state] ?? t.state} ·{" "}
                {t.snapshot?.phase ?? "尚未上报阶段"} ·{" "}
                {t.demandNo ?? "独立平台分析"}
              </p>
            </button>
          ))}
          {!list.data?.items.length && (
            <p className="text-sm text-muted-foreground">
              当前范围暂无分析任务。管理员可先选择项目并创建记录。
            </p>
          )}
          <div className="flex justify-between">
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => change("page", String(page - 1))}
            >
              上一页分析
            </Button>
            <Button
              variant="outline"
              disabled={!list.data?.hasMore}
              onClick={() => change("page", String(page + 1))}
            >
              下一页分析
            </Button>
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {id && detail.isError && (
        <p role="alert" className="text-destructive">
          分析详情加载失败：{detail.error.message}
        </p>
      )}
      {e && (
        <section
          className="space-y-4 rounded-lg border border-border p-4"
          aria-label="分析任务详情"
        >
          <header className="space-y-2">
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {e.title} · 修订 {e.revision}
              </h2>
              <Button variant="ghost" onClick={() => change("executionId", "")}>
                返回分析列表
              </Button>
            </div>
            <p>
              {stateNames[e.state] ?? e.state}
              {run ? ` · 运行：${runNames[run.status] ?? run.status}` : ""}
            </p>
            {run?.error && (
              <p className="text-sm text-destructive">{run.error}</p>
            )}
            <p className="whitespace-pre-wrap text-sm">{e.brief}</p>
            <p className="text-xs text-muted-foreground">
              本地任务：pc-{e.id}-r{e.revision} · 负责人 {e.ownerUserId}
            </p>
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
                          e.state === "queued" && !e.activeRunId && e.dispatchId
                            ? e.dispatchId
                            : crypto.randomUUID(),
                        ),
                      "已授权，等待本机领取并打开可见终端；不要手动重复启动。",
                    )
                  }
                >
                  {run ? "核验并恢复分析" : "授权并派发分析"}
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
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreateRequest(crypto.randomUUID());
                    setSupersedes(e.id);
                    setTitle(e.title);
                    setBrief(e.brief);
                    setSeat(e.seatId);
                    setDemand(e.demandNo ?? "");
                    change("projectId", e.projectId);
                    setCreating(true);
                  }}
                >
                  建立新修订
                </Button>
              )}
              <Link className="text-sm underline" to={`/issues/${e.id}`}>
                原任务与执行记录
              </Link>
            </div>
          </header>
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
          <section className="space-y-3">
            <h3 className="font-semibold">待决定问题与质量评审</h3>
            {detail.data?.decisions.map((d) => (
              <Answer
                key={d.id}
                d={d}
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
            {!detail.data?.decisions.length && (
              <p className="text-sm text-muted-foreground">
                尚无上报问题；本机权限确认仍需在 Claude 终端处理。
              </p>
            )}
          </section>
          {e.delivery && (
            <section className="space-y-3">
              <h3 className="font-semibold">本地交付索引</h3>
              <p className="text-sm">
                已核验原生 P0–P4；原始客户材料留在本机，索引不等于共享交接包。
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
                      checked={attest}
                      onChange={(v) => setAttest(v.target.checked)}
                    />
                    我已在正式来源核对上述版本及交接材料访问权限
                  </label>
                  <div className="flex justify-end">
                    <Button disabled={busy || !attest} type="submit">
                      登记已核验发布
                    </Button>
                  </div>
                </form>
              ) : (
                <p>待管理员核验正式发布。</p>
              )}
            </section>
          )}
          <ManagedSessionPanel companyId={c!} taskId={e.id} />
        </section>
      )}
    </div>
  );
}
