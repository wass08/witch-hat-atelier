import { Color, Scene, Vector2, Vector3, type WebGPURenderer } from 'three/webgpu';
import { IDLE_GLOW } from '../config';
import { ParticleField, type EmitterState } from '../spells/ParticleField';
import type { InkSurface } from './InkSurface';

/**
 * Seconds the emitter keeps spitting after the last mark vanished. Short — this
 * is the tail of one puff, not a plume — but not zero: the fade front stalls for
 * a frame or two wherever the player drew slowly, and cutting the spawn on those
 * frames left visible gaps along an otherwise continuous line.
 */
const LINGER = 0.18;

/** How far off the sheet the motes are born, in metres. */
const LIFT = 0.004;

/**
 * Past this much page travelled in one frame the front has jumped rather than
 * swept, and the emitter is teleported so no motes are strung across the gap.
 *
 * Raised a long way, from 0.09, because it was firing on ordinary sweeps and not
 * on jumps. A burn runs the fade at `INK_BURN_RATE`, which drags the front across
 * a whole stroke in about five frames — every one of those steps cleared 0.09, so
 * the emitter teleported each time, the smear that fills between frames was
 * discarded, and the trail came out as a few isolated bursts. Pen-lifts are
 * already caught properly by `VanishPoint.jumped`, which reads the `first` flag
 * on the mark rather than guessing from a distance; this is only the backstop for
 * a genuine teleport, so it belongs well outside anything a sweep can reach.
 */
const JUMP = 0.4;

/**
 * Coldest → hottest. The ink is dark, its ghost is not.
 *
 * Fire, end to end: these are embers off burning paper, and an ember is red
 * when it is nearly out, orange while it burns and yellow-white the moment it
 * leaves the page. The old ramp kept the ink's violet in the middle, which made
 * the trail read as the ink's ghost rather than as something alight — and a
 * page going up should look like it is going up. A recognised spell still takes
 * the ramp over; see {@link InkMotes.setColor}.
 *
 * The top is an orange-gold rather than a yellow. The material already whitens
 * the first few percent of every life, and the bloom and AgX pull anything hot
 * further towards white, so a yellow top left the whole trail reading cream; one
 * step down the ramp and the sparks come out gold, with the colour still there.
 */
const IDLE_PALETTE: [ number, number, number ] = [ 0x5a0a06, 0xff5a14, 0xff9a30 ];

/**
 * Spawn rate at the head of a sweep, and after it has been running a while.
 *
 * Half what a shower of this size would normally take. The drawing phase is the
 * quiet part of this scene — what has to land is the flare when the sigil
 * resolves, and that only reads as an event if the thing before it was restrained.
 */
const SPAWN_HOT = 0.028;
const SPAWN_COOL = 0.011;

/**
 * Extra spawn chance per page-width of line eaten in a frame, and its ceiling.
 *
 * The emitter is one point per frame, so a rate alone cannot describe a ribbon:
 * the same rate lays a dense trail when the front creeps and a dotted one when it
 * races. `VanishPoint.span` says how much line went this frame, and this converts
 * it into emission — so the trail keeps its density whether the fade is walking a
 * slowly drawn stroke or a burn is taking the whole sigil in five frames.
 *
 * The kernel smears each frame's spawns from the emitter's previous position to
 * its current one, so the particles land along the line that was eaten rather
 * than piling up at the end of it.
 *
 * Both down (from 3.4 and 0.55) now that each spark is a hot core rather than a
 * pale square: additive sparks that cross the bloom stack, and at the old rates a
 * frame's worth of them landing together whited out into one blob. Fewer and
 * brighter keeps them countable.
 */
const SPAWN_PER_SPAN = 2.6;
const SPAWN_MAX = 0.4;

/**
 * Emission at the head of a sweep, and once the stroke behind it has aged.
 *
 * Tripled from 1.3 / 1.0 along with the sprite going to about a third of its
 * old width. The material's colour is `tint × (heat × 1.15 + 0.2) × glow`, so a
 * newborn spark's core sits near 4.7 at the head and 3.4 at the tail — both well
 * over the 1.15 the bloom opens at, so every spark blooms by itself instead of
 * only where a wide pale square happened to overlap its neighbours.
 *
 * Not higher: past about 5 AgX rolls an orange core to white and the trail stops
 * being on fire and starts being glitter. The colour has to survive in the core,
 * because the halo around it is too faint to carry it alone.
 */
const GLOW_HOT = 3.5;
const GLOW_COOL = 2.5;

/**
 * Seconds of unbroken sweeping over which the emission cools from hot to cool.
 *
 * The fade front eats the line in the order it was written, so a long continuous
 * sweep *is* an old stroke being consumed: the head of the line is where the
 * front just arrived, and everything it has already passed is the tail. Cooling
 * the emitter over the sweep therefore puts the heat where the line is being
 * eaten and leaves a dim glow behind it, instead of a uniform ribbon of sparks
 * at one brightness for the stroke's whole length.
 *
 * It resets whenever the front stalls or jumps — a new stroke starts hot.
 */
const SWEEP_COOL = 1.1;

/**
 * Seconds the flare runs when a sigil is recognised.
 *
 * It does not sweep the line itself, and it does not need to: a cast puts
 * `InkSurface` into a burn that runs the fade at `INK_BURN_RATE`, so the front
 * races the whole remaining sigil inside `INK_BURN_SECONDS` and the emitter is
 * already being dragged along every stroke. What this adds is the character the
 * drawing phase deliberately withholds — the same line, all of it, going up at
 * once instead of being eaten a few centimetres at a time.
 *
 * Longer than the burn (0.667 s), because the lift has to outlive the thing that
 * lit it: the last stretch of line still needs somewhere to go after the ink
 * under it has gone.
 */
const FLARE_TIME = 1.15;

/**
 * The share of `SPAWN_PER_SPAN` the flare keeps while the burn drags the front.
 *
 * The flare *sets* the spawn rate rather than taking the higher of its own and
 * the trail's. The burn eats the sigil in a handful of frames, so the trail's
 * span term was pinned at its ceiling the whole time — and under a max() the
 * flare could only ever add to that. Half the trail's density is what reads as a
 * swarm of separate lights rather than a solid line of them.
 */
const FLARE_SPAN = 0.5;

/**
 * The flare, as an override of the resting emitter.
 *
 * `buoyancy` and `drift` are uniforms the kernel applies to *every* live
 * particle each frame, not just to new ones — which is exactly what lifting the
 * line off the page as a sheet requires. Everything already shed along the
 * stroke rises together the moment this comes on, rather than only whatever is
 * spawned from here.
 *
 * `dust` drops to almost nothing on purpose. One in five falling is what gives
 * the quiet phase its depth; in a flare it reads as the effect failing to commit.
 */
const FLARE: Partial<EmitterState> = {
	// Fireflies are counted, not measured: the eye picks out individual lights and
	// follows them, and it can only do that if there are few enough to tell apart.
	//
	// This is a per-frame chance that any *dead* particle comes back, so it has to
	// be read against the pool and the window, not against the old figure. The
	// sweep lasts about 0.85 s — `INK_BURN_SECONDS` plus `LINGER` — which is some
	// 51 frames, so the share of the pool that wakes is `1 - (1 - rate)^51`. At
	// the flare's old 0.32 that is essentially all of it — a wall. At 0.01 it is
	// about a third: some 560 lights of the 1,400, enough to read as the sigil
	// going up and few enough to follow one at a time.
	spawnRate: 0.01,

	// Tiny and hot: a couple of pixels at the writing framing, with a core near
	// 4.7 at birth so each one blooms by itself. Glow is about double the old 1.7
	// while the sprite went from 5 mm to under 3 — the energy per light is roughly
	// what it was, but concentrated where the bloom can see it. At 5 and over the
	// spell's colour went white in AgX; at this the fireball's burn is gold and
	// the bolt's is blue.
	glow: 3.5,
	size: 0.0028,

	// Solid, hard-edged and burning out by size rather than by alpha — the same
	// treatment as the trail, so the flare is the trail going up rather than a
	// different effect switching on. Fully solid now that the sprites are small
	// enough not to stack into a lamp; the half-solid 0.55 was what made the old
	// flare a sheet of pale squares with no light in them.
	square: 1,
	fadeSize: 1,
	opacity: 1,

	// Barely any. These rise at a couple of decimetres a second, so the old 0.05
	// stood every one on end as a vertical bar — a firefly is a point. Capped at
	// twice its width for the one the turbulence throws.
	stretch: 0.02,
	streakMax: 2,

	// The per-particle bloom, and the one part of it that carries the colour. At
	// 0.14 × a core of about 4.7 the halo peaks near 0.65 — under the threshold,
	// so it adds a soft tinted glow rather than more white — and six widths is
	// still only a dozen-odd pixels, cheap for a pool this size.
	halo: 0.14,
	haloSize: 6,

	// Born in the spell's colour, not white. The flare is the one pool here whose
	// ramp is the ink's hue rather than fire, and the ink colours are pale already
	// — the bolt's is a sky blue — so the material's white-hot birth left a
	// lightning sigil going up as white sparks with blue ones behind them.
	whiteHot: 0,

	// Nearly flat, where the resting trail is fully focused. A firefly is not an
	// ember: it does not cool as it ages, it holds its light and then goes out.
	// The fade at the end is the sprite's own, not a temperature.
	glowFocus: 0.12,

	// Each on its own phase and rate — this is the thing that makes them read as
	// alive rather than as slow sparks.
	twinkle: 0.55,
	twinkleRate: 2.4,

	// No glint: the hard square is doing that job now, and a star on a bar reads
	// as neither.
	sparkle: 0,

	// None. Falling paper dust is what gives the quiet drawing phase its depth;
	// among fireflies it just reads as something dying.
	dust: 0,

	// Gentle, all of it. The old figures threw the line upward and outward like a
	// detonation; these let it *rise*, which is the difference between sparks off
	// a fire and lights leaving a page. Long life and low damping are what buy the
	// drift — they have to still be going when you look for them.
	speed: 0.055,
	radius: 0.011,
	lifeSpan: 3.4,
	drift: new Vector3( 0, 0.13, 0 ),
	buoyancy: 0.14,
	damping: 0.65,

	// A little sideways wander so no two rise on the same line.
	swirl: 0.055,

	// Broad and slow: `turbulenceScale` is a spatial frequency, so lowering it
	// makes neighbours share a direction for longer and the swarm drifts in one
	// body instead of scattering.
	turbulence: 0.45,
	turbulenceScale: 0.45,

	// No ground. These fall at a drift rather than at a throw and burn out in the
	// air a hand's breadth under the page; there is nothing for them to land on
	// before that.
	floor: - 1e4,

	// Nothing here is thrown, so neither of the blast terms applies: a mote leaves
	// the page at one gentle speed in whatever direction the ink was, and the only
	// thing acting on it afterwards is gravity and the turbulence.
	spray: 0,
	updraft: 0,
};

/**
 * The burning edge: a second pool, sat exactly on the fade front.
 *
 * The motes above are what the line *sheds* — they leave, arc, drift, rise — and
 * however many of them there are, the place they were born is empty a frame
 * later. That emptiness is what read as the sparks and the fade being out of
 * step: nothing stayed on the edge to say *this* is where the ink is going. This
 * pool does. Its embers barely move and live about a quarter of a second, so
 * they pile up along the few centimetres of line the front has just crossed and
 * die there, and the fade opens up behind them: the line reads as burning away
 * from its edge rather than vanishing with some sparks nearby.
 *
 * A separate field because it is a separate population — one configuration per
 * field per frame, and these want the opposite of the motes on nearly every
 * axis. It costs one small dispatch and one draw.
 */
const EDGE_COUNT = 2048;

/**
 * Edge embers per page-width of line eaten, as a spawn chance per frame against a
 * mostly-dead pool (they live a quarter-second, so it is), and its floor and
 * ceiling. A burn eats a pentagram at about 0.06 page-widths a frame, which is
 * some 110 embers a frame along it; a stroke fading on its own clock eats a
 * tenth of that and gets the floor.
 */
const EDGE_PER_SPAN = 0.9;
const EDGE_MIN = 0.006;
const EDGE_MAX = 0.12;

const EDGE: Partial<EmitterState> = {
	shape: 1,
	// On the line, not around it: a nib's width either side.
	radius: 0.004,

	// A shiver, not a throw. What leaves the page is the motes' job; these stay
	// on the edge long enough to be seen there and then go out where they were.
	speed: 0.035,
	swirl: 0.01,
	lifeSpan: 0.3,
	drift: new Vector3( 0, 0.04, 0 ),
	buoyancy: 0.1,
	damping: 3,

	// Two-to-three pixels, a wide spread so the edge is ragged, not a bead chain.
	size: 0.0026,
	spread: 0.75,
	growth: 0,

	// Hotter than the motes: the edge is the hottest thing on the page, and its
	// embers are too short-lived to stack into a lamp. Every one of them blooms,
	// cooling to red over its quarter-second so the edge has a hot side (where
	// the front is) and a dying side (where it has been).
	//
	// No white at birth, and well under the 6 first tried: hundreds of these
	// stacked additively over pale parchment go white on their own, and a cream
	// edge is the colour of nothing burning. The colour is what says fire; the
	// stack supplies all the white it needs where it is densest.
	glow: 3.8,
	glowFocus: 0.8,
	whiteHot: 0,
	halo: 0.08,
	haloSize: 5,

	square: 1,
	sparkle: 0,
	stretch: 0,
	fadeSize: 1,
	opacity: 1,
	snap: 1,
	twinkle: 0.45,
	twinkleRate: 9,

	dust: 0,
	turbulence: 0,
	spray: 0,
	updraft: 0,
	inherit: 0,
};

const EMITTER: EmitterState = {
	position: new Vector3(),

	// Flat, because the ink is flat: the motes come off the page rather than out
	// of a volume hovering above it.
	shape: 1,

	// Small. `swirl` is a velocity in metres per second, not a fraction of
	// `speed` — the spells set it to over one, which on a desk-sized effect
	// throws the pool clear across the room inside a single lifetime.
	swirl: 0.04,
	spawnRate: 0,
	radius: 0.006,

	// Thrown, not released. `shape: 1` launches straight up, so this is the height
	// of the pop that gravity then argues with — the two together are what make an
	// arc instead of a drift.
	speed: 0.19,

	// One arc, and no more. At `speed` 0.19 against `buoyancy` -0.62 a mote tops out
	// about 2.7 cm up at 0.28 s and is back at the sheet by 0.56 s — past that it is
	// below the paper, where the desk occludes it. A second of life spends most of
	// itself above the page and lets the alpha curve take the rest.
	//
	// It is also the smoke guard: a long life plus turbulence lets the pool build
	// up until neighbours blur together and the whole thing becomes haze.
	lifeSpan: 1.0,
	attract: 0,
	// No drift. A constant lift is the opposite of what these do now.
	drift: new Vector3( 0, 0, 0 ),

	// Motes are shed, not puffed: they come off the line at the size they stay.
	// `growth` is the single strongest smoke tell in the system — a particle that
	// swells over its life is a puff by definition — so it is off entirely.
	//
	// Wide spread, so the trail is a scatter of a few big sparks among many small
	// ones rather than a ribbon of one size.
	//
	// A quarter-ish of the old 6 mm: two or three pixels at the writing framing,
	// where the old figure was a pale square big enough to read as a shape. A
	// spark is a point of light, and it is the bloom around it — not the sprite —
	// that should give it size on screen.
	size: 0.0024,
	growth: 0,
	spread: 0.7,

	// Set per frame from the sweep clock; see `GLOW_HOT` / `GLOW_COOL`.
	glow: GLOW_HOT,

	// Concentrated in the young half of the life, so what crosses the bloom is the
	// head of the trail and the tail falls off to a dim ember.
	glowFocus: 1,

	// Gravity, not buoyancy. Sparks off a page fall; embers rising was what gave
	// the trail its column-of-smoke shape. At this and the `speed` above, a mote
	// tops out about 3 cm over the sheet a third of a second in, then comes down.
	buoyancy: - 0.62,

	// Low enough that gravity has something to act on. At 2.0 the launch was eaten
	// in a few frames and every mote simply sagged where it was born.
	damping: 0.9,

	// Nearly off. Turbulence is what made these curl and billow, which is exactly
	// the motion smoke has — and with gravity doing the work there is a real arc to
	// follow, so the noise has nothing left to add but haze.
	turbulence: 0.07,
	turbulenceScale: 0.9,
	turbulenceFriction: 1.4,

	// A bar, not a blob. The round sprite was the single biggest reason the trail
	// read as smoke: no amount of tuning the motion escapes a silhouette that is a
	// soft circle. It used to be the four-pointed glint; now it is a hard square
	// smeared along its own arc, which is what a spark thrown off a page leaves
	// on the eye — and the square keeps a solid core inside the bloom where the
	// glint's spikes dissolved into it. Fully hard now: at a couple of pixels the
	// soft edge was only ever a grey fringe, and the halo below does its job.
	sparkle: 0,
	square: 1,

	// Seconds of travel each spark is smeared over. At `speed` 0.19 that is some
	// 7 mm of smear on a sprite now under 3 mm wide, which `streakMax` below holds
	// to a short dash at launch, shortening to a dot as gravity takes the speed
	// off — so the arc is written into the sprite as well as into the motion.
	stretch: 0.04,

	// Solid, and burning out by size. The alpha fade was the "transparent orange
	// circle" look in one number: a spark that fades in place is a light dimming,
	// where one that shrinks is a thing going out.
	fadeSize: 1,
	opacity: 1,

	// A little, not the flare's amount. Enough that the trail is alive rather than
	// a static spray, well short of the pulse that makes the cast read as fireflies.
	twinkle: 0.22,
	twinkleRate: 3.4,

	// The heavy tenth. Now that the sparks fall too, the dust is what falls
	// *hardest*: the kernel already gives it only 45% of the launch, and at this
	// gravity it barely leaves the page before dropping. The two still separate —
	// one population arcs, the other just falls.
	dust: 0.1,
	dustBuoyancy: - 1.1,
	dustGlow: 0.9,
	dustSize: 0.75,

	// No ground, for the same reason as above: these burn out in the air under the
	// page rather than reaching anything.
	floor: - 1e4,

	// See above: shed, not thrown.
	spray: 0,
	updraft: 0,

	// The emitter here is the fade front, not a thing that moves; what it sweeps
	// along is the line, and the motes come off that line, not along it.
	inherit: 0,

	// The per-particle glow. A core of 3.4–4.7 crosses the bloom, but a sprite
	// this small hands the bloom so little energy that the glow around it barely
	// shows; this draws it inside the quad instead — about 0.4 at its peak, under
	// the threshold, so it is a warm haze round each spark rather than more white.
	// Five widths is still only a dozen pixels, so the fill cost is nothing.
	halo: 0.1,
	haloSize: 5,

	// A dash, never a line: three and a half widths at most. The old default of 14
	// was a comet tail on a spark that should read as a point.
	streakMax: 3.5,

	// Fire while writing: the hottest instant of a spark is white, which is what
	// makes it incandescent rather than orange paint.
	whiteHot: 1,

	// On screen the frame it is shed. The birth ramp is a share of the life, and
	// on a mote that lives a second — let alone a firefly at 3.4 — that share was
	// several frames of nothing, which put every spark visibly behind the fade it
	// came off.
	snap: 1,
};

/**
 * The resting emitter, snapshotted before anything touches it.
 *
 * `EMITTER` is mutated in place every frame — it is what gets handed to
 * `configure` — so by the time the flare wants to blend *from* the resting values
 * they are long gone. Reading them from a copy taken at module load is what stops
 * the two drifting apart: change a number above and the flare's baseline follows,
 * instead of being a second copy that has to be remembered.
 */
const REST = { ...EMITTER, drift: EMITTER.drift.clone() };

/**
 * The ink does not simply stop being drawn — it comes off the page.
 *
 * `InkSurface` fades every texel on a curve the CPU can solve, so it can say
 * where the line is finishing its fade this frame without reading the texture
 * back. That point is the emitter: it retraces the player's own stroke one
 * lifetime behind the quill, and the motes are shed from it. Which is why this
 * reads as the writing being eaten rather than as glitter dropped on a sigil —
 * the source is a moving point on the line, not the line's area.
 */
export class InkMotes {

	private readonly field: ParticleField;
	private readonly edge: ParticleField;
	private readonly edgeState: Partial<EmitterState> = { ...EDGE, position: new Vector3() };
	private readonly page = new Vector2();
	private readonly at = new Vector3();
	private readonly start = new Vector3();
	private readonly previous = new Vector3();
	private readonly palette: [ number, number, number ] = [ ...IDLE_PALETTE ];
	private readonly scratch = new Color();
	private readonly hsl = { h: 0, s: 0, l: 0 };
	private colored = - 1;

	/** Seconds of spawning left, and of stepping owed after that. */
	private spawning = 0;
	private alive = 0;
	private placed = false;

	/** Seconds the fade front has been sweeping without a break; drives the gradient. */
	private sweep = 0;

	/** Seconds of flare left, when a sigil has been recognised. */
	private flaring = 0;

	/** Page-widths of line the fade front ate this frame. */
	private span = 0;

	/** Smoothed {@link burn}. */
	private heat = 0;

	constructor( renderer: WebGPURenderer, scene: Scene, private readonly ink: InkSurface ) {

		this.field = new ParticleField( renderer, scene, {
			// Doubled from 700: the rates below are shares of the dead pool, so this
			// doubles the trail and the flare alike without touching their shape.
			count: 1400,
			palette: IDLE_PALETTE,
			// Compiled in for this field only. It is a few octaves of noise per
			// particle per frame, and it is what makes an ember wander rather than
			// rise on a rail.
			turbulent: true,
		} );
		this.field.configure( EMITTER );

		this.edge = new ParticleField( renderer, scene, {
			count: EDGE_COUNT,
			palette: IDLE_PALETTE,
		} );
		this.edge.configure( this.edgeState );

	}

	/** True while there is anything left to step. */
	get active(): boolean {

		return this.alive > 0;

	}

	/**
	 * How hard the page is burning right now, 0..1 — for anything that wants to
	 * follow the fire without knowing how it is made, the paper-burn sound first.
	 *
	 * Rises the moment the fade front starts eating line and scales with how much
	 * it ate, holds up through a flare, and falls away over a fraction of a second
	 * once nothing is going; never a step, so a listener does not have to smooth it.
	 */
	get burn(): number {

		return this.heat;

	}

	/**
	 * Tints the motes towards the colour the page is glowing, so a sigil the
	 * parchment has already recognised sheds that spell's light as it goes.
	 */
	setColor( hex: number ): void {

		if ( hex === this.colored ) return;

		this.colored = hex;

		// The page's resting glow is the ink's violet, but the motes do not follow
		// it there: a line being eaten is on fire whatever colour the ink was, and
		// the fire ramp is what it sheds until the page has read a spell into it.
		if ( hex === IDLE_GLOW ) {

			this.palette[ 0 ] = IDLE_PALETTE[ 0 ];
			this.palette[ 1 ] = IDLE_PALETTE[ 1 ];
			this.palette[ 2 ] = IDLE_PALETTE[ 2 ];

			return;

		}

		// The ramp stays a ramp whatever it is handed: one hue, from nearly out
		// through a saturated middle to the spell's own colour at the top — so the
		// motes still cool from bright to dark over their life. Flattening all
		// three to the spell's colour reads as a decal rather than as embers.
		//
		// Built in HSL, and never whiter than the ink. The spells' ink colours are
		// pastels (the bolt's is 0x8fc4ff), the material already whitens every
		// newborn spark, and AgX whitens anything hot — so the old top, the ink
		// pushed a further 55% towards white, came out as plain white squares with
		// no spell in them. Saturation is floored and the top's lightness capped
		// so the colour survives all three.
		const { h, s, l } = this.scratch.setHex( hex ).getHSL( this.hsl );
		const rich = Math.max( s, 0.9 );

		this.palette[ 0 ] = this.scratch.setHSL( h, rich, 0.1 ).getHex();
		this.palette[ 1 ] = this.scratch.setHSL( h, rich, 0.5 ).getHex();
		//
		// Capped at 0.55, down from 0.66. Over pale parchment a burn front is a
		// thousand additive sparks stacked on a light ground, and at 0.66 the stack
		// went cream: the fireball's gold read as white fire, which is no colour at
		// all. At 0.55 the stack still whitens at its hottest, and the colour holds
		// everywhere else.
		this.palette[ 2 ] = this.scratch.setHSL( h, rich, Math.min( l, 0.55 ) ).getHex();

	}

	/**
	 * The sigil resolved: the whole line goes up at once.
	 *
	 * Call it alongside `InkSurface.burnAway`, which is what actually drags the
	 * emitter along the remaining strokes. This supplies the rest — the flare, the
	 * lift, and the dispersal after it.
	 */
	flare( seconds = FLARE_TIME ): void {

		this.flaring = seconds;

		// The line is going up whether or not the fade front is still handing over
		// marks, so the pool has to be stepped for the whole flare plus the life of
		// the last thing it throws.
		this.alive = Math.max( this.alive, seconds + ( FLARE.lifeSpan ?? EMITTER.lifeSpan ) );

	}

	update( dt: number ): void {

		const vanished = this.ink.takeVanished( this.page );

		if ( vanished !== null ) {

			this.ink.fromInkUV( this.page, this.at );

			// Just clear of the sheet. Born exactly on it, half of every sprite is
			// behind the page and the puff reads as a hard-edged semicircle.
			this.at.y += LIFT;

			// The emitter smears each frame's spawns along the ground it covered, so
			// a swept front lays a continuous ribbon of motes. A lift of the quill is
			// not ground covered, and stringing motes across it would draw a line the
			// player never wrote.
			if ( ! this.placed || vanished.jumped || this.at.distanceTo( this.previous ) > JUMP ) {

				// Placed where this frame's run began, not where it ended, and then
				// dragged to the end like any other frame — so the line eaten on a
				// jump frame is smeared along, not piled on one point. See
				// `VanishPoint.from`.
				this.ink.fromInkUV( vanished.from, this.start );
				this.start.y += LIFT;

				this.field.teleport( this.start );
				this.edge.teleport( this.start );

				// A jump means the front has left one stroke and landed on the head of
				// the next. That is a new line being eaten, so it starts hot.
				this.sweep = 0;

			}

			this.previous.copy( this.at );
			this.placed = true;
			this.sweep += dt;
			this.span = vanished.span;

			EMITTER.position.copy( this.at );
			this.spawning = LINGER;

		} else {

			this.spawning = Math.max( 0, this.spawning - dt );

			// The front has stalled. Whatever it reaches next is the head of a line
			// again, so let the emitter warm back up rather than resuming cold.
			this.sweep = Math.max( 0, this.sweep - dt * 2 );
			this.span = 0;

		}

		if ( this.spawning > 0 ) {

			// The gradient. Hot and dense where the front just arrived, thinning and
			// cooling the longer it has been eating the same line, so the tail of the
			// trail is a dim glow rather than more of the same sparks.
			const cooled = Math.min( 1, this.sweep / SWEEP_COOL );
			const eased = cooled * cooled * ( 3 - 2 * cooled );

			// The gradient sets the floor; the length eaten this frame sets the rest.
			const gradient = SPAWN_HOT + ( SPAWN_COOL - SPAWN_HOT ) * eased;

			EMITTER.spawnRate = Math.max( gradient, Math.min( SPAWN_MAX, this.span * SPAWN_PER_SPAN ) );
			EMITTER.glow = GLOW_HOT + ( GLOW_COOL - GLOW_HOT ) * eased;
			this.alive = EMITTER.lifeSpan + LINGER;

		} else {

			EMITTER.spawnRate = 0;
			this.alive = Math.max( 0, this.alive - dt );
			this.placed = false;

		}

		if ( this.flaring > 0 ) {

			this.flaring = Math.max( 0, this.flaring - dt );
			this.applyFlare();

		}

		// Line eaten per second, against what a burn eats (a pentagram's couple of
		// page-widths in two-thirds of a second): an ordinary fade walking a stroke
		// lands around a third, the burn itself pins it. Fast up, slower down.
		const eating = this.spawning > 0 ? Math.min( 1, 0.25 + ( this.span / Math.max( dt, 1e-3 ) ) / 3 ) : 0;
		const target = Math.max( eating, this.flaring > 0 ? Math.min( 1, this.flaring / FLARE_TIME + 0.3 ) : 0 );

		this.heat += ( target - this.heat ) * Math.min( 1, dt * ( target > this.heat ? 18 : 5 ) );

		if ( this.alive <= 0 ) return;

		this.field.recolour( this.palette, dt * 7 );
		this.field.configure( EMITTER );
		this.field.step( dt );

		// The edge follows the motes' emitter exactly — same point, same smear from
		// last frame's point — and burns at the density of line eaten, flare or not:
		// how fast the edge is travelling is the only thing it answers to.
		const edge = this.edgeState;

		edge.position!.copy( EMITTER.position );
		// Nothing when the front is not moving, for the same reason as the flare's:
		// a stalled edge would pile every ember onto one point.
		edge.spawnRate = this.spawning > 0 && this.span > 0
			? Math.min( EDGE_MAX, Math.max( EDGE_MIN, this.span * EDGE_PER_SPAN ) )
			: 0;

		this.edge.recolour( this.palette, dt * 7 );
		this.edge.configure( edge );
		this.edge.step( dt );

	}

	/**
	 * Folds the flare over whatever the resting emitter was about to do.
	 *
	 * Eased *out* over the flare's own clock rather than held flat, so the sheet
	 * does not simply stop rising when the timer expires: the lift and the glow
	 * bleed back towards rest, which is what turns the flare into a dispersal
	 * instead of a shower that gets switched off.
	 *
	 * The spawn rate is the exception — it rides the front half only. Past that
	 * the sigil's ink is gone, and new sparks would be coming off nothing.
	 */
	private applyFlare(): void {

		const left = Math.min( 1, this.flaring / FLARE_TIME );
		const strength = left * left * ( 3 - 2 * left );

		const blend = ( from: number, to: number ): number => from + ( to - from ) * strength;

		// Only while the fade front is still handing over line. Once the sigil has
		// been consumed the emitter stops moving, and spawning past that point piles
		// every remaining firefly onto the last place it stood — which is invisible
		// in a dense shower and obvious in a sparse one.
		//
		// And only while it is *moving*. A frame that ate no line — the front
		// pausing on a pen-down, or lingering on the last mark once the sigil is
		// gone — has nowhere to put a firefly but the one point it is sat on, and a
		// one-stroke pentagram starts and ends on the same point: at a flat rate
		// that point collected a hundred-odd lights and burned as a white knot
		// through the whole flare.
		if ( this.spawning > 0 ) {

			EMITTER.spawnRate = this.span > 0
				? Math.min( SPAWN_MAX, ( FLARE.spawnRate ?? 0 ) + this.span * SPAWN_PER_SPAN * FLARE_SPAN )
				: 0;

		}
		EMITTER.glow = blend( GLOW_COOL, FLARE.glow ?? GLOW_HOT );
		EMITTER.glowFocus = blend( REST.glowFocus, FLARE.glowFocus ?? REST.glowFocus );
		EMITTER.growth = blend( REST.growth, FLARE.growth ?? REST.growth );
		EMITTER.dust = blend( REST.dust, FLARE.dust ?? REST.dust );
		EMITTER.speed = blend( REST.speed, FLARE.speed ?? REST.speed );
		EMITTER.radius = blend( REST.radius, FLARE.radius ?? REST.radius );
		EMITTER.size = blend( REST.size, FLARE.size ?? REST.size );
		EMITTER.lifeSpan = blend( REST.lifeSpan, FLARE.lifeSpan ?? REST.lifeSpan );
		EMITTER.buoyancy = blend( REST.buoyancy, FLARE.buoyancy ?? REST.buoyancy );
		EMITTER.damping = blend( REST.damping, FLARE.damping ?? REST.damping );
		EMITTER.turbulence = blend( REST.turbulence, FLARE.turbulence ?? REST.turbulence );
		EMITTER.turbulenceScale = blend( REST.turbulenceScale, FLARE.turbulenceScale ?? REST.turbulenceScale );
		EMITTER.swirl = blend( REST.swirl, FLARE.swirl ?? REST.swirl );
		EMITTER.twinkle = blend( REST.twinkle, FLARE.twinkle ?? REST.twinkle );
		EMITTER.sparkle = blend( REST.sparkle, FLARE.sparkle ?? REST.sparkle );
		EMITTER.twinkleRate = FLARE.twinkleRate ?? REST.twinkleRate;
		EMITTER.square = blend( REST.square, FLARE.square ?? REST.square );
		EMITTER.stretch = blend( REST.stretch, FLARE.stretch ?? REST.stretch );
		EMITTER.opacity = blend( REST.opacity, FLARE.opacity ?? REST.opacity );
		EMITTER.fadeSize = blend( REST.fadeSize, FLARE.fadeSize ?? REST.fadeSize );
		EMITTER.halo = blend( REST.halo, FLARE.halo ?? REST.halo );
		EMITTER.haloSize = blend( REST.haloSize, FLARE.haloSize ?? REST.haloSize );
		EMITTER.streakMax = blend( REST.streakMax, FLARE.streakMax ?? REST.streakMax );
		EMITTER.whiteHot = blend( REST.whiteHot, FLARE.whiteHot ?? REST.whiteHot );
		EMITTER.drift.y = blend( REST.drift.y, FLARE.drift?.y ?? REST.drift.y );

		this.alive = Math.max( this.alive, EMITTER.lifeSpan );

	}

}
