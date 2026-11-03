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
function menuScript(allowed: string[], known: string[]): string {
	return `(() => {
	if (window.__tvmodeMenu2) return 'already installed';
	window.__tvmodeMenu2 = true;
	window.__tvmodeMenuLog = [];
	const report = (m) => { if (window.__tvmodeMenuLog.length < 50) window.__tvmodeMenuLog.push(m); };
	const ATTR = 'data-tvmode-hidden';
	const KNOWN = new Set(${JSON.stringify(known)});
	const ALLOWED = new Set(${JSON.stringify(allowed)});
	const style = document.createElement('style');
	style.textContent = '[' + ATTR + ']{display:none!important}';
	(document.head || document.documentElement).appendChild(style);
	const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
	let hidden = 0;
	const run = () => {
		if (!document.body) return;
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		let n;
		while ((n = walker.nextNode())) {
			const label = norm(n.data).toLowerCase();
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
	const focused = () => document.querySelector('.gpfocus') || document.activeElement;
	let redirects = 0;
	const moveOffHidden = (why) => {
		const target = focusTarget(firstVisible());
		if (!target) return;
		setTimeout(() => {
			target.focus && target.focus();
			setTimeout(() => {
				if (redirects++ < 3) report(why + ': moved focus to first entry, steam focus now on ' + norm((focused() || {}).textContent || '').slice(0, 30));
			}, 60);
		}, 0);
	};
	document.addEventListener('focusin', (e) => { if (isHidden(e.target)) moveOffHidden('focusin'); }, true);
	new MutationObserver((muts) => {
		for (const m of muts) if (m.target.classList && m.target.classList.contains('gpfocus') && isHidden(m.target)) { moveOffHidden('gpfocus'); break; }
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
	let blockedLogged = false;
	for (const type of ['vgp_onbuttondown', 'vgp_onbuttonup']) {
		document.addEventListener(type, (e) => {
			const b = e.detail && e.detail.button;
			if (b !== DIR_UP && b !== LSTICK_UP) return;
			const first = firstVisible();
			const cur = focused();
			if (!first || !cur || !first.contains(cur) && !cur.contains(first)) return;
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

export function startMenuInjector(log: Log, allowed: string[], known: string[]) {
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
				const out = await CDP.send('Runtime.evaluate', { expression: menuScript(allowed, known), returnByValue: true }, sessionId);
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
