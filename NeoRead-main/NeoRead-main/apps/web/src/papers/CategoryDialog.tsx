import { useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";

/** Names a new category or tag; `count` papers receive it on save. */
export function CategoryDialog({
  count,
  itemLabel = "篇论文",
  parent,
  kind = "category",
  suggestions = [],
  onSave,
  onClose,
}: {
  count: number;
  itemLabel?: string;
  parent?: string;
  kind?: "category" | "tag";
  suggestions?: string[];
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const noun = kind === "tag" ? "标签" : "分类";
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      if (await onSave(name)) onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {kind === "tag" ? "新标签" : parent ? "新建子分类" : "新建分类"}
          </DialogTitle>
          <DialogDescription className={count || parent ? "" : "sr-only"}>
            {[
              parent && `位于“${parent.replaceAll("/", " / ")}”`,
              count &&
                (kind === "tag"
                  ? `加到所选的 ${count} ${itemLabel}`
                  : `放入所选的 ${count} ${itemLabel}`),
            ]
              .filter(Boolean)
              .join("，") || `输入${noun}名`}
          </DialogDescription>
        </DialogHeader>
        {suggestions.length > 0 && (
          <div
            className="flex max-h-40 flex-wrap gap-1 overflow-y-auto"
            aria-label="已有标签"
          >
            {suggestions.map((tag) => (
              <Button
                key={tag}
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => setName(tag)}
              >
                #{tag}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            maxLength={40}
            aria-label={`${noun}名`}
            placeholder={`${noun}名`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={!name.trim() || saving}>
            创建
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
