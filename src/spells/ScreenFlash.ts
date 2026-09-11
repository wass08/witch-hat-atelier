import { Color } from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';

/**
 * A full-frame additive flash, mixed into the pipeline's output node. It is added
 * before the output colour transform so a hard strike rolls off through tone
 * mapping instead of clipping to a white rectangle.
 */
export class ScreenFlash {

	private amount = 0;

	private readonly uAmount = uniform( 0 );
	private readonly uColor = uniform( new Color( 0xffffff ) );

	/** Add this to the pipeline's `outputNode`. */
	readonly node = vec3( this.uColor.mul( this.uAmount ) );

	pulse( hex: number, strength: number ): void {

		this.uColor.value.setHex( hex );
		this.amount = Math.max( this.amount, strength );

	}

	update( dt: number ): void {

		if ( this.amount <= 0 ) return;

		this.amount *= Math.exp( - dt * 11 );

		if ( this.amount < 0.002 ) this.amount = 0;

		this.uAmount.value = this.amount;

	}

}
