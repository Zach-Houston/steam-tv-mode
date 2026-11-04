/* ------------------------------------------------------------------ *
 * Steam's own achievements page (/library/app/<id>/achievements/...), restyled to match TV Mode:
 * hero-art backdrop, card rows with a white focus ring, rarity colours on "% of players", gold
 * header when complete. The "Compare to..." option and the user's own avatar are removed.
 * Steam keeps doing the layout, scrolling and controller focus; this only marks and styles.
 * ------------------------------------------------------------------ */
import { heroSources } from './tvhome';

export const ACH_ROUTE = /^\/library\/app\/(\d+)\/achievements/i;

const STYLE_ID = 'tvmode-ach-style';
const PAGE = 'data-tvm-ach-page';
const ITEM = 'data-tvm-ach-item';
const TIER = 'data-tvm-tier';
const DONE = 'data-tvm-ach-complete';

const CSS = `
[${PAGE}] { background: #0a0c11 !important; }
[${PAGE}] .GamepadTabbedPage, [${PAGE}] .AchievementTabs, [${PAGE}] .Container,
[${PAGE}] .AchievementList, [${PAGE}] .TabHeaderRowWrapper { background: transparent !important; }
[${PAGE}] .TabHeaderRowWrapper { backdrop-filter: none !important; }
[${PAGE}] .Tab { border-radius: 20px !important; }
[${ITEM}] {
	background: rgba(16,20,28,.78) !important; border-radius: 14px !important; overflow: hidden;
	transition: box-shadow .15s ease, transform .15s ease, background .15s ease;
}
[${ITEM}].gpfocus, [${ITEM}]:has(.gpfocus) {
	background: rgba(36,42,56,.92) !important;
	box-shadow: 0 0 0 3px #ffffff, 0 14px 34px rgba(0,0,0,.55) !important;
	transform: scale(1.01);
}
[${ITEM}] img { border-radius: 8px; }
[${TIER}="ultra"] { color: #f2c94c !important; }
[${TIER}="rare"] { color: #c58cff !important; }
[${TIER}="uncommon"] { color: #5cb8ff !important; }
[${DONE}] { color: #f2c94c !important; }
`;

type Hide = (el: Element, reason: string) => void;
type Log = (...args: unknown[]) => void;

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const PCT_TEXT = /(\d+(?:\.\d+)?)\s*%\s*of (all )?players/i;
const AVATAR_SRC = /avatars?[.\/]|\/avatar|akamaihd\.net\/.*avatar/i;

function tierOf(p: number) {
	return p < 5 ? 'ultra' : p < 20 ? 'rare' : p < 50 ? 'uncommon' : 'common';
}

/** The row an element belongs to: Steam's list item panel, else the nearest focusable. */
function itemRoot(el: Element): Element | null {
	return el.closest('[class*="ListItem"]') ?? el.closest('.Focusable') ?? el.closest('.Panel');
}

let heroFor = -1;
let structureLoggedFor = '';

export function styleAchievementsPage(doc: Document, route: string, hide: Hide, log: Log) {
	const m = route.match(ACH_ROUTE);
	if (!m) {
		if (heroFor !== -1) {
			doc.querySelectorAll(`[${PAGE}]`).forEach((e) => e.removeAttribute(PAGE));
			heroFor = -1;
		}
		return;
	}
	const appid = Number(m[1]);

	if (!doc.getElementById(STYLE_ID)) {
		const style = doc.createElement('style');
		style.id = STYLE_ID;
		style.textContent = CSS;
		doc.head.appendChild(style);
	}

	// Backdrop on the page's scroller (the outermost Steam element of this screen).
	const tabs = doc.querySelector('.AchievementTabs') ?? doc.querySelector('.AchievementList');
	const page = (tabs?.closest('.Page.ScrollPanel') ?? tabs?.closest('.GamepadTabbedPage') ?? null) as HTMLElement | null;
	if (page && !page.hasAttribute(PAGE)) page.setAttribute(PAGE, '');
	// The hero URL goes in a stylesheet rather than on Steam's element, which React may re-render.
	let heroStyle = doc.getElementById(STYLE_ID + '-hero');
	if (!heroStyle) {
		heroStyle = doc.createElement('style');
		heroStyle.id = STYLE_ID + '-hero';
		doc.head.appendChild(heroStyle);
		heroFor = -1;
	}
	if (heroFor !== appid) {
		heroFor = appid;
		const layers = [
			'linear-gradient(90deg, rgba(10,12,17,.92) 0%, rgba(10,12,17,.72) 50%, rgba(10,12,17,.55) 100%)',
			'linear-gradient(0deg, rgba(10,12,17,.96) 0%, rgba(10,12,17,.35) 70%)',
			...heroSources(appid).map((u) => `url("${u}") center top / cover no-repeat fixed`),
			'#0a0c11',
		];
		heroStyle.textContent = `[${PAGE}] { background: ${layers.join(', ')} !important; }`;
	}
	const scope: ParentNode = page ?? doc;

	const walker = doc.createTreeWalker(page ?? doc.body, NodeFilter.SHOW_TEXT);
	let n: Node | null;
	while ((n = walker.nextNode())) {
		const el = n.parentElement;
		if (!el || el.closest('[data-tvmode-hidden]')) continue;
		const text = norm(n.textContent);
		if (!text) continue;
		if (/^compare to\b/i.test(text)) {
			// Take the whole tab/button, not just its label.
			let target: Element = el;
			while (target.parentElement && norm(target.parentElement.textContent) === text) target = target.parentElement;
			hide(target.closest('.Tab') ?? target, 'compare');
			continue;
		}
		if (/^you've unlocked all achievements/i.test(text)) {
			el.setAttribute(DONE, '');
			continue;
		}
		const pm = text.match(PCT_TEXT);
		if (pm) {
			if (!el.hasAttribute(TIER)) el.setAttribute(TIER, tierOf(parseFloat(pm[1])));
			const item = itemRoot(el);
			if (item && !item.hasAttribute(ITEM) && item !== page) item.setAttribute(ITEM, '');
		}
	}
	// Global tab rows ("74.9" "%" + a progress bar) have no "of players" text; mark them by class.
	scope.querySelectorAll('.GlobalAchievementListItem:not([' + ITEM + '])').forEach((e) => e.setAttribute(ITEM, ''));

	// Search boxes inside the lists (e.g. Global Achievements' filter box): hidden and switched off.
	scope.querySelectorAll('.AchievementList .SearchField, .MyAchievementsHeader').forEach((box) => {
		if (!box.closest('[data-tvmode-hidden]')) hide(box, 'compare');
	});

	// The user's own avatar (and any friend avatars).
	scope.querySelectorAll('img').forEach((img) => {
		const src = img.getAttribute('src') ?? '';
		const cls = (img.getAttribute('class') ?? '') + ' ' + (img.parentElement?.getAttribute('class') ?? '');
		if (!AVATAR_SRC.test(src) && !/avatar/i.test(cls)) return;
		const holder = img.closest('[class*="vatar"]') ?? img;
		hide(holder, 'avatar');
	});

	if (structureLoggedFor !== route) {
		structureLoggedFor = route;
		setTimeout(() => logStructure(doc, route, log), 1500);
	}
}

/** One-off outline of the page so the styling can be tuned against what Steam actually renders. */
function logStructure(doc: Document, route: string, log: Log) {
	try {
		const outline = (el: Element, depth: number, max: number, out: string[]) => {
			if (out.length > 60 || depth > max) return;
			const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => !/^[A-Za-z0-9_-]{18,}$/.test(c)).join('.');
			const own = Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => norm(c.textContent)).join(' ').slice(0, 40);
			const extra = el.tagName === 'IMG' ? ' src=' + (el.getAttribute('src') ?? '').replace(/^https?:\/\//, '').slice(0, 50) : '';
			const hid = el.getAttribute('data-tvmode-hidden');
			out.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${hid ? ' [hidden:' + hid + ']' : ''}${own ? ' "' + own + '"' : ''}${extra}`);
			for (const c of Array.from(el.children)) outline(c, depth + 1, max, out);
		};
		const header: string[] = [];
		const tabs = doc.querySelector('.AchievementTabs');
		if (tabs) outline(tabs.firstElementChild ?? tabs, 0, 7, header);
		const item: string[] = [];
		const first = doc.querySelector(`[${ITEM}]`);
		if (first) outline(first, 0, 6, item);
		log('achievements page', route, { page: !!doc.querySelector(`[${PAGE}]`), items: doc.querySelectorAll(`[${ITEM}]`).length });
		log('achievements header\n' + header.join('\n'));
		log('achievements first row\n' + item.join('\n'));
	} catch (e) {
		log('achievements structure failed', String(e));
	}
}
