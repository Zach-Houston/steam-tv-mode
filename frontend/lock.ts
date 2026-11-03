/* ------------------------------------------------------------------ *
 * Desktop lock: while TV Mode is active, the desktop Steam window shows a
 * lock screen. One code works from keyboard or controller:
 *   arrows / D-pad = ↑ ↓ ← →, A B X Y = A B X Y (letters/digits keyboard only).
 * Enter / Start confirms, Backspace / Select clears.
 * Only a SHA-256 hash of the code is stored.
 * ------------------------------------------------------------------ */

type Log = (...args: unknown[]) => void;

export const LOCK_HASH_KEY = 'tvmode.lock.hash';
const OVERLAY_ID = 'tvmode-lock';
/** Desktop windows that get the lock screen. The sign-in window is never locked. */
const LOCKED_TITLES = /^(Steam|Friends List)$/;

const PAD_TOKENS: Record<number, string> = { 12: 'U', 13: 'D', 14: 'L', 15: 'R', 0: 'A', 1: 'B', 2: 'X', 3: 'Y' };
const PAD_CONFIRM = 9; // Start / Menu
const PAD_CLEAR = 8; // Select / View
const SHOW: Record<string, string> = { U: '↑', D: '↓', L: '←', R: '→' };

let unlocked = false;
let mode: 'enter' | 'setup' | 'confirm' = 'enter';
let entry: string[] = [];
let firstSetup: string[] = [];
let message = '';
let padLogged = false;

const listeners = new WeakMap<Window, (e: KeyboardEvent) => void>();

function readHash(): string | null {
	try {
		return window.localStorage.getItem(LOCK_HASH_KEY);
	} catch {
		return null;
	}
}

async function hashCode(seq: string[]): Promise<string> {
	const data = new TextEncoder().encode('tvmode:' + seq.join(','));
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function keyToken(e: KeyboardEvent): string | null {
	switch (e.key) {
		case 'ArrowUp':
			return 'U';
		case 'ArrowDown':
			return 'D';
		case 'ArrowLeft':
			return 'L';
		case 'ArrowRight':
			return 'R';
	}
	return /^[a-z0-9]$/i.test(e.key) ? e.key.toUpperCase() : null;
}

const CSS = `
#${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483647; background: radial-gradient(ellipse at 50% 0%, #1b2233 0%, #0a0c11 70%);
	color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; font-family: "Motiva Sans", Arial, sans-serif; user-select: none; }
#${OVERLAY_ID} h1 { margin: 0; font-size: 34px; font-weight: 700; }
#${OVERLAY_ID} p { margin: 0; font-size: 16px; opacity: .7; max-width: 560px; text-align: center; line-height: 1.5; }
#${OVERLAY_ID} button { margin-top: 6px; padding: 12px 28px; font-size: 16px; font-weight: 600; color: #fff; background: #1a9fff; border: 0; border-radius: 6px; cursor: pointer; }
#${OVERLAY_ID} button:hover { background: #47b2ff; }
#${OVERLAY_ID} .tvm-code { min-height: 44px; min-width: 260px; padding: 8px 18px; border-radius: 8px; background: rgba(255,255,255,.07);
	font-size: 26px; letter-spacing: 6px; display: flex; align-items: center; justify-content: center; }
#${OVERLAY_ID} .tvm-msg { color: #f2c94c; opacity: 1; min-height: 22px; }
`;

function render(doc: Document) {
	const root = doc.getElementById(OVERLAY_ID);
	if (!root) return;
	const title = root.querySelector('h1')!;
	const sub = root.querySelector('.tvm-sub')!;
	const code = root.querySelector('.tvm-code')!;
	const msg = root.querySelector('.tvm-msg')!;
	if (mode === 'enter') {
		title.textContent = 'Steam is in TV Mode';
		sub.textContent = 'Use Big Picture on the TV. To use desktop Steam, enter the unlock code.';
	} else if (mode === 'setup') {
		title.textContent = 'Set an unlock code';
		sub.textContent = 'This code unlocks desktop Steam while TV Mode is on. Use the keyboard: arrows, letters or numbers.';
	} else {
		title.textContent = 'Enter the code again';
		sub.textContent = 'Confirm the unlock code.';
	}
	code.textContent = entry.length ? entry.map((t) => (mode === 'enter' ? '•' : SHOW[t] ?? t)).join(' ') : '—';
	msg.textContent = message;
}

function renderAll(windows: Window[]) {
	for (const w of windows) {
		try {
			render(w.document);
		} catch {
			/* window gone */
		}
	}
}

/** Desktop popups that are web views (they'd sit above the lock screen), closed while locked. */
const CLOSE_TITLES = /^(Special Offers)$/;
/** Desktop routes drawn in the main window itself (not a web view on top). */
const SAFE_ROUTE = /^\/library/i;

export function createDesktopLock(log: Log, getWindows: () => Window[], getMainWindow: () => any) {
	let routeFixes: number[] = [];
	let disabledThisSession = false;
	let lastDesktopRoute = '';

	/** Store/Community are web views drawn over the window; keep the desktop on the Library while locked. */
	const enforceLibrary = () => {
		const ui = (window as any).SteamUIStore;
		try {
			// In Big Picture the "main window" is Big Picture itself: never steer it from here.
			if (ui?.IsGamepadUIWindowActive?.() || ui?.MainInstanceUIMode === 4) return;
		} catch {
			return;
		}
		const inst = getMainWindow();
		if (!inst || inst === ui?.WindowStore?.GamepadUIMainWindowInstance) return;
		let route = '';
		try {
			route = String(inst?.LocationPathName ?? inst?.m_locationPathname ?? '');
		} catch {
			return;
		}
		if (route !== lastDesktopRoute) {
			lastDesktopRoute = route;
			log('desktop route', route || '(none)');
		}
		if (!route || SAFE_ROUTE.test(route)) return;
		const now = Date.now();
		routeFixes = routeFixes.filter((t) => now - t < 6000);
		if (routeFixes.length >= 4) {
			// Can't keep the desktop off web views: don't trap the user behind them.
			disabledThisSession = true;
			for (const w of getWindows()) removeOverlay(w);
			log('desktop lock disabled for this session: could not leave', route);
			return;
		}
		routeFixes.push(now);
		try {
			inst?.Navigate?.('/library/home');
		} catch (e) {
			log('desktop navigate failed', String(e));
		}
	};
	const openTvMode = () => {
		const client = (window as any).SteamClient;
		try {
			client?.UI?.SetUIMode?.(4); // 4 = gamepad UI (Big Picture)
		} catch {
			/* fall through */
		}
		try {
			client?.URL?.ExecuteSteamURL?.('steam://open/bigpicture');
		} catch (e) {
			log('open TV mode failed', String(e));
		}
	};

	const unlock = () => {
		unlocked = true;
		entry = [];
		message = '';
		for (const w of getWindows()) removeOverlay(w);
		log('desktop unlocked');
	};

	const submit = async () => {
		const seq = entry.slice();
		entry = [];
		if (!seq.length) return;
		if (mode === 'setup') {
			if (seq.length < 4) {
				message = 'Use at least 4 inputs.';
			} else {
				firstSetup = seq;
				mode = 'confirm';
				message = '';
			}
		} else if (mode === 'confirm') {
			if (seq.join() === firstSetup.join()) {
				try {
					window.localStorage.setItem(LOCK_HASH_KEY, await hashCode(seq));
				} catch {
					/* storage unavailable */
				}
				log('unlock code set');
				mode = 'enter';
				firstSetup = [];
				unlock();
				return;
			}
			mode = 'setup';
			firstSetup = [];
			message = "Codes didn't match. Start again.";
		} else {
			if ((await hashCode(seq)) === readHash()) {
				unlock();
				return;
			}
			message = 'Wrong code.';
		}
		renderAll(getWindows());
	};

	const input = (t: string) => {
		if (entry.length >= 32) return;
		entry.push(t);
		message = '';
		renderAll(getWindows());
	};

	const clear = () => {
		entry = [];
		message = '';
		renderAll(getWindows());
	};

	function removeOverlay(w: Window) {
		try {
			w.document.getElementById(OVERLAY_ID)?.remove();
			w.document.getElementById(OVERLAY_ID + '-style')?.remove();
			const l = listeners.get(w);
			if (l) w.removeEventListener('keydown', l, true);
			listeners.delete(w);
		} catch {
			/* window gone */
		}
	}

	function addOverlay(w: Window) {
		const doc = w.document;
		if (!doc.body || doc.getElementById(OVERLAY_ID)) return;
		const style = doc.createElement('style');
		style.id = OVERLAY_ID + '-style';
		style.textContent = CSS;
		doc.head.appendChild(style);

		const root = doc.createElement('div');
		root.id = OVERLAY_ID;
		root.innerHTML = '<h1></h1><p class="tvm-sub"></p><button type="button">Open TV Mode</button><div class="tvm-code"></div><p class="tvm-msg"></p><p>Click here, then type the code: arrows, letters or numbers. Enter to confirm, Backspace to clear.</p>';
		root.querySelector('button')!.addEventListener('click', (e) => {
			e.stopPropagation();
			openTvMode();
		});
		for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu', 'wheel']) {
			root.addEventListener(type, (e) => {
				if ((e.target as Element)?.tagName !== 'BUTTON') e.stopPropagation();
			});
		}
		doc.body.appendChild(root);

		const onKey = (e: KeyboardEvent) => {
			if (unlocked) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'Enter') void submit();
			else if (e.key === 'Backspace' || e.key === 'Escape') clear();
			else {
				const t = keyToken(e);
				if (t) input(t);
			}
		};
		w.addEventListener('keydown', onKey, true);
		listeners.set(w, onKey);
		render(doc);
	}

	/* Controller input via the Gamepad API (may be unavailable while Steam Input owns the pad). */
	const prevButtons = new Map<number, boolean[]>();
	const pollPads = (w: Window) => {
		let pads: (Gamepad | null)[] = [];
		try {
			pads = Array.from(w.navigator.getGamepads?.() ?? []);
		} catch {
			return;
		}
		const present = pads.filter(Boolean) as Gamepad[];
		if (!padLogged) {
			padLogged = true;
			log('lock screen gamepads visible:', present.length, present.map((p) => p.id));
		}
		for (const pad of present) {
			const prev = prevButtons.get(pad.index) ?? [];
			const now = pad.buttons.map((b) => b.pressed);
			now.forEach((down, i) => {
				if (!down || prev[i]) return;
				if (i === PAD_CONFIRM) void submit();
				else if (i === PAD_CLEAR) clear();
				else if (PAD_TOKENS[i]) input(PAD_TOKENS[i]);
			});
			prevButtons.set(pad.index, now);
		}
	};

	const tick = () => {
		if (unlocked || disabledThisSession) return;
		if (!readHash() && mode === 'enter') mode = 'setup';
		enforceLibrary();
		if (disabledThisSession) return;
		for (const w of getWindows()) {
			try {
				if (CLOSE_TITLES.test(w.document.title)) {
					log('closing', w.document.title);
					w.close();
					continue;
				}
				if (!LOCKED_TITLES.test(w.document.title)) continue;
				addOverlay(w);
				pollPads(w);
			} catch {
				/* window gone */
			}
		}
	};

	return {
		start() {
			setInterval(tick, 100);
			log('desktop lock active', readHash() ? '(code set)' : '(no code yet: setup on first show)');
		},
		/** Lock again (called when Big Picture opens). */
		relock() {
			disabledThisSession = false;
			routeFixes = [];
			if (!unlocked) return;
			unlocked = false;
			mode = readHash() ? 'enter' : 'setup';
			log('desktop locked again (Big Picture opened)');
		},
		resetCode() {
			try {
				window.localStorage.removeItem(LOCK_HASH_KEY);
			} catch {
				/* ignore */
			}
			mode = 'setup';
		},
	};
}
