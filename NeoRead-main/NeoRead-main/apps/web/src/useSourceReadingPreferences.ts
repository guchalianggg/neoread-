import { useEffect, useRef, useState } from "react";
import { api } from "@neoread/api";
import { reportDiagnostic } from "./diagnostics";
import {
  parseReadingAnchor,
  type ReadingAnchor,
} from "./source-reading-navigation";

export const readingWidths = ["narrow", "standard", "wide"] as const;
export type ReadingWidth = (typeof readingWidths)[number];
type ReadingPreferences = {
  width: ReadingWidth;
  pinned: boolean;
  position: ReadingAnchor | null;
};
const defaults: ReadingPreferences = {
  width: "standard",
  pinned: false,
  position: null,
};

function warn(detail: "read_failed" | "write_failed") {
  try {
    reportDiagnostic({
      event: "source_reading.preferences_failed",
      level: "warn",
      detail,
    });
  } catch {
    // Reading still works if preferences or diagnostics cannot be reached.
  }
}

// A single latest-value queue per reader writes neither text nor search terms.
export function useSourceReadingPreferences(id: string) {
  const current = useRef<ReadingPreferences>(defaults);
  const saved = useRef(defaults);
  const [appearance, setAppearance] = useState(defaults);
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const writing = useRef<Promise<void>>(undefined);
  const loggedFailure = useRef(false);

  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (writing.current || current.current === saved.current) return;
    const documentState = current.current;
    const pending = api
      .saveSourceReadingPreferences(id, documentState)
      .then(
        () => {
          saved.current = documentState;
          loggedFailure.current = false;
        },
        () => {
          if (!loggedFailure.current) warn("write_failed");
          loggedFailure.current = true;
        },
      )
      .finally(() => {
        writing.current = undefined;
        if (current.current !== documentState && !timer.current) flush();
      });
    writing.current = pending;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    const controller = new AbortController();
    void api
      .sourceReadingPreferences(id, controller.signal)
      .then((stored) => {
        if (controller.signal.aborted) return;
        const width =
          readingWidths.find((option) => option === stored.width) ?? "standard";
        const state = {
          width,
          pinned: stored.pinned === true,
          position: parseReadingAnchor(stored.position),
        };
        saved.current = state;
        current.current = state;
        setAppearance(state);
      })
      .catch(() => {
        if (!controller.signal.aborted) warn("read_failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    const hide = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", flushRef.current);
    const onPageHide = flushRef.current;
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", onPageHide);
      flushRef.current();
    };
  }, [id]);

  function change(patch: Partial<ReadingPreferences>) {
    if (!ready) return;
    const state = current.current;
    if (
      patch.position &&
      JSON.stringify(state.position) === JSON.stringify(patch.position)
    )
      return;
    if (patch.width === state.width || patch.pinned === state.pinned) return;
    current.current = { ...state, ...patch };
    if (patch.width !== undefined || patch.pinned !== undefined)
      setAppearance(current.current);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 350);
  }
  return {
    width: appearance.width,
    pinned: appearance.pinned,
    ready,
    current,
    change,
    flush,
  };
}
