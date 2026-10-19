All evidence gathered. Here is the second-round audit report.

# Design-Language & UI Chrome — Second-Round Audit

Ground truth: `docs/research/shaper-studio-design.md`; prior findings: `docs/reviews/design.md`. No files were modified.

## 1. Status of prior findings

### A. Deviations from the measured doc

| # | Finding | Status | Evidence |
|---|---|---|---|
| A1 | Selected design stroke 2.5px (doc: 3.5px) | **FIXED** | `src/styles/canvas.css:20` — `.cv-shape.is-selected { stroke-width: 3.5px }`, commented "measured in Studio" |
| A2 | Plan selected base stroke 3px (doc: 4px) | **REGRESSED** | `src/styles/canvas.css:129-132` — `.pl-shape.is-selected .pl-base { stroke: #1be09e; stroke-width: 2.5px }`. Was 3px, now 2.5px — *further* from the doc's 4px |
| A3 | Depth tooltip radius 4px (doc: "pill") | **NOT FIXED** | `src/styles/canvas.css:203` — `.cut-depth-tooltip { border-radius: 4px; height: 24px }`. Still a near-square tag; needs ~12px. (Arrow icon + bold 14px value are correct, `Canvas.tsx:670`) |
| A4 | Chevron only on Design tab | **FIXED** | `src/editor/Chrome.tsx:184` — `hasSettings = sel && m.id !== 'review'`; Plan tab now gets chevron + the plan settings popover (`Chrome.tsx:206`, plan rows at 277-283). Review exemption is documented in a comment |
| A5 | Export badge static "for Origin" | **FIXED** | `src/editor/AppMenu.tsx:46` computes `n of n` (selected/all), rendered at line 96; an extra "Export Selection" row with the selected count appears when a selection exists (line 98) |
| A6 | "Find Art" missing from rail | **FIXED** (with a new defect, see N1) | `src/editor/Chrome.tsx:128-130` — "Search shapes & templates" rail button in doc position, opens the Make Shape popover and focuses its search box |
| A7 | Menu sections diverge from doc | **NOT FIXED** (deliberate) | `src/editor/AppMenu.tsx:84-103,149-158` — still local-app entries; no Move / Share Design / Go-To items. Mitigation: an in-app footer now disclaims affiliation (lines 154-158), but neither the research doc nor the review record notes the substitution |
| A8 | Review shades cuts darker with depth (doc: "cut areas lighter") | **NOT FIXED** | Same direction, new mechanism: `src/editor/canvas/canvasMath.ts:55-59` maps depth→level 1-7; `src/styles/canvas.css:215-222` ramps `.rv-depth-1` rgb(155,161,176) → `.rv-depth-7` rgb(72,75,81) — deeper = darker on a light sheet |
| A9 | `ss-badge` blue; doc reserves snap red for badges | **FIXED** | `src/styles/components.css:393-396` — `.ss-badge--new { background: var(--snap-red) }`, used for "new" chips (`AppMenu.tsx:151-152`, `Popovers.tsx:72`); blue badge remains only for neutral info (file name `Carve3DDialog.tsx:309`, bit type `BitGallery.tsx:188`) as the review allowed |
| A10 | Mixed 32/35px control heights, untokenized | **NOT FIXED** | Still `.ss-input` 32 (`components.css:194`), `.ss-select` 35 (`components.css:227`), `.cut-type-select__btn` 35 (`app.css:543`), stepper/offset 32 (`app.css:617,653`); no `--control-h` tokens exist |

### B. Hard-coded colors

| # | Finding | Status | Evidence |
|---|---|---|---|
| B1 | `.cv-shape` stroke / `.pl-base.is-guide` stroke as literals | **NOT FIXED** (+ one regressed, see N2) | `canvas.css:5` — still `stroke: #56575d`. The plan-guide rule moved to `canvas.css:127` but the literal changed to `#2c9aff`, which matches *no* token (old value was `--blue-soft` #6b93ff) |
| B2 | Review colors raw literals | **NOT FIXED** (restructured) | Colors moved out of TSX into `canvas.css:215-231` classes — better placement, still literals, no `--review-*` tokens. New conflict: N3 |
| B3 | Canvas/WebGL blues re-hard-coded; `#9aa0ab` off-token | **NOT FIXED** | No `tokens.ts` exists. `PaperScanDialog.tsx:209` still `'#2c65ff'`; `Viewer3D.tsx:67,136,165,168,178,179` still `'#f6f7f9'`, `'#9aa0ab'` (still not a token), `'#2c65ff'` ×2, `'#8e929f'`, `'#1be09e'` |

### C. Internal consistency

| # | Finding | Status | Evidence |
|---|---|---|---|
| C1 | Three section-title styles | **NOT FIXED** | Carve3D uses `.ss-section-title` 14px/500 lowercase (`Carve3DDialog.tsx:347,400,480,508`, `BitGallery.tsx:152`), but Paper still uses `.pp-group__title` **12px/600** (`paper.css:218-223`) at `PaperScanDialog.tsx:883,918,993,1009,1031,1058,1098` |
| C2 | Paper sidebar double-padded via `ss-panel` | **FIXED** | `PaperScanDialog.tsx:879` — aside is `ss-dialog__side pp-side` only; both sides now 320px (`carve3d.css:3-5`, `paper.css:206-208`) |
| C3 | Paper labels ignore lowercase convention | **NOT FIXED** (half) | Range labels are now authored lowercase (`PaperScanDialog.tsx:1059-1075`), but `.pp-group__title` texts are Title Case ("Photo", "Paper size", "Detail"…) with no `text-transform` (`paper.css:218-223`), vs Carve3D's lowercase-transformed titles |
| C4 | Inline ✕/cube icons with stray stroke weights | **FIXED** (residue in N9/N10) | Carve3D now uses `IconCube` (`Carve3DDialog.tsx:299`) and `IconClose` (555); Paper uses `IconClose` (1136). Paper still inlines upload/scan/camera glyphs — nits below |
| C5 | `.ss-btn--primary` font-weight 400 | **FIXED** | `components.css:87-118` — `.ss-btn` is 500; no weight override on `--primary` |
| C6 | Duplicated checkbox-row style | **NOT FIXED** | `.check-row` (`app.css:763-773`, used `Popovers.tsx:175,180`) and `.c3d-check` (`carve3d.css:85-95`, used `Carve3DDialog.tsx:445,481,485,489`) both exist and have *silently diverged*: 13px/gray-800 vs 12px/gray-700 |
| C7 | Icon size drift per role | **NOT FIXED** (reduced) | Recenter/help/logo now 22 (`Chrome.tsx:178,445,30`) vs undo/rail 24; chevrons still mixed 16 (`Chrome.tsx:201`, `Panels.tsx:580`) vs 18 (`Panels.tsx:462`, `AppMenu.tsx:103,108`) |
| C8 | Weights outside 400/500 | **NOT FIXED** (half) | `.ss-badge` is now 500 (`components.css:388`), but `.pp-step__num` is still 600 (`paper.css:38`) |
| C9 | Dead CSS/tokens/icons | **NOT FIXED** (partly) | Fixed: `ui-round--sm` gone; `--blue-070`/`--blue-tint` now used (`components.css:318,342,386`, `app.css:913`); `IconEye/IconEyeOff/IconFolderOpen/IconSearch/IconMinus` all used. Still dead: `.pp-footer-note` (`paper.css:290-294`), `--hover-fill` (`tokens.css:39`), `--radius-xs`/`--radius-md` (`tokens.css:41,44`) |

### D. Icons

| # | Finding | Status | Evidence |
|---|---|---|---|
| D1 | `IconDraw` muddled / off-grid | **FIXED** | `icons.tsx:34-40` — redesigned as one bezier + two filled 2.25r end nodes; the pencil/strike-through sketch is gone and all geometry is on-grid |
| D2 | `IconHelp` dot nearly invisible | **FIXED** | `icons.tsx:96` — `<circle cx="12" cy="17.5" r="1.1" fill="currentColor" stroke="none" />` |

## 2. New problems introduced by the fix pass

**N1. minor — `src/editor/Chrome.tsx:128` and `:134` — two rail buttons drive the same popover, so both highlight together.**
Both "Search shapes & templates" and "Make Shape" use `active={popover === 'shapes'}` on the identical `'shapes'` popover. Repro: click *Make Shape* → both rail buttons turn blue simultaneously; clicking *Search* also never closes it (no toggle), unlike Make Shape. Fix: either give the search entry its own state/behavior, drop the duplicate `active` on one, or remove one button — the rail now lists two entries that open the identical panel, which Studio's rail never does.

**N2. minor — `src/styles/canvas.css:127` — plan guide stroke switched to an off-token literal `#2c9aff`.**
The old value (`#6b93ff`) at least equaled `--blue-soft`; the new one is in no token and not in the doc's color table, so plan guide paths now use a color that exists nowhere else. Repro: Plan mode, set a path to *guide*, compare its stroke to any UI blue. Fix: `stroke: var(--blue-050)` (matching design-mode guides) or restore `var(--blue-soft)`; if `#2c9aff` was re-measured, add it to `tokens.css` and the doc. Same family: `.pl-shape.is-pocket.is-hover .pl-base { stroke: #b5f2d5 }` (`canvas.css:124`) is another token-less literal.

**N3. minor — review canvas painted from three disagreeing sources.**
`tokens.css:83` declares `--canvas-bg: #d9dbe1` for `.theme--review`, but `canvas.css:113` paints `.ui-viewport.mode-review { background: #dfe1e7 }` and `Canvas.tsx:769` adds `fill="#dfe1e7"` — the token is dead and the doc/table value lost. Fix: decide one value, set `--canvas-bg` to it, and have `canvas.css`/`Canvas.tsx` reference it (the SVG rect can keep a literal if a comment ties it to the token).

**N4. minor — `src/styles/canvas.css:172-175` + `src/editor/canvas/ShapeViews.tsx:21` — on-line cut paths render black, doc says white.**
`.pl-cut--black { stroke: #0a0a0b; stroke-width: 1.5px }` overrides the doc's plan spec "cut path = white dashed (5,10) 1.25px" for the *on-line* type only. It plausibly mirrors the Origin encoding ("black stroke no fill = on-line"), but nothing records that. Fix: use white like the other cut paths, or add a sentence to `shaper-studio-design.md` documenting the deliberate black on-line centre-line.

**N5. minor — the three full-screen dialogs' round cancel buttons use three glyph sizes.**
Same 40px `.ss-btn-round` role, same `IconClose`: `TextDialog.tsx:139` = 24, `Carve3DDialog.tsx:555` = 20, `PaperScanDialog.tsx:1136` = 18. Side by side the ✕s visibly differ. Fix: one size (24, matching `.ss-btn-round svg` in `components.css:150-153`).

**N6. nit — feature-dialog header icons differ.** Carve3D header icon 24 (`Carve3DDialog.tsx:299`) vs Paper 20 (`PaperScanDialog.tsx:772`) although `.ss-dialog__header svg` is sized 24 by default (`components.css:28-31`). Drop the `size` prop in Paper.

**N7. minor — Make Shape search doesn't do what its placeholder says.** `Popovers.tsx:58` filters only `TEMPLATES`; the six basic-shape buttons (lines 62-69) are never filtered, yet the placeholder/aria say "Search shapes & templates" (lines 78-79). Repro: type "circle" → "No shapes or templates match" appears directly above the circle button. Fix: include `BASIC_SHAPES` labels in the filter, or reword to "search templates".

**N8. nit — search input sits inside the templates section.** `Popovers.tsx:71-82` renders it between the "templates [new]" label and the tile grid, reading as templates-only while it's meant to be global. Move it above the "shapes" label (it also serves as the Find Art search focus target, `Chrome.tsx:109`).

**N9. nit — Paper's inlined glyphs still break the 1.75 icon standard.** Drop-zone arrow 1.6 (`PaperScanDialog.tsx:827`), capture dot ring 2.0 (806); only the camera glyph (896) matches. Promote them to `icons.tsx` exports at 1.75 (the C4 fix pattern used for ✕/cube).

**N10. nit — warning/error colors bypass the tokens created for them.** `--warn-text: #a14b0b` exists (`tokens.css:31`) but `carve3d.css:41` and `paper.css:274` re-hard-code `#a14b0b`; the error red `#d61f3f` is duplicated in `carve3d.css:37` and `paper.css:266` and matches no token (snap-red is `#ff274e`); `--canvas-bg`/`--gray-700` are re-hard-coded as `#3f4145` (`canvas.css:110`). Fix: use the tokens; add `--error-red` if `#d61f3f` is intentional.

**N11. nit — dead style residue.** `.pp-footer-note` (`paper.css:290-294`) and tokens `--hover-fill`/`--radius-xs`/`--radius-md` (`tokens.css:39,41,44`) remain unreferenced after the cleanup pass.

## 3. Suggested order

Cheapest visible wins: A2 (`canvas.css:131` → 4px), A3 (`canvas.css:203` → 12px radius), N5/N6 (one line each). Then N1/N7 (rail and search behavior), N2/N3 (token alignment), then the remaining structural items (A8 direction, C1/C3/C6, B3 `tokens.ts`).
