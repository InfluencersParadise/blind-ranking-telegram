import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

function validateTelegramInitData(initData: string, botToken: string): boolean {
  if (!initData) return false;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return false;
  params.delete("hash");
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 3600) return false;
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (receivedHash.length !== calculatedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(calculatedHash, "hex"), Buffer.from(receivedHash, "hex"));
}

export async function POST(request: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });

    const body = await request.json() as { initData?: string; chatId?: string | null; categoryId?: string | null };
    if (!validateTelegramInitData(body.initData ?? "", botToken)) {
      return NextResponse.json({ error: "Telegram-Anmeldung ist ungültig oder abgelaufen." }, { status: 401 });
    }
    if (!body.chatId || !/^-?\d+$/.test(body.chatId)) {
      return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
    }

    const params = new URLSearchParams(body.initData);
    const user = JSON.parse(params.get("user") ?? "{}");
    const userId = Number(user.id);
    if (!userId) return NextResponse.json({ error: "Telegram-Nutzer-ID fehlt." }, { status: 400 });

    const supabase = getSupabaseAdmin();
    let categoryId = body.categoryId ?? null;
    if (!categoryId) {
      const { data: setting, error } = await supabase
        .from("app_settings")
        .select("active_category_id")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      categoryId = setting?.active_category_id ?? null;
    }
    if (!categoryId) return NextResponse.json({ error: "Noch keine aktive Kategorie vorhanden." }, { status: 404 });

    const [{ data: category, error: categoryError }, { data: items, error: itemsError }] = await Promise.all([
      supabase.from("categories").select("id,name").eq("id", categoryId).single(),
      supabase.from("items").select("id,title,image_url,position").eq("category_id", categoryId).order("position", { ascending: true })
    ]);
    if (categoryError) throw categoryError;
    if (itemsError) throw itemsError;
    if (!items || items.length < 2 || items.length > 30) {
      return NextResponse.json({ error: "Die Kategorie braucht 2 bis 30 Bilder." }, { status: 400 });
    }

    const { data: existingVote, error: voteError } = await supabase
      .from("game_votes")
      .select("id")
      .eq("category_id", categoryId)
      .eq("chat_id", body.chatId)
      .eq("user_id", userId)
      .maybeSingle();
    if (voteError) throw voteError;

    let previousRanking: Array<{ position: number; id: string; title: string; image: string; firstPlacePercent: number }> | null = null;
    let totalVotes = 0;

    if (existingVote?.id) {
      const [{ data: ownEntries, error: ownError }, { data: votes, error: allVotesError }] = await Promise.all([
        supabase.from("vote_entries").select("item_id,position").eq("vote_id", existingVote.id).order("position", { ascending: true }),
        supabase.from("game_votes").select("id").eq("category_id", categoryId).eq("chat_id", body.chatId)
      ]);
      if (ownError) throw ownError;
      if (allVotesError) throw allVotesError;
      const voteIds = (votes ?? []).map((vote) => vote.id);
      totalVotes = voteIds.length;
      let firstEntries: Array<{ item_id: string }> = [];
      if (voteIds.length) {
        const { data, error } = await supabase.from("vote_entries").select("item_id").in("vote_id", voteIds).eq("position", 1);
        if (error) throw error;
        firstEntries = data ?? [];
      }
      const firstCounts = new Map<string, number>();
      for (const entry of firstEntries) firstCounts.set(entry.item_id, (firstCounts.get(entry.item_id) ?? 0) + 1);
      const itemById = new Map(items.map((item) => [item.id, item]));
      previousRanking = (ownEntries ?? []).map((entry) => {
        const item = itemById.get(entry.item_id)!;
        return {
          position: entry.position,
          id: item.id,
          title: item.title,
          image: item.image_url,
          firstPlacePercent: totalVotes ? Math.round(((firstCounts.get(item.id) ?? 0) / totalVotes) * 100) : 0
        };
      }).filter((entry) => entry.id);
    }

    const shuffled = [...items].sort(() => Math.random() - 0.5);
    return NextResponse.json({
      categoryId,
      title: category.name,
      subtitle: "Wähle einen freien Platz. Deine Entscheidung ist endgültig.",
      items: shuffled.map((item) => ({ id: item.id, title: item.title, image: item.image_url })),
      alreadyVoted: Boolean(existingVote?.id),
      previousRanking,
      totalVotes
    });
  } catch (error) {
    console.error("Game API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Spiel konnte nicht geladen werden." }, { status: 500 });
  }
}
