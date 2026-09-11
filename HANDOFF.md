# Handoff

A three.js / WebGPU scene: you sit behind the witch's desk, draw a sigil on the
parchment with the quill, and the sigil casts a spell. Ink and spell VFX are TSL
compute shaders; the room is `public/Witch_Hat_Atelier_fixed.glb`.

```bash
npm install
npm run dev      # http://localhost:5173 — needs a WebGPU browser, no WebGL fallback
npm run build    # tsc --noEmit + vite build
```

**Read `README.md` first.** It carries the *reasoning* behind every non-obvious
decision — why recognition happens in screen space, why AA is spatial and not
temporal, why the light rig looks the way it does. This file only covers what the
README doesn't: current state, how to verify things, and what is still open.

---

## State

Everything below is implemented, measured and working.

| Area | Where | Notes |
| --- | --- | --- |
| Room, materials, light rig | `scene/Atelier.ts`, `scene/lightRig.ts` | 26 lamps ported from the .blend |
| Ink on parchment | `ink/InkSurface.ts` | ping-ponged storage textures, one compute dispatch/frame |
| Sky | `scene/Sky.ts` | procedural gradient + 3-layer star field, `scene.backgroundNode` |
| Floating orbs | `scene/SpookyOrbs.ts` | 7 GLB emissive spheres, re-authored as glows; drift + twinkle |
| Ink fading + motes | `ink/InkSurface.ts`, `ink/InkMotes.ts` | writing dissolves over `INK_LIFETIME`; motes shed at the fade front |
| Stroke capture + recognition | `ink/StrokeRecorder.ts`, `recognize/` | $P, screen-space, 24 sample points |
| Spells | `spells/` | every spell mesh now wears `transparentMRT()` too, not just the particle fields — without it SSGI shades the pillars/dome/ribbons as solid geometry and you get a hard mesh-shaped shadow.  fireball, lightning (20 ribbons: core, fringe, and a burst at each end), floor rune, ward + shared `ParticleField`; the field has `buoyancy` (signed, so sparks can fall), `floor` (a height they land and skid on), `spray` (speed spread) and `updraft` (a two-sided vertical kick) — the fireball uses all four, plus `turbulent` and a second 2,048-particle pool for the ash that falls for 3.2 s after the fire is out (`airborne` vs `active`), because an evenly-thrown shell is a sphere no matter what you pull on it. The ward is a cage closed *on* the dummy's body (1.25–1.70 m, centre and size both derived from its vertices — the page no longer places it, a cage has no margin for that) rather than a dome on the floor (2.35–3 m), and its shell is an iridescent bubble with a glyph ring on the floor under it (that ring sits at y=0.056: the floor there is `MagicCircleDecal` at 0.051, not the flagstones); the rune's pillars are columns of violet flame (warped noise, height-rising break), and it rocks the dummy 5° with `RUNE_JOLT` |
| Camera | `scene/CameraRig.ts`, `scene/LookAround.ts` | two framings + seated look-around; a cast sits you back for as long as it reports itself running (bolt 2.4 s, fireball 3.2, ward 3.7, rune 4.1) and glides back over the page in 1.5 s if the quill is still there. While a sigil is being drawn the camera is measured still to 0.000° — `setLocked` commits the gaze as well as the goal, and `shake` and `recentre` both defer to it. A resolved sigil is three beats: it lights up over `INK_BURN_SECONDS` with the camera still on it, then the camera leaves, then the spell fires `CAMERA_LEAD` later |
| Post | `scene/Post.ts` | SSGI + FXAA + bloom, `G` cycles views |
| HUD, welcome gate | `ui/Hud.ts` | loading screen doubles as the door in; music toggle |
| Audio | `audio/Chime.ts`, `audio/Ambience.ts` | synthesised bell/crack, decoded one-shots; ambient loop |

**Measured, so you don't have to re-derive it:**

- Recognition, simulated hand (±12% per-vertex, ±15° rotation, ⅓-sheet to
  full-sheet): **39/40 accepted, 0/12 scribbles accepted.** Genuine attempts
  0.48–0.90, scribbles ≤0.43, threshold 0.48.
- **The bolt's templates were never the problem, the framing was.** Swept against
  a simulated hand, a Z holds 40/40 across aspect 0.4–1.7, rotation ±30°, slant
  ±0.5, bars unequal 0.6:1.2 either way, rounded corners, and drawn in three
  strokes. It fails at aspect 2.0 (20/40) — and the seated framing projects the
  sheet at **2.03** wide against **1.04** leaned in, so a Z drawn to fill the page
  from the seat is exactly the one shape it cannot read. `onDrawStart` now takes
  the camera unconditionally; see the README's screen-space section.
- **How wide the sigil is drawn is a dimension that sweep missed**, and it was the
  one that mattered: leaned in on a 16:9 display the parchment is 1.2× wider than
  tall on screen, so filling the page means drawing a wide sigil, and `scaleToUnit`
  scales uniformly — proportion is part of the shape. Every bound glyph now carries
  a second exemplar at 1.32× (`WIDE` in `glyphs.ts`). Worst case over 1.0/1.2/1.35×,
  80 attempts each: pentagram 80→80, **triangle 0→80**, circle 58→80, bolt 54→80.
  Cost, on one fixed corpus of 300 random walks: 0/300 accepted before, **1/300
  after**, peak 0.48 → 0.52.
- Frame rate at 1597×1453, DPR capped 1.5: **76 fps** with SSGI, **111 fps**
  without (`G` → `plain`). Forward-shading the 40-odd lamps was 24 fps before
  clustered lighting; the fix was bounding each lamp's range.

**Resizing the renderer costs ~0.7 s of frozen screen. Treat it as the most
expensive thing the app can do.** Any change of canvas size *or* pixel ratio, in
either direction, on this scene. It is not our JavaScript — `setSize` returns in
0.0 ms and the `post.render()` after it in 0.2 ms, and the time appears between
that frame and the next. It is not the post chain — a bare
`renderer.render( scene, camera )` with `Post` bypassed stalls the same 687 ms.
It is not the browser — a hand-rolled WebGPU canvas resized on the same page
costs nothing.

**It is the pipelines.** A change invalidates every render pipeline in the scene:
hooking `backend.createRenderPipeline` and stepping the ratio by hand, the call
returns in 0.1 ms, the frame after it queues in 0.6 ms, and that frame rebuilds
**23 render pipelines** for 1.1 ms of JavaScript between them. The wait is the
driver compiling them.

Four things follow, and all four are now in the code:

- **The resolution never changes during play.** Three adaptive rigs were written
  against that 0.7 s and every one of them *was* the reported lag: the first
  oscillated forever (1.5 → 1.375 at t=23.6 s, back at t=31.4 s, two freezes a
  minute — "it lags all the time"); the second was one-way but judged the arrival,
  so it froze during the entry ("it lags when I look around after entering"); the
  same rig judged a burst of casts as sustained trouble and froze on the third
  spell ("it lags at the last spell"). `Resolution` now spends a **pixel budget**
  — 1.25 M pixels of drawing buffer, worked back to a ratio from the canvas size,
  snapped to eighths, clamped 1.0–1.5 — chosen per canvas size and never again.
  Measured after: 103 fps idle (0 long frames in 617), 107 fps sweeping the view
  (0–2 in 696), 97 fps across four casts in a row (5 in 1165), against 62 fps and
  a 776 ms freeze before.
- **Do not try to size it during the load.** It was tried. Behind the opaque boot
  screen the same scene at the same ratio measures **0%** long frames against
  **13.3%** with the screen taken away — the compositor skips presenting an
  occluded canvas, so `requestAnimationFrame` is no longer paced by the GPU.
  Timestamp queries were worse: the same frame read 19.6 ms and 67.8 ms. There is
  no honest frame-time measurement to be had before the room is on screen.
- `observeViewport` **debounces**. Wired straight through, a window drag is one
  freeze per distinct size; it is now one per drag, and none at all if the drag
  ends where it started.
- The load **draws two frames before `hud.ready()`**. `compileAsync` walks the
  *scene*, so it warms the room's materials and none of `Post` — the MRT pass,
  SSGI's node materials, the bloom mip chain, FXAA are all built inside
  `RenderPipeline` on the first `render()`. That first call measured **820 ms**,
  and it landed on the frame right after the door opened: the HUD said "Ready."
  while the most expensive part of the load had not started. Entry stall after:
  826 ms → 86 ms, with the 760 ms moved back behind the boot screen where the
  wait is already understood.

- `SpookyOrbs.place` wants `updateWorldMatrix( true, false )`, not
  `updateMatrixWorld()`. The latter walks the parent's whole *subtree*, and both
  parents are the biggest objects in the scene (`Scene`, 460 nodes; and
  `BlenderLightRig`, 57) — about 6,800 node visits a frame to move twenty-one
  things, all of it redone by `render()` a moment later. 0.584 → 0.008 ms.

---

## Verifying changes

There is a dev-only handle on `window.atelierDebug` — `renderer, scene, rig, ink,
recorder, effects, quill, post, pdollar`, plus:

```js
atelierDebug.demo( 'pentagram' )          // write a sigil at quill speed (1.4 s)
atelierDebug.demo( 'bolt', 0.34, 4 )      // slower, to watch the ink go down
atelierDebug.demo( 'triangle', 0.34, 0 )  // stamp it in one frame
atelierDebug.effects.rune.awaken()        // fire an effect directly, no glyph
atelierDebug.post.setView( 'ao' )         // 'combined' | 'plain' | 'ao' | 'gi'
```

Glyphs available to `demo`: pentagram, triangle, square, circle, spiral, bolt,
cross, caret.

**To study a single frame**, stop the loop from inside it — most spells are over
in under two seconds, and screenshots will otherwise always land after the fact:

```js
const r = atelierDebug.recorder, step = r.update.bind( r );
atelierDebug.demo( 'pentagram', 0.34, 3 );
r.update = ( dt ) => { step( dt ); if ( r.traceClock > 1.2 ) atelierDebug.renderer.setAnimationLoop( null ); };
```

The same trick works on `effects.fireball.update` (freeze on `phase === 'flight'`)
and `effects.ward.update`. Reload to resume.

**`#hud` is `pointer-events: none`**, so a drag anywhere over the overlay reaches
the canvas and draws — the right default for a HUD sitting on a scene you steer
with the mouse, and one every child inherits. The music button is the only element
that opts back in, and it has to stay the only one: re-enabling any higher up would
start swallowing strokes that began over a plate.

**The experience opens on a door, and that is a technical requirement.** No
browser will play audio until the page has been interacted with, and there are two
audio paths here — the ambient loop and `Chime`'s synthesis — that both want to be
live the moment the room appears. `Hud.gate()` collects that one gesture. Two
things about it are load-bearing: the loading runs *behind* the gate rather than
before it, so the room is finished the instant the door opens; and whatever needs
the gesture must run inside the click handler passed to `gate`, not after the
`await`, because by then it is a promise continuation and no browser still counts
it as a gesture.

**The button is not shown until `Hud.ready()`.** It used to stay live throughout
the load, remembering an early press and opening by itself once there was
something behind it — the reasoning being that making the button wait would spend
the loading time twice. It spent it worse. A live button on a screen that is
plainly still working reads as an invitation, and the reader who accepted it got a
button that changed under their hand into "One moment — still lighting the
candles". A door you can open onto nothing is not a shortcut; it is a wrong answer
to the only question the screen is being asked.

**There is no progress bar; the sigil's stroke is the progress bar.** Every shape
in the title sigil declares `pathLength="1"`, so the single custom property `--p`
— set by `Hud.progress` — drives `stroke-dashoffset` on all ten at once and the
figure inks in as one. `Hud.ready()` then adds `sealed`: the ink catches light,
and the door arrives on the back of that. The half-second `ready()` waits is not
padding — `--p` reaches 1 in the same call and the stroke has a 0.5 s transition
to travel, so sealing on the instant would light a figure still drawing itself.

Three things about that screen are worth not rediscovering:

- **It is namespaced `boot-`, and its palette is scoped to `#boot` rather than
  `:root`, because two names collide with the HUD's.** `.sigil` is already the
  grimoire card in the footer — `.sigil svg path { stroke-width: 6 }` would have
  landed on the title sigil — and `--ink` already means the parchment the HUD
  writes *in*, the exact opposite of the dark it is written *on*. Hence
  `.boot-sigil` and `--boot-ink`.
- **`#boot.gone` is only an opacity, so `Hud` follows it with `spent`
  (`display: none`).** The grain repaints three times a second and fourteen
  fireflies drift forever; an opacity of zero stops neither. Left up, an invisible
  title screen would go on taking frames off the room for the whole session — the
  worst kind of cost, because there is nothing on screen to suspect. It is set on
  `transitionend` (guarded on target and property, since that event bubbles) with
  a 1.5 s timeout behind it.
- **`#boot-msg` is `pointer-events: none`, and that is load-bearing.** It shares
  one grid cell with the door so the status line holds the space during the load
  and the button takes it over without anything below moving — but it is painted
  after the button, so a faded-out "Ready.", 39×19 px of invisible text, sat
  exactly over the middle of the button and ate the click. Opacity hides a thing;
  it does not get it out of the way. Test the door with a real click, not
  `element.click()`, which bypasses hit-testing entirely and passes regardless.

**Clicking the door does not dissolve it — you travel through it.** The exit is
two moves that overlap on purpose, and the overlap is the whole effect:
`CameraRig.arrive` starts the camera 2.2 m behind the seat and eases it forward
over 2.2 s, while the title screen's backdrop drops out early and its plate scales
past the viewer. Measured, at 60 Hz:

| ms | veil | plate | scale | camZ | fov |
| --- | --- | --- | --- | --- | --- |
| 19 | 1.00 | 1.00 | 1.00 | 5.88 | 50.0 |
| 395 | 0.20 | 0.99 | 1.01 | 5.82 | 49.8 |
| 806 | 0.00 | 0.67 | 1.12 | 5.34 | 48.5 |
| 1203 | 0.00 | 0.03 | 1.50 | 4.49 | 46.1 |
| 2196 | 0.00 | 0.00 | — | 3.72 | 44.0 |

The backdrop is gone by 600 ms so the room is visible *behind* the still-solid
title; the plate then flies from 1.0 to 1.5 over that room between 600 and
1200 ms; the camera has another second to itself after the screen retires at
1350 ms. Fading `#boot` as one sheet is what this replaced, and the numbers say
why: 94% of it was gone by 800 ms, when the camera had covered 6% of its travel,
so the two never shared a frame.

Two constraints on the dolly, both learned the hard way:

- **2.2 m is a ceiling, not a preference.** There is no ceiling in the room and
  nothing is modelled above ~2.6 m, so the camera must not clear the wall's top
  course. At 3.6 m back with any lift the top quarter of frame is empty and the
  atelier reads as a model on a table. Straight back along the view axis, no
  lift, keeps every edge inside the room.
- **`compileAsync` is camera-dependent, and so is the warm-up render.** A render
  list is frustum-culled, so warming from the seated framing warms the seated
  framing — and the wide shot contains shelves and bookcases that were never in
  it. The click handler ran in 5.2 ms and the *first frame after it* took
  **331 ms**, compiling them. `rig.arrive()` therefore happens before
  `compileAsync`, not after the gate: the camera waits at the top of the move
  (nothing advances the offset until `update` runs) and everything is warmed from
  the framing that sees the most. 331 ms → 14 ms, worst frame in the whole
  transition 19 ms.

The screen pulls Cormorant Garamond from Google Fonts, with the app's own
`'Iowan Old Style', Palatino, Georgia, serif` stack behind it and `display=swap`,
so it paints immediately and swaps — offline it simply stays on Palatino.

**Particles need `glow` to reach the bloom.** A `ParticleField` sprite's additive
contribution is its tint times its heat ramp times the 0.22 its alpha carries —
about 0.30 at the very hottest — and `Post`'s bloom does not open until 1.15. So
nothing in a field has ever bloomed on its own; only enough overlapping sprites
stacking on one pixel pushed a *region* over, which is why the effects lost their
halo the moment the particles were made small enough to stop overlapping.
`EmitterState.glow` multiplies the emitted colour, and past about 3.8 a spark's
own core crosses the line. Values above 1 are HDR and AgX rolls them off, so it
buys glow rather than white-out; the heat ramp keeps it to the young half of a
particle's life and the sprite's radial falloff to the middle of it, so what
blooms is a hot core inside a spark that still has an edge. Shipped: fireball
2.6→5 charging, 5.5 in flight, 9 falling through the burst; lightning 10 falling
with the strike; the rune rides its own charge; ink motes 4.2.

**The room has aerial perspective**, and it exists to kill one line. Where the
wall's top course meets the sky is the highest-contrast edge in the frame, and
not by accident: every lamp is *below* that course, so the darkest thing in view
sits directly against the brightest part of the sky — two flat planes glued
together, and nothing done to the sky alone can fix it, because the hard edge
belongs to the geometry. `Sky.ts` exports `buildHaze` for `scene.fogNode`: a mix
towards a dim sky-coloured haze over range. Mixing towards a *dim* colour is the
useful part — it lifts the wall's black top course a long way and leaves the
candle pools, far brighter than the haze, essentially alone. Measured across the
room at the shipped figures: parchment 0%, dummy 0%, side wall 4%, wall top 29%.
Pulling `HAZE_FAR` in to 13 puts 47% on the wall top and starts flattening the
brickwork with it.

**There is no ceiling.** Nothing is modelled above about 2.6 m, so the top of
frame is sky, and in the seated framing that is a third of the screen. It used to
be one flat colour — which by construction cannot fall off with distance or angle,
so it read as a lit surface rather than as space. `Sky.ts` replaces it with a
`scene.backgroundNode`: a dusk ramp, two octaves of haze, and three layers of
procedural stars.

The ramp has **three** stops — rose-magenta horizon, violet shoulder at
`MID_AT`, deep indigo zenith — and the third one is the point. A straight mix
between a warm horizon and a cool zenith spends half the sky in between, and that
middle is exactly where a two-colour ramp stops reading as a sky and starts
reading as a tint. It also sets a warm/cool opposition at frame scale to match the
one already in the room: every lamp here is warm and the room it stands in is
washed violet.
No texture, no geometry, no draw call — three builds the background sphere itself
and hands the view direction over as `normalWorldGeometry`. It measures *cheaper*
than the room it replaces on screen (119 fps sky-filled vs 83 looking at the room).

The star field has one trap worth knowing. Cells are a 3-D grid but the sky only
ever samples a 2-D sphere of them, so measuring from the star to the point where
that sphere crosses its cell lights a star only when the shell happens to pass
within a star radius in all three axes — the first field came out with about five
stars in it. The fix is to measure the star's distance to the *ray* (the component
of the offset perpendicular to `dir`), which asks the question that was meant.

`Post.ts` still carries two falloffs, and the sky's own gradient now does most of
what the ceiling term was faking — which is why `CEILING_FLOOR` has since been
lifted from 0.26 to 0.5. Holding the old depth over a zenith that is genuinely
dark only dimmed the stars to a quarter for nothing. The corner term is untouched;
that one was never standing in for anything: a
gentle radial term for the corners, and a separate vertical term from
`CEILING_FROM` up. A radial vignette alone cannot do this job — centred anywhere
near the middle it takes barely a tenth off the top edge, and opened wide enough
to bite there it starts eating the corners of the parchment in the leaned-in
framing. The two multiply, so the top corners end up darkest and the lower middle
— the sheet, in both framings — is untouched. `plain` deliberately has no vignette:
it exists to separate lighting faults from post faults.

**The world colour is Blender's; the strength it arrives at is not.** Cycles
treats the world as light coming from outside, so a brick deep in a closed round
room barely sees any of it — the room is in the way. An `AmbientLight` has no
notion of enclosure and adds the same amount to every surface in the scene, so
porting the authored 1.1 straight across delivered it roughly three times too
strong: an even wash that lifted every brick off black together and flattened a
room whose whole look depends on small lamps. `Atelier.ts` keeps the .blend's
colour and strength and multiplies the light by `ENCLOSURE` (0.33) with the reason
written down. AO does attenuate ambient in the composite, but it is a short-range
screen-space estimate — it darkens a crease, not a room.

**Point lamps and wash lamps get different distance cutoffs**, and only one of
them is a performance bound. `CUTOFF_WASH` (0.02) is the old one: it exists so the
clusterer can decide which cells a light reaches, and it sits far enough out to be
invisible. `CUTOFF_POINT` (0.15) is a look decision — it puts a candle's reach at
about 1.4 m instead of 3.7 m, so the small hot sources burn contained pools
instead of overlapping into one wash. It costs no brightness where the light
actually is, because three's window is `(1-(d/cutoff)^4)^2` and that is 0.97 a
third of the way out; it takes almost everything away by the edge.

Beware that the wash can come back from an unexpected direction. `bounce_wallRim`
originally sat at z -2.25 — 1.8 m from the dummy and 2.2 m from the wall behind it
— so at energy 210 it lit the stone about as hard as the thing it was meant to rim
and put the flat wall straight back. Moving it to 0.7 m from the dummy and 3.3 m
from the wall lets the inverse square contain it: same rim at a sixth of the
energy, twenty-odd times as much light on the shoulders as on the wall. If the
room ever looks evenly lit again, toggle the light groups one at a time before
touching the lamps — it was not the lamps.

`light_area_warmFill` is trimmed to 0.3 on top of that, and *that* one is not a
correction — the fill arrives exactly as authored. It is a six-metre soft source
hung over the middle of the room pointing down, so it barely falls off across the
room and held every brick at much the same value; at three tenths the shelf lamp,
the orbs and the wall wash read as pools again. Below about 0.15 the returns stop
and the violet cast the room gets from this light starts going with it. `RigLight`
carries an optional `trim` for exactly this, kept separate from `energy` so the
number Blender holds stays visible and the disagreement stays legible.

**Two of the lights are not in the .blend, on purpose.** `lightRig.ts` exports
`BOUNCE` alongside `RIG`, and everything in it is named `bounce_`. They stand in
for Cycles' second bounce, which is the one thing the port could not carry across.
The training dummy is what exposed it: every authored lamp that reaches it is
above or in front, so it came out evenly lit with no edge against the wall.

The light that should separate it *is* authored — `PurpleWash_Wall`, cool
blue-violet, sitting behind the dummy and aimed `[0,0,-1]` straight into the back
wall. Cycles bounces it off the stone and back onto the dummy's shoulders. Here it
points away from the subject at a wall further off than SSGI's two-metre radius,
so all of it lands on the wall and none returns. Same underneath: the candles
light the desk and floor, and three's screen-space GI cannot carry that bounce the
three metres to the dummy. Checked against the live .blend — 26 lamps, exactly the
port, nothing missing. The rim was never a missing lamp.

Cost measured at about 1.5 fps of ~75. Watch the measurement order if you re-check
it: alternating on-then-off gave wild readings (28–110 fps for the same state) and
only off-then-on was stable.

**The floating orbs are not lights.** `SpookyOrb_0..6` come out of the GLB as
solid emissive spheres, and each has a `SpookyOrbLight_N` point light of its own
in the rig — appearance and illumination were always separate, so `SpookyOrbs.ts`
is free to change how they look. It keeps the mesh but stops it being a surface:
additive, with opacity falling off as `normalView.z` towards the silhouette, so
the edge that read as an object dissolves. A billboarded halo supplies the bleed.
Bloom was never the missing piece — it was already running and cannot dissolve a
hard edge, only halo what is inside one.

**The ink fade is three numbers, and they are coupled.** `INK_LIFETIME` (8.0 s)
is how long until a stroke reaches zero. `INK_SOLID` (0.45) is the upper knee of
the material's smoothstep and everything above it clamps to solid black, so it
decides how long a stroke stays at *full* strength before the fade shows at all.
`INK_VISIBLE` (0.08) is the lower knee, and it must not drift — the fade rate is
derived from it, so the material reads both knees from `config.ts` rather than
repeating them.

**The fade was tuned against the wrong task, and the fix needs both knobs.** The
original 3.0 s / 0.95 was chosen so a single stroke's *trail* read well, and it
did: a stroke began thinning 0.06 s after the nib passed and was half gone by
0.78 s. That is fine for one line and hopeless for a pentagram — five strokes
take a deliberate hand three to five seconds, and the last has to close on the
first, which by then was not there. You could not join up your own drawing.

Lengthening the lifetime alone does not fix it, and that is the part worth
keeping: the lifetime scales the whole curve, so the thinning still starts
immediately, just more slowly. The plateau is `INK_SOLID`'s job. At 8.0 / 0.45:

| t | 0.5 s | 1.5 s | 2.5 s | 3 s | 4 s | 5 s | 6 s | 8 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| drawn | 100% | 100% | 100% | 92% | 57% | 27% | 9% | 0% |

Lowering the knee is the safe direction for line weight. A *high* knee lightens
whatever part of a stroke the nib did not write at full strength — which is why
0.95 was affordable only because the nib is sharp (falloff band 0.28 of the
radius, not 0.7). A low knee clamps more of that band to solid, so the line reads
a touch bolder rather than thinner.

**`INK_LIFETIME / INK_BURN_RATE` is exactly how long a cast takes to clear the
page.** Not a coincidence — `INK_TAU` is defined so ink reaches `INK_VISIBLE`
after exactly `INK_LIFETIME` of fade, which makes it an identity. `INK_BURN_RATE`
is therefore derived from `INK_BURN_SECONDS` (0.667) rather than written as a bare
multiplier, because a bare one silently stops clearing the page the moment the
lifetime moves: the old 4.5 against a lifetime of 8.0 leaves the sigil at 0.14,
above the visible knee, fading on for seconds after the spell has gone off.

Recognition is not affected by any of this. `StrokeRecorder` never expires
strokes on `INK_LIFETIME` — it holds the whole sigil until `CAST_DELAY` of
stillness resolves it — so the fade was only ever costing you the ability to
*see* what you had drawn. Cost of the longer life: `InkSurface.update` keeps
dispatching for 8 s past the last mark instead of 3 s, measured at 0.04 ms/frame
CPU and 83 → 81 fps.

**The floor rune turns for its own spell only.** `RuneAwakening.update` computes
`level = max( charge, ambient )` and uses it for brightness — but the spin must
come off `charge` alone. `ambient` is a passing fireball or bolt stirring the
circle, set from `main.ts`, and driving the rotation off the combined level meant
the floor turned for every spell in the game, spending the one gesture that
belongs to the rune on the two that do not. Verified: casting a fireball raises
`ambient` to 0.28 and leaves `phase` at exactly 0.

**The desk potions were never glass.** Base colour pure black, metalness 1,
roughness 1, an `emissive` and no maps at all — a lamp in the shape of a bottle.
`glassPotions` in `Potions.ts` gives them the real transmission stack: `ior` 1.5,
`thickness` for the volume to attenuate through, `attenuationColor` over
`attenuationDistance` so the draught's colour is a property of the *liquid*
rather than paint on a surface, and `dispersion` 0.5 to fringe the rim. Free on
this scene — 48 fps before, 50 after, back to back, and 92 on a clean run.

They keep a reduced `emissive` on purpose. Physically pure glass in this room is a
dark shape: the atelier is lit by small contained pools, there is nothing bright
behind these bottles to refract, and dropping the emission turns the two
most-looked-at objects on the desk into silhouettes. The glass now shapes a lit
core instead of being the whole story.

**A cold `AudioContext` does not start on the wall clock, and the camera does.**
Measured on the real gesture: the context reports `running` immediately while
`currentTime` is still 0.000, then settles about **0.28 s behind**
`performance.now()` and stays there. Everything in `Chime` is scheduled against
`currentTime`, so nothing can be scheduled earlier than that — the compensation
has to be in the envelope. The arrival whoosh therefore peaks *ahead* of the
camera's midpoint rather than on it.

**An exponential ramp from near-silence is far slower off the mark than it looks.**
From 0.0001 it is still at a twentieth of its peak a third of the way through, so
the whoosh measured its loudest at 1.46 s of a 2.2 s move — a third of a second
after the camera's own fastest moment, and inaudible for the first half second
while the picture was already travelling. It now *starts* at half level: the
camera is already moving on the frame `arrive` is called, so a swell that fades in
is a swell that starts late. The ramp is only the difference between moving and
moving fast. Peak is now at wall 1.18 s against a midpoint of about 1.1.

**"It measured as output" is not the same as "it was heard."** The door's click
produced a real 0.019 RMS on the frame it fired and still went unnoticed, because
it lands inside the first fifth of a second of a cold context — the least reliable
moment the device has — and because one pitched layer under the transient reads as
a knock rather than a click. Doubled, with a second short high tick added, it
measures 0.042. A press is confirmation, and a confirmation that has to be
listened for is not one.

**The click on the door has to be scheduled inside the click handler**, next to
`chime.prime()`, for the same reason every other audio path in this file is: the
press is the gesture the context is built on, and a sound scheduled after any
`await` is a promise continuation no browser still counts. It is also the first
noise the room makes, which makes it the reader's first evidence that the sound
they were asked to turn on is working.

**The arrival's whoosh reads `ARRIVAL` too, and must keep doing so.** It swells
where the camera is fastest — `CameraRig` eases on a smootherstep, so speed peaks
at the midpoint and both the filter opening and the gain peak there with it. Let
the two numbers drift and the sound stops describing the picture, which is the
entire point of it.

**Two layers with a gap between them read as two sounds.** The whoosh first
decayed straight from its peak to silence and was gone by six tenths — exactly
when the chimes begin — so the transition had a hole in the middle, audible as a
noise followed by a notification rather than as one gesture. A third envelope
point holding most of the level to seven tenths carries the whoosh underneath the
chimes and lets them resolve out of it. Measured RMS across the move, before and
after, is the check: it should not dip between the layers.

**Mix by measurement, not by ear-in-a-silent-room.** Nine overlapping chimes at
0.03 each measured almost *twice* the whoosh's peak, which inverts the effect —
the whoosh is the move, the chimes are the arrival at the end of it. Read
`SHIMMER_GAIN` against `WHOOSH_GAIN`, never on its own.

**Hover is armed, not live from the first frame.** The door opens on a wide shot
and the parchment sits in the middle of the seated framing, so the pointer is
already over it before the player has moved anything — and the first twitch of the
mouse threw the camera down onto the desk. There was no moment in which the room
could be looked at. Hover now only counts once the pointer has been somewhere that
is *not* the page, so returning to the sheet is a decision rather than an accident
of where the cursor was left. Pressing to draw arms it too, and drawing never
depended on it — `onDrawStart` forces the framing itself — so there is no state in
which the page cannot be used.

**A look-around drag stands hover down for its duration.** Turning the view sweeps
the pointer across whatever the room puts under it, the parchment included, and
hover would then lean the camera in and recentre the very turn being made — the
room snapped back to the desk halfway through looking at it. `LookAround` reports
its turning state and `StrokeRecorder.hoverSuspended` takes it.

**Synthetic-input tests have to follow the camera.** A five-stroke pentagram
traced at fixed client coordinates scores 0% if the lean starts during the first
stroke, because the page slides out from under the coordinates — the recogniser is
fine (it re-projects the whole cloud through the current camera every frame), the
*test* is drawing somewhere else. Let the lean settle before tracing, or the
result says nothing.

**The quill is four parts, and the names do not say which is which.** Measured
along the pen from the tip: `Plane002` / `Stainless Steel` is the flat 11 mm
*blade* — the only flat part, and the frontmost — then `Pen_Nib_Color` is a 37 mm
collar behind it, `Pen_Ferrule_Color` a 66 mm ferrule, and `Pen_Handle_Color` the
220 mm shaft. `Pen_Nib_Color` is therefore **not** the nib. Painting each part a
flat emissive for one frame settles it in seconds and is worth doing before
touching any of them.

**An albedo is only half of what a surface looks like.** The shaft was given the
floor's walnut — the exact linear value from `Wood Floor Dark Walnut`, on the
reasoning that two walnuts in one room should not disagree — and washed out to
pale cream. The floor is metres from any lamp; the quill lies on the desk directly
under `bounce_deskWarm` and a candle. Same hue, less than half the value, because
the other half of the look is what is shining on it.

**A texture map beats a scalar, and `brass × grey` is neither.** The blade carries
base-colour, normal, roughness and metalness maps, all authored for steel. Setting
`material.color` did nothing against the base-colour map; multiplying the brass
*through* that map gave a near-black blade, because a mid grey times a warm tint
is just dark. What works is remapping the map into a narrow band around 1 so it
contributes detail while the brass sets the level — and overriding
`metalnessNode` / `roughnessNode`, because the maps win against the scalars and
were keeping steel's response on patches of the blade.

**One mask, `surface`, decides what belongs to the liquid.** The tint, the glow,
the vapour and the currents all key off it, and they have to: tinting the *whole*
bottle was wrong twice over — the headspace is empty glass with no draught to
tint, and multiplying a dark refracted room by a saturated hue drove it to
near-black. The bottle then read as two objects stacked on each other, dark glass
above and lit liquid below, rather than as one thing. `headspace` lifts the empty
part because clear glass passes more light than tinted liquid does; at 0.55 it
overshot and came out *brighter* than the draught, which inverts the reading and
makes the bottle look full of air. 0.28.

**A soft white patch on a narrow neck is the vapour, not a specular.** The
headspace is the tightest part of these bottles, so a wisp that reads as one
billow in a wide body fills the whole neck and arrives as an emissive smudge.
Density and brightness both come down for the desk pair for that reason alone —
the shelf bottles are wider and carry more.

**Currents in the draught are a separate feature from vapour above it**, and
running them at the same frequency is what makes them wrong: convection in a
liquid and smoke in air do not look alike, and the vapour's noise reads as grit
suspended in the potion. `currentScale` is a fraction of `scale` and the drift is
slower again — a few slow bodies of colour turning over.

**`Bottle001` is the reference for what glass should look like here**, and it was
under our noses the whole time: it is the one bottle nobody has ever complained
about, and it carries `roughness` 0.3, `ior` 1.45, plain `transmission` 1, no
dispersion and no emissive. Every correction to the other two has ended up moving
towards it. Read its material before tuning glass by eye. `referenceGlass()` in
`Potions.ts` now reproduces it outright for the lower shelf.

**`depthWrite: false` is what makes that material read as glass**, and it is the
only value in it that is not a `MeshPhysicalNodeMaterial` default. Copying
`Bottle001`'s transmission, opacity, IOR, roughness and specular still gave flat
milky shapes: with depth writing on, a double-sided shell's front wall occludes its
own back wall, so the bottle has no interior and what is left is one lit surface.
Nothing in the render pointed at depth — diffing the two materials property by
property is what found it, and that diff is worth reaching for early rather than
late.

**A saturated tint on transmissive glass is a value problem, not a colour one, so
pick the value and let the hue follow.** `HERO_TEAL` (0x2fd9c4, luma 174) on the
shelf's small bottle read as opaque plastic among four pieces of glass, and cutting
its emissive barely moved it — the tint was doing it. A transmissive body needs a
*dark* interior for its highlight to sit against, and a hero tint sits far brighter
than anything beside it, so the lamp lands on a pale surface with nothing to read
through. `HERO_AMBER` (0xe8a93c) is luma 175 and fails identically; that bottle is
amber now and the fix was the same arithmetic, not a fresh search. Match
`Bottle007`'s luma of 113 and the hue is then free: 0x2d7d72 (teal, 107) and
0xa06a1c (amber, 112) both read as dark glass with a cast. The desk's hero bottles
keep the neon, correctly — they are lit from within by `buildGlass` and are supposed
to carry the frame.

**Dispersion is off, and should stay off.** It survived every reduction — at 0.1
there were still red and cyan edges along the amber bottle's cork thread and its
highlight rim. The technique is sound and the reference demo is built on it, but
that demo is a bright checkerboard environment with glass as its only subject.
Here it is the sole surface in the room that splits colour, so it reads as a
rendering fault rather than as an optical property. Nothing else in the frame does
anything like it, which is exactly what makes it look like a bug.

**An additive glow flattens whatever it is added to.** The liquid's `fillGlow` was
applied at a constant value across the whole draught, so it swamped the shading
that gives the lower body its form: the base went smooth and rubbery while the
neck, too small to hold much of it, still read as glass. It looked like a
roughness map disagreeing top to bottom and was nothing of the kind — roughness
is a single uniform value with no map anywhere. Weighting the glow by how squarely
the surface faces the eye restores the form, and is also the physical answer: a
cylinder of liquid is deepest through its middle.

**Nineteen of the room's sixty-two lights reach the desk bottles.** Measured, not
assumed: `PotionGlow_Bottle` at 0.05 m, `PotionGlow_Bottle010` at 0.12,
`bounce_potionKey` at 0.32, `light_point_cauldronGlow` at 0.67, a candle at 1.33,
and the desk bounces beyond that. So when the glass showed one hard white streak
and no sign of the rest, the cause was never reach — it was `roughness` 0.04,
which is a mirror, not glass. At that width every one of the nineteen is a
pinpoint and only the brightest ever resolves. **0.19** widens the lobe until each
lamp leaves its own soft highlight, which is the same fix as "make sure the other
lights contribute": they already were.

The orbs genuinely are culled — `range = sqrt( intensity / CUTOFF_POINT )` puts an
energy-1 orb at 0.73 m and they stand two to three metres off. Two candles miss by
centimetres (1.46 and 1.49 m against a 1.37 m reach). Widening `CUTOFF_POINT`
would bring them in and is deliberately not done: it is the constant that keeps
the room's small sources burning as contained pools rather than one wash, and it
is documented above.

**A near-black body under a bright lamp clips its highlight before the tone map
sees it.** `MeshPhysical` defaults to `ior` 1.5 at full `specularIntensity`, and
there was no colour left in the highlight for AgX to roll off — it arrived white
and flat. 1.45 and 0.62 keep it inside the range the curve can shape.

**Flat glass is the strongest CG tell there is**, because every highlight on it is
the same clean shape. `bumpMap( mx_noise_float( positionLocal.mul( 190 ) ), 0.012 )`
breaks each one differently — no texture fetched, the same route `BookCovers`
takes for the tomes' leather. It perturbs `normalView`, so the refraction wobbles
with the surface instead of sliding over a perfect one underneath.

**The "three coloured strands" in the bottles were the chromatic dispersion, not
smoke.** At `dispersion` 1.6 the floor rune's glyphs refracted through each body
and split into hard red/green/blue threads — which read as three substances in
one bottle. Cut to 0.1 on the desk and 0.12 on the shelf: enough to fringe a
silhouette, nothing crossing the body. Anything that looks like a filament inside
a bottle is worth checking against the rune before assuming it is the smoke.

**A glowing draught cannot take its brightness from what is behind it.** Scaling
the backdrop by the tint (`lit.mul( colour )`) was tried and fails asymmetrically:
the amber hero stands over a warm desk and kept its colour, while the teal one
stands over dark floor and drained to grey. The glow is added as the tint's own
light instead. What it must not do is run past about 1 — AgX rolls every channel
together up there, and an amber potion arrives cream, which it did at 1.75.

**`rim` multiplies whatever the body already is.** Harmless on the unlit shelf
bottles, which is where it was tuned; on a lit draught it pushes the silhouette
past the same AgX knee and takes the hue with it. 0.45 → 0.28 on the desk pair
was the difference between ivory and gold.

**The smoke sits in front of the draught, so it dilutes it from the front.** The
shelf's density reads as vapour over a dark interior and as a wash over a lit one
— the desk bottles run 0.62 against the shelf's 0.75 for that reason alone.

**Every cork in the room is one material.** `Potion cap`, on all seven caps across
the desk and the shelf, so the mixed pink/tan look was never seven corks
disagreeing: it was one olive-tan (`0x997d51`) under a violet ambient that pushed
it pink where the light reached and grey where it did not. `0x8c6f52` holds its
hue against that tint. One assignment fixes all seven.

**`vapourOf` derives the smoke from the liquid** — same hue, lifted and drained —
so a bottle cannot end up breathing a colour that belongs to a different potion.

**A TSL graph built outside `Fn` silently loses its control flow.** The smoke
inside the shelf bottles is a raymarch — `toVar`, a `Loop`, `addAssign` — and all
three append to the shader stack *currently being built*. Assembled at module
scope, the ordinary way to write a material, there is no stack to append to: the
entire march compiled away, `gathered` stayed 0, and `mix( body, smoke, 0 )`
returned plain glass. It rendered as a flawless empty bottle, with no error
anywhere, which is the worst possible failure mode. `ParticleField` carries the
same warning about `.discard()`. **If a material needs a loop or a variable, wrap
it in `Fn`.**

**Noise has to be scaled to the distance the thing is actually seen from.** The
shelf smoke was first tuned at 25–38, which looked right with a bottle filling the
frame and averaged to flat grey at the three metres anyone plays at — the billows
were finer than the bottle was wide on screen. Halved to 15–23 they survive being
small. Tune background dressing from the seat, not from a debug camera parked on
top of it.

**The clay jars were metal.** `MI_Trim_Props_Vertex.004` came through the exporter
with `metalness: 1` — glTF's default when a material has no `pbrMetallicRoughness`
block, and exactly what caught the two book covers (see `BookCovers.ts`). A
conductor has no diffuse response, so in a dark room it is simply black. The fix
is that one number; base colour, normal and roughness maps all arrived intact, so
`clayJars` stops overriding the look that shipped rather than authoring a new one.

**The shelf used to light itself, and no longer does.** There was no lamp on those
boards. The smoke ran at `brightness` above 1 — HDR through `backdropNode` — so the
bottles on the upper and lower boards lit the clay between them through SSGI. Cost
of all five, measured with the on/off order flipped between rounds so a drifting
pane cannot bias it: **0.93 ms a frame**. A naive same-order alternation had read
2.17 ms.

All five lost their smoke on request and with it the shelf's only light source, so
`light_shelfLower` and `light_shelfUpper` do that job now. Transmissive glass is a
lens, not a lamp, and a lens with nothing shining on it is a dark shape. Their energy
is not free to raise: `range()` derives reach from intensity, and the cabinet's rear
panel is half a metre behind the bottles, so anything past ~1.9 floods the panel and
the whole shelf reads as a cupboard with a lamp hidden in it. At 1.9 the reach lands
at 1.0 m — just past the bottles, panel still dark. As a side effect the middle
board's clay jars are better lit than they were under the smoke.

**Dropping the shelf's smoke bought back real frame time.** Idle went from ~78 fps
(p50 12.5 ms) to ~106 fps (p50 8.5 ms), steady over three rounds with no long frames
in ~1,280 samples. That is a bigger win than the 0.93 ms the on/off measurement had
predicted, because removing the march also drops five `backdropNode` materials — and
those sample the framebuffer, not just the noise field.

**The shelf's smoke path is dormant, not deleted.** Every `wisps` is `false`, so the
`buildGlass` branch in `shelfBottles` is unreachable, and `fill`/`ceiling`/`radius`/
`scale`/`depth` on those recipes feed only that branch. It is kept because it is one
flag per bottle away and those figures are measured per mesh; the march itself is
still live and exercised by the desk pair in `glassPotions`, so this is unused code
rather than untested code.

**Colours in `lightRig.ts` are linear, and pasting an sRGB triple in is a silent
mistake.** `linear()` builds with `LinearSRGBColorSpace` and converts nothing, so a
warm candle tone swept in the browser as `0xffb877` has to be entered as
`[1, 0.479, 0.184]`. Dropped in raw as `[1, 0.72, 0.47]` it is a far paler, brighter
lamp — the shelf bottles came out milky and the lamp was not the obvious suspect.

**Glass is `backdropNode`, not `transmission`, and the difference is the whole
technique.** `MeshPhysical.transmission` renders the scene into its own pass and
samples that — and the pass does not contain transmissive objects, so glass
cannot see other glass and a bottle behind a bottle is simply absent. It is also
a second render of the scene. `viewportSharedTexture` instead samples what has
already been drawn to the frame: draw the glass transparent and sorted, and each
piece reads everything painted before it. That is the route three's own
`webgpu_backdrop` examples take, and the reference this was modelled on
(`webgpu-glass-material.vercel.app`) names those examples in its own credits.

`GlassMaterial.ts` builds it: the lookup is displaced by `normalView.xy`, which
is zero facing the eye and grows towards the silhouette — so a bottle's middle is
nearly undistorted and its shoulders carry the bend, which is how a cylinder of
glass behaves. Three fetches at three displacements give the chromatic split.
`backdropNode` is substituted for the outgoing light *inside* the lighting
context, so the surface keeps its own specular on top.

**Dispersion has to be pushed well past physical before it reads.** At the 0.35
first tried the split was there in the arithmetic and invisible on screen; 1.6 is
where the rim actually fringes. The reference does the same thing more baldly —
its panel pairs an IOR of 1.03 with a dispersion of 5, barely bending the image
while splitting it hard, because the fringe is the part the eye reads as glass.

**Measure anything in this browser pane by alternating.** The glass A/B first
read as 3.4 ms a frame on a single before/after pair, and as 0.58 ms over four
alternating rounds — the pane drifted between 40 and 92 fps for identical states
across one session. The alternating figure is the real one.

**The left shelf's potions are lit from within, not shone on.** They came through
as unlit glass three metres out in a room lit entirely by small contained pools —
readable only as silhouettes. The two potions on the desk never had that problem
for an instructive reason: they are the only bottles the asset gave an `emissive`
to. `Potions.ts` does the same at a lower level, well under the desk pair's
2.1–2.6 so the sigil stays the brightest thing. A lamp would have had to be bright
enough to carry three metres, and `lightRig.ts` records what happens when one of
them starts washing the stone. The glow also feeds SSGI, so the boards take a
little colour from what stands on them.

**Eight bottles share one material.** `Purple Potion` is on `Bottle001, 002,
004..009` — the left shelf, the right shelf, a high shelf *and* the desk — so
anything set on it lights bottles all over the room, including one beside the
parchment. Every entry in `Potions.ts` clones onto its own mesh first. `Bottle002`
and `Bottle003` on the right shelf have the same darkness problem and are one line
each away from the same fix.

**Camera-look lag is not compilation, and a wider warm-up does not help.** Looking
around used to build two pipelines the first time, ~40 ms each, and they never came
back — a second sweep built none. Re-measured since, with the backend hooked and a
full sweep (yaw to both limits, pitch to both) taken as the *first* thing after the
arrival: **zero pipelines built**, on this machine at this canvas size. Whatever
those two were, moving `rig.arrive` ahead of the warm-up appears to have caught
them. The rest of this paragraph still holds. Warming from a 100° lens spun through four right
angles was tried: it compiled two pipelines at load that turned out to be
*different* ones, left the same two to be built at runtime, and was reverted.
Measured otherwise, turning the view costs nothing at all: 86 fps still against
94 fps while sweeping continuously, zero long frames in either. Anything sustained
while turning is the frame cost itself — SSGI is roughly half the frame — and the
levers for that are `gi.stepCount` / `gi.sliceCount` in `Post.ts`, or lowering
`BUDGET` in `Resolution.ts`.

**The plateau and the wipe answer two different situations, and one global pace
cannot serve both.** While the nib is working, a long plateau is what lets a
five-stroke sigil still be whole when the last stroke lands. Once the quill
stops, that same plateau is dead time — you are watching a line you have finished
with, waiting for it to begin leaving.

Scaling the whole curve down trades one for the other, and it was tried twice
(8.0 → 6.2 → 4.8) before the obvious thing: **the fade hurries only once the nib
has been still**, which is the case being complained about and no other.
`HASTE_AFTER` (0.9 s) has to clear the pause between two strokes of one sigil or
lining up the next stroke would eat the last one; `HASTE` (2.2) is held down
because it divides the *wipe* as well as the plateau, and the wipe is the part
that looks good. The stillness is measured in the surface's own clock — `lastMark`
is the ink-age of the most recent mark — so nothing new is wired in from the
recorder, and the motes stay in step for free: they ride `age` too.

Measured on a held line: stopping used to mean 4.8 s before the page was clear.
It is now **2.09 s to the wipe starting and 2.93 s to gone**. A five-stroke
pentagram drawn with 0.6 s pauses between strokes still casts.

**Whether a line dies as a wipe or as a block is set by `INK_SOLID / INK_VISIBLE`,
not by `INK_LIFETIME`.** The gap between the two knees is
`INK_TAU · ln( SOLID / VISIBLE )` seconds — how long any *one* texel takes to go
from solid to invisible — and it has to be short against the spread of ages along
a stroke, or every texel sits at a different point on the curve and they all
still look the same. At `SOLID` 0.45 that band was **5.5 s** against the ~0.6 s a
hand-drawn line spans: the gradient occupied a ninth of the band and a line faded
as one flat block. At 0.13 the band is 1.2 s and the dissolve visibly travels the
line from its oldest end.

Shortening the band did *not* shorten the ink. The plateau is
`INK_TAU · ln( 0.995 / SOLID )`, so lowering the knee **lengthened** it, 2.5 s →
5.0 s. Legibility and a crisp dissolve were never in tension; they were only in
tension while both were being asked of one number.

**`takeVanished` collapses a frame's worth of marks into one point, and the
emitter can only be in one place per frame.** That is fine for geometry — the
kernel smears each frame's spawns from the emitter's previous position to its
current one — but it loses the *length*, and the length is what the spawn rate
has to be proportional to. Measured on a straight line: 112 marks recorded, **5
emitter positions**, and the trail came out as a couple of bursts at the ends.
`VanishPoint.span` now reports page-widths eaten per frame and `InkMotes` spawns
per unit of line, so a trail keeps its density whether the fade is walking a
slowly drawn stroke or a burn is taking the whole sigil in five frames.

**`JUMP` was firing on ordinary sweeps rather than on jumps.** At 0.09 page-widths
a burn — which runs the fade at `INK_BURN_RATE` and crosses a stroke in about five
frames — cleared it on every one of those steps, so the emitter teleported each
time and the smear that fills between frames was thrown away. That is the whole of
"only the start and the end of the line release particles". Pen-lifts are already
caught properly by `VanishPoint.jumped`, which reads the `first` flag on the mark
instead of guessing from a distance, so `JUMP` is only the backstop for a genuine
teleport and belongs well outside anything a sweep can reach. 0.09 → 0.4 took the
teleports on that same line from 5 to 1.

**What made the trail read as smoke**, in rough order of blame — and the first
one is not motion at all:

1. **The sprite was a soft circle.** That is the silhouette of a puff, and no
   amount of tuning the motion escapes it. `EmitterState.sparkle` blends the mask
   towards a four-pointed glint — a hard core plus two crossed spikes, each
   rotated by the particle's own hash so the pool is not a field of plus signs.
   Built from the same quad: no extra geometry, no extra draw. Defaults to 0, so
   every spell keeps the round sprite it was tuned against.
2. **`growth` above zero.** A particle that swells over its life is a puff by
   definition. Now 0.
3. **Rising.** Buoyancy upward gave the trail a column-of-smoke shape. It is
   gravity now (-0.62) against a real launch (`speed` 0.19, and `shape: 1` fires
   straight up), so a mote arcs: about 2.7 cm at 0.28 s, back at the sheet by
   0.56 s. `damping` had to come down to 0.9 — at 2.0 the launch was eaten inside
   a few frames and every mote just sagged where it was born.
4. **Turbulence**, now 0.07. With a real arc to follow, the noise had nothing left
   to add but haze.
5. **A `GLOW_COOL` of 1.4** — under the 1.15 the bloom opens at, so the tail of
   every trail was a dim smear that lit nothing. Now 4.0.

`lifeSpan` is set from the arc rather than by feel: past 0.56 s a mote is below
the paper, where the desk occludes it, so 1.0 s spends most of the life above the
page and lets the alpha curve take the rest.

**`REST` is a snapshot of the resting emitter taken at module load.** `EMITTER` is
mutated in place every frame — it is the object handed to `configure` — so by the
time the flare wants to blend *from* the resting values they are gone. The flare
reads them off the copy, so changing a resting number moves the flare's baseline
with it instead of leaving a second copy to be remembered.

**The ink trail is two populations out of one kernel.** `ParticleField` splits its
pool on a stable per-particle hash — `dust` is the share that gets its own
buoyancy, emission and size, so one in five falls through the rising embers as
paper dust. It costs nothing: no second field, no second draw call, no new
pipeline, because the choice is a hash rather than a uniform and the same
compiled kernel runs both. The hash is deliberately *not* the `grain` the
material already uses for size spread — sharing it would tie dust-ness to size
and every falling particle would be one of the small ones, which the eye picks up
at once. The dust is kept under the 1.15 bloom threshold on purpose: an ember at
`glow` 4.2 halos and the dust must not, or the two read as one shower of sparks
at two speeds.

`glowFocus` folds the emission into the heat ramp instead of applying it flat, so
only the young half of a particle's life crosses the bloom. That is what turns a
uniform ribbon into a gradient — the emitter is a single point sweeping the line,
so the ribbon's far end is simply its oldest particles, and making brightness
follow age is the same thing as making it follow distance back along the stroke.
Both default to off, so every spell's curve is exactly as it was.

**The page reacts to ink that is on it, and keeps no record.** Channel `z` of the
ink buffer was spare, so the soak costs no bandwidth — same texture, same
dispatch, same fetch. It is a wider, softer nib footprint written beside the
stroke, and it **fades on `inkFade`, the ink's own curve**. That is what
guarantees no residue: the soak starts at 0.5 where the ink starts at 0.995 and
both are multiplied by the identical factor every frame, so the halo is strictly
below the ink at all times and reaches any threshold first — including through a
burn, which simply runs that same fade fast.

It was briefly given a slow decay of its own so the parchment would keep a record
of what had been written on it. That is a different feature and not a welcome
one: it printed every sigil on the page for a quarter of a minute and a cast
tripled it on the way out. Do not reintroduce it without asking.

Three mistakes on the way there, all worth not repeating:

- **The bleed was first derived from ink sitting between two low thresholds.** A
  band in *value* is a band in *time*: every texel of every stroke crosses it on
  the way down, so whole strokes turned into brown clouds as they faded instead
  of thinning. It is a written footprint now, which is spatial.
- **It was then accumulated per second, and stayed invisible.** A nib in motion
  covers any given texel for a handful of frames, so a per-second gain integrated
  to about 0.03. The footprint wets the fibres; the strength is a property of the
  ink, not of how long the nib loitered. It is a `max` now.
- **A cast could not darken the page through the nib footprint.** No nib is drawn
  while a sigil burns off — the burn only runs the fade fast — so a burn gain
  against that footprint is a gain against zero. Moot now that nothing survives a
  burn, but the trap is still there for anything else written at nib time.

**The flare is fireflies, and the count is the whole trick.** `spawnRate` is a
per-frame chance that a *dead* particle wakes, so it only means anything read
against the pool and the window. The sweep lasts about 0.85 s —
`INK_BURN_SECONDS` plus `LINGER`, some 51 frames — so the share of the 700-strong
pool that wakes is `1 - (1 - rate)^51`. At the flare's first setting of 0.32 that
is essentially all of it: 700 lights, which is a wall, not a swarm. At 0.01 it is
about a third, and a sigil comes apart into points you can follow one at a time.
Anything that changes the pool size, the burn length or `LINGER` changes what a
given rate means.

Two supporting pieces. `twinkle` gives every particle its own phase *and* its own
rate, both from stable hashes — a shared clock would make the pool blink in
unison and read as a strobe. And the flare's spawn is gated on the fade front
still delivering line: once the sigil is consumed the emitter stops moving, and
spawning past that piles every remaining firefly onto the last place it stood,
which is invisible in a dense shower and glaring in a sparse one.

**Testing the flare needs a real draw and a quiet spell.** A sigil stamped in one
frame (`demo( g, s, 0 )`) gives every mark the same age, so the front consumes
the whole line at once and the flare comes out as a clump at a single point —
an artifact of the test, not of the effect. And a bound glyph floods the page
with its own spell light. `demo( 'square', 0.34, 2.4 )` is the useful case:
legible, bound to nothing, so it sputters and burns with nothing else lit, and
`atelierDebug.motes.flare()` supplies the flare the sputter path does not.

**The flare rides the burn rather than duplicating it.** `InkSurface.burnAway`
runs the fade at `INK_BURN_RATE`, which drags the fade front along every
remaining stroke inside `INK_BURN_SECONDS` — so the emitter is already being
hauled over the whole sigil, and `InkMotes.flare` only has to supply the
character. `buoyancy` and `drift` are uniforms the kernel applies to *every* live
particle each frame, not just to new ones, which is exactly what lifting the line
off the page as a sheet requires: everything already shed along the stroke rises
together the moment the flare comes on. It eases out over its own clock rather
than being switched off, so the sheet disperses instead of stopping.

**Two traps the ink buffer sets.** The fade is a multiply the page applies to
itself every frame, and the storage textures are `HalfFloatType` *because of
it*: at eight bits a five-second fade is ~0.996 per frame, every texel under
~135/255 loses less than half a quantum, and the ink stalls at half strength
instead of fading. The old burn-off survived on `rgba8unorm` only because 0.955
per frame clears a quantum until it stalls below the visibility threshold.

**Transparent glows are marked, not shaded.** `scene/gbuffer.ts` writes a normal
facing away from the camera — impossible for visible geometry — and `Post` reads
it as "this pixel is a glow" and gives it no occlusion at all. Three attempts
before it tried to fabricate a plausible *surface* normal instead (the sprite's
own, world up, world up in view space) and each stained the geometry it was not
chosen for: dark discs under the ink motes on the desk, a plume-shaped shadow
across the back wall behind a fireball. If a transparent effect ever grows a
shadow again, `post.setView( 'ao' )` shows it in one frame and `'plain'` does
not.

**Isolate before tuning.** Several bugs here looked like lighting or exposure
problems and were not: one `RectAreaLight` blacking out the room, an anisotropic
nib blowing out the page, SSGI blocks that turned out to be the GI and not the
shadow map. Hiding one object, or flipping `post.setView('plain')` on a frozen
frame, settled each in one step.

---

## The Blender scene is live

The source .blend is open with the **Blender MCP** addon connected, and it is the
source of truth for anything the GLB lost. The light rig, the emissive strengths,
the walnut floor's real albedo and the rune's alpha mask all came from querying it
directly rather than matching by eye. Worth doing again before guessing at any
look question — `mcp__blender__execute_blender_code` with a small script that
prints JSON works well.

Coordinate conversion is `three = ( bx, bz, -by )`; the paper's transform confirms
it in both directions.

---

## Open threads

Nothing here is broken — these are deliberate stopping points.

1. **Temporal AA is off.** TRAA is the natural partner for SSGI, but the spells are
   GPU particle systems whose points move in storage buffers, so the velocity
   buffer reports them stationary and the fireball comes apart into blocks. The
   scene pass still writes `velocity`, so the work has somewhere to land: give
   `ParticleField` a previous-position buffer and write real per-particle velocity,
   then swap `fxaa` for `traa` in `Post.ts`.
2. **The cauldron's volume proxy is not drawn.** `fx_cauldron_smoke` is a Cycles
   volume with no surface shader. Options: raymarch it, or fake a plume with a
   `ParticleField` — the machinery already exists.
3. **The quill plays no part in casting.** It is now in hand from the moment the
   pointer reaches the parchment until it leaves — `StrokeRecorder.activePoint`
   answers to hovering and to `armed`, not to the pointer button, so it follows the
   cursor over a blank page, does not flop onto the desk between the strokes of one
   glyph, and stays up through the stillness before the cast. `Quill` runs three
   approach rates (write / carry / settle) because tracking ink, carrying a pen and
   laying one down are different motions; at the old single rate the nib trailed a
   fast stroke by 8 cm. What is still open is the cast itself: it lowers as the
   spell erupts. Making it raise into a flourish and launch from the nib was offered
   and left open. Related: its writing pose sits fairly
   flat to the page — `Quill.setHeldDirection( x, y, z )` is live-tunable from the
   console for anyone who wants to try angles.
4. **The floor rune still breathes** in brightness at rest (rotation is fully
   stopped). Freezing the pulse to a constant glow is a one-line change if wanted.
5. **Bloom threshold is 1.15 and the desk spotlight is gone** — both were reactions
   to the quill's glare, whose real cause (`anisotropy` on the nib) is now fixed.
   Under AgX and the ported rig the candles could probably take more bloom.
6. **The light scales are eyeballed.** `POINT_SCALE 0.08 / AREA_SCALE 0.02 /
   SUN_SCALE 0.1` in `lightRig.ts` preserve the .blend's ratios exactly but were
   matched to the reference by eye, not derived. One dial per class if the balance
   ever needs moving.
7. **The camera is not exactly the authored one.** `cam_firstPerson_spellTable`
   sits at (0, 1.455, 3.527) pitched 12.8° down — within 20 cm and 2° of
   `CAM_IDLE`, which is positioned around the HUD plates instead.

---

## Risks

- **This is not a git repository.** Nothing is under version control and there is
  no history behind any of the above. `git init` early.
- `video.mp4` in the root is yours; nothing here reads it.
- WebGPU only, by design — `navigator.gpu` missing shows a message and stops.
