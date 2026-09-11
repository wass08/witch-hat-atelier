/**
 * $P Point-Cloud Recognizer — Vatavu, Anthony & Wobbrock (ICMI 2012).
 *
 * A multistroke gesture recognizer that needs no training: a gesture is just a
 * cloud of points, matched greedily against template clouds after resampling,
 * scaling and translating to a canonical form. Stroke count, stroke order and
 * stroke direction are all irrelevant, which is exactly what you want when the
 * player scratches a sigil onto parchment with a quill.
 */

export interface StrokePoint {
	x: number;
	y: number;
	/** Index of the stroke this point belongs to. */
	id: number;
}

export interface Template {
	name: string;
	points: StrokePoint[];
	/** The un-rotated original. Live preview only matches against these. */
	canonical?: boolean;
}

export interface Match {
	name: string | null;
	score: number;
	/** Raw $P cloud distance — lower is better, ~0 is a perfect trace. */
	distance: number;
}

/**
 * How coarsely a sigil is re-sampled before matching — the single most important
 * knob for tolerating a hand-drawn shape, and worth more than any amount of extra
 * templates.
 *
 * Coarser sampling averages out local wobble, so one over-long limb stops
 * dominating the total, while the one-to-one point pairing that gives $P its
 * discrimination is untouched. Measured on a real (imperfect) hand-drawn star,
 * against a set of deliberately sloppy attempts and random scribbles:
 *
 *   N=32  that star 0.31 · genuine attempts 0.43–0.62 · scribbles up to 0.34
 *   N=24  that star 0.55 · genuine attempts 0.54–0.74 · scribbles up to 0.50
 *   N=20  that star 0.61 · genuine attempts 0.67–0.74 · scribbles up to 0.65
 *
 * 24 is the knee: below it, scribbles start scoring like sigils.
 */
const NUM_POINTS = 24;

export function normalize( points: StrokePoint[], numPoints = NUM_POINTS ): StrokePoint[] {

	return translateToOrigin( scaleToUnit( resample( points, numPoints ) ) );

}

/** Builds a template from raw (already stroke-tagged) sample points. */
export function makeTemplate( name: string, points: StrokePoint[] ): Template {

	return { name, points: normalize( points ) };

}

/** Rotated copies of a template, so a slightly tilted sigil still reads. */
export function withRotations( template: Template, degrees: number[] ): Template[] {

	return degrees.map( ( deg ) => ( {
		name: template.name,
		points: translateToOrigin( rotateBy( template.points, ( deg * Math.PI ) / 180 ) ),
		canonical: deg === 0,
	} ) );

}

export class Recognizer {

	private templates: Template[] = [];

	add( ...templates: Template[] ): this {

		this.templates.push( ...templates );
		return this;

	}

	/**
	 * @param quick Match only the un-rotated templates. Roughly five times cheaper,
	 * which is what makes it affordable to re-read the page on every stroke; the
	 * cost is a little less tolerance for a tilted sigil.
	 */
	recognize( points: StrokePoint[], quick = false ): Match {

		if ( points.length < 8 ) return { name: null, score: 0, distance: Infinity };

		const candidate = normalize( points );

		let best = Infinity;
		let bestName: string | null = null;

		for ( const template of this.templates ) {

			if ( quick && template.canonical !== true ) continue;

			const d = greedyCloudMatch( candidate, template.points );

			if ( d < best ) {

				best = d;
				bestName = template.name;

			}

		}

		// The canonical $P confidence mapping for unit-box normalised clouds.
		const score = bestName === null ? 0 : Math.max( ( best - 2.0 ) / - 2.0, 0 );

		return { name: bestName, score, distance: best };

	}

}

function greedyCloudMatch( points: StrokePoint[], template: StrokePoint[] ): number {

	const step = Math.floor( Math.pow( points.length, 0.5 ) ); // n^(1-e), e = 0.5
	let min = Infinity;

	for ( let i = 0; i < points.length; i += step ) {

		min = Math.min( min, cloudDistance( points, template, i ), cloudDistance( template, points, i ) );

	}

	return min;

}

function cloudDistance( a: StrokePoint[], b: StrokePoint[], start: number ): number {

	const matched = new Array<boolean>( a.length ).fill( false );
	let sum = 0;
	let i = start;

	do {

		let index = - 1;
		let min = Infinity;

		for ( let j = 0; j < b.length; j ++ ) {

			if ( matched[ j ] ) continue;

			const d = distance( a[ i ], b[ j ] );

			if ( d < min ) {

				min = d;
				index = j;

			}

		}

		if ( index >= 0 ) matched[ index ] = true;

		// Points near the start of the walk carry more weight.
		sum += ( 1 - ( ( i - start + a.length ) % a.length ) / a.length ) * min;
		i = ( i + 1 ) % a.length;

	} while ( i !== start );

	return sum;

}

function resample( points: StrokePoint[], n: number ): StrokePoint[] {

	const interval = pathLength( points ) / ( n - 1 );
	let accumulated = 0;

	const source = points.map( ( p ) => ( { ...p } ) );
	const out: StrokePoint[] = [ { ...source[ 0 ] } ];

	for ( let i = 1; i < source.length; i ++ ) {

		// Never interpolate across a pen lift.
		if ( source[ i ].id !== source[ i - 1 ].id ) {

			out.push( { ...source[ i ] } );
			continue;

		}

		const d = distance( source[ i - 1 ], source[ i ] );

		if ( accumulated + d >= interval ) {

			const t = ( interval - accumulated ) / d;
			const q: StrokePoint = {
				x: source[ i - 1 ].x + t * ( source[ i ].x - source[ i - 1 ].x ),
				y: source[ i - 1 ].y + t * ( source[ i ].y - source[ i - 1 ].y ),
				id: source[ i ].id,
			};

			out.push( q );
			source.splice( i, 0, { ...q } );
			accumulated = 0;

		} else {

			accumulated += d;

		}

	}

	while ( out.length < n ) out.push( { ...source[ source.length - 1 ] } );

	return out.slice( 0, n );

}

function scaleToUnit( points: StrokePoint[] ): StrokePoint[] {

	let minX = Infinity, minY = Infinity, maxX = - Infinity, maxY = - Infinity;

	for ( const p of points ) {

		minX = Math.min( minX, p.x );
		minY = Math.min( minY, p.y );
		maxX = Math.max( maxX, p.x );
		maxY = Math.max( maxY, p.y );

	}

	// Uniform scale keeps the aspect ratio, so a squashed circle stays an ellipse.
	const size = Math.max( maxX - minX, maxY - minY ) || 1;

	return points.map( ( p ) => ( { x: ( p.x - minX ) / size, y: ( p.y - minY ) / size, id: p.id } ) );

}

function translateToOrigin( points: StrokePoint[] ): StrokePoint[] {

	let cx = 0, cy = 0;

	for ( const p of points ) {

		cx += p.x;
		cy += p.y;

	}

	cx /= points.length;
	cy /= points.length;

	return points.map( ( p ) => ( { x: p.x - cx, y: p.y - cy, id: p.id } ) );

}

function rotateBy( points: StrokePoint[], radians: number ): StrokePoint[] {

	const c = Math.cos( radians );
	const s = Math.sin( radians );

	return points.map( ( p ) => ( { x: p.x * c - p.y * s, y: p.x * s + p.y * c, id: p.id } ) );

}

function pathLength( points: StrokePoint[] ): number {

	let d = 0;

	for ( let i = 1; i < points.length; i ++ ) {

		if ( points[ i ].id === points[ i - 1 ].id ) d += distance( points[ i - 1 ], points[ i ] );

	}

	return d;

}

function distance( a: StrokePoint, b: StrokePoint ): number {

	return Math.hypot( a.x - b.x, a.y - b.y );

}
