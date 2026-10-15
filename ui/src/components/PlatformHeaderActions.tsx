import { Bell, BookOpen, UserRound, LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSignOut } from "@/hooks/useSignOut";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./ThemeToggle";

export function PlatformHeaderActions() {
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const signOut = useSignOut();
  return <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-2 ml-2">
    <Button variant="ghost" size="icon-sm" asChild><Link to="/help" title="在线帮助" aria-label="在线帮助"><BookOpen className="size-4" /></Link></Button>
    <Button variant="ghost" size="icon-sm" asChild><Link to="/inbox" title="待处理事项与通知" aria-label="待处理事项与通知"><Bell className="size-4" /></Link></Button>
    <span className="hidden sm:flex"><ThemeToggle /></span>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" title="个人菜单" aria-label="个人菜单"><UserRound className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{session.data?.user.name || "当前账号"}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/company/settings/instance/profile">个人设置与修改密码</Link></DropdownMenuItem>
        <DropdownMenuItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}><LogOut className="size-4" />{signOut.isPending ? "正在退出…" : "退出登录"}</DropdownMenuItem>
        {signOut.isError && <p role="alert" className="px-2 py-1 text-xs text-destructive">退出失败，请重试。</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
