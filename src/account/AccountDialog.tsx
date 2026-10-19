import { useStore } from '../state/store'
import * as Ic from '../ui/icons'
import AccountPanel from './AccountPanel'

/** Sign in or create an account with email and password. Opened from the app menu. */
export default function AccountDialog() {
  const open = useStore((s) => s.dialog === 'account')
  const close = () => useStore.getState().openDialog(null)

  if (!open) return null

  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Account" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-card__head">
          <Ic.IconUser /> Account
          <button className="ss-btn-round" onClick={close} aria-label="Close account">
            <Ic.IconClose />
          </button>
        </div>
        <AccountPanel />
      </div>
    </div>
  )
}
