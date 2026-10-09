// A modal built on the native <dialog>: showModal() makes the rest of the page
// inert (a real focus trap), moves focus into the dialog, and Esc fires
// `cancel`, which we route to onClose. A click on the backdrop closes too.
import { useEffect, useId, useRef, type ReactNode } from "react";

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const previous = document.activeElement as HTMLElement | null;
      dialog.showModal();
      return () => {
        if (dialog.open) dialog.close();
        previous?.focus?.();
      };
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="ui-modal"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault(); // Esc: let React state decide, so open and DOM never disagree
        onCloseRef.current();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current(); // backdrop
      }}
    >
      {open && (
        <div className="ui-modal-content">
          <h2 id={titleId} className="ui-modal-title">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
