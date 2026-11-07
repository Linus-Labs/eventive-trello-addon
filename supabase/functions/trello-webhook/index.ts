// Catches a card dragged by hand into (or out of) LOST or KIV.
//
// Trello calls this address when anything changes on a watched board. The
// call itself is not trusted: the function asks Trello again for the same
// action by its id, on our own key and token, and acts only on what Trello
// returns. A move made by the add-on's own Move to LOST / KIV button is
// already recorded with its reason, so it is skipped here.
//
// Secrets: TRELLO_WEBHOOK_KEY, TRELLO_WEBHOOK_TOKEN, ALLOWED_BOARDS.

import { createClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("TRELLO_WEBHOOK_KEY") ?? "";
const TOKEN = Deno.env.get("TRELLO_WEBHOOK_TOKEN") ?? "";
const ALLOWED_BOARDS = (Deno.env.get("ALLOWED_BOARDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const END_LISTS = ["LOST", "KIV"];
const isEnd = (name?: string) => !!name && END_LISTS.includes(name.trim().toUpperCase());

async function fetchAction(id: string) {
  const url = new URL(`https://api.trello.com/1/actions/${id}`);
  url.searchParams.set("fields", "id,type,data,date,idMemberCreator");
  url.searchParams.set("memberCreator", "true");
  url.searchParams.set("memberCreator_fields", "fullName");
  const res = await fetch(url, { headers: { Authorization: `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"` } });
  if (!res.ok) return null;
  return await res.json();
}

Deno.serve(async (req) => {
  // Trello checks the address with a HEAD call when the webhook is made.
  if (req.method === "HEAD" || req.method === "GET") return new Response("ok", { status: 200 });
  if (req.method !== "POST") return new Response("no", { status: 405 });
  try {
    const body = await req.json().catch(() => null);
    const id = body?.action?.id;
    if (!id || !/^[0-9a-f]{24}$/i.test(id)) return new Response("ignored", { status: 200 });
    if (body.action.type !== "updateCard" || !body.action.data?.listAfter) return new Response("ignored", { status: 200 });

    const action = await fetchAction(id); // the trusted copy
    if (!action || action.type !== "updateCard") return new Response("ignored", { status: 200 });
    const d = action.data ?? {};
    const boardId = d.board?.id, cardId = d.card?.id;
    const toName: string | undefined = d.listAfter?.name, fromName: string | undefined = d.listBefore?.name;
    if (!boardId || !cardId || !toName || !ALLOWED_BOARDS.includes(boardId)) return new Response("ignored", { status: 200 });
    if (!isEnd(toName) && !isEnd(fromName)) return new Response("ignored", { status: 200 });

    // Already recorded (Trello can send the same call twice)?
    const { data: dup } = await db.from("card_moves").select("id").eq("trello_action_id", id).maybeSingle();
    if (dup) return new Response("seen", { status: 200 });

    // Made by our own button in the last 10 minutes? Then the reason is already saved.
    const since = new Date(Date.parse(action.date) - 10 * 60_000).toISOString();
    const { data: mine } = await db.from("card_moves").select("id, trello_action_id")
      .eq("card_id", cardId).eq("to_list", toName).in("source", ["button", "back"])
      .gte("at", since).is("trello_action_id", null).order("at", { ascending: false }).limit(1);
    if (mine && mine.length) {
      await db.from("card_moves").update({ trello_action_id: id }).eq("id", mine[0].id);
      return new Response("button move", { status: 200 });
    }

    await db.from("card_moves").insert({
      card_id: cardId, board_id: boardId, from_list: fromName ?? null, to_list: toName,
      why: null, needs_reason: isEnd(toName), source: "drag",
      by_member_id: action.idMemberCreator ?? null, by_member_name: action.memberCreator?.fullName ?? null,
      trello_action_id: id, at: action.date,
    });
    return new Response("recorded", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 200 }); // never make Trello retry forever
  }
});
