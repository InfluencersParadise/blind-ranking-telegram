import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseAdmin();
    let categoryId = request.nextUrl.searchParams.get("category_id");

    if (!categoryId) {
      const { data: setting, error } = await supabase
        .from("app_settings")
        .select("active_category_id")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      categoryId = setting?.active_category_id ?? null;
    }

    if (!categoryId) {
      return NextResponse.json({ error: "Noch keine aktive Kategorie vorhanden." }, { status: 404 });
    }

    const { data: category, error: categoryError } = await supabase
      .from("categories")
      .select("id,name")
      .eq("id", categoryId)
      .single();
    if (categoryError) throw categoryError;

    const { data: items, error: itemsError } = await supabase
      .from("items")
      .select("id,title,image_url,position")
      .eq("category_id", categoryId)
      .order("position", { ascending: true });
    if (itemsError) throw itemsError;

    if (!items || items.length < 2 || items.length > 30) {
      return NextResponse.json({ error: "Die Kategorie braucht 2 bis 30 Bilder." }, { status: 400 });
    }

    const shuffled = [...items].sort(() => Math.random() - 0.5);
    return NextResponse.json({
      categoryId,
      title: category.name,
      subtitle: "Wähle einen freien Platz. Deine Entscheidung ist endgültig.",
      items: shuffled.map((item) => ({ id: item.id, title: item.title, image: item.image_url }))
    });
  } catch (error) {
    console.error("Game API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Spiel konnte nicht geladen werden." }, { status: 500 });
  }
}
