import type { DeliveryInsights } from "@paperclipai/shared";
/** Prevent spreadsheet formula interpretation in names and other source text. */
function cell(value:string|number|null){let s=value===null?"未知":String(value);if(/^[\s]*[=+@-]|^[\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function deliveryReportCsv(report:DeliveryInsights):string{
  const rows:(string|number|null)[][]=[["口径版本",report.methodologyVersion,"统计开始",report.from,"统计结束（不含）",report.to,"生成时间",report.generatedAt],["席位","执行时负责人","当前在手","首次开始","首次交付","取消","运行数","执行毫秒","等待毫秒","会话未知毫秒","席位空闲毫秒","输入Token（已采集）","输出Token（已采集）","缓存读取Token（已采集）","有计量运行数","计量分母运行数","最终回执数","未计价运行数","已知费用（美分，USD）","关联缺陷数","成熟工单数","有完整观测成熟工单数","出现关联缺陷成熟工单数","关联缺陷发生率","质量覆盖率","已确认归因Bug率"]];
  for(const s of report.seats)rows.push([s.name,s.ownerName??s.ownerUserId??"未指定",s.currentOpen,s.started,s.delivered,s.cancelled,s.runs,s.executingMs,s.waitingMs,s.unknownMs,s.idleMs,s.usage.inputTokens,s.usage.outputTokens,s.usage.cachedInputTokens,s.usage.measuredRuns,s.usage.runs,s.usage.finalRuns,s.usage.unpricedRuns,s.usage.reportedCostCents,s.quality.linkedDefects,s.quality.matureEligible,s.quality.measuredMature,s.quality.affectedMature,s.quality.observedDefectRate,s.quality.coverage,null]);
  for(const note of report.notes)rows.push(["统计说明",note]);
  return "\uFEFF"+rows.map(r=>r.map(cell).join(",")).join("\r\n");
}
