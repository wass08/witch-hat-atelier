import { Color, MeshPhysicalNodeMaterial } from 'three/webgpu';
import {
	Fn,
	Loop,
	bumpMap,
	cameraPosition,
	clamp,
	color,
	dot,
	float,
	mix,
	modelWorldMatrixInverse,
	mx_fractal_noise_float,
	mx_noise_float,
	normalView,
	normalize,
	positionLocal,
	positionViewDirection,
	pow,
	saturate,
	smoothstep,
	time,
	uniform,
	vec3,
	vec4,
	viewportSharedTexture,
	viewportUV,
} from 'three/tsl';

/**
 * Refractive glass built on the viewport texture rather than on `transmission`.
 *
 * `MeshPhysicalMaterial.transmission` renders the scene into its own pass and
 * samples that, which has one consequence that decides everything: the pass does
 * not contain the transmissive objects themselves, so glass cannot see other
 * glass, and a bottle standing behind a bottle simply is not there. It is also a
 * whole extra render of the scene.
 *
 * `viewportSharedTexture` samples what has *already been drawn to the frame* this
 * pass. Draw the glass after the opaques, transparent and sorted back-to-front,
 * and each piece reads everything painted before it — including the glass in
 * front of which it stands. That is the same route three's own `webgpu_backdrop`
 * examples take, and it is what the reference this was modelled on is built from.
 *
 * `backdropNode` is the hook. `NodeMaterial` substitutes it for the outgoing
 * light *inside* the lighting context, so the surface keeps its own specular and
 * Fresnel on top of whatever the backdrop supplies — the refraction replaces what
 * shows through the body, not the highlights sitting on it.
 *
 * ---
 *
 * **The refraction is screen-space and therefore an approximation.** The lookup
 * is displaced by the surface's view-space normal, which is the standard cheat:
 * it bends most where the surface turns away from the eye, which is where real
 * refraction bends most, and it costs one texture fetch per channel instead of a
 * ray march. What it cannot do is bend towards something off-screen, so a wide
 * `strength` will smear the frame edges. That is the trade the technique makes.
 *
 * **Dispersion is three fetches at three displacements.** Red, green and blue
 * take slightly different paths, which is what fringes a rim in rainbow rather
 * than in grey. It is the single strongest cue that a surface is glass and not
 * merely shiny, and it is the reason this reads as glass where `transmission`
 * quietly did not.
 */
export interface GlassOptions {
	/**
	 * How far the lookup is displaced, in screen widths at a full side-on normal.
	 *
	 * Small. At a bottle's size on screen, past about 0.06 the body stops reading
	 * as something you are looking *through* and starts reading as a smear.
	 */
	strength?: number;
	/**
	 * Spread between the red and blue lookups, as a fraction of `strength`.
	 *
	 * **Off, and it should stay off unless something changes.** The reference this
	 * was taken from pairs a dispersion of 5 with an IOR of 1.03 and it works there
	 * because the whole scene is built around it — a bright checkerboard environment
	 * and glass as the only subject. Dropped into this room it is the only surface
	 * in it that splits colour, so instead of reading as an optical property it
	 * reads as a rendering fault: red and cyan edges along the cork thread and the
	 * highlight rim, on one object, with nothing else in the frame doing anything
	 * like it. Cutting it from 1.6 to 0.1 was not enough; the fringe survived at any
	 * strength that did anything at all.
	 *
	 * `Bottle001` is the argument. It is the one bottle nobody has complained about
	 * and it has no dispersion, `roughness` 0.3 and plain transmission.
	 */
	dispersion?: number;
	/** The draught, multiplied into whatever shows through the body. */
	tint?: number;
	/** How strongly the tint takes over from the plain refraction, 0..1. */
	density?: number;
	/** A lit core, for a bottle standing in a room with nothing bright behind it. */
	glow?: number;
	glowStrength?: number;
	/**
	 * Surface roughness.
	 *
	 * Was 0.04, which is not glass — it is a mirror. Nineteen of the room's
	 * sixty-two lights reach these bottles, and at that roughness every one of them
	 * is a pinpoint, so only the brightest ever resolves into anything: one hard
	 * white streak and no evidence of the other eighteen. Widening the lobe is what
	 * lets the candle, the cauldron and the two potion lamps each leave their own
	 * soft highlight. Real bottle glass is not optically flat anyway.
	 *
	 * 0.3 is not a guess: it is what `Bottle001` carries, which is the one bottle in
	 * the room whose glass reads correctly — soft rolled highlight, no hard streak.
	 * 0.19 was still glossy enough to keep a hard edge on the highlight low on the
	 * body while the neck's tighter curvature rolled it. Matching the reference
	 * removes the top-to-bottom disagreement as well as the streak.
	 */
	roughness?: number;
	/**
	 * Index of refraction, and how hard the specular lobe hits.
	 *
	 * `MeshPhysical` defaults to 1.5 at full `specularIntensity`, which on a
	 * near-black body under a bright lamp clips the highlight to white before the
	 * tone map ever sees it — there is no colour left in it to roll off. Backing
	 * both off a little keeps the highlight inside the range AgX can shape.
	 */
	ior?: number;
	specular?: number;
	/**
	 * Amplitude of a procedural surface bump, in normal-perturbation units.
	 *
	 * Hand-blown glass is not flat, and a perfectly flat surface is the strongest
	 * single tell that something is CG: every highlight on it is the same clean
	 * shape. A little noise breaks each one differently. No texture is fetched —
	 * this is `mx_noise_float` on the local position, the same route `BookCovers`
	 * takes for the tomes' leather.
	 */
	bump?: number;
	/** Spatial frequency of that bump, in inverse local units. */
	bumpScale?: number;
	/** Fresnel lift at the silhouette. */
	rim?: number;
	/** Fills the bottle with slow smoke. Omit for plain glass. */
	smoke?: SmokeOptions;
	/**
	 * Local Y the liquid surface sits at, and how bright the liquid itself burns.
	 *
	 * Two things at once, and they are the same feature. A bottle is not full: the
	 * draught stops short of the neck, and the line where it stops is the strongest
	 * single cue that there is a *liquid* in there rather than tinted glass. Below
	 * it the body carries the tint and the glow; above it the glass runs clear.
	 *
	 * The glow matters separately. Under this room's cool ambient a merely tinted
	 * bottle settles into the same purple-grey value as the wall behind it; lighting
	 * the liquid from within is what pushes it back out. See `Potions.ts` for what
	 * the amber one needs to hold its own against that tint.
	 */
	fill?: number;
	fillGlow?: number;
	/** Width of the meniscus band, in local units. */
	meniscus?: number;
	/**
	 * How much more light the empty glass above the liquid passes, as a fraction.
	 *
	 * Empty glass transmits more than tinted liquid, so without this the headspace
	 * is the darkest part of the bottle and the thing splits visually into two
	 * stacked objects: near-black glass on top, lit draught underneath. Small — this
	 * is a lift on an already-dark refraction, not a light source. At 0.55 the empty
	 * glass came out *brighter* than the draught below it, which inverts the reading:
	 * the eye takes the lit part for the liquid, so the bottle looked full of air.
	 */
	headspace?: number;
}

/**
 * Smoke inside the bottle, as a short march through its own local space.
 *
 * Not a surface pattern. A noise sampled on the shell would slide across the
 * glass as the camera moves, which reads as a decal on the outside — the giveaway
 * that there is nothing in there. Marching inward from the surface along the view
 * ray and accumulating density gives parallax: the near wall and the far wall
 * disagree about where the smoke is, which is the whole reason it looks like a
 * volume.
 *
 * It is deliberately a *fixed* march rather than a bounded one. There is no
 * intersection test against the bottle's interior, because the bottles are small
 * and roughly convex and `depth` covers one — the march simply walks a set
 * distance and stops. A concave vessel would leak, and none of these are.
 *
 * The reference for the look is `supah.it/blob`: very soft, very low contrast,
 * turning slowly enough that you are never quite sure it moved. Everything here
 * is tuned away from "particles" and towards that.
 */
/**
 * The live knobs, hung on the material so a look can be tuned from the console
 * without a reload — reach them through the mesh's `material.userData.glass`.
 */
export interface GlassControls {
	strength: ReturnType<typeof uniform>;
	dispersion: ReturnType<typeof uniform>;
	density: ReturnType<typeof uniform>;
	rim: ReturnType<typeof uniform>;
}

export interface SmokeOptions {
	/**
	 * The wisp's tint. One colour per bottle, and it is derived from the liquid's
	 * own hue by {@link vapourOf} rather than chosen — smoke rising off a draught
	 * is that draught, thinner. Three separate hues in one bottle read as three
	 * separate substances, which is what the chromatic split was accidentally doing.
	 */
	colour: number;
	/** How opaque the thickest part of a wisp gets, 0..1. */
	density?: number;
	/** Noise frequency for the silhouette, in inverse local units. */
	scale?: number;
	/** Upward drift per second, in local units. Slow — this is trapped smoke. */
	rise?: number;
	/** How fast the field deforms under itself. */
	churn?: number;
	/** Local units marched inward. About one bottle across. */
	depth?: number;
	/** March steps. Each is two noise fetches, so this is the cost knob. */
	steps?: number;
	/** Multiplier on the tint. Above 1 is HDR and will bloom. */
	brightness?: number;
	/**
	 * How much of the noise counts as empty, 0..1 — the wisp count knob.
	 *
	 * High. Only the top of the noise survives, so what is left is two or three
	 * separate billows with clear glass between them rather than a filled bottle.
	 */
	clearing?: number;
	/**
	 * Width of the threshold, in noise units.
	 *
	 * The difference between a wisp and a thread. Cutting the noise at a hard edge
	 * gives a silhouette as sharp as the noise itself, which at these frequencies
	 * is a filament; fading across a wide band diffuses the edge into vapour. This
	 * is the blur, and it is done on the *threshold* rather than by blurring the
	 * noise, which would cost more fetches for the same result.
	 */
	softness?: number;
	/**
	 * Local radius of the vessel, for the containment falloff.
	 *
	 * Smoke in a bottle is denser through the middle and thins towards the glass,
	 * because there is more of it along a ray through the centre. Without this the
	 * density is flat to the silhouette and the whole thing reads as a pattern
	 * printed on the outside of the bottle.
	 */
	radius: number;
	/**
	 * Slow currents turning *inside* the draught, below the fill line. 0 is off.
	 *
	 * A separate feature from the vapour above the line, and it has to be: convection
	 * in a liquid and smoke in air do not look alike. Run at the vapour's frequency
	 * it reads as grit suspended in the potion, so `currentScale` is a fraction of
	 * `scale` and the drift is slower again — what you want is a few slow bodies of
	 * colour turning over, not a cloud.
	 */
	currents?: number;
	currentScale?: number;
	/** Local Y the liquid surface sits at — vapour above it, currents below. */
	fill: number;
	/** Local Y of the top of the airspace, for the fade along a wisp's length. */
	ceiling: number;
}

/**
 * The vapour a given draught gives off: the same hue, lifted and drained.
 *
 * Derived rather than picked so a bottle cannot end up with smoke that belongs to
 * a different potion. Lightening alone would read as fog lit by the liquid;
 * pulling saturation down as well is what makes it read as the substance itself
 * having thinned out.
 */
export function vapourOf( liquid: number ): number {

	const hsl = { h: 0, s: 0, l: 0 };

	new Color( liquid ).getHSL( hsl );

	return new Color().setHSL( hsl.h, hsl.s * 0.42, Math.min( 0.86, hsl.l * 0.55 + 0.5 ) ).getHex();

}

export function buildGlass( options: GlassOptions = {} ): MeshPhysicalNodeMaterial {

	const {
		strength = 0.055,
		dispersion = 0,
		tint = 0xffffff,
		density = 0.5,
		glow = 0x000000,
		glowStrength = 0,
		roughness = 0.3,
		ior = 1.45,
		specular = 0.62,
		bump = 0.012,
		bumpScale = 190,
		rim = 0.45,
		smoke,
		fill,
		fillGlow = 0,
		meniscus = 0.006,
		headspace = 0.28,
	} = options;

	const material = new MeshPhysicalNodeMaterial();

	// Transparent so it is drawn in the sorted pass, after the opaque scene has
	// been laid down — which is precisely what makes there be a frame to sample.
	material.transparent = true;
	material.metalness = 0;
	material.roughness = roughness;
	material.ior = ior;
	material.specularIntensity = specular;
	material.color = new Color( 0xffffff );

	// Surface imperfection. Fine and shallow — enough to break each highlight into
	// its own shape, not enough to read as frosting. It perturbs `normalView`, so
	// the refraction below wobbles with the glass rather than sliding over a
	// perfectly smooth surface underneath it.
	if ( bump > 0 ) {

		material.normalNode = bumpMap( mx_noise_float( positionLocal.mul( bumpScale ) ), float( bump ) );

	}

	// No `transmission`. It would add its own pass and fight this one for the same
	// job; everything the body shows comes from `backdropNode` below.
	material.transmission = 0;

	const uStrength = uniform( strength );
	const uDispersion = uniform( dispersion );
	const uDensity = uniform( density );
	const uRim = uniform( rim );

	// The bend. `normalView.xy` is zero facing the eye and grows towards the
	// silhouette, so the middle of a bottle is nearly undistorted and the shoulders
	// carry the refraction — which is how a real cylinder of glass behaves.
	const bend = normalView.xy.mul( uStrength );

	const spread = uDispersion.mul( uStrength );

	// Three fetches, three displacements. Green rides the true bend; red goes
	// slightly further and blue slightly less, so the split widens with the bend
	// and vanishes where the surface faces the eye — the fringe is on the rim,
	// exactly where dispersion actually shows.
	const red = viewportSharedTexture( viewportUV.add( bend.add( normalView.xy.mul( spread ) ) ) ).r;
	const green = viewportSharedTexture( viewportUV.add( bend ) ).g;
	const blue = viewportSharedTexture( viewportUV.add( bend.sub( normalView.xy.mul( spread ) ) ) ).b;

	const refracted = vec3( red, green, blue );

	// Where the draught is. 1 inside the liquid, 0 in the headspace above it, with
	// the meniscus as the transition — one mask, and everything that belongs to the
	// liquid rather than to the bottle keys off it.
	const surface = fill === undefined
		? float( 1 )
		: smoothstep( float( fill ).add( meniscus ), float( fill ).sub( meniscus ), positionLocal.y );

	// The draught. Multiplied rather than mixed towards, so what shows through is
	// the room seen *through* a coloured liquid instead of the liquid painted over
	// the room — the difference is whether a bright thing behind stays bright.
	const liquid = refracted.mul( color( tint ) );
	const tinted = mix( refracted, liquid, uDensity );

	// …and only below the line. Tinting the whole bottle was wrong twice over: the
	// headspace is empty glass and has no draught to tint, and multiplying a dark
	// refracted room by a saturated hue drove it to near-black. The result read as
	// two disconnected objects stacked on each other — dark glass on top, lit liquid
	// underneath — rather than as one bottle. Empty glass also passes more light
	// than tinted liquid does, hence the lift.
	const clear = refracted.mul( float( 1 ).add( headspace ) );
	const body = mix( clear, tinted, surface );

	const filled = smoke === undefined ? body : Fn( () => {

		const {
			colour,
			density = 0.7,
			scale = 16,
			rise = 0.012,
			churn = 0.05,
			depth = 0.14,
			steps = 8,
			brightness = 1,
			clearing = 0.62,
			softness = 0.3,
			currents = 0,
			currentScale = 9,
			radius,
			fill: smokeFill,
			ceiling,
		} = smoke;

		// The eye, in the bottle's own space. Everything below is local, so the
		// smoke belongs to the bottle and travels with it.
		const eye = modelWorldMatrixInverse.mul( vec4( cameraPosition, 1 ) ).xyz;
		const ray = normalize( positionLocal.sub( eye ) );

		const march = float( depth / steps );
		const walk = positionLocal.toVar();
		const gathered = float( 0 ).toVar();
		const stirred = float( 0 ).toVar();

		Loop( steps, () => {

			// Rising is a *downward* shift of the sample point: pull the field down
			// past a fixed bottle and the smoke inside appears to climb.
			const drift = vec3( 0, time.mul( - rise * scale ), 0 );
			const at = walk.mul( scale ).add( drift ).add( time.mul( churn ) );

			// The silhouette. Two octaves, and the threshold is *faded* across
			// `softness` rather than cut — a hard cut at this frequency gives an edge
			// as sharp as the noise, which reads as a filament rather than as vapour.
			const shape = smoothstep(
				float( clearing ),
				float( clearing + softness ),
				mx_fractal_noise_float( at, 2 ).mul( 0.5 ).add( 0.5 ),
			);

			// A second field at a different frequency and offset, multiplied in, so a
			// wisp varies in density along itself instead of being a constant-opacity
			// ribbon. One noise gives shape; it takes two to give substance.
			const varies = mx_fractal_noise_float( at.mul( 0.43 ).add( 19.7 ), 2 )
				.mul( 0.5 ).add( 0.5 ).mul( 0.85 ).add( 0.15 );

			// Contained. Denser through the middle, thinning towards the glass,
			// because there is more smoke along a ray through the centre. Without this
			// the density runs flat to the silhouette and the whole thing reads as a
			// pattern printed on the outside of the bottle.
			const offAxis = walk.xz.length().div( radius );
			const contained = smoothstep( 1.0, 0.25, offAxis );

			// Above the liquid only, and fading out towards the top of the airspace —
			// this is the falloff along a wisp's length. Without it a wisp is as solid
			// at its tip as at its root, which is the other half of reading as thread.
			const span = Math.max( 1e-4, ceiling - smokeFill );
			const up = walk.y.sub( float( smokeFill ) ).div( float( span ) );
			const along = smoothstep( 0.0, 0.22, up ).mul( smoothstep( 1.05, 0.45, up ) );

			gathered.addAssign( shape.mul( varies ).mul( contained ).mul( along ) );

			// Currents *inside* the draught, on their own much coarser field and much
			// slower drift. Vapour in a headspace and convection in a liquid do not
			// look alike: the same noise that gives loose wisps above the line gives
			// grit below it, so this runs at a fraction of the frequency and reads as
			// slow bodies of colour turning over rather than as smoke underwater.
			if ( currents > 0 ) {

				const slow = walk.mul( currentScale )
					.add( vec3( 0, time.mul( - rise * currentScale * 0.35 ), 0 ) )
					.add( time.mul( churn * 0.4 ) );

				const swell = smoothstep( 0.46, 0.86, mx_fractal_noise_float( slow, 2 ).mul( 0.5 ).add( 0.5 ) );
				const inside = smoothstep( float( smokeFill ).add( 0.004 ), float( smokeFill ).sub( 0.004 ), walk.y );

				stirred.addAssign( swell.mul( contained ).mul( inside ) );

			}

			walk.addAssign( ray.mul( march ) );

		} );

		const thickness = saturate( gathered.div( steps ).mul( density * 4.5 ) );
		const vapour = mix( body, color( colour ).mul( brightness ), thickness );

		if ( currents <= 0 ) return vapour;

		const stir = saturate( stirred.div( steps ).mul( currents * 4.5 ) );

		return mix( vapour, color( colour ).mul( brightness * 0.72 ), stir );

	} )();

	// A Fresnel lift at the silhouette. Thick glass gathers light along the long
	// path through its own wall at grazing angles, and without it the edge of a
	// bottle reads as a hole rather than as a rim.
	const facing = clamp( dot( normalView, positionViewDirection ), 0, 1 );
	const edge = pow( float( 1 ).sub( facing ), 3.2 );

	const lit = filled.add( filled.mul( edge.mul( uRim ) ) );

	material.backdropNode = fill === undefined ? lit : ( () => {

		// Weighted towards the middle of the body, and this is what stops the liquid
		// reading as rubber. Added flat, the glow is the same value over the whole
		// draught regardless of which way the surface turns — it swamps the shading
		// that gives the lower two-thirds its form, so the base goes smooth and
		// plasticky while the neck, which is too small to hold much of it, still
		// reads as glass. Weighting by how squarely the surface faces the eye is also
		// the physical answer: a cylinder of liquid is deepest through its middle.
		const throughLiquid = pow( facing, 0.55 );

		const draught = lit.add( color( tint ).mul( fillGlow ).mul( surface ).mul( throughLiquid ) );

		// A little of that light carried up into the empty glass, falling off with
		// height. Physically it is the draught lighting its own headspace; what it is
		// really for is continuity — the top and bottom of the bottle stop reading as
		// two separate objects when something connects them.
		const above = positionLocal.y.sub( fill ).max( 0 ).mul( 6 );
		const carried = color( tint )
			.mul( fillGlow * 0.3 )
			.mul( surface.oneMinus() )
			.mul( smoothstep( 1.0, 0.0, above ) );

		const band = smoothstep( meniscus * 2.2, 0, positionLocal.y.sub( fill ).abs() );
		const whole = draught.add( carried );

		return whole.add( whole.mul( band.mul( 0.9 ) ) );

	} )();

	if ( glowStrength > 0 ) {

		material.emissive = new Color( glow );
		material.emissiveIntensity = glowStrength;

	}

	material.userData.glass = {
		strength: uStrength,
		dispersion: uDispersion,
		density: uDensity,
		rim: uRim,
	} satisfies GlassControls;

	return material;

}
