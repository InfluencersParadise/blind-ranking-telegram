import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

function validateTelegramInitData(initData: string, botToken: string): boolean {
  if (!initData) return false;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return false;
  params.delete("hash");
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 3600) return false;
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (receivedHash.length !== calculatedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(calculatedHash, "hex"), Buffer.from(receivedHash, "hex"));
}

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });
  const body = await request.json();
  const { initData, chatId, ranking } = body as {
    initData?: string;
    chatId?: string | null;
    categoryId?: string | null;
    ranking?: Array<{ position: number; title: string }>;
  };
  if (!validateTelegramInitData(initData ?? "", botToken)) return NextResponse.json({ error: "Telegram-Anmeldung ist ungültig oder abgelaufen." }, { status: 401 });
  if (!chatId || !/^-?\d+$/.test(chatId)) return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
  if (!Array.isArray(ranking) || ranking.length < 2 || ranking.length > 10 || ranking.some((x, i) => x.position !== i + 1 || !x.title)) {
    return NextResponse.json({ error: "Ranking ist ungültig." }, { status: 400 });
  }
  const params = new URLSearchParams(initData);
  let player = "Ein Spieler";
  try {
    const user = JSON.parse(params.get("user") ?? "{}");
    player = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(" ") || player;
  } catch {}
  const numberEmoji = (position: number) => position <= 9 ? `${position}️⃣` : `🔟`;
  const text = [`🏆 <b>Blind Ranking von ${escapeHtml(player)}</b>`, "", ...ranking.map((entry) => `${numberEmoji(entry.position)} ${escapeHtml(entry.title)}`)].join("\n");
  const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
  const telegramData = await telegramResponse.json();
  if (!telegramData.ok) return NextResponse.json({ error: telegramData.description || "Telegram konnte nicht senden." }, { status: 502 });
  return NextResponse.json({ ok: true });
}
function escapeHtml(value: string) { return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char)); }
