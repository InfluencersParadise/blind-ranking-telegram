import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";

export const dynamic = "force-dynamic";

function shuffled<T>(values: T[]) {
  return [...values].sort(() => Math.random() - 0.5);
}

export async function POST(request: NextRequest) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });

    const body = await request.json() as { initData?: string; gameId?: string };
    const auth = validateTelegramInitData(body.initData ?? "", token);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason) }, { status: 401 });

    const sb = getSupabaseAdmin();
    const { data: game } = await sb
      .from("guess_games")
      .select("id,title,answer_mode,hints_enabled,send_images,is_active")
      .eq("id", body.gameId)
      .maybeSingle();

    if (!game?.is_active) return NextResponse.json({ error: "Kategorie nicht aktiv." }, { status: 404 });

    const { data: people } = await sb
      .from("guess_people")
      .select("id,display_name,aliases,sort_order")
      .eq("game_id", game.id)
      .order("sort_order");

    const ids = (people ?? []).map((person) => person.id);
    const { data: media } = ids.length
      ? await sb.from("guess_media").select("id,person_id,media_url,media_type,hint_level,sort_order").in("person_id", ids).order("hint_level")
      : { data: [] as any[] };

    // Für Einzelspiele und kleine Kategorien holen wir zusätzliche Namen als faire Ablenkungen.
    const { data: choicePoolRows } = await sb
      .from("guess_people")
      .select("display_name")
      .limit(80);
    const choicePool = Array.from(new Set((choicePoolRows ?? []).map((row) => row.display_name).filter(Boolean)));

    const rounds = (people ?? []).map((person) => {
      const answerMode = game.answer_mode === "mixed"
        ? (Math.random() < 0.5 ? "free_text" : "multiple_choice")
        : game.answer_mode;
      const distractors = shuffled(choicePool.filter((name) => name !== person.display_name)).slice(0, 3);
      const choices = shuffled([person.display_name, ...distractors]);
      return {
        personId: person.id,
        displayName: person.display_name,
        answerMode,
        choices,
        media: (media ?? []).filter((entry) => entry.person_id === person.id),
      };
    });

    return NextResponse.json({ game, rounds });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Fehler" }, { status: 500 });
  }
}
