import { definePlugin, Field } from 'millennium';
import { makeTvHome, TvRow } from './tvhome';
import { AchievementItem, NewsItem, makeTvGame } from './tvgame';
import { createDesktopLock } from './lock';
import { startMenuInjector } from './menu-cdp';

/* ------------------------------------------------------------------ *
 * TV Mode v0.1.1
 *
 * Runs in Steam's shared UI context. Attaches to the Big Picture window
 * and, on every DOM change there:
 *   1. hides playtime / last-played blocks
 *   2. hides library tabs other than "Collections"
 *   3. hides collection tiles whose name doesn't start with "TV"
 *
 * Steam's class names are hashed and change between builds, so matching
 * is done on visible text plus small structural checks instead of
 * selectors. Everything is reversible: hidden nodes just get an attribute.
 *
 * Open the Big Picture devtools console and run `tvMode.inspect()` to see
 * what the plugin is detecting.
 * ------------------------------------------------------------------ */

/**
 * Feature switches, persisted in localStorage so they survive a Steam restart.
 * Change from the console: tvMode.set({ windowHook: false }) then restart Steam.
 * tvMode.safeMode() turns every runtime feature off.
 */
const FLAG_KEY = 'tvmode.flags';
const DEFAULT_FLAGS = {
	/** Millennium.AddWindowCreateHook — fires for every Steam window. */
	windowHook: true,
	/** Periodic scan of Steam's popup windows for Big Picture. */
	scan: true,
	/** DOM hiding inside the Big Picture window. */
	hidePlaytime: true,
	hideOtherLibraryTabs: true,
	hideNonTvCollections: true,
	/** Redirect blocked screens. Off = watch-only (log what would happen). */
	lockdown: true,
	/** Lock screen on desktop Steam while TV Mode is on. */
	desktopLock: true,
	debug: true,
};
type Flags = typeof DEFAULT_FLAGS;

function loadFlags(): Flags {
	try {
		const raw = window.localStorage.getItem(FLAG_KEY);
		return { ...DEFAULT_FLAGS, ...(raw ? JSON.parse(raw) : {}) };
	} catch {
		return { ...DEFAULT_FLAGS };
	}
}

function saveFlags(f: Flags) {
	try {
		window.localStorage.setItem(FLAG_KEY, JSON.stringify(f));
	} catch {
		/* storage unavailable; flags last until restart */
	}
}

const CONFIG = {
	/** Collections whose names match this are the TV collections. */
	tvCollectionPattern: /^tv\b/i,
	...loadFlags(),
};

/** Settings pages allowed in TV mode (sidebar labels and their routes). */
const SETTINGS_LABELS = ['System', 'Internet', 'Storage', 'Display', 'Audio', 'Controller', 'Keyboard', 'Customization', 'Accessibility'];
const SETTINGS_ALLOWED = /^\/settings\/(system|internet|storage|display|audio|controller|keyboard|customization|accessibility)(\/|$)/;

/** Big Picture library tab labels to hide. "Collections" is deliberately absent. */
const LIBRARY_TAB_LABELS = new Set([
	'great on deck',
	'all games',
	'installed',
	'non-steam',
	'soundtracks',
	'favorites',
	'demos',
	'playtests',
	'family library',
	'shared library',
	'compatible',
	'tools',
]);

/** Labels whose surrounding block (label + value) should disappear. */
const PLAYTIME_LABELS = /^(play\s?time|time played|last played|total played|playtime( on record)?|hours played)$/i;
/** Free-standing strings that are playtime on their own. */
const PLAYTIME_TEXT = [
	/^(you've\s+)?played\s+(for\s+)?[\d.,]+\s*(hours?|hrs?|minutes?|mins?)\b/i,
	/^last\s+played\b/i,
	/^[\d.,]+\s*(hours?|hrs?)\s+(played|on record)\b/i,
	/^[\d.,]+\s*(hours?|hrs?)\s+past\s+2\s+weeks\b/i,
	/^last\s+two\s+weeks\s*:/i,
	/^no\s+playtime(\s+yet)?$/i,
	/^played\s+(today|yesterday|recently|\d+\s+\w+\s+ago)\b/i,
];

const HIDDEN_ATTR = 'data-tvmode-hidden';
const STYLE_ID = 'tvmode-style';
/** Exact title of the Big Picture window. Anything else is left alone. */
const BPM_TITLE = /^Steam Big Picture Mode$/;

/** Logs to the console and to tvmode.log in the project folder (via the Lua backend). */
function log(...args: unknown[]) {
	if (!CONFIG.debug) return;
	console.log('[TV Mode]', ...args);
	const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
	try {
		// @ts-ignore -- `backend` is injected by Millennium at build time
		backend.append_log(`${new Date().toISOString()} ${line}`)?.catch?.(() => {});
	} catch {
		/* backend not ready */
	}
}

/* ---------------------------- Steam data ---------------------------- */

interface TvCollection {
	id: string;
	name: string;
	count: number;
}

interface CollectionNames {
	tv: TvCollection[];
	other: Set<string>;
}

/**
 * Steam's collection data (collectionStore.userCollections) throws if read before Steam has
 * loaded collections, and that error then sticks inside Steam's own copy and crashes its UI.
 * So only read it once its underlying maps exist; checking those plain fields is always safe.
 */
let collectionsReadyLogged = false;
let collectionsShapeLogged = false;
const pluginStartedAt = Date.now();
function collectionsReady(): boolean {
	const store = (window as any).collectionStore;
	if (!store) return false;
	try {
		const mapKeys = Object.keys(store).filter((k) => /^m_map/i.test(k));
		if (!mapKeys.length) {
			// Unknown store shape: fall back to waiting a while after start-up, and say so once.
			if (!collectionsShapeLogged) {
				collectionsShapeLogged = true;
				log('collection store fields (no m_map*):', Object.keys(store).slice(0, 30));
			}
			return Date.now() - pluginStartedAt > 25000;
		}
		const ready = mapKeys.every((k) => store[k] != null);
		if (!collectionsReadyLogged && ready) {
			collectionsReadyLogged = true;
			log('collections ready', mapKeys);
		}
		return ready;
	} catch {
		return false;
	}
}

function userCollections(): any[] {
	if (!collectionsReady()) return [];
	try {
		return Array.from((window as any).collectionStore?.userCollections ?? []);
	} catch {
		return [];
	}
}

function readCollections(withCounts = false): CollectionNames {
	const tv: TvCollection[] = [];
	const other = new Set<string>();
	let all: any[] = [];
	try {
		// userCollections is a MobX getter that throws until Steam has loaded
		// collections; never let that escape into Steam's render.
		all = userCollections();
	} catch {
		return { tv, other };
	}

	for (const c of all) {
		const name: string = (c?.displayName ?? '').trim();
		if (!name) continue;
		if (CONFIG.tvCollectionPattern.test(name)) {
			let count = 0;
			if (withCounts) {
				try {
					count = c?.allApps?.length ?? c?.apps?.size ?? 0;
				} catch {
					/* not loaded yet */
				}
			}
			tv.push({ id: String(c?.id ?? name), name, count });
		} else {
			other.add(name.toLowerCase());
		}
	}
	return { tv, other };
}

/* ------------------------------ Hiding ------------------------------ */

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Hidden for these reasons = also made unfocusable, so the controller can't land on them. */
const INERT_REASONS = new Set(['top-bar', 'search', 'settings-entry', 'wifi-original', 'library-tab', 'main-menu', 'footer']);

function hide(el: Element | null | undefined, reason: string) {
	if (!el || el.hasAttribute(HIDDEN_ATTR)) return;
	el.setAttribute(HIDDEN_ATTR, reason);
	if (INERT_REASONS.has(reason)) {
		el.setAttribute('inert', '');
		el.setAttribute('tabindex', '-1');
	}
}

/** Text nodes under root, skipping anything already hidden. */
function* textNodes(root: Node): Generator<Text> {
	const doc = root.ownerDocument ?? (root as Document);
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (n) =>
			n.parentElement?.closest(`[${HIDDEN_ATTR}]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
	});
	let n: Node | null;
	while ((n = walker.nextNode())) yield n as Text;
}

function hidePlaytime(textEl: Element, text: string) {
	if (PLAYTIME_LABELS.test(text)) {
		// Label + value usually share a small wrapper. Only take the wrapper
		// if it's small, so a bad match can't blank out a whole panel.
		const block = textEl.parentElement;
		const blockText = norm(block?.textContent);
		hide(block && blockText.length <= 60 ? block : textEl, 'playtime');
		return;
	}
	if (PLAYTIME_TEXT.some((re) => re.test(text))) hide(textEl, 'playtime');
}

/** True if el sits in a strip of siblings that look like library tabs. */
function inTabStrip(el: Element): boolean {
	let node: Element | null = el;
	for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
		const parent: Element | null = node.parentElement;
		if (!parent) return false;
		let tabLike = 0;
		for (const sib of Array.from(parent.children)) {
			const t = norm(sib.textContent).toLowerCase();
			if (LIBRARY_TAB_LABELS.has(t) || t === 'collections') tabLike++;
		}
		if (tabLike >= 3) return true;
	}
	return false;
}

/** Climb to the element representing the tab itself (direct child of the strip). */
function tabRoot(el: Element): Element {
	let node = el;
	while (node.parentElement) {
		const parent = node.parentElement;
		const siblingsLookLikeTabs = Array.from(parent.children).filter((s) => {
			const t = norm(s.textContent).toLowerCase();
			return LIBRARY_TAB_LABELS.has(t) || t === 'collections';
		}).length;
		if (siblingsLookLikeTabs >= 3) return node;
		node = parent;
	}
	return el;
}

/** Collection tile = largest ancestor whose text is still just "name + a short count". */
function collectionTile(el: Element, name: string): Element {
	let tile = el;
	let node = el.parentElement;
	for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
		if (norm(node.textContent).length > name.length + 24) break;
		tile = node;
	}
	return tile;
}

/* Settings sidebar: hide every entry that isn't allowed. */
const ALLOWED_SETTINGS = new Set(SETTINGS_LABELS.map((l) => l.toLowerCase()));
/** Labels seen in Big Picture's settings sidebar (used to recognise the list). */
const KNOWN_SETTINGS = new Set(
	[...SETTINGS_LABELS, 'Notifications', 'Friends & Chat', 'Downloads', 'Cloud', 'In Game', 'Family', 'Remote Play', 'In-Game Voice', 'Game Recording', 'Home', 'Library', 'Store', 'Interface', 'Security', 'Developer', 'Account', 'Power', 'Bluetooth', 'Music', 'Broadcasting', 'Compatibility'].map((l) => l.toLowerCase()),
);
let sidebarLogged = false;

/* Steam button menu: keep only these entries. */
const MAIN_MENU_ALLOWED = new Set(['downloads', 'settings', 'power']);
const MAIN_MENU_KNOWN = new Set(['home', 'library', 'store', 'friends & chat', 'media', 'downloads', 'settings', 'power', 'web browser', 'steam deck']);

let mainMenuHidden = 0;

/**
 * Hide unwanted Steam-menu entries one by one: each disallowed label is hidden if it sits
 * inside a small area that also holds "Power" and "Downloads" (i.e. the Steam menu),
 * however Steam groups the entries.
 */
function trimMainMenu(doc: Document) {
	if (!doc.body) return;
	const removed: string[] = [];
	for (const tn of textNodes(doc.body)) {
		const label = norm(tn.data).toLowerCase();
		if (!MAIN_MENU_KNOWN.has(label) || MAIN_MENU_ALLOWED.has(label)) continue;
		let item: Element | null = tn.parentElement;
		if (!item || item.closest('.tvm-root, .tvg-root')) continue;
		// Widest ancestor that still holds only this label (the whole menu entry, icon included).
		while (item.parentElement && norm(item.parentElement.textContent).toLowerCase() === label) item = item.parentElement;
		let inMenu = false;
		let up: Element | null = item.parentElement;
		for (let i = 0; up && i < 8; i++, up = up.parentElement) {
			const t = (up.textContent ?? '').toLowerCase();
			if (t.length > 600) break; // too big to be the menu
			if (t.includes('power') && t.includes('downloads')) {
				inMenu = true;
				break;
			}
		}
		if (!inMenu || item.hasAttribute(HIDDEN_ATTR)) continue;
		hide(item, 'main-menu');
		removed.push(norm(tn.data));
	}
	if (removed.length) {
		mainMenuHidden += removed.length;
		if (mainMenuHidden <= 20) log('steam menu: hid', removed);
	}
}

/** Menu popups are separate windows: trim them as soon as they render. */
const menuObserved = new WeakSet<Document>();
const menuSeenIn = new Set<string>();

function watchMenuWindows() {
	if (!CONFIG.lockdown) return;
	for (const w of steamWindows()) {
		let doc: Document;
		try {
			doc = w.document;
		} catch {
			continue;
		}
		if (!doc?.body) continue;
		// Log where the Steam menu actually lives (once per window title).
		const title = doc.title ?? '';
		const txt = doc.body.textContent ?? '';
		if (txt.includes('Power') && txt.includes('Downloads') && !menuSeenIn.has(title)) {
			menuSeenIn.add(title);
			log('steam menu seen in window', JSON.stringify(title), 'hidden entries:', doc.querySelectorAll('[data-tvmode-hidden="main-menu"]').length);
		}
		if (BPM_TITLE.test(title)) {
			trimMainMenu(doc);
			continue;
		}
		if (menuObserved.has(doc) || title === 'Steam') continue;
		menuObserved.add(doc);
		const style = doc.createElement('style');
		style.textContent = `[${HIDDEN_ATTR}] { display: none !important; }`;
		doc.head?.appendChild(style);
		trimMainMenu(doc);
		let lastTexts = '';
		const dump = () => {
			const texts: string[] = [];
			for (const tn of textNodes(doc.body)) {
				const t = norm(tn.data);
				if (t && t.length < 40) texts.push(t);
				if (texts.length >= 40) break;
			}
			const j = JSON.stringify(texts);
			if (j !== lastTexts && texts.length) {
				lastTexts = j;
				log('menu window', JSON.stringify(doc.title), texts);
			}
		};
		new MutationObserver(() => {
			trimMainMenu(doc);
			dump();
		}).observe(doc.body, { childList: true, subtree: true });
		dump();
	}
}

function trimSettingsSidebar(doc: Document) {
	if (!currentRoute().toLowerCase().startsWith('/settings')) return;
	for (const tn of textNodes(doc.body)) {
		if (norm(tn.data).toLowerCase() !== 'accessibility') continue;
		// Climb to the list whose children are the sidebar entries.
		for (let el = tn.parentElement; el && el !== doc.body; el = el.parentElement) {
			const kids = Array.from(el.children);
			const known = kids.filter((k) => KNOWN_SETTINGS.has(norm(k.textContent).toLowerCase()));
			if (known.length < 6) continue;
			const removed: string[] = [];
			for (const k of kids) {
				const label = norm(k.textContent).toLowerCase();
				if (label && !ALLOWED_SETTINGS.has(label)) {
					if (!k.hasAttribute(HIDDEN_ATTR)) removed.push(norm(k.textContent));
					hide(k, 'settings-entry');
				}
			}
			if (!sidebarLogged && removed.length) {
				sidebarLogged = true;
				log('settings sidebar: hid', removed);
			}
			return;
		}
	}
}

/** Hide search boxes (and their small wrapper) so search can't be opened. */
function hideSearch(doc: Document) {
	doc.querySelectorAll('input').forEach((input) => {
		const label = `${input.getAttribute('placeholder') ?? ''} ${input.getAttribute('aria-label') ?? ''} ${input.getAttribute('type') ?? ''}`;
		if (!/search/i.test(label)) return;
		let target: Element = input;
		for (let i = 0; i < 4 && target.parentElement; i++) {
			const w = target.parentElement.getBoundingClientRect().width;
			if (w === 0 || w > 520) break;
			target = target.parentElement;
		}
		hide(target, 'search');
	});
}

/* Top bar: hide everything except the clock. */
const CLOCK_RE = /^\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/i;
const headerCache = new WeakMap<Document, { header: Element; path: Set<Element> }>();
let headerMissLogged = false;

function findClock(doc: Document): Element | null {
	for (const tn of textNodes(doc.body)) if (CLOCK_RE.test(norm(tn.data))) return tn.parentElement;
	return null;
}

/* Top-bar items to keep: the controller icon (live), and Wi-Fi (as a visual-only copy). */
const wifiClones = new WeakMap<Element, Element>();
let topBarDescribed = false;

/** One-line description of a top-bar item for the log. */
function describe(el: Element): string {
	const labels = [el, ...Array.from(el.querySelectorAll('[aria-label],[title],title'))]
		.map((e) => (e.tagName.toLowerCase() === 'title' ? e.textContent : e.getAttribute('aria-label') ?? e.getAttribute('title')))
		.filter(Boolean)
		.slice(0, 4);
	const r = el.getBoundingClientRect();
	return `${el.tagName.toLowerCase()} w=${Math.round(r.width)} svgs=${el.querySelectorAll('svg').length} text=${JSON.stringify(norm(el.textContent).slice(0, 30))} labels=${JSON.stringify(labels)} class=${JSON.stringify((el.getAttribute('class') ?? '').slice(0, 80))}`;
}

/** Visual-only copy of the Wi-Fi icon next to Steam's (hidden) original. */
const wifiSource = new WeakMap<Element, string>();

function showWifiCopy(original: Element) {
	hide(original, 'wifi-original');
	const old = wifiClones.get(original);
	// Skip if the existing copy is current: rebuilding it is a DOM change that would re-trigger a sweep.
	const markup = original.innerHTML;
	if (old?.isConnected && wifiSource.get(original) === markup) return;
	wifiSource.set(original, markup);
	const copy = original.cloneNode(true) as HTMLElement;
	copy.removeAttribute(HIDDEN_ATTR);
	copy.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((n) => n.removeAttribute(HIDDEN_ATTR));
	for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
		el.removeAttribute('tabindex');
		el.removeAttribute('id');
	}
	copy.setAttribute('aria-hidden', 'true');
	copy.setAttribute('data-tvmode-copy', 'wifi');
	copy.style.pointerEvents = 'none';
	if (old?.isConnected) old.replaceWith(copy);
	else original.after(copy);
	wifiClones.set(original, copy);
}

function trimHeader(doc: Document) {
	let entry = headerCache.get(doc);
	const stale = !entry || !entry.header.isConnected || Array.from(entry.path).some((e) => !e.isConnected);
	if (stale) {
		const clock = findClock(doc);
		if (!clock) return;
		const vw = doc.defaultView?.innerWidth ?? 1920;
		// The top bar = the widest short ancestor of the clock.
		let header: Element | null = null;
		for (let el = clock.parentElement; el && el !== doc.body; el = el.parentElement) {
			const r = el.getBoundingClientRect();
			if (r.height > 160) break;
			if (r.width >= vw * 0.6) header = el;
		}
		if (!header) {
			if (!headerMissLogged) log('top bar not found around clock');
			headerMissLogged = true;
			return;
		}
		const path = new Set<Element>();
		for (let el: Element | null = clock; el; el = el.parentElement) {
			path.add(el);
			if (el === header) break;
		}
		entry = { header, path };
		headerCache.set(doc, entry);
		log('top bar found; keeping clock, controller and Wi-Fi');
	}
	const items: Element[] = [];
	for (const el of entry!.path) {
		if (el === entry!.header || !el.parentElement) continue;
		for (const sib of Array.from(el.parentElement.children)) if (!entry!.path.has(sib)) items.push(sib);
	}
	if (!topBarDescribed) {
		topBarDescribed = true;
		log('top bar items', items.map(describe));
	}
	// The whole top bar goes; its clock, controller and Wi-Fi move to a strip in the bottom bar.
	updateStatusBar(doc, entry!.header);
	hide(entry!.header, 'top-bar');
}

/** Big Picture's bottom bar = the wide, short strip at the bottom holding the "Back" hint. */
const footerCache = new WeakMap<Document, Element>();
let footerLogged = false;

function trimFooter(doc: Document) {
	const cached = footerCache.get(doc);
	if (cached?.isConnected) {
		hide(cached, 'footer');
		return;
	}
	const vh = doc.defaultView?.innerHeight ?? 1080;
	const vw = doc.defaultView?.innerWidth ?? 1920;
	for (const tn of textNodes(doc.body)) {
		if (norm(tn.data).toLowerCase() !== 'back') continue;
		const start = tn.parentElement;
		if (!start || start.closest('.tvm-root, .tvg-root')) continue;
		if (start.getBoundingClientRect().bottom < vh - 140) continue; // not near the bottom
		let footer: Element | null = null;
		for (let el: Element | null = start.parentElement; el && el !== doc.body; el = el.parentElement) {
			const r = el.getBoundingClientRect();
			if (r.height > 140) break;
			if (r.width >= vw * 0.6) footer = el;
		}
		if (!footer) continue;
		footerCache.set(doc, footer);
		hide(footer, 'footer');
		if (!footerLogged) {
			footerLogged = true;
			log('bottom bar hidden', describe(footer));
		}
		return;
	}
}

const STATUS_ID = 'tvmode-status';
let statusTimer: ReturnType<typeof setInterval> | undefined;

/* Status: just the time, top-right. Warnings appear beside it only when something is wrong. */
const WARN_ICONS = {
	internet:
		'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.8a15 15 0 0 1 4.2-2.6M10.3 5.1A15 15 0 0 1 22 8.8M5 12.6a10 10 0 0 1 3.4-2.1M15 10.4a10 10 0 0 1 4 2.2M8.5 16.1a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r=".8" fill="currentColor"/><path d="M3 3l18 18"/></svg>',
	controller:
		'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8h10a4 4 0 0 1 3.9 4.8l-.9 4.3a2 2 0 0 1-3.5.8L14.8 16H9.2l-1.7 1.9a2 2 0 0 1-3.5-.8l-.9-4.3A4 4 0 0 1 7 8z"/><path d="M3 3l18 18"/></svg>',
};

function updateStatusBar(doc: Document, header: Element) {
	let bar = doc.getElementById(STATUS_ID);
	if (!bar) {
		bar = doc.createElement('div');
		bar.id = STATUS_ID;
		bar.setAttribute('data-tvmode-copy', 'status');
		bar.style.cssText =
			'position:fixed;top:22px;right:32px;z-index:1000;display:flex;align-items:center;gap:22px;pointer-events:none;' +
			'color:#eef1f6;font-size:22px;font-weight:600;text-shadow:0 1px 6px rgba(0,0,0,.85);';
		doc.body.appendChild(bar);
		const win = doc.defaultView;
		const refresh = () => updateStatusBar(doc, headerCache.get(doc)?.header ?? header);
		win?.addEventListener('online', refresh);
		win?.addEventListener('offline', refresh);
	}
	// Steam only shows its "Controller Details" item while a controller is connected.
	const hasController = Array.from(header.querySelectorAll('[aria-label]')).some((el) =>
		/controller/i.test(el.getAttribute('aria-label') ?? ''),
	);
	const online = doc.defaultView?.navigator.onLine ?? navigator.onLine;
	const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	const sig = `${hasController}|${online}|${time}`;
	if (bar.getAttribute('data-sig') === sig) return;
	bar.setAttribute('data-sig', sig);
	bar.replaceChildren();
	// Icon only: the crossed-out glyph says enough.
	const warn = (icon: string) => {
		const el = doc.createElement('span');
		el.style.cssText = 'display:flex;align-items:center;color:#f2b84c;';
		el.innerHTML = icon;
		bar!.appendChild(el);
	};
	if (!online) warn(WARN_ICONS.internet);
	if (!hasController) warn(WARN_ICONS.controller);
	const clock = doc.createElement('span');
	clock.textContent = time;
	bar.appendChild(clock);
	if (!statusTimer) {
		statusTimer = setInterval(() => {
			const entry = headerCache.get(doc);
			if (entry?.header.isConnected) updateStatusBar(doc, entry.header);
		}, 5000);
	}
}

/** Keep the Wi-Fi copies current (signal strength etc.). */
function refreshWifiCopies(doc: Document) {
	doc.querySelectorAll('[data-tvmode-hidden="wifi-original"]').forEach((orig) => showWifiCopy(orig));
}

function sweep(root: Node, collections: CollectionNames) {
	const doc = root.ownerDocument ?? (root as Document);
	if (CONFIG.lockdown) {
		hideSearch(doc);
		trimHeader(doc);
		trimSettingsSidebar(doc);
		trimMainMenu(doc);
		trimFooter(doc);
	}
	const onLibraryPage = currentRoute().toLowerCase().startsWith('/library');
	for (const tn of textNodes(root)) {
		const el = tn.parentElement;
		if (!el) continue;
		// Never apply Steam-page hiding rules to TV Mode's own screens.
		if (el.closest('.tvm-root, .tvg-root')) continue;
		const text = norm(tn.data);
		if (!text || text.length > 120) continue;
		const lower = text.toLowerCase();

		if (CONFIG.hidePlaytime) hidePlaytime(el, text);

		if (CONFIG.hideOtherLibraryTabs && LIBRARY_TAB_LABELS.has(lower) && inTabStrip(el)) {
			hide(tabRoot(el), 'library-tab');
		}

		// Collection tiles only exist on Steam's library pages.
		if (CONFIG.hideNonTvCollections && onLibraryPage && collections.other.has(lower)) {
			hide(collectionTile(el, text), 'collection');
		}
	}
}

/* ------------------------- Big Picture window ------------------------ */

const attached = new WeakSet<Document>();

/** Max ms of sweeping per second before TV Mode backs off to protect Steam. */
const SWEEP_BUDGET_MS = 100;
const SWEEP_DEBOUNCE_MS = 200;
const COLLECTION_REFRESH_MS = 5000;

function attach(doc: Document) {
	if (attached.has(doc) || !doc.body) return;
	attached.add(doc);
	log('attached to', JSON.stringify(doc.title));
	bpmDoc = doc;
	showCover(doc);
	{
		const route = currentRoute();
		refreshTvData();
		if (CONFIG.lockdown && route && !judge(route).allow) redirectHome(route, judge(route).to);
		else if (route && judge(route).allow) hideCover();
	}
	if (CONFIG.desktopLock) desktopLock.relock();
	if (doc.defaultView) watchRoutes(doc.defaultView);

	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `[${HIDDEN_ATTR}] { display: none !important; }`;
	doc.head.appendChild(style);

	let collections = readCollections();
	let collectionsAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let windowStart = Date.now();
	let spentThisWindow = 0;
	let disabled = false;
	const pendingRoots = new Set<Node>();

	const flush = () => {
		timer = undefined;
		if (disabled) return;
		const t0 = performance.now();
		try {
			if (Date.now() - collectionsAt > COLLECTION_REFRESH_MS) {
				collections = readCollections();
				collectionsAt = Date.now();
			}
			for (const r of pendingRoots) if (r.isConnected) sweep(r, collections);
		} catch (e) {
			log('sweep failed', String(e));
		}
		pendingRoots.clear();

		const now = Date.now();
		if (now - windowStart > 1000) {
			windowStart = now;
			spentThisWindow = 0;
		}
		spentThisWindow += performance.now() - t0;
		if (spentThisWindow > SWEEP_BUDGET_MS) {
			// Back off briefly, then re-apply everything once (instead of giving up for the session).
			disabled = true;
			log('backing off 3s: sweeping used', Math.round(spentThisWindow), 'ms in under 1s');
			setTimeout(() => {
				disabled = false;
				spentThisWindow = 0;
				windowStart = Date.now();
				pendingRoots.add(doc.body);
				timer = setTimeout(flush, 0);
			}, 3000);
		}
	};

	const observer = new MutationObserver((mutations) => {
		if (disabled) return;
		for (const m of mutations) {
			m.addedNodes.forEach((n) => {
				if ((n as Element).hasAttribute?.('data-tvmode-copy')) return; // our own Wi-Fi copy
				pendingRoots.add(n);
			});
		}
		if (!timer && pendingRoots.size) timer = setTimeout(flush, SWEEP_DEBOUNCE_MS);
	});
	observer.observe(doc.body, { childList: true, subtree: true });

	// Controller input arrives as Steam "vgp_" events on the focused element. Blocking "up" from the
	// carousel's top row stops focus from ever reaching the top bar (search, icons).
	const DIR_UP = 9; // Steam's EGamepadButton.DIR_UP
	const LSTICK_UP = 23; // left stick up as a navigation input (logged below to verify)
	let vgpLogged = 0;
	const inTopRow = (el: Element | null) => {
		const tile = el?.closest?.('.tvm-tile');
		const firstRow = doc.querySelector('.tvm-row');
		return !!tile && !!firstRow && firstRow.contains(tile);
	};
	const focusedTile = (): Element | null =>
		doc.querySelector('.tvm-root .tvm-tile.gpfocus') ?? (doc.activeElement?.closest?.('.tvm-tile') ?? null);
	for (const type of ['vgp_onbuttondown', 'vgp_onbuttonup']) {
		doc.addEventListener(
			type,
			(e: Event) => {
				const detail = (e as CustomEvent).detail ?? {};
				if (vgpLogged < 6 && type === 'vgp_onbuttondown') {
					vgpLogged++;
					log('controller input', { button: detail.button, source: detail.source, target: describe(e.target as Element) });
				}
				if (!currentRoute().toLowerCase().startsWith(TV_ROUTE)) return;
				if (detail.button !== DIR_UP && detail.button !== LSTICK_UP) return;
				const tile = focusedTile() ?? (e.target as Element);
				if (!inTopRow(tile)) return;
				e.preventDefault();
				e.stopImmediatePropagation();
			},
			true,
		);
	}

	let lastTile: HTMLElement | null = null;
	const loggedFocus = new Set<string>();
	doc.addEventListener(
		'focusin',
		(e) => {
			const t = e.target as HTMLElement | null;
			if (!t) return;
			if (t.closest('.tvm-root')) {
				const tile = t.closest<HTMLElement>('.tvm-tile');
				if (tile) lastTile = tile;
				return;
			}
			// Only pull focus back when it lands on something hidden (top bar, search…).
			// Menus and dialogs (power menu, etc.) must keep their focus.
			const header = headerCache.get(doc)?.header;
			const inHidden = !!t.closest(`[${HIDDEN_ATTR}]`) || (!!header && header.contains(t) && !t.closest('[data-tvmode-copy]'));
			if (!inHidden) return;
			const desc = describe(t);
			if (!loggedFocus.has(desc)) {
				loggedFocus.add(desc);
				log('focus guard: focus left the carousel to', desc, 'hidden:', inHidden);
			}
			const back = lastTile?.isConnected ? lastTile : doc.querySelector<HTMLElement>('.tvm-tile');
			if (back) setTimeout(() => back.focus(), 0);
			else t.blur?.();
		},
		true,
	);

	// Diagnostic snapshot of what Big Picture actually renders (logged when it changes).
	let lastSnapshot = '';
	const snapshot = () => {
		if (!CONFIG.debug || !doc.body?.isConnected) return;
		try {
			const texts = new Set<string>();
			for (const tn of textNodes(doc.body)) {
				const t = norm(tn.data);
				if (t && t.length <= 40) texts.add(t);
				if (texts.size >= 200) break;
			}
			const hidden: Record<string, number> = {};
			doc.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => {
				const r = el.getAttribute(HIDDEN_ATTR)!;
				hidden[r] = (hidden[r] ?? 0) + 1;
			});
			const snap = JSON.stringify({
				elements: doc.body.getElementsByTagName('*').length,
				iframes: doc.getElementsByTagName('iframe').length,
				shadowHosts: Array.from(doc.body.querySelectorAll('*')).filter((e) => (e as HTMLElement).shadowRoot).length,
				disabled,
				hidden,
				texts: Array.from(texts),
			});
			if (snap !== lastSnapshot) {
				lastSnapshot = snap;
				log('snapshot', snap);
			}
		} catch (e) {
			log('snapshot failed', String(e));
		}
	};
	(doc.defaultView ?? window).setInterval(snapshot, 4000);
	(doc.defaultView ?? window).setInterval(() => {
		try {
			refreshWifiCopies(doc);
		} catch {
			/* ignore */
		}
	}, 5000);

	try {
		const t0 = performance.now();
		sweep(doc.body, collections);
		const counts: Record<string, number> = {};
		doc.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => {
			const r = el.getAttribute(HIDDEN_ATTR)!;
			counts[r] = (counts[r] ?? 0) + 1;
		});
		log('initial sweep', Math.round(performance.now() - t0), 'ms, hid', counts, 'tv collections:', collections.tv.map((c) => c.name));
	} catch (e) {
		log('initial sweep failed', String(e));
	}
}

function isBigPicture(doc: Document | undefined | null): doc is Document {
	return !!doc && BPM_TITLE.test(doc.title ?? '');
}

/** Raw popup records from Steam's popup manager, whatever shape they have. */
function rawPopups(): any[] {
	const mgr = (window as any).g_PopupManager;
	if (!mgr) return [];
	try {
		return Array.from(mgr.GetPopups?.() ?? mgr.m_mapPopups?.values?.() ?? []);
	} catch {
		return [];
	}
}

/** Windows handed to us by the window-creation hook (e.g. Big Picture's MainMenu_ / QuickAccess_). */
const hookedWindows = new Set<Window>();

function isWindow(v: any): v is Window {
	try {
		return !!v && typeof v === 'object' && !!v.document && !!v.location && typeof v.setTimeout === 'function';
	} catch {
		return false;
	}
}

/** Any Window objects held directly on an object (one level deep). */
function windowsOn(obj: any, out: Set<Window>) {
	if (!obj || typeof obj !== 'object') return;
	for (const k of Object.keys(obj)) {
		let v: any;
		try {
			v = obj[k];
		} catch {
			continue;
		}
		if (isWindow(v)) out.add(v);
		else if (v && typeof v === 'object' && isWindow(v.m_popup ?? v.BrowserWindow ?? v.m_BrowserWindow)) out.add(v.m_popup ?? v.BrowserWindow ?? v.m_BrowserWindow);
	}
}

/** Steam's UI windows: popup manager, window store, and hook-captured ones (not the shared JS context). */
function steamWindows(): Window[] {
	const out = new Set<Window>();
	for (const p of rawPopups()) {
		const w: Window | undefined = p?.m_popup ?? p?.window ?? p?.m_window;
		if (w) out.add(w);
	}
	try {
		const store = (window as any).SteamUIStore?.WindowStore;
		const inst = store?.GamepadUIMainWindowInstance;
		windowsOn(inst, out);
		for (const w of Array.from<any>(store?.SteamUIWindows ?? [])) windowsOn(w, out);
	} catch {
		/* shape changed */
	}
	for (const w of hookedWindows) {
		try {
			if (w.closed) hookedWindows.delete(w);
			else out.add(w);
		} catch {
			hookedWindows.delete(w);
		}
	}
	out.delete(window);
	return Array.from(out);
}

/** Logs what the scan can see, only when it changes (goes to the dev window). */
let lastScanSummary = '';
function logScan(windows: Window[]) {
	if (!CONFIG.debug) return;
	const mgr = (window as any).g_PopupManager;
	const titles = windows.map((w) => {
		try {
			return w.document.title;
		} catch {
			return '(unreadable)';
		}
	});
	const summary: Record<string, unknown> = {
		hasPopupManager: !!mgr,
		popupRecords: rawPopups().length,
		windowTitles: titles,
	};
	// If we can't find windows, show what the manager actually exposes.
	if (mgr && !windows.length) {
		const proto = Object.getPrototypeOf(mgr);
		summary.managerKeys = Object.keys(mgr);
		summary.managerMethods = proto ? Object.getOwnPropertyNames(proto) : [];
		const first = rawPopups()[0];
		if (first) summary.firstPopupKeys = Object.keys(first);
	}
	const text = JSON.stringify(summary);
	if (text !== lastScanSummary) {
		lastScanSummary = text;
		log('scan', text);
	}
}

function scanForBigPicture() {
	const windows = steamWindows();
	logScan(windows);
	for (const w of windows) {
		try {
			if (isBigPicture(w.document)) attach(w.document);
		} catch {
			/* window closed mid-scan */
		}
	}
}

/**
 * The hook only nudges a scan; it doesn't touch or hold on to the new
 * window, since it fires for every desktop popup and menu too.
 */
let hookShapeLogged = false;

function onWindowCreated(ctx: any): void {
	// Keep hold of the new window so menu windows can be trimmed.
	const candidates = [ctx, ctx?.m_popup, ctx?.window, ctx?.m_window, ctx?.BrowserWindow, ctx?.m_BrowserWindow, ctx?.popup];
	const w = candidates.find(isWindow);
	if (w) hookedWindows.add(w);
	if (!hookShapeLogged) {
		hookShapeLogged = true;
		log('window hook context', ctx && typeof ctx === 'object' ? Object.keys(ctx).slice(0, 30) : typeof ctx, 'window found:', !!w);
	}
	// Menus open as new windows: trim them right away, before they're visible for long.
	setTimeout(watchMenuWindows, 0);
	setTimeout(watchMenuWindows, 120);
	setTimeout(scanForBigPicture, 0);
	setTimeout(scanForBigPicture, 150);
	setTimeout(scanForBigPicture, 1000);
}

/* ------------------------------ Lockdown ----------------------------- */

/**
 * Allowed Big Picture screens: the collections page, a TV collection, and
 * pages of games inside TV collections. Everything else would be redirected.
 * `lockdown: false` = watch-only: log decisions, never redirect.
 */
let tvApps = new Set<string>();
let tvCollectionIds = new Set<string>();
let tvDataAt = 0;

function refreshTvData() {
	if (!collectionsReady()) return;
	if (Date.now() - tvDataAt < 5000) return;
	tvDataAt = Date.now();
	const apps = new Set<string>();
	const ids = new Set<string>();
	try {
		const all: any[] = userCollections();
		for (const c of all) {
			if (!CONFIG.tvCollectionPattern.test((c?.displayName ?? '').trim())) continue;
			ids.add(String(c?.id));
			for (const a of Array.from<any>(c?.allApps ?? [])) if (a?.appid != null) apps.add(String(a.appid));
		}
		tvApps = apps;
		tvCollectionIds = ids;
	} catch {
		/* store not ready; keep previous */
	}
}

type Verdict = { allow: boolean; why: string; to?: string };

/** Where blocked screens send you. */
const COLLECTIONS_ROUTE = '/library/tab/Collections';
const TV_ROUTE = '/tvmode';
let tvRouteReady = false;
let tvRouteBroken = false;

function homeRoute(): string {
	return tvRouteReady && !tvRouteBroken ? TV_ROUTE : COLLECTIONS_ROUTE;
}

function judge(route: string): Verdict {
	const r = route.toLowerCase();
	if (!r) return { allow: true, why: 'no route yet' };
	if (r.startsWith('/tvmode')) return { allow: true, why: 'tv home' };
	if (r.startsWith('/tvgame')) return { allow: true, why: 'tv game page' };
	if (r === '/settings' || r === '/settings/') return { allow: true, why: 'settings home' };
	if (r.startsWith('/settings/')) {
		const ok = SETTINGS_ALLOWED.test(r);
		return ok ? { allow: true, why: 'allowed settings' } : { allow: false, why: 'settings page not allowed', to: '/settings' };
	}
	if (r.startsWith('/library/tab/collections')) return { allow: true, why: 'collections tab' };

	const app = r.match(/^\/library\/app\/(\d+)/);
	if (app) {
		const ok = tvApps.has(app[1]);
		return { allow: ok, why: ok ? 'tv game ' + app[1] : 'non-tv game ' + app[1] };
	}
	const col = r.match(/\/collection\/([^/?#]+)/);
	if (col) {
		const id = decodeURIComponent(col[1]);
		const ok = Array.from(tvCollectionIds).some((t) => t.toLowerCase() === id.toLowerCase());
		return { allow: ok, why: ok ? 'tv collection' : 'non-tv collection ' + id };
	}
	if (r === '/library' || r === '/library/' || r.startsWith('/library/home') || r.startsWith('/library/tab/')) {
		return { allow: false, why: 'library view outside collections' };
	}
	if (/^\/(store|steamweb|friends|chat|media|search|community|profile|news|notifications)/.test(r)) {
		return { allow: false, why: 'blocked section' };
	}
	// Unknown screens are allowed (and logged) so a route I haven't seen can't trap Big Picture.
	return { allow: true, why: 'unrecognised route' };
}

function gamepadWindow(): any {
	return (window as any).SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance;
}

/** Big Picture's real route (it uses an in-memory router, not window.location). */
function currentRoute(): string {
	const inst = gamepadWindow();
	try {
		return String(inst?.LocationPathName ?? inst?.m_locationPathname ?? '');
	} catch {
		return '';
	}
}

/* Startup cover: hides Big Picture's own home screen until we're on an allowed screen. */
let coverEl: HTMLElement | null = null;

function showCover(doc: Document) {
	if (!CONFIG.lockdown || coverEl?.isConnected) return;
	const el = doc.createElement('div');
	el.id = 'tvmode-cover';
	el.setAttribute('aria-hidden', 'true');
	el.style.cssText =
		'position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:radial-gradient(ellipse at 50% 0%, #1b2233 0%, #0a0c11 70%);transition:opacity .25s ease;';
	doc.body.appendChild(el);
	coverEl = el;
	// Never leave it up for long, whatever happens.
	setTimeout(hideCover, 4000);
}

function hideCover() {
	const el = coverEl;
	if (!el) return;
	coverEl = null;
	el.style.opacity = '0';
	setTimeout(() => el.remove(), 300);
}

/** Redirect history, to stop if something keeps bouncing (loop guard). */
let redirectTimes: number[] = [];
let pausedUntil = 0;
let lastRedirectAt = 0;
let attemptsOnRoute = 0;
let tvRouteSeen = false;
let lastCaptureAt = 0;

function redirectHome(route: string, to?: string) {
	const now = Date.now();
	if (now < pausedUntil) return;
	redirectTimes = redirectTimes.filter((t) => now - t < 5000);
	if (redirectTimes.length >= 6) {
		pausedUntil = now + 15000;
		log('lockdown paused 15s: 6 redirects in 5s, possible loop at', route);
		return;
	}
	redirectTimes.push(now);
	lastRedirectAt = now;
	attemptsOnRoute++;
	const inst = gamepadWindow();
	try {
		// The search screen ignores Navigate; Back closes it. Other screens: step back out on retries.
		const isSearch = route.toLowerCase().startsWith('/search');
		if (isSearch || attemptsOnRoute > 1) inst?.NavigateBack?.();
		if (isSearch && attemptsOnRoute === 1) {
			log('closed search with Back');
			return;
		}
		const target = to ?? homeRoute();
		// replace=true so Back doesn't return to the blocked screen
		inst?.Navigate(target, true);
		log('redirected to', target, attemptsOnRoute > 1 ? `(retry ${attemptsOnRoute})` : '');
		if (target === TV_ROUTE && !tvRouteSeen) {
			// Only on the first ever redirect: if our screen never renders, fall back.
			setTimeout(() => {
				if (!tvRouteSeen && !currentRoute().toLowerCase().startsWith(TV_ROUTE)) {
					tvRouteBroken = true;
					log('tv home did not load (route is', currentRoute(), '); using Collections tab instead');
				}
			}, 2500);
		}
	} catch (e) {
		log('redirect failed', String(e));
	}
}

function watchRoutes(_win: Window) {
	let last = '';
	setInterval(() => {
		const route = currentRoute();
		if (route.toLowerCase().startsWith(TV_ROUTE)) tvRouteSeen = true;
		const changed = route !== last;
		if (changed) {
			last = route;
			attemptsOnRoute = 0;
			refreshTvData();
		}
		const appMatch = route.match(/^\/library\/app\/(\d+)/i);
		if (appMatch && Date.now() - lastCaptureAt > 1000 && !achievementIcon()) {
			lastCaptureAt = Date.now();
			const appid = Number(appMatch[1]);
			// Regular ribbon only from unfinished games, the 100% one only from finished games.
			void getAchievements(appid).then((a) => {
				if (!a || a.total <= 0 || !currentRoute().startsWith(`/library/app/${appid}`)) return;
				// Steam uses the same ribbon for completed games, so one capture covers all.
				if (a.unlocked < a.total && !achievementIcon()) tryCaptureAchievementIcon();
			});
		}
		const v = judge(route);
		if (v.allow && route && coverEl) hideCover();
		if (changed && route.toLowerCase().startsWith('/settings') && bpmDoc && CONFIG.lockdown) {
			setTimeout(() => bpmDoc && trimSettingsSidebar(bpmDoc), 150);
		}
		if (changed) log('route', route, v.allow ? 'ALLOW' : 'BLOCK', `(${v.why})`, CONFIG.lockdown ? '' : '[watch-only]');
		if (v.allow || !CONFIG.lockdown) return;
		// Redirect on arrival, and keep retrying while still stuck on a blocked screen.
		if (changed || Date.now() - lastRedirectAt > 800) redirectHome(route, v.to);
	}, 250);
}

/* ----------------------------- Debugging ----------------------------- */

function inspect() {
	const collections = readCollections();
	const windows = steamWindows().map((w) => {
		try {
			return { title: w.document.title, attached: attached.has(w.document) };
		} catch {
			return { title: '(unreadable)', attached: false };
		}
	});
	const hidden: Record<string, number> = {};
	for (const w of steamWindows()) {
		try {
			w.document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => {
				const r = el.getAttribute(HIDDEN_ATTR)!;
				hidden[r] = (hidden[r] ?? 0) + 1;
			});
		} catch {
			/* ignore */
		}
	}
	const report = {
		flags: loadFlags(),
		hasCollectionStore: !!(window as any).collectionStore,
		hasPopupManager: !!(window as any).g_PopupManager,
		hasWindowHook: typeof (window as any).Millennium?.AddWindowCreateHook === 'function',
		tvCollections: collections.tv,
		otherCollections: collections.other.size,
		windows,
		hiddenCounts: hidden,
	};
	console.log('[TV Mode] inspect', report);
	return report;
}

/** Undo all hiding in every window (handy while tuning). */
function reveal() {
	for (const w of steamWindows()) {
		try {
			w.document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => el.removeAttribute(HIDDEN_ATTR));
		} catch {
			/* ignore */
		}
	}
}

/* ------------------------------ Settings ----------------------------- */

const SettingsContent = () => {
	const { tv } = readCollections(true);
	if (!tv.length) {
		return (
			<Field
				label="No TV collections found"
				description='Create collections whose names start with "TV" (e.g. "TV · Singleplayer"), then reopen this page.'
			/>
		);
	}
	return (
		<>
			{tv.map((c) => (
				<Field key={c.id} label={c.name} description={`${c.count} games`} />
			))}
		</>
	);
};

/* ------------------------------- Entry ------------------------------- */

/** Persist flag changes; most take effect after a Steam restart. */
function set(changes: Partial<Flags>) {
	const next = { ...loadFlags(), ...changes };
	saveFlags(next);
	Object.assign(CONFIG, next);
	console.log('[TV Mode] flags saved — restart Steam to apply hook/scan changes', next);
	return next;
}

const safeMode = () =>
	set({ lockdown: false, windowHook: false, scan: false, hidePlaytime: false, hideOtherLibraryTabs: false, hideNonTvCollections: false });
const resetFlags = () => set({ ...DEFAULT_FLAGS });

/* ------------------------------ TV home ------------------------------ */

function readTvRows(): TvRow[] {
	const rows: TvRow[] = [];
	try {
		const all: any[] = userCollections();
		for (const c of all) {
			const name: string = (c?.displayName ?? '').trim();
			if (!CONFIG.tvCollectionPattern.test(name)) continue;
			const games = Array.from<any>(c?.allApps ?? [])
				.filter((a) => a?.appid != null)
				.map((a) => ({ appid: Number(a.appid), name: String(a.display_name ?? a.strDisplayName ?? a.appid) }))
				.sort((x, y) => x.name.localeCompare(y.name));
			rows.push({ id: String(c?.id ?? name), name, games });
		}
	} catch {
		/* store not ready */
	}
	return rows.sort((a, b) => a.name.localeCompare(b.name));
}

const TV_GAME_ROUTE = '/tvgame';
const GAME_KEY = 'tvmode.currentGame';
let tvGameApp: number | null = null;

function currentGameApp(): number | null {
	if (tvGameApp == null) {
		try {
			const v = Number(window.sessionStorage.getItem(GAME_KEY));
			tvGameApp = v > 0 ? v : null;
		} catch {
			/* ignore */
		}
	}
	return tvGameApp;
}

function openGame(appid: number) {
	tvGameApp = appid;
	try {
		window.sessionStorage.setItem(GAME_KEY, String(appid));
	} catch {
		/* ignore */
	}
	try {
		gamepadWindow()?.Navigate(TV_GAME_ROUTE);
	} catch (e) {
		log('open game failed', String(e));
	}
}

function overview(appid: number): any {
	try {
		return (window as any).appStore?.GetAppOverviewByAppID?.(appid);
	} catch {
		return null;
	}
}

let achListLogged = false;

/** Achievement images come as a filename (or sometimes a full URL). */
function achievementImageUrl(appid: number, img: unknown): string | null {
	if (typeof img !== 'string' || !img) return null;
	if (/^https?:\/\//i.test(img)) return img;
	return `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appid}/${img.replace(/^\/+/, '')}`;
}

/** One fetch per game, shared by every copy of the page; refreshed after 2 minutes. */
function cached<T>(store: Map<number, { at: number; p: Promise<T> }>, appid: number, load: () => Promise<T>): Promise<T> {
	const hit = store.get(appid);
	if (hit && Date.now() - hit.at < 120000) return hit.p;
	const p = load();
	store.set(appid, { at: Date.now(), p });
	p.catch(() => store.delete(appid));
	return p;
}
const achListCache = new Map<number, { at: number; p: Promise<AchievementItem[] | null> }>();
const newsCache = new Map<number, { at: number; p: Promise<NewsItem[]> }>();

/** Full achievement list for the game page. */
async function getAchievementList(appid: number): Promise<AchievementItem[] | null> {
	return cached(achListCache, appid, () => fetchAchievementList(appid));
}

async function fetchAchievementList(appid: number): Promise<AchievementItem[] | null> {
	try {
		const res = await (window as any).SteamClient?.Apps?.GetMyAchievementsForApp?.(String(appid));
		const data = typeof res === 'string' ? JSON.parse(res) : res;
		const raw: any[] = data?.data?.rgAchievements ?? data?.rgAchievements ?? [];
		if (!achListLogged && raw.length) {
			achListLogged = true;
			log('achievement item keys', Object.keys(raw[0]), 'image example:', String(raw[0]?.strImage ?? ''));
		}
		if (!raw.length) return null;
		log('achievements for', appid, raw.length, 'total,', raw.filter((x) => x?.bAchieved).length, 'unlocked');
		return raw.map((x, i) => ({
			id: String(x?.strID ?? x?.id ?? i),
			name: String(x?.strName ?? x?.name ?? ''),
			description: String(x?.strDescription ?? x?.description ?? ''),
			icon: achievementImageUrl(appid, x?.strImage ?? x?.icon),
			unlocked: !!(x?.bAchieved ?? x?.achieved),
			hidden: !!(x?.bHidden ?? x?.hidden),
			unlockedAt: Number(x?.rtUnlocked ?? x?.unlocktime ?? x?.unlock_time ?? 0) || 0,
		}));
	} catch (e) {
		log('achievement list failed', appid, String(e));
		return null;
	}
}

/** Steam announcement text (BBCode/HTML) to plain paragraphs. */
function plainText(raw: string): string {
	return raw
		.replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, '')
		.replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, '')
		.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
		.replace(/\[\*\]/g, '\n• ')
		.replace(/\[\/?(h[1-6])\]/gi, '\n\n')
		.replace(/\[\/?p\]/gi, '\n\n')
		.replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|h\d|li|div)>/gi, '\n\n')
		.replace(/<li[^>]*>/gi, '\n• ')
		.replace(/<[^>]+>/g, '')
		.replace(/{STEAM_CLAN_IMAGE}[^\s]*/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

let newsLogged = false;

async function getNews(appid: number): Promise<NewsItem[]> {
	return cached(newsCache, appid, () => fetchNews(appid));
}

async function fetchNews(appid: number): Promise<NewsItem[]> {
	try {
		// @ts-ignore -- `backend` is injected by Millennium at build time
		const raw: unknown = await backend.get_news(appid);
		if (!raw) {
			if (!newsLogged) log('news: empty response from backend');
			newsLogged = true;
			return [];
		}
		// Millennium may hand back the JSON already parsed into an object.
		const data: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (!data?.appnews && !newsLogged) log('news: unexpected shape', Object.keys(data ?? {}));
		const items: any[] = data?.appnews?.newsitems ?? [];
		if (!newsLogged) log('news ok', appid, items.length, 'items');
		newsLogged = true;
		return items.map((n) => ({
			id: String(n?.gid ?? n?.url ?? Math.random()),
			title: String(n?.title ?? ''),
			date: Number(n?.date) || 0,
			label: /patch|update|hotfix|fix/i.test(String(n?.title ?? '')) ? 'Update' : 'News',
			body: plainText(String(n?.contents ?? '')),
		}));
	} catch (e) {
		log('news failed', appid, String(e));
		return [];
	}
}

const TvGamePage = makeTvGame({
	onMount: (appid) => log('game page created', appid),
	news: getNews,
	currentApp: currentGameApp,
	gameName: (appid) => String(overview(appid)?.display_name ?? 'Game'),
	isInstalled: (appid) => {
		const ov = overview(appid);
		const v = ov?.installed ?? ov?.local_per_client_data?.installed;
		return typeof v === 'boolean' ? v : null;
	},
	play: (appid) => {
		try {
			(window as any).SteamClient?.Apps?.RunGame?.(String(appid), '', -1, 100);
			log('launching', appid);
		} catch (e) {
			log('launch failed', appid, String(e));
		}
	},
	install: (appid) => {
		try {
			(window as any).SteamClient?.Installs?.OpenInstallWizard?.([appid]);
		} catch (e) {
			log('install failed', appid, String(e));
		}
	},
	back: () =>
		setTimeout(() => {
			try {
				gamepadWindow()?.Navigate(TV_ROUTE, true);
			} catch {
				/* ignore */
			}
		}, 0),
	achievementList: getAchievementList,
	achievementIcon,
	controllerLayout: (appid) => navigatorAction('controller layout', appid, /controller|configurator|steaminput/i),
	properties: (appid) => navigatorAction('properties', appid, /propert/i),
	openAchievements: (appid) => navigatorAction('achievements', appid, /^MyAchievements$/),
	stockIcon: (name) => stockIcons[name] ?? null,
});

let navigatorLogged = false;

/** Big Picture's own screen-openers (Navigator.*); logs what exists the first time. */
function navigatorAction(label: string, appid: number, pattern: RegExp) {
	const nav = gamepadWindow()?.Navigator;
	const keys = nav ? Object.keys(nav) : [];
	if (!navigatorLogged) {
		navigatorLogged = true;
		log('navigator functions', keys);
	}
	const matches = keys.filter((k) => pattern.test(k));
	const key = matches[0];
	if (!key) {
		log('option unavailable', label, '- no matching Navigator entry');
		return;
	}
	if (typeof nav[key] !== 'function') {
		const v = nav[key];
		if (v && typeof v.Main === 'function') {
			try {
				v.Main(appid);
				log('option', label, 'via Navigator.' + key + '.Main', appid);
			} catch (e) {
				log('option failed', label, key + '.Main', String(e));
			}
			return;
		}
		log('option', label, 'Navigator.' + key, 'is', typeof v, v && typeof v === 'object' ? Object.keys(v) : String(v).slice(0, 120));
		return;
	}
	try {
		nav[key](appid);
		log('option', label, 'via Navigator.' + key, appid);
	} catch (e) {
		log('option failed', label, key, String(e));
	}
}

let achSourceLogged = false;

/**
 * Achievement progress for an app. Tries Steam's progress cache first (instant),
 * then asks the client for the app's achievement list.
 */
async function getAchievements(appid: number): Promise<{ unlocked: number; total: number } | null> {
	try {
		const map = (window as any).appAchievementProgressCache?.m_achievementProgress?.mapCache;
		const e = map?.get?.(appid) ?? map?.get?.(String(appid));
		if (e && Number(e.total) > 0) {
			if (!achSourceLogged) log('achievements from progress cache');
			achSourceLogged = true;
			return { unlocked: Number(e.unlocked) || 0, total: Number(e.total) };
		}
	} catch {
		/* try the client API */
	}
	try {
		const res = await (window as any).SteamClient?.Apps?.GetMyAchievementsForApp?.(String(appid));
		const data = typeof res === 'string' ? JSON.parse(res) : res;
		const list: any[] = data?.data?.rgAchievements ?? data?.rgAchievements ?? [];
		if (!achSourceLogged) log('achievements from GetMyAchievementsForApp', { appid, keys: Object.keys(data ?? {}), count: list.length });
		achSourceLogged = true;
		if (!list.length) return null;
		return { unlocked: list.filter((x) => x?.bAchieved).length, total: list.length };
	} catch (e) {
		log('achievements failed for', appid, String(e));
		return null;
	}
}

/* Steam's own achievement icon, copied from a game page the first time one is open. */
let bpmDoc: Document | null = null;
let iconCache: string | null | undefined;

function achievementIcon(): string | null {
	return iconCache ?? null;
}

/** Steam's controller and settings glyphs, loaded from icons/*.svg once captured. */
const stockIcons: Record<string, string> = {};
const STOCK_PATTERNS: Record<string, RegExp> = {
	controller: /controller|gamepad/i,
	settings: /settings|gear|cog/i,
};
let svgClassesLogged = false;

/** Look through Steam's windows for its controller/settings icons (by their SVG class names). */
function harvestStockIcons() {
	const missing = Object.keys(STOCK_PATTERNS).filter((n) => !stockIcons[n]);
	if (!missing.length) return;
	const seen = new Set<string>();
	for (const w of steamWindows()) {
		let svgs: SVGElement[] = [];
		try {
			svgs = Array.from(w.document.querySelectorAll('svg')) as SVGElement[];
		} catch {
			continue;
		}
		for (const svg of svgs) {
			if (svg.closest('.tvm-root, .tvg-root, [data-tvmode-copy]')) continue;
			const cls = svg.getAttribute('class') ?? '';
			const readable = cls.split(/\s+/).filter((c) => /^[A-Z][A-Za-z]+$/.test(c) || /^SVGIcon/i.test(c));
			readable.forEach((c) => seen.add(c));
			for (const name of missing) {
				if (stockIcons[name] || !readable.some((c) => STOCK_PATTERNS[name].test(c))) continue;
				const html = cleanSvg(svg);
				if (!html) continue;
				stockIcons[name] = html;
				saveIconFile(name as 'controller' | 'settings', html);
				log('captured stock icon', name, readable);
			}
		}
	}
	if (!svgClassesLogged && seen.size) {
		svgClassesLogged = true;
		log('svg icon names seen', Array.from(seen).slice(0, 80));
	}
}

function saveIconFile(name: 'achievement' | 'perfect' | 'controller' | 'settings', svg: string) {
	try {
		// @ts-ignore -- `backend` is injected by Millennium at build time
		void Promise.resolve(backend.save_icon(name, svg)).then((ok: unknown) => log('saved icon file', name, ok ? 'ok' : 'FAILED'));
	} catch (e) {
		log('saving icon file failed', name, String(e));
	}
}

/** Load icons saved by an earlier capture; capturing only happens if a file is missing. */
async function loadIconFiles() {
	for (const name of ['achievement', 'controller', 'settings'] as const) {
		try {
			// @ts-ignore -- `backend` is injected by Millennium at build time
			const svg: string = (await backend.read_icon(name)) ?? '';
			if (svg.startsWith('<svg')) {
				if (name === 'achievement') iconCache = svg;
				else stockIcons[name] = svg;
				log('loaded icon file', name, svg.length, 'bytes');
			}
		} catch {
			/* backend not ready; capture will fill it */
		}
	}
}

/** Clean copy of an SVG: no scripts, handlers or fixed size. */
function cleanSvg(svg: SVGElement): string | null {
	const copy = svg.cloneNode(true) as SVGElement;
	copy.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
	for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
		for (const attr of Array.from(el.attributes)) {
			if (/^on/i.test(attr.name) || /javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
		}
	}
	// Bring along gradients/patterns it references (url(#id)) that live outside the SVG,
	// and give them unique ids so the copy renders anywhere.
	const doc = svg.ownerDocument;
	const refs = new Set<string>();
	for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
		for (const attr of Array.from(el.attributes)) {
			for (const m of attr.value.matchAll(/url\(#([^)]+)\)/g)) refs.add(m[1]);
		}
	}
	if (refs.size) {
		const defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
		const suffix = '-tvm' + Math.random().toString(36).slice(2, 7);
		for (const id of refs) {
			const src = copy.querySelector(`[id="${id}"]`) ?? doc.getElementById(id);
			if (!src) continue;
			const def = src.cloneNode(true) as Element;
			def.setAttribute('id', id + suffix);
			if (!copy.contains(src)) defs.appendChild(def);
			else src.setAttribute('id', id + suffix);
		}
		copy.insertBefore(defs, copy.firstChild);
		for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
			for (const attr of Array.from(el.attributes)) {
				if (attr.value.includes('url(#')) el.setAttribute(attr.name, attr.value.replace(/url\(#([^)]+)\)/g, `url(#$1${suffix})`));
			}
		}
	}
	copy.removeAttribute('width');
	copy.removeAttribute('height');
	if (!copy.getAttribute('xmlns')) copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	const html = copy.outerHTML;
	return html.length < 20000 ? html : null;
}

/** Steam marks its achievement graphics with classes like "Ribbon"; only those are accepted. */
const ACH_SVG_CLASS = /ribbon|achievement|trophy/i;

function achievementSvgs(doc: Document): SVGElement[] {
	return Array.from(doc.querySelectorAll('svg')).filter((sv) => {
		if (sv.closest(`[${HIDDEN_ATTR}], .tvm-root`)) return false; // not our own copies / hidden bits
		const cls = sv.getAttribute('class') ?? '';
		const r = sv.getBoundingClientRect();
		return ACH_SVG_CLASS.test(cls) && r.width > 0 && r.width <= 96;
	}) as SVGElement[];
}

/** On a game page, copy Steam's achievement ribbon icon. */
function tryCaptureAchievementIcon() {
	if (achievementIcon() || !bpmDoc?.body) return;
	const svg = achievementSvgs(bpmDoc)[0];
	if (!svg) return;
	const html = cleanSvg(svg);
	if (!html) return;
	iconCache = html;
	saveIconFile('achievement', html);
	log('captured achievement icon', { class: svg.getAttribute('class'), length: html.length, hasDefs: /<(linearGradient|radialGradient|pattern)/.test(html) });
}


const desktopLock = createDesktopLock(log, steamWindows, () => (window as any).SteamUIStore?.WindowStore?.MainWindowInstance);

const TvHome = makeTvHome(readTvRows, openGame, getAchievements, achievementIcon);

function methodNames(o: any): string[] {
	const names = new Set<string>(Object.keys(o ?? {}));
	let p = o ? Object.getPrototypeOf(o) : null;
	for (let i = 0; p && i < 3; i++, p = Object.getPrototypeOf(p)) Object.getOwnPropertyNames(p).forEach((n) => names.add(n));
	return Array.from(names).slice(0, 60);
}

function registerTvRoute() {
	const hook = (window as any).__ROUTER_HOOK_INSTANCE;
	log('router hook', hook ? methodNames(hook) : 'missing');
	const add = hook?.addRoute ?? hook?.AddRoute;
	if (typeof add !== 'function') {
		log('no addRoute on router hook; home stays the Collections tab');
		return;
	}
	try {
		add.call(hook, TV_ROUTE, TvHome, { exact: true });
		tvRouteReady = true;
		log('registered', TV_ROUTE);
		add.call(hook, TV_GAME_ROUTE, TvGamePage, { exact: true });
		log('registered', TV_GAME_ROUTE);
	} catch (e) {
		log('addRoute failed', String(e));
	}
}

async function startDesktopLock() {
	try {
		// @ts-ignore -- `backend` is injected by Millennium at build time
		if (await backend.lock_reset_requested()) {
			desktopLock.resetCode();
			log('unlock code reset (reset-lock file found)');
		}
	} catch {
		/* backend not ready; no reset */
	}
	desktopLock.start();
}

function start() {
	registerTvRoute();
	if (CONFIG.lockdown) {
		try {
			startMenuInjector(log, Array.from(MAIN_MENU_ALLOWED), Array.from(MAIN_MENU_KNOWN));
		} catch (e) {
			log('menu injector failed to start', String(e));
		}
	}
	setInterval(() => {
		try {
			watchMenuWindows();
		} catch {
			/* ignore */
		}
	}, 500);
	void loadIconFiles();
	setInterval(() => {
		try {
			harvestStockIcons();
		} catch {
			/* ignore */
		}
	}, 4000);
	if (CONFIG.desktopLock) void startDesktopLock();
	try {
		const millennium = (window as any).Millennium;
		if (CONFIG.windowHook && typeof millennium?.AddWindowCreateHook === 'function') {
			millennium.AddWindowCreateHook(onWindowCreated);
		}
		if (CONFIG.scan) {
			// Big Picture may already be open, or the hook may not fire for it.
			scanForBigPicture();
			setInterval(scanForBigPicture, 750);
		}
	} catch (e) {
		log('startup failed', String(e));
	}
	log('started', loadFlags());
}

export default definePlugin(() => {
	// Millennium calls this during Steam's render; do nothing here that can throw
	// or touch Steam stores. Real startup runs on the next tick.
	setTimeout(start, 0);

	(window as any).tvMode = {
		inspect,
		reveal,
		readCollections,
		set,
		safeMode,
		resetFlags,
		flags: () => ({ ...CONFIG }),
	};

	return {
		title: 'TV Mode',
		icon: <span style={{ marginRight: 5 }}>📺</span>,
		content: <SettingsContent />,
	};
});
