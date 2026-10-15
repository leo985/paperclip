import { uiText } from "@/i18n/interface";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

/** Shared by the saved connection and its interactive review stories. */
export function RemoteMcpManagement({ providerName, connected = true, canReconnect = true, canDisconnect = true, busy = false, onReconnect, onManage, onDisconnect }: {
  providerName: string;
  connected?: boolean;
  canReconnect?: boolean;
  canDisconnect?: boolean;
  busy?: boolean;
  onReconnect: () => void;
  onManage: () => void;
  onDisconnect: () => void | Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  return <section className="space-y-4">
    <h2 className="text-sm font-semibold">{uiText("Connection settings")}</h2>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={!canReconnect || busy} onClick={onReconnect}>{uiText("Reconnect")}</Button>
      <Button variant="outline" onClick={onManage}>{uiText("Manage in")}{" "}{providerName}</Button>
      {connected && canDisconnect && <AlertDialog open={confirming} onOpenChange={(open) => { if (!busy) setConfirming(open); }}>
        <AlertDialogTrigger asChild><Button variant="ghost" className="text-destructive">{uiText("Disconnect")}</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{uiText("Disconnect")} {providerName}?</AlertDialogTitle>
            <AlertDialogDescription>{uiText("Delete this connection’s saved credentials and stop further calls through Paperclip. Other connections are unaffected. Actions already sent to the provider may still complete. Connecting again requires a new sign-in or key.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{uiText("Cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={async (event) => {
              event.preventDefault();
              try { await onDisconnect(); setConfirming(false); } catch { /* The controller displays the failure. */ }
            }}>{busy ? uiText("Disconnecting…") : uiText("Disconnect connection")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
    </div>
  </section>;
}
