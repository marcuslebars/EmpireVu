import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface ToastState {
  message: string;
  kind: "ok" | "error";
}

const ToastContext = createContext<(message: string, kind?: ToastState["kind"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback((message: string, kind: ToastState["kind"] = "ok") => {
    setToast({ message, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), kind === "error" ? 3200 : 2000);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast.kind === "ok" ? (
            <CheckCircle weight="fill" size={17} color="hsl(152 60% 55%)" />
          ) : (
            <WarningCircle weight="fill" size={17} color="var(--dest-l)" />
          )}
          <span>{toast.message}</span>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
