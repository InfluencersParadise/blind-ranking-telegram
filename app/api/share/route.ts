import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";

const MAX_ITEMS = 30;

function validateTelegramInitData(initData: string, botToken: string): boolean {
  if (!initData) return false;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return false;
  params.delete("hash");
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 3600) return false;
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (receivedHash.length !== calculatedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(calculatedHash, "hex"), Buffer.from(receivedHash, "hex"));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
}

async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram-Fehler in ${method}`);
  return data.result;
}

async function sendImagesFirst(token: string, chatId: string, urls: string[]) {
  for (let offset = 0; offset < urls.length; offset += 10) {
    const chunk = urls.slice(offset, offset + 10);
    if (chunk.length === 1) await telegramApi(token, "sendPhoto", { chat_id: chatId, photo: chunk[0] });
    else await telegramApi(token, "sendMediaGroup", { chat_id: chatId, media: chunk.map((url) => ({ type: "photo", media: url })) });
  }
}

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });
  const body = await request.json();
  const { initData, chatId, categoryId, ranking } = body as {
    initData?: string; chatId?: string | null; categoryId?: string | null;
    ranking?: Array<{ position: number; itemId: string; title: string }>;
  };
  if (!validateTelegramInitData(initData ?? "", botToken)) return NextResponse.json({ error: "Telegram-Anmeldung ist ungültig oder abgelaufen." }, { status: 401 });
  if (!chatId || !/^-?\d+$/.test(chatId)) return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
  if (!categoryId) return NextResponse.json({ error: "Kategorie-ID fehlt." }, { status: 400 });
  if (!Array.isArray(ranking) || ranking.length < 2 || ranking.length > MAX_ITEMS || ranking.some((e, i) => e.position !== i + 1 || !e.itemId || !e.title)) {
    return NextResponse.json({ error: "Ranking ist ungültig." }, { status: 400 });
  }

  const initParams = new URLSearchParams(initData);
  let player = "Ein Spieler";
  let userId = 0;
  try {
    const user = JSON.parse(initParams.get("user") ?? "{}");
    userId = Number(user.id);
    player = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(" ") || player;
  } catch {}
  if (!userId) return NextResponse.json({ error: "Telegram-Nutzer-ID fehlt." }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const itemIds = ranking.map((entry) => entry.itemId);
  const [{ data: items, error: itemError }, { data: category, error: categoryError }] = await Promise.all([
    supabase.from("items").select("id,title,image_url,category_id").eq("category_id", categoryId).in("id", itemIds),
    supabase.from("categories").select("name,send_images").eq("id", categoryId).single()
  ]);
  if (itemError || categoryError || !items || items.length !== ranking.length) {
    return NextResponse.json({ error: "Kategorie oder Bilder konnten nicht geladen werden." }, { status: 500 });
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const orderedItems = ranking.map((entry) => byId.get(entry.itemId)!).filter(Boolean);

  // Pro Nutzer, Gruppe und Kategorie ist exakt eine Stimme erlaubt.
  const { data: existingVote, error: existingError } = await supabase
    .from("game_votes")
    .select("id")
    .eq("category_id", categoryId)
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existingVote?.id) {
    return NextResponse.json({ error: "Du hast in dieser Gruppe für diese Kategorie bereits abgestimmt." }, { status: 409 });
  }

  const { data: vote, error: voteError } = await supabase
    .from("game_votes")
    .insert({ category_id: categoryId, chat_id: chatId, user_id: userId, player_name: player })
    .select("id")
    .single();
  if (voteError || !vote) throw voteError ?? new Error("Stimme konnte nicht gespeichert werden.");

  const { error: voteEntryError } = await supabase.from("vote_entries").insert(
    ranking.map((entry) => ({ vote_id: vote.id, item_id: entry.itemId, position: entry.position }))
  );
  if (voteEntryError) {
    await supabase.from("game_votes").delete().eq("id", vote.id);
    throw voteEntryError;
  }

  const { data: allVotes, error: allVotesError } = await supabase
    .from("game_votes")
    .select("id")
    .eq("category_id", categoryId)
    .eq("chat_id", chatId);
  if (allVotesError) throw allVotesError;
  const allVoteIds = (allVotes ?? []).map((entry) => entry.id);
  let firstPlaceEntries: Array<{ item_id: string }> = [];
  if (allVoteIds.length) {
    const { data, error } = await supabase.from("vote_entries").select("item_id").in("vote_id", allVoteIds).eq("position", 1);
    if (error) throw error;
    firstPlaceEntries = data ?? [];
  }
  const firstCounts = new Map<string, number>();
  for (const entry of firstPlaceEntries) firstCounts.set(entry.item_id, (firstCounts.get(entry.item_id) ?? 0) + 1);
  const totalVotes = allVoteIds.length;

  try {
    if (category.send_images !== false) await sendImagesFirst(botToken, chatId, orderedItems.map((item) => item.image_url));
    const rankingText = ranking.map((entry) => {
      const title = byId.get(entry.itemId)?.title ?? entry.title;
      const percent = totalVotes ? Math.round(((firstCounts.get(entry.itemId) ?? 0) / totalVotes) * 100) : 0;
      return `${entry.position}. <b>${escapeHtml(title)}</b> — ${percent}% auf Platz 1`;
    }).join("\n");
    let text = `🏆 <b>${escapeHtml(category.name)}</b> – Ranking von ${escapeHtml(player)}\n\n${rankingText}\n\n📊 Grundlage: ${totalVotes} ${totalVotes === 1 ? "Stimme" : "Stimmen"}`;
    if (text.length > 4090) text = text.slice(0, 4050) + "\n…";
    await telegramApi(botToken, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    return NextResponse.json({ ok: true, totalVotes });
  } catch (error) {
    console.error("Share failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Telegram konnte das Ranking nicht senden." }, { status: 502 });
  }
}
