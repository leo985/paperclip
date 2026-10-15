import { BookOpen, Inbox, CircleDot, FolderOpen, RadioTower, Settings, Search, Link2 } from "lucide-react";
import { PlatformBrand } from "./PlatformBrand";
import { SidebarNavItem } from "./SidebarNavItem.production";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu.production";
import { SeatAttentionNav } from "./SeatAttentionNav";
import { useSidebar } from "@/context/SidebarContext";
import { useCompany } from "@/context/CompanyContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { useInboxBadge } from "@/hooks/useInboxBadge";

export function FocusedSidebar() {
  const { collapsed, peeking } = useSidebar();
  const { selectedCompanyId } = useCompany();
  const { canManage } = useManagementAccess();
  const badge = useInboxBadge(selectedCompanyId);
  return <aside className="platform-sidebar flex h-full min-h-0 w-full flex-col border-r border-border bg-card">
    <PlatformBrand compact={collapsed && !peeking} />
    <div className="flex h-12 shrink-0 items-center border-y border-border/70 px-3"><SidebarCompanyMenu /></div>
    <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-4" aria-label="研发协同导航">
      <SidebarNavItem to="/jira-intake" label="接入 Jira 工单" icon={Link2} className="mb-3" />
      <SidebarNavItem to="/dashboard" label="协同工作台" icon={RadioTower} />
      <SidebarNavItem to="/issues" label="工单" icon={CircleDot} />
      <SidebarNavItem to="/inbox" label="待处理中心" icon={Inbox} badge={badge.inbox} badgeLabel="项待处理" />
      <SidebarNavItem to="/projects" label="项目" icon={FolderOpen} />
      <SeatAttentionNav />
      <SidebarNavItem to="/runs" label="执行记录" icon={RadioTower} />
      <SidebarNavItem to="/search" label="搜索" icon={Search} />
      <SidebarNavItem to="/help" label="帮助中心" icon={BookOpen} />
      {canManage && <div className="mt-4 border-t border-border pt-3"><SidebarNavItem to="/management" label="管理中心" icon={Settings} /></div>}
    </nav>
  </aside>;
}
