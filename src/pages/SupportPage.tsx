import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../store/useStore";
import { getDeviceId } from "../db";
import { HelpDocs } from "../components/HelpDocs";

/** Support = a compose page. Staff write what happened, tap Send, and their
 * mail app opens with everything assembled (pharmacy, name, version, device
 * id, date) — the message arrives with context, not "it's broken". */
export function SupportPage() {
  const pharmacyName = useStore((s) => s.pharmacyName);
  const supportEmail = useStore((s) => s.supportEmail);
  const setTourOpen = useStore((s) => s.setTourOpen);

  const [phName, setPhName] = useState(pharmacyName);
  const [staffName, setStaffName] = useState("");
  const [doing, setDoing] = useState("");
  const [expected, setExpected] = useState("");
  const [version, setVersion] = useState("—");
  const [deviceId, setDeviceId] = useState("…");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("—"));
    getDeviceId()
      .then(setDeviceId)
      .catch(() => setDeviceId("—"));
  }, []);

  const canSend = Boolean(supportEmail) && (doing.trim() !== "" || expected.trim() !== "");

  const mailto = supportEmail
    ? `mailto:${supportEmail}?subject=${encodeURIComponent(
        `Pulse support — ${phName.trim() || pharmacyName}`,
      )}&body=${encodeURIComponent(
        [
          `Pharmacy: ${phName.trim() || pharmacyName}`,
          `Staff: ${staffName.trim() || "—"}`,
          `App version: ${version}`,
          `Device: ${deviceId}`,
          `Date: ${new Date().toLocaleString()}`,
          "",
          "What I was doing:",
          doing.trim(),
          "",
          "What went wrong / what I expected:",
          expected.trim(),
          "",
          "(Attach a screenshot here if the problem is visual.)",
        ].join("\n"),
      )}`
    : null;

  const field =
    "w-full rounded border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  const [tab, setTab] = useState<"help" | "contact">("help");

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-container-lowest p-margin-page">
      <div className="mb-4" data-tour="tour-support">
        <h2 className="text-headline-lg font-headline-lg text-on-surface">Support</h2>
        <div className="mt-3 flex w-fit rounded-full border border-outline-variant bg-surface p-1">
          <button
            onClick={() => setTab("help")}
            className={`rounded-full px-4 py-1 text-label-md font-label-md ${tab === "help" ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"}`}
          >
            Help
          </button>
          <button
            onClick={() => setTab("contact")}
            className={`rounded-full px-4 py-1 text-label-md font-label-md ${tab === "contact" ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"}`}
          >
            Contact
          </button>
        </div>
      </div>

      <button
        onClick={() => setTourOpen(true)}
        className="mb-4 flex h-10 w-fit items-center gap-2 rounded border border-primary/40 bg-primary/5 px-4 text-label-md font-label-md text-primary hover:bg-primary/10"
      >
        <span className="material-symbols-outlined text-[18px]">travel_explore</span>
        Take a product tour
      </button>

      {tab === "help" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <HelpDocs />
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="max-w-xl">
        <label className="mb-4 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Pharmacy name
          </span>
          <input
            value={phName}
            onChange={(e) => setPhName(e.target.value)}
            className={`${field} h-9`}
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            Your name <span className="text-on-surface-variant">(optional)</span>
          </span>
          <input
            value={staffName}
            onChange={(e) => setStaffName(e.target.value)}
            placeholder="Who we're talking to"
            className={`${field} h-9`}
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            What were you doing?
          </span>
          <textarea
            value={doing}
            onChange={(e) => setDoing(e.target.value)}
            rows={3}
            placeholder="e.g. Scanning a new item at the counter…"
            className={field}
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-body-md font-body-md text-on-surface">
            What went wrong, or what did you expect?
          </span>
          <textarea
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            rows={3}
            placeholder="e.g. Expected it to add to the sale, but nothing happened"
            className={field}
          />
        </label>

        {mailto && canSend ? (
          <a
            href={mailto}
            className="flex h-10 w-fit items-center gap-2 rounded bg-primary px-5 text-label-md font-label-md text-on-primary shadow-sm transition-colors hover:bg-on-primary-fixed-variant"
          >
            <span className="material-symbols-outlined text-[18px]">mail</span>
            Send via Email
          </a>
        ) : (
          <button
            disabled
            className="flex h-10 w-fit cursor-not-allowed items-center gap-2 rounded bg-primary/40 px-5 text-label-md font-label-md text-on-primary"
          >
            <span className="material-symbols-outlined text-[18px]">mail</span>
            Send via Email
          </button>
        )}

        {!supportEmail && (
          <p className="mt-3 text-body-sm font-body-sm text-on-surface-variant">
            No support email is set yet — add one in Settings, then this button sends
            your report there.
          </p>
        )}
        {supportEmail && !canSend && (
          <p className="mt-3 text-body-sm font-body-sm text-on-surface-variant">
            Write what happened in the boxes above first — the button unlocks once
            there's something to send.
          </p>
        )}
        <p className="mt-3 text-body-sm font-body-sm text-on-surface-variant">
          Your mail app opens with the message ready. You can attach a screenshot
          there before sending — it helps a lot.
        </p>
        </div>
        </div>
      )}
    </div>
  );
}
