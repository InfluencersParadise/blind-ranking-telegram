"use client";

import { useEffect, useMemo, useState } from "react";

type Item = { id: string; title: string; image: string };
type PreviousItem = Item & { position: number; firstPlacePercent: number };
type GameData = {
  categoryId: string;
  title?: string;
  subtitle?: string;
  items: Item[];
  alreadyVoted?: boolean;
  previousRanking?: PreviousItem[] | null;
  totalVotes?: number;
};
type TelegramWebApp = {
  ready: () => void;
  expand: () => void;
  initData: string;
  close: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: { impactOccurred: (style: string) => void };
};

declare global { interface Window { Telegram?: { WebApp: TelegramWebApp } } }

export default function Home() {
  const [game, setGame] = useState<GameData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [round, setRound] = useState(0);
  const [ranking, setRanking] = useState<(Item | null)[]>([]);
  const [status, setStatus] = useState("");
  const [sharing, setSharing] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
    webApp?.setHeaderColor?.("#0b0f17");
    webApp?.setBackgroundColor?.("#0b0f17");
    const params = new URLSearchParams(window.location.search);
    const requestedChatId = params.get("chat_id");
    const requestedCategoryId = params.get("category_id");
    setChatId(requestedChatId);
    setCategoryId(requestedCategoryId);

    fetch("/api/game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        initData: webApp?.initData ?? "",
        chatId: requestedChatId,
        categoryId: requestedCategoryId
      })
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Konfiguration konnte nicht geladen werden.");
        return data as GameData;
      })
      .then((data) => {
        if (!Array.isArray(data.items) || data.items.length < 2 || data.items.length > 30) throw new Error("Die Kategorie braucht 2 bis 30 Einträge.");
        setGame(data);
        setRanking(Array(data.items.length).fill(null));
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : "Unbekannter Ladefehler"));
  }, []);

  const items = game?.items ?? [];
  const done = game !== null && round >= items.length;
  const current = items[round];
  const gridStyle = useMemo(() => ({ gridTemplateColumns: `repeat(${Math.min(items.length, 5)}, minmax(48px, 1fr))` }), [items.length]);

  function choose(position: number) {
    if (!current || ranking[position]) return;
    const copy = [...ranking];
    copy[position] = current;
    setRanking(copy);
    setRound((value) => value + 1);
    window.Telegram?.WebApp.HapticFeedback?.impactOccurred("medium");
  }

  async function share() {
    setSharing(true);
    setStatus("Ergebnis wird gesendet …");
    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initData: window.Telegram?.WebApp.initData ?? "",
          chatId,
          categoryId: game?.categoryId ?? categoryId,
          ranking: ranking.map((item, index) => ({ position: index + 1, itemId: item?.id ?? "", title: item?.title ?? "–" }))
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Senden fehlgeschlagen");
      setStatus("✅ Ergebnis wurde in die Gruppe gesendet. Du kannst für diese Kategorie nicht erneut abstimmen.");
    } catch (error) {
      setStatus(`❌ ${error instanceof Error ? error.message : "Unbekannter Fehler"}`);
    } finally {
      setSharing(false);
    }
  }

  if (loadError) return <main><section className="card error"><div className="content"><h1>Fehler</h1><p>{loadError}</p></div></section></main>;
  if (!game) return <main><section className="card loading"><div className="content"><p>Lade Spiel …</p></div></section></main>;

  if (game.alreadyVoted && game.previousRanking?.length) {
    return (
      <main>
        <section className="card">
          <div className="content">
            <p className="brand">{game.title ?? "Blind Ranking"}</p>
            <p className="kicker">Bereits abgestimmt</p>
            <h1>Dein bisheriges Ergebnis</h1>
            <p className="muted">Du darfst pro Gruppe und Kategorie nur einmal abstimmen.</p>
            <div className="ranking">
              {game.previousRanking.map((item) => (
                <div className="rankrow" key={item.id}>
                  <div className="rankno">{item.position}</div>
                  <img src={item.image} alt="" />
                  <div><strong>{item.title}</strong><small>{item.firstPlacePercent}% wählten es auf Platz 1</small></div>
                </div>
              ))}
            </div>
            <p className="status">📊 Grundlage: {game.totalVotes ?? 0} {(game.totalVotes ?? 0) === 1 ? "Stimme" : "Stimmen"}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main>
      {!done ? (
        <section className="card">
          <img className="hero" src={current.image} alt={current.title} />
          <div className="content">
            <p className="brand">{game.title ?? "Blind Ranking"}</p>
            <p className="kicker">Runde {round + 1} von {items.length}</p>
            <h1>{current.title}</h1>
            <p className="muted">{game.subtitle ?? "Wähle einen freien Platz. Deine Entscheidung ist endgültig."}</p>
            <div className="slots" style={gridStyle}>
              {ranking.map((value, index) => <button className="slot" key={index} disabled={Boolean(value)} onClick={() => choose(index)}>{index + 1}</button>)}
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="content">
            <p className="brand">{game.title ?? "Blind Ranking"}</p>
            <p className="kicker">Fertig</p>
            <h1>Dein Blind Ranking</h1>
            <div className="ranking">
              {ranking.map((item, index) => (
                <div className="rankrow" key={index}>
                  <div className="rankno">{index + 1}</div>
                  {item && <img src={item.image} alt="" />}
                  <strong>{item?.title}</strong>
                </div>
              ))}
            </div>
            <button className="primary" disabled={sharing} onClick={share}>{sharing ? "Wird gesendet …" : "Einmalig abstimmen & teilen"}</button>
            <p className="status">{status}</p>
          </div>
        </section>
      )}
    </main>
  );
}
