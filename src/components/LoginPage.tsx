import { useEffect, useRef, useState } from "react";
import { loginUser } from "../db";
import { useStore } from "../store/useStore";

export function LoginPage() {
  const setCurrentUser = useStore((s) => s.setCurrentUser);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const busySince = useRef<number | null>(null);
  useEffect(() => {
    if (!busy) {
      busySince.current = null;
      return;
    }
    busySince.current = Date.now();
    const t = window.setInterval(() => {
      if (busySince.current && Date.now() - busySince.current > 4000) {
        setBusy(false);
        setErr("Sign-in is taking too long — try again.");
        busySince.current = null;
        window.clearInterval(t);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [busy]);

  const doLogin = async () => {
    const u = username.trim();
    const p = password.trim();
    if (!u || !p) {
      setErr("Username and password are required.");
      return;
    }
    setBusy(true);
    setErr("");
    let user;
    try {
      user = await loginUser(u, p);
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
      setBusy(false);
      return;
    }
    try {
      setCurrentUser(user);
      setUsername("");
      setPassword("");
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-container-lowest p-8">
      <div className="w-full max-w-sm rounded-xl border border-outline-variant bg-surface p-6 shadow-lg">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded bg-primary text-headline-lg font-bold text-on-primary">
            P
          </div>
          <div>
            <h2 className="text-headline-lg font-headline-lg leading-none tracking-tight text-on-surface">
              Pulse
            </h2>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-on-surface-variant">Pharmacy MS</p>
            <p className="mt-1 text-body-sm font-body-sm text-on-surface-variant">Sign in to continue</p>
          </div>
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
          Default manager is <span className="font-mono">manager / manager</span> — or your manager PIN if one was set before. Change it after first login in Settings → Users.
        </p>
      </div>
    </div>
  );
}
