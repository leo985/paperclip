import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Search, ExternalLink, List, PanelLeftClose, PanelLeftOpen, ChevronDown } from "lucide-react";
import { Link } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import help from "@/content/dsp7-help.json";
import { HelpWorkflowDiagram } from "@/components/HelpWorkflowDiagram";

const directoryPreference = "zhiyan:help-directory-collapsed";

export function Help() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(directoryPreference) === "true"; } catch { return false; }
  });
  const article = useRef<HTMLElement>(null);
  const focusArticleOnClose = useRef(false);
  const selected = help.sections.find((section) => section.id === params.get("section")) ?? help.sections[0];
  const [openCategory, setOpenCategory] = useState(selected.category);
  useEffect(() => setBreadcrumbs([{ label: "帮助中心" }]), [setBreadcrumbs]);
  useEffect(() => { setOpenCategory(selected.category); }, [selected.id, selected.category]);
  useEffect(() => { try { localStorage.setItem(directoryPreference, String(collapsed)); } catch { /* Private browsing can deny storage. */ } }, [collapsed]);
  const matches = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return help.sections.filter((section) => words.every((word) =>
      [section.title, section.category, section.summary, section.body, ...section.scenarios]
        .join(" ").toLocaleLowerCase().includes(word)));
  }, [query]);
  const searching = query.trim().length > 0;
  const showDirectory = searching || !collapsed;
  const categories = [...new Set(matches.map((section) => section.category))];
  function select(id: string) {
    setParams((current) => { const next = new URLSearchParams(current); next.set("section", id); return next; });
    setOpenCategory(help.sections.find(section => section.id === id)?.category ?? selected.category);
    focusArticleOnClose.current = drawerOpen;
    setDrawerOpen(false);
    setQuery("");
    // The app scrolls its main panel, rather than the browser window.
    requestAnimationFrame(() => article.current?.scrollIntoView({ block: "start", behavior: "auto" }));
  }
  function directory(prefix: string) {
    return <nav aria-label="帮助主题" className="space-y-3">
      <p className="text-xs text-muted-foreground" aria-live="polite">{searching ? `找到 ${matches.length} 个主题` : `${matches.length} 个主题 · 按分类浏览`}</p>
      {categories.map((category, index) => {
        const expanded = searching || openCategory === category;
        const id = `${prefix}-category-${index}`;
        const topics = matches.filter((section) => section.category === category);
        return <section key={category} className="space-y-1">
          <button type="button" disabled={searching} aria-expanded={expanded} aria-controls={id} onClick={() => setOpenCategory(expanded ? "" : category)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-accent">
            <span>{category}</span><span className="flex items-center gap-2 text-xs text-muted-foreground">{topics.length}<ChevronDown aria-hidden="true" className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></span>
          </button>
          <div id={id} hidden={!expanded} className="space-y-1">{topics.map((section) =>
            <button key={section.id} type="button" onClick={() => select(section.id)} aria-current={selected.id === section.id ? "page" : undefined} className={`help-topic-button w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${selected.id === section.id ? "help-topic-current bg-accent font-medium text-accent-foreground" : "text-muted-foreground"}`}>{section.title}</button>
          )}</div>
        </section>;
      })}
      {matches.length === 0 && <p role="status" className="text-sm text-muted-foreground">没有找到相关主题，请尝试“项目”“终端”或“阻塞”。</p>}
    </nav>;
  }
  return (
    <div className="help-reader mx-auto max-w-7xl space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="flex items-center gap-2 text-2xl font-semibold"><BookOpen className="size-6" />帮助中心</h1><p className="mt-2 text-sm text-muted-foreground">网站功能、使用场景与 Jira / Harness 接入指南 · 更新于 {help.updated}</p></div>
        <a href="/help.html" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"><ExternalLink className="size-4" />完整手册 / 打印</a>
      </header>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3">
        <Button variant="outline" className="help-desktop-control" disabled={searching} title={searching ? "搜索时展开目录以显示结果" : undefined} onClick={() => setCollapsed(!collapsed)} aria-expanded={showDirectory} aria-controls="help-desktop-directory">{!showDirectory ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}{!showDirectory ? "展开目录" : "收起目录"}</Button>
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild><Button variant="outline" className="help-mobile-control"><List className="size-4" />浏览主题</Button></SheetTrigger>
          <SheetContent side="left" className="overflow-y-auto" onCloseAutoFocus={(event) => { if (focusArticleOnClose.current) { event.preventDefault(); focusArticleOnClose.current = false; article.current?.focus({ preventScroll: true }); requestAnimationFrame(() => article.current?.scrollIntoView({ block: "start" })); } }}>
            <SheetHeader><SheetTitle>帮助主题</SheetTitle><SheetDescription>按分类浏览，选择主题后继续阅读。</SheetDescription></SheetHeader>
            <div className="space-y-4 px-4 pb-6"><label className="sr-only" htmlFor="help-drawer-search">搜索帮助内容</label><input id="help-drawer-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索席位、审批、Token…" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />{directory("help-drawer")}</div>
          </SheetContent>
        </Sheet>
        <div className="relative min-w-0 flex-1"><label className="sr-only" htmlFor="help-search">搜索帮助内容</label><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><input id="help-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索席位、审批、Token…" className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
        {searching && <span className="text-xs text-muted-foreground" aria-live="polite">{matches.length} 个匹配主题</span>}
      </div>
      {searching && <div className="help-mobile-results rounded-lg border border-border bg-card p-4">{directory("help-search-results")}</div>}
      <div className="help-reader-layout" data-directory-collapsed={!showDirectory}>
        <aside id="help-desktop-directory" className="help-directory">{directory("help-desktop")}</aside>
        <article ref={article} tabIndex={-1} aria-labelledby="help-article-title" key={selected.id} className="help-article min-w-0 space-y-6 rounded-lg border border-border bg-card p-4 md:p-6">
          <header className="help-reading-width"><p className="text-xs text-muted-foreground">{selected.category}</p><h2 id="help-article-title" className="mt-2 text-xl font-semibold">{selected.title}</h2><p className="mt-2 text-sm text-muted-foreground">{selected.summary}</p></header>
          <section className="rounded-md bg-muted p-4" aria-label="适用场景"><h3 className="mb-2 text-sm font-semibold">什么时候使用</h3><ul className="help-reading-width list-disc space-y-1 pl-5 text-sm">{selected.scenarios.map((scenario) => <li key={scenario}>{scenario}</li>)}</ul></section>
          {selected.id === "workflow" && <HelpWorkflowDiagram />}
          <MarkdownBody className="help-prose" linkIssueReferences={false}>{selected.body}</MarkdownBody>
          <footer className="flex flex-wrap items-center gap-4 border-t border-border pt-4 text-sm">{selected.link && <Link to={selected.link} className="text-primary underline underline-offset-4">打开相关功能</Link>}<a href={`/help.html#${selected.id}`} target="_blank" rel="noreferrer" className="text-muted-foreground underline underline-offset-4">在完整手册中查看本节</a></footer>
        </article>
      </div>
    </div>
  );
}
