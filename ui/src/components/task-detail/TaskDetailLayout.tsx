import { useId, type ReactNode } from "react";
import { TaskSessionSelectionProvider } from "./TaskSessionSelection";

/** Shared task detail structure. Domain slots retain their own rules and actions. */
export function TaskDetailLayout({
  overview,
  actions,
  progress,
  deliverables,
  records,
}: {
  overview: ReactNode;
  actions: ReactNode;
  progress: ReactNode;
  deliverables: ReactNode;
  records: ReactNode;
}) {
  const prefix = `task-detail-${useId()}`;
  const sections = [
    { key: "overview", title: "任务概况", content: overview },
    { key: "actions", title: "待处理事项与执行操作", content: actions },
    { key: "progress", title: "执行进度与门禁", content: progress },
    { key: "deliverables", title: "交付成果", content: deliverables },
    { key: "records", title: "会话与执行记录", content: records },
  ];
  return (
    <TaskSessionSelectionProvider>
      <section aria-label="统一任务详情" className="min-w-0 space-y-4">
        <nav aria-label="任务详情分区" className="flex flex-wrap gap-3 text-sm">
          {sections.map((section) => (
            <a
              key={section.key}
              className="underline underline-offset-4"
              href={`#${prefix}-${section.key}`}
            >
              {section.title}
            </a>
          ))}
        </nav>
        {sections.map((section) => (
          <section
            key={section.key}
            id={`${prefix}-${section.key}`}
            aria-label={section.title}
            className="min-w-0 space-y-3 rounded-lg border border-border p-4"
          >
            <h2 className="font-semibold">{section.title}</h2>
            {section.content}
          </section>
        ))}
      </section>
    </TaskSessionSelectionProvider>
  );
}
