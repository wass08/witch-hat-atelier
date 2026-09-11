import type { WebGPURenderer } from 'three/webgpu';

/**
 * How many pixels this scene is allowed to draw, chosen from the canvas size and
 * then left alone for the whole session.
 *
 * This scene is GPU-bound rather than CPU-bound, and it fails in a particular
 * way: the frame rate looks fine and yet a few percent of frames overrun badly.
 * Measured on one machine, camera still, at three ratios of the same 825×973
 * canvas —
 *
 * | ratio | drawing buffer | pixels | fps | p50 | p90 | frames over 25 ms |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | 1.5 | 1237×1459 | 1.80 M | 62 | 12.6 ms | 24.7 ms | **8.6%**, and 13.3% on a second run |
 * | 1.25 | 1031×1216 | 1.25 M | 79 | 9.5 ms | 18.9 ms | 0.8%, 1.7% |
 * | 1.0 | 825×973 | 0.80 M | 95 | 8.4 ms | 15.9 ms | 0.2% |
 *
 * — so the cost is pixels, giving them up genuinely works, and 1.25 M of them is
 * where this scene stops missing vsyncs. Nothing in the frame is our JavaScript:
 * on an overrunning frame every stage of the update, `post.render()` included,
 * reads about zero, because `render` only queues the work. The wait is the GPU.
 *
 * Hence {@link BUDGET}, in pixels rather than in ratio. A ratio is a statement
 * about a *display* and the cost is a count of *pixels*, so the same 1.5 that is
 * free in a small window is unaffordable in a large one — and the window is the
 * one thing here that genuinely varies. Working back from a pixel count keeps the
 * cost constant and lets the ratio be whatever that costs, up to {@link CAP}.
 *
 * ---
 *
 * **It does not adapt any more, and that is the fix rather than a compromise.**
 *
 * There were three adaptive versions of this and every one of them was the thing
 * being complained about, because a change of resolution costs **about 0.7 s of
 * frozen screen** — captured three times in this scene's own profiler while the
 * last one stepped: 776 ms, 651 ms, 441 ms, each the worst frame in an otherwise
 * unremarkable six-second run. It is not the resize, either. A step invalidates
 * every render pipeline in the scene: hooking `backend.createRenderPipeline` and
 * stepping the ratio by hand, the call returns in 0.1 ms, the frame after it
 * queues in 0.6 ms, and that frame rebuilds **23 render pipelines** for 1.1 ms of
 * JavaScript between them. The wait is the driver compiling them, between one
 * frame and the next, where a stall is least attributable and most visible.
 *
 * Against that price, every adaptive rig failed the same way — not by choosing
 * wrong, but by choosing *while someone was watching*:
 *
 * - the first had a recovery path and never stopped moving: over 45 s of an idle
 *   room, 1.5 → 1.375 at t=23.6 s and back at t=31.4 s, landing exactly
 *   `WINDOW × (COOLDOWN + 1)` frames apart — the soonest its hysteresis allowed.
 *   It was not reacting to anything, it was running as fast as it was let: two
 *   two-thirds-of-a-second freezes a minute, forever. "It lags all the time";
 * - one-way and finite fixed the oscillation and left three freezes on the table.
 *   Its first windows landed on the arrival — the widest shot in the piece, with
 *   whatever the warm-up missed compiling inside it — so it froze during the
 *   entry. "It lags when I look around after entering";
 * - and a cast is the most expensive thing the scene draws. One cast is a single
 *   bad window, which it ignored; two or three in a row, the way anyone plays once
 *   they know the sigils, spanned the two consecutive windows it wanted. It
 *   dropped a step and froze on the third. "It lags at the last spell".
 *
 * Sizing during the load was tried next, and the frames there cannot be trusted:
 * behind the boot screen the same scene at the same ratio measured **0%** long
 * frames against **13.3%** with the screen taken away, because an opaque overlay
 * lets the compositor skip presenting the canvas and `requestAnimationFrame` stops
 * being paced by the GPU at all. Timestamp queries were no better — the same frame
 * read 19.6 ms and 67.8 ms depending on nothing that mattered. There is no honest
 * measurement to be had before the room is on screen.
 *
 * So the last version of the question — "what should this be?" — is answered here
 * once, from the table above, and never asked again during play. What that gives
 * up is a machine faster than this one drawing more pixels than this one can. What
 * it buys is that nothing in the session ever freezes the screen. At 0.7 s a
 * question, that is the right way round.
 */

/**
 * Pixels the drawing buffer may hold.
 *
 * 1.25 M is the middle row of the table: measured comfortable at 0.8–1.7% long
 * frames, where 1.5 M was not (the old rig stepped through 1.375 and kept going)
 * and 1.8 M missed a vsync every twelve frames. It is one machine's number, and
 * the honest thing to say about it is that it is a floor on what any machine can
 * do rather than a ceiling on what a good one could — raise it if the scene ever
 * gets a proper spread of hardware to measure on.
 */
const BUDGET = 1.25e6;

/**
 * The most this may ask of a display, however small the window.
 *
 * Screen-space GI costs per pixel and the pipeline's spatial AA already resolves
 * the edges a higher ratio would be buying, so past 1.5 there is nothing left to
 * win — and the budget, not this, is what binds on any window worth the name.
 */
const CAP = 1.5;

/** …and the least, below which the image is soft enough to notice. */
const FLOOR = 1;

/**
 * The ratio is snapped to this, and the reason is the 0.7 s.
 *
 * Solved exactly, the budget hands back a different ratio for every window size,
 * so nudging a window edge by one pixel would change the ratio — and a change of
 * ratio is a `setPixelRatio` *and* a `setSize`, which is two pipeline rebuilds
 * where a plain resize is one. Eighths are fine enough that the budget is still
 * spent (a step is a 12% change in linear resolution) and coarse enough that most
 * resizes do not move it at all.
 */
const GRAIN = 8;

export class Resolution {

	private current = 1;

	constructor( private readonly renderer: WebGPURenderer ) {}

	/** What the renderer is drawing at, for the debug read-out. */
	get pixelRatio(): number {

		return this.current;

	}

	/**
	 * Sizes the drawing buffer for a canvas this big, in CSS pixels, and reports
	 * the ratio it settled on.
	 *
	 * Called with every resize rather than only the first, because the budget is
	 * about the window and the window is what just changed. It costs nothing extra
	 * to do it here: a resize is already paying for the pipeline rebuild, and this
	 * rides along with it.
	 */
	fit( width: number, height: number ): number {

		const area = Math.max( 1, width * height );
		const wanted = Math.round( Math.sqrt( BUDGET / area ) * GRAIN ) / GRAIN;

		this.current = Math.min( CAP, Math.max( FLOOR, wanted ) );

		// three drops this on the floor when the ratio has not moved, which is what
		// makes the snapping above worth having: the caller is about to `setSize` as
		// well, and a ratio that changed too would make that two pipeline rebuilds
		// instead of one.
		this.renderer.setPixelRatio( this.current );

		return this.current;

	}

}
