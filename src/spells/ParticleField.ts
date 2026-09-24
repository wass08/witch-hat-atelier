import {
	AdditiveBlending,
	Color,
	InstancedMesh,
	Matrix4,
	PlaneGeometry,
	Scene,
	SpriteNodeMaterial,
	Vector3,
	type WebGPURenderer,
} from 'three/webgpu';
import {
	Fn,
	If,
	abs,
	atan,
	clamp,
	cos,
	cross,
	float,
	hash,
	instanceIndex,
	instancedArray,
	max,
	mix,
	modelViewMatrix,
	mx_fractal_noise_vec3,
	pow,
	sin,
	smoothstep,
	sqrt,
	step,
	uint,
	uniform,
	uv,
	vec2,
	vec3,
	vec4,
} from 'three/tsl';

import { transparentMRT } from '../scene/gbuffer';
import type { ColorUniform } from '../tsl-types';
import { ParticleLinks, type LinkOptions } from './ParticleLinks';

export interface FieldOptions {
	count: number;
	/** Colour ramp from coldest (oldest) to hottest (youngest). */
	palette: [ number, number, number ];
	/**
	 * Adds a fractal-noise turbulence term to the motion. Compiled in only when
	 * asked for: it is several octaves of noise per particle per frame, and three
	 * of the four spells here want their particles to fly straight.
	 */
	turbulent?: boolean;
	/** Draws ribbons between each particle and its two nearest live neighbours. */
	links?: LinkOptions;
}

/** Everything the CPU is allowed to say about the emitter, per frame. */
export interface EmitterState {
	position: Vector3;
	/** 0 spawns on a sphere shell, 1 spawns on a flat disc. */
	shape: number;
	/** Tangential kick, for particles that should orbit rather than fly straight. */
	swirl: number;
	/** Chance per frame that a dead particle comes back. */
	spawnRate: number;
	radius: number;
	speed: number;
	lifeSpan: number;
	/** Positive pulls towards the emitter, negative pushes away. */
	attract: number;
	drift: Vector3;
	size: number;
	/**
	 * How much a particle swells over its life. 1 quadruples it, which reads as
	 * smoke; towards 0 it holds the size it was born at, which reads as a spark.
	 */
	growth: number;
	/**
	 * Spread of sizes within one emission, 0..1. At 0 every particle is the same
	 * size; higher leaves the big ones alone and takes the small ones smaller, so
	 * a shower reads as a scatter of sparks rather than as a wall of one blob.
	 */
	spread: number;
	/**
	 * Multiplies the colour a particle emits, and its purpose is the bloom pass.
	 *
	 * A particle's additive contribution is its tint times its heat ramp times the
	 * 0.22 the sprite's alpha carries — about 0.30 at the very hottest — and the
	 * bloom in `Post` does not open until 1.15. So at 1 nothing here has ever
	 * bloomed on its own; only enough overlapping sprites stacking on the same
	 * pixel ever pushed a *region* over the line, which is why the effects lost
	 * their halo when the particles were made small enough to stop overlapping.
	 * Past about 3.8 a spark's own core crosses the threshold and glows by itself.
	 *
	 * Values above 1 are HDR and AgX rolls them off, so this buys glow rather than
	 * white-out: the heat ramp means only the young half of a particle's life is
	 * lifted, and the sprite's radial falloff means only the middle of it, so what
	 * blooms is a hot core inside a spark that still has an edge.
	 */
	glow: number;
	/**
	 * How unevenly the pool is thrown, 0..1.
	 *
	 * At 0 every particle leaves at `speed` give or take 30%, which is what makes a
	 * detonation a *ball*: an even speed in every direction is the definition of an
	 * expanding sphere, and no amount of gravity or turbulence afterwards undoes a
	 * shell that started perfect. Towards 1 the same directions get wildly
	 * different speeds — a few leaders three times the mean, a majority barely
	 * moving — so the shell breaks into fast fingers with a slow body behind them
	 * before anything else has touched it.
	 *
	 * Cheap, because it is the one factor the launch already had: this widens the
	 * random multiplier rather than adding a term.
	 */
	spray: number;

	/**
	 * A vertical kick on top of the launch, in metres per second, drawn two-sided
	 * per particle: some go up hard, some are driven down into the floor.
	 *
	 * The other half of what stops a burst reading as a sphere. An explosion is not
	 * symmetrical about the horizontal — it throws a plume up and hammers the rest
	 * of itself into the ground — and a shell that expands evenly has neither. With
	 * gravity underneath, the ones thrown up arc over and rain back down through
	 * the ones that were driven under, which is the crossing traffic that reads as
	 * *blast* rather than as *bubble*.
	 */
	updraft: number;

	/** Upwards acceleration; negative makes sparks fall. */
	buoyancy: number;

	/**
	 * World height the pool cannot fall through.
	 *
	 * Gravity on its own only means the shower leaves downwards, and a spark that
	 * sinks through the flagstones is worse than one that never fell: the room
	 * stops having a floor for as long as you are watching it happen. With a floor
	 * the same fall *lands* — the embers pile at the foot of whatever was hit,
	 * skid, and burn out there, which is the half of the throw that says how heavy
	 * they were.
	 *
	 * Defaults to far below the room, so every effect that has not asked for
	 * gravity is untouched.
	 */
	floor: number;
	/** Velocity retained per second, roughly. */
	damping: number;
	/** How hard the turbulence field pushes. Ignored unless the field is turbulent. */
	turbulence: number;
	/** Spatial frequency of the turbulence — small is broad and slow. */
	turbulenceScale: number;
	/** How fast the turbulence bleeds its own velocity back off, per second. */
	turbulenceFriction: number;

	/**
	 * Fraction of the pool that is heavy paper dust rather than ember, 0..1.
	 *
	 * Two populations out of one kernel, because two directions at once is what
	 * reads as depth: the embers rise and the dust falls through them. Splitting
	 * the pool costs nothing — no second field, no second draw call, no new
	 * pipeline — because the choice is a stable per-particle hash rather than a
	 * uniform, so the same compiled kernel runs both.
	 *
	 * The hash is deliberately *not* the `grain` the material already uses for
	 * size spread. Sharing it would tie dust-ness to size and every falling
	 * particle would be one of the small ones, which is a pattern the eye picks up
	 * immediately.
	 *
	 * Defaults to 0, so every existing effect is untouched.
	 */
	dust: number;
	/** The dust's own buoyancy. Negative falls; it also ignores `drift`. */
	dustBuoyancy: number;
	/**
	 * The dust's own emission, kept separate so it can sit below the bloom.
	 *
	 * This is the point of the dust. An ember at `glow` 4.2 has a core over the
	 * 1.15 bloom threshold and halos; paper dust must not, or the two populations
	 * read as one shower of sparks at two speeds. At 1 it is lit but never blooms.
	 */
	dustGlow: number;
	/** Size multiplier for the dust, against the ember's `size`. */
	dustSize: number;

	/**
	 * How much `glow` is concentrated in the young half of a particle's life,
	 * 0..1. At 0 the emission is flat across the whole life, which is what every
	 * spell here wants. At 1 it rides the heat ramp, so a particle blooms only
	 * while it is hot and its tail falls away to a dim ember.
	 *
	 * This is what turns a uniform ribbon of sparks into a gradient. The emitter
	 * is a single point sweeping the line, so the ribbon's far end is simply its
	 * oldest particles — making brightness follow age is therefore the same thing
	 * as making it follow distance back along the stroke.
	 */
	glowFocus: number;

	/**
	 * How deeply each particle pulses on its own, 0..1. At 0 it is steady.
	 *
	 * Every particle gets its own phase *and* its own rate, both from stable
	 * hashes, which is the whole point: a shared clock would make the pool blink
	 * in unison and read as a strobe rather than as a swarm. This is what turns a
	 * shower of sparks into something that looks alive.
	 */
	twinkle: number;
	/** Base pulses per second, before each particle's own variation. */
	twinkleRate: number;

	/**
	 * Blends the sprite from a round blob towards a four-pointed glint, 0..1.
	 *
	 * The round sprite is a soft radial falloff, which is the shape of a puff of
	 * smoke — no amount of tuning the motion gets away from that, because the
	 * silhouette is doing the talking. A glint has spikes and a hard core, so it
	 * reads as light rather than as matter.
	 *
	 * Each particle's star is rotated by its own stable hash. Without that they all
	 * point the same way and the pool reads as a printed pattern.
	 *
	 * Defaults to 0, so every spell keeps the round sprite it was tuned against.
	 */
	sparkle: number;

	/**
	 * Smears each sprite along its own velocity, in seconds of travel.
	 *
	 * The quad is turned to face the way the particle is going on screen and
	 * lengthened by how far it would move in this many seconds — a motion-blur
	 * exposure, in effect — so the fast leaders of a burst draw long streaks and
	 * the slow body behind them stays a dot. That spread of lengths is most of
	 * what separates a fire *explosion* from a cloud of embers: the eye reads the
	 * length of a streak as its speed, and a blast has every speed at once. Each
	 * particle carries its own multiplier on top, so two neighbours thrown at the
	 * same speed still leave different marks.
	 *
	 * Only the screen-plane part of the velocity counts — a spark flying straight
	 * at the camera has nothing to smear — and the length is capped at
	 * {@link STREAK_MAX_ASPECT} widths. At 0 nothing is turned or stretched.
	 */
	stretch: number;

	/**
	 * Blends the sprite from the soft disc towards a hard-edged square, 0..1.
	 *
	 * A soft radial falloff is a puff whatever colour it is; a square with an
	 * edge is a *thing*. Combined with `stretch` the square becomes a bar, which
	 * is the shape of a spark trail. Under bloom the hard edge is what keeps a
	 * bright core inside the halo instead of dissolving into it.
	 */
	square: number;

	/**
	 * How much of a particle's dying is done by shrinking rather than by fading,
	 * 0..1.
	 *
	 * At 0 the alpha rides the old puff curve — up over the first tenth, then a
	 * long fade — and the size holds. At 1 the alpha stays solid for the whole
	 * life and the *size* goes instead: full while the particle is hot, then
	 * smoothly to nothing. A spark that fades in place reads as a light dimming;
	 * one that shrinks reads as a thing burning out, and a shower of them keeps
	 * its contrast to the last frame instead of turning into a translucent wash.
	 */
	fadeSize: number;

	/**
	 * The sprite's alpha at full mask. This used to be a constant 0.22 baked into
	 * the material, which is why nothing in a field ever bloomed on its own — the
	 * additive contribution is `tint × glow × opacity`, and a fifth of the glow
	 * was gone before the bloom ever saw it. At 1 the core is solid and `glow`
	 * means what it says.
	 */
	opacity: number;

	/**
	 * How much of the emitter's own motion a newborn particle sets off with, 0..1.
	 *
	 * The kernel already knows where the emitter was last frame, for smearing
	 * spawns along its path; this hands the same displacement over as a velocity.
	 * At 0 a spark shed from a moving source is dropped where it is shed, so the
	 * wake behind a shot is a column of sparks falling from the arc. At 1 every
	 * spark leaves at the shot's full speed and the wake is a comet's — sparks
	 * flying on behind it and only then falling away, which with `stretch` is a
	 * fan of streaks rather than a stack of dots.
	 */
	inherit: number;

	/**
	 * A soft glow drawn around each particle inside its own quad, 0..1 — the
	 * halo's alpha at its centre, falling off cubically to nothing at the edge.
	 * Small numbers: the colour it multiplies is the HDR `glow`, so 0.06 on a
	 * spark at `glow` 14 is a halo of about 0.8, under the bloom.
	 *
	 * The bloom in `Post` opens at 1.15 and is deliberately gentle, because the room
	 * is tuned against it. A spark a few pixels across that is hot enough to cross
	 * it blooms, but the bloom's widest mips spread so little of a tiny sprite's
	 * energy that the halo is barely there — which is how a shower of small solid
	 * squares ends up reading as confetti. Drawing the halo here instead puts it
	 * exactly where it belongs, at a strength each effect chooses, without touching
	 * the room: the core stays over the threshold and blooms for real, the halo is
	 * the same colour at a few percent and stays under it.
	 *
	 * Costs fill rate, not draws — the quad grows by {@link EmitterState.haloSize}.
	 * At 0 the quad is exactly the sprite it was.
	 */
	halo: number;
	/** How far the halo reaches, as a multiple of the core's width. */
	haloSize: number;

	/**
	 * The longest a streak may get, as a multiple of its width. See `stretch`.
	 *
	 * Fourteen was the old constant, which is right for a lone leader and wrong for
	 * a pool: nine thousand fourteen-wide bars are a wall of matchsticks. A spark
	 * trail wants a short dash with a bright head, not a line.
	 */
	streakMax: number;

	/**
	 * How far a newborn particle is pushed towards white, 0..1. At 1 — the default,
	 * and what fire wants — the hottest tenth of every life runs to a warm white,
	 * which is what makes an ember read as incandescent. A spell's own colour is
	 * the other case: a blue firefly that is born white reads as a white one, and a
	 * pale ink colour has no headroom to spare.
	 */
	whiteHot: number;

	/**
	 * How much of the birth ramp is measured in seconds rather than in life, 0..1.
	 *
	 * A particle grows in over its first 8% of life and its alpha over the first
	 * 5%, which is invisible on a half-second spark and a whole beat on a
	 * three-second firefly: ten frames of nothing, so a mote shed exactly where the
	 * ink was going showed up a stroke's length behind it. At 1 both ramps take a
	 * fixed {@link SNAP_SECONDS} instead, so whatever is born is on screen the
	 * frame it is born — which is the whole contract when the thing emitting it is
	 * the edge of something visibly disappearing.
	 */
	snap: number;
}

/**
 * What the floor takes off a spark that lands on it: most of its speed along the
 * stone, per second, and all but a quarter of the fall it arrived with.
 *
 * A bounce at all is the point — an ember that simply stops at floor level reads
 * as one that was switched off there — but it has to be small, or a shower turns
 * into a tray of bouncing balls.
 */
const GROUND_DRAG = 6;
const GROUND_BOUNCE = 0.25;

/**
 * Half-width of a glint's spikes, in sprite widths.
 *
 * Narrow. The spike is what says "light"; widen it and the star fills in towards
 * the round blob it was chosen instead of.
 */
const SPIKE_WIDTH = 0.055;

/** Scratch for {@link ParticleField.recolour}; never escapes the call. */
const SCRATCH_COLOR = new Color();

const DEFAULTS: EmitterState = {
	position: new Vector3(),
	shape: 0,
	swirl: 0,
	spawnRate: 0,
	radius: 0.05,
	speed: 0.5,
	lifeSpan: 0.6,
	attract: 0,
	drift: new Vector3(),
	size: 0.02,
	growth: 1,
	spread: 0.55,
	glow: 1,
	spray: 0,
	updraft: 0,
	buoyancy: 0.45,
	floor: - 1e4,
	damping: 2.4,
	turbulence: 0,
	turbulenceScale: 0.5,
	turbulenceFriction: 1,
	dust: 0,
	dustBuoyancy: - 0.04,
	dustGlow: 1,
	dustSize: 0.7,
	glowFocus: 0,
	twinkle: 0,
	twinkleRate: 3.2,
	sparkle: 0,
	stretch: 0,
	square: 0,
	fadeSize: 0,
	opacity: 0.22,
	inherit: 0,
	halo: 0,
	haloSize: 4,
	// `stretch` is a time, so a leader thrown at ten metres a second would ask for
	// a streak most of a metre long; past this it stops reading as a spark.
	streakMax: 14,
	whiteHot: 1,
	snap: 0,
};

/** The birth ramp under {@link EmitterState.snap}: a frame and a bit. */
const SNAP_SECONDS = 0.02;

/**
 * A pool of particles that lives entirely in storage buffers, advanced by one
 * TSL compute kernel per frame. The CPU only describes the emitter — where it
 * is, how fast it spits, how hard it pulls — so a fireball's charge, a spark
 * shower and a column of rising embers are all the same kernel under different
 * uniforms.
 */
export class ParticleField {

	readonly mesh: InstancedMesh;

	private readonly count: number;

	private readonly positions;
	private readonly velocities;
	private readonly lives;

	private readonly uDelta = uniform( 0 );
	private readonly uSeed = uniform( 0, 'uint' );
	private readonly uEmitter = uniform( new Vector3() );
	private readonly uPrevEmitter = uniform( new Vector3() );
	private readonly uShape = uniform( 0 );
	private readonly uSwirl = uniform( 0 );
	private readonly uSpawnRate = uniform( 0 );
	private readonly uRadius = uniform( 0.05 );
	private readonly uSpeed = uniform( 0.5 );
	private readonly uLifeSpan = uniform( 0.6 );
	private readonly uAttract = uniform( 0 );
	private readonly uDrift = uniform( new Vector3() );
	private readonly uSize = uniform( 0.02 );
	private readonly uGrowth = uniform( 1 );
	private readonly uEmission = uniform( 1 );
	private readonly uSpread = uniform( 0.55 );
	private readonly uSpray = uniform( 0 );
	private readonly uUpdraft = uniform( 0 );
	private readonly uBuoyancy = uniform( 0.45 );
	private readonly uFloor = uniform( - 1e4 );
	private readonly uDamping = uniform( 2.4 );
	private readonly uTurbulence = uniform( 0 );
	private readonly uTurbScale = uniform( 0.5 );
	private readonly uTurbFriction = uniform( 1 );
	private readonly uDust = uniform( 0 );
	private readonly uDustBuoyancy = uniform( - 0.04 );
	private readonly uDustGlow = uniform( 1 );
	private readonly uDustSize = uniform( 0.7 );
	private readonly uGlowFocus = uniform( 0 );
	private readonly uTwinkle = uniform( 0 );
	private readonly uTwinkleRate = uniform( 3.2 );
	private readonly uSparkle = uniform( 0 );
	private readonly uStretch = uniform( 0 );
	private readonly uSquare = uniform( 0 );
	private readonly uFadeSize = uniform( 0 );
	private readonly uOpacity = uniform( 0.22 );
	private readonly uInherit = uniform( 0 );
	private readonly uHalo = uniform( 0 );
	private readonly uHaloSize = uniform( 4 );
	private readonly uStreakMax = uniform( 14 );
	private readonly uWhiteHot = uniform( 1 );
	private readonly uSnap = uniform( 0 );
	/** Seconds since the field was built, for anything that has to oscillate. */
	private readonly uClock = uniform( 0 );

	private readonly updateKernel;
	private readonly links: ParticleLinks | null;
	/** The live palette, so a field can be re-tinted without a rebuild. */
	private readonly ramp: [ ColorUniform, ColorUniform, ColorUniform ];
	private readonly turbulent: boolean;
	private readonly previous = new Vector3();
	private seeded = false;

	constructor( private readonly renderer: WebGPURenderer, scene: Scene, options: FieldOptions ) {

		this.count = options.count;
		this.turbulent = options.turbulent === true;

		this.positions = instancedArray( this.count, 'vec3' );
		this.velocities = instancedArray( this.count, 'vec3' );
		this.lives = instancedArray( this.count, 'vec2' );

		this.updateKernel = this.buildUpdateKernel();

		this.links = options.links === undefined
			? null
			: new ParticleLinks( renderer, scene, this.count, this.positions, this.lives, options.links );

		this.ramp = options.palette.map( ( hex ) => uniform( new Color( hex ) ) ) as [ ColorUniform, ColorUniform, ColorUniform ];

		this.mesh = new InstancedMesh( new PlaneGeometry( 1, 1 ), this.buildMaterial(), this.count );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 10;

		// InstancedMesh allocates its matrices zeroed; the sprites need identity.
		const identity = new Matrix4();

		for ( let i = 0; i < this.count; i ++ ) this.mesh.setMatrixAt( i, identity );

		this.mesh.instanceMatrix.needsUpdate = true;

		scene.add( this.mesh );

		this.reset();

	}

	/** Parks every particle out of sight and marks them dead. */
	reset(): void {

		const seed = Fn( () => {

			this.positions.element( instanceIndex ).assign( vec3( 0, - 50, 0 ) );
			this.lives.element( instanceIndex ).assign( vec2( 1, 0.0001 ) );

		} )().compute( this.count );

		this.renderer.compute( seed );
		this.seeded = true;

	}

	/** Places the emitter without drawing a trail from wherever it used to be. */
	teleport( position: Vector3 ): void {

		this.previous.copy( position );
		this.uEmitter.value.copy( position );
		this.uPrevEmitter.value.copy( position );

	}

	configure( state: Partial<EmitterState> ): void {

		const merged = { ...DEFAULTS, ...state };

		this.uShape.value = merged.shape;
		this.uSwirl.value = merged.swirl;
		this.uSpawnRate.value = merged.spawnRate;
		this.uRadius.value = merged.radius;
		this.uSpeed.value = merged.speed;
		this.uLifeSpan.value = merged.lifeSpan;
		this.uAttract.value = merged.attract;
		this.uSize.value = merged.size;
		this.uGrowth.value = merged.growth;
		this.uEmission.value = merged.glow;
		this.uSpread.value = merged.spread;
		this.uSpray.value = merged.spray;
		this.uUpdraft.value = merged.updraft;
		this.uBuoyancy.value = merged.buoyancy;
		this.uFloor.value = merged.floor;
		this.uDamping.value = merged.damping;
		this.uTurbulence.value = merged.turbulence;
		this.uTurbScale.value = merged.turbulenceScale;
		this.uTurbFriction.value = merged.turbulenceFriction;
		this.uDust.value = merged.dust;
		this.uDustBuoyancy.value = merged.dustBuoyancy;
		this.uDustGlow.value = merged.dustGlow;
		this.uDustSize.value = merged.dustSize;
		this.uGlowFocus.value = merged.glowFocus;
		this.uTwinkle.value = merged.twinkle;
		this.uTwinkleRate.value = merged.twinkleRate;
		this.uSparkle.value = merged.sparkle;
		this.uStretch.value = merged.stretch;
		this.uSquare.value = merged.square;
		this.uFadeSize.value = merged.fadeSize;
		this.uOpacity.value = merged.opacity;
		this.uInherit.value = merged.inherit;
		this.uHalo.value = merged.halo;
		this.uHaloSize.value = Math.max( 1, merged.haloSize );
		this.uStreakMax.value = Math.max( 1, merged.streakMax );
		this.uWhiteHot.value = merged.whiteHot;
		this.uSnap.value = merged.snap;
		this.uDrift.value.copy( merged.drift );

		if ( state.position !== undefined ) this.uEmitter.value.copy( state.position );

	}

	/**
	 * Advances the pool. Particles move only while this is called, so an effect
	 * that stops stepping with particles still alive leaves them frozen in the
	 * air — keep stepping until the last lifetime has expired.
	 */
	step( dt: number ): void {

		if ( ! this.seeded ) this.reset();

		this.uDelta.value = Math.min( dt, 1 / 30 );
		this.uSeed.value = ( this.uSeed.value + 1 ) % 65535;

		// Wrapped well short of the float precision that would make the twinkle
		// stutter after a few minutes, and on a multiple of 2π so nothing jumps
		// phase when it does.
		this.uClock.value = ( this.uClock.value + dt ) % ( Math.PI * 2 * 1024 );

		this.uPrevEmitter.value.copy( this.previous );
		this.previous.copy( this.uEmitter.value );

		this.renderer.compute( this.updateKernel );

		// Links are rebuilt from where the particles ended up, so they follow the
		// update rather than racing it.
		this.links?.step();

	}

	/**
	 * Eases the ramp towards another one. The colours are uniforms rather than
	 * baked constants so a field whose meaning changes — ink motes that should
	 * answer to whichever spell the page is reading — can follow without being
	 * rebuilt, and eases rather than cuts for the same reason the page's own glow
	 * does: changing your mind mid-sigil should not strobe.
	 */
	recolour( palette: [ number, number, number ], rate = 1 ): void {

		for ( let i = 0; i < 3; i ++ ) {

			this.ramp[ i ].value.lerp( SCRATCH_COLOR.setHex( palette[ i ] ), Math.min( 1, rate ) );

		}

	}

	/** Stops spawning; particles already in flight still burn out. */
	extinguish(): void {

		this.uSpawnRate.value = 0;

	}

	private buildMaterial(): SpriteNodeMaterial {

		const material = new SpriteNodeMaterial();

		const life = this.lives.toAttribute();
		const ratio = clamp( life.x.div( max( life.y, float( 0.0001 ) ) ), 0, 1 );
		const alive = step( life.x, life.y );

		// Deterministic per-particle variation, stable across respawns.
		const grain = hash( instanceIndex.mul( uint( 7919 ) ) );

		// Which population this particle belongs to — its own hash, so dust-ness is
		// uncorrelated with the size spread above. Stable across respawns, and the
		// kernel computes the identical value, so a particle cannot be an ember in
		// the simulation and dust in the shading.
		const dust = step( hash( instanceIndex.mul( uint( 3571 ) ) ), this.uDust );

		const heat = pow( ratio.oneMinus(), 1.7 );

		const [ cold, warm, hot ] = this.ramp;

		const ember = mix( cold, warm, smoothstep( 0.0, 0.35, heat ) );
		const flame = mix( ember, hot, smoothstep( 0.3, 0.72, heat ) );
		const tint = mix( flame, vec3( 1, 0.94, 0.86 ), smoothstep( 0.88, 1.0, heat ).mul( this.uWhiteHot ) );

		// Everything off the particle is discarded rather than left at zero alpha.
		// The scene pass is an MRT and SSGI reads what it writes: an invisible
		// fragment still writes `diffuseColor`, so every sprite quad was bouncing a
		// grey square of its own footprint onto whatever lay behind it. With a few
		// thousand of them alive at once the floor filled with soft dark rectangles
		// that read as shadows around the particles.
		//
		// It is invisible under `G` -> `plain` and obvious in `combined`, which makes
		// it look like a GI fault rather than a sprite — the same trap the flames set,
		// and the reason this is the shared material rather than one effect's.
		material.positionNode = this.positions.toAttribute();

		// Born small, swell, fade — the classic puff. `uGrowth` dials the swelling
		// out: at 1 this is the original curve, which quadruples a particle over its
		// life and is right for smoke and for a charge gathering. An ember is the
		// other thing entirely — it is brightest and biggest the instant it is
		// thrown and only cools from there — and at 0 it simply holds its size.
		const swell = mix( float( 1 ), ratio.mul( 1.9 ).add( 0.55 ), this.uGrowth );

		// `fadeSize`: the size holds while the particle is hot and then goes to
		// nothing, so the dying is a spark burning out rather than a light dimming.
		// It holds past the middle of the life on purpose — that is where the heat
		// ramp has cooled the colour from yellow to orange, and shrinking earlier
		// took the orange and red phases down to a pixel before they could be seen.
		// The alpha side of the same switch is `fade`, below.
		const shrink = mix( float( 1 ), smoothstep( 1.0, 0.55, ratio ), this.uFadeSize );

		const base = alive
			.mul( grain.mul( this.uSpread ).add( float( 1 ).sub( this.uSpread ) ) )
			.mul( this.uSize )
			.mul( mix( float( 1 ), this.uDustSize, dust ) )
			.mul( mix( smoothstep( 0.0, 0.08, ratio ), smoothstep( 0.0, SNAP_SECONDS, life.x ), this.uSnap ).mul( swell ) )
			.mul( shrink );

		// The streak. The velocity is taken into view space — the mesh sits at the
		// origin, so this is the camera's rotation and nothing else — and only its
		// screen-plane part is kept: a spark flying at the camera has nothing to
		// smear. Length is speed times `stretch`, per particle, capped so the fastest
		// leader is still a mark rather than a line across the room.
		const velocity = this.velocities.toAttribute();
		const planar = modelViewMatrix.mul( vec4( velocity, 0 ) ).xy;
		const streakVar = hash( instanceIndex.mul( uint( 2879 ) ) ).mul( 1.1 ).add( 0.45 );
		const reach = planar.length().mul( this.uStretch ).mul( streakVar )
			.min( base.mul( this.uStreakMax.sub( 1 ) ) );

		// The halo's room: the quad is padded by the same amount on every side, so a
		// streak's glow is a capsule around it rather than a longer streak. Exactly 1
		// when there is no halo, which leaves every effect that never asked for one
		// on the quad it was tuned against.
		const pad = mix( float( 1 ), this.uHaloSize, step( 0.0001, this.uHalo ) );

		material.scaleNode = vec2( base.add( reach ).add( base.mul( pad.sub( 1 ) ) ), base.mul( pad ) );

		// Turned to face the way it is going. Zeroed when nothing is stretched so
		// the effects that never asked for this stay exactly as they were tuned —
		// the glint carries its own random angle and does not want a second one.
		material.rotationNode = atan( planar.y, planar.x ).mul( step( 0.0001, this.uStretch ) );

		// Handed across to the fragment stage once per vertex: the mask has to know
		// how much longer than wide the quad it is painting has become.
		const aspect = base.add( reach ).div( max( base, float( 1e-6 ) ) ).toVarying();

		// The mask, in width units: y runs ±0.5 and x runs ±aspect/2, so the shapes
		// below are all drawn around a segment `half` long and the round ends of a
		// capsule fall out of the same distance the unstretched disc uses. At
		// aspect 1 every one of these is exactly the sprite it was before. The halo's
		// padding is added in the same units, so the core is drawn the same size
		// whatever the halo around it.
		const p = uv().sub( 0.5 );
		const q = vec2( p.x.mul( aspect.add( pad ).sub( 1 ) ), p.y.mul( pad ) );
		const half = aspect.sub( 1 ).mul( 0.5 );
		const dx = abs( q.x ).sub( half ).max( 0 );

		const disc = smoothstep( 0.5, 0.08, vec2( dx, q.y ).length() );

		// Hard-edged: the Chebyshev distance is a box, and the narrow step is the
		// pixel of anti-aliasing that keeps it from shimmering.
		const box = smoothstep( 0.5, 0.4, max( dx, abs( q.y ) ) );

		// A four-pointed glint: a hard core with two crossed spikes, each rotated by
		// the particle's own angle so the pool is not a field of plus signs. Built
		// from the same quad — no extra geometry, no extra draw.
		const angle = hash( instanceIndex.mul( uint( 5381 ) ) ).mul( Math.PI * 2 );
		const ca = cos( angle );
		const sa = sin( angle );
		const turned = vec2(
			q.x.mul( ca ).sub( q.y.mul( sa ) ),
			q.x.mul( sa ).add( q.y.mul( ca ) ),
		);

		const glintReach = smoothstep( 0.5, 0.0, turned.length() );
		const spikes = max(
			smoothstep( SPIKE_WIDTH, 0.0, abs( turned.y ) ),
			smoothstep( SPIKE_WIDTH, 0.0, abs( turned.x ) ),
		).mul( glintReach );
		const star = max( smoothstep( 0.17, 0.0, turned.length() ), spikes.mul( 0.8 ) );

		const sprite = mix( mix( disc, box, this.uSquare ), star, this.uSparkle );

		// The halo: distance from the core's own segment, out to the edge of the
		// padding, on a cubic so it is a glow with a bright middle rather than a
		// flat disc. Peaks at `halo` under the core and is zero at the quad's edge.
		const glowReach = clamp( vec2( dx, q.y ).length().div( pad.mul( 0.5 ) ).oneMinus(), 0, 1 );
		const haze = pow( glowReach, 3 ).mul( this.uHalo );

		// Along a streak the head is where the particle is and the tail is where
		// it was, so the brightness runs off towards the back. Only once there is
		// a streak to run along — an unstretched sprite is left flat.
		const along = q.x.div( max( aspect, float( 1 ) ) ).add( 0.5 );
		const trail = mix( float( 1 ), smoothstep( 0.0, 1.0, along ).mul( 0.7 ).add( 0.3 ), clamp( aspect.sub( 1 ), 0, 1 ) );

		// The alpha over a life: the old puff curve, or — under `fadeSize` — solid
		// from a few frames in until the shrink above has taken the size away.
		const born = smoothstep( 0.0, 0.12, ratio );
		const puff = born.mul( pow( ratio.oneMinus(), 1.25 ) );
		const held = mix( smoothstep( 0.0, 0.05, ratio ), smoothstep( 0.0, SNAP_SECONDS, life.x ), this.uSnap );
		const fade = mix( puff, held, this.uFadeSize );

		// Dust is not a dim ember; it is a different material. Pulled towards a flat
		// paper grey so it reads as something the page shed rather than something
		// that is still burning, and lit by its own emission so it can sit under the
		// bloom while the embers sit over it.
		const ash = mix( tint, vec3( 0.42, 0.38, 0.34 ), float( 0.72 ) );
		const body = mix( tint, ash, dust );

		// `glowFocus` folds the emission into the heat ramp instead of applying it
		// flat, so the bloom-crossing part of a particle's life is only its young
		// half. Zero for every spell, which leaves their curve exactly as it was.
		const focus = mix( float( 1 ), smoothstep( 0.0, 0.55, heat ), this.uGlowFocus );

		// Each particle on its own phase and its own rate, so the pool never blinks
		// together. `oneMinus` on the beat means the pulse dips from full brightness
		// rather than overshooting it — a firefly goes out and comes back, it does
		// not flare above its own steady state.
		const phase = hash( instanceIndex.mul( uint( 9173 ) ) ).mul( Math.PI * 2 );
		const rate = hash( instanceIndex.mul( uint( 4409 ) ) ).mul( 0.9 ).add( 0.55 );
		const beat = sin( this.uClock.mul( this.uTwinkleRate ).mul( rate ).add( phase ) ).mul( 0.5 ).add( 0.5 );
		const lamp = float( 1 ).sub( this.uTwinkle.mul( beat.oneMinus() ) );

		material.colorNode = body
			.mul( heat.mul( 1.15 ).add( 0.2 ) )
			.mul( lamp )
			.mul( mix( this.uEmission.mul( focus ), this.uDustGlow, dust ) );

		// The discard has to live *inside* an `Fn`. `.discard()` appends to the shader
		// stack being built, and node graphs assembled out here — the ordinary way to
		// write a material — have no stack to append to, so the call compiles away to
		// nothing and the quads keep writing. The flames got this right only because
		// their whole colour was already wrapped in one.
		material.opacityNode = Fn( () => {

			const life = fade.mul( alive );
			const mask = sprite.mul( trail ).mul( this.uOpacity ).add( haze ).mul( life ).toVar();

			// Lower than the old 0.02 because the halo's tail is meant to be faint;
			// the corners of the padded quad are still exactly zero and still go.
			mask.lessThan( 0.003 ).discard();

			return mask;

		} )();

		material.transparent = true;
		material.depthWrite = false;
		material.blending = AdditiveBlending;

		// Keep the pool out of the scene pass's auxiliary buffers entirely.
		//
		// Discarding the empty corners of the quad was not enough, and the way it
		// failed is instructive: it turned the grey squares into grey *discs*, because
		// the part of the sprite that survives still overwrote `diffuseColor`. The
		// composite is `colour x AO + albedo x GI`, so replacing the floor's albedo
		// with a near-black particle albedo deletes the floor's bounce underneath
		// every particle — which is why they read as shadows rather than as glows.
		//
		// A material's `mrtNode` is *merged* with the pass's, so this overrides those
		// two targets and leaves `output` and `velocity` alone. Zero with zero alpha
		// is inert under either blend the target might carry: additive adds nothing,
		// and source-alpha keeps the destination. The particle's light still reaches
		// the image through `output`, which is where it belonged all along.
		material.mrtNode = transparentMRT();

		return material;

	}

	private buildUpdateKernel() {

		/** Cheap, decorrelated per-particle noise for this frame. */
		const rand = ( slot: number ) => hash( instanceIndex.mul( uint( 6151 ) ).add( uint( slot * 2749 ) ).add( this.uSeed ) );

		return Fn( () => {

			const position = this.positions.element( instanceIndex );
			const velocity = this.velocities.element( instanceIndex );
			const life = this.lives.element( instanceIndex );

			const age = life.x.add( this.uDelta );

			If( age.greaterThanEqual( life.y ), () => {

				// Dead. Respawning is rationed so one emitter can be dialled from a
				// slow charge-up to a full detonation without changing kernels.
				If( rand( 0 ).lessThan( this.uSpawnRate ), () => {

					const azimuth = rand( 1 ).mul( Math.PI * 2 );
					const z = rand( 2 ).mul( 2 ).sub( 1 );
					const ring = sqrt( max( float( 0 ), z.mul( z ).oneMinus() ) );
					const sphere = vec3( cos( azimuth ).mul( ring ), z, sin( azimuth ).mul( ring ) );

					// sqrt() keeps a disc spawn area-uniform instead of centre-heavy.
					const disc = vec3( cos( azimuth ), 0, sin( azimuth ) ).mul( sqrt( rand( 7 ) ) );

					// Smeared along the distance the emitter covered this frame, so a
					// fast-moving source leaves a rope instead of a bead chain.
					const along = this.uPrevEmitter.add( this.uEmitter.sub( this.uPrevEmitter ).mul( rand( 3 ) ) );
					const jitter = rand( 4 ).mul( 0.55 ).add( 0.45 );

					const offset = mix( sphere.mul( jitter ), disc, this.uShape ).mul( this.uRadius );

					// The speed spread. At `spray` 0 this is the old ±30%; wound up, the
					// cube is what does the work — it leaves most of the pool slow and
					// throws a thin tail of leaders far out in front, which is the shape
					// of a real blast's velocity distribution rather than a shell's.
					const roll = rand( 5 );
					const even = roll.mul( 0.6 ).add( 0.7 );
					const uneven = pow( roll, 3 ).mul( 2.6 ).add( 0.22 );
					const thrown = this.uSpeed.mul( mix( even, uneven, this.uSpray ) );

					// …and the vertical kick, two-sided about a point a little below
					// centre, so rather more of the pool is driven down than up. The
					// plume is the minority; the hammer is the rest.
					const kick = rand( 8 ).sub( 0.42 ).mul( this.uUpdraft );

					const launch = mix( sphere, vec3( 0, 1, 0 ), this.uShape ).mul( thrown )
						.add( vec3( 0, kick, 0 ) );

					// cross() conveniently vanishes at the poles instead of exploding
					// like a normalize() would.
					const swirl = cross( sphere, vec3( 0, 1, 0 ) ).mul( this.uSwirl );

					// The drift is the embers' rise; handing it to the dust as well would
					// launch it upwards and only then let gravity argue with it, which
					// reads as a hesitation rather than as weight.
					const born = step( hash( instanceIndex.mul( uint( 3571 ) ) ), this.uDust );

					// The emitter's own motion this frame, as a velocity — see `inherit`.
					// Guarded against a zero-length frame, which would otherwise hand
					// every newborn an infinite speed.
					const carried = this.uEmitter.sub( this.uPrevEmitter )
						.div( max( this.uDelta, float( 1e-4 ) ) )
						.mul( this.uInherit );

					position.assign( along.add( offset ) );
					velocity.assign( launch.mul( mix( float( 1 ), float( 0.45 ), born ) )
						.add( swirl )
						.add( carried )
						.add( this.uDrift.mul( born.oneMinus() ) ) );
					life.assign( vec2( 0, this.uLifeSpan.mul( rand( 6 ).mul( 0.5 ).add( 0.75 ) ) ) );

				} ).Else( () => {

					life.assign( vec2( life.y.add( 1 ), life.y ) );

				} );

			} ).Else( () => {

				const drag = float( 1 ).sub( this.uDelta.mul( this.uDamping ) ).max( 0 );
				const pull = this.uEmitter.sub( position ).mul( this.uAttract.mul( this.uDelta ) );

				// Same hash as the material's, so the two agree on which particles fall.
				const dust = step( hash( instanceIndex.mul( uint( 3571 ) ) ), this.uDust );
				const lift = mix( this.uBuoyancy, this.uDustBuoyancy, dust );

				velocity.assign( velocity.mul( drag ).add( pull ).add( vec3( 0, this.uDelta.mul( lift ), 0 ) ) );

				if ( this.turbulent ) {

					// The turbulence field, after the linked-particles example: a few
					// octaves of fractal noise read at the particle's own position, so
					// neighbours are pushed the same way and the pool moves in sheets
					// rather than as a thousand independent specks.
					//
					// Scaled by the life left, which is what makes a particle wander
					// hardest when it is young and settle as it burns out. The example
					// adds this per frame; here it is per second, so the drift does not
					// change when the frame rate does.
					const left = life.y.sub( age ).div( max( life.y, float( 0.0001 ) ) ).clamp( 0, 1 );
					const curl = mx_fractal_noise_vec3( position.mul( this.uTurbScale ), 2, 2, 0.5, this.uTurbulence );

					velocity.addAssign( curl.mul( left.add( 0.01 ) ).mul( this.uDelta ) );
					velocity.mulAssign( float( 1 ).sub( this.uTurbFriction.mul( this.uDelta ) ).max( 0 ) );

				}

				position.assign( position.add( velocity.mul( this.uDelta ) ) );

				// …and the ground, for the pools that were given weight. An ember that
				// lands keeps whatever it had sideways and loses most of it to the
				// stone, so the shower spreads out along the floor instead of stopping
				// dead in a line — and the small bounce is what stops the last frame of
				// a fall reading as a particle being switched off at floor level.
				If( position.y.lessThan( this.uFloor ), () => {

					const skid = float( 1 ).sub( this.uDelta.mul( GROUND_DRAG ) ).max( 0 );

					position.assign( vec3( position.x, this.uFloor, position.z ) );
					velocity.assign( vec3(
						velocity.x.mul( skid ),
						velocity.y.abs().mul( GROUND_BOUNCE ),
						velocity.z.mul( skid ),
					) );

				} );

				life.assign( vec2( age, life.y ) );

			} );

		} )().compute( this.count );

	}

}
