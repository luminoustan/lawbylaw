/**
 * messages/NoticeRow.tsx — a session-scoped notice (context compression, …).
 *
 * Split out of `components/messages.tsx`; behaviour is unchanged.
 */

import type { ChatNotice } from "../../store/session"
import { AlertIcon } from "../icons"

export function NoticeRow(props: { notice: ChatNotice }) {
  return (
    <div class="dsm-notice" role="status">
      <AlertIcon size={13} />
      {props.notice.text}
    </div>
  )
}
