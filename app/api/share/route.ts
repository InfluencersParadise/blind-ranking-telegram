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
    if (chunk.length === 1) {
      await telegramApi(token, "sendPhoto", { chat_id: chatId, photo: chunk[0] });
    } else {
      await telegramApi(token, "sendMediaGroup", { chat_id: chatId, media: chunk.map((url) => ({ type: "photo", media: url })) });
    }
  }
}

function buildDistribution(items: Array<{ id: string; title: string }>, entries: Array<{ item_id: string; position: number }>, otherVoteCount: number) {
  if (!otherVoteCount) return "<b>📊 Verteilung anderer Nutzer</b>\nNoch keine anderen Stimmen in dieser Gruppe.";
  const lines = ["<b>📊 Verteilung anderer Nutzer</b>", `${otherVoteCount} andere${otherVoteCount === 1 ? " Stimme" : " Stimmen"}:`];
  for (const item of items) {
    const counts = new Map<number, number>();
    for (const entry of entries) if (entry.item_id === item.id) counts.set(entry.position, (counts.get(entry.position) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3);
    const summary = top.length ? top.map(([pos, count]) => `#${pos} ${Math.round((count / otherVoteCount) * 100)}%`).join(" · ") : "keine Daten";
    lines.push(`• <b>${escapeHtml(item.title)}</b>: ${summary}`);
  }
  return lines.join("\n");
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
  const itemIds = ranking.map((e) => e.itemId);
  const [{ data: items, error: itemError }, { data: category, error: categoryError }] = await Promise.all([
    supabase.from("items").select("id,title,image_url,category_id").eq("category_id", categoryId).in("id", itemIds),
    supabase.from("categories").select("name,send_images").eq("id", categoryId).single()
  ]);
  if (itemError || categoryError || !items || items.length !== ranking.length) return NextResponse.json({ error: "Kategorie oder Bilder konnten nicht geladen werden." }, { status: 500 });
  const byId = new Map(items.map((item) => [item.id, item]));
  const orderedItems = ranking.map((entry) => byId.get(entry.itemId)!).filter(Boolean);

  // Die vorherigen Stimmen dieses Nutzers ersetzen, damit jede Person pro Kategorie/Gruppe genau eine gültige Stimme hat.
  const { data: existingVote } = await supabase.from("game_votes").select("id").eq("category_id", categoryId).eq("chat_id", chatId).eq("user_id", userId).maybeSingle();
  let voteId: string;
  if (existingVote?.id) {
    voteId = existingVote.id;
    await supabase.from("vote_entries").delete().eq("vote_id", voteId);
    await supabase.from("game_votes").update({ player_name: player, updated_at: new Date().toISOString() }).eq("id", voteId);
  } else {
    const { data: vote, error } = await supabase.from("game_votes").insert({ category_id: categoryId, chat_id: chatId, user_id: userId, player_name: player }).select("id").single();
    if (error || !vote) throw error ?? new Error("Stimme konnte nicht gespeichert werden.");
    voteId = vote.id;
  }
  const { error: voteEntryError } = await supabase.from("vote_entries").insert(ranking.map((entry) => ({ vote_id: voteId, item_id: entry.itemId, position: entry.position })));
  if (voteEntryError) throw voteEntryError;

  const { data: otherVotes } = await supabase.from("game_votes").select("id").eq("category_id", categoryId).eq("chat_id", chatId).neq("user_id", userId);
  const otherVoteIds = (otherVotes ?? []).map((v) => v.id);
  let otherEntries: Array<{ item_id: string; position: number }> = [];
  if (otherVoteIds.length) {
    const { data } = await supabase.from("vote_entries").select("item_id,position").in("vote_id", otherVoteIds);
    otherEntries = data ?? [];
  }

  try {
    if (category.send_images !== false) await sendImagesFirst(botToken, chatId, orderedItems.map((item) => item.image_url));
    const rankingText = ranking.map((entry) => `${entry.position}. <b>${escapeHtml(byId.get(entry.itemId)?.title ?? entry.title)}</b>`).join("\n");
    const distribution = buildDistribution(orderedItems.map((item) => ({ id: item.id, title: item.title })), otherEntries, otherVoteIds.length);
    let text = `🏆 <b>${escapeHtml(category.name)}</b> – Ranking von ${escapeHtml(player)}\n\n${rankingText}\n\n${distribution}`;
    if (text.length > 4090) text = text.slice(0, 4050) + "\n…";
    await telegramApi(botToken, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    return NextResponse.json({ ok: true, otherVoteCount: otherVoteIds.length });
  } catch (error) {
    console.error("Share failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Telegram konnte das Ranking nicht senden." }, { status: 502 });
  }
}
