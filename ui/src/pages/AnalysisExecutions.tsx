import { HarnessEnrollmentGuide } from "@/components/HarnessEnrollmentGuide";
import { AnalysisQingzhouOptionsFields } from "@/components/AnalysisQingzhouWriteback";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { AnalysisQingzhouOptions } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { projectsApi } from "@/api/projects";
import { analysisApi } from "@/api/analysis-executions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link, Navigate, useLocation, useNavigate } from "@/lib/router";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
const stateNames: Record<string, string> = {
  interrupted: "会话已结束 · 分析未交付，可核验后恢复",
  draft: "未派发",
  queued: "已授权排队",
  running: "分析执行中",
  waiting: "等待人工决定",
  local_completed: "本地分析完成 · 待正式发布",
  published: "已登记正式发布",
};
const field = "rounded-md border border-border bg-background p-2 text-sm";
export function AnalysisExecutions({ createOnly = false }: { createOnly?: boolean } = {}) {
  const { selectedCompanyId: c } = useCompany(),
    { setBreadcrumbs } = useBreadcrumbs(),
    { canManage } = useManagementAccess(),
    qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const listParams = new URLSearchParams(params);
  listParams.delete("executionId");
  listParams.delete("supersedesId");
  listParams.delete("createAnalysis");
  listParams.set("taskType", "analysis");
  const listHref =
    "/issues?" + listParams;
  const detailState = createIssueDetailLocationState(
    "需求分析",
    listHref,
    "analysis",
  );
  const project = params.get("projectId") ?? "",
    id = params.get("executionId") ?? "",
    page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const [createRequest, setCreateRequest] = useState(() => crypto.randomUUID()),
    [creating, setCreating] = useState(createOnly),
    [title, setTitle] = useState(""),
    [brief, setBrief] = useState(""),
    [seat, setSeat] = useState(""),
    [demand, setDemand] = useState(params.get("demandNo") ?? ""),
    [supersedes, setSupersedes] = useState<string | undefined>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [qingzhouOptions, setQingzhouOptions] =
    useState<AnalysisQingzhouOptions>({});
  useEffect(() => {
    setBreadcrumbs([{ label: "任务", href: "/issues" }, { label: "需求分析" }]);
  }, [setBreadcrumbs]);
  useEffect(() => {
    setCreating(createOnly);
    setError("");
    setMessage("");
    setSupersedes(undefined);
  }, [c, createOnly]);
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
    enabled: !!c && !createOnly,
    refetchInterval: 5000,
  });
  const revisionId = params.get("supersedesId") ?? "";
  const revision = useQuery({
    queryKey: ["analysis-detail", c, revisionId],
    queryFn: () => analysisApi.detail(c!, revisionId),
    enabled: !!c && !!revisionId && canManage,
    retry: false,
  });
  const [seededRevision, setSeededRevision] = useState("");
  useEffect(() => {
    const source = revision.data?.execution;
    if (
      !source ||
      !source.delivery ||
      source.companyId !== c ||
      source.id !== revisionId ||
      seededRevision === source.id
    )
      return;
    if (project !== source.projectId)
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.set("projectId", source.projectId);
        return next;
      });
    setCreateRequest(crypto.randomUUID());
    setSupersedes(source.id);
    setTitle(source.title);
    setBrief(source.brief);
    setSeat(source.seatId);
    setDemand(source.demandNo ?? "");
    setQingzhouOptions(source.qingzhouWriteback?.options ?? {});
    setCreating(true);
    setSeededRevision(source.id);
  }, [revision.data, c, revisionId, seededRevision, project, setParams]);
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
  if (id) return <Navigate replace to={`/issues/${id}`} state={detailState} />;
  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">需求分析</h1>
        <p className="text-sm text-muted-foreground">
          无须 Jira 编号，由已登记的分析 Harness 执行
          P0–P4；必要决定在网页答复，同一可见 Claude 会话继续。
        </p>
        <div className="flex gap-4 text-sm">
          <Link className="underline" to="/delivery-workbench">
            交付工作台
          </Link>
          <Link
            className="underline"
            to={
              "/delivery?" +
              new URLSearchParams({
                ...(project ? { projectId: project } : {}),
                ...(params.get("snapshotId")
                  ? { snapshotId: params.get("snapshotId")! }
                  : {}),
              })
            }
          >
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
            disabled={creating && !!supersedes}
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
        {canManage && !creating && !revisionId && (
          <Button
            onClick={() => {
              setCreateRequest(crypto.randomUUID());
              setCreating(true);
              setSupersedes(undefined);
              setTitle("");
              setBrief("");
              setDemand(params.get("demandNo") ?? "");
              setQingzhouOptions({});
            }}
          >
            创建分析任务
          </Button>
        )}
      </div>
      {revisionId && revision.isPending && <p role="status" className="text-sm">正在读取原分析修订…</p>}
      {creating && canManage && (!revisionId || (seededRevision === revisionId && supersedes === revisionId && revision.data?.execution.delivery && project === revision.data.execution.projectId)) && (
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
                ...(demand ? { qingzhouOptions } : {}),
                ...(supersedes ? { supersedesId: supersedes } : {}),
              });
              setCreating(false);
              navigate(`/issues/${created.id}`, { state: detailState });
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
          {demand.trim() && (
            <AnalysisQingzhouOptionsFields
              value={qingzhouOptions}
              onChange={setQingzhouOptions}
              disabled={busy}
            />
          )}
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
          <Button
            type="button"
            variant="outline"
            disabled={seats.isFetching}
            onClick={() => void seats.refetch()}
          >
            刷新席位登记
          </Button>
          <p className="text-xs text-muted-foreground">
            没有可选席位时，先更新客户端并登记分析
            Harness；无需重新创建席位。创建分析记录不会启动 Claude。
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer">
              没有分析席位？选择本机 Harness 目录
            </summary>
            <div className="mt-3">
              <HarnessEnrollmentGuide seats={seats.data ?? []} />
            </div>
          </details>
          <div className="flex justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => createOnly ? navigate(listHref) : setCreating(false)}
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
      {!createOnly && (list.isPending ? (
        <p role="status">正在读取分析任务…</p>
      ) : (
        <section className="space-y-2" aria-label="分析任务列表">
          {list.data?.items.map((t) => (
            <button
              key={t.id}
              className={`block w-full rounded-md border p-3 text-left hover:bg-accent ${id === t.id ? "border-primary bg-accent" : "border-border"}`}
              onClick={() =>
                navigate(`/issues/${t.id}`, { state: detailState })
              }
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
      ))}
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
      {revision.data && !revision.data.execution.delivery && (
        <p role="alert" className="text-sm text-destructive">
          原分析尚未形成交付，请先恢复原分析；不能在此建立新修订。
        </p>
      )}
      {revision.isError && (
        <p role="alert" className="text-sm text-destructive">
          原分析修订加载失败：{revision.error.message}
        </p>
      )}
    </div>
  );
}

/** Preserve bookmarked list, creation and revision URLs in the task collection. */
export function AnalysisExecutionsRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set("taskType", "analysis");
  return <Navigate replace to={"/issues?" + params + location.hash} state={location.state} />;
}
