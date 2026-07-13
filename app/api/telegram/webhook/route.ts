import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (!token || !appUrl || !secret) return NextResponse.json({ ok: false }, { status: 500 });

  const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (headerSecret !== secret) return NextResponse.json({ ok: false }, { status: 401 });

  const update = await request.json();
  const message = update.message;
  if (!message?.chat?.id) return NextResponse.json({ ok: true });

  const text: string = message.text ?? "";
  if (!text.startsWith("/blindranking") && !text.startsWith("/start")) {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const miniAppUrl = `${appUrl.replace(/\/$/, "")}/?chat_id=${encodeURIComponent(chatId)}`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "🎲 <b>Blind Ranking</b>\n\nDu bekommst fünf Gerichte nacheinander und musst sie blind auf Platz 1–5 setzen.",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🎮 Spiel starten", web_app: { url: miniAppUrl } }]]
      }
    })
  });

  return NextResponse.json({ ok: true });
}
