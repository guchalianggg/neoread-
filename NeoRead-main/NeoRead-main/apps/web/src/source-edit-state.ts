import { api } from "@neoread/api";
import type { SourceEditSnapshot } from "@neoread/core";
import { registerTabCloseGuard } from "./document-tab-guards";
import { reportDiagnostic } from "./diagnostics";
import { validateSheets, type SourceSheet } from "./source-spreadsheet";

export type SourceEditState = {
  snapshot?: SourceEditSnapshot;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  conflict: boolean;
  error: string;
};

function diagnostic(event: string, conflict = false) {
  // Do not log filenames, cell contents, Markdown or server error messages.
  try {
    reportDiagnostic({
      event: `source_edit.${event}`,
      level: "warn",
      detail: conflict ? "revision_conflict" : "draft_retained",
    });
  } catch {
    /* Diagnostics must not affect draft recovery. */
  }
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 409
  );
}

function checkSnapshot(snapshot: SourceEditSnapshot) {
  if (
    !snapshot.editable ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0
  )
    throw new Error("无效的编辑快照。");
  if (snapshot.kind === "xls" || snapshot.kind === "xlsx") {
    if (!Array.isArray(snapshot.sheets)) throw new Error("缺少工作表数据。");
    validateSheets(snapshot.sheets);
  } else if (typeof snapshot.content !== "string")
    throw new Error("缺少文档正文。");
  return snapshot;
}

function createSourceEditStore(id: string) {
  let state: SourceEditState = {
    loading: false,
    saving: false,
    dirty: false,
    conflict: false,
    error: "",
  };
  let editVersion = 0;
  let loading: Promise<void> | undefined;
  let saving: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SourceEditState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const load = (discardConfirmed = false): Promise<void> => {
    if (loading) return loading;
    if (state.saving || (state.snapshot && !discardConfirmed))
      return Promise.resolve();
    update({ loading: true, error: "" });
    loading = Promise.resolve().then(async () => {
      try {
        const snapshot = checkSnapshot(await api.getSourceEdit(id));
        editVersion++;
        update({ snapshot, dirty: false, conflict: false, error: "" });
      } catch {
        update({ error: "读取失败，请重试。已有草稿仍保留。" });
        diagnostic("load_failed");
      } finally {
        loading = undefined;
        update({ loading: false });
      }
    });
    return loading;
  };
  const edit = (patch: { content?: string; sheets?: SourceSheet[] }) => {
    if (!state.snapshot || state.loading) return;
    if (patch.sheets) validateSheets(patch.sheets);
    if (patch.content !== undefined && patch.content === state.snapshot.content)
      return;
    if (patch.sheets && patch.sheets === state.snapshot.sheets) return;
    editVersion++;
    update({
      snapshot: { ...state.snapshot, ...patch },
      dirty: true,
      error: state.conflict ? state.error : "",
    });
  };
  const save = (): Promise<void> => {
    if (saving) return saving;
    if (state.conflict)
      return Promise.reject(
        new Error("版本冲突：请确认后重新加载，草稿未被覆盖。"),
      );
    if (!state.dirty || !state.snapshot) return Promise.resolve();
    if (state.loading)
      return Promise.reject(new Error("正在重新加载，请稍后保存。"));
    const sent = state.snapshot;
    const version = editVersion;
    update({ saving: true, error: "" });
    saving = Promise.resolve().then(async () => {
      try {
        const payload =
          sent.kind === "xls" || sent.kind === "xlsx"
            ? { revision: sent.revision, sheets: sent.sheets }
            : { revision: sent.revision, content: sent.content };
        const saved = checkSnapshot(await api.saveSourceEdit(id, payload));
        if (saved.revision !== sent.revision + 1)
          throw new Error("保存修订号无效。");
        // Retain newer typing, but always advance its base to the committed revision.
        const snapshot =
          editVersion === version
            ? saved
            : {
                ...saved,
                ...(sent.sheets
                  ? { sheets: state.snapshot!.sheets }
                  : { content: state.snapshot!.content }),
              };
        update({
          snapshot,
          dirty: editVersion !== version,
          conflict: false,
          error: "",
        });
      } catch (error) {
        const conflict = isConflict(error);
        update({
          dirty: true,
          conflict,
          error: conflict
            ? "版本冲突：服务器已有新版本。草稿已保留，请确认后重新加载。"
            : "保存失败，草稿已保留，请重试。",
        });
        diagnostic("save_failed", conflict);
        throw error;
      } finally {
        saving = undefined;
        update({ saving: false });
      }
    });
    return saving;
  };
  const flush = async () => {
    // Bounded retry protects close/download from an indefinitely changing draft.
    for (let round = 0; round < 20; round++) {
      if (!state.dirty && !state.saving) return;
      await save();
    }
    if (state.dirty || state.saving) {
      const error = "编辑仍在变化，请停止输入后再次保存。草稿已保留。";
      update({ error });
      throw new Error(error);
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: () => load(),
    // Caller must obtain explicit user confirmation before discarding a draft.
    reloadConfirmed: () => load(true),
    editContent: (content: string) => edit({ content }),
    editSheets: (sheets: SourceSheet[]) => edit({ sheets }),
    save,
    flush,
    registerCloseGuard: () =>
      registerTabCloseGuard(id, () =>
        state.saving
          ? { message: "文档正在保存，请稍后关闭。", blocked: true }
          : state.loading && state.dirty
            ? { message: "文档正在重新加载，请稍后关闭。", blocked: true }
            : state.dirty
              ? {
                  message:
                    "文档有未保存的修改，仍要关闭标签页吗？草稿仅保留于当前会话。",
                }
              : null,
      ),
  };
}

const stores = new Map<string, ReturnType<typeof createSourceEditStore>>();
export function getSourceEditStore(id: string) {
  let store = stores.get(id);
  if (!store) {
    store = createSourceEditStore(id);
    stores.set(id, store);
  }
  return store;
}

export function hasPendingSourceEdits(): boolean {
  return [...stores.values()].some((store) => {
    const state = store.getSnapshot();
    return state.dirty || state.saving;
  });
}

export async function flushSourceEdits(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const pending = [...stores.values()].filter((store) => {
      const state = store.getSnapshot();
      return state.dirty || state.saving;
    });
    if (!pending.length) return;
    // Wait for every write, even if one document fails; never exit during a write.
    const results = await Promise.allSettled(
      pending.map((store) => store.flush()),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  if (hasPendingSourceEdits())
    throw new Error("仍有未保存的编辑，请停止输入后重试。");
}
