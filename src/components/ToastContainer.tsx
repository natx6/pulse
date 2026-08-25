import { useToast } from "../store/toast";

const icons: Record<string, string> = {
  success: "check_circle",
  error: "error",
  info: "info",
};

const colors: Record<string, string> = {
  success: "bg-primary text-on-primary shadow-xl",
  error: "bg-error text-on-error shadow-xl",
  info: "bg-inverse-surface text-inverse-on-surface shadow-xl",
};

export function ToastContainer() {
  const toasts = useToast((s) => s.toasts);
  const dismiss = useToast((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-20 left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-3 rounded-xl px-4 py-3 shadow-lg transition-all ${colors[t.type]}`}
        >
          <span className="material-symbols-outlined text-[20px]">{icons[t.type]}</span>
          <span className="text-body-sm font-body-sm font-medium">{t.message}</span>
          {t.undo && (
            <button
              onClick={() => {
                t.undo!();
                dismiss(t.id);
              }}
              className="ml-2 rounded border border-white/30 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide hover:bg-white/10"
            >
              Undo
            </button>
          )}
          <button
            onClick={() => dismiss(t.id)}
            className="ml-1 rounded-full p-0.5 hover:bg-white/10"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      ))}
    </div>
  );
}
