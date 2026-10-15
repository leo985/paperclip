import { uiTextFormat,  uiText } from "@/i18n/interface";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { copyTextToClipboard } from "@/lib/clipboard";

export function CopyField({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
        <code title={value} className="min-w-0 flex-1 truncate text-xs">
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={uiTextFormat("Copy __PCVAR0__", [label])}
          onClick={async () => {
            try {
              await copyTextToClipboard(value);
              setCopied(true);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? uiText("Copied") : uiText("Copy")}
        </Button>
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">{uiText("Copy failed. Select and copy the text below.")}{" "}</p>
          <textarea
            readOnly
            aria-label={uiTextFormat("__PCVAR0__ text", [label])}
            value={value}
            rows={5}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}

export function AgentInstructions({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <section
      aria-label={uiText("Agent instructions")}
      className="space-y-3 rounded-md bg-muted/40 p-4"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{uiText("Agent instructions")}</h2>
        <p className="text-sm text-muted-foreground">{uiText("Give your agent everything it needs to connect this webhook: the URL, authentication key, and step-by-step instructions.")}{" "}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-label={uiText("Copy for your agent")}
        onClick={async () => {
          try {
            await copyTextToClipboard(value);
            setCopied(true);
            setError(false);
          } catch {
            setError(true);
          }
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? uiText("Copied instructions") : uiText("Copy for your agent")}
      </Button>
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">{uiText("Copy failed. Select and copy the instructions below.")}{" "}</p>
          <textarea
            readOnly
            aria-label={uiText("Agent instructions text")}
            value={value}
            rows={5}
            className="w-full rounded-md border border-input bg-background p-3 text-sm"
          />
        </div>
      )}
    </section>
  );
}
