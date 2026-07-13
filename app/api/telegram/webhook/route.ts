import { NextRequest, NextResponse } from "next/server";

type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
};

type TelegramMessage = {
  text?: string;
  chat?: TelegramChat;
};

async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram API error in ${method}`);
  }
  return data.result;
}

export async function POST(request: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WEBHOOK_SECRET;

  if (!token || !appUrl || !secret) {
    return NextResponse.json({ ok: false, error: "Server configuration is incomplete." }, { status: 500 });
  }

  const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (headerSecret !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = await request.json();
    const message: TelegramMessage | undefined = update.message;
    if (!message?.chat?.id) return NextResponse.json({ ok: true });

    const text = message.text?.trim() ?? "";
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    if (command !== "/blindranking" && command !== "/start") {
      return NextResponse.json({ ok: true });
    }

    const chatId = String(message.chat.id);
    const isPrivate = message.chat.type === "private";

    // Telegram permits web_app inline buttons only in private chats.
    // In groups, send a normal deep-link button that opens the private bot chat.
    if (!isPrivate) {
      const bot = await telegramApi(token, "getMe", {});
      const deepLink = `https://t.me/${bot.username}?start=group_${chatId}`;

      await telegramApi(token, "sendMessage", {
        chat_id: chatId,
        text: "🎲 <b>Blind Ranking</b>\n\nTippe auf den Button. Das Spiel öffnet sich kurz im privaten Bot-Chat; dein Ergebnis wird anschließend in diese Gruppe gesendet.",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🎮 Spiel starten", url: deepLink }]]
        }
      });

      return NextResponse.json({ ok: true });
    }

    // A group deep link arrives as: /start group_-1001234567890
    const startPayload = command === "/start" ? text.split(/\s+/)[1] ?? "" : "";
    const targetChatId = startPayload.startsWith("group_")
      ? startPayload.slice("group_".length)
      : chatId;

    if (!/^-?\d+$/.test(targetChatId)) {
      return NextResponse.json({ ok: false, error: "Invalid target chat." }, { status: 400 });
    }

    const miniAppUrl = `${appUrl.replace(/\/$/, "")}/?chat_id=${encodeURIComponent(targetChatId)}`;
    await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text: "🎲 <b>Blind Ranking</b>\n\nDu bekommst fünf Gerichte nacheinander und musst sie blind auf Platz 1–5 setzen.",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🎮 Spiel öffnen", web_app: { url: miniAppUrl } }]]
      }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
