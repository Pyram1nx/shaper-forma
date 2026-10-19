All files reviewed. Here is the audit.

---

# Interaction & Robustness Audit — Canvas / App / Chrome / Panels / Popovers

## Major

### M1. Locked ("reference") shapes can never be selected again — permanent dead-end
**`src/editor/Canvas.tsx:142`** (hitTest skips locked), **`Canvas.tsx:388`** (marquee skips locked), **`src/App.tsx:49`** (⌘A excludes locked), **`src/editor/Panels.tsx:172`** (locking clears the selection).

Locking a shape clears the selection, and after that no interaction can ever re-select it: hit-test, marquee and select-all all skip `locked`. The only unlock control (`reference-btn`, Panels.tsx:166-176) renders only when the selection is non-empty, so the only escape is Undo.

**How a user hits it:** click a shape → "reference path" button → click empty canvas to deselect → shape is unreachable forever (except by undoing).

**Fix:** let locked shapes be *selectable but not draggable*. In `hitTest` (Canvas.tsx:142) stop skipping locked shapes; in `onPointerDown` (Canvas.tsx:244-249) select as usual but skip creating the `move` drag (and in `startScale`, skip locked shapes in `orig`); keep marquee excluding them. Alternatively, minimally: include locked shapes in ⌘A.

### M2. Scaling a zero-width or zero-height selection produces astronomical scale factors (geometry corruption)
**`src/editor/Canvas.tsx:346-347`**

```ts
let fx = ... : (p.x - anchor.x) / (ref.x - anchor.x || 1e-9)
```

If the selection bbox is degenerate (e.g. a straight vertical line drawn with the draw tool: `ref.x === anchor.x`), the divisor becomes `1e-9` instead of the factor being neutralised. Dragging a corner handle then yields `fx ≈ 10⁹–10¹⁰`; only a *lower* clamp exists (`Math.abs(fx) < 1e-3`, lines 354-355). The shape's `sx` explodes, the geometry blows up to kilometres, and the doc is corrupted (recoverable only by undo).

**How a user hits it:** draw a horizontal line, select it, drag the `tm`/`bm` handle (or a vertical line + corner handle). One pixel of pointer movement → `fy ≈ (p.y − anchor.y) × 10⁹`.

**Fix:** guard the *factor*, not the divisor:
```ts
const dx = ref.x - anchor.x, dy = ref.y - anchor.y
let fx = handle === 'tm' || handle === 'bm' ? 1 : dx === 0 ? 1 : (p.x - anchor.x) / dx
let fy = handle === 'lm' || handle === 'rm' ? 1 : dy === 0 ? 1 : (p.y - anchor.y) / dy
```
(`ops.ts:48-49` already does this correctly for the panel resize path — mirror it.)

### M3. Mouse-wheel heuristic misfires on fast trackpad scrolls — panning suddenly zooms
**`src/editor/Canvas.tsx:161`**

```ts
const isMouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY))
```

Fast two-finger scrolls on macOS/Windows trackpads frequently produce `deltaY` values that are integers ≥ 40 (e.g. 42, 57) with `deltaX === 0` during a vertical flick, and momentum tail events too. Those get classified as a mouse wheel → the canvas **zooms in the middle of what the user intended as a pan**. This will feel randomly broken to every trackpad user.

**Fix:** harden the check — real wheel notches are exact multiples of 120 in `wheelDeltaY` (Chromium/Safari expose it; Firefox uses `deltaMode === 1`, already covered):

```ts
const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
const isMouseWheel =
  e.deltaMode === 1 ||
  (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY) &&
    (wd === undefined || wd % 120 === 0))
```

### M4. Touch: no pan, no pinch-zoom, and two-finger contact produces fighting drags
**`src/editor/Canvas.tsx:204-254`**, with `touch-action: none` (`src/styles/app.css:43`).

There is no multi-pointer handling at all. On a touchscreen: the second finger's `pointerdown` silently **overwrites** `dragRef` (e.g. a shape-move becomes a pan, or a second marquee), and both pointers' `pointermove` streams drive the same drag — the view/selection jumps wildly. Since Space doesn't exist and middle-mouse doesn't exist on touch, and two-finger gestures are the broken case above, **touch users have no way to pan or zoom the canvas at all**.

**How a user hits it:** open on an iPad/touch laptop; try to pinch or scroll.

**Fix (minimum):** in `onPointerDown`, ignore additional pointers while one is active: `if (dragRef.current) return`. **Fix (proper):** track active pointers in a `Map<pointerId, Pt>`; when a second pointer lands, cancel the current drag and switch to a pinch gesture — `zoomBy(dist/lastDist, centre)` plus pan by centre delta; on `pointerup`/`pointercancel` drop back to single-pointer mode.

### M5. No `pointercancel` handling — drags get stuck
**`src/editor/Canvas.tsx:562-575`** (only `onPointerDown/Move/Up/Leave` are bound).

Touch interruption (palm rejection, incoming gesture, OS takeover) fires `pointercancel`, never `pointerup`. `dragRef` stays set: a frozen marquee/pan/scale remains on screen, the cursor stays `grabbing`, and the next interaction behaves oddly until a fresh `pointerdown` overwrites the state.

**Fix:** add `onPointerCancel={onPointerUp}` to the `<svg>` (the handler is already safe for a null/unchanged `dragRef`).

## Minor

### m1. Arrow-nudge and NumField arrow-stepping flood undo history
**`src/App.tsx:59-62`**, **`src/editor/Panels.tsx:67-73`**, **`src/state/store.ts:116-119`**

Every nudge keypress (including OS auto-repeat at ~30/s) calls `updateShapes` → `checkpoint()`. Holding an arrow key for ~3 seconds generates 100 checkpoints, and `store.ts:118` (`past.slice(-HISTORY_LIMIT + 1)`) then evicts *older* history — the user can no longer undo back past the nudge burst, and ⌘Z becomes 100 presses of 0.06 mm steps. Same for holding ↑/↓ in a NumField (rotation, W/H, depth).

**Fix:** checkpoint once per burst: in the nudge handler use `if (!e.repeat) st.checkpoint()` then `st.patchShapes(...)` for repeats. In NumField, pass `e.repeat` info through `onCommit(v, e.repeat)` and skip `checkpoint()` on repeats (patch only).

### m2. Draw-tool keyboard handler ignores dialogs/popovers/menu; Escape fires in parallel with App's handler
**`src/editor/Canvas.tsx:91-108`** vs **`src/App.tsx:22-25, 54-58`**

Canvas's window `keydown` has no `st.dialog / st.popover / st.menuOpen` guard. With the Shortcuts (or 3D Carve) dialog open and the draw tool active, Enter/Escape/Backspace invisibly commit/pop the draft (target is `<body>`, so the input guard doesn't help). And when a popover is open in draw mode, **one** Escape both closes the popover (App) *and* commits the draft (Canvas) — two unrelated effects from one keypress, conflicting with App's defined priority order.

**Fix:** at the top of the draw-key block (after the Space handling): `if (useStore.getState().dialog || useStore.getState().popover || useStore.getState().menuOpen) return`.

### m3. Ctrl/⌘ + mouse wheel zoom is far too aggressive
**`src/editor/Canvas.tsx:163`** — with `ctrlKey` the factor is `exp(-deltaY · 0.01)`. A real mouse wheel notch sends `deltaY = ±100` (±120 in Firefox), i.e. ×0.37 or ×2.7 **per notch**. Trackpad pinch sends small deltas so it feels fine, but a Windows/Linux user holding Ctrl and rolling the wheel gets violent, unusable zoom steps.

**Fix:** clamp the per-event delta and use a milder ctrl coefficient, e.g. `const f = Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * (e.ctrlKey ? 0.005 : 0.0025) * (e.deltaMode === 1 ? 30 : 1))` → ≈ ×0.78/×1.28 per notch.

### m4. Grabbing a scale handle creates an undo checkpoint even with no movement
**`src/editor/Canvas.tsx:268`** — `st.checkpoint()` runs in `startScale`, unlike `move` which defers until a 3 px threshold (line 301). Clicking a handle without dragging (or a sub-pixel jitter) leaves an empty undo step; ⌘Z then appears to "do nothing".

**Fix:** move `st.checkpoint()` into the first `onPointerMove` of the scale case, guarded by the same `if (!d.moved)` pattern used for `move` (checkpoint before applying the first real transform).

### m5. Space key: stuck pan state on window blur, and it swallows button activation
**`src/editor/Canvas.tsx:91-114`**

1. Press-and-hold Space, then ⌘-Tab away / window loses focus → `keyup` never fires → `spaceDown` stays `true`; every subsequent canvas drag pans until Space is pressed again. **Fix:** `window.addEventListener('blur', () => setSpaceDown(false))` in the same effect.
2. `e.preventDefault()` on Space keydown (line 96) applies whenever focus is anywhere outside an input — including on a focused `<button>`. Per spec, cancelling keydown cancels the button's activation, so keyboard users (Tab navigation) cannot activate buttons with Space. **Fix:** skip the Space branch when `(e.target as HTMLElement).closest('button')` exists (or only `preventDefault` when `document.activeElement === document.body`).

### m6. Middle-click pan fights browser autoscroll
**`src/editor/Canvas.tsx:210`** — middle-button down starts a pan but doesn't prevent default, so Chromium on Windows/Linux also starts autoscroll (the pointerdown is not cancelled, so the compatibility `mousedown` fires).

**Fix:** `if (e.button === 1) e.preventDefault()` before starting the pan drag.

### m7. Anchor picker has no outside-click close
**`src/editor/Panels.tsx:90-119`** — `open` is local state; clicking the canvas, another panel, or pressing Escape leaves the 3×3 `anchor-pop` floating. It only closes on pick or re-toggling the button (and unrelated store updates can leave it stale-positioned).

**Fix:** add a `useEffect` while `open` that listens for `pointerdown` on `window` and closes when `!e.target.closest('.anchor-row')` (and Escape → close).

### m8. Popovers don't close when clicking panels / chrome (only the canvas closes them)
**`src/editor/Canvas.tsx:206`** is the only outside-click close, and it only covers clicks that reach the `<svg>`. The settings popover (**`src/editor/Chrome.tsx:172, 198`**), Shapes and ShapeShifter popovers (**`src/editor/Popovers.tsx:39, 78`**) stay open when the user clicks the right dock, action bar, or another chrome button that doesn't toggle them. The app then has two floating panels competing for attention.

**Fix:** a small `usePopoverOutsideClose` hook: `window.addEventListener('pointerdown', h, {capture:true})` closing the popover when `!e.target.closest('.settings-pop, .shape-creator, .shapeshifter, …trigger')`, mounted while a popover is open. (Canvas.tsx:206 can then go away.)

### m9. Rotation field is misleading for multi-selection
**`src/editor/Panels.tsx:209-218`** — for `sel.length > 1` the field displays `0`; typing 45 then rotates *by* 45° (delta), not *to* 45°. Users read "0", type the displayed angle they want, and get a surprise rotation.

**Fix:** render `value={single ? single.rotation : null}` with `placeholder="mixed"` (NumField already supports `null` + placeholder, see the depth field at Panels.tsx:339), keeping the delta behaviour for multi.

### m10. Position X/Y fields ignore the chosen anchor
**`src/editor/Panels.tsx:162, 221-224`** — `pos` is hard-coded to `anchorPoint(b, 'tl')` and `moveSelectionTo` aligns `b.minX/minY` (ops.ts:85-86), while the AnchorPicker above it governs resize/rotation. Setting anchor to "centre" and typing X moves the selection's *top-left* to X, not its centre. If the anchor picker is meant to be global (as in Studio), position must follow it.

**Fix:** `const pos = anchorPoint(b, anchor)` and have `moveSelectionTo` compute `dx = x − anchorPoint(b, anchor).x`.

### m11. `zoomToFit` can produce a negative zoom on small viewports
**`src/state/store.ts:255`** — `Math.min((viewport.w - pad*2)/w, (viewport.h - pad*2)/h, 400)` with `pad = 160`: if the viewport is narrower than 320 px (small iframe, split-screen, phone), the zoom goes negative → the world renders mirrored/flipped.

**Fix:** `const zoom = Math.max(0.05, Math.min((viewport.w - pad*2)/w, (viewport.h - pad*2)/h, 400))`.

### m12. Hover hit-testing cost and re-render scale with 1000+ shapes on every mousemove/drag frame
**`src/editor/Canvas.tsx:275-287, 409-451`** — every `pointermove` runs `hitTest` over all visible shapes, and every doc patch during a move/scale drag rebuilds and re-diffs the full `shapeEls` array (1000 `<path>` elements ≈ measurable ms per frame at 120 Hz pointer rates). Mostly OK today, but it's the first thing that will jank.

**Fix:** extract a `const ShapeEl = React.memo(...)` keyed on `(shape, selected, hovered, mode)` so static shapes skip re-diffing during drags; optionally throttle hover hit-testing to animation frames.

### m13. Stacked action-bar buttons are unusable on touch
**`src/editor/Chrome.tsx:273-297`** — the second action (`stacked__alt`) is only revealed via `onMouseEnter`. On touch there is no hover, so Mirror-V / Duplicate-in-place / Send-to-Back are unreachable.

**Fix:** on the first `onClick` when not yet opened (or on `pointerdown` with `pointerType === 'touch'`), open the stack instead of firing; fire the action on the second tap. Simplest: `onPointerDown={(e) => { if (e.pointerType !== 'mouse' && !open) { setOpen(true); return } }}` and guard `a.onClick` accordingly.

### m14. `beforeunload` may not prompt in all browsers
**`src/App.tsx:87-90`** — only `e.preventDefault()` is called. The spec's canonical signal is `e.returnValue = ''`, which some engines (older Chromium, some Safari versions) still require.

**Fix:** `e.preventDefault(); e.returnValue = ''`.

## Nit

### n1. Double-click finish relies on `PointerEvent.detail`
**`src/editor/Canvas.tsx:226`** — `e.detail >= 2` on `pointerdown` is populated by Chromium/Firefox, but WebKit has historically left `detail` at 0 for pointer events (click count lives in `clickCount`). If it's 0, double-click-to-finish silently never works on that browser. **Fix:** track it manually (`perf = now − lastDownTime`, distance < 5 px ⇒ finish) or also listen for `dblclick` while `tool === 'draw' && draft.length >= 2`.

### n2. Double-invoked move/up handlers during handle drags
**`src/editor/Canvas.tsx:467`** attaches `onPointerMove`/`onPointerUp` to each handle `<g>` *and* the same handlers sit on the `<svg>` (lines 568-569); captured events bubble through both → every scale event is processed twice. It's idempotent today, but it doubles per-frame work and will break if a handler ever becomes non-idempotent. **Fix:** delete the handlers from the handle `<g>` (capture keeps events flowing to the svg).

### n3. `style={{ order }}` in review mode is a no-op
**`src/editor/Canvas.tsx:447`** — `order` only applies in flex/grid containers; the parent is an SVG `<g>`. The preceding `.sort()` (line 408) already does the work. **Fix:** drop the style.

### n4. Review-mode hit-test ignores review z-order
**`src/editor/Canvas.tsx:140`** vs **`:408`** — review draws sorted by depth (deeper on top), but `hitTest` walks doc order, so the shape you click in review may not be the one that gets selected (selection is invisible in review, so it only bites via the zoom-to-selection button). **Fix:** iterate `ordered` instead of `visible` in review mode, or disable hit-testing in review.

### n5. Shift-constrained move can be defeated by smart snapping
**`src/editor/Canvas.tsx:302-335`** — the shift axis-lock is applied first, then snapping adds `best.v` to the locked axis, drifting the move off the constraint. **Fix:** when `e.shiftKey`, skip the snap block (Shift means "exact").

### n6. Global single-letter shortcuts fire while the app menu is open
**`src/App.tsx:63-69`** — with the menu open (focus on body), `p`, `f`, `1/2/3`, arrows, Delete all act "behind" the menu, and Escape closes the menu *and* runs the next branch's effect in the same keystroke via the Canvas handler. **Fix:** early-return in `useKeyboard` when `st.menuOpen` (Escape is already handled above it — keep just that branch).

### n7. App-menu rename input: Escape does nothing
**`src/editor/AppMenu.tsx:48-57`** — Enter blurs/commits, but Escape leaves the input open with no revert. **Fix:** `onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = doc.name; e.currentTarget.blur() } }}` (mirrors TopLeft.tsx:36-42).

### n8. NumField commits a rounded value on blur
**`src/editor/Panels.tsx:27-45`** — the field shows `toFixed(3)`/`toFixed(2)`; if the underlying value has more precision (e.g. imported 6.3499 mm shown as "6.35"), a bare blur (no edit) parses the rounded text and commits a slightly different value → a surprise undo step. **Fix:** in `commit`, if `text === fmt(value)` return early before parsing.

---

## Verified as correct

- **Pan:** Space-drag, middle-drag and right-drag all enter the pan branch; pan deltas are screen-space so mid-drag zoom can't distort it (Canvas.tsx:210-212, 291-293). Cursor switches `grab`/`grabbing` (line 560).
- **Pointer capture:** capture is taken on `pointerdown` (Canvas.tsx:207, 258), so pointerup outside the window still terminates move/scale/marquee/pan drags; the `dragRef` + state dual-write keeps `onPointerUp` in sync with the latest drag frame.
- **Draw tool:** click-to-add, close-click within 10 px after ≥ 3 points, Enter finishes open, Escape with < 2 points exits to select, Backspace pops points, live Shift 45° snap preview, draft cleared on tool change (Canvas.tsx:91-127, 174-201, 215-231, 544-558).
- **Move:** 3 px dead-zone before the checkpoint, so click-select never pollutes undo; Shift axis lock; smart-snap against other shapes' edges/centres plus world origin at 6 px with Alt bypass; guides rendered in screen space (Canvas.tsx:297-343).
- **Scale semantics:** corners proportional / Shift free / edge handles single-axis, matching the in-app shortcuts list (Popovers.tsx:192); min-factor clamp prevents zero/negative scale from small drags (Canvas.tsx:354-355, modulo M2); parametric shapes re-normalised to clean params on pointerup (Canvas.tsx:41-47, 396-398).
- **Marquee:** full-containment test, Shift-additive with dedup, sub-3 px drags treated as clicks, locked excluded (Canvas.tsx:378-394).
- **Zoom:** clamped 0.05–2000 px/mm with pointer-centred anchoring (store.ts:259-266); `zoomToFit` handles the empty document (origin-centred ~12 in view) and caps zoom (store.ts:243-258); trackpad two-finger pan and ctrl-pinch route correctly in the common case; `wheel` listener is non-passive so page zoom/scroll is suppressed over the canvas, with `overscroll-behavior: none` and `touch-action: none` backing it up.
- **Keyboard:** input/textarea/select/contenteditable guard in both global handlers; Enter commits / Escape reverts in NumField and rename inputs; arrows step ×10 with Shift; Delete is suppressed while drawing; `parseLength` handles `3/8`, `1 1/2`, `mm`/`in`/`cm` suffixes and arithmetic via a character-whitelisted eval (no letters possible — no injection surface) (App.tsx:22-73, ops.ts:172-204).
- **Selection/undo:** undo/redo filter the selection to surviving ids; history capped at 100 (store.ts:120-133); `setDoc` (open/recent/new) resets history, selection, mode and tool.
- **Escape priority for non-draw tools** (menu → popover → dialog → deselect) is ordered sensibly (App.tsx:54-58); ShortcutsDialog closes on backdrop click and Escape (Popovers.tsx:167-196); popovers are torn down on mode/tool switches at the store level (store.ts:239-240, 267-269).
- **Perf hygiene where it counts:** world geometry, bbox, path-`d` and cut geometry are all WeakMap-cached per immutable shape (geomCache.ts), so dragging N shapes only recomputes the moved subset; autosave is debounced at 600 ms and flushed on unload (App.tsx:76-97).

The two I'd fix first: **M1** (locked shapes become unreachable — real data dead-end) and **M2** (one drag on a degenerate selection corrupts geometry).
