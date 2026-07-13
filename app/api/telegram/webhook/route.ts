import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, IMAGE_BUCKET } from "../../../../lib/supabase";

type TelegramChat = { id: number; type: "private" | "group" | "supergroup" | "channel" };
type TelegramUser = { id: number; username?: string; first_name?: string };
type TelegramPhoto = { file_id: string; file_size?: number; width: number; height: number };
type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
  photo?: TelegramPhoto[];
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

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
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
  return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(objectPath).data.publicUrl;
}

async function findCategoryByName(name: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("categories").select("id,name").ilike("name", name.trim()).limit(1).maybeSingle();
  if (error) throw error;
  return data;
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
    const update = await request.json();
    const message: TelegramMessage | undefined = update.message;
    if (!message?.chat?.id || !message.from?.id) return NextResponse.json({ ok: true });

    const chatId = String(message.chat.id);
    const userId = message.from.id;
    const isPrivate = message.chat.type === "private";
    const text = (message.text ?? "").trim();
    const command = text ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
    const supabase = getSupabaseAdmin();

    if (isPrivate && userId === adminId) {
      if (command === "/hilfe" || command === "/admin") {
        await send(token, chatId, "<b>Admin-Befehle</b>\n\n/neuekategorie Name\nDann Bilder einzeln senden und jeweils danach den Namen schreiben.\n/fertig\n/kategorien\n/aktiv Kategoriename\n/löschen Kategoriename");
        return NextResponse.json({ ok: true });
      }

      if (command === "/neuekategorie") {
        const name = text.slice(text.indexOf(" ") + 1).trim();
        if (!name || name === text) {
          await send(token, chatId, "Bitte so senden: <code>/neuekategorie Meine Kategorie</code>");
          return NextResponse.json({ ok: true });
        }
        const { data: category, error } = await supabase.from("categories").insert({ name, created_by: userId }).select("id,name").single();
        if (error) throw error;
        await supabase.from("admin_sessions").upsert({ user_id: userId, category_id: category.id, mode: "awaiting_photo", pending_file_id: null, updated_at: new Date().toISOString() });
        await send(token, chatId, `✅ Kategorie <b>${escapeHtml(category.name)}</b> erstellt.\n\nSende jetzt das erste Bild. Danach frage ich dich nach dem Namen.`);
        return NextResponse.json({ ok: true });
      }

      if (command === "/kategorien") {
        const { data, error } = await supabase.from("categories").select("id,name,items(count)").order("created_at", { ascending: false });
        if (error) throw error;
        const rows = (data ?? []).map((c: any) => `• <b>${escapeHtml(c.name)}</b> (${c.items?.[0]?.count ?? 0} Bilder)`);
        await send(token, chatId, rows.length ? `<b>Kategorien</b>\n\n${rows.join("\n")}` : "Noch keine Kategorien vorhanden.");
        return NextResponse.json({ ok: true });
      }

      if (command === "/aktiv") {
        const name = text.slice(text.indexOf(" ") + 1).trim();
        const category = await findCategoryByName(name);
        if (!category) await send(token, chatId, "Kategorie nicht gefunden.");
        else {
          await supabase.from("app_settings").upsert({ id: 1, active_category_id: category.id });
          await send(token, chatId, `✅ <b>${escapeHtml(category.name)}</b> ist jetzt aktiv.`);
        }
        return NextResponse.json({ ok: true });
      }

      if (command === "/löschen" || command === "/loeschen") {
        const name = text.slice(text.indexOf(" ") + 1).trim();
        const category = await findCategoryByName(name);
        if (!category) await send(token, chatId, "Kategorie nicht gefunden.");
        else {
          await supabase.from("categories").delete().eq("id", category.id);
          await send(token, chatId, `🗑️ <b>${escapeHtml(category.name)}</b> wurde gelöscht.`);
        }
        return NextResponse.json({ ok: true });
      }

      if (command === "/fertig") {
        const { data: session } = await supabase.from("admin_sessions").select("category_id").eq("user_id", userId).maybeSingle();
        if (!session?.category_id) {
          await send(token, chatId, "Keine Kategorie in Bearbeitung.");
          return NextResponse.json({ ok: true });
        }
        const { count } = await supabase.from("items").select("id", { count: "exact", head: true }).eq("category_id", session.category_id);
        if (!count || count < 2 || count > 10) {
          await send(token, chatId, `Die Kategorie hat aktuell ${count ?? 0} Bilder. Erlaubt sind 2 bis 10.`);
          return NextResponse.json({ ok: true });
        }
        await supabase.from("app_settings").upsert({ id: 1, active_category_id: session.category_id });
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `✅ Fertig. Die Kategorie mit ${count} Bildern ist jetzt aktiv. Starte sie in der Gruppe mit /blindranking.`);
        return NextResponse.json({ ok: true });
      }

      const { data: session } = await supabase.from("admin_sessions").select("category_id,mode,pending_file_id").eq("user_id", userId).maybeSingle();

      if (message.photo?.length) {
        if (!session?.category_id) {
          await send(token, chatId, "Erstelle zuerst eine Kategorie mit <code>/neuekategorie Name</code>.");
          return NextResponse.json({ ok: true });
        }
        const bestPhoto = message.photo[message.photo.length - 1];
        if (message.caption?.trim()) {
          const imageUrl = await uploadTelegramPhoto(token, bestPhoto.file_id, userId);
          const { count } = await supabase.from("items").select("id", { count: "exact", head: true }).eq("category_id", session.category_id);
          if ((count ?? 0) >= 10) {
            await send(token, chatId, "Maximal 10 Bilder pro Kategorie.");
            return NextResponse.json({ ok: true });
          }
          await supabase.from("items").insert({ category_id: session.category_id, title: message.caption.trim(), image_url: imageUrl, position: (count ?? 0) + 1 });
          await send(token, chatId, `✅ <b>${escapeHtml(message.caption.trim())}</b> hinzugefügt. Sende das nächste Bild oder /fertig.`);
        } else {
          await supabase.from("admin_sessions").update({ mode: "awaiting_title", pending_file_id: bestPhoto.file_id, updated_at: new Date().toISOString() }).eq("user_id", userId);
          await send(token, chatId, "Wie heißt dieses Bild? Sende jetzt nur den Namen.");
        }
        return NextResponse.json({ ok: true });
      }

      if (text && !command && session?.mode === "awaiting_title" && session.pending_file_id) {
        const { count } = await supabase.from("items").select("id", { count: "exact", head: true }).eq("category_id", session.category_id);
        if ((count ?? 0) >= 10) {
          await send(token, chatId, "Maximal 10 Bilder pro Kategorie.");
          return NextResponse.json({ ok: true });
        }
        const imageUrl = await uploadTelegramPhoto(token, session.pending_file_id, userId);
        await supabase.from("items").insert({ category_id: session.category_id, title: text, image_url: imageUrl, position: (count ?? 0) + 1 });
        await supabase.from("admin_sessions").update({ mode: "awaiting_photo", pending_file_id: null, updated_at: new Date().toISOString() }).eq("user_id", userId);
        await send(token, chatId, `✅ <b>${escapeHtml(text)}</b> hinzugefügt. Sende das nächste Bild oder /fertig.`);
        return NextResponse.json({ ok: true });
      }
    }

    if (command !== "/blindranking" && command !== "/start") return NextResponse.json({ ok: true });

    if (!isPrivate) {
      const requestedName = command === "/blindranking" ? text.slice(text.indexOf(" ") + 1).trim() : "";
      let categoryId: string | null = null;
      let categoryName = "aktive Kategorie";
      if (requestedName && requestedName !== text) {
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
        await send(token, chatId, "Noch keine aktive Kategorie vorhanden. Der Admin muss zuerst Bilder hinzufügen.");
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
