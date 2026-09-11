import { GLYPH_PREVIEW } from '../recognize/glyphs';
import { SPELLS } from '../spells/registry';

const GRIMOIRE = [ 'pentagram', 'bolt', 'triangle', 'circle' ];

/**
 * How long the title screen takes to get out of the way, in milliseconds.
 *
 * Must cover the longest transition in the exit — the plate's 1.25 s travel —
 * with a little margin. Retiring early cuts the flight short; retiring late only
 * leaves an invisible, `pointer-events: none` element up for another moment.
 */
const EXIT_MS = 1350;

/** Flat DOM overlay — the 3D scene should never have to fight a UI toolkit. */
export class Hud {

	private readonly verdict: HTMLElement;
	private music!: HTMLButtonElement;
	private readonly line: HTMLElement;
	private readonly meter: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly cards = new Map<string, HTMLElement>();
	private readonly boot = document.getElementById( 'boot' ) as HTMLElement;
	private readonly bootMsg = document.getElementById( 'boot-msg' ) as HTMLElement;
	private readonly bootSigil = document.querySelector( '.boot-sigil' ) as SVGElement;
	private readonly enter = document.getElementById( 'boot-enter' ) as HTMLButtonElement;

	/** Set when the room has finished loading, and when the door has been pressed. */
	private loaded = false;
	private pressed = false;
	private open: ( () => void ) | null = null;

	constructor( root: HTMLElement ) {

		const bound = new Set( SPELLS.map( ( spell ) => spell.glyph ) );

		root.innerHTML = `
			<header>
				<div class="plate title">
					Witch Hat Atelier
					<small>Bring the quill over the parchment, draw a sigil, then hold still.</small>
				</div>
				<div class="controls">
				<div class="plate keys">
					<kbd>drag</kbd> the page to draw &nbsp; <kbd>drag</kbd> off it to look around<br />
					<kbd>Esc</kbd> face the desk &nbsp; <kbd>X</kbd> wipe &nbsp; <kbd>C</kbd> orbit &nbsp; <kbd>G</kbd> lighting
				</div>
				<button class="plate music" id="music" type="button" aria-pressed="true" title="Music on (M)">
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M4 9v6h4l5 4V5L8 9H4z" />
						<g class="waves"><path d="M16.5 8.5a5 5 0 0 1 0 7" /><path d="M19 6a8.5 8.5 0 0 1 0 12" /></g>
						<path class="cross" d="M17 9.5l5 5m0-5l-5 5" />
					</svg>
					<span class="sr">Music</span>
				</button>
				</div>
			</header>
			<div></div>
			<footer>
				<div class="plate grimoire">
					${ GRIMOIRE.map( ( glyph ) => sigilCard( glyph, bound.has( glyph ) ) ).join( '' ) }
				</div>
				<div class="plate" id="verdict">
					<div class="line">—</div>
					<div class="meter"><i></i></div>
					<small>awaiting a sigil</small>
				</div>
			</footer>
		`;

		this.music = root.querySelector( '#music' ) as HTMLButtonElement;
		this.verdict = root.querySelector( '#verdict' ) as HTMLElement;
		this.line = this.verdict.querySelector( '.line' ) as HTMLElement;
		this.meter = this.verdict.querySelector( '.meter i' ) as HTMLElement;
		this.detail = this.verdict.querySelector( 'small' ) as HTMLElement;

		for ( const card of root.querySelectorAll<HTMLElement>( '.sigil' ) ) {

			this.cards.set( card.dataset.glyph ?? '', card );

		}

		this.sowFireflies();

	}

	/**
	 * Motes drifting up the title screen, to answer the ones already in the room.
	 *
	 * In the DOM rather than the markup because each one is a different speed,
	 * drift and phase, and fourteen hand-written elements carrying six inline
	 * numbers each is not markup anyone would want to edit. They live inside
	 * `#boot` so they retire with it.
	 *
	 * The negative delay is what stops the screen opening on an empty sky: it
	 * starts every mote already part-way through its drift, so the first frame
	 * looks like the middle of something rather than the beginning.
	 */
	private sowFireflies(): void {

		const veil = this.boot.querySelector( '.boot-veil' ) as HTMLElement;

		for ( let i = 0; i < 14; i ++ ) {

			const fly = document.createElement( 'div' );

			fly.className = 'boot-firefly';
			fly.style.left = `${ Math.random() * 100 }vw`;
			fly.style.top = `${ 70 + Math.random() * 30 }vh`;
			fly.style.setProperty( '--dx', `${ Math.random() * 16 - 8 }vw` );
			fly.style.animationDuration = `${ 11 + Math.random() * 12 }s`;
			fly.style.animationDelay = `${ - Math.random() * 20 }s`;

			veil.appendChild( fly );

		}

	}

	/**
	 * How far in the load is, and what it is doing.
	 *
	 * There is no bar. `--p` drives `stroke-dashoffset` on all ten shapes of the
	 * title sigil at once — every one of them declares `pathLength="1"`, so a
	 * single number in the range 0…1 inks the whole figure in together.
	 */
	progress( fraction: number, message?: string ): void {

		this.bootSigil.style.setProperty( '--p', String( Math.min( 1, Math.max( 0, fraction ) ) ) );

		if ( message !== undefined ) this.bootMsg.textContent = message;

	}

	/**
	 * Resolves when the reader has asked to go in, which cannot happen before the
	 * room is built: the button does not exist to be pressed until {@link ready}.
	 *
	 * The load still runs behind this screen rather than before it — that part was
	 * always right, and it is why `Post` is warmed here too. What changed is the
	 * door itself. It used to stay live throughout, remembering an early press and
	 * opening by itself once there was something behind it, on the reasoning that
	 * making the button wait would spend the loading time twice. In practice it
	 * spent it worse: a live button on a screen that is plainly still working reads
	 * as an invitation, and the reader who accepts it gets a button that changes
	 * under their hand into a progress message. A door you can open onto nothing is
	 * not a shortcut, it is a wrong answer to "is this ready?".
	 *
	 * So the wait is now the loading bar's job alone, and the button's appearance
	 * is the answer to that question — one state, arriving once, meaning exactly
	 * what it looks like.
	 *
	 * @param onPress Runs synchronously inside the click handler. Anything that
	 * needs a user gesture — every browser refuses audio without one — has to go
	 * here rather than after the `await`, because a promise continuation is no
	 * longer the gesture.
	 */
	gate( onPress: () => void ): Promise<void> {

		return new Promise( ( resolve ) => {

			this.open = () => {

				this.boot.classList.add( 'gone' );

				// And then stop it existing. Nothing in the exit removes the screen —
				// the grain repaints three times a second and fourteen fireflies drift
				// forever, and an opacity of zero stops neither. Left up, an invisible
				// title screen would go on taking frames off the room for the whole
				// session, which is the worst kind of cost: there is nothing on screen
				// to suspect.
				//
				// On a timer rather than `transitionend`, because there is no single
				// transition to wait for — the backdrop, the plate and the sigil each
				// leave on their own curve, and that event bubbles from all three, so
				// the first to finish would retire the screen mid-flight.
				setTimeout( () => this.boot.classList.add( 'spent' ), EXIT_MS );

				resolve();

			};

			this.enter.addEventListener( 'click', () => {

				// `disabled` already refuses the click, so this only guards against a
				// double press in the moment before the overlay fades.
				if ( this.pressed || ! this.loaded ) return;

				this.pressed = true;
				onPress();
				this.open!();

			} );

		} );

	}

	/**
	 * The room is built, the shaders are warm. Seals the sigil and puts the door up.
	 *
	 * The half-second is not padding. `--p` reaches 1 in this same call and the
	 * stroke has a 0.5 s transition to travel, so sealing on the instant would
	 * light a figure that is still drawing itself. This waits for the ink to land,
	 * and the room is finished either way — the beat is spent on the one moment
	 * this screen has, not on the load.
	 */
	ready(): void {

		this.loaded = true;

		setTimeout( () => {

			this.boot.classList.add( 'sealed' );
			this.enter.disabled = false;

			// So Return works for anyone who never reached for the mouse. Harmless if
			// the window is not focused — `focus` on a background tab does not steal it.
			this.enter.focus();

		}, 500 );

	}

	fatal( message: string ): void {

		// `failed` outranks `sealed` on the status line: if this arrives after the
		// door is up, the news still has to be the thing that is readable.
		this.boot.classList.add( 'failed' );
		this.bootMsg.innerHTML = `<span class="fatal">${ message }</span>`;
		this.enter.remove();

	}

	/**
	 * Wires the music button. `toggle` reports whether the track is now playing,
	 * and the button's own state follows that rather than a copy kept here — the
	 * keyboard shortcut goes through {@link setMusic} for the same reason, so the
	 * two ways of reaching it cannot disagree.
	 */
	onMusic( toggle: () => boolean ): void {

		this.music.addEventListener( 'click', () => this.setMusic( toggle() ) );

	}

	/** Reflects whether the track is playing, whatever asked for the change. */
	setMusic( playing: boolean ): void {

		this.music.classList.toggle( 'off', ! playing );
		this.music.setAttribute( 'aria-pressed', String( playing ) );
		this.music.title = playing ? 'Music on (M)' : 'Music off (M)';

	}

	/** The running read of a half-drawn sigil, replaced by `report` once it casts. */
	reading( title: string | null, detail: string, score: number, bound: boolean ): void {

		this.line.textContent = title ?? '…';
		this.line.className = `line reading ${ bound ? 'ok' : 'miss' }`;
		this.detail.textContent = detail;
		this.meter.style.width = `${ Math.round( Math.min( 1, Math.max( 0, score ) ) * 100 ) }%`;
		this.meter.style.background = bound ? 'var(--ember)' : 'var(--rune)';

	}

	/** Lights the grimoire card for the glyph currently being read. */
	highlight( glyph: string | null ): void {

		for ( const [ name, card ] of this.cards ) card.classList.toggle( 'lit', name === glyph );

	}

	report( title: string, detail: string, score: number, ok: boolean ): void {

		this.line.textContent = title;
		this.line.className = `line ${ ok ? 'ok' : 'miss' }`;
		this.detail.textContent = detail;
		this.meter.style.width = `${ Math.round( Math.min( 1, Math.max( 0, score ) ) * 100 ) }%`;
		this.meter.style.background = ok ? 'var(--ember)' : 'var(--rune)';

	}

	status( detail: string ): void {

		this.detail.textContent = detail;

	}

}

function sigilCard( glyph: string, bound: boolean ): string {

	const spell = SPELLS.find( ( s ) => s.glyph === glyph );
	const strokes = GLYPH_PREVIEW[ glyph ] ?? [];

	const paths = strokes
		.map( ( points ) => {

			const d = points
				.map( ( [ x, y ], i ) => `${ i === 0 ? 'M' : 'L' }${ ( x * 38 + 50 ).toFixed( 1 ) } ${ ( y * 38 + 50 ).toFixed( 1 ) }` )
				.join( ' ' );

			return `<path d="${ d }" />`;

		} )
		.join( '' );

	return `
		<div class="sigil ${ bound ? 'bound' : '' }" data-glyph="${ glyph }" title="${ spell?.hint ?? 'not bound to a spell' }">
			<svg viewBox="0 0 100 100">${ paths }</svg>
			<span>${ spell?.short ?? 'unbound' }</span>
		</div>
	`;

}
