import { useEffect, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function analysisReportName(demandNo: string | null | undefined, taskId: string) {
  const name = (demandNo?.trim() || taskId).replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 100);
  return `${name}-需求分析.md`;
}

/** Preview and download share the exact uploaded bytes of the reviewed report. */
export function AnalysisReportFile({ name, content, inputDigest, sha256 }: {
  name: string; content: string; inputDigest: string; sha256?: string;
}) {
  const [open, setOpen] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string>();
  useEffect(() => {
    // Blob preserves the UTF-8 Markdown, with no BOM or HTML conversion.
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [content]);
  useEffect(() => setOpen(false), [inputDigest, content]);
  return <article className="space-y-2 rounded-md border border-border p-3" aria-label="分析报告文件">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className="break-all font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">Markdown 分析报告 · {new TextEncoder().encode(content).length.toLocaleString()} 字节</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => setOpen(true)}>预览</Button>
        {downloadUrl && <Button variant="outline" asChild><a href={downloadUrl} download={name}>下载</a></Button>}
      </div>
    </div>
    <p className="break-all font-mono text-xs text-muted-foreground">输入版本：{inputDigest}</p>
    {sha256 && <p className="break-all font-mono text-xs text-muted-foreground">文件校验：{sha256}</p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex flex-col overflow-hidden" style={{ width: "var(--sz-calc-25)", maxWidth: "var(--sz-calc-25)", height: "var(--sz-calc-18)" }}>
        <DialogHeader>
          <DialogTitle className="break-all">{name}</DialogTitle>
          <DialogDescription>分析报告预览 · 请阅读后关闭预览，在任务中批准或退回当前版本。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto"><MarkdownBody>{content}</MarkdownBody></div>
      </DialogContent>
    </Dialog>
  </article>;
}
