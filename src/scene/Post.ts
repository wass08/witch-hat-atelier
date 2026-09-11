import { PerspectiveCamera, RenderPipeline, Scene, UnsignedByteType, type Node, type WebGPURenderer } from 'three/webgpu';

type Vec3Node = Node<'vec3'>;
import { add, diffuseColor, float, mix, mrt, normalView, output, packNormalToRGB, pass, sample, screenUV, smoothstep, step, unpackRGBToNormal, vec2, vec3, vec4, velocity } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { GLOW_THRESHOLD } from './gbuffer';

/**
 * What the pipeline puts on screen. The last three are diagnostic — the point of
 * having them is that "the room looks murky" and "the AO is eating the room" are
 * very different problems and you cannot tell them apart from the combined image.
 */
export type PostView = 'combined' | 'plain' | 'ao' | 'gi';

export const POST_VIEWS: PostView[] = [ 'combined', 'plain', 'ao', 'gi' ];

/**
 * The framing darkness, and it is two separate falloffs because the room asks two
 * separate questions of it.
 *
 * **The ceiling.** There is no ceiling. Nothing is modelled above about 2.6 m, so
 * everything filling the top of frame is `scene.background` — one flat colour that
 * by construction cannot fall off with distance or angle, and a constant that
 * large reads as a lit surface rather than as space above the room. A radial
 * vignette is the wrong tool for it: centred anywhere near the middle of the
 * screen it takes barely a tenth off the top edge, and opened up far enough to
 * bite there it starts eating the corners of the parchment in the leaned-in
 * framing, which is the one surface that must stay evenly lit. So the top gets its
 * own vertical falloff, running from `CEILING_FROM` to the top of frame.
 *
 * **The corners.** Those do want a radial term, and a gentle one — enough to stop
 * the eye wandering out of frame, not enough to announce itself. Its centre sits
 * slightly low so it favours the desk, and its ellipse is wider than it is tall so
 * a wide window does not pull it onto the sheet.
 *
 * The two multiply, which is what makes the top corners the darkest part of the
 * image and leaves the lower middle — the parchment, in both framings — untouched.
 */
const VIGNETTE_CENTRE = [ 0.5, 0.45 ] as const;
const VIGNETTE_SHAPE = [ 1, 0.82 ] as const;
const VIGNETTE_INNER = 0.35;
const VIGNETTE_OUTER = 0.85;

/** How much of the image is left in the far corner, before the ceiling term. */
const VIGNETTE_FLOOR = 0.5;

/**
 * Where the sky starts going, in screen height, and what is left of it at the top.
 *
 * Lifted from 0.26 once `Sky.ts` gave the zenith a real gradient. This term was
 * put in when the sky was one flat colour and had no falloff of its own, so it
 * was faking one from the outside; with the dusk ramp behind it the darkness up
 * there has a source, and holding the old depth on top of it only dimmed the
 * stars to a quarter for nothing. The corner term is untouched — that one was
 * never standing in for anything.
 */
const CEILING_FROM = 0.62;
const CEILING_FLOOR = 0.5;

/**
 * Screen-space global illumination, temporal anti-aliasing and bloom.
 *
 * The atelier is lit almost entirely by small emissive sources — candle flames,
 * a boiling cauldron, spells — which is exactly the case direct lighting handles
 * worst: everything a candle does not point at falls to flat ambient. SSGI gets
 * that bounce back, so the desk picks up the cauldron's green and a fireball
 * throws light onto the walls it passes.
 *
 * The scene pass therefore has to write more than colour: SSGI needs depth and
 * normals, and TRAA needs velocity, so the pass runs with an MRT and the two
 * auxiliary buffers are dropped to 8-bit to keep the bandwidth down.
 */
export class Post {

	private readonly pipeline: RenderPipeline;
	private readonly views = new Map<PostView, Node>();

	private view: PostView = 'combined';

	constructor( renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera, flash: Vec3Node ) {

		this.pipeline = new RenderPipeline( renderer );

		const scenePass = pass( scene, camera );

		scenePass.setMRT( mrt( {
			output,
			diffuseColor,
			normal: packNormalToRGB( normalView ),
			velocity,
		} ) );

		// `velocity` is written but not consumed today; it is the one buffer a
		// temporal resolve would need, so the pass keeps producing it.

		const colour = scenePass.getTextureNode( 'output' );
		const albedo = scenePass.getTextureNode( 'diffuseColor' );
		const depth = scenePass.getTextureNode( 'depth' );
		const normals = scenePass.getTextureNode( 'normal' );

		// Neither buffer needs float precision; halving them buys back bandwidth
		// that SSGI would rather spend on samples.
		scenePass.getTexture( 'diffuseColor' ).type = UnsignedByteType;
		scenePass.getTexture( 'normal' ).type = UnsignedByteType;

		const sceneNormal = sample( ( uv ) => unpackRGBToNormal( normals.sample( uv ) ) );

		// Clamped before it reaches the GI: a fireball core is orders of magnitude
		// brighter than the candles, and left unbounded it dominates the estimate so
		// hard that the floor beneath it fills with stepped blocks of bounce. The
		// clamp costs nothing in the static room, where nothing is near the ceiling.
		const giSource = vec4( colour.rgb.clamp( 0, 2.5 ), colour.a );

		const gi = ssgi( giSource, depth, sceneNormal, camera );

		// Deliberately modest: this runs alongside a million-thread ink dispatch and
		// a GPU particle system, on a scene of 361 meshes.
		gi.sliceCount.value = 2;
		gi.stepCount.value = 8;
		// A tight radius keeps the bounce local. Wider looks lovely on the static
		// room but smears a moving fireball's light across the floor in steps.
		gi.radius.value = 2;
		gi.aoIntensity.value = 1.1;
		gi.giIntensity.value = 4;
		gi.thickness.value = 0.35;

		// SSGI's own temporal filter reprojects last frame's result through the
		// velocity buffer. The spells do not write velocity — their points live in
		// storage buffers — so anything bright and moving leaves stepped blocks of
		// stale GI on the floor beneath it. Spatial-only is noisier and cheaper.
		gi.useTemporalFiltering = false;

		const ao = gi.getAONode();
		const bounce = gi.getGINode();

		// Pixels the transparent effects claimed, by the marker `transparentMRT`
		// writes: a normal facing away from the camera, which nothing visible has.
		//
		// They are excused occlusion entirely. A flame or an ember is a glow in the
		// air, not a surface, and it has no business being shadowed — but it shares
		// the `output` target with whatever it is drawn over, so `colour * ao`
		// darkens the glow along with the wall behind it. Worse, the normal at such
		// a pixel is a fiction, and every fiction that named a surface put a stain
		// somewhere: the AO there is not merely unwanted, it is wrong.
		//
		// What this costs is the *real* occlusion of the surface underneath, which
		// is only ever a surface with something bright drawn on top of it. That has
		// been invisible in every shot tried; a plume-shaped shadow across the back
		// wall was not.
		const glow = step( unpackRGBToNormal( normals ).z, GLOW_THRESHOLD );
		const occlusion = mix( ao.r, float( 1 ), glow );

		// Ambient occlusion darkens what the renderer already lit; the GI term is
		// added as light on the surface's own albedo.
		const lit = vec4( add( colour.rgb.mul( occlusion ), albedo.rgb.mul( bounce.rgb ) ), colour.a );

		// Spatial AA, not temporal. TRAA is the natural partner for SSGI and it is
		// what the three.js example uses, but every spell here is a GPU particle
		// system whose points move inside storage buffers: the velocity buffer says
		// they are stationary, so the temporal resolve reprojects them wrongly and
		// the fireball comes apart into blocks. Correcting that means keeping a
		// previous-position buffer per field and writing real per-particle velocity
		// — worth doing, but not something to smuggle in behind a post FX change.
		const bloomed = lit.add( bloom( lit, 0.32, 0.8, 1.15 ) );

		// Applied after the bloom so a candle still throws its halo into the corner,
		// and before the flash, which is a deliberate full-frame event and has no
		// business being dimmed at the edges.
		const offset = screenUV.sub( vec2( ...VIGNETTE_CENTRE ) ).mul( vec2( ...VIGNETTE_SHAPE ) );
		const corners = mix( float( VIGNETTE_FLOOR ), float( 1 ),
			smoothstep( VIGNETTE_OUTER, VIGNETTE_INNER, offset.length() ) );

		// 1 below `CEILING_FROM`, falling to `CEILING_FLOOR` at the top of frame.
		const ceiling = mix( float( CEILING_FLOOR ), float( 1 ),
			smoothstep( 1, CEILING_FROM, screenUV.y ) );

		const vignette = corners.mul( ceiling );

		const graded = vec4( bloomed.rgb.mul( vignette ), bloomed.a ).add( flash );

		this.views.set( 'combined', fxaa( graded ) );
		// `plain` deliberately keeps the vignette out of it: it exists to answer
		// "is this a lighting problem or a post problem", and a post effect in the
		// control makes that question harder to answer, not easier.
		this.views.set( 'plain', fxaa( colour.add( bloom( colour, 0.32, 0.8, 1.15 ) ).add( flash ) ) );
		this.views.set( 'ao', vec4( vec3( occlusion ), 1 ) );
		this.views.set( 'gi', vec4( bounce.rgb, 1 ) );

		this.apply();

	}

	get current(): PostView {

		return this.view;

	}

	setView( view: PostView ): void {

		this.view = view;
		this.apply();

	}

	/** Steps to the next view and reports it, for a debug key. */
	cycle(): PostView {

		const next = POST_VIEWS[ ( POST_VIEWS.indexOf( this.view ) + 1 ) % POST_VIEWS.length ];

		this.setView( next );

		return next;

	}

	render(): void {

		this.pipeline.render();

	}

	private apply(): void {

		this.pipeline.outputNode = this.views.get( this.view )!;
		this.pipeline.needsUpdate = true;

	}

}
