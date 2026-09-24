# Witch Hat Atelier — sigil casting

A Three.js / WebGPU scene where you sit behind the witch's desk, draw a sigil on the
parchment with the quill, and the sigil casts a spell. Everything that matters —
the ink on the page and the fireball — runs as TSL compute shaders on the GPU.

```bash
npm install
npm run dev
```

Then open http://localhost:5173 in a **WebGPU-capable browser** (Chrome/Edge 113+,
Safari 26+). There is no WebGL fallback: the ink and the spell VFX are compute
shaders, and a fallback path would be a different program.

## Playing

| Input | Effect |
| --- | --- |
| Move the pointer over the parchment | the camera leans in over the desk |
| Drag on the parchment | the quill draws; ink soaks into the page |
| Drag anywhere else (or right-drag) | look around the room from your seat |
| `Esc`, or reach for the page | face the desk again, ready to cast |
| — while drawing | the page reads along: the ink glows in the spell's colour and the grimoire lights the matching sigil |
| Stop moving for ~1 s | the sigil resolves and casts |
| — after it casts | the camera sits back to watch, then returns to the page if the quill is still over it |
| `X` | wipe the page |
| `C` | debug free camera (OrbitControls) |
| `Esc` | sit back |

Three sigils are bound:

| Draw | Spell |
| --- | --- |
| **Pentagram** — five-pointed star, one stroke | **Fireball.** Gathers over the page, arcs downrange, detonates on the training dummy. |
| **Bolt** — a Z, one stroke | **Lightning.** No wind-up: a branching arc snaps from the quill to the dummy, with a screen flash and falling sparks. |
| **Triangle** — one stroke | **Awaken the Rune.** The 6.6 m sigil cut into the floor spins up and brightens, twelve pillars of light stand on its ring, and embers climb out of it. |
| **Circle** — a ring | **Sigil of Protection.** A dome of hardened air. Its size, position *and* lifetime all come from the ring you drew — see below. |

The recognizer also knows the square, spiral, cross and caret; those are
legible but bound to nothing, so they sputter out. That distinction is deliberate —
"I drew it wrong" and "that sigil does nothing" should not look alike.

## How it works

### The room

`public/Witch_Hat_Atelier_fixed.glb` (Draco + WebP, 361 meshes) is the source of
truth for every position in `src/config.ts` — desk, parchment, stool, dummy, floor
rune. On load every material is converted to a `NodeMaterial`
(`renderer.library.fromMaterial`) so TSL can be grafted onto the asset's own
shading: the cauldron boils, the floor rune turns, and the GLB's solid "smoke
volume" cone is rebuilt as drifting fractal noise that thins out with height. The
flames are the exception — they are not the asset's geometry at all, see below.

Note that GLTFLoader sanitises node names — Blender's `Torch.002` arrives as
`Torch002` — which `findNode` in `src/scene/Atelier.ts` handles.

**Textures are capped at 2048 a side on load.** The GLB ships two 4096² maps —
the parchment's paper noise, and the nature atlas the three mushrooms share — and
at RGBA8 with mips each of those is 85 MB of texture memory on its own. The room's
62 distinct maps came to about 1.2 GB between them.

That is worth caring about because of *how* it failed rather than how much it
cost. Frame rate was fine; what happened instead was that roughly one transition
in ten dropped a single frame of 25–60 ms. Chasing it through the camera code was
a dead end — the giveaway was that the same rate of dropped frames occurs with the
camera **completely still**, and that the CPU time inside `post.render()` is 3 ms
even on a 51 ms frame. It was never the transition; a background hitch is simply
invisible until something is moving. Capping the two oversized maps takes about
260 MB back, and twenty transitions and five still windows afterwards produced
none. That is a rare event measured over a small sample, so treat it as improved
rather than cured.

Only maps above the cap are touched, which today is those two: one is *noise*, the
other is shared by three props a hand's breadth across, and neither can show the
difference. Everything on the desk is already at or under 2048 and is left alone
deliberately — the page and the quill are close enough to the camera to show it.

Two asset properties are overridden on load, both in `Atelier.ts` and both worth
knowing about if you swap the GLB:

- **The gold part named `Pen_Nib_Color` carries `KHR_materials_anisotropy` at 0.25
  on a `roughness = 1, metalness = 1` surface** — the only material in the room that
  uses the extension at all. That combination blows the anisotropic highlight out
  into a bloom halo several times the size of the part itself, washing out the page
  underneath it. Setting `anisotropy = 0` removes the glare completely; the quill's
  albedo is also trimmed to 0.7 because the feather and ferrule ship pure white.
  All four of the quill's materials belong to it alone, so none of this leaks.

  Note the naming trap while you are in there: `Pen_Nib_Color` is the gold *collar*,
  not the nib. The actual steel nib is a separate child (`Plane.002`, material
  "Stainless Steel") hanging 8 cm further along the shaft, which is why
  `Quill.measureTip` derives the writing point from the pen's full local bounds
  rather than trusting any one part.
- **The floor rune has no colour map**, only an emissive one — see the spells
  section.

### Ink (`src/ink/InkSurface.ts`)

The page's ink lives in a pair of ping-ponged `StorageTexture`s, written by a TSL
compute kernel over all 1024×1024 texels and sampled by the parchment's own
material:

- `.x` — ink soaked into the fibres
- `.y` — heat, which drives the emissive charge glow and the burn-off after casting

Stroke segments arrive as up to 24 `vec4` uniforms per frame. **One dispatch per
frame is a hard constraint** — every slot lives in the same uniform buffer, so a
second dispatch would just re-read the last write — so a faster-than-60 Hz pointer
is decimated onto those slots rather than split across dispatches. Note that
`decimate` returns the queue array itself when it already fits, so `update` rebinds
`this.queue` rather than emptying it in place; truncating it would blank the batch
on its way to the GPU, and only for the ordinary few-segments-per-frame case. The kernel
brackets the brush loop with the frame's bounding box, so warps nowhere near the
quill skip it, and the whole dispatch stops once the page has settled.

Ink is addressed by object-space position rather than the mesh's UVs, so the
mapping does not depend on how the page was unwrapped in the source asset.

**Every pipeline is compiled before the first frame.** WebGPU builds a render
pipeline the first time a material is actually drawn, and most of this room is not
drawn at startup: a fireball's core, the lightning ribbons, the ward's shell and
the circle's pillars only reach the screen the first time that spell is cast. Left
alone, the first cast of each pays for its own compilation as a stall — and it
lands *mid-animation*, which is both the worst moment for it and the hardest place
to attribute it, because what stutters is the animation rather than the frame that
caused it.

`renderer.compileAsync` walks what would be rendered and skips anything hidden, so
the load pass shows everything for the length of the call and puts it back
afterwards. Nothing is drawn in between, so there is no frame where the spells
appear. It builds 76 pipelines up front, and the loading bar says so.

### Recognition (`src/recognize/`)

`pdollar.ts` is the $P point-cloud recognizer (Vatavu, Anthony & Wobbrock, 2012):
resample to 32 points, scale to a unit box, translate to the centroid, then greedy
cloud matching. No training, no dependencies, and stroke count/order/direction do
not matter.

`glyphs.ts` generates the templates parametrically rather than recording them by
hand, each stored at ±20° of rotation for a little slack.

**A class may have more than one exemplar, and the bolt needs three.** $P is happy
to hold several templates under one name and take the best, which matters when the
*name* covers more than one shape. The bolt's grimoire art is a stylised zigzag
whose return stroke stops short of the left edge, but the hint says "a Z" — and a
Z has square corners, with its return stroke running the whole way down and a
horizontal base. Those are far enough apart that a cleanly drawn Z scored **26%**
against the zigzag alone, against a threshold of 48: the one sigil the hint asks
for by name was the one sigil that could not be cast.

The third exemplar is a narrow Z, and it is there because normalising to a unit
*box* is not the same as preserving proportions. A Z drawn tall and thin resamples
differently from a square one — arc length falls differently across its strokes —
and it came out at 49%, one point over the line. Measured across six simulated
hands, the worst case for each: true Z 84%, narrow 82%, very narrow 62%, short
base 68%, sloping base 73%, the zigzag itself 89%. Scribbles stay at 27–38% and
the neighbouring glyphs are untouched — caret 95%, triangle 91%.

The one shape still outside is a Z drawn *wide and flat*, which lands at 37–40%
and reads as illegible. It is an unnatural way to write a Z and a fourth exemplar
would start pulling scribbles towards the bolt, so it is left alone knowingly.

**Matching happens in screen space, not on the page.** This is the single thing
that makes hand-drawn sigils work. The parchment is tilted ~60° away and seen in
perspective, so a shape drawn as a star *on screen* lands on the paper as a warped
star — and matching that warp against un-warped templates costs a perfect sigil
most of its score, the more so the bigger you draw. Measured with the identical
point stream:

| sigil size | matched on the page | matched on screen |
| --- | --- | --- |
| small | 0.84 | 1.00 |
| half the sheet | 0.80 | 1.00 |
| full sheet | 0.27–0.74 | 1.00 |

So `StrokeRecorder` keeps two copies of every sample: screen space for the
recognizer, page space for the ink and the sigil's centre. Three consequences
follow, all of them load-bearing:

- **The cloud is re-projected, not captured.** Every sample is stored in page
  space, and the screen-space cloud the recogniser matches is rebuilt by
  projecting all of them through the *current* camera each time it reads. So the
  whole shape is always seen through one camera, and a camera in motion cannot
  shear it.

  This replaced freezing the camera, and the freeze was worse than it looked.
  `setLocked` used to stop the lean-in dead — including an ease already under way
  — so starting to draw before the camera arrived cut the move off wherever it had
  got to, typically about 7% in. That was visible as the camera "stopping halfway",
  and it also meant the sigil was then matched through a nearly-seated, heavily
  foreshortened view of the page, which is the projection the measurements below
  show costing a sigil most of its score. Drawing quickly was quietly punished
  twice.

  Locking now fixes the *goal* only — nothing can redirect the framing mid-stroke
  — while the lean's own ease runs to completion. Measured through the full trace
  path, a sigil drawn while the camera is still moving now scores exactly what the
  same sigil scores drawn from a settled framing: pentagram 83%, bolt 70%, circle
  92%, triangle 73%, both ways.

  **Everything else about the camera holds still for the length of a sigil**, and
  getting there took three passes because the lock had three leaks — none of them
  the goal it was written to guard:

  - **the stillness timer.** The page casts after `CAST_DELAY` of quiet, and the
    only thing resetting that countdown was ink actually going down. Lift the pen
    at the end of one stroke, carry it across the sheet to start the next, and the
    timer ran the whole way: the sigil resolved on whatever half of it existed and
    the camera sat back to cast it. The HUD said *hold still to cast* over a pen
    that was visibly moving. A quill that has moved more than `STILL_SLOP` — an
    order of magnitude off both a resting hand's jitter and a deliberate carry —
    now resets it;
  - **`shake`.** The goal, the look-around and the hand-back all deferred to the
    lock; a jolt did not. Cast, start the next sigil while the shot is still in the
    air, and the fireball detonates under your hand: **2.6° of camera turn**,
    measured, which at this framing is the page sliding sideways under a line being
    drawn on it. Dropped rather than deferred — delivered after the sigil resolves
    it would be a knock with nothing on screen to explain it. No spell loses its
    own jolt, because `onCast` clears the lock before it calls `cast`;
  - **a recentring already in flight.** Blocking new requests is not enough when
    the request that matters was made *before* the pen went down: reaching for the
    page is what calls `recentre`, so a player who was looking at the room and then
    draws has a gaze easing back at rate 5 — about a second, the length of a
    stroke. **8.7°**, measured from a view 0.22 rad off the desk. `setLocked` now
    commits the gaze *where it is* rather than merely refusing to re-aim it.

  Frozen, not finished, in that last case: snapping the gaze straight as the stroke
  starts would be a cut in the worst possible place, and the sigil does not care —
  the recogniser re-projects the whole cloud through the current camera, so an
  off-centre gaze that holds still is just a slightly different projection, and
  `onCast` recentres properly once the lock lifts.

  This is deliberately *not* what the old rig did to `t`, and the distinction is
  the whole of it. The lean-in is a move towards the page that the stroke itself
  asked for, and freezing that stopped the camera halfway; a recentring is a
  leftover from looking at the room and has no business running while a line is
  being drawn. Measured over a two-stroke sigil that carries the quill off the
  sheet and back, takes a right-drag and an `Esc`, and has a fireball detonate
  through it: **0.000° of turn, 0.00 mm of drift, 0.0000 of lean change** — while
  the lean-in from the seat still completes, the gaze still recentres a second
  after the cast, the bolt still lands its own jolt, and looking around still turns
  28.9° when nothing is being drawn.
- **The framing is part of the shape, so a stroke takes the camera.** If the
  sigil is matched in screen space then the projection it is matched through is
  part of it, and the two framings do not project the page the same way at all.
  Measured by projecting the sheet's own corners: leaned in, it is **1.04** times
  wider than tall on screen; from the seat, **2.03** — and that is independent of
  the window, since aspect-correcting the NDC cancels the window's own shape.

  So a Z drawn to fill the page from the seat reaches the recogniser twice as wide
  as tall, past the widest exemplar the bolt carries (1.32). It is not a near miss:
  the identical traced Z casts *Lightning at 61%* leaned in and comes back
  ***"Illegible — closest was pentagram"*** from the seat. Against the simulated
  hand the bolt holds 40/40 from an aspect of 0.4 all the way to 1.7, and falls to
  20/40 at 2.0 — which is exactly where the seated page puts it.

  The fix is not another exemplar for a shape that only exists because the camera
  was in the wrong place. `onDrawStart` now takes the camera unconditionally: a
  stroke outranks a lean-out, a spell still in the air, and the arrival itself. The
  three ways to be drawing from the seat were casting again before the last spell
  had landed, drawing during the 2.2 s walk-in, and `castLock` holding the framing
  for a spell — all three now put you over the page, and all three cast the same Z
  at 62%.
- **Strokes may run past the edge of the paper.** Once a stroke is under way the
  raycast falls back to the sheet's infinite plane, so overshooting the parchment
  no longer throws those samples away (which used to mangle big sigils, or leave
  too few points to read at all). The ink still stops at the paper.
- **The minimum-distance filter measures in screen space too.** On the page it
  discarded every sample taken past the edge, where the clamped page position stops
  changing.

**How coarsely the sigil is re-sampled matters more than anything else.** A real
hand-drawn star — recognisable at a glance, but with one limb reaching 30% further
than the others and tip angles spanning 57°–99° instead of a regular 72° — scored
0.31 at 32 sample points and was rejected. The same star scores 0.55 at 24 points.
Coarse sampling averages out local wobble so one over-long limb stops dominating
the total, while the one-to-one point pairing that gives $P its discrimination is
untouched:

| `NUM_POINTS` | that hand-drawn star | genuine attempts | scribbles |
| --- | --- | --- | --- |
| 32 | 0.31 ✗ | 0.43–0.62 | up to 0.34 |
| **24** | **0.55 ✓** | 0.54–0.74 | up to 0.50 |
| 20 | 0.61 | 0.67–0.74 | up to 0.65 |

24 is the knee — below it scribbles start scoring like sigils. Worth noting what
did *not* work, since all three are the obvious things to reach for: matching
against families of pre-deformed templates (64 per glyph lifted that star only to
0.63, and made scribble rejection *worse*); capping each point's contribution so a
stray limb cannot dominate (0.31 → 0.31, with the margin over the runner-up
collapsing); and OCR-style rasterise-and-blur matching (ranks correctly, but a
random scribble scores 0.87, so the score is useless as a threshold).

Measured through the real pipeline with a deliberately sloppy simulated hand (±12%
per-vertex, ±15° rotation, sizes from a third of the sheet to the whole thing):
**39/40 accepted, 0/12 scribbles accepted.** Genuine attempts run 0.48–0.90 with a
median of 0.70; scribbles top out at 0.43. That is where `RECOGNITION_THRESHOLD`
= 0.48 comes from. The correct glyph essentially always wins on name, so the only
question the threshold answers is "did they mean anything at all" — and the cost of
the two mistakes is lopsided: a false accept casts the wrong spell, a false reject
reads as the game being broken.

**Reading along.** The page is re-read about ten times a second while you draw, so
the sigil announces itself before it fires: the ink's charge glow cross-fades to
that spell's colour (`Spell.ink`), the grimoire card lights up, and the HUD names it
in italics until it actually casts. Those live reads run in `quick` mode — un-rotated
templates only, roughly five times cheaper — and switch to a full read the moment
the quill lifts, so a tilted sigil still gets named before it casts rather than
casting unannounced. The preview uses the same threshold as the verdict: if you can
see the name, it will fire.

### Spells (`src/spells/`)

`ParticleField.ts` is the shared engine: a pool of particles living in three
storage buffers, advanced by one TSL compute kernel. The CPU only describes the
emitter — where it is, what shape it spawns on, how fast it spits, how hard it
pulls — so a fireball's charge, a shower of sparks and a column of rising embers
are all the same kernel under different uniforms. Particles respawn smeared along
the distance the emitter covered that frame, so a fast-moving source leaves a rope
of flame instead of a bead chain.

**The sprite is a spark, not a puff.** Five emitter knobs, all defaulting to the
old behaviour, are what turned the fire from a cloud of translucent orange dots
into something that reads as an explosion. `stretch` turns each quad to face the
way it is moving on screen and lengthens it by that many seconds of travel — a
motion-blur exposure — so the fast leaders of a burst draw long streaks and the
slow body stays a dot, with every speed in the pool visible at once. `square`
blends the soft disc towards a hard-edged box, which with `stretch` is a bar.
`fadeSize` makes a particle die by shrinking rather than by fading, so a shower
keeps its contrast to the last frame instead of dissolving into a wash. `opacity`
is the alpha the material used to bake in at 0.22: at 1 the core is solid and
`glow` means what it says. And `inherit` hands a newborn a share of the emitter's
own velocity, so the wake behind a shot flies on behind it like a comet's tail
instead of dropping off the arc. Fireball and the ink motes use all of them;
lightning, the rune and the ward are untouched.

Note that particles move *only* while their field is stepped: an effect that stops
stepping with particles still alive leaves them frozen in the air, which is why
`Lightning` and `RuneAwakening` both keep running for a beat after they finish.

**Weight is a uniform, and until recently nothing had any.** `buoyancy` is a signed
vertical acceleration and it defaults to **+0.45** — upwards, which is right for the
motes climbing off a burning page and wrong for anything that was thrown. The
fireball never set it, and its burst handed the embers another 0.9 of upward drift
on top, so a detonation left a ball of sparks expanding evenly around the dummy and
hanging there: the one shape that says nothing about weight, about which way is
down, or about where the shot came from.

**Nor is gravity enough on its own to stop a burst being a ball**, and the reason is
worth stating plainly: a shell thrown at one speed in every direction *is* a sphere,
and it stays one however hard it is pulled down, because every point of it is pulled
the same. Two evennesses have to go, and there is a uniform for each. `spray` breaks
the speed — cubing the roll leaves most of the pool barely moving and throws a thin
tail of leaders three times as far, so there is no surface left to be spherical.
`updraft` breaks the symmetry about the horizontal, the one an explosion never has: a
minority is kicked hard upwards into a plume and the rest is driven down into the
floor, and with gravity underneath the plume arcs over and rains back through them.
That crossing traffic — some going up while others come down — is what reads as
*blast* rather than *bubble*. The third lever is `turbulent`, which the fireball now
asks for: nine thousand particles flying straight are nine thousand radii of the same
sphere, and a noise field that pushes neighbours together tears the shell into
billows instead.

Gravity alone does not finish the job either, because a spark that sinks through the
flagstones is worse than one that never fell — the room stops having a floor for as
long as you are watching it happen. `floor` is a height the pool cannot pass; an
ember that reaches it keeps what it had sideways, loses most of that to the stone
and bounces a quarter of what it arrived with, so the shower lands at the foot of
whatever was hit, skids, and burns out there. It defaults far below the room, so
every effect that has not asked for weight is untouched.

**Every transparent effect wears the MRT override in `scene/gbuffer.ts`**, and
the reasoning is worth reading before touching any of them — see that file.

That sentence was aspirational for a while, which is worth recording because of how
the gap presented. The particle fields, the links, the flames and the orbs all wore
it; the *spell meshes* — the rune's pillars, the ward's shell, the bolt's ribbons,
the fireball's core and shockwave — did not, and so wrote real normals into the
buffer SSGI reads. A 2.6 m cylinder standing on the floor is a very convincing
surface to write, so the AO pass shaded the rune's flame as though it were a pillar
of stone. What that looks like is not "the fire is too dark": it is a **hard-edged
shadow** where everything else about the effect is soft, because what shows through
is the silhouette of the *mesh* rather than of the fire drawn on it. The tell is the
one this file already gives — a stain in `post.setView( 'ao' )` that is absent from
`'plain'`.

The
short version: the scene pass writes `normal` and SSGI reads it, so a
camera-facing sprite drawn over the floor tells the AO pass that the floor faces
the camera. The hemisphere then points into the floor, finds it occluding in
every direction, and comes back black. That is the dark disc under every
particle.

It took three attempts to land, and the two failures are the instructive part:

- **Discarding the transparent fragments** only shrinks the artefact to the shape
  of whatever still draws. The dark *squares* became dark *discs*. (The discards
  are still there — they save shading work — but they were never the fix.)
- **Writing zeroes to the auxiliary targets** does nothing, because those targets
  default to `NoBlending`: a material's write replaces what is under it rather
  than blending with it. A zero normal is not "no normal", it is a degenerate one,
  and AO reads it worse than a wrong one. Borrowing the material's blend mode with
  `setBlendMode` does not rescue it either — on this version that is honoured for
  `output` alone.

Diagnosis notes, since this class of bug reads as a lighting fault: `G` → `plain`
makes it vanish (no SSGI, no artefact), `G` → `ao` shows the whole particle web as
solid black occluders, and hiding one mesh at a time says which. Forcing
`diffuseColor` to red and seeing *no* change is what ruled the albedo out and left
the normal.

One unrelated trap found on the way, worth writing down: `.discard()` appends to
the shader stack currently being built, so a node graph assembled the ordinary way
— out in a material's constructor — has no stack to append to and the call
compiles away to nothing, silently. It has to be inside an `Fn`.

- **`Fireball.ts`** — 9,216 particles, plus a noise-displaced plasma core, an
  expanding fresnel shockwave and a moving light. Charge → arc → detonate.

  Three phases, three weights. The gather still rises (+0.3) because that is heat
  pooling; the trail falls away behind the arc (−1.6), which is what makes a lobbed
  shot read as lobbed rather than as a line with a fringe; and the burst is pulled
  down at **−5.2** onto a floor at 0.02. That figure is chosen against the burst's
  own numbers, not against physics: damping is 1.9, so terminal fall is about 2.7
  m/s, and from a bullseye 1.54 m up the shower spends its first third of a second
  going outwards and the rest of its 1.35 s life coming down — landing at the
  dummy's feet about when it burns out. Real gravity puts it there three times
  faster and reads as sparks being *dropped* rather than thrown.

  A quarter of the burst is `dust`: heavier, falling nearly twice as hard, glowing
  under the bloom threshold instead of over it. Two speeds out of one kernel is what
  gives a shower depth — one population arcs out and rains, the other drops straight
  through it.

  **And then the ash**, which is its own pool of 2,048 rather than a third
  population inside the embers'. `ParticleField` can already run two out of one
  kernel — that is what `dust` is — but they share a palette, a lifetime and a
  damping, and ash disagrees with an ember about all three: it is grey rather than
  lit, it lives four times as long, and it falls slowly because it is mostly air
  resistance. Forcing it through the same uniforms means compromising both, and that
  compromise is exactly what makes an effect read as *particles* rather than as fire
  and ash.

  Its numbers are arguments about air, not fire. `buoyancy` −0.55 against `damping`
  1.6 is a terminal fall of about a third of a metre a second, so a flake lofted two
  metres takes most of its life to land. `glow` 0.9 keeps it deliberately *under* the
  1.15 bloom threshold — ash is lit, not luminous, and a flake with a halo is an
  ember — and `sparkle` is 0 for the same reason, since a glint is a point of light
  and this is a piece of something. What it has instead is `twinkle`: a flake turning
  over catches the room's light and loses it again.

  **The ash outlives the spell.** A real explosion does not finish when it stops
  glowing, so the fireball gained a fifth phase and a second question: `active` keeps
  the pools moving, because particles only move while their field is stepped, while
  `airborne` is what the cast sequence waits on and goes false the moment the light
  dies. Traced end to end: the fire is out at 4.4 s, the camera starts back to the
  parchment there and arrives by 6.0, and the last flakes are still coming down at
  7.6 — behind the player, over their shoulder, which is the point of having them.

  **The core boils, and that is a shape problem rather than a shading one.** It
  used to be one octave of noise tinted across a solid sphere, and the sphere was
  the problem: a smooth outline reads as a marble whatever is painted on it, so the
  hottest object in the room was also the most geometrically calm. `positionNode`
  now pushes every vertex along its own normal by fractal noise scrolling downwards
  through the ball, at 42% of the radius — so the silhouette is lumpy, asymmetric
  and never twice the same. Displacement in the vertex stage costs one noise per
  vertex rather than per pixel, which even at detail 4 (5,120 triangles, up from
  1,280 — the boil came out faceted at detail 3) is cheaper than the shading it
  sits under.

  The shading is domain-warped: fractal noise on its own gives soft round blobs,
  which is the same silhouette problem one level down, so the sample position is
  warped by a *second* noise field before the first is read. That curdles the blobs
  into filaments and folds, which is the cheapest structure that does not read as
  cloud. Over it, three ramps — radial for a white-hot middle and a thin edge, a rim
  term because a shell of gas is optically deepest where you look along it, and a
  `smoothstep` tightening the hot band so there is a visible boundary between the
  white core and the red body instead of a gradient across the whole ball.

  **The core is not where the glare should come from.** Taken to 8 to out-glare the
  candles it went off like a flashbulb, washed the room pink and drowned the very
  shower it was lighting. A candle emits 7 through a sprite a few centimetres
  across; the core is a 15 cm sphere seen from two metres, so the same number covers
  thirty times the screen. It sits at 4.1 now, and the halo comes from the embers
  instead: solid (`opacity` 1), hard-edged (`square` 0.65) and emitting at 4.5 at
  the detonation — a little over what the old 16 put on screen through the 0.22
  alpha the material used to bake in, and every core over the bloom. What makes it
  a burst rather than a shower is `stretch` 0.05: every spark is a bar smeared
  along its own velocity, so the leaders `spray` throws far draw long streaks, the
  slow body stays a scatter of squares, and the plume `updraft` sends up arcs over
  as a fan of lines. The palette runs deep red through red-orange to a yellow that
  the material takes on to near-white at the throw, so the shower is yellow-white
  at the centre and red rain at the edges.

  Both aimed spells hit the **centre of the target painted on the dummy**, and
  that point is derived rather than written down: the decal's centre is `u = v =
  0.5` by definition, which runs back through the same Mapping the shader uses to
  a point on the cloth's axis, and one raycast puts it on the surface. The decal
  and the aim cannot drift apart — move the target in Blender and both follow.
  This replaced the dummy's bounding-box centre, which was **57 cm low**, because
  that box contains the post and the crossbar as well as the body: the spells were
  detonating on the stand.
- **`Lightning.ts`** — the arc is twenty billboarded ribbons whose spine is
  displaced by noise in the vertex stage, so the CPU never touches a vertex and the
  bolt re-jags itself every frame for free. Branches are the same geometry over a
  shorter span of the path with a free tip.

  It was four — a trunk and three branches — which is enough to say *not straight*
  and nothing more. What an arc actually looks like is a **core with a fringe**, and
  that needs four groups rather than two: three strands spanning the whole path and
  pinned at both ends, winding about one another because their drifts differ; eight
  short filaments hanging off at intervals with free tips, which is what stops the
  middle reading as a tube; and a burst of six at the impact plus three at the quill,
  because the charge leaves from somewhere as well as arriving.

  The bursts needed one trick. Drift is perpendicular to the path, so on its own it
  can fan filaments sideways but never send one back the way it came — a burst all
  raking forward is a splash, not a starburst. Giving some of them a **negative
  length** runs their span backwards down the path, and the burst radiates.

  All of it is still one draw call: 20 ribbons × 26 sections × 2 vertices is 1,040
  vertices and 1,000 triangles, which is less than a single bookcase.

  The core is white and the colour lives in the haze around it (`mix(blue, white,
  core^1.5) × 1.9`). A bolt lit in its own colour all the way through reads as a
  painted line; what says *arc* is a centre too bright to have a colour at all, over
  the bloom threshold so the fringe it throws is the post pass's rather than the
  ribbon's. 3,072 sparks fall from the impact —
  the one pool in the room where nothing is on fire, and the one that most needs
  to read as light rather than as matter. They emit at 18 against the candle's 7,
  and `sparkle` 0.75 blends the sprite hardest of any effect towards a
  four-pointed glint: the round sprite is a soft radial falloff, which is the
  silhouette of a puff of smoke, and at the old emission of 10 a spark's core sat
  barely twice over a bloom that does not open until 1.15 — lit, but with no halo,
  which is what made a strike look like blue confetti.
- **`RuneAwakening.ts`** — drives the floor decal's charge and rotation, twelve
  shared-material pillars that turn with the carving, and 2,048 embers spawned
  disc-wise across the full 3.3 m radius, webbed together by `ParticleLinks`. The carving is **perfectly still at
  rest**: rotation speed is proportional to charge, so it spins up for the spell
  and winds down to a stop as the charge decays instead of idling forever. This is
  why the phase is integrated frame by frame rather than driven off `time` — a
  `time`-based angle cannot stop without the carving jumping.

  **The pillars are beams, and the second pass is what made them read as light.**
  They began as twelve identical columns of slowly-scrolling noise whose only move
  was to fade up and fade down. Adding a climb, a crest and a swell fixed the
  *motion* but not the substance: a scrolling cloud in a cylinder is a fog however
  brightly it is lit, because nothing in it holds an edge.

  Rings climbing the shaft came next and were legible but too regular — anything on
  a grid reads as machinery, and what comes out of a carving cut by a witch is not
  machinery. What they are now is **fire**: upward-scrolling fractal noise, **domain
  warped** so the blobs curdle into tongues instead of staying clouds, thresholded by
  a cut that *rises with height* so the column is a solid pool at the foot and comes
  apart into detached wisps at the top. A flame does not fade out; it breaks.

  Three numbers had to be found by looking, and the two failures are the instructive
  part:

  - **the noise has to be finer than the thing it is drawn on.** A pillar is 13 cm
    across; at 2.4 features per metre every fragment of it sampled nearly the same
    value and the fire rendered as a slab of even brightness — a marble column. 10
    per metre gives it structure across its own width;
  - **three-octave fractal noise does not span 0..1.** It clusters near the middle,
    so the first version thresholded against values the field never reached and the
    pillars came out *completely empty*. `FLAME_STRETCH` pulls the useful band out to
    the full range first, which is what makes the break threshold mean anything;
  - and the tongues need a hard border. At an edge width of 0.17 they had haze
    instead, and the column read as textured rather than burning.

  It is surface-shaded on a cylinder rather than raymarched, so it is a flame seen on
  a shell rather than one with depth — but the shell is open and drawn double-sided
  and additive, so front and back add along the sight line, which buys most of the
  volume for none of the cost.

  Being on a shell has one tell that has to be paid for: **without help, the flame's
  outline is the cylinder's**, a hard vertical edge down both sides of every column
  and the one line in the whole effect that could not have been drawn by fire. The
  alpha is therefore weighted by how squarely the surface faces the camera, which
  takes it to nothing exactly where the mesh turns away, so the column thins into the
  room rather than ending at its own geometry. Note that this is the *opposite*
  weighting to the one a beam wants — a tube of light is brightest at its silhouette,
  where the sight line runs along it — and that difference is most of what separates
  the two readings. The vertical taper reaches past the top of the mesh for the same
  reason: at 0.9 the column still had a height it stopped at, and a flame does not
  have one of those.

  **The exit is a fire going out, not a light being switched off.** The charge's own
  decay is 1.6 s and it used to drive everything, so when the spell ended the columns
  went with it — and because their alpha only ever fell with the *climb*, what that
  looked like was the fire retracting into the floor and then stopping. The beams now
  keep their own level: fast to take hold (rate 9), slow to let go (1.05), so they go
  on burning about two seconds past the charge, into the drain, after the circle has
  gone quiet.

  And they go out **bottom-up**. An extinction line sweeps *upwards* as that level
  falls, so the base darkens first and the last of the flame rises off the floor and
  comes apart — a fire cut off at its fuel, which is where this one's fuel is.
  Sinking back into the ring was the alternative and reads as the fire being *pulled*
  down, which is a different claim about what just happened. The line's gradient is
  0.28 of the column so it never has an edge you could point at, and it overruns the
  top by 1.3 so the last wisp leaves the column rather than parking at its rim — from
  which the level where nothing is left to draw falls out exactly, at 0.015, rather
  than being guessed.

  **The flame's shape is measured from that line, not from the floor**, and this is
  the difference between fading out and blinking out. Everything about the fire's
  form — how dense it is, how far it tapers — is a function of how high a fragment
  sits, because fire is fed from below and thins as it rises. Sweeping the extinction
  upward *against* that makes the two compound: the only part still alight is the
  part that was already almost nothing, so the last second of a two-second fade had
  no fire in it and the beams appeared to vanish. Rebasing the height on the
  extinction line fixes it exactly — the surviving band always has its own dense root
  at the cut and its own wisps above, a flame lifting off a burner — and while the
  fire is whole the rebase is the identity, so nothing about the burning state
  changes.

  (Two earlier shapes survive in the history if either is ever wanted: a double helix
  — two strands, two and a half turns, written as a line of constant `angle − turns ×
  height` — and the rings.)

  The climb survives from the first pass: the light stands *up* out of the ring as
  the charge attacks and sinks back into it as it decays, so the shape of the spell
  is in the envelope rather than in an alpha ramp. So does the trick that makes
  twelve identical pillars behave differently without a per-pillar attribute — a
  swell written as a function of `positionWorld`'s angle about the room's axis
  stands still in the *room* while the pillars sweep through it, so each brightens
  and dims as it passes.

  It also moves the room. `RUNE_JOLT` is the third entry in `Recoil.ts` and the
  only one that is not an impact: **five degrees** of sway at 4.5 Hz, damped at
  1.0, so the dummy standing on the floor is still rocking three seconds later
  while the pillars are up. Low frequency is what carries the difference — at 9.5
  Hz that angle reads as a flinch, at 4.5 it reads as weight shifting underneath —
  which is why the amplitude is the only thing that moved when it needed to hit
  harder. It started at 0.07 rad, which measured a 2.5° peak: about what a draught
  would do to a post in a weighted base. The pillars fade out near the camera;
  the ring passes within a metre of the seated viewpoint and would otherwise fill
  the frame with haze.
- **`ParticleLinks.ts`** — the circle's web, after the three.js
  `webgpu_tsl_vfx_linkedparticles` example: every live mote draws a ribbon to its
  two nearest live neighbours, so the spell reads as a constellation being drawn
  rather than a column of sparks. The search is the honest O(n²) — each mote walks
  the whole pool every frame — which is why the ember count halved to 2,048. It
  costs about 3 fps while the spell runs, and the web is dense long before the
  pool is.

  Two things had to change from the example, both because this is a room rather
  than a flat demo:

  - **Ribbons are billboarded rather than offset in Y.** The example gives a quad
    its width by pushing its two ends apart along world Y, which is free and looks
    right while nothing is vertical. These embers climb, so a link between two of
    them is very often itself vertical — and offsetting a vertical line along its
    own axis gives a quad of zero width. The width here is
    `cross( link, toCamera )`, resolved in the vertex stage because that is the
    stage that knows where the camera is; the compute pass stays camera-free.
  - **Links have a reach.** The example's particles are one tight cluster around
    the cursor, so the two nearest are always near. These spread over a 3.3 m
    ring, and an isolated mote will happily throw a half-metre strand across the
    circle. The cutoff is 0.22 m, which is measured rather than guessed: with the
    pool full a mote's nearest neighbour sits about 9 cm away and nine in ten are
    inside 15 cm, so the reach adds nothing but excludes the outliers that turn a
    web into a scattering of shards.

  Worth knowing if you extend this: the two extra vertex streams are read with
  `attribute( name, 'vec4' )` and **not** `storage( … ).toAttribute()`. That
  helper binds a buffer as an anonymous attribute, and with two vec4 streams on
  one geometry the second silently resolves to the first — the ribbon took its
  half-width from the tint's alpha and splayed by up to a metre. It presents as a
  broken neighbour search, since the buffer the compute pass writes is perfectly
  correct; reading it back is what rules the compute out.
- **`Recoil.ts`** — the training dummy rocks when something lands on it. It is a
  post in a weighted base, so it tips rather than slides: the whole thing pivots
  about its own origin, which the asset conveniently puts on the floor at the foot
  of the post, and a damped sine does the rest.

  It tips *away* from whatever hit it. A rotation about a horizontal axis `A`
  moves the top of the post along `A × up`, so tipping away from an impact means
  `A = push × up`, where `push` is the horizontal direction from the foot out
  towards the point of impact.

  The two spells land differently. The fireball is a shove — **8.2°**, peaking
  117 ms after the blast, still moving at a second and a half — and lightning is a
  crack: 6.6°, there in 67 ms and gone by 950 ms.

  Both are sized against *what they compete with* rather than against physics, and
  both were tuned up twice before they read. The fireball's first pass was 4.5°,
  which is a real movement — 17 cm at the top of the post — and it still went
  unseen, because its peak lands in the middle of the brightest part of an
  explosion happening at that exact spot. Lightning has worse luck again: the bolt
  arrives the instant the sigil resolves, while the camera is still swinging back
  from the parchment, so for the first half second the whole frame is moving and a
  small tilt is invisible inside that. A recoil has to outlast the thing that
  caused it. At 8.2° the top of the post travels 30 cm and is still going when the
  light has gone.

  **The recoil judges the hit itself rather than being told about it.** Both
  spells report where they landed, not what they struck: `Fireball.onImpact` fires
  from the one place both routes into `burst` pass through, so a shot a ward
  stopped short reports the ward's shell, and lightning reports whatever
  `Ward.deflect` handed back. Anything landing more than 0.7 m from the target is
  ignored — comfortably inside the ward's smallest dome, so a spell the ward ate
  leaves the straw alone without either spell having to know a ward exists.
- **`Ward.ts`** — the one spell that reads the *quality* of the line, and the only
  thing in the room the player's own spells can collide with. See below.
- **`ScreenFlash.ts`** — a full-frame additive term mixed into the pipeline's
  output node, before the colour transform so a hard strike rolls off through tone
  mapping instead of clipping.
- **`audio/Chime.ts`** — the only sound in the atelier, synthesised rather than
  loaded: a struck bell is a handful of inharmonic partials over an exponential
  decay, so a few oscillators cost less than shipping a wav. The context is created
  lazily on the first pointer-down, which is what browsers require before a page
  may make noise.
- **`audio/InkSfx.ts`** — the page's own sounds, synthesised on `Chime`'s context
  and master (so the welcome click unlocks them too). The quill: looped paper hiss
  plus a baked bed of fibre ticks, both through a 6 kHz lowpass, with level,
  brightness and tick density following nib speed on the sheet (`recorder.inking`,
  differenced `activePoint`), silent when the nib rests, hovers or runs off the
  page. The burn: a lowpassed brown-noise bed, a thin sizzle and Poisson crackle
  pops, all following `InkMotes.burn`, plus a one-shot whoosh when a recognised
  sigil ignites. Every level is re-set each frame with a quarter-second fall to
  silence behind it, so a backgrounded tab cannot leave a scratch hissing, and the
  looped sources are stopped after 0.6 s of quiet. Loudness and character are the
  constants at the top of the file; `INK_SFX_LEVEL` trims the lot.

#### A cage, not a dome

The ward closes around the dummy's **body**, and the shape change is what made the
size change possible. A hemisphere standing on the flagstones has to reach the top
of the dummy's head from the *floor's* centre — 2.192 m, measured across its 3,199
vertices — so the smallest ward that actually warded was 2.35 m and swallowed the
room. Measured from the body's own middle instead, the same dummy fits inside
**1.139 m**: half the radius, an eighth of the volume.

So the shell is a whole sphere now rather than an upper hemisphere, it hangs at the
height of a body rather than standing on the stone, and both its size and its
clearance are derived at load from the dummy's own vertices — replace the asset and
the cage still fits it. Not from its bounding box, which this scene has been caught
by before: the box diagonal gives 1.30 m here, 14 cm of it corners that hold no
geometry at all.

Two things followed from closing the shell. The plating's rows now span pole to pole
(`direction.y * 0.5 + 0.5`) instead of clamping to the upper half, which would have
collapsed every row below the equator into a single seam; and `intercept` lost its
floor guard, which existed because a dome has a rim that a shot can pass under. A
closed shell has no underneath, so being within the radius is the whole of the test.
Verified: a fireball cast at a warded dummy bursts at exactly 1.45 m from the cage's
centre and never reaches the straw, and the bolt earths on the same shell.

#### What the shell is made of, and why it changed twice

The shell has been three things, and the shape of the ward decided each one.

**A fresnel wash.** From the seat this was a blue filter over the room, and the
reason was geometric rather than artistic: the *dome* was room-sized, so its
silhouette was never on screen and the only part you ever saw was the flat 0.13 of
fill underneath. Forcing the material to a flat 0.45 confirms it — the dome covers
the viewport corner to corner with no rim anywhere in frame.

**Plating.** The answer to a silhouette you cannot see is to put the substance on
the surface, where it reads face-on: rows and offset columns of seams with a charge
running up them. It worked, and it taught the `min( f, 1 - f )` trick for drawing a
seam of an exact width. Worley cells were the dead end on the way — at any scale
fine enough for panels, `mx_worley_noise_float` is saturated near its maximum across
nearly the whole shell, so a threshold on it gives a sheet with holes rather than a
lattice, and no control over seam width at all.

**A bubble**, which is what it is now, because closing the dome into a cage changed
the premise the other two were answering. At 1.45 m around the dummy and 3.9 m from
the seat the shell subtends about 44°, so its **silhouette is in frame** — the whole
outline, all the time. That is the geometry a fresnel term was always for, and with
it available the honest shape for a ward is the one a bubble has: nothing in the
middle, everything at the rim.

There is also no band at the equator any more, and it is worth saying why it was ever
there: on the hemisphere that line was where the shell met the stone, a *footprint*,
and the thing that stopped a small ward reading as a smudge. Closed into a sphere it
is not a footprint — it is a stripe through the middle of a bubble — and the writing
it carried now lives on the ring on the floor, which is where a ward's inscription
belongs.

So the fill is 0.025 — a tenth of what the plating carried — and you look *through* a
ward. What tells you it is there is its edge, the sheen crossing it, and whatever has
just hit it. The rim is sharpened to power 2.6 because a soap bubble's edge is thin,
and a soft one reads as fog inside a sphere rather than as a surface enclosing it.
The colour is thin-film **iridescence**: a bubble's colour is not a property of the
bubble but interference, so it shifts with the angle you catch it at and drifts as
the film moves — two colours mixed by a slow noise over the surface, biased towards
the violet end as the rim steepens, which is what thickness does to a real film.

#### The ring it stands in

A shell hanging at chest height is a claim about a piece of *floor*, and closing the
dome into a cage took away the thing that used to say so — the old hemisphere met the
stone and drew its own footprint there. A ring of marks puts it back, and it does
more than tidy: a thing with a mark under it is a thing standing somewhere, so it is
what stops the cage reading as floating.

They are glyphs rather than a drawn circle, and the difference is in the spacing:
`fract( angle × 34 )` cuts the ring into equal cells and a noise read at the cell's
own index sets how wide that mark is and how brightly it burns, so no two are alike
and none is a dash. The eye reads a row of *characters* rather than a dotted line,
which is the difference between an inscription and a selection marker. Each breathes
at its own pace off the same number.

**Its height is measured, and the first guess was wrong in the way that costs an
hour.** The floor here is not the flagstones: `MagicCircleDecal` is laid over them
and raycasts down onto it at **y = 0.051** everywhere the ring falls, so a ring at
0.028 sat two centimetres *inside* the carving and was depth-tested away — invisible
even when forced to flat opaque cyan, which is what finally ruled the shader out.
0.056 clears it by 5 mm.

#### The ward reads the line, not just the shape

Every other spell cares only *which* glyph you drew. The ward cares how well:

- **Where** — on the dummy, and this is the one thing the ward *stopped* reading
  off the page. A page width used to map to 5 m of floor and the shell stood wherever
  on it you drew the ring, which worked while this was a 2.35 m dome: a dome that
  size swallows a placement error and still covers what it was cast for. A cage
  cannot. It is 1.25 m around a body 1.14 m across, so its entire margin is a hand's
  width, and a ring drawn a fifth of a page off centre is a metre of floor — which
  puts the straw outside the shell. A ward that misses is not a smaller ward, it is
  a failed one, so the same argument that sizes it now places it.
- **How big** — the drawn radius maps to 11–56 cm of clearance around the body,
  both figures relative to the body's own enclosing radius rather than to the room.
- **How round** — `SigilShape.roundness` is the spread of the sample radii about
  their centre, measured on screen where the player was judging their own line.
  A perfect ring holds for 11 seconds, a lumpy one for 3.5. Size and roundness are
  what is left of the ward reading the line, and between them they are still more
  than any other spell asks of it.

Impacts are real: `Ward.intercept` tests the fireball's core against the shell each
frame and `Fireball.detonateAt` stops the shot on the surface, while `Ward.deflect`
solves the ray/sphere intersection so lightning earths itself on the dome instead
of the target behind it. Three hits shatter it.

The cracks are drawn in polar coordinates around each impact — a tangent frame on
the shell gives an azimuth, so fractures throw *straight spokes* out from the point
of impact with concentric fractures across them, rather than the wandering veins
you get from sampling noise directly. Sampling that noise along each fracture's
length as well as its angle is what stops the set of them looking like lines of
longitude.

The shell is blended rather than additive, incidentally: an additive dome vanishes
wherever the room behind it is already bright, and this one has to read against a
candle-lit floor as well as a dark wall.

The floor sigil is worth a note: its decal has **no colour map at all** — the
carving lives entirely in an emissive map, which the material uses as both the
pattern and the cut-out mask. Overwrite `emissiveNode` naively and the rune becomes
a flat purple disc.

### Fire (`src/scene/Flames.ts`)

Every flame in the room — eight candles and two torches — is a billboarded sprite
with the whole flame generated in its fragment shader, ported from the three.js
`webgpu_tsl_vfx_flames` example. The GLB's own flames are hidden.

The reason is that what reads as fire is not brightness, it is the silhouette
moving: a body that leans, narrows, and sheds tongues off its tip. The GLB models
a candle flame as sixteen triangles of solid cone, and the emissive material this
replaces could only ever make that cone brighter and dimmer — a lamp shaped like a
flame rather than a flame. So the cone is not drawn.

The shader is the example's first flame: spherize the UV into a body, stretch it
upward, sway it with a sine running up its own height, then subtract climbing
cellular noise to bite the tongues out of the tip. The silhouette that falls out
doubles as the coordinate into a colour ramp, so the flame is coloured by its own
shape — cool at the edge, white at the core.

Three things worth knowing:

- **The cellular noise is procedural.** The example scrolls a 256² voronoi tile;
  this calls `mx_worley_noise_float` on the same coordinates. Same F1-distance
  field, no texture to ship, no seam where the tile wraps — and it takes a third
  coordinate, which is what gives each flame its own slice of the field.
- **All ten flames share one material, and none of them share a clock.** The
  seed is the sprite's own world position, read off `modelWorldMatrix` and put
  through a salted sine hash twice: one draw sets where a flame is in its cycle,
  the other sets how fast it runs, between 0.8x and 1.3x. One pipeline, ten
  flames, no two of them alike.

  The rate is the half that matters. Offsetting alone desynchronises nothing —
  flames that all sway at the same 1.6 Hz hold the same relationship forever,
  however far apart they are started, and a shelf of candles keeping time with
  each other reads as one animation played ten times no matter how staggered it
  is. The hash matters too, for a smaller reason: the linear dot product this
  started with put two flames 0.02 apart, close enough to watch them move
  together.

  The sway itself is two sines at frequencies that do not divide into each other,
  under a slow envelope built from two more, so a flame stands nearly still for a
  few seconds and then dances. A candle is not evenly restless, and one pure tone
  is audible as a tone.
- **Fragments off the flame are discarded, not left transparent.** The scene pass
  is an MRT and SSGI reads what it writes; an invisible fragment still writes
  `diffuseColor`, and off the flame that value is white. Left at zero alpha, every
  torch lit the wall behind it with a bright rectangle of bounce the exact size of
  its sprite — invisible in `plain`, obvious in `combined`, and easy to mistake for
  a GI bug rather than a sprite.

The sprite is twice the height of the mesh it replaces, because the flame does not
fill its quad: the silhouette clears the sprite's edges and the tip fades out about
four fifths of the way up. The palette's two middle stops are the .blend's own
flame colours, so the candles still sit where the reference render put them.

Where a sprite is anchored is per-kind, because the two are not modelled the same
way. A candle's flame is a sixteen-triangle cone standing on its wick, so its
bounding box starts exactly where the fire does. A torch's is a 480-triangle
volume that sockets *into* the head, starting two centimetres inside the wood —
anchored at its box, the sprite burns around the head instead of rising out of it.
Torches are therefore anchored a third of the way up their own mesh, which is the
one figure in the file matched by eye: the top of the wood is only that 2 cm up,
and stopping there is still too low, because the shader's flame has a soft
spreading base where the asset's cone has a hard one, and a soft base reads lower
than it sits.

### The light rig is the .blend's own (`src/scene/lightRig.ts`)

The GLB carries **no lights** — it has no `KHR_lights_punctual` — so the room
arrived flat and every lamp in early versions was guesswork. The real rig was read
out of the source Blender scene over MCP: **26 lamps**, with their authored
positions, linear colours and relative powers. Positions convert the way the glTF
exporter converts meshes, `three = ( bx, bz, -by )`, which the paper's own
transform confirms.

Blender's watts do not map onto three's candela through any constant that also
preserves the *look*, because the renderers tone-map differently. So the authored
ratios are kept exactly and one scale per light class is tuned by eye against the
reference render — three dials, not twenty-six.

Four things the port had to work around:

- **`RectAreaLight` blacks out the entire room.** It is exported by `three/webgpu`
  but does not survive this renderer's node lighting path — adding one turns every
  surface black, which is easy to mistake for an exposure problem. Both area lamps
  are rebuilt as strips of point lights that keep the authored position, colour and
  total power. Area lamps also need their own scale: Blender spreads their power
  over a surface emitting into a hemisphere, and at parity the 140 W ceiling strip
  alone out-lit every candle in the room.
- **Soft lamps become rings.** Blender lamps have a physical radius; three's points
  are infinitesimal. `MagicCircleGlow` is a two-metre sphere lying on the floor, and
  as a true point it became a searing hotspot in the middle of the room instead of
  a wash across the whole circle.
- **Clustered shading, and lamps must be bounded.** Forty-odd lights shaded forward
  cost more than the shadow pass and SSGI put together — **24 fps**. Overriding
  `renderer.lighting.createNode` with `clusteredLights()` bins them into a 3D grid,
  but with `distance = 0` the clusterer cannot bound a lamp and the room fills with
  rectangular patches of missing light. Giving every lamp a cutoff at the radius
  where it contributes 0.02 lux — far enough out to be invisible, and three windows
  the falloff smoothly to zero — fixed both: **76 fps**, no artefacts.
- **Tone mapping is AgX**, because the source scene is graded with it (Cycles, "AgX
  / Medium High Contrast"). ACES rolls highlights off differently enough that the
  candles and the rune never matched.

Only the sun casts shadows, and the room's own shell — the floor slab, wall core
and three hundred brick instances — is excluded from casting: those are what you
cast *onto*, and including them doubled the shadow pass for no visible gain.

#### What the exporter lost, recovered from the .blend

(This list started at three. It is worth assuming there is more.)

- **The floor was the wrong colour.** `Wood Floor Dark Walnut` builds its base
  colour from a Mix of two wood textures whose *factor* is
  `floorboards_displacement`; glTF cannot bake that, so the exporter wrote the
  factor — a pale height map — out as the albedo. The middle of the room is bare
  slab out to 3.5 m before the stone tiles begin, so it read as pale grey instead of
  dark walnut. Both wood textures average to the same linear brown, which the floor
  now uses, keeping the exported map only as grain.
- **The rune was masked wrongly.** Blender mixes a Transparent BSDF with an Emission
  using the texture's *alpha*, emitting white at strength 2.2 and letting the map
  supply the colour — the warm gold in the reference. This masked on luminance and
  tinted the result violet, which threw both away.
- **The training dummy lost its cloth entirely.** `Old fabric`'s base colour is a
  Mix of `fabric01_diffuse` with a bullseye decal projected in *object space* —
  Texture Coordinate → Object, X and Z through a Mapping node. glTF can express
  neither the mix nor a projection that is not a UV lookup, so the exporter kept
  one branch of the chain, and it kept the wrong one: the decal became the
  `baseColorTexture`, `fabric01_diffuse` was left out of the file altogether, and
  the decal's object-space Mapping was written out as a `KHR_texture_transform`
  on the mesh's own UVs (offset 0.5/1.95, scale 2.5). Those UVs land wholly
  outside [0,1] and clamp to the decal's transparent border — RGBA(0,0,0,0) — so
  the dummy rendered **flat black**, with the weave still legible in the normal
  map, which is what made it look like a lighting fault instead of a missing
  texture. Both halves are rebuilt in `enchant`: the cloth is unpacked from the
  .blend into `public/textures/`, and the decal is re-projected from
  `positionLocal` — Blender's local X and Z are three's local X and Y under the
  exporter's own `three = ( bx, bz, -by )`. It is masked on the decal's **alpha**
  rather than Blender's mask on its colour, which had been blending the red rings
  in at about a third strength.
- **Both witchy tomes lost their covers completely.** `VintageWitchy_Book03_Cover`
  and `VintageWitchy_Book08_Cover` are the only materials in the room with no
  image texture anywhere in them — three Noise Textures feeding five Color Ramps,
  two Mix nodes and a Bump. glTF cannot express procedural nodes and the exporter
  did not try: both came through the file as nothing but a name, with no
  `pbrMetallicRoughness` block at all. That means the glTF defaults applied —
  base colour white, roughness 1, and metalness **1**. A shelf of white metal
  books. `BookCovers.ts` rebuilds the graph; the two are identical apart from the
  dye, so it is one function with the leather passed in.

  The one number in there that is not the .blend's is `SPREAD`. Blender scales
  its Perlin gradients so a single octave nearly fills [-1,1]; MaterialX leaves
  them around ±0.7, so even after matching Blender's octave count and amplitude
  normalisation the result sits in the middle of the range and never reaches the
  ends. The .blend keys on the ends — the gilding lives entirely between 0.82 and
  0.88 — so at MaterialX's own spread not one fleck of gold appears on the cover.
  Correcting the spread once, at the noise, is what lets all five ramps downstream
  stay literally the numbers Blender uses; moving the thresholds instead would
  have hidden the same mismatch in five places and flattened the leather's
  contrast on the way past.
- **The mushrooms glowed everywhere instead of only where they should.** The
  three `Explorer_MAT` materials add an Emission shader over the Principled, and
  its *strength* is the albedo's own luminance through a ramp — nothing below
  0.35, full above 0.75. So the light comes off the pale caps and their spots
  while the darker red stays the colour the atlas painted it. glTF carries one
  flat `emissiveFactor` per material and has no way to mask it, so the exporter
  wrote the mint at full strength across the whole mesh. At an emissive of
  ( 0.3, 1, 0.55 ) in a room lit by candles that buries the texture completely,
  and the fly agarics arrived as featureless pale-green blobs — cap, spots and
  stem all one colour. Only the mask was lost; the colour was already right, so
  the repair is the ramp and nothing else.
- **Both glowing potions lit end to end instead of only their liquid.** Blender
  mixes a clear Glass BSDF with a glowing one, and the factor is a Color Ramp on
  the bottle's *own Z* — so the light comes off the liquid in the bottom and the
  neck above it is plain glass. One flat `emissiveFactor` cannot say that, so the
  exporter lit the whole bottle: a bar of light rather than a potion. Restoring
  the mask also halves the glow, since the .blend's emission times the 0.55 its
  Mix Shader gives it is a little under what the exporter wrote.

  Masking it exposed a second thing that had been hiding underneath: these
  materials are black **and fully metallic** in the GLB, which nothing revealed
  while the flat emission covered every pixel of them. Mask it off and the necks
  turn into silhouettes — black metal is not glass in any renderer — so the glass
  colour above the liquid line is the .blend's, taken well down.

  The mask itself is *softened* rather than copied, and that is deliberate. The
  .blend's ramp is a hard edge, four centimetres of a thirty-three centimetre
  bottle, and Cycles can afford it because both sides are refractive glass and you
  are looking through the neck at the liquid behind it. Applied literally to an
  opaque surface the same edge cuts each bottle in half and welds two materials
  together at the seam. The glow instead eases up through the neck to
  `POTION_NECK` — not what the .blend says, but what the .blend looks like: one
  bottle, brightest at the bottom.
- **The potion on the desk is a volume too.** `Material.003` is a second
  `Principled Volume` after the cauldron's smoke — density 6, colour from a noise
  through a three-stop ramp, and no surface shader at all. The exporter handed it
  a default surface and it arrived white and fully metallic: a bright bead sitting
  inside a dark purple bottle. The smoke is simply not drawn, but this one is small
  and enclosed enough to fake as a surface, with the ramp's own colours knocked
  down by `VOLUME_SCATTER` — a volume that thin scatters a fraction of what passes
  through it, so its albedo painted straight onto a surface reads far brighter than
  the volume ever looks.
- **The floor sigil's carving was re-encoded lossily.** This one is not a lost
  connection but a lost *file*. The .blend stores the engraving as a 1536² 32-bit
  EXR; the exporter wrote it into the GLB as lossy WebP at 125 KB. Same pixel
  count, so it does not look like a resolution problem until you see it — but the
  carving is nothing except one-pixel lines, and lossy compression eats exactly
  those. The rings came through broken and the runes furred.

  `public/textures/MagicCircleRune.png` is that EXR written out losslessly at 8
  bits, which the content allows: the brightest texel in the file is 0.95, so
  dropping float clips nothing. It is exported through a Standard view transform,
  not the file's AgX — rendering a texture through a film response bakes the
  response into the texture.

  Worth pairing with the sampler's `anisotropy`, set to 16 here. A floor decal is
  seen almost edge-on from the desk, the near edge of the ring a metre away and
  the far edge six, and that is the case trilinear filtering handles worst: the
  mip chosen for the far half smears the engraving into a band whatever its
  resolution. Note this is the sampler's anisotropy and not `material.anisotropy`,
  the BRDF extension on the quill's nib that had to be switched off — same word,
  unrelated setting, and only one of them touches shading.
- **The plant pot came through white, and is the one entry here that is not a
  port.** `Procedural Mud Pot` is another name-only material, so it arrived at the
  glTF defaults. In the .blend it is a single node group — and inside that group
  are seven Voronoi textures, four noise textures, two wave textures, twenty
  colour ramps and eight chained bumps, driven in part by an `Ambient Occlusion`
  node and by `Geometry → Pointiness`. Neither of those exists in a rasteriser.
  Reproducing it faithfully is not a shader translation, it is a bake.

  So this one takes the colour and the grain and stops. Worth recording *which*
  colour, because the obvious answer is wrong: the group's `Color` socket is a
  pale sand, and feeding that through gives a cream pot. The terracotta the pot
  actually is comes from a Color Ramp buried inside the group, whose three lit
  stops are the values used here. The Blender viewport is what settled it —
  the socket said sand, the render said clay.
- **The cauldron's "smoke" is not a surface.** It is a box with no Surface shader at
  all, only a `Principled Volume`, with `display_type: WIRE` — Cycles renders it by
  marching the volume inside. The exporter gave it a default surface material and it
  arrived as an opaque grey slab. Faking it properly means raymarching; until then
  it is not drawn.

#### Three things that are not the .blend's, and are marked as such

Everything above recovers something the exporter dropped. These three do not —
they are look changes, and the constants are all in `Atelier.ts` under names that
say so.

- **The tapestries are lifted** — `TAPESTRY_CLOTH` 4x on the printed faces,
  `TAPESTRY_BORDER` 3x on the near-black purple border. Both were faithful; the
  cloth art is a dark image in a dark room and read as two black rectangles on the
  wall, with the moon phases and the pentacle illegible from the desk.
- **The easel's canvas is painted.** `Easel_Canvas` came through the exporter
  perfectly intact, and what it carries is a *blank primed board*, because that is
  what the asset is — which is a bright white rectangle in the corner of the room.
  It now has aged linen under a sigil study, and the sigil is the floor rune's own
  texture, already loaded for the carving: the witch's working drawing for the
  circle cut into her floor, pinned up where she was solving it. No second image
  is shipped and the two cannot fall out of step.

  Its UVs are a trim-atlas sub-rect (u 0.34–0.53, v 0.26–0.40), so the sketch is
  placed against the mesh's **local frame** instead — the same approach the dummy's
  target decal uses, and for the same reason.
- **The plant pot's grain** is invented; only its colour is the .blend's. See above.

Emissive strengths are the .blend's too: flames 8 (7 on the sprites that replaced
them), cauldron 11, orbs 7 and 8, rune 2.2.

**One thing here is not fidelity, and is marked as such in the code.** The two wall
tapestries export perfectly correctly — the fault is ours. They are dark navy
prints with fine gold line work, they hang on the far wall four metres from the
nearest candle, and screen-space GI cannot gather the bounce that lifts them in
Cycles. At the authored albedo they read as two black rectangles from the desk and
the art on them is invisible, so the cloth is multiplied by 4 and the border by 3.
The border is lifted less on purpose: matching them flattens the banner into a
single panel, and the frame reading darker than its print is what keeps it looking
like cloth hung on a rod.

Worth knowing if you reach for the same fix elsewhere: this **cannot** be done with
`material.color`, the way the quill's trim is taken down. A colour factor above 1
is clamped on its way to the GPU — 2.5 and 4 render identically to 1 — so that dial
only ever goes down. Multiplying the map inside the node graph is the only way up.

### Lighting pipeline (`src/scene/Post.ts`)

Screen-space global illumination, spatial AA and bloom, following the structure of
the three.js `webgpu_postprocessing_ssgi` example.

The atelier is lit almost entirely by small emissive sources — candle flames, a
boiling cauldron, potion bottles, spells — which is precisely the case direct
lighting handles worst: everything a candle is not pointed at falls to flat
ambient. SSGI gets the bounce back. The GI buffer shows it plainly: the magenta
potion throws pink onto the desk, and a fireball in flight lights the wall and the
training dummy it is about to hit.

The scene pass therefore runs with an MRT (`output`, `diffuseColor`, `normal`,
`velocity`), the two auxiliary buffers dropped to 8-bit for bandwidth, and the
composite is `colour × AO + albedo × GI`. Press **G** to cycle
`combined → plain → ao → gi`; the last two are diagnostic, and they are the reason
several of the decisions below could be made from evidence rather than taste.

Four things this cost, all measured on this scene:

- **MSAA had to go.** A multisampled depth buffer cannot be copied, and copying
  depth is exactly what SSGI does — with `antialias: true` the renderer throws
  `sample count (4) and destination sample count (1) does not match` every frame.
  The example creates its renderer without antialias for the same reason.
- **Spatial AA, not temporal.** TRAA is the natural partner for SSGI, but every
  spell here is a GPU particle system whose points move inside storage buffers: the
  velocity buffer reports them stationary, the temporal resolve reprojects them
  wrongly, and the fireball comes apart into blocks. FXAA instead. Doing this
  properly means keeping a previous-position buffer per `ParticleField` and writing
  real per-particle velocity — worth doing, but it is a particle-system change, not
  a post-processing one. The pass still writes `velocity` so that work has somewhere
  to land.
- **The GI's light input is clamped.** A fireball core is orders of magnitude
  brighter than a candle; unbounded it dominates the estimate and leaves stepped
  blocks of stale bounce on the floor beneath it.
- **`radius` is the expensive dial, not resolution.** Dropping it from 3.5 to 2
  took the scene from 43 to 79 fps — far more than halving the pixel count did
  (38.5 → 42.8). The pixel ratio is capped at 1.5, since GI costs per pixel and
  there is no MSAA left to want it for.

- **Resolution is fixed, because the adaptation was the lag.** With `radius` at 2
  the scene sits comfortably above 60 — and still drops a few percent of frames
  badly, which reads as a stutter that no average will show you. Measured on one
  machine, camera still, at three ratios of the same 825×973 canvas:

  | ratio | drawing buffer | pixels | fps | p50 | p90 | frames over 25 ms |
  | --- | --- | --- | --- | --- | --- | --- |
  | 1.5 | 1237×1459 | 1.80 M | 62 | 12.6 ms | 24.7 ms | **8.6%**, 13.3% on a re-run |
  | 1.25 | 1031×1216 | 1.25 M | 79 | 9.5 ms | 18.9 ms | 0.8%, 1.7% |
  | 1.0 | 825×973 | 0.80 M | 95 | 8.4 ms | 15.9 ms | 0.2% |

  So the cost is pixels, giving them up works, and nothing in the frame is ours:
  on an overrunning frame every stage of the update reads about zero, `post.render()`
  included, because `render` only queues the work. The wait is the GPU missing a
  vsync.

  **A change of resolution costs about 0.7 s of frozen screen**, and that number
  is what the whole design has to answer to — 776 ms, 651 ms and 441 ms, captured
  three times in this scene's own profiler while the old adaptive rig stepped. It
  is not the resize: a step invalidates every render pipeline in the scene, and the
  frame after `setPixelRatio` rebuilds **23 of them**. The call returns in 0.1 ms,
  that frame queues in 0.6 ms, and the rest is the driver compiling, between one
  frame and the next.

  Three adaptive rigs were written against that price and all three *were* the
  lag: one oscillated forever (two freezes a minute), one judged the arrival and
  froze during the entry, one judged a burst of casts and froze on the third
  spell. Sizing during the load is no better, because the frames there cannot be
  trusted — behind the opaque boot screen the same scene at the same ratio measures
  **0%** long frames against **13.3%** with the screen taken away, since the
  compositor skips presenting an occluded canvas and `requestAnimationFrame` stops
  being paced by the GPU at all.

  So `Resolution` spends a **pixel budget** instead: 1.25 M pixels of drawing
  buffer, worked back to a ratio from the canvas size and snapped to eighths,
  clamped to 1.0–1.5. A ratio is a statement about a display and the cost is a
  count of pixels, so the same 1.5 that is free in a small window is unaffordable
  in a large one. It is chosen once per canvas size and never during play, which is
  what makes the session freeze-free. `atelierDebug.resolution.pixelRatio` reports
  it, and `atelierDebug.watch()` logs any frame that overruns with a breakdown of
  where its time went.

  Measured after the change, same machine and canvas: **103 fps idle** (0 long
  frames in 617), **107 fps sweeping the view** (0–2 in 696), and **97 fps across
  four casts in a row** (5 in 1165, worst 43 ms) — against 62 fps and a 776 ms
  freeze before it.

For reference, on a 1597×1453 canvas: **79 fps combined, 111 fps plain.**

### Camera (`src/scene/CameraRig.ts`, `src/scene/LookAround.ts`)

Two framings and a blend: seated at the desk taking in the room, and leaning over
the parchment. On top of either, the view can *turn* — yaw and pitch applied to
the gaze without moving the seat, so the witch looks around the atelier rather than
flying through it and the desk never stops being the anchor.

Looking around needed no new mode, because drawing is already page-only: a drag
that starts on the parchment draws, a drag that starts anywhere else turns the
view, and right-drag turns it from anywhere (leaning in leaves almost no bare
canvas to grab, and the right button never draws). `LookAround` registers its
listeners after `StrokeRecorder`, so if the quill has taken the pointer the view
stays put — verified: a full pentagram drawn with the pointer moves the gaze by
exactly zero.

Starting to look sits you back automatically, since turning inside the leaned-in
framing just sweeps the desk. Coming back is `Esc`, or simply reaching for the
page again — the clearest statement that you are done looking. The return is
deliberately the slower of the two eases: following a drag should feel immediate,
coming back to work should feel like a decision. The lean is driven by *hover*, not by clicking, so the camera has
already settled by the time the first stroke lands — drawing while the camera moves
smears the sigil and wrecks the recognition score.

**A resolved sigil is a sequence, not an instant.** Everything used to happen on one
frame: the ink lit up, the spell went off and the camera left for the seat, all at
once — so the one moment the whole interaction is built towards, *your* finished line
catching light, played out on a page that was already sliding out of frame.

Three beats now:

1. **The sigil lights up**, with the camera still over it. `SIGIL_FLARE` is not a
   taste, it is `INK_BURN_SECONDS` (0.667): a cast puts the ink into a burn that runs
   the fade at `INK_BURN_RATE`, dragging the front along every remaining stroke in
   exactly that long, so the page is held for precisely as long as there is something
   happening on it and not one frame more.
2. **Then the camera leaves.**
3. **Then the spell fires**, `CAMERA_LEAD` (0.3 s) later — about two thirds of the
   lean-out, which eases at 4.5 — so it goes off into a camera that has essentially
   arrived. That is what makes the fireball read as launching *from* the page you are
   leaving rather than as something already in the air.

Measured, identical for all four spells: sigil lit at 1.02 s, camera leaves at 1.70 s
(**held 0.68 s**), spell fires at 2.00 s with the camera 77% of the way back.

And the flare had to be *built*, which is the part worth knowing. The page's emissive
term was driven by the **countdown** — `recorder.charge` ramps 0 → 1 as the quill
holds still, which is how you can tell a sigil is about to take. Then it resolves,
`charge` drops to zero, and so did the glow: the page went **dark** on the exact
frame it was supposed to catch light, and what was called a flare was a fade front
eating an unlit line. The glow now comes from the cast instead — starting at 2.2,
which the emissive term multiplies by 6.5 and so lands well over the bloom threshold,
decaying over `burnAway`'s own 1.2 s so the light goes out as the last of the line
does.

Casting sits you back, because a spell crossing the room is not something to watch
from six inches above the page. The framing then belongs to the spell for as long as
the spell reports itself running — `spellRunning()` — under a floor of `CAST_WATCH`.

Two separate things decide whether that reads well, and both of them were wrong
once:

**How long it holds.** Waiting on each spell's own flag is what makes the shot the
spell's rather than a fixed beat's — and a spell is not over when its headline
event is. The ward was the first to show it: a dome rises in 0.4 s and then *stands*,
so releasing on a 1.2 s beat left for the page with the shell still up, and the cast
you wait longest for was the one you got to look at least. The bolt was the same
mistake at the other end — it stops reporting itself at 1.15 s while its own sound
runs 1.5, so the camera turned for the page mid-crack, with the light still draining
off the walls and the dummy ringing for another 0.7 s. Where they land now:

| | camera holds | its sound | what is still going |
| --- | --- | --- | --- |
| lightning | 2.4 s (the floor) | 1.5 s | arc 0.45, drain 0.7, dummy 0.7 |
| fireball | 3.2 s | 1.0 s | flight, burst, settle |
| ward | 3.7 s | 3.7 s | rise, hold, collapse |
| rune | 4.1 s | 3.5 s | attack 0.7, hold 1.8, decay 1.6 |

**How fast it comes back.** The lean ran at one rate in both directions, and the two
directions are not the same act. Reaching for the page is the player's move and
should be immediate — hover starts it while the hand is already going, and it still
takes 0.48 s. Coming back *after a spell* is nobody's move: the room is going back to
work on its own, and at the reaching rate it covered two thirds of the distance in a
quarter of a second, which reads as a cut rather than as settling. `returnToPage`
runs three times gentler — the same ratio the look-around already uses between
following a drag (16) and recentring afterwards (5) — so the return glides in 1.5 s.
Start a stroke during that glide and it snaps: `lean` is a reach, and the rest of the
move takes 0.4 s.

**What happens next is decided by the quill, not by the spell.** Still held over the
parchment when the spell ends, and the camera leans back in on its own: a pen resting
on the page is someone waiting to write the next sigil. Laid down — the pointer went
somewhere else while the spell was in the air — and the camera stays sat back, since
leaning in over a page nobody is holding a pen to is the room moving for its own
reasons. Before this the page had to be *clicked* to get the camera back, hover being
an event and a resting hand generating none, and that click was a `pointerdown` on the
parchment: it started a stroke and left a blot of ink under the cursor every time.

The answer to "is the quill over the page" is the *remembered* one, not a fresh ray
through the camera, and that distinction is the whole fix. Sitting back moves the
parchment across the screen and shrinks it, so a pointer that has not moved an inch
fails a fresh test — measured: re-casting through the seated framing put the page's
own centre more than a quarter-sheet outside it, so the camera never came back. What
the question is about is the hand, and the hand has not moved. `onPointerMove` keeps
that answer current throughout the spell — it is only ever blind while a stroke is
actually being drawn.

## Adding a spell

1. Add a polyline to `RAW` in `src/recognize/glyphs.ts` (and to `GLYPH_PREVIEW` if
   you want it in the HUD grimoire).
2. Add an entry to `SPELLS` in `src/spells/registry.ts` binding that glyph name to
   a `cast()`. The context carries the sigil's position on the page, the impact
   point, the measured `shape` (centre, radius, roundness) and the effect bundle
   (`fireball`, `lightning`, `rune`, `ward`, `flash`). Returning a string from
   `cast()` replaces the HUD's certainty read-out with it, which is how the ward
   reports its size and lifetime.

For a new *visual*, a `ParticleField` plus a couple of uniforms usually gets you
most of the way — see `RuneAwakening` for the shortest example.

Unbound glyphs already resolve and report themselves, so a new glyph is testable
before it does anything.

## Dev helpers

In dev builds, `window.atelierDebug` exposes the renderer, scene, camera rig, ink
surface, recorder and fireball, plus:

```js
atelierDebug.demo( 'pentagram' )            // write a sigil at quill speed (1.4 s)
// any glyph in GLYPH_PREVIEW: pentagram triangle square circle spiral bolt cross caret
atelierDebug.demo( 'bolt', 0.34, 4 )        // slower, to watch the ink go down
atelierDebug.demo( 'triangle', 0.34, 0 )    // stamp it in a single frame
atelierDebug.effects.rune.awaken()          // fire an effect directly, no glyph
```

The timed form goes through exactly the same per-frame path as a real quill — one
dispatch per frame, live re-reads, the pen following the nib — which makes it the
useful one for spotting anything that only breaks at drawing speed. To study a
single frame, stop the loop from inside it:

```js
const r = atelierDebug.recorder, step = r.update.bind( r );
atelierDebug.demo( 'pentagram', 0.34, 3 );
r.update = ( dt ) => { step( dt ); if ( r.traceClock > 1.2 ) atelierDebug.renderer.setAnimationLoop( null ); };
```
