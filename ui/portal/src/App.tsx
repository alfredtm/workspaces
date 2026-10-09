import { faArrowRightFromBracket } from "@fortawesome/free-solid-svg-icons";
import { useEffect, useState, type MouseEvent } from "react";
import { fetchMe, type Me } from "./api";
import StatusView from "./StatusView";
import WorkspacesView from "./WorkspacesView";
import { AppShell } from "./ui/AppShell";
import { buttonClass } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { Message } from "./ui/Message";
import { Spinner } from "./ui/Spinner";

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch((e: Error) => {
        if (e.message !== "unauthorized") setError(e.message);
      });
  }, []);

  // No router: two pages, switched with the History API.
  const navigate = (path: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work
    e.preventDefault();
    window.history.pushState(null, "", path);
    setRoute(path);
  };

  const onStatus = route === "/status";

  return (
    <AppShell
      title="Workspaces"
      onHome={navigate("/")}
      links={[
        { href: "/", label: "Workspaces", active: !onStatus, onClick: navigate("/") },
        { href: "/status", label: "Status", active: onStatus, onClick: navigate("/status") },
      ]}
      account={
        me && (
          <>
            <span className="ui-account-name" title={me.upn}>
              {me.displayName || me.username}
            </span>
            <a href="/auth/logout" className={buttonClass("ghost", "sm")} aria-label="Sign out" title="Sign out">
              <Icon icon={faArrowRightFromBracket} />
              <span className="ui-account-label">Sign out</span>
            </a>
          </>
        )
      }
    >
      {error && (
        <Message tone="error" title="Something went wrong">
          {error}
        </Message>
      )}
      {onStatus ? (
        <StatusView />
      ) : me ? (
        <WorkspacesView me={me} />
      ) : (
        !error && (
          <div className="page-loader">
            <Spinner size="lg" label="Loading your profile" />
          </div>
        )
      )}
    </AppShell>
  );
}
