"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export default function GuessPage() {
  const [data, setData] = useState<any>(null);
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<any>(null);
  const [hint, setHint] = useState(0);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const gameId = useMemo(
    () => new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("game_id") ?? new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("gameId"),
    []
  );

  useEffect(() => {
    const tg = window.Telegram?.WebApp as any;

    const syncViewport = () => {
      const height = tg?.viewportStableHeight || tg?.viewportHeight || window.visualViewport?.height || window.innerHeight;
      document.documentElement.style.setProperty("--guess-app-height", `${Math.round(height)}px`);
    };

    tg?.ready();
    tg?.expand();
    syncViewport();
    tg?.onEvent?.("viewportChanged", syncViewport);
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", syncViewport);

    fetch("/api/guess/game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg?.initData ?? "", gameId }),
    })
      .then((response) => response.json())
      .then(setData);

    return () => {
      tg?.offEvent?.("viewportChanged", syncViewport);
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
    };
  }, [gameId]);

  useEffect(() => {
    if (!result) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.setTimeout(() => {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }, [result]);

  if (!data) return <main className="app-shell guess-shell"><p>Lädt…</p></main>;
  if (data.error) return <main className="app-shell guess-shell"><p>{data.error}</p></main>;

  const round = data.rounds[i];
  if (!round) return <main className="app-shell guess-shell"><h1>Geschafft 🎉</h1></main>;

  const media = round.media[Math.min(hint, round.media.length - 1)];
  const answerMode = round.answerMode ?? data.game.answer_mode;

  async function check(value = answer) {
    if (!value.trim()) return;
    const tg = window.Telegram?.WebApp as any;
    const response = await fetch("/api/guess/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        initData: tg?.initData ?? "",
        gameId,
        personId: round.personId,
        answer: value,
      }),
    });
    setResult(await response.json());
  }

  function nextRound() {
    setI((value) => value + 1);
    setAnswer("");
    setResult(null);
    setHint(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="app-shell guess-shell">
      <section className="hero">
        <span className="eyebrow">🧩 INFLUENCERIN ERRATEN</span>
        <h1>{data.game.title}</h1>
        <p>Runde {i + 1} von {data.rounds.length}</p>
      </section>

      <section className="guess-card">
        {media?.media_type === "animation" ? (
          <video src={media.media_url} autoPlay loop muted playsInline />
        ) : (
          <img src={media?.media_url} alt="Bildausschnitt oder Tipp" />
        )}

        <div className="guess-controls">
          {answerMode === "multiple_choice" ? (
            round.choices.map((choice: string) => (
              <button key={choice} type="button" disabled={Boolean(result)} onClick={() => check(choice)}>
                {choice}
              </button>
            ))
          ) : (
            <>
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") check();
                }}
                disabled={Boolean(result)}
                placeholder="Name eingeben"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button type="button" disabled={Boolean(result) || !answer.trim()} onClick={() => check()}>
                Antwort prüfen
              </button>
            </>
          )}

          {data.game.hints_enabled && hint < round.media.length - 1 && !result && (
            <button type="button" onClick={() => setHint((value) => value + 1)}>
              Größeren Ausschnitt / Tipp zeigen
            </button>
          )}
        </div>

        {result && (
          <div className="result-box" ref={resultRef} aria-live="polite">
            <strong>{result.correct ? "✅ Richtig" : "❌ Noch nicht richtig"}</strong>
            {result.suggestion && <p>Meintest du „{result.suggestion}“?</p>}
            <p>Lösung: {result.correctName}</p>
            <p>Punkte: {result.points ?? 0}</p>
            <button type="button" onClick={nextRound}>Weiter</button>
          </div>
        )}
      </section>
    </main>
  );
}
