import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CAM_FOCUS, CAM_IDLE } from '../config';

const EASE = ( t: number ): number => t * t * ( 3 - 2 * t );

const UP = new Vector3( 0, 1, 0 );

/** How far the view may turn from the framing it belongs to. */
const YAW_LIMIT = Math.PI * 0.42;
const PITCH_UP = Math.PI * 0.16;
const PITCH_DOWN = Math.PI * 0.2;

/** How close the lean has to be to its goal before it counts as arrived. */
const LEAN_SETTLED = 0.015;

/**
 * How hard the lean chases its goal, per second, as the rate of an exponential
 * approach — and how much gentler it is when nobody asked.
 *
 * Reaching for the page should be immediate: hover starts that move and the hand
 * is already on its way, so the camera arriving late is the camera lagging the
 * player. Coming back to the page *after a spell* is the opposite — the player
 * asked for nothing, the room is simply going back to work — and at the reaching
 * rate it covers two thirds of the distance in a quarter of a second, which does
 * not read as settling. It reads as a cut.
 *
 * The ratio is the one the look-around already uses for the same distinction:
 * following a drag runs at 16, recentring afterwards at 5, because "following
 * wants to feel immediate, coming back wants to feel like a decision". Three
 * times gentler here puts the return at about a second and a half, and a stroke
 * started mid-glide takes the rate back — `lean` is a reach, and a reach is
 * immediate again.
 */
const LEAN_RATE = 4.5;
const RETURN_RATE = 1.5;

/**
 * How fast a jolt dies away, per second, as an exponential rate. High: a shake
 * that outlives the thing that caused it stops reading as an impact and starts
 * reading as a fault in the camera.
 */
const SHAKE_DECAY = 7.5;

/**
 * Metres from the camera at which a jolt is worth half of what it was at the
 * source. The room is about nine across, so at this figure a detonation on the
 * dummy still carries and one against the far wall barely does.
 */
const SHAKE_HALF = 2.6;

/**
 * The frequencies the three axes wobble at, in radians per second. Chosen not to
 * divide into one another, so the three never line up and the shake never
 * repeats over the half second anyone can actually see it.
 */
const SHAKE_RATE = [ 43.1, 37.7, 29.3 ] as const;

/**
 * Radians of head-turn per metre of jolt.
 *
 * A conversion, not a fraction — the two halves of a shake are in different
 * units and pretending otherwise is how this ended up too gentle: at 0.55 a
 * fireball turned the view 0.7°, which is about fifteen pixels, and the whole
 * knock read as the camera being nudged rather than hit. At 1.6 the same jolt
 * turns it 2°, and since displacing the camera 22 mm only moves a four-metre
 * subject by a third of a degree, the turn is doing nearly all the work — which
 * is the right way round. It is what the eye reads as being knocked.
 */
const SHAKE_TURN = 1.6;

/**
 * The arrival, in metres back along the view axis and degrees of extra field.
 *
 * The door opens onto a camera that is already moving: 2.2 m behind the seat,
 * looking at the same point, easing forward into it. What that buys is a shot
 * the experience otherwise never shows — from back there the whole round room is
 * in frame, the cauldron and the candle shelf and the bookcases, and the stool
 * you are about to sit on is in the middle of it, and then it passes under you.
 *
 * 2.2 is a limit, not a taste. There is no ceiling and nothing is modelled above
 * about 2.6 m, so the camera must not clear the wall's top course: at 3.6 m back
 * with any lift at all the top quarter of the frame is empty sky and the room
 * reads as a model on a table. Straight back along the view axis, no lift, keeps
 * every edge of the frame inside the room.
 *
 * The extra field is small on purpose. Widening the lens and dollying in at once
 * is a dolly zoom, and a strong one holds the subject the same size while the
 * room distorts around it — which is a horror-film effect and the opposite of
 * arriving somewhere. At 6° it only softens the perspective at the far end.
 */
const ENTRY_BACK = 2.2;
const ENTRY_FOV = 6;

function clamp( value: number, min: number, max: number ): number {

	return Math.min( max, Math.max( min, value ) );

}

/**
 * Two framings, one blend: the witch sits back to watch the room, then leans in
 * over the parchment to draw. `t` is the lean — 0 seated, 1 nose-to-the-page.
 */
export class CameraRig {

	readonly camera: PerspectiveCamera;

	/** Debug free-look; suspends the rig while active. */
	readonly controls: OrbitControls;
	private free = false;

	private t = 0;
	private goal = 0;
	private leanRate = LEAN_RATE;
	private locked = false;
	/** A hover request that arrived mid-move; applied when the move lands. */
	private queued: 0 | 1 | null = null;

	/** Where the witch is looking, relative to whatever the framing points at. */
	private yaw = 0;
	private pitch = 0;
	private yawGoal = 0;
	private pitchGoal = 0;
	private recentring = false;
	private clock = 0;

	/** Live jolt amplitude, in metres. Decays to nothing on its own. */
	private shakeAmount = 0;

	/** The arrival: 1 the moment the door opens, 0 once the camera is in the seat. */
	private entry = 0;
	private entryClock = 0;
	private entrySeconds = 0;

	private readonly position = new Vector3();
	private readonly target = new Vector3();
	private readonly direction = new Vector3();
	private readonly right = new Vector3();

	constructor( canvas: HTMLCanvasElement ) {

		this.camera = new PerspectiveCamera( CAM_IDLE.fov, 1, 0.05, 60 );
		this.camera.position.copy( CAM_IDLE.position );
		this.camera.lookAt( CAM_IDLE.target );

		this.controls = new OrbitControls( this.camera, canvas );
		this.controls.target.copy( CAM_IDLE.target );
		this.controls.enabled = false;
		this.controls.enableDamping = true;

	}

	setViewport( width: number, height: number ): void {

		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

	}

	get isFree(): boolean {

		return this.free;

	}

	/** True while the lean-in or lean-out is still visibly running. */
	get isLeaning(): boolean {

		return Math.abs( this.goal - this.t ) > LEAN_SETTLED;

	}

	/**
	 * Asks for a framing. A move already under way is not redirected — it lands
	 * first and the request is applied after.
	 *
	 * The two framings put the parchment in different places on screen, so a
	 * pointer resting near the edge of the sheet genuinely *is* over the page in
	 * one and off it in the other. Hover then answers a question whose answer it
	 * is itself changing: the camera would start leaning in, the page would slide
	 * out from under the cursor, hover would flip, and the rig juddered between
	 * the two rather than arriving at either. Committing to the move breaks that
	 * loop at the camera; `StrokeRecorder` widens the hover test to keep the
	 * pointer from re-asking the moment it lands.
	 *
	 * @param force Skip the wait. For deliberate acts — starting a stroke, a cast
	 * finishing, Escape — where the camera should answer immediately.
	 */
	lean( amount: 0 | 1, force = false ): void {

		if ( this.locked ) return;

		// The arrival guards itself here rather than asking callers to remember a
		// lock. A pointer crossing the parchment while the camera is still walking
		// in would otherwise start a lean-in *through* the dolly, and the two blends
		// would fight over the same frame.
		//
		// A forced lean goes through anyway, and the two blends compose rather than
		// fight: `apply` lerps the framing and *then* pushes the result back along
		// the view axis, so the camera leans in while it is still walking. What is
		// on the other side of a forced lean during the arrival is someone who has
		// started drawing on a page they cannot yet see properly — and a sigil drawn
		// from back there is not the shape the recogniser is holding templates for.
		if ( this.entry > 0 && ! force ) return;

		if ( ! force && this.isLeaning ) {

			this.queued = amount;
			return;

		}

		this.queued = null;
		this.goal = amount;
		this.leanRate = LEAN_RATE;

	}

	/**
	 * Comes back to the page once a spell is done with the camera, in the camera's
	 * own time rather than the hand's — see {@link RETURN_RATE}.
	 *
	 * Separate from `lean` because it is a different act. Everything that goes
	 * through `lean` is somebody reaching: the pointer crossing on to the sheet, a
	 * stroke starting, Escape. This is the room putting itself back where the work
	 * happens, with nobody having asked, and a move nobody asked for should not
	 * arrive like one that was.
	 */
	returnToPage(): void {

		if ( this.locked ) return;

		this.recentre();

		this.queued = null;
		this.goal = 1;
		this.leanRate = RETURN_RATE;

	}

	/**
	 * Commits the framing for the duration of a sigil: the goal stops moving, so
	 * neither a hover leaving the page nor a look-around can redirect the camera
	 * mid-stroke. The ease already under way still runs to completion.
	 */
	setLocked( locked: boolean ): void {

		// Whatever hover last asked for is stale the moment a sigil starts; the
		// caller commits the framing it wants with a forced `lean`.
		this.queued = null;

		// And the gaze is committed *where it is*, not merely stopped from being
		// re-aimed. Blocking new requests is not enough on its own, because the one
		// that matters has already been made: reaching for the page is what calls
		// `recentre`, so a player who was looking around the room and then draws has
		// a recentring already in flight when the stroke starts — and it eases at
		// rate 5, over about a second, which is the length of a stroke. Measured
		// through the drawing path from a view turned 0.22 rad off the desk: **8.7°
		// of camera turn while the sigil was being drawn**, all of it a move that had
		// been asked for before the pen went down.
		//
		// Frozen rather than finished. Snapping the gaze straight at the moment the
		// stroke starts would be a cut in the worst possible place, and the sigil
		// does not care: the recogniser re-projects the whole cloud through the
		// current camera, so an off-centre gaze that *holds still* is just a slightly
		// different projection, and `onCast` recentres properly once the lock lifts.
		//
		// This is deliberately not what the old rig did to `t`, and the distinction
		// is the point. The lean-in is a move *towards* the page that the stroke
		// itself asked for, and freezing it stopped the camera halfway; the
		// recentring is a leftover from looking at the room and has no business
		// running while a line is being drawn.
		if ( locked && ! this.locked ) {

			this.yawGoal = this.yaw;
			this.pitchGoal = this.pitch;
			this.recentring = false;

		}

		this.locked = locked;

	}

	/**
	 * Turns the view without leaving the seat — the witch looks around the room
	 * rather than flying through it, so the desk never stops being the anchor.
	 * Angles are in radians and accumulate; the limits stop you looking through
	 * your own shoulders.
	 */
	look( deltaYaw: number, deltaPitch: number ): void {

		if ( this.locked || this.entry > 0 ) return;

		this.recentring = false;
		this.yawGoal = clamp( this.yawGoal + deltaYaw, - YAW_LIMIT, YAW_LIMIT );
		this.pitchGoal = clamp( this.pitchGoal + deltaPitch, - PITCH_DOWN, PITCH_UP );

	}

	/**
	 * Knocks the camera, for something landing at `at` with `energy` metres of
	 * displacement at the source.
	 *
	 * The falloff is here rather than at the call sites so every spell is measured
	 * the same way: what a caller knows is how hard the thing hit, and what the rig
	 * knows is how far away it was. Jolts take the larger of the two rather than
	 * summing, so a shot landing inside a shatter cannot stack into a lurch.
	 */
	shake( at: Vector3, energy: number ): void {

		// Not while a sigil is being drawn. `setLocked` commits the framing, and a
		// jolt is the one thing that was still getting through it — the goal, the
		// look-around and the hand-back all defer to the lock, and this did not.
		//
		// It is also the worst of them to let through, because of *when* it happens.
		// A player who casts and immediately starts the next sigil is drawing while
		// the last shot is still in the air; the fireball then detonates under their
		// hand and turns the view. Measured through the drawing path with a shot
		// landing mid-stroke: **2.6° of camera turn**, which at this framing is the
		// page sliding a centimetre sideways while a line is being drawn on it.
		//
		// Dropped rather than deferred. The jolt is about something landing at that
		// moment; delivered half a second later, after the sigil resolves, it would
		// be a camera knock with nothing on screen to explain it. No spell loses its
		// own jolt to this: `onCast` clears the lock before it calls `cast`, so the
		// bolt, the ward and the rune all shake from an unlocked rig, and the
		// fireball's impact lands a second and a half after that.
		if ( this.locked ) return;

		const distance = at.distanceTo( this.camera.position );

		this.shakeAmount = Math.max( this.shakeAmount, energy / ( 1 + ( distance / SHAKE_HALF ) ** 2 ) );

	}

	/** Eases the view back to facing the desk, ready to write. */
	recentre(): void {

		// Same as `shake`: the lock owns the framing for the length of a sigil, and
		// the gaze is part of the framing. Hover calls this every time the pointer
		// crosses on to the sheet, which happens between the strokes of a multi-
		// stroke glyph — so a view that was turned would have eased itself straight
		// mid-sigil, with the pen down on the page.
		if ( this.locked ) return;

		if ( this.yawGoal === 0 && this.pitchGoal === 0 ) return;

		this.recentring = true;
		this.yawGoal = 0;
		this.pitchGoal = 0;

	}

	/** True while the view is turned away from the framing's own direction. */
	get isTurned(): boolean {

		return Math.abs( this.yaw ) > 0.01 || Math.abs( this.pitch ) > 0.01;

	}

	/**
	 * Walks the camera in from behind the seat. Call it as the door opens.
	 *
	 * Applied immediately rather than on the next frame, because the first frame
	 * after the gate is the first frame anyone sees: leaving it to `update` would
	 * show one frame of the seated shot before the camera jumped back, which is a
	 * cut in the worst possible place.
	 */
	arrive( seconds: number ): void {

		this.entry = 1;
		this.entryClock = 0;
		this.entrySeconds = seconds;

		this.apply();

	}

	/** True while the arrival is still running. */
	get isArriving(): boolean {

		return this.entry > 0;

	}

	/** Jumps straight to a framing, skipping the ease. */
	snap( amount: 0 | 1 ): void {

		// Cancels an arrival outright: `snap` exists to put the camera somewhere
		// definite this instant, and an entry offset still decaying underneath it
		// would drift the shot for the next two seconds.
		this.entry = 0;
		this.goal = amount;
		this.t = amount;
		this.leanRate = LEAN_RATE;
		this.queued = null;
		this.yaw = this.pitch = this.yawGoal = this.pitchGoal = 0;

		// Placed immediately, not on the next frame: callers project through this
		// camera straight away, and a stale transform silently ruins the result.
		this.apply();

	}

	toggleFree(): boolean {

		this.free = ! this.free;
		this.controls.enabled = this.free;

		if ( this.free ) this.controls.target.copy( this.target );

		return this.free;

	}

	update( dt: number ): void {

		this.clock += dt;

		if ( this.free ) {

			this.controls.update();
			return;

		}

		// Critically-ish damped approach; snappy enough to feel like a lean-in.
		//
		// This keeps easing while locked, and that is the point of the lock now: a
		// sigil fixes the *goal* so nothing can redirect the framing mid-stroke, but
		// the move itself still finishes. It used to freeze `t` as well, which meant
		// starting to draw before the lean-in had arrived stopped the camera dead,
		// halfway. That was necessary while the recogniser matched the screen-space
		// samples it captured; `StrokeRecorder` re-projects the whole cloud through
		// the current camera now, so a camera in motion can no longer shear it.
		this.t += ( this.goal - this.t ) * Math.min( 1, dt * this.leanRate );

		if ( this.queued !== null && ! this.isLeaning ) {

			this.goal = this.queued;
			this.queued = null;

		}

		// Following the drag wants to feel immediate; coming back wants to feel like
		// a decision, so the return is deliberately the slower of the two.
		const rate = Math.min( 1, dt * ( this.recentring ? 5 : 16 ) );

		this.yaw += ( this.yawGoal - this.yaw ) * rate;
		this.pitch += ( this.pitchGoal - this.pitch ) * rate;

		if ( this.recentring && ! this.isTurned ) {

			this.recentring = false;
			this.yaw = this.pitch = 0;

		}

		this.shakeAmount *= Math.exp( - dt * SHAKE_DECAY );

		if ( this.shakeAmount < 0.0002 ) this.shakeAmount = 0;

		if ( this.entry > 0 ) {

			this.entryClock += dt;
			this.entry = Math.max( 0, 1 - this.entryClock / this.entrySeconds );

		}

		this.apply();

	}

	/** Places the camera for the current lean. */
	private apply(): void {

		const k = EASE( this.t );

		this.position.lerpVectors( CAM_IDLE.position, CAM_FOCUS.position, k );
		this.target.lerpVectors( CAM_IDLE.target, CAM_FOCUS.target, k );

		// The arrival, before anything else touches the position: straight back along
		// the view axis, so the camera keeps looking at exactly what it will look at
		// from the seat and the whole move reads as travel rather than as a pan.
		//
		// Eased on both ends. A pure ease-out covers most of the distance in the
		// first third and reads as being shoved; smootherstep leaves under a tenth
		// of the travel in the last quarter-second, which is the part that reads as
		// coming to rest.
		const arriving = this.entry > 0 ? 1 - EASE( EASE( 1 - this.entry ) ) : 0;

		if ( arriving > 0 ) {

			this.direction.subVectors( this.target, this.position ).normalize();
			this.position.addScaledVector( this.direction, - ENTRY_BACK * arriving );

		}

		// A slow breath keeps the seated shot from looking like a still.
		const breath = ( 1 - k ) * 0.006;
		this.position.x += Math.sin( this.clock * 0.51 ) * breath;
		this.position.y += Math.sin( this.clock * 0.83 + 1.2 ) * breath;

		// The jolt. Displacing the camera alone is surprisingly weak — at the scale
		// that stays comfortable the frame barely moves — so most of it goes into
		// turning the head instead, which is what the eye actually reads as being
		// knocked. The two share one amplitude so they always decay together.
		const jolt = this.shakeAmount;

		if ( jolt > 0 ) {

			this.position.x += Math.sin( this.clock * SHAKE_RATE[ 0 ] ) * jolt;
			this.position.y += Math.sin( this.clock * SHAKE_RATE[ 1 ] + 1.7 ) * jolt;
			this.position.z += Math.sin( this.clock * SHAKE_RATE[ 2 ] + 3.1 ) * jolt;

		}

		this.camera.position.copy( this.position );

		// The framing decides where the head is and roughly where it faces; yaw and
		// pitch then turn that gaze in place.
		this.direction.subVectors( this.target, this.position ).applyAxisAngle( UP, this.yaw );
		this.right.crossVectors( this.direction, UP ).normalize();
		this.direction.applyAxisAngle( this.right, this.pitch );

		if ( jolt > 0 ) {

			this.direction.applyAxisAngle( UP, Math.sin( this.clock * SHAKE_RATE[ 2 ] + 0.9 ) * jolt * SHAKE_TURN );
			this.direction.applyAxisAngle( this.right, Math.sin( this.clock * SHAKE_RATE[ 0 ] + 2.4 ) * jolt * SHAKE_TURN );

		}

		this.camera.lookAt( this.target.copy( this.position ).add( this.direction ) );
		this.camera.fov = CAM_IDLE.fov + ( CAM_FOCUS.fov - CAM_IDLE.fov ) * k + ENTRY_FOV * arriving;
		this.camera.updateProjectionMatrix();
		this.camera.updateMatrixWorld();

	}

}
