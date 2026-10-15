import { Paperclip } from "lucide-react";
import { Link } from "@/lib/router";
import { useSidebar } from "@/context/SidebarContext";
import { cn } from "@/lib/utils";

export function PlatformBrand({ compact = false, header = false }: { compact?: boolean; header?: boolean }) {
  const { isMobile, setSidebarOpen } = useSidebar();
  return (
    <Link to="/dashboard" title="智研协同平台 · 返回工作台" aria-label="智研协同平台，返回工作台"
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={cn("platform-brand flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", compact ? "mx-3 px-3 py-4" : header ? "mr-3 shrink-0 p-1" : "mx-3 px-3 py-4")}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Paperclip className="size-4" aria-hidden="true" /></span>
      <span className={compact ? "sr-only" : "min-w-0"}>
        <span className="block truncate text-sm font-semibold tracking-tight">智研协同平台</span>
        {!header && <span className="block text-xs text-muted-foreground">研发执行 · 人机协同</span>}
      </span>
    </Link>
  );
}
