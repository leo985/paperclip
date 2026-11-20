import { useEffect, useRef, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { authApi } from "@/api/auth";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link, useLocation, useParams, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  readIssueDetailBreadcrumb,
  rememberIssueDetailLocationState,
} from "@/lib/issueDetailBreadcrumb";
import { TaskExecutionDetail } from "@/components/task-detail/TaskExecutionDetail";
import { Button } from "@/components/ui/button";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { recordRecentTask } from "@/lib/recent-tasks";

/** One canonical URL for analysis, development, QA and human tasks. */
export function UnifiedTaskDetailPage({
  collaboration,
}: {
  collaboration: ReactNode;
}) {
  const { issueId } = useParams<{ issueId: string }>();
  const [params] = useSearchParams();
  const location = useLocation();
  const { selectedCompanyId } = useCompany();
  const cache = useQueryClient();
  const lastRead = useRef("");
  const { enabled: streamlined } = useStreamlinedUiEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const advanced = params.get("detailView") === "collaboration";
  // Historic deep links into a comment, tab or file keep their original surface.
  const historicalLink =
    (!!location.hash && !location.hash.startsWith("#task-detail-")) ||
    ["tab", "commentId", "document", "file"].some((key) => params.has(key));
  const showCollaboration = advanced || historicalLink;
  const detail = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
    retry: false,
    refetchInterval: showCollaboration ? false : 5000,
  });
  const issue = detail.data;
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: authApi.getSession,
    enabled: !showCollaboration,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      for (const key of [
        queryKeys.issues.listMineByMe(selectedCompanyId),
        queryKeys.issues.listTouchedByMe(selectedCompanyId),
        queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId),
        queryKeys.sidebarBadges(selectedCompanyId),
      ])
        void cache.invalidateQueries({ queryKey: key });
    },
  });
  useEffect(() => {
    if (
      showCollaboration ||
      !issue ||
      issue.companyId !== selectedCompanyId ||
      lastRead.current === issue.id
    )
      return;
    lastRead.current = issue.id;
    markRead.mutate(issue.id);
  }, [showCollaboration, issue?.id, selectedCompanyId, markRead.mutate]);
  const userId =
    session.data?.user?.id ?? session.data?.session?.userId ?? null;
  useEffect(() => {
    if (
      !showCollaboration &&
      streamlined &&
      session.isFetched &&
      issue?.companyId === selectedCompanyId
    )
      recordRecentTask(issue, userId);
  }, [
    showCollaboration,
    streamlined,
    session.isFetched,
    issue,
    selectedCompanyId,
    userId,
  ]);
  const source = readIssueDetailBreadcrumb(
    issueId,
    location.state,
    location.search,
  );
  useEffect(() => {
    if (!issue) return;
    rememberIssueDetailLocationState(issue.id, location.state, location.search);
    if (issue.identifier)
      rememberIssueDetailLocationState(
        issue.identifier,
        location.state,
        location.search,
      );
  }, [issue?.id, issue?.identifier, location.state, location.search]);
  useEffect(() => {
    if (!showCollaboration && issue)
      setBreadcrumbs([
        { label: source?.label ?? "任务", href: source?.href ?? "/issues" },
        { label: issue.identifier ?? issue.title },
      ]);
  }, [
    issue?.id,
    issue?.identifier,
    issue?.title,
    source?.label,
    source?.href,
    showCollaboration,
    setBreadcrumbs,
  ]);
  function href(advanced: boolean) {
    const next = new URLSearchParams(params);
    next.delete("tab");
    next.delete("commentId");
    next.delete("document");
    next.delete("file");
    advanced
      ? next.set("detailView", "collaboration")
      : next.delete("detailView");
    return location.pathname + (next.size ? "?" + next : "");
  }
  const navigation = (
    <nav
      className="flex flex-wrap items-center gap-2"
      aria-label="任务详情视图"
    >
      <Button variant={showCollaboration ? "outline" : "secondary"} asChild>
        <Link state={location.state} to={href(false)}>
          任务详情
        </Link>
      </Button>
      <Button variant={showCollaboration ? "secondary" : "outline"} asChild>
        <Link state={location.state} to={href(true)}>
          对话、文件与高级操作
        </Link>
      </Button>
      {source && (
        <Link className="text-sm underline" to={source.href}>
          返回{source.label}
        </Link>
      )}
    </nav>
  );
  if (showCollaboration)
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        {navigation}
        <div className="min-h-0 flex-1">{collaboration}</div>
      </div>
    );
  return (
    <div className="min-w-0 space-y-4">
      {navigation}
      {markRead.isError && (
        <p role="alert" className="text-sm text-destructive">
          已读状态同步失败，不影响查看任务。
          <button
            className="underline"
            onClick={() => issue && markRead.mutate(issue.id)}
          >
            重试同步
          </button>
        </p>
      )}
      {detail.isPending && (
        <p role="status" className="text-sm">
          正在读取任务…
        </p>
      )}
      {detail.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>任务读取失败：{detail.error.message}</p>
          <Button variant="outline" onClick={() => void detail.refetch()}>
            重新读取
          </Button>
        </div>
      )}
      {issue && issue.companyId !== selectedCompanyId && (
        <p role="alert" className="text-sm text-destructive">
          当前任务不属于所选组织，请切换到对应组织后查看。
        </p>
      )}
      {issue && issue.companyId === selectedCompanyId && (
        <>
          <header className="space-y-1">
            <p className="font-mono text-xs text-muted-foreground">
              {issue.identifier ?? issue.id}
            </p>
            <h1 className="text-2xl font-semibold">{issue.title}</h1>
          </header>
          <TaskExecutionDetail key={issue.companyId + issue.id} issue={issue} />
        </>
      )}
    </div>
  );
}
