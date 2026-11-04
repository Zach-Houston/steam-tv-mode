import { definePlugin, Field } from 'millennium';
import { heroSources, makeTvHome, TvRow } from './tvhome';
import { AchievementItem, DownloadState, NewsItem, downloadLabel, makeTvGame } from './tvgame';
import { createDesktopLock } from './lock';
import { startMenuInjector } from './menu-cdp';
import { ACH_ROUTE, styleAchievementsPage } from './achpage';

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
const PLAYTIME_LABELS = /^(play\s?time|time played|last played|total played|playtime( on record)?|hours played|(last|past) (two|2) weeks)$/i;
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
const INERT_REASONS = new Set(['top-bar', 'search', 'settings-entry', 'wifi-original', 'library-tab', 'main-menu', 'footer', 'compare', 'avatar']);

function hide(el: Element | null | undefined, reason: string) {
	if (!el || el.hasAttribute(HIDDEN_ATTR)) return;
	el.setAttribute(HIDDEN_ATTR, reason);
	if (INERT_REASONS.has(reason)) {
		el.setAttribute('inert', '');
		el.setAttribute('tabindex', '-1');
		// A hidden text box (the top bar's search) can still get Steam's focus, and A on it opens the
		// on-screen keyboard. Disabled inputs can't take focus or be typed into.
		const inputs = el.matches('input, textarea') ? [el] : Array.from(el.querySelectorAll('input, textarea'));
		inputs.forEach((i) => ((i as HTMLInputElement).disabled = true));
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
/* A running game's entry in the Steam menu: these options are dropped. */
const GAME_MENU_HIDDEN = ['view game details', 'guides', 'notes', 'game recording'];
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
	// No top bar anywhere; the time shows top-right instead. Steam screens' reserved space
	// for it is removed by the PadForHeader rule in attach().
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
/** Steam's Wi-Fi glyph, copied from its hidden top bar. */
let steamWifiSvg: string | null = null;

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
	const wifiItem = Array.from(header.querySelectorAll('[aria-label]')).find((el) =>
		/internet|network|wi-?fi/i.test(el.getAttribute('aria-label') ?? ''),
	);
	const wifiSvg = wifiItem?.querySelector('svg');
	if (wifiSvg) steamWifiSvg = wifiSvg.outerHTML;
	const hasController = Array.from(header.querySelectorAll('[aria-label]')).some((el) =>
		/controller/i.test(el.getAttribute('aria-label') ?? ''),
	);
	const online = doc.defaultView?.navigator.onLine ?? navigator.onLine;
	const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	const sig = `${hasController}|${online}|${time}`;
	if (bar.getAttribute('data-sig') === sig) return;
	bar.setAttribute('data-sig', sig);
	bar.replaceChildren();
	// Steam's own glyphs, white, with a strike through them.
	const warn = (svg: string) => {
		const el = doc.createElement('span');
		el.style.cssText = 'position:relative;display:inline-flex;width:28px;height:28px;';
		const glyph = doc.createElement('span');
		glyph.style.cssText = 'display:inline-flex;width:100%;height:100%;filter:brightness(0) invert(1);';
		glyph.innerHTML = svg;
		glyph.querySelectorAll('svg').forEach((g) => {
			g.removeAttribute('width');
			g.removeAttribute('height');
			(g as SVGElement).style.cssText = 'width:100%;height:100%;';
		});
		const strike = doc.createElement('span');
		strike.style.cssText =
			'position:absolute;left:-2px;right:-2px;top:50%;height:2.5px;margin-top:-1.25px;background:#fff;border-radius:2px;transform:rotate(-45deg);box-shadow:0 0 0 1.5px rgba(0,0,0,.55);';
		el.append(glyph, strike);
		bar!.appendChild(el);
	};
	if (!online) warn(steamWifiSvg ?? WARN_ICONS.internet);
	if (!hasController) warn(stockIcons.controller ?? WARN_ICONS.controller);
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
	// Text boxes Steam re-creates inside hidden areas: keep them disabled (see hide()).
	doc.querySelectorAll<HTMLInputElement>(`[${HIDDEN_ATTR}] input:not([disabled]), [${HIDDEN_ATTR}] textarea:not([disabled])`).forEach((i) => {
		const reason = i.closest(`[${HIDDEN_ATTR}]`)?.getAttribute(HIDDEN_ATTR) ?? '';
		if (INERT_REASONS.has(reason)) i.disabled = true;
	});
	try {
		styleAchievementsPage(doc, currentRoute(), hide, log);
	} catch (e) {
		log('achievements styling failed', String(e));
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

/* ------------------------------------------------------------------ *
 * Steam's own row-move sound. Steam plays a sound when its navigation moves focus between rows,
 * but not when we move focus ourselves (the carousel wrap). We watch what Steam plays right after
 * a normal up/down move and replay exactly that on a wrap, so both sound the same.
 * ------------------------------------------------------------------ */
type CapturedSound =
	| { kind: 'media'; win: any; src: string; volume: number }
	| { kind: 'buffer'; ctx: any; buffer: any; dest: any };
let lastVerticalMoveAt = 0;
let rowMoveSound: CapturedSound | null = null;
let replayingSound = false;
const loggedSounds = new Set<string>();

function onSteamSound(snd: CapturedSound) {
	if (replayingSound) return;
	const since = Date.now() - lastVerticalMoveAt;
	const key = snd.kind === 'media' ? snd.src : `buffer ${snd.buffer?.duration?.toFixed?.(3)}s`;
	if (loggedSounds.size < 12 && !loggedSounds.has(key)) {
		loggedSounds.add(key);
		log('steam sound', key, 'ms after up/down:', since);
	}
	if (since < 250) rowMoveSound = snd;
}

function installSoundHook(win: any) {
	if (!win || win.__tvmodeSoundHook) return;
	win.__tvmodeSoundHook = true;
	try {
		const dests = new WeakMap<object, any>();
		const nodeProto = win.AudioNode?.prototype;
		const origConnect = nodeProto?.connect;
		if (origConnect) {
			nodeProto.connect = function (this: any, dest: any, ...rest: any[]) {
				try {
					if (win.AudioBufferSourceNode && this instanceof win.AudioBufferSourceNode && !dests.has(this)) dests.set(this, dest);
				} catch {
					/* ignore */
				}
				return origConnect.call(this, dest, ...rest);
			};
		}
		const srcProto = win.AudioBufferSourceNode?.prototype;
		const origStart = srcProto?.start;
		if (origStart) {
			srcProto.start = function (this: any, ...args: any[]) {
				try {
					if (this.buffer) onSteamSound({ kind: 'buffer', ctx: this.context, buffer: this.buffer, dest: dests.get(this) });
				} catch {
					/* ignore */
				}
				return origStart.apply(this, args);
			};
		}
		const mediaProto = win.HTMLMediaElement?.prototype;
		const origPlay = mediaProto?.play;
		if (origPlay) {
			mediaProto.play = function (this: any, ...args: any[]) {
				try {
					const src = this.currentSrc || this.src;
					if (src && /\/sounds\//.test(src)) onSteamSound({ kind: 'media', win, src, volume: this.volume });
				} catch {
					/* ignore */
				}
				return origPlay.apply(this, args);
			};
		}
	} catch (e) {
		log('sound hook failed', String(e));
	}
}

function replayRowMoveSound() {
	const snd = rowMoveSound;
	if (!snd) {
		log('carousel wrap: no row-move sound captured yet');
		return;
	}
	replayingSound = true;
	try {
		if (snd.kind === 'media') {
			const a = new snd.win.Audio(snd.src);
			a.volume = snd.volume;
			a.play()?.catch?.(() => {});
		} else {
			const n = snd.ctx.createBufferSource();
			n.buffer = snd.buffer;
			n.connect(snd.dest ?? snd.ctx.destination);
			n.start();
		}
	} catch (e) {
		log('carousel wrap: replay failed', String(e));
	} finally {
		replayingSound = false;
	}
}

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
	installSoundHook(window);
	installSoundHook(doc.defaultView);

	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent =
		`[${HIDDEN_ATTR}] { display: none !important; }\n` +
		// Steam pages reserve 40px top and bottom for Big Picture's bars; with the top bar gone that
		// shows as black strips. Let them fill the screen (the bottom bar, where shown, overlays it).
		`[class~="PadForHeader"] { padding-top: 0 !important; padding-bottom: 0 !important; }`;
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

	// Controller input arrives as Steam "vgp_" events on the focused element. On the carousel,
	// up from the top row wraps to the bottom row and down from the bottom row wraps to the top,
	// so focus never reaches the hidden top bar and there's no "dead end" sound.
	const DIR_UP = 9; // Steam's EGamepadButton.DIR_UP
	const DIR_DOWN = 10; // Steam's EGamepadButton.DIR_DOWN
	const LSTICK_UP = 23;
	const LSTICK_DOWN = 24;
	const BTN_A = 1; // EGamepadButton.OK
	let vgpLogged = 0;
	let lastWrap = 0;
	let lastDir: 'up' | 'down' | 'other' = 'other';
	let achLogged = 0;
	const lastTileInRow = new WeakMap<Element, HTMLElement>();
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
				// A on something hidden (the top bar's search box, which Steam's focus can still reach)
				// would open search and the keyboard. Swallow it and put focus back on the screen.
				if (detail.button === BTN_A) {
					const focused = Array.from(doc.querySelectorAll<HTMLElement>('.gpfocus')).pop() ?? null;
					const header = headerCache.get(doc)?.header;
					const hiddenFocus =
						!!focused && (!!focused.closest(`[${HIDDEN_ATTR}]`) || (!!header && header.contains(focused) && !focused.closest('[data-tvmode-copy]')));
					if (hiddenFocus) {
						e.preventDefault();
						e.stopImmediatePropagation();
						if (type === 'vgp_onbuttondown') {
							const back =
								doc.querySelector<HTMLElement>('.tvg-panel .tvg-row, .tvg-panel .tvg-para') ??
								doc.querySelector<HTMLElement>('.tvg-play') ??
								(lastTile?.isConnected ? lastTile : doc.querySelector<HTMLElement>('.tvm-tile')) ??
								(lastGood?.isConnected ? lastGood : null);
							log('A on hidden element blocked', describe(focused!), '→', back ? describe(back) : 'nothing');
							back?.focus();
						}
						return;
					}
				}
				if (type === 'vgp_onbuttondown') {
					const b = detail.button;
					lastDir = b === DIR_UP || b === LSTICK_UP ? 'up' : b === DIR_DOWN || b === LSTICK_DOWN ? 'down' : 'other';
				}
				// Steam's achievements page. Above the tabs is only the hidden top bar (its search box pops
				// up the keyboard), and between the tabs and the first achievement sits the removed
				// "Compare to..." box. Steer around both: up from the tabs stops, down from the tabs goes
				// straight to the first achievement, up from the first achievement goes back to the tabs.
				if (ACH_ROUTE.test(currentRoute())) {
					const b = detail.button;
					const isUp = b === DIR_UP || b === LSTICK_UP;
					const isDown = b === DIR_DOWN || b === LSTICK_DOWN;
					if (isUp || isDown) {
						const focused = Array.from(doc.querySelectorAll<HTMLElement>('.gpfocus')).pop() ?? null;
						if (achLogged < 30 && type === 'vgp_onbuttondown') {
							achLogged++;
							log('ach nav', isUp ? 'up' : 'down', focused ? describe(focused) : 'no gpfocus', 'active:', doc.activeElement ? describe(doc.activeElement) : '-');
						}
						const inTabs = !!focused?.closest('.TabRow') || !!doc.querySelector('.TabRow .gpfocus');
						const firstItem = doc.querySelector<HTMLElement>('[data-tvm-ach-item]');
						const onFirst = !!firstItem && !!focused && (focused === firstItem || firstItem.contains(focused));
						let to: HTMLElement | null | undefined;
						let stop = false;
						// Above the content area there's only the tabs and the progress header; nothing to go up to.
						const inContent = !!focused?.closest('.TabContents, .AchievementList');
						if (isUp && (inTabs || !inContent)) stop = true;
						else if (inTabs && isDown) to = firstItem;
						else if (onFirst && isUp) to = doc.querySelector<HTMLElement>('.TabRow .Tab.Selected') ?? doc.querySelector<HTMLElement>('.TabRow .Tab');
						if (stop || to) {
							e.preventDefault();
							e.stopImmediatePropagation();
							if (to && type === 'vgp_onbuttondown') to.focus();
							return;
						}
					}
				}
				if (!currentRoute().toLowerCase().startsWith(TV_ROUTE)) return;
				const up = detail.button === DIR_UP || detail.button === LSTICK_UP;
				const down = detail.button === DIR_DOWN || detail.button === LSTICK_DOWN;
				if (!up && !down) return;
				const tile = focusedTile() ?? (e.target as Element);
				const row = tile?.closest?.('.tvm-row');
				if (!row || !tile?.closest?.('.tvm-tile')) return;
				const rows = Array.from(doc.querySelectorAll('.tvm-root .tvm-row'));
				const idx = rows.indexOf(row);
				if (idx < 0) return;
				if (up ? idx !== 0 : idx !== rows.length - 1) {
					// Normal move: Steam handles it; note the time so we can learn its sound.
					if (type === 'vgp_onbuttondown') lastVerticalMoveAt = Date.now();
					return;
				}
				e.preventDefault();
				e.stopImmediatePropagation();
				if (type !== 'vgp_onbuttondown' || rows.length < 2) return;
				const now = Date.now();
				if (now - lastWrap < 250) return; // a held stick shouldn't spin through the rows
				lastWrap = now;
				const target = rows[up ? rows.length - 1 : 0];
				const remembered = lastTileInRow.get(target);
				const dest = remembered?.isConnected && target.contains(remembered) ? remembered : target.querySelector<HTMLElement>('.tvm-tile');
				if (!dest) return;
				dest.focus();
				replayRowMoveSound();
				setTimeout(() => {
					if (!dest.classList.contains('gpfocus')) log('carousel wrap: focus did not take', describe(dest));
				}, 150);
			},
			true,
		);
	}

	let lastTile: HTMLElement | null = null;
	let lastGood: HTMLElement | null = null;
	const loggedFocus = new Set<string>();
	doc.addEventListener(
		'focusin',
		(e) => {
			const t = e.target as HTMLElement | null;
			if (!t) return;
			if (t.closest('.tvm-root')) {
				const tile = t.closest<HTMLElement>('.tvm-tile');
				if (tile) {
					lastTile = tile;
					const row = tile.closest('.tvm-row');
					if (row) lastTileInRow.set(row, tile);
				}
				return;
			}
			// Only pull focus back when it lands on something hidden (top bar, search…).
			// Menus and dialogs (power menu, etc.) must keep their focus.
			const header = headerCache.get(doc)?.header;
			const inHidden = !!t.closest(`[${HIDDEN_ATTR}]`) || (!!header && header.contains(t) && !t.closest('[data-tvmode-copy]'));
			if (ACH_ROUTE.test(currentRoute()) && achLogged < 30) {
				achLogged++;
				log('ach focus', describe(t), 'hidden:', inHidden, 'in TabRow:', !!t.closest('.TabRow'));
			}
			if (!inHidden) {
				lastGood = t;
				return;
			}
			const desc = describe(t);
			if (!loggedFocus.has(desc)) {
				loggedFocus.add(desc);
				log('focus guard: focus left the carousel to', desc, 'hidden:', inHidden);
			}
			// Steam's achievements page: skip over the removed "Compare to..." entry in the direction
			// of travel (it sits between the tabs and the first achievement).
			if (ACH_ROUTE.test(currentRoute())) {
				const next =
					lastDir === 'up'
						? doc.querySelector<HTMLElement>('.TabRow .Tab.Selected') ?? doc.querySelector<HTMLElement>('.TabRow .Tab')
						: doc.querySelector<HTMLElement>('[data-tvm-ach-item]');
				const target = next ?? (lastGood?.isConnected ? lastGood : null);
				if (target) setTimeout(() => target.focus(), 0);
				else t.blur?.();
				return;
			}
			const back = lastTile?.isConnected ? lastTile : doc.querySelector<HTMLElement>('.tvm-tile');
			if (back) setTimeout(() => back.focus(), 0);
			else if (lastGood?.isConnected) setTimeout(() => lastGood!.focus(), 0);
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

function hideCoverNow() {
	const el = coverEl;
	if (!el) return;
	coverEl = null;
	el.remove();
}

/** Steam's own page for a TV game, which TV Mode always replaces with its own. */
function isSteamTvGamePage(route: string): boolean {
	const m = route.match(/^\/library\/app\/(\d+)\/?$/i);
	return !!m && tvApps.has(m[1]);
}

function hideCover() {
	const el = coverEl;
	if (!el) return;
	coverEl = null;
	el.style.opacity = '0';
	setTimeout(() => el.remove(), 300);
}

/** Diagnostics: what is drawn along the top and bottom edges of the screen. */
const edgesLogged = new Set<string>();
function logEdges(doc: Document, route: string) {
	const key = route.replace(/\d+/g, '#');
	if (edgesLogged.has(key)) return;
	edgesLogged.add(key);
	const win = doc.defaultView;
	if (!win) return;
	const w = win.innerWidth;
	const h = win.innerHeight;
	const at = (x: number, y: number) => {
		const el = doc.elementFromPoint(x, y);
		if (!el) return 'nothing';
		const chain: string[] = [];
		for (let e: Element | null = el, i = 0; e && i < 5; e = e.parentElement, i++) {
			const cs = win.getComputedStyle(e);
			const r = e.getBoundingClientRect();
			chain.push(
				`${e.tagName.toLowerCase()}.${(e.getAttribute('class') ?? '').split(/\s+/).filter((c) => /^[A-Z]/.test(c)).slice(0, 2).join('.')}` +
					` [${Math.round(r.top)}-${Math.round(r.bottom)}] bg=${cs.backgroundColor} pad=${cs.paddingTop}/${cs.paddingBottom}` +
					(e.closest('[' + HIDDEN_ATTR + ']') ? ' HIDDEN-ANCESTOR' : ''),
			);
		}
		return chain;
	};
	log('edges on', key, { size: `${w}x${h}`, top: at(w / 2, 6), belowTop: at(w / 2, 70), bottom: at(w / 2, h - 6), aboveBottom: at(w / 2, h - 70) });
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
		if (v.allow && route && coverEl && !isSteamTvGamePage(route)) hideCover();
		if (CONFIG.lockdown) steamGamePageToTv(route);
		try {
			updateRunningScreen(route);
		} catch (e) {
			log('running screen failed', String(e));
		}
		if (changed && bpmDoc && CONFIG.lockdown) {
			try {
				trimHeader(bpmDoc);
				trimFooter(bpmDoc);
			} catch {
				/* ignore */
			}
			if (/controllerconfigurator|achievements|properties/i.test(route)) {
				const doc = bpmDoc;
				setTimeout(() => logEdges(doc, route), 1500);
			}
		}
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
			// Display name without the "TV" prefix (e.g. "TV - Singleplayer" → "Singleplayer").
			const display = name.replace(/^tv\b[\s\-–—·:|_]*/i, '').trim() || name;
			rows.push({ id: String(c?.id ?? name), name: display, games });
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

/* Big Picture's own UI sounds (shipped with Steam), played in the Big Picture window. */
const UI_SOUNDS = {
	activate: 'deck_ui_default_activation.wav',
	intoGame: 'deck_ui_into_game_detail.wav',
	outOfGame: 'deck_ui_out_of_game_detail.wav',
	launch: 'deck_ui_launch_game.wav',
} as const;
type UiSound = keyof typeof UI_SOUNDS;
const soundFailed = new Set<string>();

function playUiSound(name: UiSound) {
	const file = UI_SOUNDS[name];
	if (soundFailed.has(file)) return;
	try {
		const win: any = bpmDoc?.defaultView ?? window;
		const audio = new win.Audio(`https://steamloopback.host/sounds/${file}`);
		audio.volume = 0.8;
		const p = audio.play();
		p?.catch?.((e: unknown) => {
			if (soundFailed.has(file)) return;
			soundFailed.add(file);
			log('ui sound failed', file, String(e));
		});
	} catch (e) {
		soundFailed.add(file);
		log('ui sound failed', file, String(e));
	}
}

function openGame(appid: number) {
	playUiSound('intoGame');
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

/**
 * Installed on THIS PC. Steam's overview also knows about other PCs on the account
 * (per_client_data), and its general "installed" flag can be true because of those, so the
 * local entry wins.
 */
const installLogged = new Set<number>();
function installedHere(appid: number): boolean | null {
	const ov = overview(appid);
	if (!ov) return null;
	let local: unknown;
	let anyClient: unknown;
	try {
		local = ov.local_per_client_data?.installed;
		const pcd = ov.per_client_data;
		if (Array.isArray(pcd)) {
			const here = pcd.find((c: any) => String(c?.clientid ?? '') === '0');
			anyClient = here?.installed;
		}
	} catch {
		/* ignore */
	}
	if (!installLogged.has(appid)) {
		installLogged.add(appid);
		log('install state', appid, { local, localClient: anyClient });
	}
	const ds = displayStatus(appid);
	if (ds != null && (NOT_INSTALLED.has(ds) || FIRST_INSTALL.has(ds))) return false;
	if (typeof local === 'boolean') return local;
	if (typeof anyClient === 'boolean') return anyClient;
	// Installed games always carry install info for this PC; an overview without any is a game
	// that isn't installed here (seen with ELDEN RING: no local data at all).
	return false;
}

let underlay: HTMLElement | null = null;
let underlayLogged = false;
/**
 * A plain dark sheet placed directly beneath Steam's pop-up (same parent, same z-index, just
 * before it), so the pop-up stays on top and Steam's game page underneath is never visible.
 * It stays until we've left Steam's game page, so closing the pop-up doesn't flash the page.
 */
function showUnderlay(dialog: Element) {
	if (underlay?.isConnected && underlay.nextElementSibling === dialog) return;
	underlay?.remove();
	const doc = dialog.ownerDocument;
	const win = doc.defaultView ?? window;
	const z = win.getComputedStyle(dialog).zIndex;
	const d = doc.createElement('div');
	d.id = 'tvmode-underlay';
	// Same z-index as the pop-up (or none), inserted before it: drawn right underneath it.
	d.style.cssText = `position:fixed;inset:0;background:#0a0c11;pointer-events:none;z-index:${z};`;
	dialog.parentElement?.insertBefore(d, dialog);
	underlay = d;
	if (!underlayLogged) {
		underlayLogged = true;
		const chain: string[] = [];
		for (let n: Element | null = dialog; n && chain.length < 8; n = n.parentElement) {
			const cs = win.getComputedStyle(n);
			chain.push(`${n.tagName.toLowerCase()}.${(n.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.length < 18).join('.')} pos=${cs.position} z=${cs.zIndex} kids=${n.parentElement?.children.length ?? 0}`);
		}
		log('install pop-up underlay', 'dialog z:', z, chain);
	}
}

function hideUnderlay() {
	underlay?.remove();
	underlay = null;
}

let installGraceUntil = 0;
/**
 * Big Picture's install pop-up is what Steam shows when you start a game that isn't installed
 * (the desktop install wizard doesn't appear in Big Picture). Steam opens it over its own game
 * page, so that page is masked the moment the pop-up appears, and we go back to TV Mode's game
 * page once it closes.
 */
function openInstall(appid: number) {
	playUiSound('activate');
	installGraceUntil = Date.now() + 3000;
	try {
		(window as any).SteamClient?.Apps?.RunGame?.(String(appid), '', -1, 100);
		log('install via launch', appid);
	} catch (e) {
		log('install failed', appid, String(e));
		return;
	}
	if (bpmDoc) showCover(bpmDoc);
	// Check often while this is going on, so the pop-up appearing and closing are both caught
	// within a frame or two. Stops once we're back on TV Mode's page (or after a minute).
	const start = Date.now();
	const t = setInterval(() => {
		const route = currentRoute();
		const elapsed = Date.now() - start;
		if (elapsed > 60000 || (elapsed > 1500 && !isSteamTvGamePage(route))) return clearInterval(t);
		steamGamePageToTv(route);
	}, 30);
}

let lastGamePageRedirect = 0;
let lastDialogLog = 0;
/** Steam sends some flows (launching an uninstalled game, cancelling install) to its own game page. */
function steamGamePageToTv(route: string) {
	const m = route.match(/^\/library\/app\/(\d+)\/?$/i);
	if (!m || !tvApps.has(m[1]) || !bpmDoc) {
		hideUnderlay();
		return;
	}
	const now = Date.now();
	const dialog = bpmDoc.querySelector('.ModalPosition, [class*="ModalPosition"], .GamepadDialogContent, [role="dialog"]');
	if (dialog) {
		showUnderlay(dialog);
		hideCoverNow(); // the cover sits above everything, the pop-up included
		installGraceUntil = 0; // the pop-up is up; once it closes, go straight back
		if (now - lastDialogLog > 5000) {
			lastDialogLog = now;
			log('steam game page: hidden behind dialog until it closes', describe(dialog));
		}
		return;
	}
	// Right after asking for the install pop-up, Steam may show its page a moment before the pop-up.
	if (now < installGraceUntil) return;
	if (now - lastGamePageRedirect < 1000) return;
	lastGamePageRedirect = now;
	showCover(bpmDoc); // hides Steam's page (the pop-up is gone) until /tvgame is showing
	const appid = Number(m[1]);
	tvGameApp = appid;
	try {
		window.sessionStorage.setItem(GAME_KEY, String(appid));
	} catch {
		/* ignore */
	}
	try {
		gamepadWindow()?.Navigate(TV_GAME_ROUTE, true);
		log('steam game page → tv game page', appid);
	} catch (e) {
		log('steam game page redirect failed', String(e));
	}
}

/* --------------------------- Downloads --------------------------- */

function openDownloadsScreen() {
	playUiSound('activate');
	const w = gamepadWindow();
	try {
		if (typeof w?.Navigator?.Downloads === 'function') w.Navigator.Downloads();
		else w?.Navigate('/downloads');
		log('opened downloads');
	} catch (e) {
		log('open downloads failed', String(e));
	}
}

/** Everything Steam says about this game's install/download state, logged on each button press. */
function logPrimaryPress(button: string, appid: number) {
	try {
		const ov = overview(appid);
		const item = dlItems.find((i) => Number(i?.appid) === appid);
		log('primary button', button, appid, {
			installedHere: installedHere(appid),
			download: downloadState(appid),
			queueItem: item ?? null,
			queueSize: dlItems.length,
			currentDownload: dlOverview ? { appid: dlOverview.update_appid, state: dlOverview.update_state, paused: dlOverview.paused } : null,
			local: ov?.local_per_client_data ?? null,
			perClient: ov?.per_client_data ?? null,
			displayStatus: ov?.display_status,
		});
	} catch (e) {
		log('primary button log failed', String(e));
	}
}

let dlItems: any[] = [];
let dlOverview: any = null;
let dlWatching = false;
let dlLoggedItems = false;
let dlLoggedOverview = false;

/** Subscribe once to Steam's download queue and current-download progress. */
function watchDownloads() {
	if (dlWatching) return;
	dlWatching = true;
	const D = (window as any).SteamClient?.Downloads;
	if (!D) {
		log('downloads: SteamClient.Downloads missing');
		return;
	}
	try {
		D.RegisterForDownloadItems?.((a: any, b: any) => {
			const raw: any[] = Array.isArray(a) ? a : Array.isArray(b) ? b : [];
			// Grouped per PC: [{ remote_client_id: "0", item_data: [...] }]. "0" is this PC.
			const items: any[] = [];
			for (const r of raw) {
				if (Array.isArray(r?.item_data)) {
					if (String(r.remote_client_id ?? '0') === '0') items.push(...r.item_data);
				} else if (r?.appid != null) items.push(r);
			}
			dlItems = items;
			if (!dlLoggedItems && items.length) {
				dlLoggedItems = true;
				log('downloads: items', items.slice(0, 3));
			}
		});
	} catch (e) {
		log('downloads: items register failed', String(e));
	}
	try {
		D.RegisterForDownloadOverview?.((ov: any) => {
			dlOverview = ov;
			if (!dlLoggedOverview && ov && Number(ov.update_appid)) {
				dlLoggedOverview = true;
				log('downloads: overview', ov);
			}
		});
	} catch (e) {
		log('downloads: overview register failed', String(e));
	}
}

/*
 * Steam's per-game display status (EDisplayStatus). Seen: ELDEN RING sat at 22 with
 * "installed: true" right after its install was queued, so "installed" alone isn't enough.
 */
const DS = {
	Installing: 3,
	Validating: 5,
	Updating: 6,
	Downloading: 7,
	ReadyToInstall: 9,
	UpdatePaused: 17,
	UpdateQueued: 18,
	DownloadPaused: 21,
	DownloadQueued: 22,
	DownloadRequired: 23,
} as const;
/** First install still in progress: not playable yet. */
const FIRST_INSTALL = new Set<number>([DS.Installing, DS.Downloading, DS.DownloadPaused, DS.DownloadQueued]);
const NOT_INSTALLED = new Set<number>([DS.ReadyToInstall, DS.DownloadRequired]);

function displayStatus(appid: number): number | null {
	try {
		const ov = overview(appid);
		const v = ov?.local_per_client_data?.display_status ?? ov?.display_status;
		return typeof v === 'number' ? v : null;
	} catch {
		return null;
	}
}

function downloadState(appid: number): DownloadState | null {
	watchDownloads();
	const ds = displayStatus(appid);
	const ov = dlOverview;
	const active = !!ov && Number(ov.update_appid) === appid && String(ov.update_state ?? 'None') !== 'None';
	// Only real queue entries; the list also holds deferred auto-updates (queue_index -1).
	const item = dlItems.find((i) => Number(i?.appid) === appid && !i.completed && (i.active || Number(i.queue_index) >= 0));
	const firstInstall = ds != null && FIRST_INSTALL.has(ds);
	// Updates for installed games only show while they're actually downloading.
	if (!active && !firstInstall && !(item && ds != null && FIRST_INSTALL.has(ds))) return null;

	const paused = !!item?.paused || (active && !!ov.paused) || ds === DS.DownloadPaused || ds === DS.UpdatePaused;
	let phase: DownloadState['phase'];
	if (paused) phase = 'paused';
	else if (active) phase = ds === DS.Installing || ds === DS.Validating ? 'installing' : 'downloading';
	else phase = 'queued';

	let percent: number | null = null;
	let secondsLeft: number | null = null;
	let bytesPerSecond: number | null = null;
	if (active) {
		const p = Number(ov.overall_percent_complete);
		if (isFinite(p) && p > 0) percent = p;
		const left = Number(ov.overall_estimated_time_remaining_sec);
		if (isFinite(left) && left > 0) secondsLeft = left;
		bytesPerSecond = Number(ov.update_network_bytes_per_second) || null;
	}
	if (percent == null) {
		const sp = Number(overview(appid)?.local_per_client_data?.status_percentage);
		if (isFinite(sp) && sp > 0 && phase !== 'queued') percent = sp;
	}
	return { phase, percent, bytesPerSecond, secondsLeft };
}

/* --------------------------- Running games --------------------------- */

let lastLaunchedApp: number | null = null;
let runningShapeLogged = false;

function runningAppIds(): number[] {
	try {
		const ra = (window as any).SteamUIStore?.RunningApps;
		const list: any[] = Array.isArray(ra) ? ra : ra && typeof ra[Symbol.iterator] === 'function' ? Array.from(ra) : [];
		if (!runningShapeLogged && list.length) {
			runningShapeLogged = true;
			log('running apps', list.slice(0, 2).map((a) => (a && typeof a === 'object' ? Object.keys(a).slice(0, 12) : a)), list.map((a) => a?.appid));
		}
		return list.map((a) => Number(a?.appid ?? a)).filter((n) => n > 0);
	} catch {
		return [];
	}
}

/** 'launching' / 'playing' while Steam is starting or running this game, else null. */
function runState(appid: number): 'launching' | 'playing' | null {
	const ds = displayStatus(appid);
	if (ds === 1) return 'launching'; // EDisplayStatus.Launching
	if (ds === 4 || runningAppIds().includes(appid)) return 'playing'; // Running
	return null;
}

let runningEl: HTMLElement | null = null;
let runningFor = -1;
/**
 * Big Picture's own "game running" screen is empty (just the clock once its top bar is gone),
 * and it's what you look at while a game starts. Cover it with the game's art and its state.
 */
function updateRunningScreen(route: string) {
	const doc = bpmDoc;
	if (!doc || !route.toLowerCase().startsWith('/apprunning')) {
		runningEl?.remove();
		runningEl = null;
		runningFor = -1;
		return;
	}
	const appid = runningAppIds()[0] ?? lastLaunchedApp ?? tvGameApp;
	if (!appid) return;
	if (!runningEl?.isConnected || runningFor !== appid) {
		runningEl?.remove();
		runningFor = appid;
		const el = doc.createElement('div');
		el.id = 'tvmode-running';
		el.style.cssText = 'position:fixed;inset:0;z-index:900;pointer-events:none;background:#0a0c11;color:#fff;overflow:hidden;';
		const art = heroSources(appid).map((u) => `url("${u}") center top / cover no-repeat`).join(', ');
		el.innerHTML =
			`<div style="position:absolute;inset:-3%;background:${art};opacity:.55;filter:saturate(1.1)"></div>` +
			'<div style="position:absolute;inset:0;background:linear-gradient(0deg, rgba(10,12,17,.97) 0%, rgba(10,12,17,.55) 55%, rgba(10,12,17,.35) 100%)"></div>' +
			'<div style="position:absolute;left:0;right:0;bottom:16vh;text-align:center;padding:0 10%">' +
			'<div data-k="name" style="font-size:56px;font-weight:800;line-height:1.1"></div>' +
			'<div data-k="state" style="margin-top:14px;font-size:24px;font-weight:700;color:#5cb8ff"></div>' +
			'<div style="margin-top:18px;font-size:17px;color:#9aa4b8">Press the Steam button for game options</div>' +
			'</div>';
		doc.body.appendChild(el);
		runningEl = el;
	}
	const name = String(overview(appid)?.display_name ?? '');
	const state = runState(appid) === 'playing' ? 'Now playing' : 'Launching…';
	const n = runningEl.querySelector<HTMLElement>('[data-k="name"]');
	const st = runningEl.querySelector<HTMLElement>('[data-k="state"]');
	if (n && n.textContent !== name) n.textContent = name;
	if (st && st.textContent !== state) st.textContent = state;
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
		log('achievements for', appid, raw.length, 'total,', raw.filter((x) => x?.bAchieved).length, 'unlocked; global % sample', raw.slice(0, 6).map((x) => [x?.strName, x?.flAchieved]));
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
const CLAN_IMAGES = 'https://clan.akamai.steamstatic.com/images';
/** Marks an image paragraph in a post body: "\u0001img:<url>". */
const IMG_MARK = '\u0001img:';

function resolveImage(url: string): string {
	return url.trim().replace(/^\{STEAM_CLAN_IMAGE\}/, CLAN_IMAGES).replace(/^http:\/\//, 'https://');
}

/** Image URLs in a post, in order (BBCode [img]…[/img], [img src="…"], or HTML <img src="…">). */
function postImages(raw: string): string[] {
	const out: string[] = [];
	const re = /\[img(?:\s+src="([^"]+)")?[^\]]*\]([\s\S]*?)\[\/img\]|<img[^>]*src="([^"]+)"[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw))) {
		const url = (m[1] || m[2] || m[3] || '').trim();
		if (url && /^(\{STEAM_CLAN_IMAGE\}|https?:)/i.test(url)) out.push(resolveImage(url));
	}
	return out;
}

function plainText(raw: string): string {
	return raw
		// Keep images as their own paragraphs; the post view shows them.
		.replace(/\[img(?:\s+src="([^"]+)")?[^\]]*\]([\s\S]*?)\[\/img\]/gi, (_m, a, b) => {
			const url = String(a || b || '').trim();
			return url ? `\n\n${IMG_MARK}${resolveImage(url)}\n\n` : '';
		})
		.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (_m, a) => `\n\n${IMG_MARK}${resolveImage(String(a))}\n\n`)
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
			image: postImages(String(n?.contents ?? ''))[0] ?? null,
		}));
	} catch (e) {
		log('news failed', appid, String(e));
		return [];
	}
}

let detailsApiLogged = false;
const detailsLoadedAt = new Map<number, number>();

/**
 * Steam's own game page registers for the app's details, which loads achievement data with
 * global percentages. Our TV page skips that page, so do the same registration here.
 */
function loadSteamAppDetails(appid: number) {
	const store = (window as any).appDetailsStore;
	if (!detailsApiLogged) {
		detailsApiLogged = true;
		const names = new Set<string>(Object.keys(store ?? {}));
		let p = store ? Object.getPrototypeOf(store) : null;
		for (let i = 0; p && i < 3; i++, p = Object.getPrototypeOf(p)) Object.getOwnPropertyNames(p).forEach((n) => names.add(n));
		log('appDetailsStore', store ? Array.from(names).filter((n) => /regist|request|achiev|load|fetch/i.test(n)) : 'missing');
	}
	const last = detailsLoadedAt.get(appid) ?? 0;
	if (Date.now() - last < 60000) return;
	detailsLoadedAt.set(appid, Date.now());
	try {
		const sub = store?.RegisterForAppData?.(appid, () => {});
		// Keep the registration alive long enough for the data (and global %) to arrive.
		setTimeout(() => {
			try {
				if (typeof sub === 'function') sub();
				else sub?.unregister?.();
			} catch {
				/* ignore */
			}
		}, 30000);
		setTimeout(() => {
			try {
				const ach = store?.GetAchievements?.(appid);
				const sample = [...(ach?.vecHighlight ?? []), ...(ach?.vecUnachieved ?? [])].slice(0, 4).map((a: any) => [a?.strName, a?.flAchieved]);
				log('steam details for', appid, sub ? 'registered' : 'no RegisterForAppData', 'global % sample', sample);
			} catch (e) {
				log('steam details check failed', String(e));
			}
		}, 3000);
	} catch (e) {
		log('steam details load failed', appid, String(e));
	}
}

const TvGamePage = makeTvGame({
	debug: (...a) => log(...a),
	onMount: (appid) => {
		log('game page created', appid);
		loadSteamAppDetails(appid);
	},
	news: getNews,
	currentApp: currentGameApp,
	gameName: (appid) => String(overview(appid)?.display_name ?? 'Game'),
	isInstalled: (appid) => installedHere(appid),
	play: (appid) => {
		logPrimaryPress('play', appid);
		if (downloadState(appid)) {
			openDownloadsScreen();
			return;
		}
		if (installedHere(appid) === false) {
			openInstall(appid);
			return;
		}
		if (runState(appid)) {
			log('already running', appid);
			return;
		}
		playUiSound('launch');
		lastLaunchedApp = appid;
		try {
			(window as any).SteamClient?.Apps?.RunGame?.(String(appid), '', -1, 100);
			log('launching', appid);
		} catch (e) {
			log('launch failed', appid, String(e));
		}
	},
	install: (appid) => {
		logPrimaryPress('install', appid);
		if (downloadState(appid)) openDownloadsScreen();
		else openInstall(appid);
	},
	download: (appid) => downloadState(appid),
	running: (appid) => runState(appid),
	openDownloads: () => openDownloadsScreen(),
	back: () =>
		setTimeout(() => {
			playUiSound('outOfGame');
			try {
				gamepadWindow()?.Navigate(TV_ROUTE, true);
			} catch {
				/* ignore */
			}
		}, 0),
	achievementList: getAchievementList,
	achievementIcon,
	controllerLayout: (appid) => {
		playUiSound('activate');
		navigatorAction('controller layout', appid, /controller|configurator|steaminput/i);
	},
	properties: (appid) => {
		playUiSound('activate');
		navigatorAction('properties', appid, /propert/i);
	},
	sound: () => playUiSound('activate'),
	openAchievements: (appid) => {
		playUiSound('activate');
		// Make sure Steam has the full details first, then open its achievements page.
		const fresh = Date.now() - (detailsLoadedAt.get(appid) ?? 0) > 60000;
		loadSteamAppDetails(appid);
		setTimeout(() => navigatorAction('achievements', appid, /^MyAchievements$/), fresh ? 800 : 0);
	},
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

/** Carousel status line: download progress, "Not Installed", or nothing when it's ready to play. */
function tileStatus(appid: number): { text: string; active: boolean } | null {
	const r = runState(appid);
	if (r) return { text: r === 'playing' ? 'Playing' : 'Launching…', active: true };
	const d = downloadState(appid);
	if (d) return { text: downloadLabel(d).main, active: d.phase === 'downloading' || d.phase === 'installing' };
	if (installedHere(appid) === false) return { text: 'Not Installed', active: false };
	return null;
}

const TvHome = makeTvHome(readTvRows, openGame, getAchievements, achievementIcon, tileStatus);

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
			startMenuInjector(
				log,
				Array.from(MAIN_MENU_ALLOWED),
				Array.from(MAIN_MENU_KNOWN),
				GAME_MENU_HIDDEN,
				PLAYTIME_TEXT.map((re) => re.source),
			);
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
