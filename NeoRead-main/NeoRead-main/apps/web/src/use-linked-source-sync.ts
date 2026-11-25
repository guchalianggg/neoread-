import { useLayoutEffect, useRef, useState } from "react";
import { reportDiagnostic } from "./diagnostics";
import {
  canRefreshSourceEdit,
  type SourceEditStore,
} from "./source-edit-state";

type SyncSourceFile = NonNullable<
  NonNullable<Window["neoreadDesktop"]>["syncSourceFile"]
>;
type SyncStatus = Awaited<ReturnType<SyncSourceFile>>["state"];
type SyncFailure = "bridge_rejected" | "snapshot_unavailable";
type SyncWork = {
  inFlight?: Promise<void>;
  minimumRevision: number;
  failure?: SyncFailure;
};

// The store outlives the tab. An IPC can commit before an inactive/closed tab
// abandons its read, so keep the reported revision and single-flight lock here.
const workByStore = new WeakMap<SourceEditStore, SyncWork>();
const CHECK_INTERVAL_MS = 5_000;

function reportFailure(work: SyncWork, detail: SyncFailure) {
  if (work.failure === detail) return;
  work.failure = detail;
  try {
    reportDiagnostic({
      event: "source_sync.check_failed",
      level: "warn",
      detail,
    });
  } catch {
    /* Diagnostics cannot block checks or retries. */
  }
}

export function useLinkedSourceSync(
  id: string,
  store: SourceEditStore,
  eligible: boolean,
) {
  const desktop = window.neoreadDesktop;
  const syncSourceFile = desktop?.syncSourceFile;
  const [status, setStatus] = useState<SyncStatus>();
  const [checking, setChecking] = useState(false);
  const statusRef = useRef<SyncStatus>(undefined);
  const retryRef = useRef<() => void>(undefined);

  useLayoutEffect(() => {
    if (!eligible || !syncSourceFile) return;
    const work = workByStore.get(store) ?? { minimumRevision: 0 };
    workByStore.set(store, work);
    let current = true;
    const publish = (next: SyncStatus) => {
      statusRef.current = next;
      setStatus(next);
    };
    const check = (manual = false) => {
      if (
        !current ||
        work.inFlight ||
        (!manual && statusRef.current === "conflict")
      )
        return;
      const expected = store.getSnapshot();
      if (!canRefreshSourceEdit(expected)) return;
      const stillCurrent = () => current && store.getSnapshot() === expected;
      setChecking(true);
      work.inFlight = (async () => {
        let result: Awaited<ReturnType<SyncSourceFile>>;
        try {
          result = await syncSourceFile.call(desktop, id);
        } catch {
          reportFailure(work, "bridge_rejected");
          // A transport error alone doesn't establish that this source is linked.
          if (
            stillCurrent() &&
            statusRef.current &&
            statusRef.current !== "unlinked"
          )
            publish("failed");
          return;
        }
        if (result.state === "unlinked") {
          work.minimumRevision = 0;
          work.failure = undefined;
          if (stillCurrent()) publish("unlinked");
          return;
        }
        const revision =
          typeof result.revision === "number" &&
          Number.isSafeInteger(result.revision) &&
          result.revision >= 0
            ? result.revision
            : result.state === "updated"
              ? expected.snapshot.revision + 1
              : 0;
        work.minimumRevision = Math.max(work.minimumRevision, revision);
        if (!stillCurrent()) return;

        let next = result.state;
        if (
          next === "updated" ||
          work.minimumRevision > expected.snapshot.revision
        ) {
          const refreshed = await store.refreshLinkedSnapshot(
            expected,
            work.minimumRevision,
            () => current,
          );
          if (!current || refreshed === "blocked") return;
          if (refreshed === "failed") {
            reportFailure(work, "snapshot_unavailable");
            if (next !== "conflict" && next !== "missing") next = "failed";
            publish(next);
            return;
          }
        }
        work.failure = undefined;
        publish(next);
      })().finally(() => {
        work.inFlight = undefined;
        setChecking(false);
      });
    };
    // Defer the first check past effect setup (including StrictMode replay).
    // If a previous tab session is still checking, wait for it before checking.
    void Promise.resolve(work.inFlight).then(() => check());
    const onFocus = () => check();
    retryRef.current = () => check(true);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (statusRef.current !== "unlinked") check();
    }, CHECK_INTERVAL_MS);
    return () => {
      current = false;
      retryRef.current = undefined;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [desktop, syncSourceFile, eligible, id, store]);

  return {
    status: syncSourceFile && status !== "unlinked" ? status : undefined,
    checking,
    retry: () => retryRef.current?.(),
  };
}
