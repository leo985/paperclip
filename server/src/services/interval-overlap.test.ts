import { describe, expect, it } from "vitest";
import { intervalOverlapMs } from "./interval-overlap.js";
import { unionMs } from "./managed-sessions.js";
describe("report interval overlap", () => {
  it("clips, merges duplicate intervals and treats adjacent boundaries as zero overlap", () => {
    expect(intervalOverlapMs([{start:-10,end:20},{start:10,end:40},{start:10,end:40},{start:70,end:100}], [{start:15,end:30},{start:25,end:60},{start:60,end:70}], 0, 80)).toBe(25);
    expect(intervalOverlapMs([{start:0,end:10}], [{start:10,end:20}], 0, 30)).toBe(0);
    expect(intervalOverlapMs([], [{start:0,end:10}], 0, 10)).toBe(0);
  });
  it("preserves the previous pairwise calculation across overlapping and invalid ranges", () => {
    let seed=418; const random=()=>{seed=(seed*16807)%2147483647;return seed%150-25;};
    for(let n=0;n<50;n++){
      const left=Array.from({length:20},()=>({start:random(),end:random()}));
      const right=Array.from({length:25},()=>({start:random(),end:random()}));
      const expected=unionMs(left.flatMap(l=>right.map(r=>({start:Math.max(l.start,r.start),end:Math.min(l.end,r.end)}))),0,100);
      expect(intervalOverlapMs(left,right,0,100)).toBe(expected);
    }
  });
  it("handles large repeated histories without materializing a Cartesian product", () => {
    const left=Array.from({length:20000},(_,i)=>({start:i,end:i+10}));
    const right=Array.from({length:20000},(_,i)=>({start:i+5,end:i+15}));
    expect(intervalOverlapMs(left,right,0,30000)).toBe(20004);
  });
});
