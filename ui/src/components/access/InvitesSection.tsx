import { uiText } from "@/i18n/interface";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";

const inviteRoleOptions = [
  {
    value: "viewer",
    label: "观察成员",
    description: "查看组织工单进度与效果数据。",
    gets: "仅可查看，不能执行工单或提交决策。",
  },
  {
    value: "operator",
    label: "研发成员",
    description: "适用于参与研发并使用本机 Claude 执行工单的人员。",
    gets: "使用已授权席位接入、执行工单并处理任务决策。",
  },
  {
    value: "admin",
    label: "组织管理员",
    description: "适用于维护组织项目、共享仓库、席位和接单配置的人员。",
    gets: "可以配置执行智能体、邀请人员和审批加入申请；实例级配置仍需实例管理员。",
  },
  {
    value: "owner",
    label: "组织负责人",
    description: "管理组织权限与管理员，建议仅授予少量负责人。",
    gets: "拥有组织管理员能力，并管理成员权限。",
  },
] as const;

const INVITE_HISTORY_PAGE_SIZE = 5;

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

/** The Invites tab of the Members page (extracted from the former standalone Invites page). */
export function InvitesSection() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
  const latestInviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  function selectLatestInviteUrl() {
    latestInviteInputRef.current?.focus();
    latestInviteInputRef.current?.select();
  }

  async function copyText(text: string, unavailableBody: string, afterFallback?: () => void) {
    try {
      await copyTextToClipboard(text);
      return true;
    } catch {
      afterFallback?.();
    }
    pushToast({
      title: "浏览器不允许自动复制",
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, "已选中邀请链接，请手动复制。", selectLatestInviteUrl);
  }

  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", INVITE_HISTORY_PAGE_SIZE);
  const invitesQuery = useInfiniteQuery({
    queryKey: inviteHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      accessApi.listInvites(selectedCompanyId!, {
        limit: INVITE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const inviteHistory = useMemo(
    () =>
      invitesQuery.data?.pages.flatMap((page) =>
        Array.isArray(page?.invites) ? page.invites.filter(isInviteHistoryRow) : [],
      ) ?? [],
    [invitesQuery.data?.pages],
  );

  const createInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "human",
        humanRole,
        agentMessage: null,
      }),
    onSuccess: async (invite) => {
      setLatestInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(false);
      const copied = await copyText(invite.inviteUrl, "请从下方输入框手动复制邀请链接。");

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: "邀请已创建",
        body: copied ? "邀请链接已生成并复制。" : "邀请链接已在下方生成。",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "创建邀请失败",
        body: error instanceof Error ? error.message : "未知错误",
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: "邀请已撤销", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "撤销邀请失败",
        body: error instanceof Error ? error.message : "未知错误",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">请先选择要管理邀请的组织。</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">正在加载邀请…</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? "你没有管理组织邀请的权限。"
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : "邀请加载失败。";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-8">
      <p className="max-w-3xl text-sm text-muted-foreground">
        邀请人员加入此组织。链接生成后会尝试复制；浏览器不允许复制时，可手动选中链接复制。
      </p>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">邀请人员</h2>
          <p className="text-sm text-muted-foreground">
            生成一次性人员邀请链接，并选择加入后的组织角色。
          </p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">选择角色</legend>
          <div className="rounded-xl border border-border">
            {inviteRoleOptions.map((option, index) => {
              const checked = humanRole === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer gap-3 px-4 py-4 ${index > 0 ? "border-t border-border" : ""}`}
                >
                  <input
                    type="radio"
                    name="invite-role"
                    value={option.value}
                    checked={checked}
                    onChange={() => setHumanRole(option.value)}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {uiText("Default")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          每条邀请链接仅可使用一次。人员登录加入后立即获得所选角色；智能体邀请仍需审批。
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? uiText("Creating…") : uiText("Create invite")}
          </Button>
          <span className="text-sm text-muted-foreground">下方邀请历史保留操作记录。</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">最新邀请链接</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {uiText("Copied")}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">{uiText("This URL includes the current Paperclip domain returned by the server.")}{" "}</div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">最新邀请链接</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label="最新邀请链接"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const copied = await copyInviteUrl(latestInviteUrl);
                  setLatestInviteCopied(copied);
                }}
              >
                <Copy className="h-4 w-4" />
                {uiText("Copy link")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">邀请历史</h2>
            <p className="text-sm text-muted-foreground">{uiText("Review invite status, audience, inviter, and any linked join request.")}{" "}</p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">{uiText("Open join request queue")}{" "}</Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            此组织尚未创建邀请。
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{uiText("State")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{uiText("For")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{uiText("Invited by")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{uiText("Created")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">加入申请</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{uiText("Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {formatInviteState(invite.state)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 align-top">{formatInviteAudience(invite)}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || "未知邀请人"}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">
                            {uiText("Review request")}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right align-top">
                        {invite.state === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revokeMutation.mutate(invite.id)}
                            disabled={revokeMutation.isPending}
                          >
                            {uiText("Revoke")}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{uiText("Inactive")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invitesQuery.hasNextPage ? (
              <div className="flex justify-center border-t border-border px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => invitesQuery.fetchNextPage()}
                  disabled={invitesQuery.isFetchingNextPage}
                >
                  {invitesQuery.isFetchingNextPage ? "正在加载更多…" : "查看更多"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  return ({ active: "可使用", accepted: "已接受", expired: "已过期", revoked: "已撤销" })[state];
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number]) {
  const role = inviteRoleOptions.find(option => option.value === invite.humanRole)?.label;
  if (invite.allowedJoinTypes === "agent") return "智能体";
  if (invite.allowedJoinTypes === "both") return role ? `人员或智能体 · ${role}` : "人员或智能体";
  return role ?? "人员";
}
