// One row of the workspace list: status dot, name, an optional line or two of
// detail, then actions.
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { SkeletonLine } from "../ui/Skeleton";
import type { ResourceState } from "./status";

export type RowStatus = {
  state: ResourceState;
  /** The line under the name. Empty string renders no line at all. */
  label: string;
};

export default function ResourceRow({
  name,
  status,
  subline,
  quietActions,
  actions,
  onDelete,
  openable,
}: {
  /** Display name; also the row's accessible label. */
  name: string;
  status: RowStatus;
  /** An extra line under the status line (e.g. the retention notice). */
  subline?: ReactNode;
  /** Actions that stay quiet until the row is hovered or focused, rendered before the delete button. */
  quietActions?: ReactNode;
  /** The primary action, rendered last. */
  actions?: ReactNode;
  /** Renders the quiet delete button; the caller opens the confirm modal. */
  onDelete?: () => void;
  /** Row is a click target for a stretched `.ws-open` link inside `actions`. */
  openable?: boolean;
}) {
  const warn = status.state === "slow" || status.state === "error";
  return (
    <article className={"ws-row" + (openable ? " ws-row-openable" : "")} aria-label={name}>
      <span className={"ws-dot ws-dot-" + status.state} aria-hidden="true" />
      <div className="ws-id">
        <h3 className="ws-name">{name}</h3>
        {status.label && <p className={"ws-line" + (warn ? " ws-line-warn" : "")}>{status.label}</p>}
        {subline && <p className="ws-line">{subline}</p>}
      </div>
      <div className="ws-actions">
        {quietActions}
        {onDelete && (
          <Button
            size="sm"
            variant="danger-ghost"
            className="ws-quiet"
            aria-label={`Delete ${name}`}
            title="Delete"
            onClick={onDelete}
          >
            <Icon icon={faTrash} />
          </Button>
        )}
        {actions}
      </div>
    </article>
  );
}

/** First-load placeholder for the list — two rows' worth. */
export function ResourceListSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="ws-list">
      <span className="ui-visually-hidden">{label}</span>
      {[0, 1].map((i) => (
        <div className="ws-row" aria-hidden="true" key={i}>
          <span className="ws-dot ws-dot-paused" />
          <div className="ws-id" style={{ flex: 1 }}>
            <SkeletonLine width="35%" />
            <SkeletonLine width="20%" />
          </div>
          <SkeletonLine width="88px" />
        </div>
      ))}
    </div>
  );
}
