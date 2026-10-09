import { useId, type InputHTMLAttributes } from "react";

/** A labelled text input. `hideLabel` keeps the label for screen readers only. */
export function Input({
  label,
  hideLabel,
  invalid,
  className,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hideLabel?: boolean; invalid?: boolean }) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={"ui-field" + (className ? " " + className : "")}>
      <label htmlFor={inputId} className={hideLabel ? "ui-visually-hidden" : "ui-label"}>
        {label}
      </label>
      <input
        id={inputId}
        className={"ui-input" + (invalid ? " ui-input-invalid" : "")}
        aria-invalid={invalid || undefined}
        {...rest}
      />
    </div>
  );
}
