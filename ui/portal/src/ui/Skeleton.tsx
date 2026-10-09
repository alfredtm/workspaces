/** A shimmering placeholder bar standing in for a line of text. */
export function SkeletonLine({ width = "100%" }: { width?: string }) {
  return <span className="ui-skeleton" style={{ width }} aria-hidden="true" />;
}
