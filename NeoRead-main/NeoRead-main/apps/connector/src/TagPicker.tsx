import { useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@neoread/ui/components/toggle-group";

export function TagPicker({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: string[];
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [created, setCreated] = useState<string[]>([]);
  const choices = [
    ...new Map(
      [...options, ...created, ...value].map((tag) => [tag.toLowerCase(), tag]),
    ).values(),
  ];
  const addTag = () => {
    const name = draft.trim();
    if (!name || disabled) return;
    const tag =
      choices.find((option) => option.toLowerCase() === name.toLowerCase()) ||
      name;
    if (!choices.includes(tag)) setCreated((current) => [...current, tag]);
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };
  return (
    <section className="tag-picker" aria-labelledby="tag-picker-label">
      <p id="tag-picker-label" className="tag-picker-label">
        标签
      </p>
      {choices.length > 0 && (
        <ToggleGroup
          multiple
          size="sm"
          variant="outline"
          className="tag-options"
          aria-label="可选标签"
          value={value}
          onValueChange={onChange}
          disabled={disabled}
        >
          {choices.map((tag) => (
            <ToggleGroupItem
              key={tag}
              value={tag}
              className="tag-capsule"
              title={tag}
            >
              <span>#{tag}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      <div className="tag-create">
        <Input
          type="text"
          aria-label="新增标签"
          placeholder="新增标签"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              addTag();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !draft.trim()}
          onClick={addTag}
        >
          添加
        </Button>
      </div>
    </section>
  );
}
