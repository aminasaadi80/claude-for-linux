import { useCallback, useRef, useState } from "react";

/** A self-expiring toast message — shared by the Git and SFTP/FTP panels. */
export function useToast(ttlMs = 4000) {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const flash = useCallback(
    (msg: string) => {
      setToast(msg);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setToast(null), ttlMs);
    },
    [ttlMs]
  );

  const clear = useCallback(() => setToast(null), []);

  return { toast, flash, clear };
}
