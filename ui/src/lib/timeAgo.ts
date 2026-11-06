import { i18n } from "@/i18n";
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  const chinese = i18n.language.startsWith("zh");
  if (seconds < MINUTE) return chinese ? "刚刚" : "just now";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return chinese ? `${m} 分钟前` : `${m}m ago`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return chinese ? `${h} 小时前` : `${h}h ago`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return chinese ? `${d} 天前` : `${d}d ago`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return chinese ? `${w} 周前` : `${w}w ago`;
  }
  const mo = Math.floor(seconds / MONTH);
  return chinese ? `${mo} 个月前` : `${mo}mo ago`;
}
