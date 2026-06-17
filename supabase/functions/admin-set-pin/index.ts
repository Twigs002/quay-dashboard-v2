// Supabase Edge Function: admin-set-pin
// Resets a staff member's Supabase Auth password (their PIN).
// Caller must be an admin (verified by the public.staff row of the auth.uid).
//
// Deploy:
//   supabase functions deploy admin-set-pin --no-verify-jwt
//
// Environment variables required (set via Supabase dashboard or CLI):
//   SUPABASE_URL              — auto-set
//   SUPABASE_ANON_KEY         — auto-set
//   SUPABASE_SERVICE_ROLE_KEY — set this yourself (NEVER commit)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function bad(err: string, status = 400) {
  return ok({ ok: false, error: err }, status);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return bad("Use POST", 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return bad("Missing Authorization", 401);
  const accessToken = auth.slice(7);

  let payload: { id?: string; pin?: string };
  try {
    payload = await req.json();
  } catch {
    return bad("Body must be JSON");
  }
  const { id, pin } = payload;
  if (!id || typeof id !== "string") return bad("id required");
  if (!pin || !/^\d{4}$/.test(pin)) return bad("pin must be 4 digits");

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!service) return bad("Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing", 500);

  // Verify caller is an admin via their own session.
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser();
  if (whoErr || !who.user) return bad("Invalid session", 401);
  const callerEmail = who.user.email;

  const admin = createClient(url, service);
  const { data: callerStaff, error: callerErr } = await admin
    .from("staff")
    .select("is_admin, is_super")
    .eq("id", (callerEmail ?? "").split("@")[0])
    .maybeSingle();
  if (callerErr || !callerStaff?.is_admin) return bad("Admin only", 403);

  // Find the target user by id -> email.
  const { data: targetStaff } = await admin
    .from("staff")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!targetStaff) return bad("Staff not found", 404);

  // Resolve the auth user via the email convention used by admin-create-staff.
  // (Assumed email shape: `<id>@quay1.co.za` — match whatever admin-create-staff uses.)
  const email = `${id}@quay1.co.za`;
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({
    page: 1, perPage: 200,
  });
  if (listErr) return bad(`auth lookup failed: ${listErr.message}`, 500);
  const target = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!target) return bad(`auth user not found for ${email}`, 404);

  const { error: updErr } = await admin.auth.admin.updateUserById(target.id, {
    password: pin,
  });
  if (updErr) return bad(`update failed: ${updErr.message}`, 500);

  return ok({ ok: true, id, email });
});
