import { Camera, Plane, Raycaster, Vector2, Vector3 } from 'three/webgpu';
import type { InkSurface } from './InkSurface';
import type { Match, Recognizer, StrokePoint } from '../recognize/pdollar';
import { CAST_DELAY, PREVIEW_INTERVAL, RECOGNITION_THRESHOLD } from '../config';

interface ScheduledPoint {
	x: number;
	y: number;
	id: number;
	/** Seconds into the trace at which this point is written. */
	at: number;
	first: boolean;
	last: boolean;
}

/** What the sigil looked like, for spells that care about more than its name. */
export interface SigilShape {
	/** Centre on the page, 0..1 in each axis. */
	centre: Vector2;
	/** Mean distance from that centre, in page widths — roughly the sigil's radius. */
	radius: number;
	/**
	 * 1 for a perfect ring, lower for anything lumpier. Measured on screen, where
	 * the player was actually judging their own line.
	 */
	roundness: number;
}

export interface CastEvent {
	match: Match;
	accepted: boolean;
	/** World-space centre of the drawn sigil, on the page. */
	origin: Vector3;
	shape: SigilShape;
}

interface Handlers {
	/** Fires when the quill crosses on/off the page, drawing or not. */
	onHover?: ( overPage: boolean ) => void;
	/** Fires when the running read of the half-drawn sigil changes. */
	onPreview?: ( match: Match | null ) => void;
	onDrawStart?: () => void;
	onCast?: ( event: CastEvent ) => void;
	onClear?: () => void;
}

/**
 * How far the quill may wander between strokes and still count as held still, in
 * screen units — the same space the recogniser works in, where the frame is 2
 * tall.
 *
 * It has to clear a resting hand and nothing more. A mouse left alone jitters a
 * pixel or two, which at a thousand pixels of frame height is about 0.004; a hand
 * carrying the pen to the next stroke covers tens of them. 0.02 sits an order of
 * magnitude off both, so *hold still to cast* stays a thing you can do by simply
 * not moving, and cannot be done by accident while still drawing.
 */
const STILL_SLOP = 0.02;

/**
 * Turns pointer input into (a) wet ink on the page and (b) a stroke-tagged
 * point cloud for the recognizer. A sigil resolves on its own once the quill
 * has been still for `CAST_DELAY`, so there is no "submit" button to hunt for.
 */
export class StrokeRecorder {

	enabled = true;

	private readonly raycaster = new Raycaster();
	private readonly ndc = new Vector2();
	private readonly uv = new Vector2();

	/** Last hit expressed the way the recognizer wants it: screen space, y down. */
	private readonly screen = new Vector2();
	private readonly plane = new Plane();
	private readonly planeHit = new Vector3();
	/** Page-space hit before clamping, and whether it landed on the sheet itself. */
	private readonly uvRaw = new Vector2();
	private onPage = false;

	private readonly hitWorld = new Vector3();

	/**
	 * Where the quill waits between strokes: the last place the nib actually put
	 * ink, or wherever the pointer has since wandered to over the sheet.
	 * Deliberately not `hitWorld`, which follows a stroke off the edge of the page
	 * and out across the room — fine for a line being drawn, absurd for a pen
	 * being held.
	 */
	private readonly heldWorld = new Vector3();

	/**
	 * Recognition happens in *screen* space, not on the page. The parchment is
	 * tilted ~60° away and seen in perspective, so a shape drawn as a star on
	 * screen lands on the page as a warped star — matching that warp against
	 * un-warped templates cost a perfect sigil up to two thirds of its score, and
	 * the bigger you drew the worse it got. What the player draws is what gets
	 * matched; the page keeps its own copy for the ink and the sigil's centre.
	 */
	private points: StrokePoint[] = [];
	private trail: Vector2[] = [];
	/** Which stroke each `trail` sample belongs to, so the cloud can be rebuilt. */
	private trailStroke: number[] = [];
	private readonly scratchWorld = new Vector3();
	private pending: ScheduledPoint[] = [];
	private tracing = false;
	private traceClock = 0;
	private previewMatch: Match | null = null;
	private previewKey = '';
	private sincePreview = 0;
	private dirty = false;
	private strokeId = - 1;
	private drawing = false;
	private overPage = false;

	/**
	 * Whether hover is allowed to steer the camera yet.
	 *
	 * The door opens on a wide shot of the room, and the parchment sits in the
	 * middle of the seated framing — so the pointer is already over it before the
	 * player has moved anything, and the first twitch of the mouse threw the camera
	 * down onto the desk. There was no moment in which the room could be looked at.
	 *
	 * Hover therefore only counts once the pointer has been somewhere that is *not*
	 * the page: bringing it back to the sheet is then a decision rather than an
	 * accident of where the cursor happened to be sitting. Pressing to draw arms it
	 * too, and drawing never depended on this — `onDrawStart` forces the framing
	 * itself — so there is no state in which the page cannot be used.
	 */
	private hoverArmed = false;

	/**
	 * Set while a look-around drag is running.
	 *
	 * A drag that starts off the sheet turns the view, and turning the view sweeps
	 * the pointer across whatever the room puts under it — including the parchment.
	 * Without this, dragging past the page mid-look fires hover, which leans the
	 * camera in and recentres the very turn being made: the room would snap back to
	 * the desk halfway through looking at it.
	 */
	hoverSuspended = false;
	private idle = 0;
	private armed = false;

	/**
	 * Where the quill was when the countdown to casting last started, in screen
	 * space — the point everything since is measured against.
	 */
	private readonly stillAt = new Vector2();

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly camera: Camera,
		private readonly ink: InkSurface,
		private readonly recognizer: Recognizer,
		private readonly handlers: Handlers = {},
	) {

		canvas.addEventListener( 'pointerdown', this.onPointerDown );
		canvas.addEventListener( 'pointermove', this.onPointerMove );
		window.addEventListener( 'pointerup', this.onPointerUp );
		canvas.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

	}

	/**
	 * Where the quill should be, or null to leave it on the desk. It is in hand
	 * from the moment the pointer reaches the parchment until it leaves again:
	 *
	 * - **drawing** — nib down on the line, tracking the point the ink is being
	 *   laid at.
	 * - **mid-sigil** — a sigil is not over when the pointer comes up. A cross has
	 *   a pen-lift in the middle of it and every sigil ends with `CAST_DELAY` of
	 *   deliberate stillness; `armed` covers both, so the quill no longer flops
	 *   onto the desk between the strokes of one glyph or while the spell goes off.
	 * - **hovering** — over a blank page it follows the cursor too. Reaching for
	 *   the parchment is already the gesture that leans the camera in; picking the
	 *   quill up on the same gesture is what makes that read as reaching for the
	 *   pen rather than as the room moving on its own.
	 */
	get activePoint(): Vector3 | null {

		if ( this.drawing || this.tracing ) return this.hitWorld;

		return this.armed || this.overPage ? this.heldWorld : null;

	}

	/** True only while the nib is actually laying ink down. */
	get writing(): boolean {

		return this.drawing || this.tracing;

	}

	/**
	 * True while the nib is down *on the sheet* — {@link writing}, less the part
	 * of a stroke that has run off the edge.
	 *
	 * The two differ because a stroke keeps following the pointer past the page
	 * (the recogniser needs that overshoot), and `activePoint` goes with it out
	 * across the desk. That is still writing as far as the sigil is concerned, but
	 * there is no paper under it, so anything that is the *sound* of paper — the
	 * quill's scratch — must stop there. A trace is always on the page.
	 */
	get inking(): boolean {

		return this.tracing || ( this.drawing && this.onPage );

	}

	/**
	 * Which stroke the nib is on; changes the moment a new one begins.
	 *
	 * For whoever measures the pen by differencing `activePoint` between frames:
	 * a trace lifts and lands in one frame, so the point jumps from the end of
	 * one stroke to the start of the next without `writing` ever going false, and
	 * that jump read as speed is a burst of noise across a gap the pen never
	 * touched. A change here is the pen-lift that the position alone cannot show.
	 */
	get stroke(): number {

		return this.strokeId;

	}

	/**
	 * Whether the quill is being held over the parchment — the same answer the
	 * last `onHover` reported, readable by anyone who missed it.
	 *
	 * Hover is an event, and a hand resting on the page generates none, so a
	 * caller that starts caring halfway through has no way to catch up. The spell
	 * is exactly that caller: it takes the camera for as long as it is in the air
	 * and has to know, when it gives the camera back, whether there is still a pen
	 * waiting over the page.
	 *
	 * Deliberately the *remembered* answer rather than a fresh cast through the
	 * camera. Sitting back to watch a spell moves the parchment across the screen
	 * and shrinks it, so the pointer that has not moved an inch would fail a fresh
	 * test — and it should not, because nothing about the hand has changed. What
	 * this is asked for is the hand. The pointer's own movements keep the answer
	 * current the whole time, spell or no spell: `onPointerMove` is only ever
	 * blind while a stroke is being drawn.
	 */
	get overParchment(): boolean {

		return this.overPage;

	}

	/** The running read of what is on the page, or null while it is illegible. */
	get preview(): Match | null {

		return this.previewMatch;

	}

	/** 0..1 progress towards the sigil resolving; drives the page's glow. */
	get charge(): number {

		if ( ! this.armed ) return 0;

		return Math.min( 1, this.idle / ( CAST_DELAY / 1000 ) );

	}

	update( dt: number ): void {

		this.playTrace( dt );
		this.readPage( dt );

		if ( this.drawing || this.tracing || ! this.armed ) return;

		this.idle += dt;

		if ( this.idle >= CAST_DELAY / 1000 ) this.resolve();

	}

	/**
	 * Files one sample. The page copy is the one that matters: the screen copy is
	 * kept only so the minimum-distance filter can ask how far the pointer moved
	 * since the last sample, which is a live question about the pointer rather
	 * than about the shape.
	 */
	private record( uv: Vector2, screen: Vector2 ): void {

		// Wherever the nib last was is where the hand would still be holding it.
		this.heldWorld.copy( this.hitWorld );

		this.points.push( { x: screen.x, y: screen.y, id: this.strokeId } );
		this.trail.push( uv.clone() );
		this.trailStroke.push( this.strokeId );
		this.dirty = true;

	}

	/**
	 * The stroke as it looks *right now*, rebuilt by projecting every page sample
	 * through the current camera.
	 *
	 * Recognition still happens in screen space — that part is load-bearing and
	 * measured — but it no longer has to happen in the screen space of the frame
	 * each sample was captured in. Re-projecting means a camera that moves during
	 * a stroke cannot shear the shape being matched, because the whole cloud is
	 * always seen through one camera: the current one.
	 *
	 * That is what lets the rig keep easing while you draw. It used to freeze the
	 * lean-in wherever it had got to, which was correct for the matching and awful
	 * to look at — start drawing before the camera has arrived and the move simply
	 * stopped, halfway.
	 */
	private screenCloud(): StrokePoint[] {

		// Once for the whole cloud, not once per point: `project` reads the camera's
		// inverse world matrix, which the renderer only refreshes at draw time.
		this.camera.updateMatrixWorld();

		const cloud: StrokePoint[] = new Array( this.trail.length );

		for ( let i = 0; i < this.trail.length; i ++ ) {

			const projected = this.ink.fromInkUV( this.trail[ i ], this.scratchWorld ).project( this.camera );

			cloud[ i ] = { x: projected.x * this.aspect, y: - projected.y, id: this.trailStroke[ i ] };

		}

		return cloud;

	}

	/** Feeds any scheduled trace points that have come due this frame. */
	private playTrace( dt: number ): void {

		if ( ! this.tracing ) return;

		this.traceClock += dt;

		while ( this.pending.length > 0 && this.pending[ 0 ].at <= this.traceClock ) {

			const point = this.pending.shift()!;
			const uv = new Vector2( point.x, point.y );

			if ( point.first ) {

				this.strokeId ++;
				this.ink.beginStroke( uv );

			} else {

				this.ink.extendStroke( uv );

			}

			this.ink.fromInkUV( uv, this.hitWorld );
			this.record( uv, this.screenFromInkUV( uv, this.screen ) );

			if ( point.last ) this.ink.endStroke();

		}

		if ( this.pending.length > 0 ) return;

		this.tracing = false;
		this.armed = true;
		this.idle = 0;

	}

	private writeStroke( stroke: { x: number; y: number }[] ): void {

		if ( stroke.length === 0 ) return;

		this.strokeId ++;

		stroke.forEach( ( point, index ) => {

			const uv = new Vector2( point.x, point.y );

			if ( index === 0 ) this.ink.beginStroke( uv );
			else this.ink.extendStroke( uv );

			this.record( uv, this.screenFromInkUV( uv, this.screen ) );

		} );

		this.ink.endStroke();

	}

	/**
	 * Re-reads the half-finished sigil so the page can show what it thinks is
	 * being drawn. Rate-limited and run in `quick` mode — this is a hint, not the
	 * verdict, and the verdict re-reads properly against every rotation.
	 */
	private readPage( dt: number ): void {

		this.sincePreview += dt;

		if ( ! this.dirty || this.sincePreview < PREVIEW_INTERVAL ) return;

		this.sincePreview = 0;
		this.dirty = false;

		// Quick (un-rotated) reads while the quill is moving, where they happen ten
		// times a second; a full read the moment it lifts, so a tilted sigil gets
		// named before it casts rather than casting unannounced.
		const match = this.recognizer.recognize( this.screenCloud(), this.drawing );
		const legible = match.name !== null && match.score >= RECOGNITION_THRESHOLD;

		this.previewMatch = legible ? match : null;

		// Bucket the score so a jittering confidence does not churn the HUD.
		const key = legible ? `${ match.name }:${ Math.round( match.score * 20 ) }` : '';

		if ( key === this.previewKey ) return;

		this.previewKey = key;
		this.handlers.onPreview?.( this.previewMatch );

	}

	private clearPreview(): void {

		this.previewMatch = null;
		this.dirty = false;

		if ( this.previewKey === '' ) return;

		this.previewKey = '';
		this.handlers.onPreview?.( null );

	}

	/**
	 * Feeds a sigil into the page in ink space, bypassing the pointer. Handy from
	 * the dev console (`atelierDebug.demo()`) and for testing the recognizer
	 * without a mouse.
	 *
	 * By default the strokes are drawn out over `seconds` at a steady pace, going
	 * through exactly the same per-frame path a real quill does — one dispatch per
	 * frame, live re-reads, the quill following the nib. Pass 0 to dump the whole
	 * sigil onto the page in a single frame instead.
	 */
	trace( strokes: { x: number; y: number }[][], seconds = 1.4 ): void {

		this.wipe();

		const total = strokes.reduce( ( sum, stroke ) => sum + stroke.length, 0 );

		if ( total === 0 ) return;

		if ( seconds <= 0 ) {

			for ( const stroke of strokes ) this.writeStroke( stroke );

			this.armed = true;
			this.idle = 0;
			return;

		}

		// A beat between strokes, so a multi-stroke sigil looks written rather than
		// stamped, and the pen-lift path gets exercised too.
		const lift = 0.18;
		const step = Math.max( 0, seconds - lift * ( strokes.length - 1 ) ) / total;

		let at = 0;
		let id = 0;

		this.pending = [];

		for ( const stroke of strokes ) {

			stroke.forEach( ( point, index ) => {

				this.pending.push( { x: point.x, y: point.y, id, at, first: index === 0, last: index === stroke.length - 1 } );
				at += step;

			} );

			at += lift;
			id ++;

		}

		this.tracing = true;
		this.traceClock = 0;
		this.handlers.onDrawStart?.();

	}

	wipe(): void {

		this.points = [];
		this.trail = [];
		this.trailStroke = [];
		this.pending = [];
		this.tracing = false;
		this.strokeId = - 1;
		this.armed = false;
		this.idle = 0;
		this.clearPreview();
		this.ink.clear();
		this.ink.setGlow( 0 );
		this.handlers.onClear?.();

	}

	dispose(): void {

		this.canvas.removeEventListener( 'pointerdown', this.onPointerDown );
		this.canvas.removeEventListener( 'pointermove', this.onPointerMove );
		window.removeEventListener( 'pointerup', this.onPointerUp );

	}

	private resolve(): void {

		const match = this.recognizer.recognize( this.screenCloud() );
		const accepted = match.name !== null && match.score >= RECOGNITION_THRESHOLD;

		// Cleared first: the preview handler resets the HUD, and the verdict has to
		// be what is left on screen afterwards.
		this.clearPreview();
		this.handlers.onCast?.( { match, accepted, origin: this.sigilCentre(), shape: this.measure() } );

		this.points = [];
		this.trail = [];
		this.trailStroke = [];
		this.strokeId = - 1;
		this.armed = false;
		this.idle = 0;

	}

	private sigilCentre(): Vector3 {

		let u = 0;
		let v = 0;

		for ( const p of this.trail ) {

			u += p.x;
			v += p.y;

		}

		const n = Math.max( 1, this.trail.length );

		return this.ink.fromInkUV( new Vector2( u / n, v / n ) );

	}

	/** Within a quarter-page of the sheet's edge. */
	private nearPage(): boolean {

		const margin = 0.35;

		return this.uvRaw.x > - margin && this.uvRaw.x < 1 + margin
			&& this.uvRaw.y > - margin && this.uvRaw.y < 1 + margin;

	}

	/** Size on the page, roundness on screen — see {@link SigilShape}. */
	private measure(): SigilShape {

		const centre = new Vector2();
		const pageCount = Math.max( 1, this.trail.length );

		for ( const p of this.trail ) centre.add( p );

		centre.divideScalar( pageCount );

		let radius = 0;

		for ( const p of this.trail ) radius += Math.hypot( p.x - centre.x, p.y - centre.y );

		radius /= pageCount;

		// Roundness is the spread of the radii: a ring has none, a star has plenty.
		// Measured on the same re-projected cloud the recogniser saw, so the number
		// describes one consistent view rather than a stroke smeared across however
		// far the camera happened to travel while it was being drawn.
		const screen = this.screenCloud();

		let sx = 0;
		let sy = 0;
		const screenCount = Math.max( 1, screen.length );

		for ( const p of screen ) {

			sx += p.x;
			sy += p.y;

		}

		sx /= screenCount;
		sy /= screenCount;

		let mean = 0;

		for ( const p of screen ) mean += Math.hypot( p.x - sx, p.y - sy );

		mean /= screenCount;

		let variance = 0;

		for ( const p of screen ) variance += ( Math.hypot( p.x - sx, p.y - sy ) - mean ) ** 2;

		variance /= screenCount;

		const roundness = mean > 1e-6 ? clamp( 1 - Math.sqrt( variance ) / mean, 0, 1 ) : 0;

		return { centre, radius, roundness };

	}

	/** Aspect-corrected so a circle on screen is a circle to the recognizer. */
	private get aspect(): number {

		const width = this.canvas.clientWidth || window.innerWidth;
		const height = this.canvas.clientHeight || window.innerHeight;

		return height > 0 ? width / height : 1;

	}

	/** Screen-space position of a point on the page, for traced (mouse-less) input. */
	private screenFromInkUV( uv: Vector2, out: Vector2 ): Vector2 {

		// `project` reads the camera's inverse world matrix, which the renderer only
		// refreshes at draw time; without this a trace started in the same tick as a
		// camera move is projected through the *previous* framing.
		this.camera.updateMatrixWorld();

		const projected = this.ink.fromInkUV( uv ).project( this.camera );

		return out.set( projected.x * this.aspect, - projected.y );

	}

	/**
	 * @param beyondPage Keep tracking once the quill has left the parchment. A
	 * stroke that overshoots the edge used to have those samples thrown away,
	 * which either mangled the sigil or left too few points to read at all.
	 */
	private hit( event: PointerEvent, beyondPage = false ): Vector2 | null {

		const rect = this.canvas.getBoundingClientRect();
		const width = rect.width || this.canvas.clientWidth;
		const height = rect.height || this.canvas.clientHeight;

		if ( width < 2 || height < 2 ) return null;

		this.ndc.set(
			( ( event.clientX - rect.left ) / width ) * 2 - 1,
			- ( ( event.clientY - rect.top ) / height ) * 2 + 1,
		);

		this.raycaster.setFromCamera( this.ndc, this.camera );

		const [ intersection ] = this.raycaster.intersectObject( this.ink.mesh, false );

		this.onPage = intersection !== undefined;

		let point = intersection?.point;

		if ( point === undefined ) {

			if ( ! beyondPage ) return null;

			this.ink.getPlane( this.plane );

			if ( this.raycaster.ray.intersectPlane( this.plane, this.planeHit ) === null ) return null;

			point = this.planeHit;

		}

		this.hitWorld.copy( point );
		this.screen.set( this.ndc.x * this.aspect, - this.ndc.y );

		this.ink.toInkUV( point, this.uvRaw );

		// The ink has nowhere to go past the sheet; keep the page-space copy sane
		// so a stroke chased across the room cannot drag the sigil's centre with it.
		this.uv.set( clamp( this.uvRaw.x, - 0.4, 1.4 ), clamp( this.uvRaw.y, - 0.4, 1.4 ) );

		return this.uv;

	}

	private readonly onPointerDown = ( event: PointerEvent ): void => {

		if ( ! this.enabled || event.button !== 0 ) return;

		// Reaching for the page with the button down is as deliberate as it gets, so
		// hover has nothing left to guard against after this.
		this.hoverArmed = true;

		// Starting a stroke just off the edge of the sheet is a near miss, not an
		// attempt to draw on the floor; anything further away is ignored.
		const uv = this.hit( event, true );

		if ( uv === null ) return;
		if ( ! this.onPage && ! this.nearPage() ) return;

		// Synthetic events (tests, automation) have no live pointer to capture.
		try {

			this.canvas.setPointerCapture( event.pointerId );

		} catch {

			// no capture available; the window-level pointerup still ends the stroke

		}

		this.drawing = true;
		this.armed = true;
		this.idle = 0;
		this.strokeId ++;

		this.stillAt.copy( this.screen );

		this.ink.beginStroke( uv );
		this.record( uv, this.screen );
		this.handlers.onDrawStart?.();

	};

	private readonly onPointerMove = ( event: PointerEvent ): void => {

		// Always solved against the page's plane, not just its outline: a stroke
		// needs that to keep following an overshoot, and hover needs it to measure
		// *how far* off the sheet the pointer has drifted.
		const uv = this.hit( event, true );

		if ( this.enabled && ! this.drawing && ! this.hoverSuspended ) {

			// Deliberately asymmetric. Crossing on to the page is the strict test;
			// leaving it means clearing the sheet by `nearPage`'s margin.
			//
			// Hover drives the camera and the camera moves the page: the two framings
			// frame the parchment differently, so a pointer parked near the edge is
			// honestly on the sheet in one and off it in the other, and a strict test
			// on both sides let it flip every time the rig moved. The rig commits to a
			// move once it starts, which stops the judder — this stops the pointer
			// asking again the instant the move lands. The margin is `nearPage`'s, so
			// the band where the quill stays raised is exactly the band where a
			// stroke started off the sheet still counts as aimed at it.
			const over = uv !== null && ( this.onPage || ( this.overPage && this.nearPage() ) );

			// The first time the pointer is genuinely off the sheet, hover starts
			// counting. Before that it is only reporting where the cursor was left.
			if ( ! over ) this.hoverArmed = true;

			if ( over !== this.overPage && this.hoverArmed ) {

				this.overPage = over;
				this.handlers.onHover?.( over );

			}

			// The quill follows the pointer around the page whenever it is over it —
			// before the first stroke, and between strokes, where you are about to
			// draw the next one and that is where. Only over the sheet, though: off
			// it, the pen holds its last place instead of being dragged across the
			// room. This runs on the same frame `overPage` turns true, so the held
			// point is never read before it has been set.
			if ( over ) {

				// …and a quill on its way to the next stroke is not a quill being held
				// still.
				//
				// The page casts on `CAST_DELAY` of stillness, and the only thing that
				// was resetting that countdown was ink actually being laid down. Lift
				// the pen at the end of one stroke of a cross, carry it across the
				// sheet to start the next, and the timer ran the whole way: the sigil
				// resolved on whatever half of it existed, mid-draw, and the camera sat
				// back to cast it. The HUD said *hold still to cast* over a pen that
				// was visibly moving — the quill follows the pointer on the line above,
				// so the game was showing the hand travelling and counting it as
				// stillness at the same time.
				//
				// Only once a sigil is under way. Before the first stroke there is
				// nothing to resolve and `armed` is false, so wandering over a blank
				// page costs nothing.
				if ( this.armed && Math.hypot( this.screen.x - this.stillAt.x, this.screen.y - this.stillAt.y ) > STILL_SLOP ) {

					this.stillAt.copy( this.screen );
					this.idle = 0;

				}

				this.heldWorld.copy( this.hitWorld );

			}

		}

		if ( ! this.drawing || uv === null ) return;

		const last = this.points[ this.points.length - 1 ];

		// Measured in screen space, the same space the recognizer works in. Doing
		// this on the page instead threw away every sample taken past the sheet's
		// edge, where the clamped page position stops changing.
		if ( last !== undefined && last.id === this.strokeId
			&& Math.hypot( this.screen.x - last.x, this.screen.y - last.y ) < 0.006 ) return;

		this.ink.extendStroke( uv );
		this.record( uv, this.screen );
		this.idle = 0;

	};

	private readonly onPointerUp = ( event: PointerEvent ): void => {

		if ( ! this.drawing ) return;

		if ( this.canvas.hasPointerCapture( event.pointerId ) ) this.canvas.releasePointerCapture( event.pointerId );

		this.drawing = false;
		this.idle = 0;
		this.stillAt.copy( this.screen );
		this.ink.endStroke();

	};

}

function clamp( value: number, min: number, max: number ): number {

	return Math.min( max, Math.max( min, value ) );

}
