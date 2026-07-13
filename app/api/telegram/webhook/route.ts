import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, IMAGE_BUCKET } from "../../../../lib/supabase";

type TelegramChat = { id: number; type: "private" | "group" | "supergroup" | "channel" };
type TelegramUser = { id: number; username?: string; first_name?: string };
type TelegramPhoto = { file_id: string; width: number; height: number };
type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
  photo?: TelegramPhoto[];
};
type CallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};
type TelegramUpdate = { message?: TelegramMessage; callback_query?: CallbackQuery };

type CategoryRow = { id: string; name: string };
type SessionRow = {
  category_id: string | null;
  mode: string;
  pending_file_id: string | null;
  pending_item_id: string | null;
};

async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API error in ${method}`);
  return data.result;
}

async function send(token: string, chatId: string | number, text: string, extra: Record<string, unknown> = {}) {
  return telegramApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

async function answerCallback(token: string, callbackQueryId: string, text?: string) {
  return telegramApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
}

function commandArg(text: string) {
  const firstSpace = text.indexOf(" ");
  return firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
}

async function uploadTelegramPhoto(token: string, fileId: string, userId: number) {
  const file = await telegramApi(token, "getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram hat keinen Dateipfad geliefert.");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error("Bild konnte nicht von Telegram geladen werden.");
  const arrayBuffer = await response.arrayBuffer();
  const extension = String(file.file_path).split(".").pop()?.toLowerCase() || "jpg";
  const objectPath = `${userId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(objectPath, arrayBuffer, {
    contentType: response.headers.get("content-type") || "image/jpeg",
    upsert: false
  });
  if (error) throw error;
  const imageUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(objectPath).data.publicUrl;
  return { imageUrl, objectPath };
}

async function findCategoryByName(name: string): Promise<CategoryRow | null> {
  if (!name.trim()) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("categories").select("id,name").ilike("name", name.trim()).limit(1).maybeSingle();
  if (error) throw error;
  return data as CategoryRow | null;
}

async function getSession(userId: number): Promise<SessionRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("admin_sessions")
    .select("category_id,mode,pending_file_id,pending_item_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as SessionRow | null;
}

async function setSession(userId: number, values: Partial<SessionRow> & { category_id?: string | null }) {
  const supabase = getSupabaseAdmin();
  const existing = await getSession(userId);
  const payload = {
    user_id: userId,
    category_id: values.category_id ?? existing?.category_id ?? null,
    mode: values.mode ?? existing?.mode ?? "awaiting_photo",
    pending_file_id: values.pending_file_id !== undefined ? values.pending_file_id : existing?.pending_file_id ?? null,
    pending_item_id: values.pending_item_id !== undefined ? values.pending_item_id : existing?.pending_item_id ?? null,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("admin_sessions").upsert(payload);
  if (error) throw error;
}

async function categoryCount(categoryId: string) {
  const { count, error } = await getSupabaseAdmin().from("items").select("id", { count: "exact", head: true }).eq("category_id", categoryId);
  if (error) throw error;
  return count ?? 0;
}

async function normalizePositions(categoryId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("items").select("id").eq("category_id", categoryId).order("position", { ascending: true });
  if (error) throw error;
  for (let i = 0; i < (data ?? []).length; i += 1) {
    const { error: updateError } = await supabase.from("items").update({ position: i + 1 }).eq("id", data![i].id);
    if (updateError) throw updateError;
  }
}


async function sendCommands(token: string, chatId: string | number, isAdmin: boolean) {
  const adminSection = isAdmin
    ? "\n\n<b>🛠 Verwaltung</b>\n" +
      "<code>/neuekategorie Name</code> – neue Kategorie anlegen\n" +
      "<code>/kategorien</code> – Kategorien mit Buttons verwalten\n" +
      "<code>/bearbeiten Kategorie</code> – Kategorie direkt öffnen\n" +
      "<code>/loeschen Kategorie</code> – Kategorie löschen (mit Bestätigung)\n" +
      "<code>/fertig</code> – Bearbeitung abschließen und aktivieren\n" +
      "<code>/abbrechen</code> – aktuelle Eingabe abbrechen\n\n" +
      "<b>🖼 Bilder</b>\n" +
      "Sende ein Bild im privaten Chat. Den Namen kannst du direkt als Bildunterschrift mitsenden.\n" +
      "Pro Kategorie sind 2 bis 30 Bilder möglich. In der Kategorienverwaltung kannst du Ergebnisbilder ein- oder ausschalten."
    : "";

  const keyboard = isAdmin
    ? [
        [{ text: "🎮 Spiel starten", callback_data: "menuplay:x" }],
        [{ text: "➕ Neue Kategorie", callback_data: "menunew:x" }, { text: "📂 Kategorien", callback_data: "menucats:x" }],
        [{ text: "❓ Hilfe", callback_data: "menuhelp:x" }]
      ]
    : [[{ text: "🎮 Spiel starten", callback_data: "menuplay:x" }]];

  await send(
    token,
    chatId,
    "<b>🤖 Blind Ranking – Befehle</b>\n\n" +
      "<b>🎮 Spiel</b>\n" +
      "<code>/blindranking</code> – aktive Kategorie starten\n" +
      "<code>/blindranking Kategorie</code> – bestimmte Kategorie starten\n" +
      "<code>/statistik Kategoriename</code> – ausführliche Punkte- und Platzstatistik\n" +
      "<code>/top</code> – meistgespielte Kategorien anzeigen\n" +
      "<code>/leaderboard</code> – aktivste Spieler dieser Gruppe anzeigen\n" +
      "<code>/history</code> – letzte Abstimmungen dieser Gruppe anzeigen\n" +
      "<code>/commands</code> – diese Übersicht anzeigen" +
      adminSection,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function categoryMenu(token: string, chatId: string | number) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("categories").select("id,name,items(count)").order("created_at", { ascending: false });
  if (error) throw error;
  if (!data?.length) {
    await send(token, chatId, "Noch keine Kategorien vorhanden. Erstelle eine mit <code>/neuekategorie Name</code>.");
    return;
  }
  const buttons = data.map((category: any) => [{
    text: `${category.name} (${category.items?.[0]?.count ?? 0})`,
    callback_data: `cat:${category.id}`
  }]);
  await send(token, chatId, "<b>Kategorien verwalten</b>\n\nTippe eine Kategorie an:", {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showCategoryActions(token: string, chatId: string | number, categoryId: string) {
  const supabase = getSupabaseAdmin();
  const { data: category, error } = await supabase.from("categories").select("id,name,send_images").eq("id", categoryId).maybeSingle();
  if (error) throw error;
  if (!category) {
    await send(token, chatId, "Kategorie nicht gefunden.");
    return;
  }
  const count = await categoryCount(categoryId);
  const imageMode = category.send_images !== false ? "🖼 Bilder werden gesendet" : "📝 Nur Text wird gesendet";
  await send(token, chatId, `<b>${escapeHtml(category.name)}</b>\n${count} Bilder\n${imageMode}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Aktivieren", callback_data: `activate:${categoryId}` }, { text: "➕ Bild hinzufügen", callback_data: `add:${categoryId}` }],
        [{ text: "🖼 Bilder verwalten", callback_data: `items:${categoryId}` }],
        [{ text: category.send_images !== false ? "📝 Ergebnis ohne Bilder" : "🖼 Ergebnis mit Bildern", callback_data: `toggleimages:${categoryId}` }],
        [{ text: "✏️ Kategorie umbenennen", callback_data: `renamecat:${categoryId}` }],
        [{ text: "🗑 Kategorie löschen", callback_data: `delcatask:${categoryId}` }]
      ]
    }
  });
}

async function showItems(token: string, chatId: string | number, categoryId: string) {
  const supabase = getSupabaseAdmin();
  const { data: category } = await supabase.from("categories").select("name").eq("id", categoryId).maybeSingle();
  const { data, error } = await supabase.from("items").select("id,title,position").eq("category_id", categoryId).order("position", { ascending: true });
  if (error) throw error;
  if (!data?.length) {
    await send(token, chatId, "Diese Kategorie enthält noch keine Bilder.");
    return;
  }
  const buttons = data.map((item) => [{ text: `${item.position}. ${item.title}`, callback_data: `item:${item.id}` }]);
  await send(token, chatId, `<b>Bilder: ${escapeHtml(category?.name ?? "Kategorie")}</b>\n\nTippe einen Eintrag an:`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleCallback(token: string, callback: CallbackQuery, adminId: number) {
  if (callback.from.id !== adminId || !callback.message?.chat?.id || !callback.data) {
    await answerCallback(token, callback.id, "Nicht erlaubt");
    return;
  }
  const chatId = String(callback.message.chat.id);
  const [action, id] = callback.data.split(":", 2);
  const supabase = getSupabaseAdmin();
  await answerCallback(token, callback.id);

  if (action === "menuhelp") return sendCommands(token, chatId, true);
  if (action === "menucats") return categoryMenu(token, chatId);
  if (action === "menunew") {
    await setSession(adminId, { category_id: null, mode: "awaiting_new_category_name", pending_file_id: null, pending_item_id: null });
    await send(token, chatId, "Sende jetzt den Namen der neuen Kategorie.");
    return;
  }
  if (action === "menuplay") {
    const { data: setting } = await supabase.from("app_settings").select("active_category_id").eq("id", 1).maybeSingle();
    if (!setting?.active_category_id) return send(token, chatId, "Noch keine aktive Kategorie vorhanden.");
    const bot = await telegramApi(token, "getMe", {});
    const deepLink = `https://t.me/${bot.username}?start=group_${chatId}_${setting.active_category_id}`;
    await send(token, chatId, "🎮 Aktives Blind Ranking öffnen:", {
      reply_markup: { inline_keyboard: [[{ text: "🎮 Spiel öffnen", url: deepLink }]] }
    });
    return;
  }
  if (action === "cat") return showCategoryActions(token, chatId, id);
  if (action === "activate") {
    await supabase.from("app_settings").upsert({ id: 1, active_category_id: id });
    await send(token, chatId, "✅ Kategorie wurde aktiviert.");
    return;
  }
  if (action === "add") {
    await setSession(adminId, { category_id: id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
    await send(token, chatId, "Sende jetzt ein neues Bild. Du kannst den Namen direkt als Bildunterschrift mitsenden.");
    return;
  }
  if (action === "items") return showItems(token, chatId, id);
  if (action === "toggleimages") {
    const { data: category } = await supabase.from("categories").select("send_images").eq("id", id).maybeSingle();
    if (!category) return send(token, chatId, "Kategorie nicht gefunden.");
    const nextValue = category.send_images === false;
    const { error } = await supabase.from("categories").update({ send_images: nextValue }).eq("id", id);
    if (error) throw error;
    await send(token, chatId, nextValue ? "✅ Ergebnisbilder sind aktiviert." : "✅ Ergebnisse werden künftig nur als Text gesendet.");
    return showCategoryActions(token, chatId, id);
  }
  if (action === "renamecat") {
    await setSession(adminId, { category_id: id, mode: "awaiting_category_name", pending_file_id: null, pending_item_id: null });
    await send(token, chatId, "Sende jetzt den neuen Namen der Kategorie.");
    return;
  }
  if (action === "delcatask") {
    await send(token, chatId, "Kategorie wirklich endgültig löschen?", {
      reply_markup: { inline_keyboard: [[{ text: "Ja, löschen", callback_data: `delcat:${id}` }, { text: "Abbrechen", callback_data: "noop:x" }]] }
    });
    return;
  }
  if (action === "delcat") {
    await supabase.from("categories").delete().eq("id", id);
    await send(token, chatId, "🗑 Kategorie gelöscht.");
    return;
  }
  if (action === "item") {
    const { data: item } = await supabase.from("items").select("id,title,category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await send(token, chatId, `<b>${escapeHtml(item.title)}</b>`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✏️ Namen ändern", callback_data: `renameitem:${item.id}` }, { text: "📷 Bild ersetzen", callback_data: `replace:${item.id}` }],
          [{ text: "🗑 Eintrag löschen", callback_data: `delitemask:${item.id}` }]
        ]
      }
    });
    return;
  }
  if (action === "renameitem") {
    const { data: item } = await supabase.from("items").select("category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await setSession(adminId, { category_id: item.category_id, mode: "awaiting_item_name", pending_item_id: id, pending_file_id: null });
    await send(token, chatId, "Sende jetzt den neuen Namen.");
    return;
  }
  if (action === "replace") {
    const { data: item } = await supabase.from("items").select("category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await setSession(adminId, { category_id: item.category_id, mode: "awaiting_replacement_photo", pending_item_id: id, pending_file_id: null });
    await send(token, chatId, "Sende jetzt das neue Bild.");
    return;
  }
  if (action === "delitemask") {
    await send(token, chatId, "Eintrag wirklich löschen?", {
      reply_markup: { inline_keyboard: [[{ text: "Ja, löschen", callback_data: `delitem:${id}` }, { text: "Abbrechen", callback_data: "noop:x" }]] }
    });
    return;
  }
  if (action === "delitem") {
    const { data: item } = await supabase.from("items").select("category_id,storage_path").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await supabase.from("items").delete().eq("id", id);
    if (item.storage_path) await supabase.storage.from(IMAGE_BUCKET).remove([item.storage_path]);
    await normalizePositions(item.category_id);
    await send(token, chatId, "🗑 Eintrag gelöscht.");
    return;
  }
}


function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "gerade eben";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(value));
}

async function sendTopCategories(token: string, chatId: string) {
  const supabase = getSupabaseAdmin();
  const [{ data: votes, error: votesError }, { data: categories, error: categoryError }] = await Promise.all([
    supabase.from("game_votes").select("category_id"),
    supabase.from("categories").select("id,name")
  ]);
  if (votesError) throw votesError;
  if (categoryError) throw categoryError;
  if (!votes?.length) {
    await send(token, chatId, "🏆 Noch keine Kategorien wurden bewertet.");
    return;
  }
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote.category_id, (counts.get(vote.category_id) ?? 0) + 1);
  const names = new Map((categories ?? []).map((category) => [category.id, category.name]));
  const ranking = [...counts.entries()]
    .map(([id, count]) => ({ id, count, name: names.get(id) ?? "Gelöschte Kategorie" }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"))
    .slice(0, 10);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ranking.map((entry, index) => `${medals[index] ?? `${index + 1}.`} <b>${escapeHtml(entry.name)}</b> — ${entry.count} ${entry.count === 1 ? "Vote" : "Votes"}`);
  await send(token, chatId, `<b>🏆 Top Kategorien</b>\n\n${lines.join("\n")}`);
}

async function sendLeaderboard(token: string, chatId: string) {
  const supabase = getSupabaseAdmin();
  const { data: votes, error } = await supabase
    .from("game_votes")
    .select("user_id,player_name")
    .eq("chat_id", chatId);
  if (error) throw error;
  if (!votes?.length) {
    await send(token, chatId, "🏅 In dieser Gruppe gibt es noch keine Abstimmungen.");
    return;
  }
  const players = new Map<number, { name: string; count: number }>();
  for (const vote of votes) {
    const current = players.get(Number(vote.user_id));
    players.set(Number(vote.user_id), { name: vote.player_name || current?.name || "Unbekannt", count: (current?.count ?? 0) + 1 });
  }
  const ranking = [...players.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de")).slice(0, 15);
  const lines = ranking.map((entry, index) => `${index + 1}. <b>${escapeHtml(entry.name)}</b> — ${entry.count} ${entry.count === 1 ? "Ranking" : "Rankings"}`);
  await send(token, chatId, `<b>🏅 Aktivste Spieler</b>\n\n${lines.join("\n")}`);
}

async function sendHistory(token: string, chatId: string) {
  const supabase = getSupabaseAdmin();
  const { data: votes, error } = await supabase
    .from("game_votes")
    .select("category_id,player_name,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) throw error;
  if (!votes?.length) {
    await send(token, chatId, "📜 In dieser Gruppe gibt es noch keine Abstimmungen.");
    return;
  }
  const categoryIds = [...new Set(votes.map((vote) => vote.category_id))];
  const { data: categories, error: categoryError } = await supabase.from("categories").select("id,name").in("id", categoryIds);
  if (categoryError) throw categoryError;
  const names = new Map((categories ?? []).map((category) => [category.id, category.name]));
  const lines = votes.map((vote, index) => `${index + 1}. <b>${escapeHtml(names.get(vote.category_id) ?? "Gelöschte Kategorie")}</b> — ${escapeHtml(vote.player_name)} · ${relativeTime(vote.created_at)}`);
  await send(token, chatId, `<b>📜 Letzte Abstimmungen</b>\n\n${lines.join("\n")}`);
}


async function sendStatistics(token: string, chatId: string, categoryName: string) {
  const category = await findCategoryByName(categoryName);
  if (!category) {
    await send(token, chatId, "Kategorie nicht gefunden. Beispiel: <code>/statistik Test</code>");
    return;
  }

  const supabase = getSupabaseAdmin();
  const [{ data: votes, error: votesError }, { data: items, error: itemsError }] = await Promise.all([
    supabase.from("game_votes").select("id").eq("category_id", category.id).eq("chat_id", chatId),
    supabase.from("items").select("id,title,position").eq("category_id", category.id).order("position", { ascending: true })
  ]);
  if (votesError) throw votesError;
  if (itemsError) throw itemsError;

  const voteIds = (votes ?? []).map((vote) => vote.id);
  if (!voteIds.length) {
    await send(token, chatId, `📊 Für <b>${escapeHtml(category.name)}</b> gibt es in dieser Gruppe noch keine Stimmen.`);
    return;
  }

  const { data: entries, error: entriesError } = await supabase
    .from("vote_entries")
    .select("item_id,position")
    .in("vote_id", voteIds);
  if (entriesError) throw entriesError;

  const itemCount = (items ?? []).length;
  const pointsByItem = new Map<string, number>();
  const positionCounts = new Map<string, Map<number, number>>();
  for (const entry of entries ?? []) {
    const points = Math.max(1, itemCount - entry.position + 1);
    pointsByItem.set(entry.item_id, (pointsByItem.get(entry.item_id) ?? 0) + points);
    const counts = positionCounts.get(entry.item_id) ?? new Map<number, number>();
    counts.set(entry.position, (counts.get(entry.position) ?? 0) + 1);
    positionCounts.set(entry.item_id, counts);
  }

  const maxPoints = itemCount * voteIds.length;
  const rankedItems = (items ?? [])
    .map((item) => ({
      ...item,
      points: pointsByItem.get(item.id) ?? 0,
      firstPlaceCount: positionCounts.get(item.id)?.get(1) ?? 0
    }))
    .sort((a, b) => b.points - a.points || b.firstPlaceCount - a.firstPlaceCount || a.title.localeCompare(b.title, "de"));

  const scoreLines = rankedItems.map((item, index) => {
    const percentage = maxPoints > 0 ? Math.round((item.points / maxPoints) * 100) : 0;
    return `${index + 1}. <b>${escapeHtml(item.title)}</b> — ${item.points}/${maxPoints} Punkte (${percentage}%)`;
  });

  const distributionBlocks = rankedItems.map((item) => {
    const counts = positionCounts.get(item.id) ?? new Map<number, number>();
    const parts: string[] = [];
    for (let position = 1; position <= itemCount; position += 1) {
      const count = counts.get(position) ?? 0;
      if (count > 0) parts.push(`#${position} ${Math.round((count / voteIds.length) * 100)}%`);
    }
    return `<b>${escapeHtml(item.title)}</b>\n${parts.join(" · ") || "Keine Platzierungen"}`;
  });

  const favorite = rankedItems[0];
  const firstPick = [...rankedItems].sort((a, b) => b.firstPlaceCount - a.firstPlaceCount || b.points - a.points)[0];
  const controversial = [...rankedItems]
    .map((item) => {
      const counts = positionCounts.get(item.id) ?? new Map<number, number>();
      const mean = [...counts.entries()].reduce((sum, [position, count]) => sum + position * count, 0) / voteIds.length;
      const variance = [...counts.entries()].reduce((sum, [position, count]) => sum + ((position - mean) ** 2) * count, 0) / voteIds.length;
      return { ...item, variance };
    })
    .sort((a, b) => b.variance - a.variance)[0];
  const surprise = [...rankedItems]
    .map((item, communityIndex) => ({ ...item, gain: item.position - (communityIndex + 1) }))
    .sort((a, b) => b.gain - a.gain || b.points - a.points)[0];

  const badges = [
    favorite ? `👑 <b>Community-Favorit:</b> ${escapeHtml(favorite.title)}` : "",
    firstPick ? `❤️ <b>Häufigster #1 Pick:</b> ${escapeHtml(firstPick.title)} (${Math.round((firstPick.firstPlaceCount / voteIds.length) * 100)}%)` : "",
    controversial ? `😈 <b>Kontrovers:</b> ${escapeHtml(controversial.title)}` : "",
    surprise && surprise.gain > 0 ? `🔥 <b>Überraschung:</b> ${escapeHtml(surprise.title)} (+${surprise.gain} Plätze gegenüber der Ausgangsreihenfolge)` : ""
  ].filter(Boolean).join("\n");

  const sections = [
    `📊 <b>Statistik: ${escapeHtml(category.name)}</b>\n\n👥 ${voteIds.length} ${voteIds.length === 1 ? "Stimme" : "Stimmen"}\n📝 ${itemCount} Einträge\nPlatz 1 erhält ${itemCount} Punkte, der letzte Platz 1 Punkt.\nMaximal ${maxPoints} Punkte je Eintrag.`,
    `🏆 <b>Punktewertung</b>\n\n${scoreLines.join("\n")}`,
    `📈 <b>Platzverteilung</b>\n\n${distributionBlocks.join("\n\n")}`,
    badges ? `🏅 <b>Community-Badges</b>\n\n${badges}` : ""
  ].filter(Boolean);

  for (const section of sections) {
    let remaining = section;
    while (remaining.length > 3900) {
      let splitAt = remaining.lastIndexOf("\n", 3900);
      if (splitAt < 1000) splitAt = 3900;
      await send(token, chatId, remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n+/, "");
    }
    if (remaining) await send(token, chatId, remaining);
  }
}

export async function POST(request: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WEBHOOK_SECRET;
  const adminId = Number(process.env.ADMIN_TELEGRAM_USER_ID);

  if (!token || !appUrl || !secret || !adminId) {
    return NextResponse.json({ ok: false, error: "Server configuration is incomplete." }, { status: 500 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    if (update.callback_query) {
      await handleCallback(token, update.callback_query, adminId);
      return NextResponse.json({ ok: true });
    }

    const message = update.message;
    if (!message?.chat?.id || !message.from?.id) return NextResponse.json({ ok: true });

    const chatId = String(message.chat.id);
    const userId = message.from.id;
    const isPrivate = message.chat.type === "private";
    const text = (message.text ?? "").trim();
    const isCommand = text.startsWith("/");
    const command = isCommand ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
    const supabase = getSupabaseAdmin();

    if (["/commands", "/help", "/hilfe"].includes(command)) {
      await sendCommands(token, chatId, isPrivate && userId === adminId);
      return NextResponse.json({ ok: true });
    }

    if (command === "/top") {
      await sendTopCategories(token, chatId);
      return NextResponse.json({ ok: true });
    }

    if (command === "/leaderboard") {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/leaderboard</code> direkt in einer Telegram-Gruppe.");
      } else {
        await sendLeaderboard(token, chatId);
      }
      return NextResponse.json({ ok: true });
    }

    if (["/history", "/verlauf"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/history</code> direkt in einer Telegram-Gruppe.");
      } else {
        await sendHistory(token, chatId);
      }
      return NextResponse.json({ ok: true });
    }

    if (["/statistik", "/statistics"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/statistik Kategoriename</code> direkt in der Telegram-Gruppe, deren Stimmen du auswerten möchtest.");
        return NextResponse.json({ ok: true });
      }
      const name = commandArg(text);
      if (!name) {
        await send(token, chatId, "Bitte so senden: <code>/statistik Kategoriename</code>");
        return NextResponse.json({ ok: true });
      }
      await sendStatistics(token, chatId, name);
      return NextResponse.json({ ok: true });
    }

    if (isPrivate && userId === adminId) {
      if (["/admin", "/start"].includes(command) && !text.includes("group_")) {
        await sendCommands(token, chatId, true);
        return NextResponse.json({ ok: true });
      }

      if (command === "/neuekategorie") {
        const name = commandArg(text);
        if (!name) {
          await send(token, chatId, "Bitte so senden: <code>/neuekategorie Meine Kategorie</code>");
          return NextResponse.json({ ok: true });
        }
        const { data: category, error } = await supabase.from("categories").insert({ name, created_by: userId }).select("id,name").single();
        if (error) {
          if (String(error.message).toLowerCase().includes("duplicate")) {
            await send(token, chatId, "Eine Kategorie mit diesem Namen existiert bereits.");
            return NextResponse.json({ ok: true });
          }
          throw error;
        }
        await setSession(userId, { category_id: category.id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
        await send(token, chatId, `✅ Kategorie <b>${escapeHtml(category.name)}</b> erstellt.\n\nSende jetzt das erste Bild. Danach frage ich nach dem Namen – oder du setzt den Namen direkt als Bildunterschrift.`);
        return NextResponse.json({ ok: true });
      }

      if (command === "/kategorien") {
        await categoryMenu(token, chatId);
        return NextResponse.json({ ok: true });
      }

      if (command === "/bearbeiten") {
        const name = commandArg(text);
        if (!name) {
          await categoryMenu(token, chatId);
          return NextResponse.json({ ok: true });
        }
        const category = await findCategoryByName(name);
        if (!category) {
          await send(token, chatId, "Kategorie nicht gefunden. Nutze <code>/kategorien</code>.");
          return NextResponse.json({ ok: true });
        }
        await showCategoryActions(token, chatId, category.id);
        return NextResponse.json({ ok: true });
      }

      if (["/loeschen", "/löschen"].includes(command)) {
        const name = commandArg(text);
        if (!name) {
          await send(token, chatId, "Bitte so senden: <code>/loeschen Kategoriename</code>");
          return NextResponse.json({ ok: true });
        }
        const category = await findCategoryByName(name);
        if (!category) {
          await send(token, chatId, "Kategorie nicht gefunden.");
          return NextResponse.json({ ok: true });
        }
        await send(token, chatId, `Kategorie <b>${escapeHtml(category.name)}</b> wirklich endgültig löschen?`, {
          reply_markup: { inline_keyboard: [[{ text: "Ja, löschen", callback_data: `delcat:${category.id}` }, { text: "Abbrechen", callback_data: "noop:x" }]] }
        });
        return NextResponse.json({ ok: true });
      }

      if (command === "/abbrechen") {
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, "Aktuelle Bearbeitung wurde abgebrochen.");
        return NextResponse.json({ ok: true });
      }

      if (command === "/fertig") {
        const session = await getSession(userId);
        if (!session?.category_id) {
          await send(token, chatId, "Keine Kategorie in Bearbeitung.");
          return NextResponse.json({ ok: true });
        }
        const count = await categoryCount(session.category_id);
        if (count < 2 || count > 30) {
          await send(token, chatId, `Die Kategorie hat aktuell ${count} Bilder. Erlaubt sind 2 bis 30.`);
          return NextResponse.json({ ok: true });
        }
        await supabase.from("app_settings").upsert({ id: 1, active_category_id: session.category_id });
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `✅ Fertig. Die Kategorie mit ${count} Bildern ist jetzt aktiv. Starte sie in der Gruppe mit <code>/blindranking</code>.`);
        return NextResponse.json({ ok: true });
      }

      const session = await getSession(userId);

      if (message.photo?.length) {
        if (!session?.category_id) {
          await send(token, chatId, "Erstelle zuerst eine Kategorie mit <code>/neuekategorie Name</code> oder öffne <code>/kategorien</code>.");
          return NextResponse.json({ ok: true });
        }
        const bestPhoto = message.photo[message.photo.length - 1];

        if (session.mode === "awaiting_replacement_photo" && session.pending_item_id) {
          const uploaded = await uploadTelegramPhoto(token, bestPhoto.file_id, userId);
          const { data: old } = await supabase.from("items").select("storage_path").eq("id", session.pending_item_id).maybeSingle();
          const { error } = await supabase.from("items").update({ image_url: uploaded.imageUrl, storage_path: uploaded.objectPath }).eq("id", session.pending_item_id);
          if (error) throw error;
          if (old?.storage_path) await supabase.storage.from(IMAGE_BUCKET).remove([old.storage_path]);
          await setSession(userId, { mode: "awaiting_photo", pending_item_id: null, pending_file_id: null });
          await send(token, chatId, "✅ Bild wurde ersetzt.");
          return NextResponse.json({ ok: true });
        }

        const count = await categoryCount(session.category_id);
        if (count >= 30) {
          await send(token, chatId, "Maximal 30 Bilder pro Kategorie.");
          return NextResponse.json({ ok: true });
        }

        if (message.caption?.trim()) {
          const uploaded = await uploadTelegramPhoto(token, bestPhoto.file_id, userId);
          const { error } = await supabase.from("items").insert({
            category_id: session.category_id,
            title: message.caption.trim(),
            image_url: uploaded.imageUrl,
            storage_path: uploaded.objectPath,
            position: count + 1
          });
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
          await send(token, chatId, `✅ <b>${escapeHtml(message.caption.trim())}</b> hinzugefügt (${count + 1}/30). Sende das nächste Bild oder /fertig.`);
        } else {
          await setSession(userId, { mode: "awaiting_title", pending_file_id: bestPhoto.file_id, pending_item_id: null });
          await send(token, chatId, "Wie heißt dieses Bild? Sende jetzt nur den Namen.");
        }
        return NextResponse.json({ ok: true });
      }

      if (text && !isCommand && session) {
        if (session.mode === "awaiting_new_category_name") {
          const { data: category, error } = await supabase.from("categories").insert({ name: text, created_by: userId }).select("id,name").single();
          if (error) {
            if (String(error.message).toLowerCase().includes("duplicate")) {
              await send(token, chatId, "Eine Kategorie mit diesem Namen existiert bereits.");
              return NextResponse.json({ ok: true });
            }
            throw error;
          }
          await setSession(userId, { category_id: category.id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
          await send(token, chatId, `✅ Kategorie <b>${escapeHtml(category.name)}</b> erstellt. Sende jetzt das erste Bild.`);
          return NextResponse.json({ ok: true });
        }
        if (session.mode === "awaiting_title" && session.pending_file_id && session.category_id) {
          const count = await categoryCount(session.category_id);
          if (count >= 30) {
            await send(token, chatId, "Maximal 30 Bilder pro Kategorie.");
            return NextResponse.json({ ok: true });
          }
          const uploaded = await uploadTelegramPhoto(token, session.pending_file_id, userId);
          const { error } = await supabase.from("items").insert({
            category_id: session.category_id,
            title: text,
            image_url: uploaded.imageUrl,
            storage_path: uploaded.objectPath,
            position: count + 1
          });
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
          await send(token, chatId, `✅ <b>${escapeHtml(text)}</b> hinzugefügt (${count + 1}/30). Sende das nächste Bild oder /fertig.`);
          return NextResponse.json({ ok: true });
        }
        if (session.mode === "awaiting_category_name" && session.category_id) {
          const { error } = await supabase.from("categories").update({ name: text }).eq("id", session.category_id);
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_item_id: null, pending_file_id: null });
          await send(token, chatId, `✅ Kategorie heißt jetzt <b>${escapeHtml(text)}</b>.`);
          return NextResponse.json({ ok: true });
        }
        if (session.mode === "awaiting_item_name" && session.pending_item_id) {
          const { error } = await supabase.from("items").update({ title: text }).eq("id", session.pending_item_id);
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_item_id: null, pending_file_id: null });
          await send(token, chatId, `✅ Eintrag heißt jetzt <b>${escapeHtml(text)}</b>.`);
          return NextResponse.json({ ok: true });
        }
      }
    }

    if (command !== "/blindranking" && command !== "/start") return NextResponse.json({ ok: true });

    if (!isPrivate) {
      const requestedName = command === "/blindranking" ? commandArg(text) : "";
      let categoryId: string | null = null;
      let categoryName = "aktive Kategorie";
      if (requestedName) {
        const category = await findCategoryByName(requestedName);
        if (!category) {
          await send(token, chatId, "Kategorie nicht gefunden. Nutze /blindranking ohne Zusatz für die aktive Kategorie.");
          return NextResponse.json({ ok: true });
        }
        categoryId = category.id;
        categoryName = category.name;
      } else {
        const { data: setting } = await supabase.from("app_settings").select("active_category_id").eq("id", 1).maybeSingle();
        categoryId = setting?.active_category_id ?? null;
        if (categoryId) {
          const { data: category } = await supabase.from("categories").select("name").eq("id", categoryId).maybeSingle();
          if (category?.name) categoryName = category.name;
        }
      }
      if (!categoryId) {
        await send(token, chatId, "Noch keine aktive Kategorie vorhanden. Der Admin muss zuerst eine Kategorie fertigstellen.");
        return NextResponse.json({ ok: true });
      }
      const bot = await telegramApi(token, "getMe", {});
      const deepLink = `https://t.me/${bot.username}?start=group_${chatId}_${categoryId}`;
      await send(token, chatId, `🎲 <b>Blind Ranking</b>\nKategorie: <b>${escapeHtml(categoryName)}</b>\n\nTippe auf den Button.`, {
        reply_markup: { inline_keyboard: [[{ text: "🎮 Spiel starten", url: deepLink }]] }
      });
      return NextResponse.json({ ok: true });
    }

    const startPayload = command === "/start" ? text.split(/\s+/)[1] ?? "" : "";
    const match = startPayload.match(/^group_(-?\d+)_([0-9a-f-]{36})$/i);
    let targetChatId = chatId;
    let categoryId: string | null = null;
    if (match) {
      targetChatId = match[1];
      categoryId = match[2];
    } else {
      const { data: setting } = await supabase.from("app_settings").select("active_category_id").eq("id", 1).maybeSingle();
      categoryId = setting?.active_category_id ?? null;
    }
    if (!categoryId) {
      await send(token, chatId, "Noch keine aktive Kategorie vorhanden.");
      return NextResponse.json({ ok: true });
    }
    const miniAppUrl = `${appUrl.replace(/\/$/, "")}/?chat_id=${encodeURIComponent(targetChatId)}&category_id=${encodeURIComponent(categoryId)}`;
    await send(token, chatId, "🎲 <b>Blind Ranking</b>\n\nÖffne jetzt das Spiel:", {
      reply_markup: { inline_keyboard: [[{ text: "🎮 Spiel öffnen", web_app: { url: miniAppUrl } }]] }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
