import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";

/** Keep an exit outside the flow body so loading / error screens cannot hide it. */
export function WorkflowPageFrame({children,to,label,note}:{children:ReactNode;to:string;label:string;note?:string}) {
  return <div className="space-y-4"><header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background py-3"><Button asChild variant="outline"><Link to={to}><ArrowLeft className="size-4"/>{label}</Link></Button>{note&&<p className="text-xs text-muted-foreground">{note}</p>}</header>{children}</div>;
}
