import {
	Color,
	Mesh,
	MeshPhysicalNodeMaterial,
	NoColorSpace,
	HalfFloatType,
	LinearFilter,
	Plane,
	StorageTexture,
	Vector2,
	Vector3,
	Vector4,
	type WebGPURenderer,
} from 'three/webgpu';
import {
	Fn,
	If,
	clamp,
	color,
	float,
	instanceIndex,
	max,
	min,
	mix,
	mx_fractal_noise_float,
	mx_noise_float,
	positionLocal,
	pow,
	smoothstep,
	texture,
	textureLoad,
	textureStore,
	uint,
	uniform,
	uv,
	uvec2,
	vec2,
	vec3,
	vec4,
} from 'three/tsl';
import { IDLE_GLOW, INK_BURN_RATE, INK_LIFETIME, INK_SIZE, INK_SOLID, INK_VISIBLE } from '../config';
import type { FloatUniform, Vec2Node, Vec4Uniform } from '../tsl-types';

/**
 * Segment slots consumed by a single paint dispatch. One dispatch per frame is
 * a hard requirement — every slot lives in the same uniform buffer, so a second
 * dispatch in the same frame would simply re-read whatever was written last.
 * Anything beyond this many segments in one frame is decimated instead.
 */
const SLOTS = 24;

/** Frames of decay to keep dispatching after the last change to the page. */
const SETTLE_FRAMES = 70;

/**
 * Fade time constant, in seconds, derived rather than tuned: ink written at full
 * strength lands exactly on `INK_VISIBLE` after `INK_LIFETIME`. That is what lets
 * the CPU know where the ink has gone without reading the texture back. The
 * shader stops drawing a texel and `takeVanished` hands its position to the
 * motes on the same frame, because both are solving the same equation.
 */
const INK_TAU = INK_LIFETIME / Math.log( 1 / INK_VISIBLE );

/**
 * Drawn darkness at which a stroke counts as gone, and the ink level that
 * produces it.
 *
 * Stated as darkness rather than as a raw ink level on purpose, because darkness
 * is the thing anyone can see and the mapping between the two moves. The old
 * figure was the raw level — 8.5% of the way from `INK_VISIBLE` to `INK_SOLID`,
 * which happens to be **2%** darkness — and 2% was right when the visible curve
 * fell off a cliff at the end. It no longer does. With the plateau restored, the
 * fade ends in a long faint tail: 27% at 5 s, 9% at 6 s, 2% at 7 s. Firing at 2%
 * put the motes 2.1 s behind the moment the line was seen to go, which reads as
 * the sparks arriving late for something that already happened.
 *
 * At 30% the line is unmistakably dissolving but still there, so the motes come
 * off it rather than off blank parchment.
 *
 * The constant below is the exact inverse of the material's `smoothstep`
 * (`y = x²(3 - 2x)`), so the two cannot drift: change the darkness and the ink
 * level follows.
 */
const VANISH_AT = 0.3;
const VANISH_X = 0.5 - Math.sin( Math.asin( 1 - 2 * VANISH_AT ) / 3 );

const INK_FAINT = INK_VISIBLE + VANISH_X * ( INK_SOLID - INK_VISIBLE );

/**
 * Seconds after the nib passes at which a mark counts as vanished and throws its
 * mote. Not `INK_LIFETIME`, which is when the ink reaches *mathematically* zero.
 *
 * The two used to be the same thing, because the old plateau made the visible
 * curve fall off a cliff right at the end. With the plateau gone the fall is
 * spread across the whole life instead, and it ends in a long tail so faint that
 * the last fifth of it is invisible — so firing at `INK_LIFETIME` would have
 * dropped sparks onto what already looked like blank parchment. The motes go
 * where the line is *seen* to disappear.
 */
const VANISH_AFTER = INK_TAU * Math.log( 1 / INK_FAINT );

/**
 * How wet the fibres get beside a stroke, and how dark that reads.
 *
 * The page reacts to ink that is *on* it and to nothing else. There is no record
 * kept: this rides `inkFade`, so the halo is gone at the same moment the stroke
 * is, and a burn takes it with the ink rather than leaving a mark behind.
 *
 * `DEPTH` is well under what a scorch would be, because this is damp paper
 * rather than singed paper — enough that a stroke sits in the sheet instead of
 * on it, not enough to read as a second, softer stroke.
 */
const SOAK_STRENGTH = 0.5;
const SOAK_DEPTH = 0.2;

/** What it goes towards: the warm brown of ink in wet fibres. */
const SOAK_TINT = vec3( 0.45, 0.31, 0.2 );

/**
 * How the ink soaks sideways into the fibres.
 *
 * `RAGGED` jitters the solid knee along the paper grain, so the stroke's border
 * wanders instead of being the nib's own clean falloff. `SPREAD` is how much
 * wider than the nib the stain reaches, as a multiple of the nib radius — this is
 * the sideways soak, and it is written into its own channel at nib time rather
 * than derived from the ink's value, so it cannot smear as the ink fades.
 */
const BLEED_RAGGED = 0.055;
const BLEED_SPREAD = 2.4;

/**
 * Ink-age of stillness before the fade starts hurrying, and how much faster.
 *
 * `HASTE_AFTER` has to clear the pause between two strokes of one sigil, or
 * lining up the next stroke would eat the last one — that is the whole reason the
 * plateau is long. Comfortably under a second covers repositioning; past that you
 * have stopped, not paused, and `CAST_DELAY` is about to agree with that anyway.
 *
 * `HASTE` is held down to keep the dissolve watchable. It divides the *wipe* as
 * well as the plateau, and the wipe is the part that looks good: at 2.2 it runs
 * in 0.36 s, quick but still legible as a sweep travelling the line. At 4 it is a
 * flash and the effect is gone.
 *
 * Measured against a held line: stopping used to mean 4.8 s before the page was
 * clear. It is now 0.9 s of grace, 1.4 s of hurried plateau and a 0.36 s wipe —
 * about 2.7 s, with the visible part unchanged in character.
 */
const HASTE_AFTER = 0.9;
const HASTE = 2.2;

/** One sample of the line the nib drew, kept so the fade can be followed. */
interface Mark {
	x: number;
	y: number;
	/** Ink-age at which it was laid; it vanishes at `at + VANISH_AFTER`. */
	at: number;
	/** First sample of a stroke — the quill was put down here, not dragged. */
	first: boolean;
}

/** Where the fade is eating the line this frame. */
export interface VanishPoint {
	/**
	 * The front arrived here by lifting rather than by sweeping — a new stroke,
	 * or the first crossing after a pause. Anything trailing it should jump too.
	 */
	jumped: boolean;
	/**
	 * How much line the front ate this frame, in page widths.
	 *
	 * The emitter can only be in one place per frame, and a frame can easily
	 * consume dozens of marks — a burn runs the fade at `INK_BURN_RATE`, so a
	 * stroke drawn over 0.6 s is eaten in 0.05 s, five frames. Reporting only
	 * *where* the front ended up therefore loses the length entirely: measured, a
	 * 112-mark line produced five emitter positions, and the trail came out as a
	 * couple of bursts at the ends instead of a ribbon.
	 *
	 * The kernel already smears each frame's spawns along the ground the emitter
	 * covered, so the geometry is handled. What was missing is the *rate*: with
	 * this, `InkMotes` can spawn per unit of line rather than per frame, and the
	 * ribbon comes out at the same density however fast the front is moving.
	 */
	span: number;
}

/** Marks consumed before the list is compacted. */
const COMPACT_AFTER = 256;

/** A segment parked far outside the sheet contributes nothing. */
const IDLE_SEGMENT = new Vector4( - 9, - 9, - 9, - 9 );

/**
 * The parchment's ink is a GPU-resident quantity: a ping-ponged pair of storage
 * textures written by a TSL compute kernel and sampled by the page's material.
 *
 * Channel layout
 *   .x  ink    — how much iron-gall ink has soaked into the fibres
 *   .y  heat   — how charged that ink is; drives the emissive glow and burn-off
 *   .z  soak   — the wider, softer footprint that wets the fibres beside a
 *                stroke. Fades on the ink's own curve, so the page keeps no
 *                record of anything once the writing has gone.
 *
 * Nothing about the stroke lives on the CPU except the handful of segments
 * queued for the next dispatch, so drawing stays cheap no matter how long the
 * sigil gets.
 */
export class InkSurface {

	readonly mesh: Mesh;

	/** Paper-local bounds used to convert a raycast hit into ink UV. */
	private readonly localMin = new Vector2();
	private readonly localSize = new Vector2();

	private readonly targets: [ StorageTexture, StorageTexture ];
	private readonly kernels: [ ReturnType<typeof buildKernel>, ReturnType<typeof buildKernel> ];
	private front = 0;

	private readonly segments = Array.from( { length: SLOTS }, () => uniform( IDLE_SEGMENT.clone() ) );
	// Back down now the nib is sharp: a narrow falloff band puts three quarters of
	// the stroke at full ink, which reads bolder at 0.011 than the soft nib did at
	// 0.013.
	private readonly uRadius = uniform( 0.011 );
	private readonly uInkFade = uniform( 1 );
	private readonly uHeatDecay = uniform( 0.90 );
	private readonly uSoakStrength = uniform( SOAK_STRENGTH );
	private readonly uGlow = uniform( 0 );
	private readonly uGlowColor = uniform( new Color( IDLE_GLOW ) );
	private readonly glowTarget = new Color( IDLE_GLOW );
	private readonly uAspect = uniform( 1 );
	private readonly uBox = uniform( new Vector4( 2, 2, - 2, - 2 ) );
	private readonly inkSampler: ReturnType<typeof texture>;

	/** Segments waiting for a dispatch, oldest first. */
	private queue: Vector4[] = [];
	private lastPoint: Vector2 | null = null;

	private burn = 0;
	private wipeRequested = false;

	/**
	 * The line the nib drew, oldest first, and how far along it the fade has got.
	 * Nothing is read back off the GPU — the ink decays on a curve the CPU can
	 * solve, so following it is a matter of walking this list against the clock.
	 */
	private readonly history: Mark[] = [];
	private head = 0;
	/** Seconds of fade elapsed. Runs fast while a sigil burns off. */
	private age = 0;
	private continuing = false;
	/** Ink-age of the most recent mark, so the fade can be run to its true end. */
	private lastMark = - INK_LIFETIME;
	private readonly vanished: VanishPoint = { jumped: false, span: 0 };

	/** Frames since anything on the page last changed. */
	private settled = Number.MAX_SAFE_INTEGER;

	constructor( private readonly renderer: WebGPURenderer, mesh: Mesh ) {

		this.mesh = mesh;

		mesh.geometry.computeBoundingBox();
		const bounds = mesh.geometry.boundingBox!;
		this.localMin.set( bounds.min.x, bounds.min.z );
		this.localSize.set( bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z );
		this.uAspect.value = this.localSize.x / this.localSize.y;

		const a = new StorageTexture( INK_SIZE, INK_SIZE );
		const b = new StorageTexture( INK_SIZE, INK_SIZE );

		for ( const t of [ a, b ] ) {

			// Half float, not the default `rgba8unorm`, and this is load-bearing.
			//
			// The fade is a multiply the buffer applies to itself every frame, and at
			// eight bits a gentle one is a no-op: a five-second fade is about 0.996
			// per frame, so any texel below ~135/255 loses less than half a quantum
			// and rounds straight back to where it started. The ink stalled at roughly
			// half strength and sat there — visibly, since the page only stops drawing
			// ink below 0.08. The old burn-off got away with 0.955 per frame, which
			// clears a quantum until it stalls at ~0.05, under the threshold and so
			// invisible; nothing about it survives being slowed down.
			t.type = HalfFloatType;
			t.minFilter = LinearFilter;
			t.magFilter = LinearFilter;
			t.generateMipmaps = false;
			t.colorSpace = NoColorSpace;

		}

		this.targets = [ a, b ];

		const params = {
			segments: this.segments,
			radius: this.uRadius,
			inkFade: this.uInkFade,
			heatDecay: this.uHeatDecay,
			soakStrength: this.uSoakStrength,
			aspect: this.uAspect,
			box: this.uBox,
		};

		// One kernel per ping-pong direction: a compute graph binds its textures
		// at build time, so the swap has to be baked into two graphs.
		this.kernels = [ buildKernel( a, b, params ), buildKernel( b, a, params ) ];

		this.inkSampler = texture( b );
		this.applyMaterial();

	}

	/**
	 * The plane the sheet lies in, extended infinitely. Used to keep following a
	 * stroke that has wandered off the parchment: the ink stops at the edge of the
	 * paper, but the shape the player is drawing stays whole.
	 */
	getPlane( out = new Plane() ): Plane {

		const bounds = this.mesh.geometry.boundingBox!;

		const normal = new Vector3( 0, 1, 0 ).transformDirection( this.mesh.matrixWorld ).normalize();
		const surface = this.mesh.localToWorld( new Vector3( 0, bounds.max.y, 0 ) );

		return out.setFromNormalAndCoplanarPoint( normal, surface );

	}

	/** Maps a world-space hit on the page into 0..1 ink space (v runs away from the viewer). */
	toInkUV( worldPoint: Vector3, out = new Vector2() ): Vector2 {

		const local = this.mesh.worldToLocal( worldPoint.clone() );

		return out.set(
			( local.x - this.localMin.x ) / this.localSize.x,
			( local.z - this.localMin.y ) / this.localSize.y,
		);

	}

	/** Inverse of {@link toInkUV}: 0..1 ink space back to a world point on the page. */
	fromInkUV( uvPoint: Vector2, out = new Vector3() ): Vector3 {

		const bounds = this.mesh.geometry.boundingBox!;

		out.set(
			this.localMin.x + uvPoint.x * this.localSize.x,
			bounds.max.y,
			this.localMin.y + uvPoint.y * this.localSize.y,
		);

		return this.mesh.localToWorld( out );

	}

	beginStroke( point: Vector2 ): void {

		this.lastPoint = point.clone();
		this.queueSegment( point, point );
		this.mark( point, true );

	}

	extendStroke( point: Vector2 ): void {

		if ( this.lastPoint === null ) return this.beginStroke( point );

		this.queueSegment( this.lastPoint, point );
		this.lastPoint.copy( point );
		this.mark( point, false );

	}

	/**
	 * Advances the fade front and reports where it got to, in 0..1 page space, or
	 * null if nothing finished fading this frame.
	 *
	 * The front walks the marks in the order the nib laid them, so it retraces the
	 * player's own line a lifetime behind the quill. That ordering is the whole
	 * trick: motes shed from a point moving along the stroke read as the writing
	 * being consumed, where motes scattered over the sigil's area would only read
	 * as sparkle laid on top of it.
	 */
	takeVanished( out: Vector2 ): VanishPoint | null {

		const horizon = this.age - VANISH_AFTER;
		let jumped = ! this.continuing;
		let found = false;
		let span = 0;
		let lastX = 0;
		let lastY = 0;

		while ( this.head < this.history.length && this.history[ this.head ].at <= horizon ) {

			const mark = this.history[ this.head ++ ];

			if ( mark.first ) jumped = true;

			// Samples past the edge of the sheet were recorded so the *shape* stayed
			// whole; no ink was ever laid there, so nothing vanishes there either.
			if ( mark.x < 0 || mark.x > 1 || mark.y < 0 || mark.y > 1 ) continue;

			// Length eaten, accumulated along the marks rather than measured end to
			// end: a frame that swallows a corner covers both of its sides, and the
			// straight line between the first and last mark would report the shortcut.
			// Pen-lifts are not ground covered, so a `first` mark starts a new run.
			if ( found && ! mark.first ) span += Math.hypot( mark.x - lastX, mark.y - lastY );

			lastX = mark.x;
			lastY = mark.y;

			out.set( mark.x, mark.y );
			found = true;

		}

		if ( this.head > COMPACT_AFTER ) {

			this.history.splice( 0, this.head );
			this.head = 0;

		}

		this.continuing = found;

		if ( ! found ) return null;

		this.vanished.jumped = jumped;
		this.vanished.span = span;

		return this.vanished;

	}

	endStroke(): void {

		this.lastPoint = null;

	}

	/** Charge level of the drawn sigil, 0..1 — pushed into the page's emissive. */
	setGlow( amount: number ): void {

		this.uGlow.value = amount;

	}

	/**
	 * Colour the ink glows with — the page shows which spell it is reading long
	 * before the sigil resolves. Cross-fades, so changing your mind mid-sigil does
	 * not strobe the parchment.
	 */
	setGlowColor( hex: number ): void {

		this.glowTarget.setHex( hex );

	}

	/** Burns the sigil off the page over `seconds`. */
	burnAway( seconds = 1.1 ): void {

		this.burn = seconds;

	}

	/** Wipes the page on the next dispatch. */
	clear(): void {

		this.wipeRequested = true;
		this.burn = 0;
		this.queue.length = 0;
		this.lastPoint = null;
		this.forget();

	}

	update( dt: number ): void {

		this.uGlowColor.value.lerp( this.glowTarget, Math.min( 1, dt * 7 ) );

		// Once the page has stopped changing there is nothing for a million
		// threads to do; the heat channel needs about a second to decay to black,
		// and after that the dispatch is pure waste.
		//
		// "Stopped changing" now means the sheet is empty, not that the quill is
		// still: ink written up to `INK_LIFETIME` ago is mid-fade and needs the
		// kernel to run for it to get anywhere. `history` holds exactly the marks
		// that have not vanished yet, so it is the liveness test as well as the
		// trail the motes follow.
		// `history` empties when the last mote has been thrown, which now happens
		// before the ink itself has finished decaying — so the kernel is kept
		// running for the remainder of a full lifetime past that.
		const fading = this.age - this.lastMark < INK_LIFETIME;
		const drawing = this.queue.length > 0 || this.head < this.history.length || fading;

		if ( drawing || this.burn > 0 || this.wipeRequested ) this.settled = 0;
		else if ( this.settled < SETTLE_FRAMES ) this.settled ++;
		else return;

		// Burning is the ordinary fade run fast, not a second fade with its own
		// constants. That matters because the CPU predicts where the ink has got to
		// rather than reading it back: one clock drives both, so a sigil going up in
		// smoke sheds its motes along the line instead of drifting out of step.
		const burning = this.burn > 0;

		// The plateau and the wipe answer two different situations, and one global
		// pace cannot serve both. While the nib is working, a long plateau is what
		// lets a five-stroke sigil still be whole when the last stroke lands. Once
		// the quill stops, that same plateau is dead time — you are watching a line
		// you have finished with, waiting for it to begin leaving.
		//
		// Scaling the whole curve down trades one for the other, and it was tried
		// twice: 8.0 s, then 6.2, then 4.8, and stopping still meant a four-second
		// wait before anything happened. So the fade hurries only once the nib has
		// been still, which is exactly the case being complained about and no other.
		//
		// The stillness is measured in the surface's own clock — `lastMark` is the
		// ink-age of the most recent mark — so nothing new has to be wired in from
		// the recorder, and the motes stay in step for free: they ride `age` too, so
		// a hurried fade sheds its trail just as fast.
		const still = this.age - this.lastMark;
		const hasty = ! burning && still > HASTE_AFTER;

		const rate = burning ? INK_BURN_RATE : ( hasty ? HASTE : 1 );

		if ( burning ) this.burn = Math.max( 0, this.burn - dt );

		this.age += dt * rate;

		if ( this.wipeRequested ) {

			// Zero fade for exactly one dispatch: the kernel multiplies the whole
			// buffer by zero and the page comes back blank.
			//
			// The trail is dropped by `clear` rather than here. A wipe is requested on
			// one frame and dispatched on the next, and the kernel writes this frame's
			// segments *after* the multiply — so a sigil stamped in between survives
			// the wipe on the page, and forgetting here would throw away the only
			// record of it while the ink itself stayed.
			this.wipeRequested = false;
			this.uInkFade.value = 0;
			this.uHeatDecay.value = 0;
		} else {

			this.uInkFade.value = Math.exp( - ( dt * rate ) / INK_TAU );

			// The stain outlives the ink, which is the whole point of it: the page is
			// meant to look like it was written on, not like a screen the writing was
			// projected onto. Four lifetimes, so a stroke is long gone before its mark
			// on the fibres is — and it does not ride `rate`, because burning the ink
			// off is exactly the moment the paper should be *more* marked, not less.

			// Heat lingers a little longer while a sigil burns, so the line is still
			// lit as it goes. Per second rather than per frame: the fade it rides on
			// is timed against the clock the motes read.
			this.uHeatDecay.value = Math.pow( burning ? 0.94 : 0.90, dt * 60 );

		}

		// Rebind rather than truncate: `decimate` hands back the queue itself when it
		// fits, and emptying it in place would blank the batch we are about to send.
		const batch = decimate( this.queue, SLOTS );
		this.queue = [];

		const box = this.uBox.value.set( 2, 2, - 2, - 2 );

		for ( let i = 0; i < SLOTS; i ++ ) {

			const segment = batch[ i ] ?? IDLE_SEGMENT;
			this.segments[ i ].value.copy( segment );

			if ( segment === IDLE_SEGMENT ) continue;

			// Bounding box of this frame's ink, so texels nowhere near the quill
			// can skip the brush evaluation entirely.
			box.x = Math.min( box.x, segment.x, segment.z );
			box.y = Math.min( box.y, segment.y, segment.w );
			box.z = Math.max( box.z, segment.x, segment.z );
			box.w = Math.max( box.w, segment.y, segment.w );

		}

		const pad = this.uRadius.value * 1.5;
		box.x -= pad;
		box.y -= pad;
		box.z += pad;
		box.w += pad;

		this.renderer.compute( this.kernels[ this.front ] );
		this.front = 1 - this.front;
		this.inkSampler.value = this.targets[ this.front ];

	}

	private queueSegment( a: Vector2, b: Vector2 ): void {

		this.queue.push( new Vector4( a.x, a.y, b.x, b.y ) );

	}

	/** Files where the nib was, so the fade can be followed back along the line. */
	private mark( point: Vector2, first: boolean ): void {

		this.history.push( { x: point.x, y: point.y, at: this.age, first } );
		this.lastMark = this.age;

	}

	/** Drops the trail without spawning anything — the page went blank, it did not fade. */
	private forget(): void {

		this.history.length = 0;
		this.head = 0;
		this.continuing = false;
		this.lastMark = this.age - INK_LIFETIME;

	}

	/**
	 * Re-authors the parchment material so the page shows its own texture with
	 * the live ink buffer composited on top. The ink is addressed by object-space
	 * position rather than the mesh's own UVs, which keeps the mapping honest
	 * regardless of how the page was unwrapped in the source asset.
	 */
	private applyMaterial(): void {

		const material = this.mesh.material as MeshPhysicalNodeMaterial;

		const inkUv = vec2(
			positionLocal.x.sub( this.localMin.x ).div( this.localSize.x ),
			positionLocal.z.sub( this.localMin.y ).div( this.localSize.y ),
		);

		const sample = this.inkSampler.sample( inkUv );

		// The knees are the config's, not literals: the lower one is the same
		// number the fade rate is derived from, so a texel stops being drawn on the
		// very frame the CPU hands its position to the motes. Hard-coding it here
		// would let the two drift apart silently.
		const heat = sample.y;
		const soak = sample.z;

		// The source asset's "Procedural Parchment Page" material carries no map at
		// all, so the page gets its fibres from TSL instead of a texture fetch.
		const fibres = mx_noise_float( vec3( inkUv.mul( vec2( 420, 90 ) ), 0 ) ).mul( 0.5 ).add( 0.5 );
		const blotch = mx_fractal_noise_float( vec3( inkUv.mul( 7 ), 0 ), 4 ).mul( 0.5 ).add( 0.5 );
		const rim = smoothstep( 0.0, 0.09, min( min( inkUv.x, inkUv.y ), min( inkUv.x.oneMinus(), inkUv.y.oneMinus() ) ) );

		// The ink edge follows the paper grain instead of the nib's own perfect
		// falloff. Jittering the *knees* rather than blurring the result is what
		// makes this read as absorption: the same fibre noise that lightens the
		// parchment is what the stroke's border now wanders along, so the ragged
		// edge and the fibres underneath it are the same feature.
		const bleedJitter = fibres.sub( 0.5 ).mul( BLEED_RAGGED );
		const ink = smoothstep( INK_VISIBLE, float( INK_SOLID ).add( bleedJitter ), sample.x );

		const aged = mix( color( 0x9c8963 ), color( 0xcdb894 ), blotch );
		const paper = material.map ? texture( material.map, uv() ).rgb : aged;

		const parchment = paper
			.mul( fibres.mul( 0.14 ).add( 0.9 ) )
			.mul( rim.mul( 0.25 ).add( 0.75 ) );

		// Ink that has soaked sideways into the fibres beside the stroke. Multiplied
		// into the parchment rather than mixed over it, so it darkens the paper's own
		// colour and grain instead of laying a flat decal on top of them — and
		// modulated by the same fibre noise, so it reads as being *in* the paper.
		// It fades with the ink, so nothing is left on the page afterwards.
		const damp = parchment.mul( mix(
			vec3( 1, 1, 1 ),
			SOAK_TINT,
			clamp( soak, 0, 1 ).mul( SOAK_DEPTH ).mul( fibres.mul( 0.5 ).add( 0.6 ) ),
		) );

		const inkColor = mix( color( 0x241a2e ), color( 0x120b18 ), ink );

		material.colorNode = mix( damp, inkColor, ink );
		// Damp fibres are a little glossier than dry parchment, so the soak shows in
		// a highlight as well as in colour — and goes with the ink, like the rest.
		material.roughnessNode = mix( float( 0.92 ), float( 0.55 ), ink ).sub( soak.mul( 0.05 ) );

		// A charged sigil lights the page from within; the rim of each stroke
		// glows hottest, which reads as ink about to catch fire.
		// Heat only sharpens the rim; the body of the glow follows the ink itself,
		// otherwise a finished sigil would go dark while it is still charging.
		const charge = ink.mul( pow( heat, 1.4 ).mul( 0.55 ).add( 0.45 ) );
		material.emissiveNode = mix( color( 0x6d3ac9 ), this.uGlowColor, smoothstep( 0.05, 0.45, this.uGlow ) )
			.mul( charge )
			.mul( this.uGlow.mul( 6.5 ) );

		material.emissiveIntensity = 1;
		material.needsUpdate = true;

	}

}

interface KernelParams {
	segments: Vec4Uniform[];
	radius: FloatUniform;
	inkFade: FloatUniform;
	heatDecay: FloatUniform;
	soakStrength: FloatUniform;
	aspect: FloatUniform;
	box: Vec4Uniform;
}

/**
 * Squeezes an arbitrarily long queue of stroke segments into `slots` of them by
 * joining runs end-to-end. A 1000 Hz mouse can out-produce a 60 Hz frame; the
 * path it traced is preserved, only its sub-pixel detail is lost.
 */
function decimate( queue: Vector4[], slots: number ): Vector4[] {

	if ( queue.length <= slots ) return queue;

	const out: Vector4[] = [];

	for ( let i = 0; i < slots; i ++ ) {

		const start = queue[ Math.floor( ( i * queue.length ) / slots ) ];
		const end = queue[ Math.floor( ( ( i + 1 ) * queue.length ) / slots ) - 1 ] ?? start;

		out.push( new Vector4( start.x, start.y, end.z, end.w ) );

	}

	return out;

}

/** Distance from `p` to the capsule spine `a`→`b`. */
const sdSegment = Fn( ( [ p, a, b ]: [ Vec2Node, Vec2Node, Vec2Node ] ) => {

	const pa = p.sub( a );
	const ba = b.sub( a );
	const h = clamp( pa.dot( ba ).div( ba.dot( ba ).add( 1e-7 ) ), 0, 1 );

	return pa.sub( ba.mul( h ) ).length();

} );

function buildKernel( read: StorageTexture, write: StorageTexture, params: KernelParams ) {

	const readNode = texture( read );

	return Fn( () => {

		const x = instanceIndex.mod( uint( INK_SIZE ) );
		const y = instanceIndex.div( uint( INK_SIZE ) );
		const coord = uvec2( x, y );

		const previous = textureLoad( readNode, coord );

		const ink = previous.x.mul( params.inkFade ).toVar();
		const heat = previous.y.mul( params.heatDecay ).toVar();

		// Where the ink has soaked sideways into the fibres. Channel `z` was spare,
		// so it costs no bandwidth: same texture, same dispatch, same fetch.
		//
		// Faded on `inkFade` — the ink's own curve — and that is the whole point.
		// This used to have a slow decay of its own so the page would keep a record
		// of what had been written on it, which is a different feature and not a
		// welcome one: it left every sigil printed on the parchment for a quarter of
		// a minute, and a cast tripled it on the way out. Sharing the ink's fade
		// means the halo cannot outlive the stroke that made it, by construction —
		// including through a burn, which simply runs that same fade fast.
		const soaked = previous.z.mul( params.inkFade ).toVar();

		const skew = vec2( params.aspect, 1 );
		const uvPoint = vec2( float( x ).add( 0.5 ), float( y ).add( 0.5 ) ).div( float( INK_SIZE ) );
		const p = uvPoint.mul( skew );

		const inside = uvPoint.x.greaterThanEqual( params.box.x )
			.and( uvPoint.y.greaterThanEqual( params.box.y ) )
			.and( uvPoint.x.lessThanEqual( params.box.z ) )
			.and( uvPoint.y.lessThanEqual( params.box.w ) );

		// Whole warps outside this frame's ink skip the brush entirely; the ones
		// that stay run an unrolled loop, so there is no dynamic indexing at all.
		If( inside, () => {

			for ( const segment of params.segments ) {

				const d = sdSegment( p, segment.xy.mul( skew ), segment.zw.mul( skew ) );
				// A narrow falloff band, so most of a stroke is written at full ink
				// rather than ramping across two thirds of its own width. That is what
				// lets `INK_SOLID` sit high enough to kill the fade's plateau without
				// the line going thin: the knee can only lighten what the nib did not
				// write solidly in the first place.
				const nib = smoothstep( params.radius, params.radius.mul( 0.72 ), d );

				ink.assign( max( ink, nib ) );
				heat.assign( max( heat, nib ) );

				// The stain gets its own footprint, wider and much softer than the nib,
				// because that is what soaking sideways into the fibres looks like.
				//
				// It must be written from the *distance*, not read off the ink. The
				// first attempt derived the bleed from ink sitting between two low
				// thresholds, which is a band in value and therefore a band in *time*:
				// every texel of every stroke crosses it on the way down, so whole
				// strokes turned into brown clouds as they faded instead of thinning.
				// A footprint laid at write time is spatial and stays where it was put.
				const wide = smoothstep( params.radius.mul( BLEED_SPREAD ), params.radius.mul( 0.5 ), d );

				// Maxed, not accumulated: a nib in motion covers any given texel for only
				// a handful of frames, so a per-second gain integrates to almost nothing.
				// The footprint is what wets the fibres; the strength is a property of
				// the ink, not of how long the nib loitered.
				soaked.assign( max( soaked, wide.mul( params.soakStrength ) ) );

			}

		} );

		// Ink never leaves the sheet, and never quite reaches pure black.
		If( ink.greaterThan( 0.995 ), () => {

			ink.assign( 0.995 );

		} );

		textureStore( write, coord, vec4( ink, min( heat, float( 1 ) ), min( soaked, float( 1 ) ), 1 ) );

	} )().compute( INK_SIZE * INK_SIZE );

}
