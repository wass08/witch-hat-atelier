import { Recognizer, makeTemplate, withRotations, type StrokePoint, type Template } from './pdollar';

/**
 * The sigil vocabulary. Templates are generated parametrically rather than
 * recorded by hand so they are exact, and they live in the same y-down unit
 * space that `InkSurface` reports stroke points in.
 *
 * To teach a new sigil: add a polyline here and bind its name in `spells/registry.ts`.
 */

type Polyline = [ number, number ][];

/** Densifies a polyline so $P's arc-length resample lands where you expect. */
function stroke( verts: Polyline, id: number, samplesPerSegment = 12 ): StrokePoint[] {

	const out: StrokePoint[] = [];

	for ( let i = 0; i < verts.length - 1; i ++ ) {

		const [ x0, y0 ] = verts[ i ];
		const [ x1, y1 ] = verts[ i + 1 ];

		for ( let s = 0; s < samplesPerSegment; s ++ ) {

			const t = s / samplesPerSegment;
			out.push( { x: x0 + ( x1 - x0 ) * t, y: y0 + ( y1 - y0 ) * t, id } );

		}

	}

	const last = verts[ verts.length - 1 ];
	out.push( { x: last[ 0 ], y: last[ 1 ], id } );

	return out;

}

function ring( turns: number, startRadius: number, endRadius: number, steps: number, id: number, wide = 1 ): StrokePoint[] {

	const out: StrokePoint[] = [];

	for ( let i = 0; i <= steps; i ++ ) {

		const t = i / steps;
		const a = - Math.PI / 2 + t * Math.PI * 2 * turns;
		const r = startRadius + ( endRadius - startRadius ) * t;
		out.push( { x: Math.cos( a ) * r * wide, y: Math.sin( a ) * r, id } );

	}

	return out;

}

/**
 * Five-pointed star, drawn in one continuous stroke, apex up. `wide` stretches
 * it horizontally, for the second exemplar — see the templates below.
 */
function pentagramVerts( wide = 1 ): Polyline {

	const verts: Polyline = [];

	for ( let i = 0; i <= 5; i ++ ) {

		// Step by two points around the circle to get the star chord order.
		const a = - Math.PI / 2 + ( ( i * 2 ) % 5 ) * ( ( Math.PI * 2 ) / 5 );
		verts.push( [ Math.cos( a ) * wide, Math.sin( a ) ] );

	}

	return verts;

}

function polygonVerts( sides: number, rotation = - Math.PI / 2, wide = 1 ): Polyline {

	const verts: Polyline = [];

	for ( let i = 0; i <= sides; i ++ ) {

		const a = rotation + ( i / sides ) * Math.PI * 2;
		verts.push( [ Math.cos( a ) * wide, Math.sin( a ) ] );

	}

	return verts;

}

/**
 * How far the second exemplar of each bound glyph is stretched sideways. Set a
 * little past the parchment's own 1.2x so the coverage runs out beyond where the
 * page leads you, rather than stopping exactly there.
 */
const WIDE = 1.32;

const RAW: Template[] = [
	// Every bound glyph is carried twice: once square, once stretched to WIDE.
	//
	// `scaleToUnit` scales uniformly, on purpose — it is what keeps a squashed
	// circle an ellipse rather than flattening it back into a ring. The price is
	// that proportion is part of the shape, so a star drawn wide genuinely does
	// not sit on a square exemplar. And the sheet pushes every player towards
	// exactly that: leaned in over the desk on a 16:9 display the parchment is
	// 1.2x wider than tall on screen, so a sigil drawn to fill the page comes out
	// that shape. Recognition happens in screen space, which is the right call for
	// other reasons, and this is its bill.
	//
	// Measured against a simulated hand, worst case over 1.0x / 1.2x / 1.35x wide,
	// 80 attempts at each — with the square exemplar alone, and then with both:
	//
	//              square only     both
	//   pentagram    80/80        80/80
	//   triangle      0/80        80/80
	//   circle       58/80        80/80
	//   bolt         54/80        80/80
	//
	// The triangle is the one that shows what this really was: at 1.35x it was not
	// merely scoring low, it was being *named* wrong in 74 of 80. The pentagram, by
	// contrast, was named right in 80 of 80 at every width and still refused to
	// cast — the score alone fell under the threshold, which reads to a player as
	// the game being broken rather than as a wobbly line.
	//
	// The reach very nearly is free. Judged against one fixed corpus of 300 random
	// walks, the square exemplars alone accept 0 of them at a peak score of 0.48;
	// with these, 1 of 300, peak 0.52. That is the whole bill — and it is the trade
	// this threshold was chosen to make, since a false accept casts a spell you did
	// not mean while a false reject reads as the game being broken. Real sigils sit
	// at a median of 0.65 to 0.86, so the headroom above a scribble is wider now
	// than it was, not narrower.
	//
	// A caret is also still read as a caret rather than as a wide triangle, which
	// is the collision the rotation slack was already chosen to avoid.
	makeTemplate( 'pentagram', stroke( pentagramVerts(), 0 ) ),
	makeTemplate( 'pentagram', stroke( pentagramVerts( WIDE ), 0 ) ),
	makeTemplate( 'triangle', stroke( polygonVerts( 3 ), 0 ) ),
	makeTemplate( 'triangle', stroke( polygonVerts( 3, - Math.PI / 2, WIDE ), 0 ) ),
	makeTemplate( 'square', stroke( polygonVerts( 4, - Math.PI / 4 ), 0 ) ),
	makeTemplate( 'circle', ring( 1, 1, 1, 48, 0 ) ),
	makeTemplate( 'circle', ring( 1, 1, 1, 48, 0, WIDE ) ),
	makeTemplate( 'spiral', ring( 2.5, 0.12, 1, 96, 0 ) ),
	// Two exemplars for the bolt, and the second one is not decoration.
	//
	// The first is the stylised zigzag the grimoire draws, whose return stroke
	// stops short of the left edge at ( -0.6, 0.2 ). The hint, though, says "a Z",
	// and a Z has square corners: its return stroke runs all the way to the bottom
	// left and its base is horizontal. Those are different enough shapes that a
	// cleanly drawn Z scored **26%** against the zigzag alone — barely half the
	// threshold — so the sigil the hint asks for was the one sigil that could not
	// be cast. $P takes as many exemplars per class as you like, so it gets both.
	makeTemplate( 'bolt', stroke( [ [ - 1, - 1 ], [ 1, - 1 ], [ - 0.6, 0.2 ], [ 1, 1 ] ], 0 ) ),
	makeTemplate( 'bolt', stroke( [ [ - 1, - 1 ], [ 1, - 1 ], [ - 1, 1 ], [ 1, 1 ] ], 0 ) ),

	// And a narrow one. A Z is a natural thing to draw narrow, and against a square
	// exemplar a tall thin one scored 49% — one point over the line, which is not a
	// margin. Its mirror, the wide Z, is covered by the pass above.
	makeTemplate( 'bolt', stroke( [ [ - 0.62, - 1 ], [ 0.62, - 1 ], [ - 0.62, 1 ], [ 0.62, 1 ] ], 0 ) ),
	makeTemplate( 'bolt', stroke( [ [ - WIDE, - 1 ], [ WIDE, - 1 ], [ - WIDE, 1 ], [ WIDE, 1 ] ], 0 ) ),
	makeTemplate( 'cross', [ ...stroke( [ [ 0, - 1 ], [ 0, 1 ] ], 0 ), ...stroke( [ [ - 1, 0 ], [ 1, 0 ] ], 1 ) ] ),
	makeTemplate( 'caret', stroke( [ [ - 1, 1 ], [ 0, - 1 ], [ 1, 1 ] ], 0 ) ),
];

// $P is deliberately not rotation invariant; a little slack keeps a hand-drawn
// sigil legible without letting a triangle become a caret.
const ROTATIONS = [ - 20, - 10, 0, 10, 20 ];

export function buildRecognizer(): Recognizer {

	const recognizer = new Recognizer();

	for ( const template of RAW ) recognizer.add( ...withRotations( template, ROTATIONS ) );

	return recognizer;

}

/**
 * Ink-space (0..1) sample points for a glyph — used by the dev demo hook and by
 * anything that wants to exercise the recognizer without a mouse.
 */
export function sampleGlyph( name: string, scale = 0.34, samplesPerSegment = 10 ): { x: number; y: number }[][] {

	const strokes = GLYPH_PREVIEW[ name ];

	if ( strokes === undefined ) throw new Error( `sampleGlyph: no polyline for "${ name }"` );

	// Dense polylines (circle, spiral) need no further subdivision.
	return strokes.map( ( line ) =>
		stroke( line, 0, line.length > 24 ? 1 : samplesPerSegment )
			.map( ( p ) => ( { x: 0.5 + p.x * scale, y: 0.5 + p.y * scale } ) ) );

}

/**
 * Polylines for every glyph, in the same y-down unit space: the HUD grimoire
 * draws from these, and `sampleGlyph` traces from them. Every glyph the
 * recognizer knows needs an entry, or `demo()` quietly draws nothing.
 */
export const GLYPH_PREVIEW: Record<string, Polyline[]> = {
	pentagram: [ pentagramVerts() ],
	triangle: [ polygonVerts( 3 ) ],
	square: [ polygonVerts( 4, - Math.PI / 4 ) ],
	circle: [ toPolyline( ring( 1, 1, 1, 48, 0 ) ) ],
	spiral: [ toPolyline( ring( 2.5, 0.12, 1, 96, 0 ) ) ],
	bolt: [ [ [ - 1, - 1 ], [ 1, - 1 ], [ - 0.6, 0.2 ], [ 1, 1 ] ] ],
	cross: [ [ [ 0, - 1 ], [ 0, 1 ] ], [ [ - 1, 0 ], [ 1, 0 ] ] ],
	caret: [ [ [ - 1, 1 ], [ 0, - 1 ], [ 1, 1 ] ] ],
};

function toPolyline( points: StrokePoint[] ): Polyline {

	return points.map( ( p ) => [ p.x, p.y ] as [ number, number ] );

}
