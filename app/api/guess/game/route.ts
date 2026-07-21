import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });
    const body = await request.json() as { initData?: string; gameId?: string };
    const auth = validateTelegramInitData(body.initData ?? "", token);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason) }, { status: 401 });
    const sb = getSupabaseAdmin();
    const { data: game } = await sb.from("guess_games").select("id,title,answer_mode,hints_enabled,send_images,is_active").eq("id", body.gameId).maybeSingle();
    if (!game?.is_active) return NextResponse.json({ error: "Kategorie nicht aktiv." }, { status: 404 });
    const { data: people } = await sb.from("guess_people").select("id,display_name,aliases,sort_order").eq("game_id", game.id).order("sort_order");
    const ids=(people??[]).map(p=>p.id);
    const { data: media } = ids.length ? await sb.from("guess_media").select("id,person_id,media_url,media_type,hint_level,sort_order").in("person_id",ids).order("hint_level") : {data:[] as any[]};
    const rounds=(people??[]).map(p=>({personId:p.id, displayName:p.display_name, choices:(people??[]).map(x=>x.display_name).sort(()=>Math.random()-.5).slice(0,4), media:(media??[]).filter(m=>m.person_id===p.id)}));
    return NextResponse.json({game,rounds});
  } catch(e){ return NextResponse.json({error:e instanceof Error?e.message:"Fehler"},{status:500}); }
}
