/**
 * Viewport plumbing that refuses to believe in a zero-sized canvas.
 *
 * Hidden panes, collapsed splits and background tabs can all report a 0×0
 * layout; feeding that to the camera produces a NaN projection matrix that
 * survives long after the window comes back. Keeping the last good size is
 * always the better answer.
 *
 * **Resizing the renderer costs about 0.7 s of frozen screen**, measured on this
 * scene — not in our JavaScript (`setSize` returns in 0.0 ms) but in three's
 * resize path, between the frame that asks for it and the next one. So a
 * `ResizeObserver` wired straight to `renderer.setSize` is a lockup: dragging a
 * window edge produces a distinct size every frame, and every distinct size buys
 * its own freeze. `Resolution` carries the measurements behind that number.
 *
 * Hence {@link SETTLE}. A drag is answered once, when it stops. Sizes that have
 * not actually changed are dropped before the timer is even armed, because the
 * observer fires for plenty of things that are not a resize.
 */

/**
 * How long a size has to hold still before it is acted on.
 *
 * Long enough that a drag resolves to one resize rather than fifty, short enough
 * that letting go of the window edge feels like it took effect immediately.
 */
const SETTLE = 200;

export function observeViewport( canvas: HTMLCanvasElement, onResize: ( width: number, height: number ) => void ): void {

	let applied: string | null = null;
	let pending: ReturnType<typeof setTimeout> | null = null;

	const commit = ( width: number, height: number ): void => {

		applied = `${ width }×${ height }`;
		onResize( width, height );

	};

	const measure = (): [ number, number ] | null => {

		const width = canvas.clientWidth || window.innerWidth;
		const height = canvas.clientHeight || window.innerHeight;

		if ( width < 2 || height < 2 ) return null;

		return [ width, height ];

	};

	const apply = (): void => {

		const size = measure();

		if ( size === null ) return;
		if ( `${ size[ 0 ] }×${ size[ 1 ] }` === applied ) return;

		if ( pending !== null ) clearTimeout( pending );

		pending = setTimeout( () => {

			pending = null;

			// Re-measured rather than closed over: the size that armed the timer is
			// a frame of a drag, and the one that matters is wherever it ended.
			const settled = measure();

			if ( settled === null ) return;
			if ( `${ settled[ 0 ] }×${ settled[ 1 ] }` === applied ) return;

			commit( settled[ 0 ], settled[ 1 ] );

		}, SETTLE );

	};

	new ResizeObserver( apply ).observe( canvas );
	window.addEventListener( 'resize', apply );

	// The first size is not a change and must not wait out the settle — there is
	// no frame to draw until the renderer has one.
	const first = measure();

	if ( first !== null ) commit( first[ 0 ], first[ 1 ] );
	else apply();

}
