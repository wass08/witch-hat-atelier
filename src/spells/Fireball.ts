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
/**
 * Everything about the ash that does not change between being thrown and being
 * shed: what it looks like, and how it comes down.
 *
 * The numbers are all arguments about air rather than about fire. `buoyancy`
 * −0.55 against `damping` 1.6 is a terminal fall of about a third of a metre a
 * second, so a flake lofted two metres takes most of `ASH_TIME` to land — which is
 * why ash is still coming down when everything else has finished. `glow` 0.9 keeps
 * it *under* the 1.15 bloom threshold on purpose: ash is lit, not luminous, and a
 * flake with a halo is an ember. `sparkle` 0 for the same reason — a glint is a
 * point of light, and this is a piece of something. What it has instead is
 * `twinkle`, which is the only thing here that is not about air: a flake turning
 * over catches the room's light and loses it again.
 */
const ASH_FALL = {
	shape: 0,
	size: 0.028,
	growth: 0.1,
	spread: 0.9,
	glow: 0.9,
	sparkle: 0,
	twinkle: 0.5,
	twinkleRate: 1.5,
	buoyancy: - 0.55,
	damping: 1.6,
	floor: FLOOR,

	// A third of it heavier — grit rather than flake — falling three times as hard.
	// Two speeds is what stops a fall reading as one sheet coming down.
	dust: 0.32,
	dustBuoyancy: - 1.9,
	dustGlow: 0.55,
	dustSize: 0.7,

	turbulence: 1.6,
	turbulenceScale: 0.5,
	turbulenceFriction: 0.9,
} as const;

const CORE_RADIUS = 0.075;
const CORE_BOIL = 0.42;

const UP = new Vector3( 0, 1, 0 );

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
	 * ash disagrees with an ember about all three. It is grey rather than lit, it
	 * lives four times as long, and it falls slowly because it is mostly air
	 * resistance. Forcing it through the same uniforms would have meant compromising
	 * both, and the compromise is exactly what makes an effect read as "particles"
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
			palette: [ 0x2a0407, 0xd8330a, 0xff8a1e ],

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

			// Soot to pale ash, coldest first. Nothing in this ramp is a fire colour:
			// what separates ash from a dying ember is that it was never burning.
			palette: [ 0x14100e, 0x4a423c, 0xc0b4a6 ],

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
			swirl: 1.6,
			spawnRate: 0.05,
			radius: 0.07 * ( 1 - t * 0.72 ),
			speed: 0.04,
			lifeSpan: 0.38,
			attract: 34 * t + 8,
			drift: new Vector3( 0, 0.08, 0 ),

			// The gather is the one phase that may still swell a little — it reads as
			// heat pooling rather than as sparks thrown.
			size: 0.007 + t * 0.003,
			growth: 0.5,
			spread: 0.7,

			// Just over the bloom threshold as the gather finishes, so the halo comes
			// up with the charge instead of switching on. The whole ramp sits higher
			// than it did — the candle three inches away emits at 7, and a fireball
			// being gathered has no business being the dimmer of the two.
			glow: 4 + t * 4.5,

			// Heat pooling, so this is the one phase that still rises.
			buoyancy: 0.3,

			// A glint rather than a blob. The round sprite is the silhouette of a
			// puff of smoke and no amount of tuning the motion argues with a
			// silhouette; the spikes are what read as light. Gentle here, because
			// what is being described is a gather rather than a shower.
			sparkle: 0.3,
			twinkle: 0.25,

			// Just enough to keep the pool boiling while it waits.
			turbulence: 0.5,
			turbulenceScale: 1.6,
			turbulenceFriction: 2.2,
		} );

		this.uCore.value = t;
		this.core.scale.setScalar( 0.2 + t * 0.55 );
		this.light.intensity = 0.55 * t * t;

		if ( t >= 1 ) this.enter( 'flight' );

	}

	private flight(): void {

		const t = Math.min( 1, this.elapsed / FLIGHT_TIME );

		quadratic( this.origin, this.control, this.target, t * t * ( 3 - 2 * t ), this.corePosition );

		this.embers.configure( {
			position: this.corePosition,
			// Smaller embers cover less of the screen, and an additive glow is area
			// times count — so the tail is kept by throwing more of them, not bigger
			// ones. That is the trade that turns a smear into a trail of sparks.
			spawnRate: 0.26,
			radius: 0.045,
			speed: 0.4,
			lifeSpan: 0.45,
			attract: 3,

			// Barely any lift, and then weight. The trail used to rise off the arc,
			// which put the sparks *above* a shot travelling on a lobbed curve —
			// exactly backwards. Falling away behind it is what makes the arc read as
			// an arc rather than as a line with a fringe.
			drift: new Vector3( 0, 0.1, 0 ),
			buoyancy: - 1.6,
			floor: FLOOR,
			size: 0.013,
			growth: 0.25,
			spread: 0.8,
			glow: 9,
			sparkle: 0.45,
			twinkle: 0.2,

			// The trail curls off the arc rather than trailing it in a tube.
			turbulence: 1.1,
			turbulenceScale: 1.1,
			turbulenceFriction: 1.8,
		} );

		this.uCore.value = 1;
		this.core.scale.setScalar( 0.8 );
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
			spawnRate: 0.85,
			radius: 0.14,
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
			dustGlow: 2.6,
			dustSize: 0.8,

			// Sparks, not smoke. This was 0.075 with the full swell, which works out
			// at 18 cm across by the end of a particle's life — bigger than the
			// dummy's head, so nine thousand of them read as one soft cloud instead
			// of as a shower you can pick individual embers out of.
			size: 0.020,
			growth: 0.3,
			spread: 0.82,

			// Hardest here, and it falls with `t`: the detonation is the one moment
			// the embers should be brighter than anything in the room, and the decay
			// is what stops the shower still glowing while it settles. 9 was not
			// brighter than anything in the room — a candle flame emits at 7 across a
			// sprite that fills far more of the screen than an ember does, which is
			// why the candles beside the parchment out-bloomed the detonation.
			glow: 16 * ( 1 - t * 0.5 ),

			// The glint, hardest of the three phases. This is a shower of sparks and
			// a spark is a point of light, not a dot of matter.
			sparkle: 0.6,
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

		this.uCore.value = 1 - t;
		this.core.scale.setScalar( 0.8 + t * 1.6 );
		this.light.intensity = 16 * ( 1 - t * 0.7 );

		this.shock.scale.setScalar( 0.12 + t * 1.5 );
		this.uShock.value = ( 1 - t ) ** 1.5;

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

		this.light.intensity = 5 * ( 1 - t ) ** 2;

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
	 * Then three ramps over it. A radial one, so the middle is white-hot and the
	 * edge is thin; a rim term on top, because a shell of gas is optically deepest
	 * where you look along it; and the hot band tightened with `smoothstep` so
	 * there is a visible boundary between the white core and the red body instead
	 * of a gradient across the whole ball.
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

		// Hot in the middle, thin at the edge, and deepest where the sight line runs
		// along the shell.
		const radial = smoothstep( 1.05, 0.15, unit.length() );
		const rim = pow( normalView.z.abs().oneMinus(), 2.4 );

		const heat = churn.mul( 0.62 ).add( radial.mul( 0.55 ) ).add( rim.mul( 0.4 ) ).clamp( 0, 1.3 );

		// Three colours rather than two: the black-red body is what gives the white
		// core something to be the middle of.
		const shell = mix(
			mix( color( 0x6d0f02 ), color( 0xff5a12 ), smoothstep( 0.15, 0.62, heat ) ),
			color( 0xfff6dc ),
			smoothstep( 0.72, 1.05, heat ),
		);

		// 4.1 at full charge, against 2.8 before and the candle's 7.
		//
		// The candle is not the comparison it looks like. It emits 7 through a sprite
		// a few centimetres across; this is a sphere 15 cm wide seen from two metres,
		// so the same number covers thirty times the screen. Taken to 8 to "out-glare
		// the candles" it did — it went off like a flashbulb, washed the room pink and
		// drowned the ember shower it was supposed to be lighting, which is the exact
		// opposite of what more bloom was wanted for. The halo has to come from the
		// sparks; the core only has to be hot enough to sit inside it.
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
