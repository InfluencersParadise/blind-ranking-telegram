"use client";

import { useEffect, useMemo, useState } from "react";

type Item = { id: string; title: string; image: string };
type GameData = { title?: string; subtitle?: string; items: Item[] };
type TelegramWebApp = {
  ready: () => void;
  expand: () => void;
  initData: string;
  close: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: { impactOccurred: (style: string) => void };
};

declare global {
  interface Window { Telegram?: { WebApp: TelegramWebApp } }
}

export default function Home() {
  const [game, setGame] = useState<GameData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [round, setRound] = useState(0);
  const [ranking, setRanking] = useState<(Item | null)[]>([]);
  const [status, setStatus] = useState("");
  const [sharing, setSharing] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    webApp?.ready();
    webApp?.expand();
    webApp?.setHeaderColor?.("#0b0f17");
    webApp?.setBackgroundColor?.("#0b0f17");
    setChatId(new URLSearchParams(window.location.search).get("chat_id"));

    fetch("/game-data.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Konfiguration konnte nicht geladen werden.");
        return response.json() as Promise<GameData>;
      })
      .then((data) => {
        if (!Array.isArray(data.items) || data.items.length < 2 || data.items.length > 10) {
          throw new Error("In game-data.json müssen 2 bis 10 Einträge stehen.");
        }
        const valid = data.items.every((item) => item.id && item.title && item.image);
        if (!valid) throw new Error("Jeder Eintrag braucht id, title und image.");
        setGame(data);
        setRanking(Array(data.items.length).fill(null));
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : "Unbekannter Ladefehler"));
  }, []);

  const items = game?.items ?? [];
  const done = game !== null && round >= items.length;
  const current = items[round];
  const gridStyle = useMemo(() => ({ gridTemplateColumns: `repeat(${Math.min(items.length, 5)}, 1fr)` }), [items.length]);

  function choose(position: number) {
    if (!current || ranking[position]) return;
    const copy = [...ranking];
    copy[position] = current;
    setRanking(copy);
    setRound((r) => r + 1);
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
          ranking: ranking.map((item, index) => ({ position: index + 1, title: item?.title ?? "–" }))
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Senden fehlgeschlagen");
      setStatus("✅ Ergebnis wurde in die Gruppe gesendet.");
    } catch (error) {
      setStatus(`❌ ${error instanceof Error ? error.message : "Unbekannter Fehler"}`);
    } finally {
      setSharing(false);
    }
  }

  if (loadError) {
    return <main><section className="card error"><div className="content"><h1>Konfigurationsfehler</h1><p>{loadError}</p></div></section></main>;
  }

  if (!game) {
    return <main><section className="card loading"><div className="content"><p>Lade Spiel …</p></div></section></main>;
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
              {ranking.map((value, index) => (
                <button className="slot" key={index} disabled={Boolean(value)} onClick={() => choose(index)}>
                  {index + 1}
                </button>
              ))}
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
            <button className="primary" disabled={sharing} onClick={share}>
              {sharing ? "Wird gesendet …" : "In Telegram-Gruppe teilen"}
            </button>
            <p className="status">{status}</p>
          </div>
        </section>
      )}
    </main>
  );
}
