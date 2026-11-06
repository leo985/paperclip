import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { SeatRunControl } from "./SeatRunControl";
function render(values:Record<string,unknown>){const cache=new QueryClient();cache.setQueryData(["seat-run-control","company","run"],{runId:"run",mode:"observed_cost",stopStatus:"pending",meteringStatus:"unknown",tokens:null,costStatus:"unpriced",observedAt:null,route:null,...values});return renderToStaticMarkup(<QueryClientProvider client={cache}><SeatRunControl companyId="company" runId="run"/></QueryClientProvider>);}
describe("run control evidence display",()=>{
 it("does not label unknown usage as zero or terminal state as verified stop",()=>{const html=render({});expect(html).toContain("不等于零消耗");expect(html).toContain("停止待核验");expect(html).toContain("不保证零超支");});
 it("distinguishes partial observations from final settlement",()=>{const html=render({meteringStatus:"partial_observation",tokens:{inputTokens:100,outputTokens:20,cachedInputTokens:10}});expect(html).toContain("尚无最终汇总");expect(html).toContain("100");expect(html).not.toContain("最终汇总已对账");});
 it("keeps legacy transport distinct from verified managed process evidence",()=>{expect(render({mode:"legacy"})).toContain("旧执行通道");expect(render({stopStatus:"verified",meteringStatus:"final_reported"})).toContain("本机已回报受管进程树停止证明");});
});
