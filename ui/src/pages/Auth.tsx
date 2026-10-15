import { uiText } from "@/i18n/interface";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi, AuthApiError } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PaperclipLockup } from "../components/PaperclipLockup";

type AuthMode = "sign_in" | "sign_up";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [personnel, setPersonnel] = useState(false);
  const [activation] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("activate"));
  const [error, setError] = useState<string | null>(null);
  const errorId = "auth-error";

  const nextPath = useMemo(
    () => searchParams.get("next") || getRememberedInvitePath() || "/",
    [searchParams],
  );
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (activation) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, [activation]);

  useEffect(() => {
    if (session && !activation) {
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath, activation]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (activation) { await authApi.activatePersonnel(activation, password); return; }
      if (mode === "sign_in") {
        if (personnel) { await authApi.signInPersonnel({ username: email.trim(), password }); return; }
        try { await authApi.signInEmail({ email: email.trim(), password }); }
        catch(error) {
          if(!(error instanceof AuthApiError)||error.status!==401)throw error;
          await authApi.signInPersonnel({username:email.trim(),password});
        }
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      // Reset rather than invalidate: the `["companies"]` entry is shared app-wide and
      // is not account-scoped, so invalidating leaves the previous account's list
      // readable (and any fetch for that session in flight) until the refetch lands.
      // Sign-in can change accounts, so drop the list outright.
      await queryClient.resetQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const canSubmit =
    (activation ? password.length >= 12 : email.trim().length > 0) &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <PaperclipLoading className="min-h-0" />
      </div>
    );
  }

  if (activation && session) return <div className="flex min-h-screen items-center justify-center bg-background p-6"><section className="space-y-4 rounded-md border border-border p-6"><h1 className="text-lg font-semibold">请先退出当前账号</h1><p className="text-sm text-muted-foreground">此浏览器已有登录会话，请退出后由激活链接对应的本人设置密码。</p><Button onClick={() => void authApi.signOut().then(() => queryClient.resetQueries({ queryKey: queryKeys.auth.session }))}>退出当前账号</Button></section></div>;

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="mb-8">
            <PaperclipLockup className="h-6 w-auto text-primary" />
          </div>

          <h1 className="text-xl font-semibold">
            {activation ? "激活企业人员账号" : mode === "sign_in" ? uiText("Sign in to Paperclip") : uiText("Create your Paperclip account")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {activation ? "设置至少 12 位的个人登录密码，激活链接仅可使用一次。" : mode === "sign_in"
              ? uiText("Use your email and password to access this instance.")
              : uiText("Create an account for this instance. Email confirmation is not required in v1.")}
          </p>

          <form
            className="mt-6 space-y-4"
            method="post"
            action={mode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
            onSubmit={(event) => {
              event.preventDefault();
              if (mutation.isPending) return;
              if (!canSubmit) {
                setError("Please fill in all required fields.");
                return;
              }
              mutation.mutate();
            }}
          >
            {!activation && mode === "sign_in" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={personnel} onChange={e => setPersonnel(e.target.checked)} />企业人员账号（联邦用户名或邮箱）</label>}
            {!activation && mode === "sign_up" && (
              <div>
                <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">{uiText("Name")}</label>
                <input
                  id="name"
                  name="name"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
              </div>
            )}
            {!activation && <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">{personnel && mode === "sign_in" ? "联邦用户名或邮箱" : uiText("Email")}</label>
              <input
                id="email"
                name="email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type={personnel && mode === "sign_in" ? "text" : "email"}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                autoFocus={mode === "sign_in"}
              />
            </div>}
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">{uiText("Password")}</label>
              <input
                id="password"
                name="password"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={!activation && mode === "sign_in" ? "current-password" : "new-password"}
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
            {error && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending}
              className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending
                ? uiText("Working…")
                : activation ? "激活并登录" : mode === "sign_in"
                  ? uiText("Sign In")
                  : uiText("Create Account")}
            </Button>
          </form>
          <a href="/help.html" className="mt-4 block text-sm text-muted-foreground underline underline-offset-4">查看网站使用帮助</a>

          {!activation && <div className="mt-5 text-sm text-muted-foreground">
            {mode === "sign_in" ? uiText("Need an account?") : uiText("Already have an account?")}{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setError(null);
                setMode(mode === "sign_in" ? "sign_up" : "sign_in");
              }}
            >
              {mode === "sign_in" ? uiText("Create one") : uiText("Sign in")}
            </button>
          </div>}
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
