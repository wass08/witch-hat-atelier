import { Box3, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three/webgpu';

const UP = new Vector3( 0, 1, 0 );

/**
 * How hard the quill chases where it should be, per second, as the rate of an
 * exponential approach.
 *
 * Three of them, because writing, carrying and being put down are not the same
 * motion.
 *
 * Writing is the strict one: the nib has to sit on the point the ink is appearing
 * at, and the ink appears under the cursor the same frame the pointer moves. At
 * 14 the pen trailed a fast drag by 8 cm, a sixth of the way across the sheet, so
 * the line drew itself ahead of the nib.
 *
 * Carrying — hovering the page, or between the strokes of one sigil — should keep
 * up without being rigid about it. Nothing is being drawn, and a hand moving a
 * pen across a page does lag a little.
 *
 * Reaching for the desk and laying back down is the loosest: nothing is racing
 * it, and a snap there looks like a glitch rather than like a hand.
 */
const FOLLOW_RATE = 55;
const CARRY_RATE = 28;
const SETTLE_RATE = 14;

/**
 * Finds the far end of the quill along its own axis — the point that should meet
 * the paper. Measured rather than hard-coded, because the writing tip is not the
 * part you would guess: the gold piece named "Pen_Nib_Color" is only the collar,
 * and the actual steel nib hangs 8 cm beyond it on a separate child.
 */
function measureTip( pen: Object3D ): number {

	pen.updateMatrixWorld( true );

	const toLocal = new Matrix4().copy( pen.matrixWorld ).invert();
	const transform = new Matrix4();
	const bounds = new Box3();
	const part = new Box3();

	pen.traverse( ( child ) => {

		const mesh = child as Mesh;

		if ( mesh.isMesh !== true ) return;

		mesh.geometry.computeBoundingBox();
		part.copy( mesh.geometry.boundingBox! );
		part.applyMatrix4( transform.multiplyMatrices( toLocal, mesh.matrixWorld ) );
		bounds.union( part );

	} );

	return bounds.min.y;

}

/**
 * Picks the quill up off the desk while the player draws and puts it back down
 * when they stop. The pen's own local +Y runs from nib to feather, so holding it
 * is just a rotation that maps +Y onto the writing angle, plus an offset that
 * keeps the nib on the point being drawn.
 */
export class Quill {

	private readonly restPosition = new Vector3();
	private readonly restQuaternion = new Quaternion();

	// Leaned well out to the right, the way a right-hander holds a pen: held
	// upright it stands between the camera and the page and hides the very
	// strokes being drawn.
	private readonly heldDirection = new Vector3( 0.62, 0.72, 0.31 ).normalize();
	private readonly heldQuaternion = new Quaternion();

	private readonly desired = new Vector3();

	/** Where the writing tip sits along the quill's own axis. */
	private readonly tipOffset: number;

	constructor( private readonly pen: Object3D ) {

		this.restPosition.copy( pen.position );
		this.restQuaternion.copy( pen.quaternion );
		this.heldQuaternion.setFromUnitVectors( UP, this.heldDirection );
		this.tipOffset = measureTip( pen );

	}

	/** Re-aims the writing pose. Live-tunable from the dev console. */
	setHeldDirection( x: number, y: number, z: number ): void {

		this.heldDirection.set( x, y, z ).normalize();
		this.heldQuaternion.setFromUnitVectors( UP, this.heldDirection );

	}

	/**
	 * @param point Where the nib should be, or null to lay the quill back down.
	 * @param writing Whether the nib is actually laying ink. False keeps the quill
	 * in hand but lifts it clear of the page — between the strokes of one sigil,
	 * and through the stillness before it casts, the pen is held, not writing.
	 */
	update( point: Vector3 | null, dt: number, writing = true ): void {

		if ( point === null ) {

			const settle = Math.min( 1, dt * SETTLE_RATE );

			this.pen.position.lerp( this.restPosition, settle );
			this.pen.quaternion.slerp( this.restQuaternion, settle );
			return;

		}

		const blend = Math.min( 1, dt * ( writing ? FOLLOW_RATE : CARRY_RATE ) );

		// Just off the page while writing, so the nib does not z-fight the sheet;
		// a centimetre clear of it while merely held, which is the whole difference
		// between a pen in use and a pen waiting.
		const lift = writing ? 0.004 : 0.012;

		this.desired.copy( point ).addScaledVector( this.heldDirection, - this.tipOffset ).addScaledVector( UP, lift );

		this.pen.position.lerp( this.desired, blend );

		// The angle never has to chase anything — it is the same writing pose the
		// whole time — so it keeps the gentler rate and the pen turns into the grip
		// rather than snapping into it.
		this.pen.quaternion.slerp( this.heldQuaternion, Math.min( 1, dt * SETTLE_RATE ) );

	}

}
