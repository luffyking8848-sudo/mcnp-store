
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

const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
const maxFileSize = 5 * 1024 * 1024;

Deno.serve(async (req) => {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ error: "Use POST" }, 405);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !serviceKey) {
      return reply({ error: "Order service is not configured." }, 500);
    }

    // Require a signed-in customer. Do not trust a user ID from the request body.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return reply({ error: "Please sign in first." }, 401);
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const token = authHeader.slice("Bearer ".length);
    const { data: authData, error: authError } =
      await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      return reply({ error: "Your session is invalid. Sign in again." }, 401);
    }

    const body = await req.json();

    const player = body.player_name;
    const server = body.server;
    const edition = body.edition;
    const productId = body.product_id;
    const quantity = body.quantity ?? 1;
    const contact = body.customer_contact ?? null;
    const receiptBase64 = body.receipt_base64;
    const receiptMime = body.receipt_mime;

    if (
      typeof player !== "string" ||
      !/^[A-Za-z0-9_]{3,16}$/.test(player)
    ) {
      return reply({ error: "Enter a valid Minecraft username." }, 400);
    }

    if (!["Survival", "Lifesteal"].includes(server)) {
      return reply({ error: "Choose Survival or Lifesteal." }, 400);
    }

    if (!["Java", "Bedrock"].includes(edition)) {
      return reply({ error: "Choose Java or Bedrock edition." }, 400);
    }

    if (
      typeof productId !== "string" ||
      !Object.hasOwn(catalog, productId)
    ) {
      return reply({ error: "Unknown product." }, 400);
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return reply({ error: "Quantity must be 1–10." }, 400);
    }

    if (
      ["vip", "elite", "champion", "custom_rank"].includes(productId) &&
      quantity !== 1
    ) {
      return reply({ error: "Rank quantity must be 1." }, 400);
    }

    if (
      contact !== null &&
      (typeof contact !== "string" || contact.length > 120)
    ) {
      return reply({ error: "Contact must be under 120 characters." }, 400);
    }

    // Receipt is optional while payments are disabled.
    // If supplied, validate and store it privately for manual review.
    let receiptPath: string | null = null;

    if (receiptBase64 !== undefined && receiptBase64 !== null) {
      if (
        typeof receiptBase64 !== "string" ||
        !allowedTypes.includes(receiptMime)
      ) {
        return reply({ error: "Use a JPG, PNG, or WebP receipt." }, 400);
      }

      // Limit encoded data size before decoding.
      if (receiptBase64.length > Math.ceil(maxFileSize * 4 / 3) + 16) {
        return reply({ error: "Receipt must be 5 MB or smaller." }, 400);
      }

      let bytes: Uint8Array;
      try {
        const cleanBase64 = receiptBase64.replace(
          /^data:image\/(jpeg|png|webp);base64,/,
          "",
        );
        const binary = atob(cleanBase64);
        bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      } catch {
        return reply({ error: "Receipt image data is invalid." }, 400);
      }

      if (bytes.length === 0 || bytes.length > maxFileSize) {
        return reply({ error: "Receipt must be between 1 byte and 5 MB." }, 400);
      }

      // Basic file-signature checks; this is not a full malware scan.
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 &&
        bytes[2] === 0x4e && bytes[3] === 0x47;
      const isWebp = bytes.length >= 12 &&
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";

      if (
        (receiptMime === "image/jpeg" && !isJpeg) ||
        (receiptMime === "image/png" && !isPng) ||
        (receiptMime === "image/webp" && !isWebp)
      ) {
        return reply({ error: "File contents do not match the image type." }, 400);
      }

      const receiptId = crypto.randomUUID();
      receiptPath = `${authData.user.id}/${receiptId}`;

      const { error: uploadError } = await supabase.storage
        .from("payment-receipts")
        .upload(receiptPath, bytes, {
          contentType: receiptMime,
          upsert: false,
        });

      if (uploadError) {
        console.error("Receipt upload failed:", uploadError.message);
        return reply({
          error: "Receipt upload failed. Check the private payment-receipts bucket.",
        }, 500);
      }
    }

    const product = catalog[productId];
    const total = product.price * quantity;

    const { data, error } = await supabase
      .from("orders")
      .insert({
        user_id: authData.user.id,
        player_name: player,
        server,
        edition,
        product_id: productId,
        product_name: product.name,
        unit_price: product.price,
        quantity,
        total,
        customer_contact: contact,
        receipt_path: receiptPath,
        status: "pending",
        payment_status: "disabled",
      })
      .select("id, order_code, total, status, payment_status")
      .single();

    if (error) {
      console.error("Order insert failed:", error.message);
      return reply({
        error: "Could not save order. Check database columns.",
      }, 500);
    }

    return reply({
      message: "Order submitted. Payment is disabled; no money was collected or verified.",
      order: data,
    }, 201);
  } catch {
    return reply({ error: "Invalid request." }, 400);
  }
});
