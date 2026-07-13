import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";

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

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
}

function numberEmoji(position: number) {
  return position <= 9 ? `${position}️⃣` : "🔟";
}

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });

  const body = await request.json();
  const { initData, chatId, categoryId, ranking } = body as {
    initData?: string;
    chatId?: string | null;
    categoryId?: string | null;
    ranking?: Array<{ position: number; itemId: string; title: string }>;
  };

  if (!validateTelegramInitData(initData ?? "", botToken)) {
    return NextResponse.json({ error: "Telegram-Anmeldung ist ungültig oder abgelaufen." }, { status: 401 });
  }
  if (!chatId || !/^-?\d+$/.test(chatId)) {
    return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
  }
  if (!categoryId) {
    return NextResponse.json({ error: "Kategorie-ID fehlt." }, { status: 400 });
  }
  if (
    !Array.isArray(ranking) ||
    ranking.length < 2 ||
    ranking.length > 10 ||
    ranking.some((entry, index) => entry.position !== index + 1 || !entry.itemId || !entry.title)
  ) {
    return NextResponse.json({ error: "Ranking ist ungültig." }, { status: 400 });
  }

  const initParams = new URLSearchParams(initData);
  let player = "Ein Spieler";
  try {
    const user = JSON.parse(initParams.get("user") ?? "{}");
    player = user.username
      ? `@${user.username}`
      : [user.first_name, user.last_name].filter(Boolean).join(" ") || player;
  } catch {
    // Telegram-Nutzername ist optional.
  }

  const itemIds = ranking.map((entry) => entry.itemId);
  const supabase = getSupabaseAdmin();
  const { data: items, error } = await supabase
    .from("items")
    .select("id,title,image_url,category_id")
    .eq("category_id", categoryId)
    .in("id", itemIds);

  if (error) {
    console.error("Share lookup failed:", error);
    return NextResponse.json({ error: "Bilder konnten nicht geladen werden." }, { status: 500 });
  }
  if (!items || items.length !== ranking.length) {
    return NextResponse.json({ error: "Mindestens ein Ranking-Bild wurde nicht gefunden." }, { status: 400 });
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const media = ranking.map((entry, index) => {
    const item = byId.get(entry.itemId);
    if (!item?.image_url) throw new Error(`Bild für Platz ${entry.position} fehlt.`);
    const heading = index === 0 ? `🏆 <b>Blind Ranking von ${escapeHtml(player)}</b>\n\n` : "";
    return {
      type: "photo",
      media: item.image_url,
      caption: `${heading}${numberEmoji(entry.position)} <b>${escapeHtml(item.title)}</b>`,
      parse_mode: "HTML"
    };
  });

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, media })
    });
    const telegramData = await telegramResponse.json();
    if (!telegramData.ok) {
      console.error("Telegram sendMediaGroup failed:", telegramData);
      return NextResponse.json(
        { error: telegramData.description || "Telegram konnte die Bilder nicht senden." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Share failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Telegram konnte das Ranking nicht senden." },
      { status: 502 }
    );
  }
}
