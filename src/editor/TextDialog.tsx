import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import * as Ic from '../ui/icons'
import { DEFAULT_FONT, addCustomFont, fontNames, textToContours } from '../io/text'
import { uid } from '../model/ids'
import { DEFAULT_CUT, MM_PER_IN } from '../model/types'
import { pickFile } from '../io/projectFile'
import { NumField } from './Panels'

/** Default cap height: 1 in, or 25 mm in a millimetre document. */
const defaultHeight = (units: 'in' | 'mm') => (units === 'in' ? MM_PER_IN : 25)

/** Studio's full-screen "Edit Text" dialog. Text becomes cuttable outlines. */
export default function TextDialog() {
  const dialog = useStore((s) => s.dialog)
  const editingId = useStore((s) => s.editingTextId)
  const shapes = useStore((s) => s.doc.shapes)
  const units = useStore((s) => s.doc.units)
  const editing = editingId ? shapes.find((s) => s.id === editingId) : undefined
  const [text, setText] = useState('')
  const [font, setFont] = useState(DEFAULT_FONT)
  const [height, setHeight] = useState(defaultHeight(units))
  const [fonts, setFonts] = useState(fontNames())
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const open = dialog === 'text'

  useEffect(() => {
    if (!open) return
    setText(editing ? String(editing.params?.text ?? '') : '')
    setFont(editing ? String(editing.params?.font ?? DEFAULT_FONT) : DEFAULT_FONT)
    setHeight(editing && Number(editing.params?.height) > 0 ? Number(editing.params?.height) : defaultHeight(units))
    const t = setTimeout(() => ref.current?.focus(), 30)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Escape closes from anywhere in the dialog (the global shortcut handler is suppressed while a dialog is open).
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().openDialog(null)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open])

  if (!open) return null
  const st = useStore.getState
  const close = () => st().openDialog(null)

  const place = async () => {
    if (!text.trim()) return close()
    setBusy(true)
    try {
      const h = height > 0 ? height : defaultHeight(units)
      const contours = await textToContours(text, font, h)
      if (editing && !editing.locked) {
        st().updateShapes([editing.id], (s) => ({ ...s, contours, name: text.split('\n')[0].slice(0, 32), params: { ...s.params, text, font, height: h } }))
      } else {
        const { view, viewport } = st()
        st().addShapes([
          {
            id: uid(),
            name: text.split('\n')[0].slice(0, 32),
            kind: 'text',
            params: { text, font, height: h },
            contours,
            x: (viewport.w / 2 - view.panX) / view.zoom,
            y: (viewport.h / 2 - view.panY) / view.zoom,
            rotation: 0,
            sx: 1,
            sy: 1,
            cut: { ...DEFAULT_CUT },
          },
        ])
      }
      close()
    } catch (e) {
      st().showToast('Could not create text: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ss-dialog text-dialog" role="dialog" aria-modal="true" aria-label="Edit Text">
      <div className="ss-dialog__header">
        <Ic.IconText /> Edit Text
      </div>
      <div className="text-dialog__body">
        <textarea
          ref={ref}
          className="text-dialog__input"
          aria-label="Text"
          placeholder="Insert Text"
          value={text}
          rows={Math.max(1, text.split('\n').length)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) place()
          }}
          style={{ fontFamily: font === DEFAULT_FONT ? 'var(--font-ui)' : undefined }}
        />
        <div className="text-dialog__options">
          <div className="ss-field text-dialog__height" role="group" aria-label="Height">
            <span className="ss-label">cap height</span>
            <NumField label="Cap height" units={units} value={height} onCommit={(v) => setHeight(Math.max(v, 0.1))} />
          </div>
          <div className="text-dialog__font">
            <select className="ss-select" aria-label="Font" value={font} onChange={(e) => setFont(e.target.value)}>
              {fonts.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <button
              className="ss-btn ss-btn--sm"
              onClick={async () => {
                try {
                  const f = await pickFile('.ttf,.otf,.woff')
                  const name = await addCustomFont(f)
                  setFonts(fontNames())
                  setFont(name)
                } catch (e) {
                  if ((e as Error).message !== 'No file') st().showToast('Font could not be loaded')
                }
              }}
            >
              <Ic.IconUpload size={16} /> Upload Font
            </button>
          </div>
        </div>
      </div>
      <div className="ss-dialog__footer">
        <button className="ss-btn ss-btn--primary" disabled={busy} onClick={place}>
          {editing ? 'Update Text' : 'Place Text'}
        </button>
        <button className="ss-btn-round" onClick={close} aria-label="Cancel">
          <Ic.IconClose />
        </button>
      </div>
    </div>
  )
}
