import { faCircleCheck, faCircleExclamation, faCircleInfo, faXmark } from "@fortawesome/free-solid-svg-icons";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export type MessageTone = "info" | "success" | "error";

const TONE_ICON = { info: faCircleInfo, success: faCircleCheck, error: faCircleExclamation };

/** An inline notice: icon, bold title, optional body, optional dismiss button. */
export function Message({
  tone = "info",
  title,
  children,
  onClose,
}: {
  tone?: MessageTone;
  title: string;
  children?: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className={`ui-message ui-message-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon icon={TONE_ICON[tone]} className="ui-message-icon" />
      <div className="ui-message-text">
        <p className="ui-message-title">{title}</p>
        {children && <div className="ui-message-body">{children}</div>}
      </div>
      {onClose && (
        <button type="button" className="ui-message-close" aria-label="Dismiss" onClick={onClose}>
          <Icon icon={faXmark} />
        </button>
      )}
    </div>
  );
}
