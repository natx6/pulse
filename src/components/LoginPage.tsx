import { useState } from "react";
import { loginUser } from "../db";
import { useStore } from "../store/useStore";
import { beep } from "../lib/audio";

export function LoginPage() {
  const setCurrentUser = useStore((s) => s.setCurrentUser);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const doLogin = async () => {
    const u = username.trim();
    const p = password.trim();
    if (!u || !p) {
      setErr("Username and password are required.");
      beep(false);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const user = await loginUser(u, p);
      beep(true);
      setCurrentUser(user);
      // Clear the form for next login.
      setUsername("");
      setPassword("");
      if (user.must_change_password) {
        // Keep the user logged in but force a password change UX via Settings or a prompt.
        // For now the manager can reset via Users tab.
      }
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      beep(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center bg-surface-container-lowest p-8">
      <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface p-6 shadow-lg">
        <div className="mb-6 text-center">
          <span className="material-symbols-outlined text-[48px] text-primary">local_pharmacy</span>
          <h2 className="mt-2 text-headline-lg font-headline-lg text-on-surface">Pulse</h2>
          <p className="text-body-sm font-body-sm text-on-surface-variant">Sign in to continue</p>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-label-md font-label-md text-on-surface">Username</span>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void doLogin()}
            placeholder="e.g. manager"
            className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-label-md font-label-md text-on-surface">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void doLogin()}
            placeholder="••••"
            className="h-9 w-full rounded border border-outline-variant bg-surface-container-lowest px-3 font-data-mono text-data-mono tracking-[0.3em] text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>

        {err && <p className="mb-3 text-body-sm font-body-sm text-error">{err}</p>}

        <button
          onClick={() => void doLogin()}
          disabled={busy}
          className="h-9 w-full rounded bg-primary px-4 text-label-md font-label-md text-on-primary shadow-sm hover:bg-on-primary-fixed-variant disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="mt-4 text-center text-body-sm font-body-sm text-on-surface-variant">
          Default manager is <span className="font-mono">manager / manager</span> — change it after first login in Settings → Users.
        </p>
      </div>
    </div>
  );
}
