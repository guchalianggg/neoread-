import { toast } from "sonner";
export async function copyText(text: string, successMessage?: string) {
  try {
    if (window.neoreadDesktop?.writeClipboardText)
      await window.neoreadDesktop.writeClipboardText(text);
    else await navigator.clipboard.writeText(text);
    if (successMessage)
      toast.success(successMessage, { id: "neoread-clipboard" });
    return true;
  } catch {
    toast.error("复制失败，请选择文字后复制。", { id: "neoread-clipboard" });
    return false;
  }
}
export async function copyImage(url: string, text: string) {
  try {
    if (window.neoreadDesktop?.writeClipboardImage) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(response.statusText);
      await window.neoreadDesktop.writeClipboardImage(
        new Uint8Array(await response.arrayBuffer()),
        text,
      );
      toast.success("已复制图片", { id: "neoread-clipboard" });
      return;
    }
    // Pass the blob as a promise so Safari keeps the click's user activation.
    const image = fetch(url).then((response) => {
      if (!response.ok) throw new Error(response.statusText);
      return response.blob();
    });
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": image,
        ...(text && { "text/plain": new Blob([text], { type: "text/plain" }) }),
      }),
    ]);
    toast.success("已复制图片", { id: "neoread-clipboard" });
  } catch {
    toast.error("复制图片失败", { id: "neoread-clipboard" });
  }
}
