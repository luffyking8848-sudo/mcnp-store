import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const catalog: Record<string, { name: string; price: number }> = {
  vip: { name: "VIP Rank", price: 49 },
  elite: { name: "Elite Rank", price: 99 },
  champion: { name: "Champion Rank", price: 399 },
  custom_rank: { name: "Custom Rank", price: 899 },
  iron_key: { name: "Iron Crate Key", price: 10 },
  gold_key: { name: "Gold Crate Key", price: 20 },
  diamond_key: { name: "Diamond Crate Key", price: 35 },
  exclusive_key: { name: "Exclusive Crate Key", price: 45 },
};

Deno.serve(async (req) => {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  try {
    const body = await req.json();
    const player = body.player_name;
    const server = body.server;
    const productId = body.product_id;
    const quantity = body.quantity ?? 1;
    const contact = body.customer_contact ?? null;

    if (typeof player !== "string" ||
        !/^[A-Za-z0-9_]{3,16}$/.test(player)) {
      return reply({ error: "Enter a valid Minecraft username." }, 400);
    }

    if (!["Survival", "Lifesteal"].includes(server)) {
      return reply({ error: "Choose Survival or Lifesteal." }, 400);
    }

    if (typeof productId !== "string" ||
        !Object.hasOwn(catalog, productId)) {
      return reply({ error: "Unknown product." }, 400);
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return reply({ error: "Quantity must be 1–10." }, 400);
    }

    if (["vip", "elite", "champion", "custom_rank"].includes(productId) &&
        quantity !== 1) {
      return reply({ error: "Rank quantity must be 1." }, 400);
    }

    if (contact !== null &&
        (typeof contact !== "string" || contact.length > 120)) {
      return reply({ error: "Contact must be under 120 characters." }, 400);
    }

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !key) {
      return reply({ error: "Order service is not configured." }, 500);
    }

    const supabase = createClient(url, key);
    const product = catalog[productId];

    const { data, error } = await supabase
      .from("orders")
      .insert({
        player_name: player,
        server,
        product_id: productId,
        product_name: product.name,
        unit_price: product.price,
        quantity,
        total: product.price * quantity,
        customer_contact: contact,
        status: "pending",
        payment_status: "disabled",
      })
      .select("id, order_code, total, status")
      .single();

    if (error) {
      console.error("Order insert failed:", error.message);
      return reply({ error: "Could not save order. Check database columns." }, 500);
    }

    return reply({
      message: "Order submitted. Payment is disabled; no money was collected.",
      order: data,
    }, 201);
  } catch {
    return reply({ error: "Invalid request." }, 400);
  }
});
