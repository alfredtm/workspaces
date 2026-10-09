/** A small rotating ring sized to the surrounding text. Decorative unless `label` is given. */
export function Spinner({ label, size }: { label?: string; size?: "md" | "lg" }) {
  return (
    <span
      className={"ui-spinner" + (size === "lg" ? " ui-spinner-lg" : "")}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
