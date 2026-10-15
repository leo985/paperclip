import { WorkflowPageFrame } from "@/components/WorkflowPageFrame";
import { uiText } from "@/i18n/interface";
import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { NewAgentSetup } from "../components/new-agent/NewAgentSetup";

export function NewAgent() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: uiText("Agents"), href: "/agents" },
      { label: uiText("New agent") },
    ]);
  }, [setBreadcrumbs]);
  return <WorkflowPageFrame to="/agents/all" label="返回智能体列表" note="返回不会删除已创建的智能体；未保存的配置不会提交。"><NewAgentSetup /></WorkflowPageFrame>;
}
