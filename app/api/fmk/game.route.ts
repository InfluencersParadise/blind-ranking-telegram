import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import {
  telegramAuthErrorMessage,
  validateTelegramInitData,
} from "../../../../lib/telegram-auth";

export const dynamic = "force-dynamic";

type FmkRole = "fuck" | "marry" | "kill";
type VoteEntry = { item_id: string; role: FmkRole };

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

export async function POST(request: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });
    }

    const body = (await request.json()) as {
      initData?: string;
      chatId?: string | null;
      categoryId?: string | null;
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

    const user = JSON.parse(auth.params.get("user") ?? "{}") as { id?: number };
    const userId = Number(user.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return NextResponse.json(
        { error: "Telegram-Nutzer-ID fehlt." },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();
    const [categoryResult, itemsResult] = await Promise.all([
      supabase
        .from("categories")
        .select("id,name,game_type")
        .eq("id", body.categoryId)
        .single(),
      supabase
        .from("items")
        .select("id,title,image_url,position")
        .eq("category_id", body.categoryId)
        .order("position", { ascending: true }),
    ]);

    if (categoryResult.error) throw categoryResult.error;
    if (itemsResult.error) throw itemsResult.error;

    const category = categoryResult.data;
    const items = itemsResult.data ?? [];

    if (category.game_type !== "fmk") {
      return NextResponse.json(
        { error: "Dieses Spiel ist kein Fuck, Marry, Kill." },
        { status: 400 },
      );
    }
    if (items.length !== 3) {
      return NextResponse.json(
        { error: "Ein FMK-Spiel muss genau 3 Bilder enthalten." },
        { status: 400 },
      );
    }

    const existingVoteResult = await supabase
      .from("fmk_votes")
      .select("id")
      .eq("category_id", body.categoryId)
      .eq("chat_id", body.chatId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingVoteResult.error) throw existingVoteResult.error;

    const existingVote = existingVoteResult.data;
    let previousSelection: VoteEntry[] | null = null;
    let community:
      | Array<{
          itemId: string;
          title: string;
          image: string;
          fuck: number;
          marry: number;
          kill: number;
        }>
      | null = null;
    let totalVotes = 0;

    if (existingVote?.id) {
      const [ownResult, votesResult] = await Promise.all([
        supabase
          .from("fmk_vote_entries")
          .select("item_id,role")
          .eq("vote_id", existingVote.id),
        supabase
          .from("fmk_votes")
          .select("id")
          .eq("category_id", body.categoryId)
          .eq("chat_id", body.chatId),
      ]);

      if (ownResult.error) throw ownResult.error;
      if (votesResult.error) throw votesResult.error;

      previousSelection = (ownResult.data ?? []) as VoteEntry[];
      const voteIds = (votesResult.data ?? []).map((vote) => vote.id);
      totalVotes = voteIds.length;

      let allEntries: VoteEntry[] = [];
      if (voteIds.length > 0) {
        const entriesResult = await supabase
          .from("fmk_vote_entries")
          .select("item_id,role")
          .in("vote_id", voteIds);
        if (entriesResult.error) throw entriesResult.error;
        allEntries = (entriesResult.data ?? []) as VoteEntry[];
      }

      const counts = new Map<string, Record<FmkRole, number>>();
      for (const item of items) {
        counts.set(item.id, { fuck: 0, marry: 0, kill: 0 });
      }
      for (const entry of allEntries) {
        const itemCounts = counts.get(entry.item_id);
        if (itemCounts) itemCounts[entry.role] += 1;
      }

      community = items.map((item) => {
        const itemCounts = counts.get(item.id) ?? { fuck: 0, marry: 0, kill: 0 };
        return {
          itemId: item.id,
          title: item.title,
          image: item.image_url,
          fuck: totalVotes ? Math.round((itemCounts.fuck / totalVotes) * 100) : 0,
          marry: totalVotes ? Math.round((itemCounts.marry / totalVotes) * 100) : 0,
          kill: totalVotes ? Math.round((itemCounts.kill / totalVotes) * 100) : 0,
        };
      });
    }

    return NextResponse.json({
      categoryId: category.id,
      title: category.name,
      items: shuffle(items).map((item) => ({
        id: item.id,
        title: item.title,
        image: item.image_url,
      })),
      alreadyVoted: Boolean(existingVote?.id),
      previousSelection,
      community,
      totalVotes,
    });
  } catch (error) {
    console.error("FMK game API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "FMK-Spiel konnte nicht geladen werden.",
      },
      { status: 500 },
    );
  }
}
