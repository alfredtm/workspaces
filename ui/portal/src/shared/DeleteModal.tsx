// "Delete <name>?" — the confirm dialog for destructive actions. Cancel comes
// first and takes focus, so a stray Enter never deletes anything.
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";

export default function DeleteModal({
  name,
  body,
  confirmLabel,
  deleting,
  onCancel,
  onConfirm,
}: {
  /** Display name of the resource, or null when the modal is closed. */
  name: string | null;
  /** What exactly is lost. */
  body: ReactNode;
  /** e.g. "Delete workspace". */
  confirmLabel: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={name !== null} onClose={onCancel} title={`Delete ${name ?? ""}?`}>
      <p className="ui-modal-body">{body}</p>
      <div className="ui-modal-actions">
        <Button variant="secondary" onClick={onCancel} autoFocus>
          Cancel
        </Button>
        <Button variant="danger" disabled={deleting} onClick={onConfirm}>
          {deleting ? <Spinner /> : <Icon icon={faTrash} />}
          {deleting ? "Deleting…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
