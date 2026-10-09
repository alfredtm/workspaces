// Renders a FontAwesome icon definition as inline SVG — no runtime library, no
// CDN, just the path data that ships in @fortawesome/free-solid-svg-icons.
import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";

export function Icon({ icon, label, className }: { icon: IconDefinition; label?: string; className?: string }) {
  const [width, height, , , path] = icon.icon;
  const d = Array.isArray(path) ? path.join(" ") : path;
  return (
    <svg
      className={"ui-icon" + (className ? " " + className : "")}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path fill="currentColor" d={d} />
    </svg>
  );
}
