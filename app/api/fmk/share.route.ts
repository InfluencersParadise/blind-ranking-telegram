import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import {
  telegramAuthErrorMessage,
  validateTelegramInitData,
} from "../../../../lib/telegram-auth";

type Role = "fuck" | "marry" | "kill";
type Selection = { itemId: string; role: Role };
type TelegramUser = {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

const ROLES: Role[] = ["fuck", "marry", "kill"];
const LABELS: Record<Role, string> = {
  fuck: "🔥 Fuck",
  marry: "❤️ Marry",
  kill: "💀 Kill",
};

function escapeHtml(value: string) {
  return value.replace(
    /[&<>]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char,
  );
}

async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as { ok?: boolean; description?: string; result?: unknown };
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram-Fehler in ${method}`);
  }
  return data.result;
}

function isValidSelection(value: unknown): value is Selection[] {
  if (!Array.isArray(value) || value.length !== 3) return false;

  const entries = value as Array<Partial<Selection>>;
  return (
    entries.every(
      (entry) =>
        typeof entry.itemId === "string" &&
        entry.itemId.length > 0 &&
        typeof entry.role === "string" &&
        ROLES.includes(entry.role as Role),
    ) &&
    new Set(entries.map((entry) => entry.itemId)).size === 3 &&
    new Set(entries.map((entry) => entry.role)).size === 3
  );
}

export async function POST(request: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });
    }

    const body = (await request.json()) as {
      initData?: string;
      chatId?: string;
      categoryId?: string;
      selection?: unknown;
    };

    const auth = validateTelegramInitData(body.initData ?? "", botToken);
    if (!auth.ok) {
      return NextResponse.json(
        { error: telegramAuthErrorMessage(auth.reason), code: auth.reason },
        { status: 401 },
      );
    }
    if (!body.chatId || !/^-?\d+$/.test(body.chatId)) {
      return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
    }
    if (!body.categoryId) {
      return NextResponse.json({ error: "FMK-Spiel-ID fehlt." }, { status: 400 });
    }
    if (!isValidSelection(body.selection)) {
      return NextResponse.json(
        { error: "Jede Rolle muss genau einmal vergeben werden." },
        { status: 400 },
      );
    }

    const selection = body.selection;
    const user = JSON.parse(auth.params.get("user") ?? "{}") as TelegramUser;
    const userId = Number(user.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return NextResponse.json(
        { error: "Telegram-Nutzer-ID fehlt." },
        { status: 400 },
      );
    }

    const player = user.username
      ? `@${user.username}`
      : [user.first_name, user.last_name].filter(Boolean).join(" ") || "Ein Spieler";

    const supabase = getSupabaseAdmin();
    const [categoryResult, itemsResult, topicResult] = await Promise.all([
      supabase
        .from("categories")
        .select("name,game_type,send_images")
        .eq("id", body.categoryId)
        .single(),
      supabase
        .from("items")
        .select("id,title,image_url")
        .eq("category_id", body.categoryId),
      supabase
        .from("group_topic_settings")
        .select("results_thread_id")
        .eq("chat_id", body.chatId)
        .maybeSingle(),
    ]);

    if (categoryResult.error) throw categoryResult.error;
    if (itemsResult.error) throw itemsResult.error;
    if (topicResult.error) throw topicResult.error;

    const category = categoryResult.data;
    const items = itemsResult.data ?? [];
    const topic = topicResult.data;

    if (category.game_type !== "fmk" || items.length !== 3) {
      return NextResponse.json({ error: "Ungültiges FMK-Spiel." }, { status: 400 });
    }

    const allowedItemIds = new Set(items.map((item) => item.id));
    if (selection.some((entry) => !allowedItemIds.has(entry.itemId))) {
      return NextResponse.json(
        { error: "Ungültige Bildauswahl." },
        { status: 400 },
      );
    }

    const existingResult = await supabase
      .from("fmk_votes")
      .select("id")
      .eq("category_id", body.categoryId)
      .eq("chat_id", body.chatId)
      .eq("user_id", userId)
      .maybeSingle();
    if (existingResult.error) throw existingResult.error;
    if (existingResult.data?.id) {
      return NextResponse.json(
        { error: "Du hast für dieses FMK-Spiel bereits abgestimmt." },
        { status: 409 },
      );
    }

    const voteResult = await supabase
      .from("fmk_votes")
      .insert({
        category_id: body.categoryId,
        chat_id: body.chatId,
        user_id: userId,
        player_name: player,
      })
      .select("id")
      .single();

    if (voteResult.error || !voteResult.data) {
      if (voteResult.error?.code === "23505") {
        return NextResponse.json(
          { error: "Du hast für dieses FMK-Spiel bereits abgestimmt." },
          { status: 409 },
        );
      }
      throw voteResult.error ?? new Error("FMK-Stimme konnte nicht gespeichert werden.");
    }

    const voteId = voteResult.data.id;
    const entriesResult = await supabase.from("fmk_vote_entries").insert(
      selection.map((entry) => ({
        vote_id: voteId,
        item_id: entry.itemId,
        role: entry.role,
      })),
    );

    if (entriesResult.error) {
      await supabase.from("fmk_votes").delete().eq("id", voteId);
      throw entriesResult.error;
    }

    const votesResult = await supabase
      .from("fmk_votes")
      .select("id")
      .eq("category_id", body.categoryId)
      .eq("chat_id", body.chatId);
    if (votesResult.error) throw votesResult.error;

    const voteIds = (votesResult.data ?? []).map((vote) => vote.id);
    const allEntriesResult = await supabase
      .from("fmk_vote_entries")
      .select("item_id,role")
      .in("vote_id", voteIds);
    if (allEntriesResult.error) throw allEntriesResult.error;

    const totalVotes = voteIds.length;
    const counts = new Map<string, Record<Role, number>>(
      items.map((item) => [item.id, { fuck: 0, marry: 0, kill: 0 }]),
    );

    for (const entry of allEntriesResult.data ?? []) {
      const itemCounts = counts.get(entry.item_id);
      if (itemCounts && ROLES.includes(entry.role as Role)) {
        itemCounts[entry.role as Role] += 1;
      }
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    const threadPayload = topic?.results_thread_id
      ? { message_thread_id: topic.results_thread_id }
      : {};

    if (category.send_images !== false) {
      await telegramApi(botToken, "sendMediaGroup", {
        chat_id: body.chatId,
        ...threadPayload,
        media: selection.map((entry) => ({
          type: "photo",
          media: byId.get(entry.itemId)!.image_url,
        })),
      });
    }

    const ownResult = selection
      .map(
        (entry) =>
          `${LABELS[entry.role]}: <b>${escapeHtml(byId.get(entry.itemId)!.title)}</b>`,
      )
      .join("\n");

    const communityResult = items
      .map((item) => {
        const itemCounts = counts.get(item.id) ?? { fuck: 0, marry: 0, kill: 0 };
        const percentage = (value: number) =>
          totalVotes > 0 ? Math.round((value / totalVotes) * 100) : 0;
        return `<b>${escapeHtml(item.title)}</b>\n🔥 ${percentage(itemCounts.fuck)}% · ❤️ ${percentage(itemCounts.marry)}% · 💀 ${percentage(itemCounts.kill)}%`;
      })
      .join("\n\n");

    await telegramApi(botToken, "sendMessage", {
      chat_id: body.chatId,
      parse_mode: "HTML",
      ...threadPayload,
      text: `🔥 <b>${escapeHtml(category.name)}</b> – Fuck, Marry, Kill von ${escapeHtml(player)}\n\n${ownResult}\n\n━━━━━━━━━━━━━━\n\n📊 <b>FMK-Community</b>\n${totalVotes} ${totalVotes === 1 ? "Stimme" : "Stimmen"} inklusive deiner Stimme\n\n${communityResult}`,
    });

    return NextResponse.json({ ok: true, totalVotes });
  } catch (error) {
    console.error("FMK share API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "FMK-Ergebnis konnte nicht gesendet werden.",
      },
      { status: 500 },
    );
  }
}
