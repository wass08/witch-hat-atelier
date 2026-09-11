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
	clamp,
	cos,
	cross,
	float,
	hash,
	instanceIndex,
	instancedArray,
	max,
	mix,
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
};

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
		const tint = mix( flame, vec3( 1, 0.94, 0.86 ), smoothstep( 0.88, 1.0, heat ) );

		const offset = uv().sub( 0.5 );
		const disc = smoothstep( 0.5, 0.08, offset.length() );

		// A four-pointed glint: a hard core with two crossed spikes, each rotated by
		// the particle's own angle so the pool is not a field of plus signs. Built
		// from the same quad — no extra geometry, no extra draw.
		const angle = hash( instanceIndex.mul( uint( 5381 ) ) ).mul( Math.PI * 2 );
		const ca = cos( angle );
		const sa = sin( angle );
		const turned = vec2(
			offset.x.mul( ca ).sub( offset.y.mul( sa ) ),
			offset.x.mul( sa ).add( offset.y.mul( ca ) ),
		);

		const reach = smoothstep( 0.5, 0.0, turned.length() );
		const spikes = max(
			smoothstep( SPIKE_WIDTH, 0.0, abs( turned.y ) ),
			smoothstep( SPIKE_WIDTH, 0.0, abs( turned.x ) ),
		).mul( reach );
		const star = max( smoothstep( 0.17, 0.0, turned.length() ), spikes.mul( 0.8 ) );

		const sprite = mix( disc, star, this.uSparkle );
		const puff = smoothstep( 0.0, 0.12, ratio ).mul( pow( ratio.oneMinus(), 1.25 ) );

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

		material.scaleNode = alive
			.mul( grain.mul( this.uSpread ).add( float( 1 ).sub( this.uSpread ) ) )
			.mul( this.uSize )
			.mul( mix( float( 1 ), this.uDustSize, dust ) )
			.mul( smoothstep( 0.0, 0.08, ratio ).mul( swell ) );

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

			const mask = sprite.mul( puff ).mul( alive ).toVar();

			mask.lessThan( 0.02 ).discard();

			return mask.mul( 0.22 );

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

					position.assign( along.add( offset ) );
					velocity.assign( launch.mul( mix( float( 1 ), float( 0.45 ), born ) )
						.add( swirl )
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
