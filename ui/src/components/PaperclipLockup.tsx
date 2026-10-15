import type { SVGProps } from "react";

interface PaperclipLockupProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  decorative?: boolean;
  title?: string;
}

/** Product mark and Chinese wordmark, sized by the caller's height. */
export function PaperclipLockup({
  decorative = false,
  title = "智研协同平台",
  className,
  ...rest
}: PaperclipLockupProps) {
  return (
    <svg {...rest} className={className} viewBox="22.5 22.5 193 27"
      fill="currentColor" role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title} focusable="false">
      <path d="M46.2611 33.6556L34.7307 44.6408C32.7445 46.5331 29.5205 46.5323 27.5303 44.6361C25.5404 42.74 25.54 39.669 27.5261 37.7768L39.0565 26.7916C40.2474 25.657 42.1811 25.6567 43.3752 26.7943C44.5693 27.9319 44.5689 29.7742 43.378 30.9088L31.849 41.8954C31.4528 42.2728 30.8077 42.273 30.4092 41.8933C30.011 41.5136 30.0117 40.8996 30.4078 40.5223L41.9382 29.5371C42.336 29.1581 42.336 28.5437 41.9382 28.1647C41.5404 27.786 40.8954 27.7858 40.4977 28.1647L28.9673 39.1499C27.7742 40.2866 27.7764 42.1295 28.9687 43.2657C30.1613 44.402 32.0963 44.4046 33.2895 43.2678L44.8192 32.2805C46.8068 30.3865 46.8038 27.3159 44.8157 25.4219C42.8275 23.5277 39.6039 23.5253 37.616 25.4192L26.0856 36.4044C23.3024 39.056 23.3058 43.3558 26.0898 46.0085C28.8741 48.6612 33.388 48.6649 36.1712 46.0132L47.7017 35.028C48.0994 34.649 48.0994 34.0346 47.7017 33.6556C47.3039 33.2766 46.6589 33.2766 46.2611 33.6556Z" />
      <text x="57" y="43" fontSize="23" fontWeight="600"
        fontFamily="system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif">智研协同平台</text>
    </svg>
  );
}
