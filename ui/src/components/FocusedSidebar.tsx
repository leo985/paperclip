import { BookOpen, CircleDot, FolderOpen, RadioTower, Settings, Search, ListTree, ChartNoAxesCombined, LayoutDashboard } from "lucide-react";
import { PlatformBrand } from "./PlatformBrand";
import { SidebarNavItem } from "./SidebarNavItem.production";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu.production";
import { SeatAttentionNav } from "./SeatAttentionNav";
import { useSidebar } from "@/context/SidebarContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";

export function FocusedSidebar() {
  const { collapsed, peeking } = useSidebar();
  const { canManage } = useManagementAccess();
  const rail = collapsed && !peeking;
  return <aside className="platform-sidebar flex h-full min-h-0 w-full flex-col border-r border-border bg-card">
    <PlatformBrand compact={collapsed && !peeking} />
    <div className="flex h-12 shrink-0 items-center border-y border-border/70 px-3"><SidebarCompanyMenu /></div>
    <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-4" aria-label="交付协同导航">
      {!rail && <p className="px-3 py-2 text-xs font-medium text-muted-foreground">工作</p>}
      <SidebarNavItem to="/dashboard" label="工作台" icon={RadioTower} />
      {!rail && <p className="px-3 py-2 text-xs font-medium text-muted-foreground">交付</p>}
      <SidebarNavItem to="/delivery-dashboard" label="席位看板" icon={LayoutDashboard} />
      <SidebarNavItem to="/delivery" label="需求条目" icon={ListTree} />
      <SidebarNavItem to="/delivery-chain" label="AI交付链" icon={ListTree} />
      <SidebarNavItem to="/issues" label="AI任务" icon={CircleDot} />
      <SidebarNavItem to="/delivery-workbench" label="交付报表" icon={ChartNoAxesCombined} />
      {!rail && <p className="px-3 py-2 text-xs font-medium text-muted-foreground">资源</p>}
      <SidebarNavItem to="/projects" label="项目" icon={FolderOpen} />
      <SeatAttentionNav />
      <SidebarNavItem to="/runs" label="执行记录" icon={RadioTower} />
      <SidebarNavItem to="/search" label="搜索" icon={Search} />
      <SidebarNavItem to="/help" label="帮助中心" icon={BookOpen} />
      {canManage && <div className="mt-4 border-t border-border pt-3"><SidebarNavItem to="/management" label="管理中心" icon={Settings} /></div>}
    </nav>
  </aside>;
}
