import { Object3D, Quaternion, Vector3 } from 'three/webgpu';

/** How a particular spell rocks the thing it lands on. */
export interface Jolt {
	/** Peak tilt, in radians. */
	amplitude: number;
	/** How fast it rocks, in radians per second. */
	frequency: number;
	/** How fast it gives up, per second. */
	damping: number;
}

/**
 * A shove. The fireball is heavy and slow, and the dummy takes a moment over it.
 *
 * Sized against what it competes with rather than against physics. The first pass
 * was 4.5°, which is a real movement — 17 cm at the top of the post — and still
 * went unseen, because its peak lands 83 ms after the blast, in the middle of the
 * brightest part of an explosion happening at that exact spot. A recoil has to
 * outlast the thing that caused it to register at all, so this one is twice the
 * angle and rings for half again as long: it is still going when the light has
 * gone.
 */
export const FIREBALL_JOLT: Jolt = { amplitude: 0.2, frequency: 9.5, damping: 2.2 };

/**
 * A crack. Sharper and faster than the fireball's shove, and it rings rather than
 * rolls — but not *small*. It has worse luck than the fireball: the bolt lands the
 * instant the sigil resolves, while the camera is still swinging back from the
 * parchment, so for the first half second the whole frame is moving and a small
 * tilt is invisible inside that. It has to still be going when the camera settles.
 */
export const LIGHTNING_JOLT: Jolt = { amplitude: 0.155, frequency: 15, damping: 3 };

/**
 * The floor waking under it — not a hit at all, and the numbers say so.
 *
 * The other two are impacts: something arrived, the post took it, and it rang
 * fast and stopped. The rune is a six-metre carving spinning up in the flagstones
 * two metres from the dummy's feet, and the right reading is the *ground* moving
 * rather than the straw being struck. So this is a third of the fireball's angle,
 * at half its frequency, damped half as hard: a slow sway that arrives with the
 * pillars and is still going a couple of seconds later, when the circle is at
 * full charge.
 *
 * Low frequency is what carries the difference. At 9.5 a 4° tilt reads as a
 * flinch; at 4.5 the same 4° reads as weight shifting under it — which is why the
 * amplitude is the only thing that moved when this needed to hit harder. 0.07 gave
 * a 2.5° peak, which is about what a draught would do to a post standing in a
 * weighted base; 0.125 gives 4.5°, enough that the crossbar visibly swings, and
 * the damping is eased to 1.0 so it is still going when the pillars reach full
 * height. Raising the frequency instead would have bought the same angle and lost
 * the whole point of it.
 */
export const RUNE_JOLT: Jolt = { amplitude: 0.125, frequency: 4.5, damping: 1.0 };

/**
 * How near a hit has to land before the dummy feels it. A ward standing over the
 * dummy bursts the shot on its own shell, and its smallest dome is 0.85 m across
 * the centre, so this comfortably tells "hit the straw" from "hit the ward".
 */
const REACH = 0.7;

/** Below this the rocking is not worth a matrix update; the dummy is set upright. */
const SETTLED = 0.02;

/**
 * Rocks the training dummy when a spell lands on it.
 *
 * It is a post standing in a weighted base, so it tips rather than slides: the
 * whole thing pivots about its own origin, which the asset conveniently puts on
 * the floor at the foot of the post. A damped sine does the rest — one shove,
 * then a few decreasing swings back through upright.
 *
 * The dummy tips *away* from whatever hit it. A rotation about a horizontal axis
 * `A` moves the top of the post along `A × up`, so tipping away from an impact
 * means `A = push × up`, where `push` is the horizontal direction from the post's
 * foot out towards the point of impact.
 */
export class Recoil {

	private readonly rest = new Quaternion();
	private readonly pivot = new Vector3();
	private readonly axis = new Vector3( 1, 0, 0 );
	private readonly push = new Vector3();
	private readonly spin = new Quaternion();

	private jolt: Jolt | null = null;
	private elapsed = 0;

	constructor( private readonly dummy: Object3D, private readonly centre: Vector3 ) {

		this.rest.copy( dummy.quaternion );
		dummy.getWorldPosition( this.pivot );

	}

	/** True while it is still moving, so a caller can hold off on re-aiming. */
	get active(): boolean {

		return this.jolt !== null;

	}

	/**
	 * Takes a hit at a world point. Anything landing wide of the dummy — a shot
	 * the ward ate, most obviously — is ignored, so this can be wired straight to
	 * a spell's impact without the spell having to know what it struck.
	 */
	hit( at: Vector3, jolt: Jolt ): void {

		if ( at.distanceTo( this.centre ) > REACH ) return;

		this.push.copy( at ).sub( this.pivot );
		this.push.y = 0;

		// A shot straight down the post's own axis has no direction to tip along;
		// keep whatever axis the last one used rather than dividing by nothing.
		if ( this.push.lengthSq() > 1e-6 ) {

			this.axis.copy( this.push ).normalize().cross( UP ).normalize();

		}

		this.jolt = jolt;
		this.elapsed = 0;

	}

	update( dt: number ): void {

		if ( this.jolt === null ) return;

		this.elapsed += dt;

		const decay = Math.exp( - this.elapsed * this.jolt.damping );

		if ( decay < SETTLED ) {

			this.jolt = null;
			this.dummy.quaternion.copy( this.rest );
			return;

		}

		const angle = this.jolt.amplitude * decay * Math.sin( this.elapsed * this.jolt.frequency );

		this.spin.setFromAxisAngle( this.axis, angle );

		// The axis is in world space and the dummy's parent carries no transform of
		// its own, so the shove goes on before the asset's own orientation.
		this.dummy.quaternion.copy( this.rest ).premultiply( this.spin );

	}

}

const UP = new Vector3( 0, 1, 0 );
