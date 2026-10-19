import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../state/store'
import * as Ic from '../ui/icons'
import { BASIC_SHAPES, createBasic, createTemplate, type BasicShape } from './shapeFactory'
import { TEMPLATES } from '../geometry/templates'
import { TemplateIcon } from '../geometry/templateIcons'
import { MM_PER_IN } from '../model/types'

const basicIcon: Record<BasicShape, ReactNode> = {
  circle: <circle cx="12" cy="12" r="7" />,
  ellipse: <ellipse cx="12" cy="12" rx="8" ry="5" />,
  rect: <rect x="5.5" y="5.5" width="13" height="13" />,
  roundrect: <rect x="5.5" y="5.5" width="13" height="13" rx="3.5" />,
  polygon: <path d="M12 4.5 19.5 10l-2.9 8.5H7.4L4.5 10Z" />,
  triangle: <path d="M12 5.5 19 18.5H5Z" />,
}

function viewCentre() {
  const { view, viewport } = useStore.getState()
  return { x: (viewport.w / 2 - view.panX) / view.zoom, y: (viewport.h / 2 - view.panY) / view.zoom }
}

const dismissPopover = () => useStore.getState().setPopover(null)

/** Close a popover on a pointer-down outside it. Clicks on chrome that toggles or changes
 *  state itself (hover buttons, the mode tabs) are left to those controls. */
function useOutsideDismiss(active: boolean, inside: string) {
  useEffect(() => {
    if (!active) return
    const down = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(inside)) dismissPopover()
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [active, inside])
}

const SHAPE_INSIDE = '.shape-creator, .hover-btn, .mode-switcher, .settings-pop'

export function ShapesPopover() {
  const popover = useStore((s) => s.popover)
  const mode = useStore((s) => s.mode)
  const [query, setQuery] = useState('')
  useOutsideDismiss(popover === 'shapes' && mode === 'design', SHAPE_INSIDE)
  if (popover !== 'shapes' || mode !== 'design') return null
  const st = useStore.getState
  const place = (s: ReturnType<typeof createBasic> | null) => {
    if (!s) return
    st().addShapes([s])
    // Zoom so a fresh 1" shape is comfortably visible, like Studio does.
    const { view, viewport } = st()
    if (s.contours.length && view.zoom * MM_PER_IN < Math.min(viewport.w, viewport.h) / 8) st().zoomToFit()
  }
  // The search filters basic shapes (by label) and templates (by name).
  const q = query.trim().toLowerCase()
  const basics = q ? BASIC_SHAPES.filter((b) => b.label.toLowerCase().includes(q)) : BASIC_SHAPES
  const templates = q ? TEMPLATES.filter((t) => t.name.toLowerCase().includes(q)) : TEMPLATES
  return (
    <div className="shape-creator" role="dialog" aria-label="Make shape">
      <input
        id="shape-search"
        // Focus immediately so typing right after Find Art / Make Shape filters.
        autoFocus
        type="search"
        className="shape-creator__search"
        placeholder="Search shapes & templates"
        aria-label="Search shapes & templates"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {basics.length > 0 && (
        <>
          <div className="shape-creator__label">shapes</div>
          <div className="shape-creator__basic">
            {basics.map((b) => (
              <button key={b.id} className="basic-shape-btn" title={b.label} aria-label={b.label} onClick={() => place(createBasic(b.id, viewCentre().x, viewCentre().y))}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                  {basicIcon[b.id]}
                </svg>
              </button>
            ))}
          </div>
        </>
      )}
      {templates.length > 0 && (
        <>
          <div className="shape-creator__label">
            templates <span className="ss-badge ss-badge--new">new</span>
          </div>
          <div className="shape-creator__templates">
            {templates.map((t) => (
              <button key={t.id} className="template-btn" title={t.name} aria-label={t.name} onClick={() => place(createTemplate(t.id, viewCentre().x, viewCentre().y))}>
                <TemplateIcon id={t.id} size={36} />
              </button>
            ))}
          </div>
        </>
      )}
      {!basics.length && !templates.length && <div className="ss-muted shape-creator__none">No shapes or templates match “{query.trim()}”.</div>}
      <button className="shape-creator__close ss-btn-round" onClick={dismissPopover} aria-label="Close make shape">
        <Ic.IconClose />
      </button>
    </div>
  )
}

export function ShortcutsDialog() {
  const dialog = useStore((s) => s.dialog)
  useEffect(() => {
    if (dialog !== 'shortcuts') return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && useStore.getState().openDialog(null)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [dialog])
  if (dialog !== 'shortcuts') return null
  const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'
  // Only shortcuts that are implemented. "(Design)" marks ones that only work in Design mode.
  const rows: [string, string][] = [
    [`${mod} S`, 'Save to computer'],
    [`${mod} ⇧ S`, 'Save as…'],
    [`${mod} O`, 'Open from computer'],
    [`${mod} E`, 'Export SVG'],
    [`${mod} ⇧ E`, 'Export selection as SVG'],
    [`${mod} Z / ${mod} ⇧ Z / ${mod} Y`, 'Undo / Redo'],
    [`${mod} D`, 'Duplicate'],
    [`${mod} A`, 'Select all'],
    [`${mod} +  /  ${mod} −`, 'Zoom in / out'],
    [`${mod} 0`, 'Zoom to fit'],
    ['F', 'Zoom to fit'],
    ['Delete', 'Delete selection (Design)'],
    ['Arrows', 'Nudge (⇧ ×10) (Design)'],
    ['↑ / ↓ in a field', 'Step the value'],
    ['Space + drag', 'Pan (also middle or right drag)'],
    ['Pinch / ⌘ scroll', 'Zoom'],
    ['P', 'Draw tool'],
    ['Enter / Backspace / Esc', 'Finish / remove last point / cancel while drawing'],
    ['1 / 2 / 3', 'Design / Plan / Review'],
    ['Alt + click', 'Select whole group'],
    ['Shift', 'Snap angle / free scale / add to selection'],
    ['Alt + drag', 'Move without smart alignment'],
  ]
  return (
    <div className="modal-backdrop" onPointerDown={() => useStore.getState().openDialog(null)}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-card__head">
          <Ic.IconKeyboard /> Keyboard Shortcuts
          <button className="ss-btn-round" onClick={() => useStore.getState().openDialog(null)} aria-label="Close keyboard shortcuts">
            <Ic.IconClose />
          </button>
        </div>
        <div className="shortcut-list">
          {rows.map(([k, v]) => (
            <div key={k} className="shortcut-list__row">
              <kbd>{k}</kbd>
              <span>{v}</span>
            </div>
          ))}
        </div>
        <div className="ss-muted" style={{ marginTop: 12 }}>
          Shaper forma runs entirely in your browser. Designs autosave locally; use Save to keep a <code>.shaperstudio</code> file on your computer and Export SVG to
          send it to Shaper Origin.
        </div>
      </div>
    </div>
  )
}
