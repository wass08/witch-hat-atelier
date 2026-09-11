import type { CameraRig } from './CameraRig';

/** Radians of turn per pixel of drag. */
const SPEED = 0.0035;

const LEFT = 0;
const RIGHT = 2;

/**
 * Drag anywhere that is not the parchment to look around the room.
 *
 * There is no mode to enter: drawing already only happens on the page, so a drag
 * that starts anywhere else is unambiguous. This listens after `StrokeRecorder`,
 * so if the quill took the pointer, `busy()` reports it and the view stays put.
 */
export class LookAround {

	private turning = false;
	private lastX = 0;
	private lastY = 0;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly rig: CameraRig,
		private readonly busy: () => boolean,
		/**
		 * Told when a look-around starts and stops.
		 *
		 * `StrokeRecorder` uses it to stand its hover down for the duration. A turn
		 * sweeps the pointer across whatever the room puts under it, and if that
		 * includes the parchment the recorder would lean the camera in and recentre
		 * the very turn being made.
		 */
		private readonly onTurning: ( active: boolean ) => void = () => {},
	) {

		canvas.addEventListener( 'pointerdown', this.onDown );
		canvas.addEventListener( 'pointermove', this.onMove );
		window.addEventListener( 'pointerup', this.onUp );
		window.addEventListener( 'pointercancel', this.onUp );

	}

	dispose(): void {

		this.canvas.removeEventListener( 'pointerdown', this.onDown );
		this.canvas.removeEventListener( 'pointermove', this.onMove );
		window.removeEventListener( 'pointerup', this.onUp );
		window.removeEventListener( 'pointercancel', this.onUp );

	}

	private readonly onDown = ( event: PointerEvent ): void => {

		if ( this.rig.isFree ) return;

		// Right-drag always looks, from anywhere. Leaning in over the desk leaves
		// almost no bare canvas to grab, and the right button never draws.
		const looking = event.button === RIGHT || ( event.button === LEFT && ! this.busy() );

		if ( ! looking ) return;

		// Looking around is a room-scale act; the leaned-in framing is for writing
		// and turning inside it just sweeps the desk.
		this.rig.lean( 0 );

		this.turning = true;
		this.onTurning( true );
		this.lastX = event.clientX;
		this.lastY = event.clientY;

	};

	private readonly onMove = ( event: PointerEvent ): void => {

		if ( ! this.turning ) return;

		// Dragging left turns the view left, as if pushing the room past you.
		this.rig.look( ( event.clientX - this.lastX ) * SPEED, ( event.clientY - this.lastY ) * SPEED );

		this.lastX = event.clientX;
		this.lastY = event.clientY;

	};

	private readonly onUp = (): void => {

		if ( this.turning ) this.onTurning( false );

		this.turning = false;

	};

}
