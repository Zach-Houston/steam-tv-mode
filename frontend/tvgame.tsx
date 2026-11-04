import { Focusable } from 'millennium';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Backdrop, CSS as HOME_CSS, FALLBACK_ICON, goldRibbon, swallow } from './tvhome';

/* ------------------------------------------------------------------ *
 * TV game page (/tvgame), layout "5b": one centred column.
 *   Logo · Play · option icons · achievements card · latest update card.
 * Cards open full-screen panels: all achievements, all updates, a post.
 * No friends, media, community, playtime or last played.
 * B closes the top panel, otherwise returns to the carousel.
 * ------------------------------------------------------------------ */

const F = Focusable as any;

export interface AchievementItem {
	id: string;
	name: string;
	description: string;
	icon: string | null;
	unlocked: boolean;
	hidden: boolean;
	unlockedAt: number; // unix seconds, 0 if unknown
}

export interface NewsItem {
	id: string;
	title: string;
	date: number; // unix seconds
	label: string;
	body: string; // plain text; image paragraphs start with IMG_MARK
	image: string | null; // first image in the post, for the list
}

const IMG_MARK = '\u0001img:';

export interface DownloadState {
	phase: 'queued' | 'downloading' | 'paused' | 'installing';
	percent: number | null;
	bytesPerSecond: number | null;
	secondsLeft: number | null;
}

function fmtRate(bps: number | null): string {
	if (!bps || bps <= 0) return '';
	const mb = bps / 1e6;
	return mb >= 10 ? `${Math.round(mb)} MB/s` : `${mb.toFixed(1)} MB/s`;
}

function fmtLeft(sec: number | null): string {
	if (!sec || sec <= 0 || !isFinite(sec)) return '';
	const m = Math.ceil(sec / 60);
	if (m < 60) return `${m} min left`;
	return `${Math.floor(m / 60)} h ${m % 60} min left`;
}

export function downloadLabel(d: DownloadState): { main: string; sub: string } {
	const pct = d.percent != null ? ` ${Math.floor(d.percent)}%` : '';
	if (d.phase === 'queued') return { main: 'Queued', sub: 'Waiting for other downloads' };
	if (d.phase === 'paused') return { main: 'Paused' + pct, sub: 'Open Downloads to resume' };
	if (d.phase === 'installing') return { main: 'Installing…', sub: '' };
	return { main: 'Downloading' + pct, sub: [fmtRate(d.bytesPerSecond), fmtLeft(d.secondsLeft)].filter(Boolean).join(' · ') };
}

export interface TvGameDeps {
	/** Big Picture's activation click. */
	sound?: () => void;
	debug?: (...args: unknown[]) => void;
	onMount?: (appid: number) => void;
	currentApp: () => number | null;
	gameName: (appid: number) => string;
	isInstalled: (appid: number) => boolean | null;
	play: (appid: number) => void;
	install: (appid: number) => void;
	/** Download/install in progress for this game, or null. */
	download: (appid: number) => DownloadState | null;
	running: (appid: number) => 'launching' | 'playing' | null;
	openDownloads: () => void;
	back: () => void;
	controllerLayout: (appid: number) => void;
	properties: (appid: number) => void;
	openAchievements: (appid: number) => void;
	stockIcon: (name: 'controller' | 'settings') => string | null;
	achievementList: (appid: number) => Promise<AchievementItem[] | null>;
	achievementIcon: () => string | null;
	news: (appid: number) => Promise<NewsItem[]>;
}

/* Simple outline icons (drawn for this plugin). */
const ICONS = {
	news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2"/><path d="M7.5 9h6M7.5 12.5h6M7.5 16h4"/></svg>',
	controller:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8h10a4 4 0 0 1 3.9 4.8l-.9 4.3a2 2 0 0 1-3.5.8L14.8 16H9.2l-1.7 1.9a2 2 0 0 1-3.5-.8l-.9-4.3A4 4 0 0 1 7 8z"/><path d="M8 11v3M6.5 12.5h3"/></svg>',
	gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
};

const CSS = `
.tvg-root { position: absolute; inset: 0; color: #fff; overflow: hidden; background: #0a0c11; }
.tvg-root .tvm-bg-shade { background: rgba(10,12,17,.55); }
.tvg-root .tvm-bg-shade::after { content: ""; position: absolute; inset: 0; background: linear-gradient(0deg, rgba(10,12,17,.97) 0%, rgba(10,12,17,0) 75%); }
.tvg-col { position: relative; z-index: 1; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 6vh 0 10vh; box-sizing: border-box; overflow-y: auto; }
.tvg-col::-webkit-scrollbar { display: none; }
.tvg-logo { max-width: 720px; max-height: 210px; object-fit: contain; display: block; filter: drop-shadow(0 6px 24px rgba(0,0,0,.6)); }
.tvg-title { font-size: 72px; font-weight: 800; line-height: 1; text-align: center; max-width: 1100px; }

.tvg-play { width: 440px; height: 72px; margin-top: 48px; border-radius: 34px; background: #1a9fff; display: flex; align-items: center; justify-content: center; gap: 12px;
	font-size: 24px; font-weight: 700; outline: none; transition: transform .15s ease, box-shadow .15s ease; }
.tvg-play svg { width: 24px; height: 24px; }
.tvg-play--dl { position: relative; overflow: hidden; flex-direction: column; gap: 2px; background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 2px rgba(26,159,255,.55); }
.tvg-play.tvg-play--dl.gpfocus, .tvg-play.tvg-play--dl:focus { box-shadow: inset 0 0 0 2px rgba(26,159,255,.55), 0 0 0 4px #fff, 0 12px 36px rgba(0,0,0,.6); }
.tvg-dl-fill { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(26,159,255,.45); transition: width .6s ease; }
.tvg-dl-fill--busy { width: 100% !important; background: linear-gradient(90deg, rgba(26,159,255,.15), rgba(26,159,255,.45), rgba(26,159,255,.15)); background-size: 200% 100%; animation: tvg-busy 1.6s linear infinite; }
@keyframes tvg-busy { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.tvg-dl-main, .tvg-dl-sub { position: relative; }
.tvg-dl-main { font-size: 22px; font-weight: 700; }
.tvg-dl-sub { font-size: 14px; font-weight: 600; color: #cfe1f5; }
.tvg-play--running { background: rgba(26,159,255,.25); color: #e3f1ff; }
.tvg-play--install { background: rgba(26,159,255,.12); box-shadow: inset 0 0 0 2px #1a9fff; color: #cfe8ff; }
.tvg-play.tvg-play--install.gpfocus, .tvg-play.tvg-play--install:focus { background: rgba(26,159,255,.22); box-shadow: inset 0 0 0 2px #1a9fff, 0 0 0 4px #fff, 0 12px 36px rgba(0,0,0,.6); }
.tvg-icons { display: flex; gap: 18px; margin-top: 20px; }
.tvg-icon { width: 52px; height: 52px; border-radius: 26px; background: rgba(255,255,255,.14); display: flex; align-items: center; justify-content: center;
	position: relative; outline: none; transition: transform .15s ease, background .15s ease, box-shadow .15s ease; }
.tvg-icon > span { width: 24px; height: 24px; display: inline-flex; }
.tvg-icon > span svg { width: 100%; height: 100%; }
.tvg-icon-label { position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: 14px; font-weight: 600;
	padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,.8); opacity: 0; pointer-events: none; transition: opacity .15s ease; z-index: 3; }
.tvg-play.gpfocus, .tvg-play:focus, .tvg-icon.gpfocus, .tvg-icon:focus { transform: scale(1.06); box-shadow: 0 0 0 4px #fff, 0 12px 36px rgba(0,0,0,.6); }
.tvg-icon.gpfocus .tvg-icon-label, .tvg-icon:focus .tvg-icon-label { opacity: 1; }
.tvg-icon--danger.gpfocus, .tvg-icon--danger:focus { background: #c2403a; }

.tvg-card { width: 540px; margin-top: 14px; padding: 20px 24px; min-height: 150px; border-radius: 16px; background: rgba(16,20,28,.82); box-sizing: border-box; outline: none;
	transition: transform .15s ease, box-shadow .15s ease; }
.tvg-card--first { margin-top: 44px; }
.tvg-card.gpfocus, .tvg-card:focus { transform: scale(1.02); box-shadow: 0 0 0 3px #fff, 0 14px 40px rgba(0,0,0,.6); }
.tvg-card-head { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; }
.tvg-card-head .tvm-ach-icon { width: 22px; height: 22px; display: inline-flex; }
.tvg-card-head .tvm-ach-icon svg { width: 100%; height: 100%; }
.tvg-right { margin-left: auto; }
.tvg-bar { height: 6px; margin-top: 12px; border-radius: 4px; background: rgba(255,255,255,.12); overflow: hidden; }
.tvg-bar > div { height: 100%; border-radius: 4px; background: #1a9fff; }
.tvg-done { color: #f2c94c; }
.tvg-done .tvg-bar > div { background: #f2c94c; }
.tvg-recent { display: flex; align-items: center; gap: 9px; margin-top: 14px; }
.tvg-recent-img { width: 52px; height: 52px; border-radius: 8px; overflow: hidden; background: #3a4a66; flex: 0 0 auto; }
.tvg-recent-img--placeholder { background: rgba(255,255,255,.07); }
.tvg-recent { min-height: 52px; }
.tvg-muted { font-size: 16px; color: #9aa4b8; }
.tvg-recent-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tvg-recent-img--locked { filter: grayscale(1) brightness(.45); }
.tvg-news-label { font-size: 13px; font-weight: 700; letter-spacing: .6px; color: #5cb8ff; text-transform: uppercase; }
.tvg-news-title { margin-top: 10px; font-size: 21px; font-weight: 800; color: #fff; }
.tvg-news-excerpt { margin-top: 8px; font-size: 15px; line-height: 1.5; color: #b9c2d3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.tvg-panel { position: absolute; inset: 6vh 18%; z-index: 5; border-radius: 18px; background: rgba(12,14,20,.97); box-shadow: 0 30px 90px rgba(0,0,0,.7);
	display: flex; flex-direction: column; overflow: hidden; }
.tvg-panel-head { padding: 26px 32px 18px; border-bottom: 1px solid rgba(255,255,255,.08); }
.tvg-panel-title { font-size: 28px; font-weight: 800; line-height: 1.2; }
.tvg-panel-sub { margin-top: 8px; font-size: 15px; color: #9aa4b8; }
.tvg-panel-body { flex: 1; overflow-y: auto; padding: 12px 20px 24px; scroll-behavior: smooth; }
.tvg-panel-body::-webkit-scrollbar { display: none; }
.tvg-panel-hint { padding: 12px 32px; font-size: 14px; color: #9aa4b8; border-top: 1px solid rgba(255,255,255,.06); }
.tvg-row { display: flex; gap: 14px; align-items: center; padding: 10px 12px; border-radius: 10px; outline: none; }
.tvg-row.gpfocus, .tvg-row:focus { background: rgba(255,255,255,.1); box-shadow: inset 0 0 0 2px rgba(255,255,255,.85); }
.tvg-row-img { flex: 0 0 56px; width: 56px; height: 56px; border-radius: 8px; overflow: hidden; background: rgba(255,255,255,.08);
	display: flex; align-items: center; justify-content: center; font-size: 22px; }
.tvg-row-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tvg-row--locked .tvg-row-img { filter: grayscale(1) brightness(.5); }
.tvg-row--locked .tvg-row-text { opacity: .55; }
.tvg-row-name { font-size: 17px; font-weight: 700; }
.tvg-row-desc { margin-top: 3px; font-size: 14px; color: #b9c2d3; line-height: 1.35; }
.tvg-para { padding: 6px 12px; border-radius: 6px; font-size: 18px; line-height: 1.6; color: #dfe4ec; outline: none; white-space: pre-wrap; }
.tvg-para.gpfocus, .tvg-para:focus { background: rgba(255,255,255,.06); }
.tvg-para--img { padding: 8px 12px; }
.tvg-para--img img { display: block; max-width: 100%; max-height: 60vh; margin: 0 auto; border-radius: 10px; }
.tvg-news-thumb { flex: 0 0 160px; width: 160px; height: 90px; border-radius: 8px; overflow: hidden; background: rgba(255,255,255,.06); }
.tvg-news-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
`;

function logoSources(appid: number): string[] {
	return [
		`https://steamloopback.host/assets/${appid}/logo.png`,
		`https://shared.steamstatic.com/store_item_assets/steam/apps/${appid}/logo.png`,
		`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/logo.png`,
	];
}

const Logo = ({ appid, name }: { appid: number; name: string }) => {
	const [i, setI] = useState(0);
	const sources = logoSources(appid);
	useEffect(() => setI(0), [appid]);
	if (i >= sources.length) return <div className="tvg-title">{name}</div>;
	return <img className="tvg-logo" src={sources[i]} alt="" onError={() => setI((n) => n + 1)} />;
};

function scrollTo(e: any, block: ScrollLogicalPosition = 'nearest') {
	const el: HTMLElement | undefined = e?.currentTarget ?? e?.target;
	try {
		el?.scrollIntoView?.({ block, inline: 'nearest', behavior: 'smooth' });
	} catch {
		/* ignore */
	}
}

const Svg = ({ svg }: { svg: string }) => <span dangerouslySetInnerHTML={{ __html: svg }} />;

const IconButton = ({ icon, label, onActivate, autoFocus }: { icon: string; label: string; onActivate: () => void; autoFocus?: boolean }) => (
	<F className="tvg-icon" noFocusRing autoFocus={!!autoFocus} onActivate={onActivate}>
		<Svg svg={icon} />
		<div className="tvg-icon-label">{label}</div>
	</F>
);

function formatDate(unix: number): string {
	if (!unix) return '';
	try {
		return new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	} catch {
		return '';
	}
}

/** Unlocked first (newest first when unlock times are known), then locked, then hidden. */
function sortAchievements(list: AchievementItem[]): AchievementItem[] {
	const rank = (a: AchievementItem) => (a.unlocked ? 0 : a.hidden ? 2 : 1);
	return [...list].sort((a, b) => rank(a) - rank(b) || b.unlockedAt - a.unlockedAt);
}

type Panel = { kind: 'updates'; index?: number } | { kind: 'post'; post: NewsItem; from: 'updates'; index: number };

export function makeTvGame(deps: TvGameDeps) {
	return function TvGamePage() {
		const appid = deps.currentApp();
		const [list, setList] = useState<AchievementItem[] | null | undefined>(undefined);
		const [news, setNews] = useState<NewsItem[]>([]);
		const [panel, setPanel] = useState<Panel | null>(null);
		/** The button that opened the last panel; it gets focus back when the panel closes. */
		const [returnTo, setReturnTo] = useState<string | null>(null);
		const [installed, setInstalled] = useState<boolean | null>(() => (appid ? deps.isInstalled(appid) : null));
		const [dl, setDl] = useState<DownloadState | null>(() => (appid ? deps.download(appid) : null));
		const [run, setRun] = useState<'launching' | 'playing' | null>(() => (appid ? deps.running(appid) : null));

		useEffect(() => {
			if (appid) deps.onMount?.(appid);
		}, []);

		useEffect(() => {
			if (!appid) return;
			let live = true;
			setList(undefined);
			setNews([]);
			setPanel(null);
			deps.achievementList(appid).then((l) => live && setList(l)).catch(() => live && setList(null));
			deps.news(appid).then((n) => live && setNews(n)).catch(() => live && setNews([]));
			const t = setInterval(() => {
				setInstalled(deps.isInstalled(appid));
				setDl(deps.download(appid));
				setRun(deps.running(appid));
			}, 1000);
			return () => {
				live = false;
				clearInterval(t);
			};
		}, [appid]);

		// While a panel is open, B is taken at the document so it always closes the panel, even if
		// Steam's focus isn't inside it (otherwise Steam's own Back leaves the game page).
		const rootRef = useRef<HTMLDivElement | null>(null);
		const panelRef = useRef<Panel | null>(null);
		panelRef.current = panel;
		useEffect(() => {
			const doc = rootRef.current?.ownerDocument;
			if (!doc || !panel) return;
			const onB = (e: Event) => {
				const d = (e as CustomEvent).detail ?? {};
				if (d.button !== 2) return; // CANCEL (B)
				e.preventDefault();
				e.stopImmediatePropagation();
				if (e.type !== 'vgp_onbuttondown') return;
				const cur = panelRef.current;
				deps.sound?.();
				if (cur?.kind === 'post' && cur.from === 'updates') setPanel({ kind: 'updates', index: cur.index });
				else setPanel(null);
			};
			doc.addEventListener('vgp_onbuttondown', onB, true);
			doc.addEventListener('vgp_onbuttonup', onB, true);
			return () => {
				doc.removeEventListener('vgp_onbuttondown', onB, true);
				doc.removeEventListener('vgp_onbuttonup', onB, true);
			};
		}, [!!panel]);

		// Coming back to the updates list: show the remembered update in place before the first
		// paint, instead of smooth-scrolling down to it.
		useLayoutEffect(() => {
			const root = rootRef.current;
			if (!root || panel?.kind !== 'updates' || !panel.index) return;
			const body = root.querySelector<HTMLElement>('.tvg-panel-body');
			const row = root.querySelectorAll<HTMLElement>('.tvg-panel .tvg-row')[panel.index];
			if (!body || !row) return;
			const prev = body.style.scrollBehavior;
			body.style.scrollBehavior = 'auto';
			const r = row.getBoundingClientRect();
			const b = body.getBoundingClientRect();
			body.scrollTop += r.top + r.height / 2 - (b.top + b.height / 2);
			requestAnimationFrame(() => {
				body.style.scrollBehavior = prev;
			});
		}, [panel]);

		// Panel closed: make sure focus is back on the button that opened it (autoFocus usually does it).
		useEffect(() => {
			const root = rootRef.current;
			if (!root || panel || !returnTo) return;
			const t = setTimeout(() => {
				const btn = Array.from(root.querySelectorAll<HTMLElement>('.tvg-icon')).find(
					(el) => el.querySelector('.tvg-icon-label')?.textContent === returnTo,
				);
				if (btn && !btn.classList.contains('gpfocus')) btn.focus();
			}, 60);
			return () => clearTimeout(t);
		}, [panel]);

		// Put focus inside a panel when it opens. Steam's autoFocus doesn't always take when one panel
		// replaces another, and then focus falls to the hidden top bar (A there opened the keyboard).
		useEffect(() => {
			const root = rootRef.current;
			if (!root || !panel) return;
			const t = setTimeout(() => {
				const inPanel = root.querySelector('.tvg-panel .gpfocus');
				if (inPanel) return;
				const idx = panel.kind === 'updates' ? (panel.index ?? 0) : 0;
				const rows = root.querySelectorAll<HTMLElement>('.tvg-panel .tvg-row');
				const target = rows[idx] ?? root.querySelector<HTMLElement>('.tvg-panel .tvg-row, .tvg-panel .tvg-para');
				target?.focus();
			}, 60);
			const check = setTimeout(() => {
				const f = Array.from(root.ownerDocument.querySelectorAll('.gpfocus')).pop() as HTMLElement | undefined;
				deps.debug?.('panel', panel.kind, 'focus:', f ? `${f.className.slice(0, 60)} in-panel=${!!f.closest('.tvg-panel')}` : 'none');
			}, 500);
			return () => {
				clearTimeout(t);
				clearTimeout(check);
			};
		}, [panel]);

		// B: post → updates list → game page → carousel.
		const back = (e: any) => {
			swallow(e);
			if (panel?.kind === 'post' && panel.from === 'updates') setPanel({ kind: 'updates', index: panel.index });
			else if (panel) setPanel(null);
			else deps.back();
			return true;
		};

		if (!appid) {
			deps.back();
			return null;
		}
		const name = deps.gameName(appid);
		const sorted = list ? sortAchievements(list) : [];
		const total = sorted.length;
		const unlocked = sorted.filter((a) => a.unlocked).length;
		const done = total > 0 && unlocked >= total;
		const ribbon = deps.achievementIcon();
		const ribbonHtml = ribbon ? (done ? goldRibbon(ribbon) : ribbon) : FALLBACK_ICON;
		// Newest unlocks first; topped up with locked ones (dimmed) so the row is never empty.
		const recent = sorted.filter((a) => !(a.hidden && !a.unlocked)).slice(0, 8);
		const canInstall = installed === false;

		return (
			<div className="tvg-root" ref={rootRef}>
				<style>{HOME_CSS}</style>
				<style>{CSS}</style>
				<Backdrop appid={appid} />

				{/* The page is unmounted while a panel is open so the controller can't wander behind it. */}
				{!panel && (
				<F className="tvg-col" flow-children="column" onCancel={back} onCancelButton={back}>
					<Logo appid={appid} name={name} />

					{dl ? (
						<F className="tvg-play tvg-play--dl" autoFocus={!returnTo} noFocusRing onActivate={() => deps.openDownloads()}>
							<div
								className={'tvg-dl-fill' + (dl.percent == null || dl.phase === 'installing' ? ' tvg-dl-fill--busy' : '')}
								style={{ width: `${Math.max(0, Math.min(100, dl.percent ?? 0))}%` }}
							/>
							<span className="tvg-dl-main">{downloadLabel(dl).main}</span>
							{downloadLabel(dl).sub && <span className="tvg-dl-sub">{downloadLabel(dl).sub}</span>}
						</F>
					) : (
						<F
							className={'tvg-play' + (canInstall ? ' tvg-play--install' : run ? ' tvg-play--running' : '')}
							autoFocus={!returnTo}
							noFocusRing
							onActivate={() => (canInstall ? deps.install(appid) : run ? undefined : deps.play(appid))}
						>
							{canInstall ? 'Install' : run === 'playing' ? 'Playing' : run === 'launching' ? 'Launching…' : 'Play'}
						</F>
					)}

					<F className="tvg-icons" flow-children="row">
						<IconButton
							icon={deps.stockIcon('controller') ?? ICONS.controller}
							label="Controller layout"
							onActivate={() => deps.controllerLayout(appid)}
						/>
						<IconButton icon={deps.stockIcon('settings') ?? ICONS.gear} label="Properties" onActivate={() => deps.properties(appid)} />
						<IconButton icon={ICONS.news} label="Updates" autoFocus={returnTo === 'Updates'} onActivate={() => {
							deps.sound?.();
							setReturnTo('Updates');
							setPanel({ kind: 'updates' });
						}} />
					</F>

					<F
						className={'tvg-card tvg-card--first' + (done ? ' tvg-done' : '')}
						noFocusRing
						onActivate={() => total > 0 && deps.openAchievements(appid)}
						onGamepadFocus={(e: any) => scrollTo(e)}
					>
						<div className="tvg-card-head">
							<span className="tvm-ach-icon" dangerouslySetInnerHTML={{ __html: ribbonHtml }} />
							Achievements
							<span className="tvg-right">{list === undefined ? '…' : total ? `${unlocked} / ${total}` : 'None'}</span>
						</div>
						<div className="tvg-bar">
							<div style={{ width: total ? `${Math.round((unlocked / total) * 100)}%` : '0%' }} />
						</div>
						<div className="tvg-recent">
							{list === undefined
								? Array.from({ length: 8 }, (_, i) => <div key={i} className="tvg-recent-img tvg-recent-img--placeholder" />)
								: recent.map((a) => (
										<div key={a.id} className={'tvg-recent-img' + (a.unlocked ? '' : ' tvg-recent-img--locked')}>
											{a.icon && <img src={a.icon} alt="" />}
										</div>
									))}
							{list !== undefined && !total && <span className="tvg-muted">This game has no achievements.</span>}
						</div>
					</F>

				</F>
				)}

				{panel?.kind === 'updates' && (
					<F className="tvg-panel" flow-children="column" onCancel={back} onCancelButton={back}>
						<div className="tvg-panel-head">
							<div className="tvg-panel-title">Updates</div>
							<div className="tvg-panel-sub">Official announcements and patch notes</div>
						</div>
						<F className="tvg-panel-body" flow-children="column">
							{!news.length && (
								<F className="tvg-para tvg-muted" focusable onActivate={() => {}} noFocusRing autoFocus>
									No updates from the developer yet.
								</F>
							)}
							{news.map((n, i) => (
								<F
									key={n.id}
									className="tvg-row"
									noFocusRing
									autoFocus={i === (panel.kind === 'updates' ? (panel.index ?? 0) : 0)}
									data-tvg-index={i}
									onActivate={() => {
										deps.sound?.();
										setPanel({ kind: 'post', post: n, from: 'updates', index: i });
									}}
									onGamepadFocus={(e: any) => scrollTo(e)}
									onFocus={(e: any) => scrollTo(e)}
								>
									{n.image && (
										<div className="tvg-news-thumb">
											<img src={n.image} alt="" onError={(e: any) => (e.currentTarget.parentElement.style.display = 'none')} />
										</div>
									)}
									<div className="tvg-row-text">
										<div className="tvg-news-label">
											{n.label}
											{n.date ? ' · ' + formatDate(n.date) : ''}
										</div>
										<div className="tvg-row-name" style={{ marginTop: '4px' }}>
											{n.title}
										</div>
									</div>
								</F>
							))}
						</F>
					</F>
				)}

				{panel?.kind === 'post' && (
					<F className="tvg-panel" flow-children="column" onCancel={back} onCancelButton={back}>
						<div className="tvg-panel-head">
							<div className="tvg-panel-title">{panel.post.title}</div>
							<div className="tvg-panel-sub">
								{panel.post.label}
								{panel.post.date ? ' · ' + formatDate(panel.post.date) : ''}
							</div>
						</div>
						<F className="tvg-panel-body" flow-children="column">
							{panel.post.body
								.split(/\n{2,}/)
								.filter((p) => p.trim())
								.map((p, i) => (
									<F
										key={i}
										className={'tvg-para' + (p.trim().startsWith(IMG_MARK) ? ' tvg-para--img' : '')}
										focusable
										onActivate={() => {}}
										noFocusRing
										autoFocus={i === 0}
										onGamepadFocus={(e: any) => scrollTo(e, 'center')}
										onFocus={(e: any) => scrollTo(e, 'center')}
									>
										{p.trim().startsWith(IMG_MARK) ? (
											<img src={p.trim().slice(IMG_MARK.length)} alt="" onError={(e: any) => (e.currentTarget.closest('.tvg-para').style.display = 'none')} />
										) : (
											p.trim()
										)}
									</F>
								))}
						</F>
					</F>
				)}
			</div>
		);
	};
}
