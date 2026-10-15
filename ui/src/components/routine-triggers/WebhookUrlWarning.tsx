import { uiText } from "@/i18n/interface";
import { InlineBanner } from "@/components/InlineBanner";
import { webhookUrlWarningReason } from "@/lib/webhook-url-warning";

const warnings = {
  loopback: {
    title: uiText("Other apps can’t reach this localhost URL"),
    message: uiText("This address points back to the machine sending the request. Services such as GitHub can’t use it to reach Paperclip on your computer."),
  },
  private: {
    title: uiText("This webhook URL appears to be private"),
    message: uiText("Only senders with access to this network can reach this address. Apps on the public internet, such as GitHub, usually can’t deliver webhooks here."),
  },
  tailscale: {
    title: uiText("This Tailscale URL may not be public"),
    message: uiText("Tailscale Serve is private to your tailnet, even with HTTPS. Apps outside your tailnet need Tailscale Funnel or another public HTTPS address. If Funnel is already enabled for this URL, you can continue."),
  },
  https: {
    title: uiText("Use HTTPS for webhooks from other apps"),
    message: uiText("This URL uses HTTP. Many apps require HTTPS, and HTTP does not encrypt webhook credentials or payloads."),
  },
  invalid: {
    title: uiText("Check the webhook URL"),
    message: uiText("This is not a valid HTTP or HTTPS URL. Your sending app needs a complete address it can reach."),
  },
};

export function WebhookUrlWarning({ url }: { url: string }) {
  const reason = webhookUrlWarningReason(url);
  if (!reason) return null;
  const warning = warnings[reason];
  return <InlineBanner tone="warning" title={warning.title}>
    <div className="space-y-2">
      <p>{warning.message}</p>
      <p>{uiText("You can continue for local or private-network use. For public senders, use a publicly reachable HTTPS URL.")}</p>
      <a className="underline underline-offset-4" href="https://docs.paperclip.ing/reference/deploy/https/" target="_blank" rel="noopener noreferrer">{uiText("Learn how to set up HTTPS and public access")}</a>
    </div>
  </InlineBanner>;
}
