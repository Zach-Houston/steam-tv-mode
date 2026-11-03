import { Focusable } from 'millennium';
import { useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ *
 * TV Home: the custom Big Picture screen at /tvmode.
 *
 * One TV collection per screen-height row; each row is a horizontal
 * carousel of cover art. Steam's own Focusable components do the
 * controller navigation: left/right within a row, up/down between rows.
 * A opens the game's Steam page. No playtime or last-played anywhere.
 * ------------------------------------------------------------------ */

export interface TvGame {
	appid: number;
	name: string;
}

export interface TvRow {
	id: string;
	name: string;
	games: TvGame[];
}

/** Millennium's Focusable is Steam's component; its gamepad props aren't all in the typings. */
const F = Focusable as any;

export const CSS = `
.tvm-root { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 0%, #1b2233 0%, #0a0c11 70%); color: #fff; overflow: hidden; }
.tvm-rows { position: relative; z-index: 1; height: 100%; overflow-y: auto; scroll-snap-type: y mandatory; scroll-behavior: smooth; }
.tvm-bg { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
.tvm-bg-layer { position: absolute; inset: -4%; background-size: cover; background-position: center top; opacity: 0;
	animation: tvm-fade .7s ease forwards, tvm-drift 28s ease-in-out infinite alternate; will-change: transform, opacity; }
.tvm-bg-layer--blur { filter: blur(40px) saturate(1.3); }
.tvm-bg-shade { position: absolute; inset: 0;
	background: linear-gradient(90deg, rgba(10,12,17,.9) 0%, rgba(10,12,17,.5) 45%, rgba(10,12,17,.3) 100%),
		linear-gradient(0deg, rgba(10,12,17,.95) 0%, rgba(10,12,17,0) 60%); }
@keyframes tvm-fade { to { opacity: 1; } }
@keyframes tvm-drift { from { transform: scale(1.04) translate3d(0, 0, 0); } to { transform: scale(1.12) translate3d(-1.5%, -1%, 0); } }
.tvm-rows::-webkit-scrollbar, .tvm-strip::-webkit-scrollbar { display: none; }
.tvm-row { height: 100%; scroll-snap-align: start; display: flex; flex-direction: column; justify-content: center; transition: opacity .25s ease; }
.tvm-row:not(:focus-within) { opacity: .35; }
.tvm-title { margin: 0 0 8px 72px; font-size: 44px; font-weight: 700; letter-spacing: .3px; }
.tvm-count { margin: 0 0 0 72px; font-size: 18px; opacity: .55; }
.tvm-strip { display: flex; align-items: center; gap: 32px; overflow-x: auto; padding: 56px 50vw 72px 72px; scroll-behavior: smooth; }
.tvm-tile { flex: 0 0 auto; width: 230px; outline: none; border-radius: 10px; transition: transform .18s ease; transform-origin: center; }
.tvm-tile::before, .tvm-tile::after { display: none !important; }
.tvm-art { width: 100%; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; background: #1c2230; box-shadow: 0 10px 30px rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; text-align: center; padding: 0; }
.tvm-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tvm-art .tvm-fallback { padding: 16px; font-size: 20px; font-weight: 600; opacity: .85; }
.tvm-name { margin-top: 16px; font-size: 20px; font-weight: 600; text-align: center; opacity: 0; transition: opacity .18s ease; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tvm-tile.gpfocus, .tvm-tile:focus, .tvm-tile:focus-visible { transform: scale(1.16); z-index: 1; }
.tvm-tile.gpfocus .tvm-art, .tvm-tile:focus .tvm-art { box-shadow: 0 0 0 4px #fff, 0 18px 50px rgba(0,0,0,.7); }
.tvm-ach { margin-top: 6px; font-size: 17px; text-align: center; opacity: 0; color: #c7d0e0; transition: opacity .18s ease; }
.tvm-ach--done { color: #f2c94c; }
.tvm-ach { display: flex; align-items: center; justify-content: center; gap: 6px; height: 22px; }
.tvm-ach-icon { display: inline-flex; width: 18px; height: 18px; }
.tvm-ach-icon svg { width: 100%; height: 100%; }
.tvm-art-wrap { position: relative; }
.tvm-tile--perfect .tvm-art { box-shadow: 0 0 0 3px #f2c94c, 0 10px 30px rgba(0,0,0,.5); }
.tvm-tile--perfect.gpfocus .tvm-art, .tvm-tile--perfect:focus .tvm-art { box-shadow: 0 0 0 4px #f2c94c, 0 0 28px rgba(242,201,76,.55), 0 18px 50px rgba(0,0,0,.7); }
.tvm-perfect { position: absolute; top: -10px; right: -10px; width: 42px; height: 42px; filter: drop-shadow(0 3px 6px rgba(0,0,0,.6)); }
.tvm-perfect svg { width: 100%; height: 100%; }
.tvm-tile.gpfocus .tvm-name, .tvm-tile:focus .tvm-name, .tvm-tile.gpfocus .tvm-ach, .tvm-tile:focus .tvm-ach { opacity: 1; }
.tvm-empty { height: 100%; display: flex; align-items: center; justify-content: center; font-size: 28px; opacity: .7; text-align: center; padding: 0 15%; }
`;

/** Cover art candidates, best first; the img walks the list on load errors. */
export function artSources(appid: number): string[] {
	const out: string[] = [];
	try {
		const store = (window as any).appStore;
		const ov = store?.GetAppOverviewByAppID?.(appid);
		const fromStore = ov && (store?.GetVerticalCapsuleURLs?.(ov) ?? store?.GetCustomVerticalCapsuleURLs?.(ov));
		if (Array.isArray(fromStore)) out.push(...fromStore.filter((u: unknown) => typeof u === 'string'));
		else if (typeof fromStore === 'string') out.push(fromStore);
	} catch {
		/* fall through to fixed URLs */
	}
	out.push(
		`https://steamloopback.host/assets/${appid}/library_600x900.jpg`,
		`https://shared.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`,
		`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
	);
	return out;
}

const Art = ({ game }: { game: TvGame }) => {
	const [sources] = useState(() => artSources(game.appid));
	const [i, setI] = useState(0);
	return (
		<div className="tvm-art">
			{i < sources.length ? (
				<img src={sources[i]} alt="" onError={() => setI((n) => n + 1)} />
			) : (
				<div className="tvm-fallback">{game.name}</div>
			)}
		</div>
	);
};

/** Keep the focused tile centred and its row on screen. */
function centre(e: any) {
	const el: HTMLElement | undefined = e?.currentTarget ?? e?.target;
	try {
		el?.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' });
	} catch {
		/* ignore */
	}
}

/** Stops B on the home screen from walking back into a blocked screen. */
export function swallow(e: any) {
	e?.preventDefault?.();
	e?.stopPropagation?.();
	return true;
}

export interface Achievements {
	unlocked: number;
	total: number;
}

type GetAchievements = (appid: number) => Promise<Achievements | null>;

/** Plain outline used until Steam's own achievement icon has been captured. */
export const FALLBACK_ICON =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H5a2 2 0 0 0 2 4h1"/><path d="M16 6h3a2 2 0 0 1-2 4h-1"/><path d="M12 13v4"/><path d="M9 20h6"/></svg>';

function useAchievements(appid: number, get: GetAchievements): Achievements | null | undefined {
	const [a, setA] = useState<Achievements | null | undefined>(undefined);
	useEffect(() => {
		let live = true;
		get(appid)
			.then((r) => live && setA(r))
			.catch(() => live && setA(null));
		return () => {
			live = false;
		};
	}, [appid]);
	return a;
}

/** Fallback 100% seal: gold disc with a star. */
const FALLBACK_PERFECT =
	'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#f2c94c" stroke="#7a5a00" stroke-width="1.5"/><path d="M12 5.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L12 15.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#fff8e1"/></svg>';

/**
 * Gold version of Steam's blue ribbon for completed games: swaps the gradient colours and
 * renames the gradient ids so gold and blue copies on the same screen don't share gradients.
 */
const goldCache = new Map<string, string>();
export function goldRibbon(svg: string): string {
	let gold = goldCache.get(svg);
	if (!gold) {
		gold = svg
			.replace(/-tvm/g, '-tvmgold')
			.replace(/#0056D6/gi, '#A86B00')
			.replace(/#1A9FFF/gi, '#F2C94C')
			.replace(/#FFAB2C/gi, '#FFF1C1')
			.replace(/#FFC82C/gi, '#FFFBEA');
		goldCache.set(svg, gold);
	}
	return gold;
}

const AchievementLine = ({ a, icon }: { a: Achievements | null | undefined; icon: () => string | null }) => {
	if (!a) return <div className="tvm-ach" aria-hidden="true" />; // reserve the line so tiles don't jump
	const done = a.unlocked >= a.total;
	return (
		<div className={'tvm-ach' + (done ? ' tvm-ach--done' : '')}>
			<span className="tvm-ach-icon" dangerouslySetInnerHTML={{ __html: (() => {
				const svg = icon();
				if (!svg) return FALLBACK_ICON;
				return done ? goldRibbon(svg) : svg;
			})() }} />
			{a.unlocked} / {a.total}
		</div>
	);
};

/** Wide hero art (the banner on a game's page), best source first. */
function heroSources(appid: number): string[] {
	return [
		`https://steamloopback.host/assets/${appid}/library_hero.jpg`,
		`https://shared.steamstatic.com/store_item_assets/steam/apps/${appid}/library_hero.jpg`,
		`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`,
	];
}

interface BgLayer {
	key: number;
	url: string;
	blur: boolean;
}

/** Full-screen background of the focused game: hero art, or its blurred cover as a fallback. */
export const Backdrop = ({ appid }: { appid: number | null }) => {
	const [layers, setLayers] = useState<BgLayer[]>([]);
	useEffect(() => {
		if (appid == null) return;
		let cancelled = false;
		const tryLoad = (urls: string[], i: number, blur: boolean) => {
			if (cancelled) return;
			if (i >= urls.length) {
				if (!blur) tryLoad(artSources(appid), 0, true);
				return;
			}
			const img = new Image();
			img.onload = () => {
				if (cancelled) return;
				// Keep the previous layer underneath so the new one fades in over it.
				setLayers((prev) => [...prev.slice(-1), { key: Date.now(), url: urls[i], blur }]);
			};
			img.onerror = () => tryLoad(urls, i + 1, blur);
			img.src = urls[i];
		};
		// Wait for a short pause so fast scrolling doesn't flicker through backgrounds.
		const t = setTimeout(() => tryLoad(heroSources(appid), 0, false), 180);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [appid]);
	return (
		<div className="tvm-bg">
			{layers.map((l) => (
				<div
					key={l.key}
					className={'tvm-bg-layer' + (l.blur ? ' tvm-bg-layer--blur' : '')}
					style={{ backgroundImage: `url("${l.url}")` }}
				/>
			))}
			<div className="tvm-bg-shade" />
		</div>
	);
};

interface TileProps {
	game: TvGame;
	autoFocus: boolean;
	openGame: (appid: number) => void;
	getAchievements: GetAchievements;
	achievementIcon: () => string | null;
	onFocusGame: (appid: number) => void;
}

const Tile = ({ game, autoFocus, openGame, getAchievements, achievementIcon, onFocusGame }: TileProps) => {
	const focused = (e: any) => {
		centre(e);
		onFocusGame(game.appid);
	};
	const a = useAchievements(game.appid, getAchievements);
	const perfect = !!a && a.total > 0 && a.unlocked >= a.total;
	return (
		<F
			className={'tvm-tile' + (perfect ? ' tvm-tile--perfect' : '')}
			autoFocus={autoFocus}
			noFocusRing
			onActivate={() => openGame(game.appid)}
			onGamepadFocus={focused}
			onFocus={focused}
		>
			<div className="tvm-art-wrap">
				<Art game={game} />
				{perfect && <span className="tvm-perfect" dangerouslySetInnerHTML={{ __html: FALLBACK_PERFECT }} />}
			</div>
			<div className="tvm-name">{game.name}</div>
			<AchievementLine a={a} icon={achievementIcon} />
		</F>
	);
};

/** Last game selected on the carousel; survives leaving and returning to it. */
let lastSelectedApp: number | null = null;

export function makeTvHome(
	readRows: () => TvRow[],
	openGame: (appid: number) => void,
	getAchievements: GetAchievements,
	achievementIcon: () => string | null,
) {
	return function TvHome() {
		const [rows, setRows] = useState<TvRow[]>(readRows);
		// Start on the game you last had selected (kept across visits), else the first one.
		const [startApp] = useState<number | null>(() => {
			const rows0 = readRows();
			const known = rows0.some((row) => row.games.some((g) => g.appid === lastSelectedApp));
			return known ? lastSelectedApp : (rows0[0]?.games[0]?.appid ?? null);
		});
		const [focusedApp, setFocusedApp] = useState<number | null>(startApp);
		// Bring the remembered game into view once Steam has focused it.
		const rootRef = useRef<HTMLDivElement | null>(null);
		useEffect(() => {
			const t = setTimeout(() => {
				const el = rootRef.current?.querySelector('.tvm-tile.gpfocus, .tvm-tile:focus') as HTMLElement | null;
				el?.scrollIntoView?.({ block: 'center', inline: 'center' });
			}, 150);
			return () => clearTimeout(t);
		}, []);
		const onFocusGame = (appid: number) => {
			lastSelectedApp = appid;
			setFocusedApp(appid);
		};
		useEffect(() => {
			const t = setInterval(() => setRows(readRows()), 5000);
			return () => clearInterval(t);
		}, []);

		if (!rows.length) {
			return (
				<div className="tvm-root">
					<style>{CSS}</style>
					<div className="tvm-empty">No TV collections yet. On your PC, make a collection whose name starts with "TV".</div>
				</div>
			);
		}

		return (
			<div className="tvm-root" ref={rootRef}>
				<style>{CSS}</style>
				<Backdrop appid={focusedApp} />
				<F className="tvm-rows" flow-children="column" onCancel={swallow} onCancelButton={swallow}>
					{rows.map((row, r) => (
						<section key={row.id} className="tvm-row">
							<div className="tvm-title">{row.name}</div>
							<div className="tvm-count">{row.games.length} games</div>
							<F className="tvm-strip" flow-children="row">
								{row.games.map((g, i) => (
									<Tile
										key={g.appid}
										game={g}
										autoFocus={startApp != null ? g.appid === startApp : r === 0 && i === 0}
										openGame={openGame}
										getAchievements={getAchievements}
										achievementIcon={achievementIcon}
										onFocusGame={onFocusGame}
									/>
								))}
							</F>
						</section>
					))}
				</F>
			</div>
		);
	};
}
