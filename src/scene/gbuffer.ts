import { mrt, packNormalToRGB, vec3 } from 'three/tsl';

/**
 * The marker {@link transparentMRT} writes into the normal buffer, and the value
 * {@link Post} tests for. Facing straight away from the camera, which visible
 * geometry never is.
 */
export const GLOW_NORMAL = vec3( 0, 0, - 1 );

/**
 * How far past level a normal has to lean away from the camera to be the marker
 * rather than a steep surface. Real geometry grazes towards zero and stops;
 * nothing visible reaches this.
 */
export const GLOW_THRESHOLD = - 0.8;

/**
 * The MRT override every transparent effect in the room wears.
 *
 * The scene pass writes `output`, `diffuseColor`, `normal` and `velocity`, and
 * SSGI reads the middle two. Every glow here — flames, spell particles, the
 * circle's web — is a camera-facing quad drawn over solid geometry, and by
 * default each one writes its *own* normal into that buffer. At a floor pixel
 * under a particle the depth still says "floor" while the normal now says
 * "facing the camera", so the AO hemisphere is rotated to point into the floor,
 * finds it occluding in every direction, and comes back almost black. That is
 * where the dark discs around the particles came from — and the dark squares
 * before them, which were the same fault across the whole quad rather than only
 * the part that survived the alpha test.
 *
 * Two things that look like fixes and are not, both tried:
 *
 * - **Discarding the transparent fragments.** It only shrinks the artefact to
 *   the shape of whatever still draws — squares became discs.
 * - **Writing zeroes.** The auxiliary targets default to `NoBlending`, so a
 *   material's write *replaces* what is underneath rather than blending with it.
 *   A zero normal is not "no normal", it is a degenerate one, and AO reads it
 *   worse than a wrong one. Borrowing the material's blend mode for those targets
 *   via `setBlendMode` does not help either — on this version it is honoured for
 *   `output` alone.
 *
 * Since the write cannot be avoided, stop trying to guess a surface and write a
 * *marker* instead. These are additive glows hanging in mid-air; the honest AO
 * for them is none, and `Post` is where that can be said. The value written here
 * is a normal pointing directly away from the camera, which no visible geometry
 * can produce — a front face is only visible because it turns toward the viewer,
 * so `normalView.z` is positive for every real pixel in the buffer. The composite
 * tests for it and passes those pixels through with no occlusion at all.
 *
 * It is a unit vector rather than a zero one on purpose: it travels through the
 * same 8-bit pack, the same `unpackRGBToNormal`, and SSGI's own `normalize` with
 * nothing degenerate to trip over. Whatever AO it computes there is discarded.
 *
 * Three fabricated surfaces came before this, and each one failed on the geometry
 * it was not chosen for — the tell every time is a stain in `post.setView( 'ao' )`
 * that is absent from `'plain'`:
 *
 * - **The particle's own camera-facing normal**, the default. Dark squares, then
 *   dark discs once the empty corners of the quad were discarded.
 * - **World up.** Right over the floor, which is what the spells are mostly seen
 *   against. On a wall the hemisphere lies along the surface instead of off it,
 *   every ray grazes into the stone it started on, and a fireball crossing the
 *   back of the room painted a plume-shaped shadow across it.
 * - **World up in view space.** The same vector finally in the space the pass
 *   writes — `packNormalToRGB( normalView )` — which fixed the ink motes over the
 *   desk and left the fireball's plume exactly as it was. It was never the space
 *   that was wrong so much as the premise: there is no one surface to name.
 *
 * `diffuseColor` is deliberately left alone. It is the other buffer SSGI reads,
 * but the term it feeds is `albedo * bounce`, small next to `colour * ao`
 * wherever these effects are drawn, and overriding it was measurably invisible.
 */
export function transparentMRT() {

	return mrt( { normal: packNormalToRGB( GLOW_NORMAL ) } );

}
