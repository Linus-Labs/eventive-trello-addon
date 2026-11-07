// Project Details add-on: the one server function the add-on talks to.
//
// The lock: every call except "config" carries the member's own Trello token.
// Before any read or write this function asks Trello who the token belongs to,
// which board the card is on, and whether that person is a member of the
// board. The board must also be on the ALLOWED_BOARDS list. Only then does it
// touch the database (service role, server side only).
//
// Secrets (set in Supabase, never in the repo):
//   TRELLO_APP_KEY   the Power-Up's API key (public identifier, served by "config")
//   ALLOWED_BOARDS   comma list of Trello board ids the add-on may serve
//   ALLOWED_ORIGIN   the GitHub Pages origin, for the browser CORS check
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  provided by Supabase

import { createClient } from "npm:@supabase/supabase-js@2";

const APP_KEY = Deno.env.get("TRELLO_APP_KEY") ?? "";
const ALLOWED_BOARDS = (Deno.env.get("ALLOWED_BOARDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "https://linus-labs.github.io";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const END_LISTS = ["LOST", "KIV"];

// Columns the add-on may write, and how each is checked.
type Kind = "text" | "num" | "bool" | "qualified" | "priority" | "chaselog" | "time";
const COLUMNS: Record<string, Kind> = {
  qualified: "qualified",
  why_not_qualified: "text",
  priority: "priority",
  chase_stage: "text",
  chase_since: "time",
  chase_log: "chaselog",
  event_type: "text",
  event_date: "text",
  initial_budget: "text",
  initial_pax: "text",
  expected_close: "text",
  probability: "num",
  projected_revenue: "num",
  cogs: "num",
  deposit: "bool",
  first_name: "text",
  last_name: "text",
  email: "text",
  mobile: "text",
  company_name: "text",
  job_role: "text",
  notes_on_customer: "text",
  lead_source: "text",
  initial_enquiry: "text",
  lead_cycle_contacted: "text",
  lead_cycle_proposed: "text",
};

class Fail extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

// ---------- Trello calls on the member's own token ----------
async function trello(token: string, method: string, path: string, query: Record<string, string> = {}) {
  if (!APP_KEY) throw new Fail(503, "The add-on is not set up yet (no Trello app key).");
  const url = new URL("https://api.trello.com/1" + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `OAuth oauth_consumer_key="${APP_KEY}", oauth_token="${token}"`, Accept: "application/json" },
  });
  const text = await res.text();
  if (res.status === 401) throw new Fail(401, "Trello did not accept the sign-in. Sign in again.");
  if (!res.ok) throw new Fail(res.status === 404 ? 404 : 502, `Trello said ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- The lock ----------
type Who = { id: string; fullName: string };
const memberCache = new Map<string, { at: number; who: Who }>();
const boardCache = new Map<string, number>(); // `${memberId}:${boardId}` -> time checked

async function hash(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function whoIs(token: string): Promise<Who> {
  if (!token || typeof token !== "string" || token.length > 400) throw new Fail(401, "Not signed in to Trello.");
  const key = await hash(token);
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.who;
  const me = await trello(token, "GET", "/members/me", { fields: "id,fullName" });
  const who = { id: me.id, fullName: me.fullName };
  memberCache.set(key, { at: Date.now(), who });
  return who;
}

async function checkBoard(token: string, who: Who, boardId: string) {
  if (!ALLOWED_BOARDS.includes(boardId)) throw new Fail(403, "The add-on is not switched on for this board.");
  const key = `${who.id}:${boardId}`;
  const t = boardCache.get(key);
  if (t && Date.now() - t < 60_000) return;
  const members = await trello(token, "GET", `/boards/${boardId}/members`, { fields: "id" });
  if (!Array.isArray(members) || !members.some((m: { id: string }) => m.id === who.id)) {
    throw new Fail(403, "Only members of this board can see Project Details.");
  }
  boardCache.set(key, Date.now());
}

async function lockCard(token: string, cardId: string) {
  if (!/^[0-9a-f]{24}$/i.test(cardId ?? "")) throw new Fail(400, "Bad card id.");
  const who = await whoIs(token);
  const card = await trello(token, "GET", `/cards/${cardId}`, { fields: "id,name,idBoard,idList", list: "true", list_fields: "name" });
  await checkBoard(token, who, card.idBoard);
  return { who, card };
}

// ---------- Checking what the browser sends ----------
function clean(patch: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    const kind = COLUMNS[k];
    if (!kind) throw new Fail(400, `Unknown box: ${k}`);
    if (v === null || v === "") {
      out[k] = kind === "bool" ? false : kind === "chaselog" ? [] : null;
      continue;
    }
    switch (kind) {
      case "text":
        if (typeof v !== "string" || v.length > 20000) throw new Fail(400, `Bad value for ${k}`);
        out[k] = v;
        break;
      case "num": {
        const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
        if (!isFinite(n)) throw new Fail(400, `Bad number for ${k}`);
        out[k] = n;
        break;
      }
      case "bool":
        out[k] = v === true;
        break;
      case "qualified":
        if (v !== "yes" && v !== "no") throw new Fail(400, "Bad value for qualified");
        out[k] = v;
        break;
      case "priority":
        if (!["DEFCON 1", "DEFCON 2", "DEFCON 3"].includes(String(v))) throw new Fail(400, "Bad priority");
        out[k] = v;
        break;
      case "time":
        if (isNaN(Date.parse(String(v)))) throw new Fail(400, `Bad time for ${k}`);
        out[k] = new Date(String(v)).toISOString();
        break;
      case "chaselog":
        if (!Array.isArray(v) || v.length > 30) throw new Fail(400, "Bad chase log");
        out[k] = v.map((e) => {
          const at = (e as { at?: string })?.at, by = (e as { by?: string })?.by;
          if (!at || isNaN(Date.parse(at))) throw new Fail(400, "Bad chase log time");
          return { at: new Date(at).toISOString(), by: typeof by === "string" ? by.slice(0, 100) : "" };
        });
        break;
    }
  }
  return out;
}

function cleanWhy(why: unknown) {
  const s = typeof why === "string" ? why.trim() : "";
  if (!s) throw new Fail(400, "Type a reason first, or pick No reason given.");
  return s.slice(0, 2000);
}

async function recentMoves(cardId: string) {
  const { data, error } = await db.from("card_moves").select("*").eq("card_id", cardId).order("at", { ascending: false }).limit(10);
  if (error) throw new Fail(500, error.message);
  return data;
}

// ---------- Actions ----------
async function load(token: string, cardId: string) {
  const { who, card } = await lockCard(token, cardId);
  const { data, error } = await db.from("cards").select("*").eq("card_id", cardId).maybeSingle();
  if (error) throw new Fail(500, error.message);
  return { member: who, card: { id: card.id, name: card.name, idBoard: card.idBoard, idList: card.idList, listName: card.list?.name ?? "" }, data, moves: await recentMoves(cardId) };
}

async function save(token: string, cardId: string, patch: Record<string, unknown>) {
  const { who, card } = await lockCard(token, cardId);
  const row = { ...clean(patch), card_id: cardId, board_id: card.idBoard, last_update_by: who.fullName, last_update_by_id: who.id };
  const { data, error } = await db.from("cards").upsert(row, { onConflict: "card_id" }).select("*").single();
  if (error) throw new Fail(500, error.message);
  return { data };
}

async function boardLists(token: string, boardId: string) {
  const lists = await trello(token, "GET", `/boards/${boardId}/lists`, { fields: "id,name", filter: "open" });
  return lists as { id: string; name: string }[];
}

async function move(token: string, cardId: string, to: string, why: unknown) {
  const { who, card } = await lockCard(token, cardId);
  const fromName: string = card.list?.name ?? "";
  const lists = await boardLists(token, card.idBoard);
  let target: { id: string; name: string } | undefined;
  let reason: string;
  let source: "button" | "back";
  if (to === "BACK") {
    const last = (await recentMoves(cardId)).find((m) => m.source !== "back" ? m.to_list === fromName : false);
    if (!last?.from_list) throw new Fail(400, "There is no earlier list to move back to.");
    target = lists.find((l) => l.name === last.from_list);
    reason = "Moved back";
    source = "back";
  } else {
    if (!END_LISTS.includes(to)) throw new Fail(400, "Cards can only be moved to LOST or KIV here.");
    target = lists.find((l) => l.name.trim().toUpperCase() === to);
    reason = cleanWhy(why);
    source = "button";
  }
  if (!target) throw new Fail(400, `This board has no list called ${to === "BACK" ? "that" : to}.`);
  if (target.id === card.idList) throw new Fail(400, `The card is already in ${target.name}.`);

  // Save the reason first, so the drag catcher knows this move came from the button.
  const { data: moveRow, error } = await db.from("card_moves").insert({
    card_id: cardId, board_id: card.idBoard, from_list: fromName, to_list: target.name,
    why: reason, source, by_member_id: who.id, by_member_name: who.fullName,
  }).select("*").single();
  if (error) throw new Fail(500, error.message);

  try {
    await trello(token, "PUT", `/cards/${cardId}`, { idList: target.id, pos: "top" });
  } catch (e) {
    await db.from("card_moves").delete().eq("id", moveRow.id);
    throw e;
  }
  let commented = false;
  if (source === "button") {
    try {
      await trello(token, "POST", `/cards/${cardId}/actions/comments`, { text: `Moved to ${target.name}. Why: ${reason}` });
      commented = true;
      await db.from("card_moves").update({ comment_posted: true }).eq("id", moveRow.id);
    } catch (_e) {
      commented = false;
    }
  }
  // Touch the card row so Last Update shows who moved it and when.
  await db.from("cards").upsert({ card_id: cardId, board_id: card.idBoard, last_update_by: who.fullName, last_update_by_id: who.id }, { onConflict: "card_id" });
  return { moved: { ...moveRow, comment_posted: commented }, listName: target.name, idList: target.id, moves: await recentMoves(cardId) };
}

// A card dragged into LOST / KIV by hand: add the reason afterwards.
async function giveReason(token: string, cardId: string, moveId: number, why: unknown) {
  const { who } = await lockCard(token, cardId);
  const reason = cleanWhy(why);
  const { data: row, error } = await db.from("card_moves").select("*").eq("id", moveId).eq("card_id", cardId).maybeSingle();
  if (error) throw new Fail(500, error.message);
  if (!row || !row.needs_reason) throw new Fail(400, "That move already has a reason.");
  let commented = false;
  try {
    await trello(token, "POST", `/cards/${cardId}/actions/comments`, { text: `Moved to ${row.to_list}. Why: ${reason}` });
    commented = true;
  } catch (_e) { /* reason still saved */ }
  const { error: e2 } = await db.from("card_moves").update({
    why: reason, needs_reason: false, reason_at: new Date().toISOString(), reason_by: who.fullName, comment_posted: commented,
  }).eq("id", moveId);
  if (e2) throw new Fail(500, e2.message);
  return { moves: await recentMoves(cardId) };
}

// Card front badges for a whole board in one call.
async function board(token: string, boardId: string) {
  if (!/^[0-9a-f]{24}$/i.test(boardId ?? "")) throw new Fail(400, "Bad board id.");
  const who = await whoIs(token);
  await checkBoard(token, who, boardId);
  const { data, error } = await db.from("cards")
    .select("card_id, priority, expected_close, probability, projected_revenue, chase_stage, chase_since, chase_log")
    .eq("board_id", boardId);
  if (error) throw new Fail(500, error.message);
  const { data: moves, error: e2 } = await db.from("card_moves")
    .select("card_id, to_list, needs_reason, at").eq("board_id", boardId).order("at", { ascending: false }).limit(2000);
  if (e2) throw new Fail(500, e2.message);
  const lastMove: Record<string, unknown> = {};
  for (const m of moves ?? []) if (!lastMove[m.card_id]) lastMove[m.card_id] = m;
  return { cards: data, lastMove };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  try {
    const body = await req.json().catch(() => ({}));
    const { action, token, cardId } = body ?? {};
    let out: unknown;
    switch (action) {
      case "config": out = { appKey: APP_KEY || null }; break;
      case "load": out = await load(token, cardId); break;
      case "save": out = await save(token, cardId, body.patch); break;
      case "move": out = await move(token, cardId, String(body.to ?? ""), body.why); break;
      case "reason": out = await giveReason(token, cardId, Number(body.moveId), body.why); break;
      case "board": out = await board(token, body.boardId); break;
      default: throw new Fail(400, "Unknown action.");
    }
    return new Response(JSON.stringify(out), { status: 200, headers });
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    const message = e instanceof Fail ? e.message : "Something went wrong on the server.";
    if (!(e instanceof Fail)) console.error(e);
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
