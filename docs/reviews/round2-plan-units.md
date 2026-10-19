All evidence gathered. Here is the second-round audit report.

# Second-round audit — Plan & Review rendering + units

Ground truth: `docs/research/plan-review-spec.md`. All file:line refs verified against the working tree today.

## 1. Re-verdicts on `docs/reviews/plan.md`

| Finding | Verdict | Evidence |
|---|---|---|
| M1 cut-type menu clipped | **FIXED** | `Floating` renders in a `document.body` portal: `src/editor/Panels.tsx:119-171`, used at `Panels.tsx:465`; positioned with viewport clamps at `:143-144` |
| M2 open-path offset (vanish / double-loop) | **FIXED** (all-open case) | `src/editor/canvas/canvasMath.ts:42` — `centre = off && anyClosed ? offsetContours(world, off) : world`, so all-open shapes never enter `offsetContours`. Residual for *mixed* shapes → new finding N1 below |
| M3 unselected types indistinguishable | **FIXED (spec reversed the premise)** | plan-review-spec.md:17-24 shows unselected outside/inside/online/pocket all share base `#dfe1e7` 1.25px and hides band/cut-path by default (:27-29). `canvas.css:118-122` + `Canvas.tsx:575-577` now match the measured spec exactly |
| m1 mixed selection assigns impossible types | **FIXED** | menu filters for all-open (`Panels.tsx:430-431`) and `pickType` coerces per-shape: `Panels.tsx:438-445` |
| m2 hover shows no band | **FIXED** | `showCut = !isGuide && (selected \|\| hovered \|\| cutAll)`, `Canvas.tsx:575`; band renders on hover at black .45 per spec :30 (`canvas.css:137-140`) |
| m3 − button increases depth from unset | **FIXED** | `Panels.tsx:482` — `depth == null ? null : Math.max(0, depth - step) \|\| null` |
| m4 no flute-length warning | **FIXED** | `Panels.tsx:434-435` (`tooDeep` via `BITS` diameter match) rendered at `:500-504` |
| m5 selected guide loses dash | **FIXED (spec settles it)** | spec :33 says selected guide = plain `#1be09e`, no dash required; `canvas.css:133-135` matches |
| m6 export drops offset | **FIXED** | `svgExport.ts:26-46` bakes offset per type; `shaper:cutOffset` no longer written (header :4-6) |
| n1 dead `order` style | **FIXED** | gone from `Canvas.tsx:586` |
| n2 depth tooltip on selected guides | **NOT FIXED** | `Canvas.tsx:658` gates only on `selShapes.length`; a lone selected guide still shows an "unset" pill |
| n3 "mixed" shows On-Line icon | **NOT FIXED** | `Panels.tsx:460` — `cur?.icon ?? <Ic.IconCutOnline …>` unchanged |
| n4 menu never closes on outside click | **FIXED** | `Floating`'s captured pointerdown/Escape dismissal, `Panels.tsx:147-164`; canvas clicks land outside → closes |
| n5 fixed 86px tooltip | **FIXED** | `Canvas.tsx:663-668` — 96px pill, clamped to viewport (`:665-666`), `overflow: visible` so long text still renders |
| n6 stale params on type switch | **NOT FIXED** | `svgExport.ts:91-92` still writes `shaper:cutDepth`/`toolDia` for guides; `pickType` (`Panels.tsx:438-445`) doesn't clear depth/offset/bitDia |

## 2. Re-verdicts on `docs/reviews/units.md`

1. mm 3-decimal display — **FIXED**: `factory.ts:39-43` (`fmtNum` trims to 3 decimals; 3.175 → "3.175"); `NumField` uses it via `fmtLenValue` (`Panels.tsx:14`, `:42`).
2. Units unreachable in Plan — **FIXED**: chevron on Design **and** Plan tabs (`Chrome.tsx:184`), plan popover rendered at `:206`, contains Units seg (`:272-274`). Styling matches spec: 287px/`#2a2b2d`/2px `#0a0a0b`/r12 (`app.css:306-312`, tokens `tokens.css:15-16`), seg ring `#56575d` (`components.css:270-273`), switch 48×24 dark off `#3f4145`+white ring / on `#2d3f70`+`#d5e0ff` (`components.css:279-318`, `tokens.css:23,32`).
3. Paper Scan Custom inch defaults in mm docs — **NOT FIXED**: `PaperScanDialog.tsx:353-354` still `useState(8.5)` / `useState(11)`; clamp at `:133-134` still silently raises 8.5→10 mm.
4. `parseLength` comma decimals — **FIXED**: `ops.ts:219`; `NumField` also normalizes (`Panels.tsx:61`).
5. Text height hard-wired 1 in — **FIXED**: `defaultHeight` per units (`TextDialog.tsx:11`) + cap-height NumField (`:106-109`).
6. Offset default ¼″ constant — **FIXED**: `Popovers.tsx:137` (`units === 'in' ? MM_PER_IN/8 : 3`).
7. New shapes 1 in — **kept deliberately**; matches measured Studio (`shapeFactory.ts:33,62-80`). No change needed.
8. Paper preset labels mm-only — **NOT FIXED**: `PaperScanDialog.tsx:928` unchanged.
9. Ink sliders mm-only — **FIXED**: edge margin `format={(v) => fmtLen(v, units)}` (`PaperScanDialog.tsx:1061-1069`), min blob per-unit `in²`/mm² (`:1074-1081`).
10. Depth arrow-key vs button step mismatch — **FIXED**: `step={step}` passed (`Panels.tsx:490`); `NumField` default aligns (`Panels.tsx:67`).
11. Duplicate offset 6.35 mm — **FIXED**: `store.ts:269` (`doc.units === 'in' ? 6.35 : 5`).
12. Fixed-width bbox pills — **FIXED**: `textPillWidth` sizing (`Canvas.tsx:618-623`, `canvasMath.ts:94-96`).
13. No global units preference — **FIXED**: `lastUnits`/`rememberUnits` (`store.ts:17-36`), used in `newDoc` (`:45`) and `setUnits` (`:199-204`).
14. Group info raw mm — **PARTIAL**: now rendered (`Panels.tsx:623-631`) but via `String(v)`; `carvePlan.ts:406-413` still stores raw mm, so a mm doc shows "stepDown 3.175" with no unit. Formatting half of the recommended fix is missing.

## 3. In-area items from the other reviews

- design.md **A2** (plan selected stroke 3 vs 4 px) — **FIXED**: the later-measured spec (:31) says 2.5px; `canvas.css:131` is 2.5px.
- design.md **A3** (tooltip 4px radius vs "pill") — **NOT FIXED** (`canvas.css:203`), but plan-review-spec.md:35 only says "black pill", so this is now unactionable ambiguity.
- design.md **A4** (chevron Design-only) — **FIXED** (`Chrome.tsx:184,196,201`).
- design.md **A8** (review shades *darker* with depth) — **RESOLVED**: the measured spec's table (:43-52) confirms darker-with-depth; `canvas.css:215-231` matches all 32 fill/stroke/shadow values cell-for-cell, and Canvas sorts shallow→deep (`Canvas.tsx:580-585`).
- interact.md **n4** (review hit-test ignores z-order) — **FIXED**: review hit-testing disabled outright, `Canvas.tsx:184`.
- features.md **m3** (no delete in Plan) — **NOT FIXED**: `App.tsx:107` still guards `st.mode === 'design'`.

## 4. Spec compliance of the new rendering (spot-check results)

Verified correct against plan-review-spec.md: popover rows/order and both themes; band/cut-path visibility rules incl. Cut Path Display; per-type band geometry (outside/inside/online/pocket, `canvasMath.ts:35-47`); ants colours/widths/dash 5,10/1s linear and per-type direction (outside+online ccw 0→15, inside cw 0→−15: `canvas.css:161-191`, `ShapeViews.tsx:18-23`); pocket fill+tick pattern with constant 24px screen tiles (`Canvas.tsx:743-757`); hover states incl. pocket `#b5f2d5`; selected states incl. collapsed-inside showing base only; guide blue / hidden-in-review; Review bg `#dfe1e7` + procedural grain; depth level formula (0.25 in→3, 0.5 in→5, eps guard: `canvasMath.ts:55-59`, tested in `tests/canvas-geometry.test.ts:32-40`); shadow shift (0.1, dy) px screen-space clipped to swept area (`ShapeViews.tsx:71-95`); tooltip left-of-selection with clamping.

## 5. NEW problems

**N1 — major → minor — mixed closed+open shapes: open subpaths become band outlines in inside/outside/pocket geometry**
`src/editor/canvas/canvasMath.ts:35-47` + `src/geometry/offset.ts:73-79`. The M2 fix only guards the *all-open* case (`anyClosed`). When a shape mixes closed and open contours (one SVG `<path>` with both `…Z` and non-`Z` subpaths; Paper Scan traces can do this), `offsetContours` receives the open contours and — since the offset.ts rewrite — always strokes them into a closed stadium outline for **both** delta signs. For an *inside* cut (delta always ≤ −bitDia/2 < 0, i.e. the branch the old code never reached), the dashed cut path now traces a double loop around each open segment instead of along it, and Review sweeps stadium×bitDia blobs.
*Repro:* import an SVG containing `M10 10h40M60 60a30 30 0 1 1-.1 0` → set cut Inside (any bit) → Plan shows ants looping around the 40 mm segment; Review shows a fat swept band there.
*Fix:* in `computeCutGeometry`, partition `world` into closed/open; call `offsetContours(closed, …)` only and concatenate the open contours unchanged into `centre` (open members cut on-line, consistent with the all-open coercion). `swept` already handles mixed via `strokeOutline`.

**N2 — minor — canvas styling keyed on stored cut type, not effective type**
`src/editor/canvas/ShapeViews.tsx:18-23,44,60`. `pocket`, `isGuide` and `CUT_CLASS[s.cut.type]` read the *stored* type, while geometry uses the effective type (`geom.type`). A shape that is all-open but carries a stale `inside`/`outside` type (project files or autosaves written before the `pickType` coercion existed) renders white clockwise ants instead of black ccw online ants; a stale `pocket` renders a filled black .45 stadium plus ticks instead of a band + centre line. `svgImport.ts:219` coerces at import, so only pre-fix local files hit this — but they exist in the wild of this repo's own autosave.
*Fix:* derive all three from `geom.type` (it's already a prop-time value whenever `band` is true): `const t = geom?.type ?? s.cut.type` then `pocket = t === 'pocket'`, `isGuide = t === 'guide'`, `CUT_CLASS[t]`.

**N3 — minor — `depthLevel(0)` returns 1, not 0**
`src/editor/canvas/canvasMath.ts:55-59` guards only `null`/non-finite; `depth = 0` passes to `Math.max(1, Math.ceil(-1e-9))` → level 1. Our own stepper can't store 0, but `svgImport.readDepth` can (`svgImport.ts:104-108` accepts `shaper:cutDepth="0mm"`), and the established convention is 0 ≡ unset (plan.md "Verified"): such a shape renders as a visible shallow cut in Review and shows a "0 mm" tooltip instead of "unset".
*Fix:* `if (depth == null || !Number.isFinite(depth) || depth <= 0) return 0`.

**N4 — nit — Origin Anchor rows lack the ⓘ affordance**
`src/editor/Chrome.tsx:280-282` and `:292-294` render icon+label+switch only; spec :11 explicitly notes "Origin Anchor — switch (with ⓘ)" in the Plan popover.
*Fix:* add a muted info glyph (e.g. `Ic.IconHelp size={14}` with a `title`/tooltip) between label and switch in `SettingsRow` when a new `info?: string` prop is set.

**N5 — nit — selected pocket outline stroke is 1 world unit and scales with zoom**
`src/styles/canvas.css:151-156` sets `stroke: #1be09e; stroke-opacity: .3` on `.pl-pocket` but no width and no `vector-effect`; the rendered `<path>` (`ShapeViews.tsx:51`) sets no stroke width either, so the green ring around a selected pocket is 1 mm wide in world space (4 px at default zoom, 40 px zoomed in). Every other plan stroke is a non-scaling hairline.
*Fix:* add `vector-effect: non-scaling-stroke` to `.pl-pocket` (attribute on the path or CSS `vector-effect`) with an explicit `stroke-width: 1px`.

## 6. Suggested order of attack

N1 (geometry correctness, also fixes Review output) → N2 (one-line, fixes stale-file rendering) → N3 (one-line) → N4/N5 (cosmetic). The two outstanding not-fixed minors worth a follow-up PR: units.md #3 (Paper Scan Custom prefills) and plan.md n2/n3/n6 (tooltip on guides, mixed icon, guide export attrs).
