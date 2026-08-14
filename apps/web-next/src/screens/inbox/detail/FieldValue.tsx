/**
 * FieldValue — exhaustive switch over all 11 FieldTypes.
 * assertNever default (locked rule: feedback_assertnever_discriminated_union_renderers).
 * Import assertNever from @gatewerk/shared which already exports it.
 */
import { type FieldType, assertNever } from "@gatewerk/shared";
import { TextField } from "./fields/TextField";
import { MarkdownField } from "./fields/MarkdownField";
import { NumberField } from "./fields/NumberField";
import { BooleanField } from "./fields/BooleanField";
import { SelectField } from "./fields/SelectField";
import { ButtonsField } from "./fields/ButtonsField";
import { UrlField } from "./fields/UrlField";
import { DateField } from "./fields/DateField";
import { ImageField } from "./fields/ImageField";
import { VideoField } from "./fields/VideoField";
import { JsonField } from "./fields/JsonField";

interface Props {
  type: FieldType;
  value: unknown;
  editable: boolean;
  options?: string[];
  onCommit: (v: unknown) => void;
}

export function FieldValue({ type, value, editable, options, onCommit }: Props) {
  switch (type) {
    case "text":
      return (
        <TextField
          value={value}
          editable={editable}
          onCommit={(v) => onCommit(v)}
        />
      );

    case "markdown":
      return (
        <MarkdownField
          value={value}
          editable={editable}
          onCommit={(v) => onCommit(v)}
        />
      );

    case "number":
      return (
        <NumberField
          value={value}
          editable={editable}
          onCommit={(v) => onCommit(v)}
        />
      );

    case "boolean":
      return (
        <BooleanField
          value={value}
          editable={editable}
          onCommit={(v) => onCommit(v)}
        />
      );

    case "select":
      return (
        <SelectField
          value={value}
          editable={editable}
          options={options}
          onCommit={(v) => onCommit(v)}
        />
      );

    case "buttons":
      return (
        <ButtonsField
          value={value}
          editable={editable}
          options={options}
          onCommit={(v) => onCommit(v)}
        />
      );

    case "url":
      return <UrlField value={value} />;

    case "date":
      return <DateField value={value} />;

    case "image":
      return <ImageField value={value} />;

    case "video":
      return <VideoField value={value} />;

    case "json":
      return <JsonField value={value} />;

    default:
      return assertNever(type);
  }
}
