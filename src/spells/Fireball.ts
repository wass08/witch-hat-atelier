import {
	AdditiveBlending,
	IcosahedronGeometry,
	Mesh,
	MeshBasicNodeMaterial,
	PointLight,
	Scene,
	SphereGeometry,
	Vector3,
	type WebGPURenderer,
} from 'three/webgpu';
import {
	color,
	mix,
	mx_fractal_noise_float,
	mx_fractal_noise_vec3,
	normalLocal,
	normalView,
	positionLocal,
	pow,
	smoothstep,
	time,
	uniform,
	vec3,
} from 'three/tsl';
import { transparentMRT } from '../scene/gbuffer';
import type { Chime } from '../audio/Chime';
import { ParticleField } from './ParticleField';

type Phase = 'idle' | 'charge' | 'flight' | 'burst' | 'settle' | 'ash';

const CHARGE_TIME = 0.55;
const FLIGHT_TIME = 0.8;
const BURST_TIME = 0.28;
const SETTLE_TIME = 1.5;

/**
 * How long the ash goes on falling after the fire is out.
 *
 * A real explosion does not finish when it stops glowing — what is left is the
 * part that was never burning: flakes lofted by the blast, too light to have been
 * thrown anywhere and too slow to have landed yet, coming down for seconds after
 * the light has gone. The spell had no such stage: the embers burned out, the
 * shower stopped, and the room was instantly as it had been.
 *
 * 3.2 s is long enough that the last flakes are still settling when the camera is
 * back over the parchment, which is the point of it — see `airborne`, which is
 * how the ash outlives the spell without holding the camera hostage to it.
 */
const ASH_TIME = 3.2;

/**
 * The floor, in metres, and how hard the shot's embers are pulled down onto it.
 *
 * Everything about a fireball is thrown, and until now nothing about it fell:
 * `ParticleField` defaults `buoyancy` to **+0.45**, so the embers accelerated
 * *upwards*, and the burst handed them another 0.9 of upward drift on top. A
 * detonation therefore left a ball of sparks hanging in the air around the
 * dummy, expanding evenly in every direction — the one shape that says nothing
 * about weight, or about which way is down, or about where the shot came from.
 *
 * -5.2 is chosen against the burst's own numbers rather than against physics.
 * Damping is 1.9 per second, so an ember's terminal fall is about `GRAVITY /
 * damping` — 2.7 m/s — and the bullseye it is thrown from stands 1.4 m up. The
 * spray spends its first third of a second going outwards, and the rest of its
 * life coming down, which lands the shower at the dummy's feet at about the
 * moment it burns out. Real gravity would put it there in a third of the time
 * and read as sparks being dropped rather than thrown.
 */
const FLOOR = 0.02;
const GRAVITY = - 5.2;

/**
 * Everything about the ash that does not change between being thrown and being
 * shed: what it looks like, and how it comes down.
 *
 * The motion is all an argument about air rather than about fire. `buoyancy`
 * −0.55 against `damping` 1.6 is a terminal fall of about a third of a metre a
 * second, so a flake lofted two metres takes most of `ASH_TIME` to land — which is
 * why ash is still coming down when everything else has finished.
 *
 * The look is grit, not snow. At 2.8 cm and a soft pale disc each flake was
 * bigger than a burst spark by five times, and two thousand of them drifting
 * across the dark wall read as a snowfall of pale blobs — the one part of the
 * shot that was still big and flat after the sparks had been made small. Now it
 * is a few millimetres, a hard square like everything else in the spell, and
 * lit by the palette in the pool (see `ash` in the constructor): the youngest
 * flakes are still embers and just touch the bloom as they are lofted, and
 * within a fraction of a second they have cooled to a dim red and then to soot,
 * so what comes down for the rest of `ASH_TIME` is barely-there grit. `glow` 1.5
 * is what puts only that first moment over 1.15. `sparkle` 0 — a glint is a
 * point of light, and this is a piece of something. `twinkle` stays: a flake
 * turning over catches the light and loses it again.
 */
const ASH_FALL = {
	shape: 0,
	size: 0.0045,
	growth: 0,
	spread: 0.8,
	glow: 1.5,
	sparkle: 0,
	square: 1,
	opacity: 1,
	fadeSize: 0.6,
	twinkle: 0.5,
	twinkleRate: 1.5,
	buoyancy: - 0.55,
	damping: 1.6,
	floor: FLOOR,

	// A third of it heavier — grit rather than flake — falling three times as hard.
	// Two speeds is what stops a fall reading as one sheet coming down.
	dust: 0.32,
	dustBuoyancy: - 1.9,
	dustGlow: 0.35,
	dustSize: 0.8,

	turbulence: 1.6,
	turbulenceScale: 0.5,
	turbulenceFriction: 0.9,
} as const;

/**
 * The core's geometry radius, and how far the surface is allowed to boil in and
 * out of it as a fraction of that.
 *
 * The radius is only a unit: the mesh is scaled at runtime from a fifth of it to
 * two and a half times. What matters is the displacement — at 0.42 the silhouette
 * is never a circle, which is the point of displacing it at all. A sphere reads as
 * a sphere from any distance and at any brightness, and a *ball* of fire is the
 * one thing a fireball must not look like.
 *
 * Detail 4 rather than 3 on the icosahedron: 5,120 triangles instead of 1,280,
 * because displacement is only as fine as the vertices carrying it and at detail
 * 3 the boil came out faceted.
 */
const CORE_RADIUS = 0.075;
const CORE_BOIL = 0.42;

const UP = new Vector3( 0, 1, 0 );

/** Scratch for {@link Fireball.update}; never escapes the call. */
const SCRATCH = new Vector3();

/** The one-shot `Chime` holds for this spell — loaded in `main`, at the gate. */
export const FIREBALL_SOUND = 'fireball';

/**
 * Gathers over the parchment, arcs downrange and detonates. The particles are a
 * {@link ParticleField}; this class is just the choreography — where the core is
 * this frame and how hard the emitter should be working.
 */
export class Fireball {

	/**
	 * Called the instant the shot detonates, with the point it went off at. That
	 * is the shot's target normally and the ward's shell when one ate it, so a
	 * listener has to judge what it hit rather than assume — which is exactly what
	 * `Recoil` does.
	 */
	onImpact: ( ( at: Vector3 ) => void ) | null = null;

	private phase: Phase = 'idle';
	private elapsed = 0;

	private readonly origin = new Vector3();
	private readonly target = new Vector3();
	private readonly control = new Vector3();
	private readonly corePosition = new Vector3();

	private readonly uCore = uniform( 0 );
	private readonly uShock = uniform( 0 );

	private readonly embers: ParticleField;

	/**
	 * The ash, as its own pool rather than a second population inside the embers'.
	 *
	 * `ParticleField` can already run two populations out of one kernel — that is
	 * what `dust` is — but the two share a palette, a lifetime and a damping, and
	 * ash disagrees with an ember about all three. It cools to soot where an ember
	 * cools to red, it lives over twice as long, and it falls slowly because it is
	 * mostly air resistance. Forcing it through the same uniforms would have meant
	 * compromising both, and the compromise is exactly what makes an effect read as "particles"
	 * instead of as fire and ash.
	 *
	 * 2,048 against the embers' 9,216. Ash is sparse — it is what is *left* — and
	 * the pool only has to look like a scatter rather than a shower.
	 */
	private readonly ash: ParticleField;
	private readonly core: Mesh;
	private readonly shock: Mesh;
	private readonly light: PointLight;

	constructor( renderer: WebGPURenderer, scene: Scene, private readonly chime: Chime ) {

		this.embers = new ParticleField( renderer, scene, {
			count: 9216,

			// Deep red through red-orange to a hot amber that the material takes on
			// to near-white at the moment of the throw. The old top was a plain
			// orange, which is the colour of the *middle* of a fire: with nothing
			// hotter above it every spark was the same orange dot at every age. It was
			// a pale yellow for a pass, and that was too far the other way — at the
			// emission these sparks now run at, AgX takes a pale yellow to white, and
			// the whole young shower read white rather than as a fire cooling. Amber
			// keeps its colour at eight or ten and leaves white to the first frames
			// of a spark's life, which is where the material puts it.
			palette: [ 0x3a0603, 0xff3a0a, 0xffa336 ],

			// Several octaves of noise per particle per frame, and worth every one of
			// them here. The other thing that made a detonation read as a bubble is
			// that nine thousand particles flying straight are nine thousand radii of
			// the same sphere: the field pushes neighbours the same way, so the pool
			// moves in sheets and the shell tears into billows instead of expanding
			// as a surface. It is the difference between an explosion and an inflation.
			turbulent: true,
		} );

		this.ash = new ParticleField( renderer, scene, {
			count: 2048,

			// Soot, a dull banked red, and an ember orange at the top, coldest first.
			// This was soot to *pale* ash, and pale was the problem: with nothing hot
			// in the ramp the only way to see a flake at all was to make it big and
			// light-coloured, which is snow. A flake that starts as an ember and
			// cools to soot on the way down is visible exactly while it is worth
			// seeing and goes dark as it lands. The heavy third (`dust`) is pulled to
			// the material's own flat grey whatever this says — the grit.
			palette: [ 0x0d0907, 0x4a1c0c, 0xff6a24 ],

			// The flutter. Ash falls badly — it is light enough that the air decides
			// where it goes — and the turbulence field is what makes neighbouring
			// flakes drift together in sheets rather than each picking its own line.
			turbulent: true,
		} );

		this.core = new Mesh( new IcosahedronGeometry( CORE_RADIUS, 4 ), this.buildCoreMaterial() );
		this.core.frustumCulled = false;
		this.core.visible = false;

		this.shock = new Mesh( new SphereGeometry( 1, 32, 16 ), this.buildShockMaterial() );
		this.shock.frustumCulled = false;
		this.shock.visible = false;

		this.light = new PointLight( 0xff7a2a, 0, 6, 2 );
		this.light.visible = false;

		scene.add( this.core, this.shock, this.light );

	}

	get active(): boolean {

		return this.phase !== 'idle';

	}

	/**
	 * True while the *spell* is still happening, as opposed to still being stepped.
	 *
	 * The ash outlives the fire by three seconds and the camera should not wait for
	 * it: what the shot is worth watching for is over when the light goes out, and
	 * flakes still coming down behind you as you turn back to the page is the point
	 * of having them. So `active` keeps the pools moving — particles only move while
	 * their field is stepped — while this is what the cast sequence waits on.
	 */
	get airborne(): boolean {

		return this.phase !== 'idle' && this.phase !== 'ash';

	}

	/** Where the core is right now — used to test it against the ward. */
	get position(): Vector3 {

		return this.corePosition;

	}

	/** Stops the shot short and detonates it here instead of at its target. */
	detonateAt( point: Vector3 ): void {

		if ( this.phase !== 'charge' && this.phase !== 'flight' ) return;

		this.target.copy( point );
		this.corePosition.copy( point );
		this.enter( 'burst' );
		this.shock.visible = true;

	}

	cast( origin: Vector3, target: Vector3 ): void {

		this.origin.copy( origin );
		this.target.copy( target );

		// Lob it: the arc peaks above the straight line so the shot reads in the
		// seated framing instead of shooting flat away from camera.
		this.control.lerpVectors( origin, target, 0.5 ).addScaledVector( UP, 0.55 );

		this.corePosition.copy( origin );
		this.embers.teleport( origin );

		this.phase = 'charge';
		this.elapsed = 0;

		this.core.visible = true;
		this.light.visible = true;

	}

	update( dt: number ): void {

		this.elapsed += dt;

		switch ( this.phase ) {

			case 'charge':
				this.charge();
				break;

			case 'flight':
				this.flight();
				break;

			case 'burst':
				this.burst();
				break;

			case 'settle':
				this.settle();
				break;

			case 'ash':
				this.ashfall();
				break;

			default:
				this.embers.extinguish();
				this.ash.extinguish();

		}

		this.core.position.copy( this.corePosition );
		this.light.position.copy( this.corePosition );

		// Once it has gone off, the light stands a little back from the point of
		// impact, level with it, on the side the shot came in from. The target is on the dummy's
		// surface, and a point light with inverse-square falloff sitting *on* a
		// surface paints a blown-out disc there — a pale glowing ball on the
		// bullseye that outlasted every spark and read as the biggest particle in
		// the shot. Sixty centimetres back — a third of a metre still left a hot
		// disc, since at that range the falloff is still steep across the dummy's
		// chest — the same light washes the dummy and the floor instead of burning
		// a hole in one spot of it. Level, because backing it off towards the arc's
		// control point lifted it to the dummy's head and moved the hot disc there.
		if ( this.phase === 'burst' || this.phase === 'settle' ) {

			SCRATCH.subVectors( this.origin, this.target ).setY( 0 ).normalize();
			this.light.position.addScaledVector( SCRATCH, 0.6 );

		}
		this.shock.position.copy( this.target );

		this.embers.step( dt );
		this.ash.step( dt );

	}

	private charge(): void {

		const t = Math.min( 1, this.elapsed / CHARGE_TIME );

		// Rises off the page as it gathers.
		this.corePosition.copy( this.origin ).addScaledVector( UP, 0.12 * t );

		this.embers.configure( {
			position: this.corePosition,

			// **Sparks falling in, not a pile building up.** They are born out on a
			// shell a hand's breadth wide and `attract` hauls them into the core, so
			// the gather has a direction — inwards — instead of being a cloud that
			// happens to be centred on something.
			//
			// The old gather was a swirl of 1.6 m/s against an `attract` that started
			// at 8, and a spring only holds an orbit of radius `swirl / √attract`:
			// that is over half a metre, which is why the charge was a pinkish heap
			// the width of the parchment rather than a knot of heat above it. Here
			// the spring starts at 30 and ends at 70 — a quarter-period, the time to
			// fall from the shell to the middle, of 0.29 s down to 0.19 s, so a spark
			// makes one pass at the core inside its life and is gone — and the swirl
			// is about half of what would hold a circle, so each one spirals in on a
			// flat ellipse rather than orbiting.
			swirl: 0.35,
			radius: 0.12 * ( 1 - t * 0.4 ),
			speed: 0.05,
			attract: 30 + 40 * t,

			// Heavy drag on top of the spring, so what overshoots the middle is
			// caught there instead of flying out the far side — the spiral closes.
			// Critical damping for this spring is `2√attract`, eleven to seventeen;
			// seven is a bit over half that, so a spark swings through the core once
			// and settles into it instead of ringing out to the shell and back, which
			// is what filled the gather in to a ball.
			damping: 7,

			// A spark's whole visit is one fall into the middle. About as long as the
			// spring's quarter-period plus a little, so they arrive, flare and die in
			// the core rather than hanging around it.
			lifeSpan: 0.34,

			// Sparse, because each one is now bright enough to be seen on its own.
			// Forty to sixty a frame on the dead pool, so under a thousand in the air
			// at the end of the gather — against the old rate's hundred-odd a frame
			// into a sprite twice the size, which piled up into a pale heap the width
			// of the page.
			spawnRate: 0.004 + t * 0.003,

			// Nothing rises: heat pooling upwards is what made the heap tall. The
			// core itself climbs off the page, and the sparks follow it.
			drift: new Vector3(),
			buoyancy: 0,

			// A few pixels, and hot. The recipe from the burst: a third of the old
			// size, several times the emission, so each core crosses the 1.15 bloom
			// on its own and the halo does the rest. The ramp with `t` is the charge
			// building — the last sparks in are the hottest.
			size: 0.0032 + t * 0.0012,
			growth: 0,
			spread: 0.7,
			glow: 7 + t * 7,
			halo: 0.06,
			haloSize: 5,

			// Hard squares burning out by size, smeared along their fall into short
			// dashes. A spark falls in at about `radius × √attract` — some sixty
			// centimetres a second — so 0.02 s of it is a centimetre, and the cap
			// holds the quick ones at five widths: a spiral of dashes pointing at the
			// core. The
			// old worry about stretch making a column was the overshoot at ten metres
			// a second that the heavy spring used to cause; at these speeds there is
			// none.
			square: 1,
			fadeSize: 1,
			opacity: 1,
			stretch: 0.02,
			streakMax: 5,
			sparkle: 0,
			twinkle: 0.3,

			// Just enough to keep the gather from being a perfect funnel.
			turbulence: 0.3,
			turbulenceScale: 1.6,
			turbulenceFriction: 2.2,
		} );

		// The white-hot middle the sparks are falling into. Small — it was allowed
		// to reach three-quarters of the flight size here, and under the spark halo
		// that read as a pink ball the sparks were piled on rather than a point of
		// heat — and driven past 1 by the end of the gather so it is the hottest
		// thing in the charge and blooms white, not salmon.
		this.uCore.value = 0.3 + t * 1.2;
		this.core.scale.setScalar( 0.12 + t * 0.3 );
		// A glow on the page, not a lamp on it: the light is a dozen centimetres
		// off the parchment here, and at the old 0.55 the end of the gather washed
		// the whole page out to a pale pink.
		this.light.intensity = 0.3 * t * t;

		if ( t >= 1 ) {

			// The arc leaves from where the gather ended, not from the page it
			// rose off. The curve used to start at the origin proper, so the core
			// dropped twelve centimetres in one frame on the way into flight — and
			// now that the trail inherits the emitter's motion, that frame slung a
			// fan of sparks straight down at the desk.
			this.origin.copy( this.corePosition );
			this.enter( 'flight' );

		}

	}

	private flight(): void {

		const t = Math.min( 1, this.elapsed / FLIGHT_TIME );

		quadratic( this.origin, this.control, this.target, t * t * ( 3 - 2 * t ), this.corePosition );

		this.embers.configure( {
			position: this.corePosition,
			// Sparse. This was 0.26 when the sprites were faint discs and the tail
			// had to be kept by count; a solid streak carries the trail on its own,
			// and at the old rate the whole nine-thousand pool was awake behind the
			// shot and the arc was a column of light rather than a wake of sparks.
			// The arithmetic: this is a per-dead-particle chance per frame, so 0.006
			// on a nine-thousand pool is about fifty sparks a frame, and at a 0.5 s
			// life that is some fifteen hundred in the air behind the shot — plenty,
			// now that each one is a point of light rather than part of a smear.
			spawnRate: 0.006,
			radius: 0.035,
			speed: 0.35,
			lifeSpan: 0.5,

			// Weak, and only so the last of the gather is towed off the page behind
			// the shot instead of being flung out of its orbit the instant the spring
			// lets go. At 3 it also dragged the wake back into the head, which bunched
			// the tail into a column following the core.
			attract: 1.2,

			// A fraction of the shot's own speed, not most of it. A comet's tail is
			// what the head leaves *behind*: at 0.6 the sparks kept pace with the core
			// and the wake was a sheath around it; at 0.25 they fall back along the
			// arc and only a little way past where they were shed, so the tail is laid
			// out along the path and every streak points the way the shot went.
			inherit: 0.25,

			// No lift, and then weight. The trail used to rise off the arc, which put
			// the sparks *above* a shot travelling on a lobbed curve — exactly
			// backwards. Falling away behind it is what makes the arc read as an arc
			// rather than as a line with a fringe.
			drift: new Vector3(),
			buoyancy: - 2.4,
			floor: FLOOR,

			// Embers a few pixels across, glowing on their own — see the burst. A
			// third of the old size, four times the emission: each one blooms, and
			// the wake is a scatter of points of light instead of pale blobs.
			size: 0.0038,
			growth: 0,
			spread: 0.8,
			glow: 14,
			halo: 0.05,
			haloSize: 5,

			// Short streaks along the way each ember is falling off the arc, so the
			// tail draws the shot's motion behind it — dashes, not lines.
			sparkle: 0,
			square: 1,
			fadeSize: 1,
			opacity: 1,
			stretch: 0.02,
			streakMax: 4,
			twinkle: 0.3,

			// The trail curls off the arc rather than trailing it in a tube.
			turbulence: 1.1,
			turbulenceScale: 1.1,
			turbulenceFriction: 1.8,
		} );

		// The comet's head: smaller than it was and hotter. At 0.8 and a multiplier
		// of 4.1 it was a twelve-centimetre ball that AgX took to a flat salmon
		// disc, the largest non-blooming thing in the shot. At half the size and
		// driven well past its charge brightness (`uCore` 2.2 takes the multiplier
		// to about 8), the middle goes white and blooms, and the trail is what carries
		// the size of the thing.
		this.uCore.value = 2.2;
		this.core.scale.setScalar( 0.5 );
		this.light.intensity = 2.6;

		if ( t >= 1 ) {

			this.enter( 'burst' );
			this.shock.visible = true;

		}

	}

	private burst(): void {

		const t = Math.min( 1, this.elapsed / BURST_TIME );

		this.corePosition.copy( this.target );

		this.embers.configure( {
			position: this.corePosition,

			// One punch, not a fountain. The rate is a per-frame chance for each dead
			// particle, and at the old 0.85 the whole nine-thousand pool was awake
			// within three frames — every one of them over the bloom at once, which
			// is the white-out. At 0.16 falling to nothing, the first frame throws
			// twelve hundred and the burst as a whole a bit over half the pool, most
			// of it in the first tenth of a second: a dense hot knot at the moment of
			// impact, then nothing new, so the shower that follows is the same sparks
			// cooling rather than fresh white ones being added to it.
			spawnRate: 0.16 * ( 1 - t ),
			radius: 0.1,
			speed: 3.4 * ( 1 - t * 0.55 ),

			// Long enough to arrive. At this gravity the shower needs about a second
			// and a quarter to get from the bullseye to the flagstones, and a particle
			// that expires in the air on the way down never lands at all — which is
			// the whole of what was being asked for.
			lifeSpan: 1.35,
			attract: - 1.5,

			// A hand's breadth of lift and then gravity, instead of 0.9 of lift and
			// none.
			drift: new Vector3( 0, 0.22, 0 ),
			buoyancy: GRAVITY,
			floor: FLOOR,

			// **What stops it being a ball.** Gravity alone was not enough, and the
			// reason is that a shell thrown at one speed in every direction *is* a
			// sphere — it stays one however hard it is pulled down, because every
			// point of it is pulled the same. So the two evennesses that were left
			// both go:
			//
			// `spray` breaks the speed. Most of the pool now barely leaves the impact
			// and a thin tail of leaders is thrown three times as far, so there is no
			// surface to be spherical — there is a dense core with fingers off it.
			//
			// `updraft` breaks the symmetry about the horizontal, which is the one an
			// explosion never has. A minority is kicked hard upwards into a plume and
			// the rest is driven down into the flagstones, and because gravity is
			// underneath it the plume arcs over and rains back down through them. The
			// crossing traffic is the whole effect: some particles going up while
			// others come down is what says *blast* rather than *bubble*.
			spray: 0.85,
			updraft: 3.4,

			// And the pool moves in sheets rather than as nine thousand independent
			// radii — see `turbulent` on the field itself. Hardest at the detonation
			// and it costs nothing to ask for, since the octaves are compiled in
			// either way.
			turbulence: 3.4,
			turbulenceScale: 0.85,
			turbulenceFriction: 1.1,

			// Less drag, because drag is what a fall has to fight. At 2.4 the embers
			// gave up their outward speed and their fall in the same breath and the
			// shower hung; at 1.9 the throw carries and the drop still terminates.
			damping: 1.9,

			// A quarter of them heavier than the rest, falling nearly twice as hard
			// and glowing under the bloom threshold rather than over it. Two speeds
			// out of one kernel is what gives a shower depth — one population arcs
			// out and rains, the other drops almost straight down through it.
			dust: 0.26,
			dustBuoyancy: - 9,
			// Under the bloom now that the sprite is solid — the heavy quarter is the
			// dark grit falling through the light, not more of the light.
			dustGlow: 0.8,
			dustSize: 0.8,

			// Sparks, not smoke. This was 0.075 with the full swell, which works out
			// at 18 cm across by the end of a particle's life — bigger than the
			// dummy's head, so nine thousand of them read as one soft cloud instead
			// of as a shower you can pick individual embers out of. The spread is
			// wide so a few big sparks ride among many small ones.
			size: 0.0055,
			growth: 0.1,
			spread: 0.88,

			// Hardest here, and it falls with `t`: the detonation is the one moment
			// the embers should be brighter than anything in the room, and the decay
			// is what stops the shower still glowing while it settles. Against a
			// solid sprite a few pixels wide, 11 takes every young core well over the
			// 1.15 bloom and still leaves the colour in it: the yellow top of the
			// ramp comes out at eight or nine, which AgX keeps yellow, where the 16 of
			// the first pass put it at fifteen and the whole shower read white. The
			// white is kept for the first few frames of a spark's life, where the
			// material's own tint puts it, and for the flash of the core.
			glow: 11 * ( 1 - t * 0.4 ),

			// A faint glow inside each sprite's own quad, and a small one. This pool
			// is dense at the moment of impact, and the halo is additive like
			// everything else: at 0.05 across six widths, a thousand overlapping
			// halos were a haze the size of the dummy that lit the wall pink. At
			// half the strength and four widths it costs less than half the fill and
			// stays a glow around each spark rather than a fog around all of them.
			halo: 0.025,
			haloSize: 4,
			streakMax: 5,

			// **What makes it an explosion rather than a shower.** Every spark is a
			// hard bar smeared along its own velocity for `stretch` seconds of travel:
			// the leaders `spray` throws three times as far draw long streaks out of
			// the blast, the slow body behind them stays a scatter of squares, and the
			// plume `updraft` sends up arcs over as a fan of lines. One number, and
			// the eye reads every speed in the pool at once — which is exactly what a
			// real burst shows and an even cloud of dots never can. Solid and dying
			// by size, so the shower keeps its contrast to the last frame instead of
			// dissolving into an orange haze.
			sparkle: 0,
			square: 1,
			fadeSize: 1,
			opacity: 1,
			stretch: 0.03,
			twinkle: 0.3,
		} );

		// …and the ash goes up with it. Thrown, but barely: what the blast does to a
		// flake is loft it, and everything after that is the air's business.
		this.ash.configure( {
			position: this.corePosition,
			radius: 0.45,
			spawnRate: 0.55 * ( 1 - t * 0.4 ),
			speed: 1.5,
			lifeSpan: ASH_TIME,
			attract: - 0.4,
			drift: new Vector3( 0, 1.1, 0 ),
			...ASH_FALL,
		} );

		// The flash: white-hot, brief, and not much bigger than the shot. It used
		// to swell to two and a half times the flight size — eighteen centimetres
		// of radius — while fading linearly, so for most of the burst there was a
		// pale ball the size of the dummy's head sitting in the middle of the
		// sparks. Now it starts hotter than the shot (the multiplier is about 9),
		// opens fast and is gone by the square of `t`: a flash, and then the
		// sparks.
		this.uCore.value = 2.4 * ( 1 - t ) ** 2;
		this.core.scale.setScalar( 0.5 + Math.sqrt( t ) * 1.1 );
		this.light.intensity = 3 + 6 * ( 1 - t ) ** 2;

		// The shock ring, kept to about half a metre and faded faster. At a metre
		// and a half it was a pale disc behind the whole dummy for most of the
		// burst, and even at a metre its edge still read as a circle drawn on the
		// wall; this small it is a ripple at the heart of the flash.
		this.shock.scale.setScalar( 0.1 + t * 0.5 );
		this.uShock.value = 0.5 * ( 1 - t ) ** 2;

		if ( t >= 1 ) {

			this.enter( 'settle' );
			this.core.visible = false;
			this.shock.visible = false;
			this.uShock.value = 0;

		}

	}

	private settle(): void {

		const t = Math.min( 1, this.elapsed / SETTLE_TIME );

		this.embers.extinguish();

		// The last of the ash is still being shed as the fire dies — a fire that
		// stops making smoke the instant it stops glowing is a fire that was never
		// burning anything.
		this.ash.configure( {
			position: this.corePosition,
			radius: 0.7,
			spawnRate: 0.12 * ( 1 - t ) ** 2,
			speed: 0.5,
			lifeSpan: ASH_TIME,
			drift: new Vector3( 0, 0.35, 0 ),
			...ASH_FALL,
		} );

		this.light.intensity = 3 * ( 1 - t ) ** 2;

		if ( t >= 1 ) {

			this.phase = 'ash';
			this.elapsed = 0;
			this.light.visible = false;

		}

	}

	/**
	 * Nothing is burning any more; this is the fall.
	 *
	 * Only the ash is still moving, and only because it is still being stepped —
	 * `airborne` has already gone false, so the camera went back to the page a
	 * beat ago and what is happening here is happening behind the player. That is
	 * the whole intent: the room takes a few seconds to be finished with a
	 * fireball, and it does not ask to be watched doing it.
	 */
	private ashfall(): void {

		this.ash.extinguish();

		if ( this.elapsed >= ASH_TIME ) this.phase = 'idle';

	}

	private enter( phase: Phase ): void {

		this.phase = phase;
		this.elapsed = 0;

		// Both routes into `burst` come through here — running out of flight, and
		// being stopped short by a ward — so this is the one place impact happens,
		// and the one place the sound belongs. It was on `cast` first, which put it
		// on the shot being made rather than on the shot landing; a ward swallowing
		// the fireball would have played the same sound a second and a half before
		// anything arrived anywhere.
		if ( phase === 'burst' ) {

			this.onImpact?.( this.target );
			this.chime.play( FIREBALL_SOUND, 0.85 );

		}

	}

	/**
	 * The core.
	 *
	 * It used to be one octave of noise tinted across a solid sphere, and the
	 * sphere was the problem: a smooth outline reads as a marble whatever is
	 * painted on it, so the hottest object in the room was also the most
	 * geometrically calm. Two things fix that, and both are about *shape*.
	 *
	 * **The silhouette boils.** `positionNode` pushes every vertex along its own
	 * normal by fractal noise that scrolls downwards through the sphere, so the
	 * outline is lumpy, asymmetric and never the same twice. Displacement in the
	 * vertex stage costs one noise per vertex rather than per pixel, which on 5,120
	 * triangles is cheaper than the shading it sits under.
	 *
	 * **The shading is domain-warped.** Fractal noise on its own gives soft round
	 * blobs — the same silhouette problem one level down. Warping the sample
	 * position by a *second* noise field before reading the first curdles those
	 * blobs into filaments and folds, which is what fire actually looks like: it is
	 * the cheapest structure that does not read as cloud.
	 *
	 * Then three ramps over it. One on how squarely the surface faces the camera,
	 * so the middle of the disc you see is white-hot and the edge is thin; a
	 * faint rim term on top, because a shell of gas is optically deepest where you
	 * look along it; and the hot band tightened with `smoothstep` so there is a
	 * visible boundary between the white core and the red body instead of a
	 * gradient across the whole ball.
	 */
	private buildCoreMaterial(): MeshBasicNodeMaterial {

		const material = new MeshBasicNodeMaterial();

		// Local space normalised to a unit sphere, so every frequency below is in
		// units of the core's own radius rather than of metres.
		const unit = positionLocal.div( CORE_RADIUS );
		const clock = time.mul( 1.4 );

		// The boil. Rising, so the surface reads as convecting rather than as
		// jittering in place.
		const swell = mx_fractal_noise_float( unit.mul( 2.3 ).add( vec3( 0, clock.mul( - 0.9 ), 0 ) ), 3 );

		material.positionNode = positionLocal.add(
			normalLocal.mul( swell.mul( CORE_RADIUS * CORE_BOIL ) ),
		);

		// The warp, and then the churn read through it.
		const warp = mx_fractal_noise_vec3(
			unit.mul( 1.9 ).add( vec3( clock.mul( 0.5 ), clock.mul( - 0.4 ), clock.mul( 0.45 ) ) ), 2, 2, 0.5, 0.75,
		);
		const churn = mx_fractal_noise_float(
			unit.mul( 3.6 ).add( warp ).add( vec3( 0, clock.mul( - 1.3 ), 0 ) ), 4,
		).mul( 0.5 ).add( 0.5 );

		// Hot in the middle, thin at the edge, and a little deeper where the sight
		// line runs along the shell.
		//
		// The middle used to be a radial term on the local position, and it never
		// did anything: every fragment of this mesh is *on* its surface, a radius
		// out, so it came to about 0.05 everywhere and the only thing lifting the
		// heat was the rim. That is why the core read as a salmon ball with a
		// lighter edge — hottest exactly where it should be thinnest. The middle of
		// the disc on screen is where the surface faces the camera, so that is what
		// the hot term follows now, and the rim is cut to a trace.
		const facing = pow( normalView.z.abs(), 1.5 );
		const rim = pow( facing.oneMinus(), 2.4 );

		const heat = churn.mul( 0.55 ).add( facing.mul( 0.9 ) ).add( rim.mul( 0.2 ) ).clamp( 0, 1.3 );

		// Three colours rather than two: the black-red body is what gives the white
		// core something to be the middle of. The middle one is amber rather than
		// the red-orange it was: driven to six or eight, a red with almost no green
		// in it is what AgX turns pink, and the head of the shot read as a salmon
		// ball. Amber at the same level comes out a hot orange going to white.
		const shell = mix(
			mix( color( 0x6d0f02 ), color( 0xff7a1e ), smoothstep( 0.15, 0.62, heat ) ),
			color( 0xfff6dc ),
			smoothstep( 0.72, 1.05, heat ),
		);

		// `uCore` 1 is 4.1; the phases drive it from about 1.6 at the start of the
		// charge to 8.4 in flight and a flash of 9 at impact.
		//
		// Those top figures were once tried and rejected — taken to 8 to "out-glare
		// the candles", a sphere fifteen centimetres wide went off like a flashbulb,
		// washed the room pink and drowned the ember shower. What changed is the
		// size: the core is now kept to two to eight centimetres across while it is
		// that hot, and only opens out as it fades (see the `scale` each phase
		// sets), so the same emission covers a quarter of the
		// screen it used to and reads as a white-hot point with a bloom rather than
		// as a lamp. The halo around the shot still comes from the sparks.
		material.colorNode = shell.mul( heat.mul( 0.55 ).add( 0.45 ) ).mul( this.uCore.mul( 3.6 ).add( 0.5 ) );
		material.transparent = true;
		material.depthWrite = false;
		material.blending = AdditiveBlending;

		// The MRT marker: a ball of plasma is not a surface, and a shockwave shell
		// is less of one still. See `scene/gbuffer.ts`.
		material.mrtNode = transparentMRT();

		return material;

	}

	private buildShockMaterial(): MeshBasicNodeMaterial {

		const material = new MeshBasicNodeMaterial();

		// Fresnel shell: a thin bright ring at the silhouette, hollow through the
		// middle, so an expanding sphere reads as a shockwave rather than a bubble.
		const rim = pow( normalView.z.abs().oneMinus(), 6 );

		material.colorNode = mix( color( 0xff7a2a ), color( 0xffe9b0 ), rim );
		material.opacityNode = rim.mul( this.uShock ).mul( 0.85 );
		material.transparent = true;
		material.depthWrite = false;
		material.blending = AdditiveBlending;

		// The MRT marker: a ball of plasma is not a surface, and a shockwave shell
		// is less of one still. See `scene/gbuffer.ts`.
		material.mrtNode = transparentMRT();

		return material;

	}

}

function quadratic( a: Vector3, b: Vector3, c: Vector3, t: number, out: Vector3 ): Vector3 {

	const s = 1 - t;

	return out
		.copy( a ).multiplyScalar( s * s )
		.addScaledVector( b, 2 * s * t )
		.addScaledVector( c, t * t );

}
