import crypto from "crypto";
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
  message_thread_id?: number;
  is_topic_message?: boolean;
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

type BotRole = "owner" | "creator" | "player";
type BotUserRow = { user_id: number; role: BotRole; active: boolean; username?: string | null; display_name?: string | null; category_limit?: number | null; categories_used?: number | null };

function tokenHash(value: string) {
  return crypto.createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}

function newInviteToken() {
  const raw = crypto.randomBytes(9).toString("base64url").toUpperCase();
  return `BR-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

async function getRole(userId: number, ownerId: number): Promise<BotRole> {
  if (userId === ownerId) return "owner";
  const { data, error } = await getSupabaseAdmin().from("bot_users").select("role,active").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (data?.active && data.role === "owner") return "owner";
  if (data?.active && data.role === "creator") return "creator";
  return "player";
}

async function saveCreator(user: TelegramUser, approvedBy: number, categoryLimit: number | null) {
  const displayName = user.first_name || user.username || String(user.id);
  const { error } = await getSupabaseAdmin().from("bot_users").upsert({
    user_id: user.id,
    role: "creator",
    active: true,
    username: user.username ?? null,
    display_name: displayName,
    approved_by: approvedBy,
    category_limit: categoryLimit,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
  if (error) throw error;
}

async function getCreatorQuota(userId: number) {
  const { data, error } = await getSupabaseAdmin().from("bot_users")
    .select("category_limit,categories_used,active,role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.active || data.role !== "creator") return null;
  return { limit: data.category_limit as number | null, used: Number(data.categories_used ?? 0) };
}

async function assertCreatorCanCreate(userId: number, role: BotRole) {
  if (role === "owner") return;
  if (role !== "creator") throw new Error("Nur Owner oder Creator dürfen Kategorien erstellen.");
  const quota = await getCreatorQuota(userId);
  if (!quota) throw new Error("Dein Creator-Zugang ist nicht aktiv.");
  if (quota.limit !== null && quota.used >= quota.limit) {
    throw new Error(`Dein Kategorienkontingent ist aufgebraucht (${quota.used}/${quota.limit}).`);
  }
}

async function incrementCreatorUsage(userId: number, role: BotRole) {
  if (role !== "creator") return;
  const quota = await getCreatorQuota(userId);
  if (!quota) throw new Error("Creator-Konto nicht gefunden.");
  const { error } = await getSupabaseAdmin().from("bot_users")
    .update({ categories_used: quota.used + 1, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw error;
}

async function canManageCategory(userId: number, role: BotRole, categoryId: string) {
  if (role === "owner") return true;
  if (role !== "creator") return false;
  const { data, error } = await getSupabaseAdmin().from("categories").select("created_by").eq("id", categoryId).maybeSingle();
  if (error) throw error;
  return Number(data?.created_by) === userId;
}

async function canManageItem(userId: number, role: BotRole, itemId: string) {
  if (role === "owner") return true;
  if (role !== "creator") return false;
  const { data, error } = await getSupabaseAdmin().from("items").select("category_id,categories!inner(created_by)").eq("id", itemId).maybeSingle();
  if (error) throw error;
  const categories = data?.categories as unknown as { created_by?: number } | null;
  return Number(categories?.created_by) === userId;
}

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

async function lookupTelegramUser(token: string, userId: number): Promise<TelegramUser> {
  try {
    const chat = await telegramApi(token, "getChat", { chat_id: userId });
    return { id: userId, username: chat.username, first_name: chat.first_name || chat.title };
  } catch {
    return { id: userId };
  }
}

function backButton(callbackData: string, text = "⬅️ Zurück") {
  return [{ text, callback_data: callbackData }];
}

type GroupTopicSettings = { poll_thread_id: number | null; results_thread_id: number | null };

async function getGroupTopicSettings(chatId: string | number): Promise<GroupTopicSettings> {
  const { data, error } = await getSupabaseAdmin()
    .from("group_topic_settings")
    .select("poll_thread_id,results_thread_id")
    .eq("chat_id", String(chatId))
    .maybeSingle();
  if (error) throw error;
  return {
    poll_thread_id: data?.poll_thread_id ?? null,
    results_thread_id: data?.results_thread_id ?? null
  };
}

async function setGroupTopicSetting(chatId: string | number, field: "poll_thread_id" | "results_thread_id", threadId: number | null) {
  const supabase = getSupabaseAdmin();
  const current = await getGroupTopicSettings(chatId);
  const payload = {
    chat_id: String(chatId),
    poll_thread_id: field === "poll_thread_id" ? threadId : current.poll_thread_id,
    results_thread_id: field === "results_thread_id" ? threadId : current.results_thread_id,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("group_topic_settings").upsert(payload, { onConflict: "chat_id" });
  if (error) throw error;
}

function topicExtra(threadId: number | null | undefined): Record<string, unknown> {
  return threadId ? { message_thread_id: threadId } : {};
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


async function sendCommands(token: string, chatId: string | number, role: BotRole | null) {
  const isManager = role === "owner" || role === "creator";
  const adminSection = isManager
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

  const keyboard = isManager
    ? [
        [{ text: "🎮 Spiel starten", callback_data: "menuplay:x" }],
        [{ text: "➕ Neue Kategorie", callback_data: "menunew:x" }, { text: "📂 Kategorien", callback_data: "menucats:x" }],
        [{ text: "🎟 Creator-Token einlösen", callback_data: "tokenredeem:x" }],
        ...(role === "owner" ? [[{ text: "🔐 Rollen & Tokens", callback_data: "rolemenu:x" }]] : [])
      ]
    : [
        [{ text: "🎮 Spiel starten", callback_data: "menuplay:x" }],
        [{ text: "🎟 Creator-Token einlösen", callback_data: "tokenredeem:x" }]
      ];

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
      "<code>/themen</code> – Zielthemen für Umfrage und Ergebnisse anzeigen\n" +
      "<code>/setumfragethema</code> – aktuelles Thema für Umfrage-Links festlegen\n" +
      "<code>/setergebnisthema</code> – aktuelles Thema für Ergebnisse festlegen\n" +
      "<code>/themenreset</code> – beide Zielthemen zurücksetzen\n" +
      "<code>/id</code> – deine persönliche Telegram-ID anzeigen\n" +
      "<code>/aktivieren TOKEN</code> – einmaligen Creator-Token einlösen\n" +
      (role === "owner" ? "<code>/rollen</code> – Rollen- und Tokenverwaltung öffnen\n" : "") +
      "<code>/commands</code> – diese Übersicht anzeigen" +
      adminSection,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function categoryMenu(token: string, chatId: string | number, userId: number, role: BotRole) {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("categories").select("id,name,items(count)").order("created_at", { ascending: false });
  if (role === "creator") query = query.eq("created_by", userId);
  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) {
    await send(token, chatId, "Noch keine Kategorien vorhanden. Erstelle eine mit <code>/neuekategorie Name</code>.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    return;
  }
  const buttons = data.map((category: any) => [{
    text: `${category.name} (${category.items?.[0]?.count ?? 0})`,
    callback_data: `cat:${category.id}`
  }]);
  await send(token, chatId, "<b>Kategorien verwalten</b>\n\nTippe eine Kategorie an:", {
    reply_markup: { inline_keyboard: [...buttons, backButton("menuhelp:x")] }
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
        [{ text: "🗑 Kategorie löschen", callback_data: `delcatask:${categoryId}` }],
        backButton("menucats:x")
      ]
    }
  });
}

async function showItems(token: string, chatId: string | number, categoryId: string) {
  const supabase = getSupabaseAdmin();
  const { data: category } = await supabase.from("categories").select("name").eq("id", categoryId).maybeSingle();
  const { data, error } = await supabase.from("items").select("id,title,position,image_url").eq("category_id", categoryId).order("position", { ascending: true });
  if (error) throw error;
  if (!data?.length) {
    await send(token, chatId, "Diese Kategorie enthält noch keine Bilder.");
    return;
  }

  // Telegram erlaubt maximal 10 Medien pro Album. Die Bilder werden deshalb in Blöcken gesendet.
  for (let offset = 0; offset < data.length; offset += 10) {
    const chunk = data.slice(offset, offset + 10);
    if (chunk.length === 1) {
      await telegramApi(token, "sendPhoto", {
        chat_id: chatId,
        photo: chunk[0].image_url,
        caption: `${chunk[0].position}. ${chunk[0].title}`
      });
    } else {
      await telegramApi(token, "sendMediaGroup", {
        chat_id: chatId,
        media: chunk.map((item) => ({
          type: "photo",
          media: item.image_url,
          caption: `${item.position}. ${item.title}`
        }))
      });
    }
  }

  const buttons = data.map((item) => [{ text: `${item.position}. ${item.title}`, callback_data: `item:${item.id}` }]);
  await send(token, chatId, `<b>Bilder: ${escapeHtml(category?.name ?? "Kategorie")}</b>\n\nOben siehst du alle hinterlegten Bilder. Tippe unten einen Eintrag zum Bearbeiten an:`, {
    reply_markup: { inline_keyboard: [...buttons, backButton(`cat:${categoryId}`)] }
  });
}

async function showRoleMenu(token: string, chatId: string | number) {
  await send(token, chatId, `<b>🔐 Creator- & Tokenverwaltung</b>

Player sind automatisch alle Nutzer. Nur Owner können dieses Menü verwenden.`, {
    reply_markup: { inline_keyboard: [
      [{ text: "🎟 Creator-Token erstellen", callback_data: "tokenmenu:x" }],
      [{ text: "👑 Owner per ID hinzufügen", callback_data: "owneraddmenu:x" }],
      [{ text: "➕ Creator per ID genehmigen", callback_data: "approvemenu:x" }],
      [{ text: "👥 Owner & Creator verwalten", callback_data: "roleusers:x" }],
      [{ text: "🧾 Offene Tokens", callback_data: "roletokens:x" }],
      [{ text: "📊 Kontingent ändern", callback_data: "quotaedit:x" }],
      backButton("menuhelp:x")
    ] }
  });
}

function quotaLabel(limit: number | null, used = 0) {
  return limit === null ? `unbegrenzt · ${used} erstellt` : `${used}/${limit} verwendet`;
}

function quotaButtons(prefix: string, backTo?: string) {
  const rows = [
    [{ text: "1 Kategorie", callback_data: `${prefix}:1` }, { text: "3 Kategorien", callback_data: `${prefix}:3` }],
    [{ text: "5 Kategorien", callback_data: `${prefix}:5` }, { text: "10 Kategorien", callback_data: `${prefix}:10` }],
    [{ text: "♾ Unbegrenzt", callback_data: `${prefix}:u` }]
  ];
  if (backTo) rows.push(backButton(backTo));
  return rows;
}

function tokenDurationButtons(quotaCode: string) {
  return [
    [{ text: "1 Stunde", callback_data: `tokentime:${quotaCode}_1h` }, { text: "24 Stunden", callback_data: `tokentime:${quotaCode}_24h` }],
    [{ text: "7 Tage", callback_data: `tokentime:${quotaCode}_7d` }, { text: "30 Tage", callback_data: `tokentime:${quotaCode}_30d` }],
    [{ text: "♾ Ohne Ablauf", callback_data: `tokentime:${quotaCode}_never` }],
    backButton("tokenmenu:x")
  ];
}

function tokenExpiry(durationCode: string): string | null {
  const now = Date.now();
  const milliseconds: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  return durationCode === "never" ? null : new Date(now + (milliseconds[durationCode] ?? 0)).toISOString();
}

async function listRoleUsers(token: string, chatId: string | number, ownerId: number) {
  const { data, error } = await getSupabaseAdmin().from("bot_users").select("user_id,role,username,display_name,active,category_limit,categories_used").in("role", ["owner", "creator"]).eq("active", true).order("created_at");
  if (error) throw error;
  const rows = [`👑 <b>Haupt-Owner</b> — <code>${ownerId}</code>`];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const user of data ?? []) {
    if (Number(user.user_id) === ownerId) continue;
    const label = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.display_name || String(user.user_id));
    if (user.role === "owner") {
      rows.push(`✅ 👑 <b>Owner</b> — ${label} · <code>${user.user_id}</code>`);
      buttons.push([{ text: `👑 ${user.username ? `@${user.username}` : user.display_name || user.user_id}`, callback_data: `roleuser:${user.user_id}` }]);
    } else {
      rows.push(`✅ <b>Creator</b> — ${label} · <code>${user.user_id}</code> · ${quotaLabel(user.category_limit, Number(user.categories_used ?? 0))}`);
      buttons.push([{ text: `🛠 ${user.username ? `@${user.username}` : user.display_name || user.user_id}`, callback_data: `roleuser:${user.user_id}` }]);
    }
  }
  buttons.push(backButton("rolemenu:x"));
  await send(token, chatId, `<b>👥 Owner & Creator</b>\n\n${rows.join("\n")}\n\nTippe eine Person an, um sie zu verwalten.`, { reply_markup: { inline_keyboard: buttons } });
}

async function showRoleUser(token: string, chatId: string | number, targetId: number, ownerId: number) {
  if (targetId === ownerId) return send(token, chatId, "Der Haupt-Owner kann nicht entfernt werden.", { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  const { data, error } = await getSupabaseAdmin().from("bot_users").select("user_id,role,username,display_name,active,category_limit,categories_used").eq("user_id", targetId).maybeSingle();
  if (error) throw error;
  if (!data?.active || !["owner", "creator"].includes(data.role)) return send(token, chatId, "Nutzer nicht gefunden.", { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  const label = data.username ? `@${escapeHtml(data.username)}` : escapeHtml(data.display_name || String(data.user_id));
  const quota = data.role === "creator" ? `
Kontingent: <b>${quotaLabel(data.category_limit, Number(data.categories_used ?? 0))}</b>` : "";
  await send(token, chatId, `<b>${data.role === "owner" ? "👑 Owner" : "🛠 Creator"}</b>

Name: ${label}
Telegram-ID: <code>${data.user_id}</code>${quota}`, {
    reply_markup: { inline_keyboard: [
      [{ text: "🗑 Berechtigung entfernen", callback_data: `removeauth:${data.user_id}` }],
      backButton("roleusers:x")
    ] }
  });
}

async function listOpenTokens(token: string, chatId: string | number) {
  const { data, error } = await getSupabaseAdmin().from("invite_tokens").select("token_hint,role,expires_at,created_at,category_limit").is("used_at", null).is("revoked_at", null).order("created_at", { ascending: false }).limit(30);
  if (error) throw error;
  if (!data?.length) return send(token, chatId, "Keine offenen Tokens vorhanden.", { reply_markup: { inline_keyboard: [backButton("rolemenu:x")] } });
  const rows = data.map((entry) => `• <code>${escapeHtml(entry.token_hint)}</code> — Creator · ${entry.category_limit === null ? "unbegrenzt" : `${entry.category_limit} Kategorien`}${entry.expires_at ? ` · gültig bis ${new Date(entry.expires_at).toLocaleDateString("de-DE")}` : ""}`);
  await send(token, chatId, `<b>🧾 Offene Tokens</b>\n\n${rows.join("\n")}\n\nAus Sicherheitsgründen wird nur ein Hinweis, nicht der vollständige Token, gespeichert.`, { reply_markup: { inline_keyboard: [backButton("rolemenu:x")] } });
}

async function handleCallback(token: string, callback: CallbackQuery, ownerId: number) {
  if (!callback.message?.chat?.id || !callback.data) { await answerCallback(token, callback.id, "Ungültige Aktion"); return; }
  const role = await getRole(callback.from.id, ownerId);
  const chatId = String(callback.message.chat.id);
  const [action, id] = callback.data.split(":", 2);
  const supabase = getSupabaseAdmin();
  await answerCallback(token, callback.id);

  if (action === "menuhelp") return sendCommands(token, chatId, role);
  if (action === "noop") return;
  if (action === "tokenredeem") {
    if (role !== "player") return send(token, chatId, "Du bist bereits Owner oder Creator.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_token_redeem", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, `<b>🎟 Creator-Token einlösen</b>

Sende jetzt deinen vollständigen Token, zum Beispiel <code>BR-XXXX-XXXX-XXXX</code>.`, { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
  }
  if (action === "menucats") { if (role === "player") return send(token, chatId, "Nicht erlaubt."); return categoryMenu(token, chatId, callback.from.id, role); }
  if (action === "rolemenu") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return showRoleMenu(token, chatId); }
  if (action === "roleusers") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return listRoleUsers(token, chatId, ownerId); }
  if (action === "roleuser") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return showRoleUser(token, chatId, Number(id), ownerId); }
  if (action === "removeauth") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const targetId = Number(id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === ownerId) return send(token, chatId, "Diese Berechtigung kann nicht entfernt werden.");
    return send(token, chatId, `<b>Berechtigung wirklich entfernen?</b>

Telegram-ID: <code>${targetId}</code>
Der Nutzer wird danach wieder Player.`, { reply_markup: { inline_keyboard: [[{ text: "✅ Entfernen", callback_data: `removeauthconfirm:${targetId}` }], backButton(`roleuser:${targetId}`)] } });
  }
  if (action === "removeauthconfirm") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const targetId = Number(id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === ownerId) return send(token, chatId, "Diese Berechtigung kann nicht entfernt werden.");
    const { error } = await supabase.from("bot_users").update({ active: false, updated_at: new Date().toISOString() }).eq("user_id", targetId);
    if (error) throw error;
    await send(token, chatId, `✅ Die Owner-/Creator-Berechtigung von <code>${targetId}</code> wurde entfernt.`, { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
    return;
  }
  if (action === "roletokens") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return listOpenTokens(token, chatId); }
  if (action === "tokenmenu") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    return send(token, chatId, "<b>🎟 Creator-Token erstellen</b>\n\n1) Wähle zuerst das Kategorienkontingent.\n2) Danach wählst du die Gültigkeitsdauer.\n3) Der Bot generiert den Token automatisch.", { reply_markup: { inline_keyboard: quotaButtons("tokengen", "rolemenu:x") } });
  }
  if (action === "tokengen") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const categoryLimit = id === "u" ? null : Number(id);
    if (id !== "u" && ![1, 3, 5, 10].includes(categoryLimit as number)) return send(token, chatId, "Ungültiges Kontingent.");
    return send(token, chatId, `<b>⏱ Gültigkeitsdauer wählen</b>\n\nKontingent: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>\n\nWie lange darf der Token eingelöst werden?`, {
      reply_markup: { inline_keyboard: tokenDurationButtons(id) }
    });
  }
  if (action === "tokentime") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const [quotaCode, durationCode] = id.split("_", 2);
    const categoryLimit = quotaCode === "u" ? null : Number(quotaCode);
    if (quotaCode !== "u" && ![1, 3, 5, 10].includes(categoryLimit as number)) return send(token, chatId, "Ungültiges Kontingent.");
    if (!["1h", "24h", "7d", "30d", "never"].includes(durationCode)) return send(token, chatId, "Ungültige Gültigkeitsdauer.");
    const expiresAt = tokenExpiry(durationCode);
    const raw = newInviteToken();
    const { error } = await supabase.from("invite_tokens").insert({
      token_hash: tokenHash(raw),
      token_hint: `${raw.slice(0, 7)}…${raw.slice(-4)}`,
      role: "creator",
      category_limit: categoryLimit,
      created_by: callback.from.id,
      expires_at: expiresAt
    });
    if (error) throw error;
    const validity = expiresAt ? `gültig bis ${new Date(expiresAt).toLocaleString("de-DE")}` : "ohne Ablaufdatum";
    return send(token, chatId, `<b>🎟 Einmaliger Creator-Token</b>\n\n<code>${raw}</code>\n\nKontingent: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>\nGültigkeit: <b>${validity}</b>\nEinmal verwendbar.\n\nAktivierung: <code>/aktivieren ${raw}</code>`);
  }
  if (action === "owneraddmenu") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_authorize_owner_id", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "<b>👑 Owner per ID hinzufügen</b>\n\nSende jetzt die numerische Telegram-ID des neuen Owners.");
  }
  if (action === "approveowner") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const targetId = Number(id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return send(token, chatId, "Ungültige Telegram-ID.");
    const targetUser = await lookupTelegramUser(token, targetId);
    const { error } = await supabase.from("bot_users").upsert({
      user_id: targetId,
      role: "owner",
      username: targetUser.username ?? null,
      display_name: targetUser.first_name ?? targetUser.username ?? String(targetId),
      active: true,
      approved_by: callback.from.id,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (error) throw error;
    return send(token, chatId, `✅ <code>${targetId}</code> wurde als <b>Owner</b> hinzugefügt.`, { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  }
  if (action === "approvemenu") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_authorize_creator_id", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "<b>➕ Creator per ID genehmigen</b>\n\nSende jetzt zuerst die numerische Telegram-ID des Nutzers.");
  }
  if (action === "approveuser") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const [target, quotaCode] = id.split("_", 2);
    const targetId = Number(target);
    const categoryLimit = quotaCode === "u" ? null : Number(quotaCode);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || (quotaCode !== "u" && ![1, 3, 5, 10].includes(categoryLimit as number))) {
      return send(token, chatId, "Ungültige Freigabeauswahl.");
    }
    const targetUser = await lookupTelegramUser(token, targetId);
    await saveCreator(targetUser, callback.from.id, categoryLimit);
    return send(token, chatId, `✅ <code>${targetId}</code> wurde als <b>Creator</b> genehmigt. Kontingent: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>.`, { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  }
  if (action === "quotaedit") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_quota_user", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "Sende die numerische Telegram-ID des Creators, dessen Kontingent du ändern möchtest.", { reply_markup: { inline_keyboard: [backButton("rolemenu:x")] } });
  }
  if (action === "setquota") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const [target, quotaCode] = id.split("_", 2);
    const targetId = Number(target);
    const categoryLimit = quotaCode === "u" ? null : Number(quotaCode);
    if (!Number.isSafeInteger(targetId) || (quotaCode !== "u" && categoryLimit === null || ![1, 3, 5, 10].includes(categoryLimit as number))) return send(token, chatId, "Ungültige Auswahl.");
    const { error } = await supabase.from("bot_users").update({ category_limit: categoryLimit, updated_at: new Date().toISOString() }).eq("user_id", targetId).eq("role", "creator");
    if (error) throw error;
    return send(token, chatId, `✅ Kontingent für <code>${targetId}</code>: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>.`);
  }
  if (action === "rolerevoke") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_revoke_user", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "Sende jetzt die numerische Telegram-ID des zu sperrenden Creators.");
  }
  if (action === "menunew") {
    try { await assertCreatorCanCreate(callback.from.id, role); } catch (error) { return send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); }
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_new_category_name", pending_file_id: null, pending_item_id: null });
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
  if (action === "cat") { if (!(await canManageCategory(callback.from.id, role, id))) return send(token, chatId, "Du darfst diese Kategorie nicht verwalten."); return showCategoryActions(token, chatId, id); }
  if (["activate","add","items","toggleimages","renamecat","delcatask","delcat"].includes(action) && !(await canManageCategory(callback.from.id, role, id))) return send(token, chatId, "Du darfst diese Kategorie nicht verwalten.");
  if (action === "activate") {
    await supabase.from("app_settings").upsert({ id: 1, active_category_id: id });
    await send(token, chatId, "✅ Kategorie wurde aktiviert.");
    return;
  }
  if (action === "add") {
    await setSession(callback.from.id, { category_id: id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
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
    await setSession(callback.from.id, { category_id: id, mode: "awaiting_category_name", pending_file_id: null, pending_item_id: null });
    await send(token, chatId, "Sende jetzt den neuen Namen der Kategorie.");
    return;
  }
  if (action === "delcatask") {
    await send(token, chatId, "Kategorie wirklich endgültig löschen?", {
      reply_markup: { inline_keyboard: [[{ text: "Ja, löschen", callback_data: `delcat:${id}` }], backButton(`cat:${id}`, "Abbrechen")] }
    });
    return;
  }
  if (action === "delcat") {
    await supabase.from("categories").delete().eq("id", id);
    await send(token, chatId, "🗑 Kategorie gelöscht.");
    return;
  }
  if (["item","renameitem","replace","delitemask","delitem"].includes(action) && !(await canManageItem(callback.from.id, role, id))) return send(token, chatId, "Du darfst diesen Eintrag nicht verwalten.");
  if (action === "item") {
    const { data: item } = await supabase.from("items").select("id,title,category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await send(token, chatId, `<b>${escapeHtml(item.title)}</b>`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✏️ Namen ändern", callback_data: `renameitem:${item.id}` }, { text: "📷 Bild ersetzen", callback_data: `replace:${item.id}` }],
          [{ text: "🗑 Eintrag löschen", callback_data: `delitemask:${item.id}` }],
          backButton(`items:${item.category_id}`)
        ]
      }
    });
    return;
  }
  if (action === "renameitem") {
    const { data: item } = await supabase.from("items").select("category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await setSession(callback.from.id, { category_id: item.category_id, mode: "awaiting_item_name", pending_item_id: id, pending_file_id: null });
    await send(token, chatId, "Sende jetzt den neuen Namen.");
    return;
  }
  if (action === "replace") {
    const { data: item } = await supabase.from("items").select("category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await setSession(callback.from.id, { category_id: item.category_id, mode: "awaiting_replacement_photo", pending_item_id: id, pending_file_id: null });
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

async function redeemCreatorToken(token: string, chatId: string | number, user: TelegramUser, rawInput: string, ownerId: number) {
  const raw = rawInput.trim().toUpperCase();
  if (!raw) { await send(token, chatId, "Bitte sende einen vollständigen Token, zum Beispiel <code>BR-XXXX-XXXX-XXXX</code>."); return false; }
  const supabase = getSupabaseAdmin();
  const { data: invite, error } = await supabase.from("invite_tokens").select("id,role,category_limit,expires_at,used_at,revoked_at").eq("token_hash", tokenHash(raw)).maybeSingle();
  if (error) throw error;
  if (!invite || invite.used_at || invite.revoked_at || (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now())) {
    await send(token, chatId, "Dieser Token ist ungültig, abgelaufen oder bereits verwendet.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    return false;
  }
  if (invite.role !== "creator") { await send(token, chatId, "Dieser Token-Typ wird nicht unterstützt."); return false; }
  await saveCreator(user, ownerId, invite.category_limit as number | null);
  const { error: useError } = await supabase.from("invite_tokens").update({ used_by: user.id, used_at: new Date().toISOString() }).eq("id", invite.id).is("used_at", null);
  if (useError) throw useError;
  await send(token, chatId, `✅ Als <b>Creator</b> freigeschaltet. Kontingent: <b>${invite.category_limit === null ? "unbegrenzt" : `${invite.category_limit} Kategorien`}</b>. Nutze <code>/meinkonto</code>.`, { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
  return true;
}

export async function POST(request: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WEBHOOK_SECRET;
  const ownerId = Number(process.env.ADMIN_TELEGRAM_USER_ID);

  if (!token || !appUrl || !secret || !ownerId) {
    return NextResponse.json({ ok: false, error: "Server configuration is incomplete." }, { status: 500 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    if (update.callback_query) {
      await handleCallback(token, update.callback_query, ownerId);
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
    const role = await getRole(userId, ownerId);

    if (["/token", "/tokenmenu"].includes(command)) {
      if (!isPrivate) { await send(token, chatId, "Öffne das Token-Menü bitte im privaten Chat mit dem Bot."); return NextResponse.json({ ok: true }); }
      if (role !== "player") { await send(token, chatId, "Du bist bereits Owner oder Creator."); return NextResponse.json({ ok: true }); }
      await setSession(userId, { category_id: null, mode: "awaiting_token_redeem", pending_file_id: null, pending_item_id: null });
      await send(token, chatId, `<b>🎟 Creator-Token einlösen</b>

Sende jetzt deinen vollständigen Token, zum Beispiel <code>BR-XXXX-XXXX-XXXX</code>.`, { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
      return NextResponse.json({ ok: true });
    }

    if (command === "/aktivieren") {
      if (role !== "player") { await send(token, chatId, "Du bist bereits Owner oder Creator. Dein Kontingent kann nur ein Owner ändern."); return NextResponse.json({ ok: true }); }
      if (!isPrivate) { await send(token, chatId, "Aktiviere Tokens nur im privaten Chat mit dem Bot."); return NextResponse.json({ ok: true }); }
      await redeemCreatorToken(token, chatId, message.from, commandArg(text), ownerId);
      return NextResponse.json({ ok: true });
    }

    if (["/commands", "/help", "/hilfe"].includes(command)) {
      await sendCommands(token, chatId, role);
      return NextResponse.json({ ok: true });
    }

    if (["/id", "/meineid", "/myid"].includes(command)) {
      if (role === "owner" || role === "creator") {
        await supabase.from("bot_users").update({ username: message.from.username ?? null, display_name: message.from.first_name ?? message.from.username ?? String(userId), updated_at: new Date().toISOString() }).eq("user_id", userId);
      }
      const username = message.from.username ? `@${escapeHtml(message.from.username)}` : "kein öffentlicher Benutzername";
      await send(
        token,
        chatId,
        `<b>🆔 Deine Telegram-ID</b>\n\n<code>${userId}</code>\n\nBenutzername: ${escapeHtml(username)}\nRolle: <b>${role === "owner" ? "Owner" : role === "creator" ? "Creator" : "Player"}</b>\n\nDu kannst diese ID einem Owner schicken, damit er dich direkt als Creator freigibt.`,
        isPrivate ? undefined : topicExtra(message.message_thread_id)
      );
      return NextResponse.json({ ok: true });
    }

    if (["/rollen", "/roles"].includes(command)) {
      if (!isPrivate || role !== "owner") await send(token, chatId, "Dieses Menü ist nur für Owner im privaten Bot-Chat verfügbar.");
      else await showRoleMenu(token, chatId);
      return NextResponse.json({ ok: true });
    }

    if (["/meinkonto", "/myaccount"].includes(command)) {
      if (role !== "creator") {
        await send(token, chatId, role === "owner" ? "Owner haben ein unbegrenztes Kontingent." : "Du bist Player. Zum Erstellen eigener Kategorien brauchst du eine Creator-Freigabe.");
      } else {
        const quota = await getCreatorQuota(userId);
        await send(token, chatId, quota ? `<b>🛠 Creator-Konto</b>

Erstellt: ${quota.used}
Kontingent: ${quota.limit === null ? "unbegrenzt" : quota.limit}
Verfügbar: ${quota.limit === null ? "unbegrenzt" : Math.max(0, quota.limit - quota.used)}` : "Creator-Konto nicht gefunden.");
      }
      return NextResponse.json({ ok: true });
    }

    if (["/themen", "/topics"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/themen</code> direkt in deiner Telegram-Gruppe.");
      } else {
        const settings = await getGroupTopicSettings(chatId);
        const poll = settings.poll_thread_id ? `Themen-ID <code>${settings.poll_thread_id}</code>` : "Allgemeines Thema";
        const results = settings.results_thread_id ? `Themen-ID <code>${settings.results_thread_id}</code>` : "Allgemeines Thema";
        await send(token, chatId, `<b>📌 Zielthemen dieser Gruppe</b>\n\n🎮 Umfrage-Link: ${poll}\n🏆 Ergebnisse: ${results}\n\nSende <code>/setumfragethema</code> im gewünschten Umfrage-Thema und <code>/setergebnisthema</code> im gewünschten Ergebnis-Thema.`, topicExtra(message.message_thread_id));
      }
      return NextResponse.json({ ok: true });
    }

    if (["/setumfragethema", "/setpolltopic"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Diesen Befehl musst du im gewünschten Thema deiner Gruppe senden.");
      } else if (role !== "owner") {
        await send(token, chatId, "Nur der konfigurierte Bot-Admin darf Zielthemen ändern.", topicExtra(message.message_thread_id));
      } else {
        const threadId = message.message_thread_id ?? null;
        await setGroupTopicSetting(chatId, "poll_thread_id", threadId);
        await send(token, chatId, threadId ? "✅ Dieses Thema ist jetzt das Ziel für Umfrage-Links." : "✅ Umfrage-Links werden jetzt im allgemeinen Thema gesendet.", topicExtra(threadId));
      }
      return NextResponse.json({ ok: true });
    }

    if (["/setergebnisthema", "/setresulttopic"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Diesen Befehl musst du im gewünschten Thema deiner Gruppe senden.");
      } else if (role !== "owner") {
        await send(token, chatId, "Nur der konfigurierte Bot-Admin darf Zielthemen ändern.", topicExtra(message.message_thread_id));
      } else {
        const threadId = message.message_thread_id ?? null;
        await setGroupTopicSetting(chatId, "results_thread_id", threadId);
        await send(token, chatId, threadId ? "✅ Dieses Thema ist jetzt das Ziel für Ergebnisse." : "✅ Ergebnisse werden jetzt im allgemeinen Thema gesendet.", topicExtra(threadId));
      }
      return NextResponse.json({ ok: true });
    }

    if (["/themenreset", "/resettopics"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Diesen Befehl musst du in der Gruppe senden.");
      } else if (role !== "owner") {
        await send(token, chatId, "Nur der konfigurierte Bot-Admin darf Zielthemen ändern.", topicExtra(message.message_thread_id));
      } else {
        const { error } = await supabase.from("group_topic_settings").delete().eq("chat_id", chatId);
        if (error) throw error;
        await send(token, chatId, "✅ Zielthemen zurückgesetzt. Umfrage-Link und Ergebnisse gehen wieder ins allgemeine Thema.", topicExtra(message.message_thread_id));
      }
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

    if (isPrivate && role === "player" && text && !isCommand) {
      const playerSession = await getSession(userId);
      if (playerSession?.mode === "awaiting_token_redeem") {
        const redeemed = await redeemCreatorToken(token, chatId, message.from, text, ownerId);
        if (redeemed) await setSession(userId, { category_id: null, mode: "idle", pending_file_id: null, pending_item_id: null });
        return NextResponse.json({ ok: true });
      }
    }

    if (isPrivate && (role === "owner" || role === "creator")) {
      if (["/admin", "/start"].includes(command) && !text.includes("group_")) {
        await sendCommands(token, chatId, role);
        return NextResponse.json({ ok: true });
      }

      if (command === "/neuekategorie") {
        try { await assertCreatorCanCreate(userId, role); } catch (error) { await send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); return NextResponse.json({ ok: true }); }
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
        await incrementCreatorUsage(userId, role);
        await setSession(userId, { category_id: category.id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
        await send(token, chatId, `✅ Kategorie <b>${escapeHtml(category.name)}</b> erstellt.\n\nSende jetzt das erste Bild. Danach frage ich nach dem Namen – oder du setzt den Namen direkt als Bildunterschrift.`);
        return NextResponse.json({ ok: true });
      }

      if (command === "/kategorien") {
        await categoryMenu(token, chatId, userId, role);
        return NextResponse.json({ ok: true });
      }

      if (command === "/bearbeiten") {
        const name = commandArg(text);
        if (!name) {
          await categoryMenu(token, chatId, userId, role);
          return NextResponse.json({ ok: true });
        }
        const category = await findCategoryByName(name);
        if (!category) {
          await send(token, chatId, "Kategorie nicht gefunden. Nutze <code>/kategorien</code>.");
          return NextResponse.json({ ok: true });
        }
        if (!(await canManageCategory(userId, role, category.id))) { await send(token, chatId, "Du darfst diese Kategorie nicht verwalten."); return NextResponse.json({ ok: true }); }
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
        if (!(await canManageCategory(userId, role, category.id))) { await send(token, chatId, "Du darfst diese Kategorie nicht löschen."); return NextResponse.json({ ok: true }); }
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

      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_authorize_owner_id") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0) {
          await send(token, chatId, "Ungültige Telegram-ID. Sende nur die numerische ID, zum Beispiel <code>123456789</code>.");
          return NextResponse.json({ ok: true });
        }
        if (targetId === ownerId) {
          await supabase.from("admin_sessions").delete().eq("user_id", userId);
          await send(token, chatId, "Diese ID ist bereits der Haupt-Owner.");
          return NextResponse.json({ ok: true });
        }
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `<b>Owner hinzufügen?</b>\n\nTelegram-ID: <code>${targetId}</code>\n\nDer neue Owner erhält dieselben Verwaltungsrechte wie du.`, {
          reply_markup: { inline_keyboard: [[
            { text: "✅ Als Owner hinzufügen", callback_data: `approveowner:${targetId}` },
            { text: "Abbrechen", callback_data: "noop:x" }
          ]] }
        });
        return NextResponse.json({ ok: true });
      }
      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_authorize_creator_id") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0) {
          await send(token, chatId, "Ungültige Telegram-ID. Sende nur die numerische ID, zum Beispiel <code>123456789</code>.");
          return NextResponse.json({ ok: true });
        }
        const { data: existingCreator } = await supabase
          .from("bot_users")
          .select("user_id,role,active,category_limit,categories_used")
          .eq("user_id", targetId)
          .maybeSingle();
        if (existingCreator?.role === "creator" && existingCreator.active) {
          await supabase.from("admin_sessions").delete().eq("user_id", userId);
          await send(token, chatId, `Dieser Nutzer ist bereits Creator. Aktuell: <b>${quotaLabel(existingCreator.category_limit, Number(existingCreator.categories_used ?? 0))}</b>. Nutze „Kontingent ändern“ im Rollenmenü.`);
          return NextResponse.json({ ok: true });
        }
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        const rows = quotaButtons("placeholder").map((row) => row.map((button) => {
          const quotaCode = button.callback_data.split(":", 2)[1];
          return { ...button, callback_data: `approveuser:${targetId}_${quotaCode}` };
        }));
        await send(token, chatId, `<b>Creator freigeben</b>\n\nTelegram-ID: <code>${targetId}</code>\n\nWie viele Kategorien darf dieser Creator insgesamt erstellen?`, {
          reply_markup: { inline_keyboard: rows }
        });
        return NextResponse.json({ ok: true });
      }
      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_quota_user") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0) { await send(token, chatId, "Ungültige Telegram-ID."); return NextResponse.json({ ok: true }); }
        const { data: creator } = await supabase.from("bot_users").select("user_id,category_limit,categories_used,active").eq("user_id", targetId).eq("role", "creator").maybeSingle();
        if (!creator) { await send(token, chatId, "Creator nicht gefunden."); return NextResponse.json({ ok: true }); }
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `<b>Kontingent ändern</b>
Creator: <code>${targetId}</code>
Aktuell: ${quotaLabel(creator.category_limit, Number(creator.categories_used ?? 0))}

Neues Kontingent wählen:`, {
          reply_markup: { inline_keyboard: quotaButtons(`setquota_${targetId}`).map(row => row.map(button => ({ ...button, callback_data: button.callback_data.replace(`setquota_${targetId}:`, `setquota:${targetId}_`) }))) }
        });
        return NextResponse.json({ ok: true });
      }
      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_revoke_user") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === ownerId) { await send(token, chatId, "Ungültige ID oder Owner kann nicht gesperrt werden."); return NextResponse.json({ ok: true }); }
        const { error } = await supabase.from("bot_users").update({ active: false, updated_at: new Date().toISOString() }).eq("user_id", targetId);
        if (error) throw error;
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `🚫 Creator <code>${targetId}</code> wurde gesperrt. Das Konto bleibt als Player nutzbar.`);
        return NextResponse.json({ ok: true });
      }

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
          try { await assertCreatorCanCreate(userId, role); } catch (error) { await send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); return NextResponse.json({ ok: true }); }
          const { data: category, error } = await supabase.from("categories").insert({ name: text, created_by: userId }).select("id,name").single();
          if (error) {
            if (String(error.message).toLowerCase().includes("duplicate")) {
              await send(token, chatId, "Eine Kategorie mit diesem Namen existiert bereits.");
              return NextResponse.json({ ok: true });
            }
            throw error;
          }
          await incrementCreatorUsage(userId, role);
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
    if (!isPrivate && role === "player") {
      await send(token, chatId, "Nur Owner oder Creator dürfen ein neues Spiel starten.", topicExtra(message.message_thread_id));
      return NextResponse.json({ ok: true });
    }

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
        if (role === "creator" && !(await canManageCategory(userId, role, category.id))) {
          await send(token, chatId, "Creator dürfen nur eigene Kategorien starten.");
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
      if (categoryId && role === "creator" && !(await canManageCategory(userId, role, categoryId))) {
        await send(token, chatId, "Die aktive Kategorie gehört einem anderen Creator. Starte eine eigene Kategorie mit <code>/blindranking Kategoriename</code>.");
        return NextResponse.json({ ok: true });
      }
      if (!categoryId) {
        await send(token, chatId, "Noch keine aktive Kategorie vorhanden. Der Admin muss zuerst eine Kategorie fertigstellen.");
        return NextResponse.json({ ok: true });
      }
      const bot = await telegramApi(token, "getMe", {});
      const deepLink = `https://t.me/${bot.username}?start=group_${chatId}_${categoryId}`;
      const topicSettings = await getGroupTopicSettings(chatId);
      await send(token, chatId, `🎲 <b>Blind Ranking</b>\nKategorie: <b>${escapeHtml(categoryName)}</b>\n\nTippe auf den Button.`, {
        ...topicExtra(topicSettings.poll_thread_id),
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
