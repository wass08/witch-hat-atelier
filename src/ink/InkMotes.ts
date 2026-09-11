import { Color, Scene, Vector2, Vector3, type WebGPURenderer } from 'three/webgpu';
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
 * The hot end is warm now rather than pale lilac: these are embers off burning
 * paper, and the violet stays in the middle where it reads as the ink's own
 * colour rather than as the temperature of the thing that is burning.
 */
const IDLE_PALETTE: [ number, number, number ] = [ 0x1a1026, 0x8a5ad0, 0xffd2a0 ];

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
 */
const SPAWN_PER_SPAN = 3.4;
const SPAWN_MAX = 0.55;

/**
 * Emission at the head of a sweep, and once the stroke behind it has aged.
 *
 * Both raised, and the floor raised much harder — 1.4 is under the 1.15 the bloom
 * opens at, so the tail of every trail was a dim smear that lit nothing. Ink
 * leaving a page is not smoke coming off it: the whole trail should be over the
 * threshold and blooming, with the head simply hotter than the tail.
 */
const GLOW_HOT = 8.5;
const GLOW_COOL = 4.0;

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
	// 51 frames, so the share of a 700-strong pool that wakes is
	// `1 - (1 - rate)^51`. At the flare's old 0.32 that is essentially all of it:
	// 700 lights, which is a wall. At 0.01 it is about a third, and a pentagram
	// comes apart into points you can follow one at a time.
	spawnRate: 0.01,

	// Fewer, so each one can afford to be brighter and bigger.
	glow: 12,
	size: 0.012,

	// Nearly flat, where the resting trail is fully focused. A firefly is not an
	// ember: it does not cool as it ages, it holds its light and then goes out.
	// The fade at the end is the sprite's own, not a temperature.
	glowFocus: 0.12,

	// Each on its own phase and rate — this is the thing that makes them read as
	// alive rather than as slow sparks.
	twinkle: 0.55,
	twinkleRate: 2.4,

	// Mostly back to round. A firefly is a soft light; the glint that stops the
	// drawing trail reading as smoke would make the flare read as tinsel.
	sparkle: 0.3,

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
	size: 0.0055,
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

	// A glint, not a blob. The round sprite was the single biggest reason the trail
	// read as smoke: no amount of tuning the motion escapes a silhouette that is a
	// soft circle.
	sparkle: 1,

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
	private readonly page = new Vector2();
	private readonly at = new Vector3();
	private readonly previous = new Vector3();
	private readonly palette: [ number, number, number ] = [ ...IDLE_PALETTE ];
	private readonly scratch = new Color();
	private readonly violet = new Color( IDLE_PALETTE[ 1 ] );
	private readonly white = new Color( 0xffffff );
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

	constructor( renderer: WebGPURenderer, scene: Scene, private readonly ink: InkSurface ) {

		this.field = new ParticleField( renderer, scene, {
			count: 700,
			palette: IDLE_PALETTE,
			// Compiled in for this field only. It is a few octaves of noise per
			// particle per frame, and it is what makes an ember wander rather than
			// rise on a rail.
			turbulent: true,
		} );
		this.field.configure( EMITTER );

	}

	/** True while there is anything left to step. */
	get active(): boolean {

		return this.alive > 0;

	}

	/**
	 * Tints the motes towards the colour the page is glowing, so a sigil the
	 * parchment has already recognised sheds that spell's light as it goes.
	 */
	setColor( hex: number ): void {

		if ( hex === this.colored ) return;

		this.colored = hex;

		// The ramp stays a ramp whatever it is handed: the middle keeps some of the
		// ink's own violet and the top is pushed towards white, so the motes still
		// cool from bright to dark over their life. Flattening all three to the
		// spell's colour reads as a decal rather than as embers.
		this.palette[ 1 ] = this.scratch.setHex( hex ).lerp( this.violet, 0.45 ).getHex();
		this.palette[ 2 ] = this.scratch.setHex( hex ).lerp( this.white, 0.55 ).getHex();

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

				this.field.teleport( this.at );

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

		if ( this.alive <= 0 ) return;

		this.field.recolour( this.palette, dt * 7 );
		this.field.configure( EMITTER );
		this.field.step( dt );

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
		if ( this.spawning > 0 ) {

			EMITTER.spawnRate = Math.max(
				EMITTER.spawnRate,
				Math.min( SPAWN_MAX, ( FLARE.spawnRate ?? 0 ) + this.span * SPAWN_PER_SPAN * 0.35 ),
			);

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
		EMITTER.drift.y = blend( REST.drift.y, FLARE.drift?.y ?? REST.drift.y );

		this.alive = Math.max( this.alive, EMITTER.lifeSpan );

	}

}
