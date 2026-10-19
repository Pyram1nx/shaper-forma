# Audit — Plan mode cut types

## What the user currently sees (behaviour matrix)

Plan mode (all types, per selection state):

| Cut type | Unselected | Hovered | Selected |
|---|---|---|---|
| online | white 1px contour + faint 4% fill (`pl-base`) — identical to outside/inside | + dashed white tool-centre line — identical to outside/inside | + translucent green tool band + dashed centre line |
| outside | identical to online/inside (no band, no fill difference) | identical to online/inside | + green band (outside the line) — distinguishable only by band position |
| inside | identical to online/outside | identical to online/outside | + green band (inside the line) — distinguishable only by band position |
| pocket | **plus** 18% white fill over the cleared area (`pl-pocket`) — distinguishable | same pocket fill + dashed centre | pocket fill turns 35% green; no band |
| guide | dashed blue contour (`pl-base.is-guide`), no fill — distinguishable | dashed blue only (no centre line) | solid green 3px overlay **covers the dash**; no band/centre |

Review mode: every non-guide type renders identically — the swept band (pocket: cleared area) filled with a depth-shaded gray. No hover or selection feedback at all (clicking still updates `selection` state invisibly). Guide shapes are hidden. Types are only distinguishable by band geometry, not styling.

---

## Findings

### Major

**M1 — Cut Type dropdown is completely invisible (clipped by the panel)**
`src/styles/app.css:526` + `src/styles/app.css:714`
`.right-dock .ss-panel` sets `overflow-y: auto`, which computes `overflow-x` to `auto` too, clipping descendants to the panel's padding box. `.cut-type-menu` is positioned at `right: calc(100% + 30px)` relative to `.cut-type-select`, putting its right edge 30px left of the select, i.e. ~14px outside the panel's border box — fully outside the clip region, and leftward overflow can't even be scrolled to in LTR.
*Hit:* Switch to Plan, select a shape, click the Cut Type button → nothing appears; you can't change cut type at all.
*Fix:* Give `.plan-panel` (or `.right-dock .ss-panel`) `overflow: visible`, or render the menu in a portal / move it outside the scroller. If scroll is needed for tall panels, position the menu with `position: fixed` coordinates computed on open.

**M2 — Offset on open paths: negative offset deletes the toolpath, positive offset produces a double-loop centre line**
`src/editor/geomCache.ts:63` + `src/geometry/offset.ts:45`
`offsetContours` only adds open contours when `delta > 0`, and Clipper's `ClipperOffset` on open paths returns the closed outline of a stroke of width `2·delta` centred on the line (verified in clipper-lib `DoOffset`: it traces +delta, caps, negates normals, traces −delta) — not a line shifted to one side. So in the `online` case:
- `offset < 0`: open contours are silently dropped → for an all-open shape (which `geomCache.ts:53` forces to `online`) `centre` and `band` are empty → the toolpath vanishes from Plan **and** Review; only the base outline remains.
- `offset > 0`: the dashed "tool centre" path (`pl-centre`) renders as a closed double-loop tracing both edges of a 2·offset-wide stadium, instead of a single line shifted sideways. (The band is coincidentally correct.)

*Hit:* Draw an open path, select it in Plan, type offset 2, then press the flip button (or type −2) → the toolpath disappears. Type +2 → the centre line looks like a loop.
*Fix:* In `cutGeometry`'s `online` case, offset open contours by shifting each vertex along its segment normal by `off` (with miter/round joins), and leave `offsetContours` for closed contours only. If `offsetContours` itself is changed to always include open paths (negative delta = other side, which Clipper handles), audit its other callers (Offset tool, carve3d) first, since they currently rely on open paths being dropped at negative delta.

**M3 — Unselected Plan shapes are indistinguishable between online / outside / inside**
`src/editor/Canvas.tsx:429-439`, `src/styles/app.css:147-156`
All three render the identical `.pl-base` (white 1px + 4% fill). Only pocket (extra `.pl-pocket` fill) and guide (dashed blue) differ. Real Studio differentiates unselected shapes per cut type with fills/colours (per the design brief), so a user scanning the canvas cannot see which shapes will be cut on-line vs inside vs outside without clicking each one — the primary information Plan mode exists to convey.
*Hit:* Import a mixed design, switch to Plan → all non-pocket, non-guide shapes look the same.
*Fix:* Add per-type classes on the `<g className="pl-shape">` (e.g. `is-online/is-inside/is-outside/is-pocket`) and style `.pl-base` per type — e.g. subtle fill/hatch for pocket (exists), a distinct tint or pre-drawn faint band (`g.bandD` at low alpha) for inside/outside, plain hairline for online — mirroring the selected-state vocabulary at lower opacity.

### Minor

**m1 — Mixed selection can assign inside/outside/pocket to open paths, which silently behave as online**
`src/editor/Panels.tsx:300-301` vs `src/editor/geomCache.ts:53` / `src/io/svgExport.ts:46`
The menu filters to online/guide only when *every* selected shape is all-open. With a mixed selection (one open path + one closed), all 5 types are offered; choosing `inside` stores that on the open shape, but geometry and export silently force `online`. The panel then permanently misreports the open shape's cut type.
*Fix:* Compute `hasOpen = sel.some((s) => s.contours.every((c) => !c.closed))` and disable (grey out, with a tooltip) inside/outside/pocket items in that case — or coerce open members to `online` in the store when applying, so panel, canvas and export agree.

**m2 — Hover shows no tool band, so hover looks identical across online/outside/inside**
`src/editor/Canvas.tsx:437`
Hover draws only the dashed centre line; `.pl-band` is gated on `selected` (line 435). Without the band width, an outside cut at offset 0 (centre line r from the edge) is barely distinguishable from an online cut on hover.
*Fix:* Draw `g.bandD` with a dimmer band class (e.g. `pl-band--hover`, ~0.2 alpha) when `hovered` too.

**m3 — Depth stepper: the − button *increases* depth from unset**
`src/editor/Panels.tsx:338`
`depth == null ? step : …` makes − behave exactly like + when depth is unset/mixed: it sets a positive first step. A user reading − as "decrease" is surprised; also every stepper press creates an undo checkpoint (acceptable, but note each key-repeat press is one entry).
*Fix:* From unset, make − a no-op (only + seeds the value); keep the existing `Math.max(0, depth − step) || null` wrap-to-unset behaviour.

**m4 — Depth can exceed the bit's flute length with no warning**
`src/editor/Panels.tsx:339-340` (commit `v > 0 ? v : null`, unbounded +/▲ stepping)
`BITS` (`src/features/carve3d/bits.ts:18,23-35`) carries `fluteLength`, but Plan mode never consults it. Real Studio warns/limits when depth exceeds flute length (multi-pass territory). A user can plan a 20 mm depth with a 1/8" bit (12.7 mm flute) and nothing flags it.
*Fix:* On commit/step, if depth > flute length of the best-matching bit in `BITS` (match by diameter), show a warning line in the panel (or clamp with notice). Full fix needs a per-shape bit id, but a diameter-based check closes the gap.

**m5 — Selected guide loses its dashed identity**
`src/editor/Canvas.tsx:587-592`
The selection layer draws solid green 3px `.pl-base-sel` over *all* selected shapes, including guides, hiding the `.pl-base.is-guide` dash. A selected guide is distinguishable from online only by the absent band/centre, not by its own styling.
*Fix:* Add a `is-guide` variant on the overlay (`.pl-base-sel.is-guide { stroke-dasharray: 4 3; }`) driven by the shape's cut type.

**m6 — Export drops the planned offset; `shaper:cutOffset` is not a convention the target understands**
`src/io/svgExport.ts:43,60` vs `docs/research/shaper-studio-design.md:72`
Export writes the *raw* contours plus a `shaper:cutOffset` attribute, while the research notes state the tool offset can't be relied on from the SVG and that real Studio generates explicit offset paths. The file's own header (svgExport.ts:4-6) concedes offsets "must be baked". Net: a user who plans an outside cut at +2 mm offset exports an SVG that Origin will cut at +0.
*Fix:* When `s.cut.offset !== 0` and the type is online/outside/inside, export the tool-centre path from `cutGeometry(s).centre` as the geometry (marked `online`, since outside/inside would make Origin re-apply its own offset); drop the non-documented `shaper:cutOffset` attribute. Pocket keeps the boundary (Origin generates its own clear-out).

### Nits

**n1 — Dead `order` style on review shapes.** `src/editor/Canvas.tsx:447` — `style={{ order }}` does nothing inside an SVG `<g>` (not a flex container); paint order comes solely from the array sort on line 408. Delete the style.

**n2 — Depth tooltip shown for selected guides.** `src/editor/Canvas.tsx:515-525` — the unset/depth pill renders next to a selected guide although guides have no depth (the panel hides it). Skip the overlay when every selected shape is a guide.

**n3 — "mixed" type shows the On-Line icon.** `src/editor/Panels.tsx:311` — `cur?.icon ?? <IconCutOnline …>` pairs the online icon with the "mixed" label. Use a neutral/blank icon for mixed.

**n4 — Cut-type menu never closes on outside click or selection change.** `src/editor/Panels.tsx:287,310` — `open` is local state; Canvas's outside-click handler clears `st.popover` but not this menu, so the (currently invisible, see M1) menu stays open with a stale `is-active` row across selection changes.

**n5 — Depth tooltip fixed 86px foreignObject.** `src/editor/Canvas.tsx:519` — `white-space: nowrap` values wider than 86px (e.g. `254.000`) spill toward the shape; at `x0 − 90` with a selection near the left viewport edge the pill is clipped by the SVG viewport.

**n6 — Type switches leave stale params.** `src/state/store.ts:182` + `src/io/svgExport.ts:58` — switching to `guide` keeps depth/offset/bitDia, so a guide can export `shaper:cutDepth`. Harmless for Origin but noisy; consider clearing inapplicable fields on type change or skipping depth/offset attrs for guides.

---

## Verified correct

- **Band side per type:** outside band spans `[off, 2r+off]` outward, inside `[off, 2r+off]` inward, online straddles the line, pocket clears the reachable area — offset sign matches the documented "positive = away from the material that stays" for all four (`types.ts:21`, `geomCache.ts:53-71`).
- **`strokeOutline` really is centred** for both open (`etOpenRound`) and closed (`etClosedLine`) contours — confirmed two-sided in the vendored clipper source; bands render correctly as annuli under `fillRule="evenodd"`.
- **Pocket with holes/islands:** even-odd normalize preserves islands; the cleared area leaves the `off` skin at both the outer wall and island walls; holes render as holes.
- **Open paths are forced to online/guide consistently** in geometry (`geomCache.ts:53`), the menu (`Panels.tsx:301`), and export (`svgExport.ts:46`).
- **SVG export colour convention** matches the documented Shaper mapping (black fill = outside, white fill + black stroke = inside, stroke-only = online, grey = pocket, blue = guide) and `shaper:cutType` values match the enum; depth/tool diameter written in mm; depth omitted when unset.
- **Depth stepper semantics:** + from unset steps to 1/16″ (0.5 mm); at the minimum step − wraps to *unset* (the 0 ≡ unset convention); typing 0/negative reverts to unset; unset/mixed render correctly in both the field placeholder and the canvas tooltip.
- **Review mode layering:** guides hidden; shapes drawn shallow→deep so deeper (darker) cuts overlay; band geometry reuses `cutGeometry`, so offsets are reflected.
- **Menu contents/order** match the real app (On Line, Guide, Inside, Pocket, Outside) and all cut-type icons exist; `cutGeometry`'s identity-keyed WeakMap cache is safe given immutable shape updates.
