import { faArrowUpRightFromSquare, faLaptopCode, faPause, faPlay, faPlus } from "@fortawesome/free-solid-svg-icons";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  createWorkspace,
  deleteWorkspace,
  fetchWorkspaces,
  startWorkspace,
  stopWorkspace,
  workspaceStatus,
  type Me,
  type Workspace,
} from "./api";
import DeleteModal from "./shared/DeleteModal";
import ResourceRow, { ResourceListSkeleton } from "./shared/ResourceRow";
import { useSuggestedName } from "./shared/names";
import { isSettled, replicaStatus, retentionNotice, startMessage } from "./shared/status";
import { useResourceList } from "./shared/useResourceList";
import { useStartMessages } from "./shared/useStartMessages";
import { Button, buttonClass } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { Input } from "./ui/Input";
import { Message } from "./ui/Message";
import { Spinner } from "./ui/Spinner";

export default function WorkspacesView({ me }: { me: Me }) {
  const { items: workspaces, banner, setBanner, reload, busy, withBusy } = useResourceList<Workspace>({
    load: fetchWorkspaces,
    isSettled,
    loadErrorHeader: "Could not load workspaces",
    startingMs: 3000,
  });

  const [confirmDelete, setConfirmDelete] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const taken = useMemo(() => new Set((workspaces ?? []).map((w) => w.slug || w.name)), [workspaces]);
  const { name, setName, reroll } = useSuggestedName(taken, "workspace");

  // Stage messages ("Preparing your disk…") for rows that are starting, so
  // the wait to Ready reads as progress instead of a silent spinner — and a
  // warning-styled line once the cluster names a problem or it drags on.
  const startMsgs = useStartMessages(workspaces, (w) =>
    workspaceStatus(w.name).then((s) => startMessage(s.message, s)),
  );

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("Give the workspace a name.");
      return;
    }
    setFormError("");
    setCreating(true);
    try {
      await createWorkspace(name.trim());
      // No success banner: the new row appears with its own "starting" state.
      reroll(name.trim());
      reload();
    } catch (err) {
      setBanner({ tone: "error", header: "Could not create workspace", body: (err as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const formValid = name.trim() !== "";
  const activeCount = (workspaces ?? []).filter((w) => w.replicas > 0).length;
  const atLimit = activeCount >= me.activeLimit;
  const showFormError = formError !== "" && !formValid;

  let list: ReactNode;
  if (workspaces === null) {
    list = <ResourceListSkeleton label="Loading workspaces" />;
  } else if (workspaces.length === 0) {
    list = (
      <div className="ws-empty">
        <div className="ws-empty-icon" aria-hidden="true">
          <Icon icon={faLaptopCode} />
        </div>
        <h2>No workspaces yet</h2>
        <p className="muted">Name one above and press Create.</p>
      </div>
    );
  } else {
    list = (
      <div className="ws-list">
        {workspaces.map((w) => {
          const status = replicaStatus(w, startMsgs[w.name]);
          const label = w.slug || w.name;
          const isBusy = busy(w.name);
          return (
            <ResourceRow
              key={w.name}
              name={label}
              openable={w.ready}
              status={status}
              // "Unused for N days — deleted after D days unless opened" once the
              // manager's retention sweep has flagged the row; resuming clears it.
              subline={retentionNotice(w) || undefined}
              onDelete={() => setConfirmDelete(w)}
              quietActions={
                w.replicas > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className={atLimit ? "" : "ws-quiet"}
                    disabled={isBusy}
                    title="Pause now (idle workspaces pause themselves)"
                    onClick={() => withBusy(w.name, () => stopWorkspace(w.name), "Could not pause workspace")}
                  >
                    <Icon icon={faPause} />
                    Pause
                  </Button>
                )
              }
              actions={
                w.ready ? (
                  <a
                    href={w.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass("primary", "md", "ws-open")}
                  >
                    Open
                    <Icon icon={faArrowUpRightFromSquare} />
                  </a>
                ) : (
                  <Button
                    disabled={isBusy || status.spinner}
                    onClick={() => withBusy(w.name, () => startWorkspace(w.name), "Could not resume workspace")}
                  >
                    {status.spinner ? <Spinner /> : <Icon icon={faPlay} />}
                    {status.spinner ? "Starting…" : "Resume"}
                  </Button>
                )
              }
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="ws-page">
      <header className="ws-head">
        <h1>Your workspaces</h1>
        <p className="muted">Browser-based development environments. Each one has its own disk, editor and database.</p>
      </header>

      <section className="ws-create" aria-label="New workspace">
        <form noValidate onSubmit={onCreate} className="ws-create-row">
          <Input
            label="Workspace name"
            hideLabel
            className="ws-create-input"
            placeholder="Name it, e.g. chess-arena"
            value={name}
            onChange={(e) => setName(e.target.value)}
            invalid={showFormError}
            aria-describedby={showFormError ? "ws-create-error" : undefined}
          />
          <Button type="submit" variant="primary" disabled={creating || atLimit}>
            {creating ? <Spinner /> : <Icon icon={faPlus} />}
            Create
          </Button>
        </form>
        {showFormError && (
          <p id="ws-create-error" className="ws-create-note ws-line-warn">
            {formError}
          </p>
        )}
        {atLimit && <p className="ws-create-note muted">Active limit reached. Pause a workspace first.</p>}
      </section>

      {banner && (
        <div aria-live="polite">
          <Message tone={banner.tone} title={banner.header} onClose={() => setBanner(null)}>
            {banner.body}
          </Message>
        </div>
      )}

      {list}

      <DeleteModal
        name={confirmDelete && (confirmDelete.slug || confirmDelete.name)}
        body="All files and data in this workspace are permanently deleted. This cannot be undone."
        confirmLabel="Delete workspace"
        deleting={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const w = confirmDelete!;
          setDeleting(true);
          try {
            await deleteWorkspace(w.name);
            setConfirmDelete(null);
            setBanner(null); // the row disappearing is the feedback
          } catch (e) {
            setBanner({ tone: "error", header: "Could not delete workspace", body: (e as Error).message });
            setConfirmDelete(null);
          } finally {
            setDeleting(false);
            reload();
          }
        }}
      />
    </div>
  );
}
