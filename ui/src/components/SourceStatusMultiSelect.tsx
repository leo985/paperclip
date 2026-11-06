import { ChevronDown } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
type Option = { value: string; label: string };
export function SourceStatusMultiSelect({ label, options, values, onChange, disabled }: {
  label: string; options: Option[]; values: string[]; onChange: (values: string[]) => void; disabled?: boolean;
}) {
  const missing = values.filter(value => !options.some(option => option.value === value)).map(value => {
    let name = "原有状态";
    try { const parsed: unknown = JSON.parse(value); if (typeof parsed === "string") name = parsed || "来源未提供"; } catch { /* Keep legacy selection removable. */ }
    return { value, label: `${name}（本次未返回）` };
  });
  const all = [...options, ...missing];
  const selected = all.filter(option => values.includes(option.value));
  const text = !values.length ? "全部状态" : selected.length === 1 ? selected[0]!.label : `已选 ${values.length} 个状态`;
  return <Popover><PopoverTrigger asChild><Button type="button" variant="outline" disabled={disabled} aria-label={label} title={selected.map(option => option.label).join("、") || "全部状态"} className="w-full justify-between gap-2"><span className="truncate">{text}</span><ChevronDown className="size-4 shrink-0" aria-hidden="true"/></Button></PopoverTrigger>
    <PopoverContent align="start" className="space-y-3 p-3" aria-label={`${label}选项`}>
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">来源状态（可多选）</span><Button type="button" size="sm" variant="ghost" disabled={disabled||!values.length} onClick={()=>onChange([])}>全部状态</Button></div>
      <div className="max-h-60 space-y-1 overflow-y-auto">{all.length ? all.map(option => <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-accent"><input type="checkbox" disabled={disabled} aria-label={`${label}：${option.label}`} checked={values.includes(option.value)} onChange={event=>onChange(event.target.checked ? [...values, option.value] : values.filter(value => value !== option.value))}/><span>{option.label}</span></label>) : <p className="text-xs text-muted-foreground">当前没有来源状态选项。</p>}</div>
      <p className="text-xs text-muted-foreground">勾选后立即生效；任一所选状态匹配即可。未勾选表示全部状态。</p>
    </PopoverContent>
  </Popover>;
}
