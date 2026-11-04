import { ChromeDevToolsProtocol } from 'millennium';

/* ------------------------------------------------------------------ *
 * Big Picture's Steam-button menu is drawn in its own browser (a
 * separate process the plugin's page code can't reach). Millennium's
 * ChromeDevToolsProtocol bridge can: find that browser, attach to it,
 * and run a small script there that hides the unwanted entries.
 * ------------------------------------------------------------------ */

type Log = (...args: unknown[]) => void;

const CDP = ChromeDevToolsProtocol as any;

/** Browsers worth injecting into (the menu's title isn't documented, so match broadly). */
const TARGET_TITLE = /mainmenu|quickaccess|sp overlay|^menu$/i;

/** Runs inside the menu's own browser. Self-contained: no access to the plugin's code. */
function menuScript(allowed: string[], known: string[], gameHide: string[], playtime: string[]): string {
	return `(() => {
	if (window.__tvmodeMenu8) return 'already installed';
	window.__tvmodeMenu8 = true;
	window.__tvmodeMenuLog = [];
	const report = (m) => { if (window.__tvmodeMenuLog.length < 50) window.__tvmodeMenuLog.push(m); };
	const ATTR = 'data-tvmode-hidden';
	const KNOWN = new Set(${JSON.stringify(known)});
	const ALLOWED = new Set(${JSON.stringify(allowed)});
	/* Entries of a running game's menu that TV Mode doesn't want (exact labels). */
	const GAME_HIDE = new Set(${JSON.stringify(gameHide)});
	/* Playtime text (same rules as the main window). */
	const PLAYTIME = ${JSON.stringify(playtime)}.map((p) => new RegExp(p, 'i'));
	const PLAYTIME_LABEL = /^(play\\s?time|time played|last played|total played|playtime( on record)?|hours played|(last|past) (two|2) weeks)$/i;
	const style = document.createElement('style');
	style.textContent = '[' + ATTR + ']{display:none!important}';
	(document.head || document.documentElement).appendChild(style);
	const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
	let hidden = 0;
	const seenTimeTexts = new Set();
	/* Grow from el to its wrapper only while the wrapper is still just this one small control. */
	const smallBox = (el) => {
		let box = el;
		for (let up = el.parentElement, d = 0; up && d < 4; up = up.parentElement, d++) {
			if (norm(up.textContent).length > 30) break;
			if (up.querySelectorAll('img, svg, button, input, .Focusable, [tabindex]').length > 3) break;
			box = up;
		}
		return box;
	};
	const hideBox = (el, why) => {
		if (!el || el.hasAttribute(ATTR)) return;
		// Last line of defence: never hide a block with real content (it once took the whole list).
		if (el.querySelectorAll('*').length > 25 || norm(el.textContent).length > 40) {
			report('refused to hide ' + why + ': too big (' + el.querySelectorAll('*').length + ' inside)');
			return;
		}
		el.setAttribute(ATTR, why);
		el.setAttribute('inert', '');
		const inputs = el.matches('input, textarea') ? [el] : Array.from(el.querySelectorAll('input, textarea'));
		inputs.forEach((i) => { i.disabled = true; });
		hidden++;
		if (why === 'compare') {
			const chain = [];
			for (let n = el.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) chain.push(desc(n));
			report('compare box parents: ' + chain.join(' < '));
		}
		report('hid ' + why + ' ' + (el.tagName || '').toLowerCase() + ' "' + norm(el.textContent).slice(0, 30) + '" (' + el.querySelectorAll('*').length + ' inside)');
	};
	const run = () => {
		if (!document.body) return;
		// In-game achievements: the row under the tabs ("MyAchievementsHeader") holds the "Compare
		// to..." label and a friend-search text box side by side. Hide the whole row.
		document.querySelectorAll('.MyAchievementsHeader').forEach((row) => {
			if (!row.closest('[' + ATTR + ']')) hideBox(row, 'compare');
		});
		// Any other search box in an achievements list (Global Achievements has one beside
		// "% of all players"). Only the box goes; the column heading stays.
		document.querySelectorAll('.AchievementList .SearchField').forEach((box) => {
			if (!box.closest('[' + ATTR + ']')) hideBox(box, 'search');
		});
		// Text boxes whose hint is "Compare to..." (placeholder, not text).
		document.querySelectorAll('input[placeholder]').forEach((i) => {
			if (!/^compare to\\b/i.test(i.getAttribute('placeholder') || '') || i.closest('[' + ATTR + ']')) return;
			hideBox(smallBox(i), 'compare');
		});
		// The user's own avatar (and friends') on the in-game achievements page.
		document.querySelectorAll('img').forEach((img) => {
			const src = img.getAttribute('src') || '';
			const cls = (img.getAttribute('class') || '') + ' ' + ((img.parentElement && img.parentElement.getAttribute('class')) || '');
			if (img.closest('[' + ATTR + ']') || !(/avatars?[.\\/]|\\/avatar/i.test(src) || /avatar/i.test(cls))) return;
			let holder = img.closest('[class*="vatar"]') || img;
			if (holder !== img && (holder.querySelectorAll('img').length > 1 || norm(holder.textContent).length > 0)) holder = img;
			holder.setAttribute(ATTR, 'avatar');
		});
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		let n;
		while ((n = walker.nextNode())) {
			const raw = norm(n.data);
			const label = raw.toLowerCase();
			if (!label) continue;
			if (n.parentElement && n.parentElement.closest('[' + ATTR + ']')) continue;
			// In-game achievements (overlay): the "Compare to..." friend box sits between the tabs and
			// the list. Hide it, switch its text box off, and the focus code below steps over it.
			if (/^compare to\\b/i.test(raw)) {
				hideBox(smallBox(n.parentElement), 'compare');
				continue;
			}
			if (GAME_HIDE.has(label)) {
				let item = n.parentElement;
				while (item.parentElement && norm(item.parentElement.textContent).toLowerCase() === label) item = item.parentElement;
				const f = item.closest('.Focusable, [tabindex], button');
				if (f && norm(f.textContent).toLowerCase() === label) item = f;
				item.setAttribute(ATTR, 'game-menu');
				item.setAttribute('inert', '');
				hidden++;
				report('hid game menu entry ' + raw);
				continue;
			}
			if (PLAYTIME_LABEL.test(raw) || PLAYTIME.some((re) => re.test(raw))) {
				let el = n.parentElement;
				const block = el.parentElement;
				if (PLAYTIME_LABEL.test(raw) && block && norm(block.textContent).length <= 60) el = block;
				el.setAttribute(ATTR, 'playtime');
				hidden++;
				report('hid playtime "' + raw.slice(0, 40) + '"');
				continue;
			}
			if (/\\b(hours?|hrs?|minutes?|mins?|weeks?|played)\\b/i.test(raw) && raw.length < 60 && seenTimeTexts.size < 12 && !seenTimeTexts.has(raw)) {
				seenTimeTexts.add(raw);
				report('time-like text left visible: "' + raw + '"');
			}
			if (!KNOWN.has(label) || ALLOWED.has(label)) continue;
			let item = n.parentElement;
			if (!item || item.closest('[' + ATTR + ']')) continue;
			while (item.parentElement && norm(item.parentElement.textContent).toLowerCase() === label) item = item.parentElement;
			let up = item.parentElement, inMenu = false;
			for (let i = 0; up && i < 8; i++, up = up.parentElement) {
				const t = (up.textContent || '').toLowerCase();
				if (t.length > 600) break;
				if (t.includes('power') && t.includes('downloads')) { inMenu = true; break; }
			}
			if (!inMenu) continue;
			item.setAttribute(ATTR, 'main-menu');
			item.setAttribute('inert', '');
			hidden++;
		}
	};
	/* Keep the controller off hidden entries. */
	const DIR_UP = 9, LSTICK_UP = 23;
	const isHidden = (el) => !!(el && el.closest && el.closest('[' + ATTR + ']'));
	/* Steam's focus can sit on a wrapper around something we hid (the compare box's own
	   focusable is outside the part that has its text). Treat such a wrapper as hidden too. */
	const isHiddenFocus = (el) => {
		if (!el || !el.querySelector) return false;
		if (isHidden(el)) return true;
		const hb = el.querySelector('[' + ATTR + '="compare"]');
		if (hb && norm(el.textContent).length <= norm(hb.textContent).length + 4) return true;
		const r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0 && el.querySelector('input, textarea')) return true;
		return false;
	};
	/* Diagnostics: where Steam's focus goes (first 25 moves), with a few ancestors. */
	const desc = (el) => {
		if (!el || !el.tagName) return '-';
		const cls = (el.getAttribute('class') || '').split(/\\s+/).filter((c) => c && c.length < 22).slice(0, 4).join('.');
		const r = el.getBoundingClientRect();
		return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + norm(el.textContent).slice(0, 24) + '"' + (isHidden(el) ? ' [hidden]' : '');
	};
	let focusReports = 0;
	const reportFocus = (el) => {
		if (focusReports++ >= 25) return;
		const chain = [];
		for (let n = el && el.parentElement, i = 0; n && i < 4; n = n.parentElement, i++) chain.push(desc(n));
		report('focus → ' + desc(el) + ' | in ' + chain.join(' < '));
	};
	const entryFor = (label) => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		let n;
		while ((n = walker.nextNode())) {
			if (norm(n.data).toLowerCase() !== label) continue;
			let item = n.parentElement;
			while (item && item.parentElement && norm(item.parentElement.textContent).toLowerCase() === label) item = item.parentElement;
			if (item && !isHidden(item)) return item;
		}
		return null;
	};
	/** The topmost visible entry (Downloads), and the element in it that takes focus. */
	const firstVisible = () => {
		const order = ${JSON.stringify(allowed)};
		const items = order.map(entryFor).filter(Boolean);
		items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
		return items[0] || null;
	};
	const focusTarget = (item) => (item && (item.matches('[tabindex],.Focusable,button') ? item : item.querySelector('[tabindex],.Focusable,button'))) || item;
	const focused = () => { const all = document.querySelectorAll('.gpfocus'); return all[all.length - 1] || document.activeElement; };
	const DIR_DOWN = 10, LSTICK_DOWN = 24;
	let lastDir = 'down';
	/* Innermost focusable elements, in page order (hidden ones included, to find neighbours). */
	const leaves = () => Array.from(document.querySelectorAll('.Focusable, [tabindex], button, input')).filter((el) => !el.querySelector('.Focusable, [tabindex], button, input'));
	const visible = (el) => !isHiddenFocus(el) && el.getClientRects().length > 0;
	let redirects = 0;
	/* Focus landed on a hidden entry: step to the next visible one in the direction of travel. */
	const moveOffHidden = (why, from) => {
		const list = leaves();
		const start = from ? list.findIndex((el) => el === from || el.contains(from) || from.contains(el)) : -1;
		let target = null;
		if (start >= 0) {
			const step = lastDir === 'up' ? -1 : 1;
			for (let i = start + step; i >= 0 && i < list.length; i += step) if (visible(list[i])) { target = list[i]; break; }
			if (!target) for (let i = start - step; i >= 0 && i < list.length; i -= step) if (visible(list[i])) { target = list[i]; break; }
		}
		if (!target) target = focusTarget(firstVisible());
		if (!target) return;
		setTimeout(() => {
			target.focus && target.focus();
			setTimeout(() => {
				if (redirects++ < 5) report(why + ': moved focus off hidden entry to ' + norm((focused() || {}).textContent || '').slice(0, 30));
			}, 60);
		}, 0);
	};
	document.addEventListener('focusin', (e) => { if (isHiddenFocus(e.target)) moveOffHidden('focusin', e.target); }, true);
	new MutationObserver((muts) => {
		for (const m of muts) {
			if (!m.target.classList || !m.target.classList.contains('gpfocus')) continue;
			reportFocus(m.target);
			if (isHiddenFocus(m.target)) { moveOffHidden('gpfocus', m.target); break; }
		}
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
	let blockedLogged = false;
	for (const type of ['vgp_onbuttondown', 'vgp_onbuttonup']) {
		document.addEventListener(type, (e) => {
			const b = e.detail && e.detail.button;
			if (type === 'vgp_onbuttondown') {
				if (b === DIR_UP || b === LSTICK_UP) lastDir = 'up';
				else if (b === DIR_DOWN || b === LSTICK_DOWN) lastDir = 'down';
			}
			if (b === 1) {
				const cur = focused();
				if (cur && isHiddenFocus(cur)) {
					e.preventDefault();
					e.stopImmediatePropagation();
					if (type === 'vgp_onbuttondown') moveOffHidden('A on hidden', cur);
				}
				return;
			}
			if (b !== DIR_UP && b !== LSTICK_UP) return;
			const first = firstVisible();
			const cur = focused();
			if (!first || !cur || !first.contains(cur) && !cur.contains(first)) return;
			/* A running game adds its own entry above Downloads: let up reach it. */
			const fr = first.getBoundingClientRect();
			const above = leaves().some((el) => {
				if (!visible(el) || first.contains(el) || el.contains(first)) return false;
				const r = el.getBoundingClientRect();
				return r.height > 0 && r.bottom <= fr.top + 2 && r.right > fr.left && r.left < fr.right;
			});
			if (above) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			if (!blockedLogged && type === 'vgp_onbuttondown') { blockedLogged = true; report('blocked up from the first entry'); }
		}, true);
	}

	run();
	new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	return 'installed, hid ' + hidden;
})()`;
}

export function startMenuInjector(log: Log, allowed: string[], known: string[], gameHide: string[] = [], playtime: string[] = []) {
	const injected = new Set<string>();
	const sessions = new Map<string, string>(); // targetId -> sessionId
	let titlesLogged = '';
	let failedLogged = false;

	const tick = async () => {
		if (!CDP?.send) {
			if (!failedLogged) log('menu injector: ChromeDevToolsProtocol not available');
			failedLogged = true;
			return;
		}
		let infos: any[] = [];
		try {
			const res = await CDP.send('Target.getTargets');
			infos = res?.targetInfos ?? [];
		} catch (e) {
			if (!failedLogged) log('menu injector: Target.getTargets failed', String(e));
			failedLogged = true;
			return;
		}
		const titles = JSON.stringify(infos.map((t) => `${t.type}:${t.title}`));
		if (titles !== titlesLogged) {
			titlesLogged = titles;
			log('cdp targets', infos.map((t) => `${t.type}:${t.title}`));
		}
		for (const t of infos) {
			if (!TARGET_TITLE.test(String(t.title ?? '')) || injected.has(t.targetId)) continue;
			injected.add(t.targetId);
			try {
				const { sessionId } = await CDP.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
				sessions.set(t.targetId, sessionId);
				const out = await CDP.send('Runtime.evaluate', { expression: menuScript(allowed, known, gameHide, playtime), returnByValue: true }, sessionId);
				log('menu injector:', JSON.stringify(t.title), '→', out?.result?.value ?? out?.exceptionDetails?.text ?? 'no result');
			} catch (e) {
				log('menu injector: inject failed for', JSON.stringify(t.title), String(e));
				injected.delete(t.targetId); // retry on the next tick
			}
		}
		// Forget closed targets so a recreated menu gets injected again.
		const live = new Set(infos.map((t) => t.targetId));
		for (const id of Array.from(injected)) if (!live.has(id)) injected.delete(id);
		for (const id of Array.from(sessions.keys())) if (!live.has(id)) sessions.delete(id);

		// Collect what the in-menu script reported.
		for (const [, sessionId] of sessions) {
			try {
				const out = await CDP.send(
					'Runtime.evaluate',
					{ expression: 'JSON.stringify((window.__tvmodeMenuLog || []).splice(0))', returnByValue: true },
					sessionId,
				);
				const msgs: string[] = JSON.parse(out?.result?.value ?? '[]');
				for (const m of msgs) log('menu:', m);
			} catch {
				/* session gone */
			}
		}
	};

	void tick();
	setInterval(() => void tick(), 4000);
}
