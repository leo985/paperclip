import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { queryKeys } from "@/lib/queryKeys";

export function TaskIdentitySummary({
  companyId,
  seatId,
  ownerUserId,
  projectName,
}: {
  companyId: string;
  seatId: string | null;
  ownerUserId: string | null;
  projectName?: string | null;
}) {
  const seats = useQuery({
    queryKey: ["dsp7-registered-seats", companyId],
    queryFn: () => dsp7SeatsApi.list(companyId),
    enabled: !!seatId,
    retry: false,
    refetchInterval: 15000,
  });
  const users = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: !!ownerUserId,
    retry: false,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!seatId,
    retry: false,
  });
  const seat = seats.data?.find((item) => item.agentId === seatId);
  const owner = users.data?.users.find(
    (item) => (item.user?.id ?? item.principalId) === ownerUserId,
  );
  return (
    <div className="space-y-1 text-sm">
      {projectName && <p>项目：{projectName}</p>}
      <p>
        负责人：
        {ownerUserId
          ? (owner?.user?.name ??
            owner?.user?.email ??
            (seat?.owner?.id === ownerUserId
              ? seat.owner.name
              : `待同步（${ownerUserId}）`))
          : (seat?.owner?.name ?? "未分配人员")}
      </p>
      <p>
        执行席位／Agent：
        {seatId
          ? (seat?.name ??
            agents.data?.find((item) => item.id === seatId)?.name ??
            `待同步（${seatId}）`)
          : "未分配"}
        {seat ? ` · ${seat.online ? "在线" : "离线"}` : ""}
      </p>
      {(seats.isError || users.isError || agents.isError) && (
        <p className="text-xs text-destructive">
          部分人员或席位信息读取失败，请刷新核对；不据此判断执行状态。
        </p>
      )}
    </div>
  );
}
