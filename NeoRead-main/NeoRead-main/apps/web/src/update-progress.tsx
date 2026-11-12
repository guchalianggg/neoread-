import { useEffect } from "react";
import { toast } from "sonner";
import { Progress } from "@neoread/ui/components/progress";

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);
// Shows desktop update downloads in one persistent toast.
export function useUpdateProgress() {
  useEffect(
    () =>
      window.neoreadDesktop?.onUpdateProgress?.((progress) => {
        if (!progress) {
          toast.dismiss("neoread-update");
          return;
        }
        if (progress.phase === "prepare") {
          toast.loading(`正在准备安装 NeoRead ${progress.version}`, {
            id: "neoread-update",
            description: undefined,
            duration: Infinity,
          });
          return;
        }
        const { received, total } = progress;
        toast.loading(`正在下载 NeoRead ${progress.version}`, {
          id: "neoread-update",
          duration: Infinity,
          description: (
            <div className="mt-2 grid gap-1.5">
              {/* An unknown size would render as an empty, 0% track. */}
              {total && (
                <Progress
                  aria-label="更新下载进度"
                  value={Math.min(100, (received / total) * 100)}
                />
              )}
              <span className="tabular-nums">
                {total
                  ? `${megabytes(received)} / ${megabytes(total)} MB`
                  : `已下载 ${megabytes(received)} MB`}
              </span>
              <span className="text-xs opacity-70">
                速度较慢时可开启代理加速。
              </span>
            </div>
          ),
        });
      }),
    [],
  );
}
