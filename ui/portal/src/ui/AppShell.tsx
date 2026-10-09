// The page frame: a slim top bar (product name, section links, account) over
// a centred content column. Links are plain <a> elements; the caller decides
// whether a click is a client-side navigation.
import type { MouseEvent, ReactNode } from "react";

export type NavLink = {
  href: string;
  label: string;
  active: boolean;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
};

export function AppShell({
  title,
  onHome,
  links,
  account,
  children,
}: {
  title: string;
  /** Click handler for the product name (links to "/"). */
  onHome?: (e: MouseEvent<HTMLAnchorElement>) => void;
  links: NavLink[];
  /** Right-hand side of the bar (signed-in user, sign out). */
  account?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ui-shell">
      <a className="ui-skip" href="#main">
        Skip to content
      </a>
      <header className="ui-topbar">
        <div className="ui-topbar-inner">
          <a href="/" className="ui-brand" onClick={onHome}>
            {title}
          </a>
          <nav aria-label="Main" className="ui-nav">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className={"ui-nav-link" + (l.active ? " ui-nav-link-active" : "")}
                aria-current={l.active ? "page" : undefined}
                onClick={l.onClick}
              >
                {l.label}
              </a>
            ))}
          </nav>
          {account && <div className="ui-account">{account}</div>}
        </div>
      </header>
      <main id="main" className="ui-main">
        {children}
      </main>
    </div>
  );
}
