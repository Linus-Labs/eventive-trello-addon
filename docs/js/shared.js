/* Project Details add-on: pieces shared by the card back and the card front.
   No keys here. The Trello app key is fetched from the server at start. */
(function (w) {
  "use strict";
  const API_URL = "https://lrixbkfrbsjdiknahssa.supabase.co/functions/v1/api";
  const APP_NAME = "Eventive Project Details";

  // Choice lists copied from the Amazing Fields board set-up, 7 Nov 2026 (text exactly as on the board).
  const CHOICES = {
    priority: [
      { t: "DEFCON 1", c: "chip-red", badge: "red" },
      { t: "DEFCON 2", c: "chip-amber", badge: "yellow" },
      { t: "DEFCON 3", c: "chip-grey", badge: "light-gray" }
    ],
    source: ["Email", "WhatsApp", "Call", "Tender", "Return", "Personal"],
    cycleA: [
      "1.a | No Res | TP1 | 8 | W/C/E", "1.b | No Res | TP2 | 8 | W/E", "1.c | No Res | TP3 | 8 | C/W", "1.d | No Res | Drop",
      "2.a | No Join Meet | TP1 | 5min | C/W/E", "2.b | No Join Meet | TP2 | 4 | W/E", "2.c | No Join Meet | TP3 | 12 | W/E",
      "2.d | No Join Meet | TP4 | 16H| C/W", "2.e | No Join Meet | TP4 | Drop",
      "3.a | Poor/No Res to Qn | TP1 | 8 | C/W", "3.b | Poor/No Res to Qn | TP2 | 16 | W/E",
      "3.c | Poor/No Res to Question | TP3 | 8 | C/W", "3.d | Poor/No Res to Question | Drop",
      "4.a | Change Scope | TP1 | 8 | W/E", "4.b  | Change Scope | TP2 | 24 | W/E", "4.c | Change Scope | TP3 | 12 | C/W", "4.d | Change Scope | Drop"
    ],
    cycleB: [
      "5.a | No Res to Propose | TP1 | 8 | W/E", "5.b | No Res to Propose | TP2 | 12 | C/W", "5.c | No Res to Propose | TP3 | 24 | W/E",
      "5.d | No Res to Propose | TP4 | 12 | W/E", "5.e | No Res to Propose | TP5 | 12 | C/W", "5.e | No Res to Propose | Drop",
      "6.a | More Requirement | TP1 | 8 | W/E", "6.b | More Requirement | TP2 | 24 | W/E", "6.c | More Requirement | TP3 | 8 | W/E",
      "6.d | More Requirement | TP4 | 12 | C/W", "6.e | More Requirement | TP5 | 24 | W/E", "6.f | More Requirement | TP6 | 12 | W/E",
      "6.g | More Requirement | TP7 | 12 | W/E", "6.g | More Requirement | Drop",
      "7.a | Change Scope | TP1 | 8 | C/W", "7.b | Change Scope | TP2 | 24 | W/E", "7.c | Change Scope | TP3 | 8 | W/E",
      "7.d | Change Scope | TP4 | 12 | C/W", "7.e | Change Scope | TP5 | 24 | W/E", "7.f | Change Scope | TP6 | 12 | W/E",
      "7.g | Change Scope | TP7 | 12 | W/E", "7.h | Change Scope | Drop",
      "8.a | Review with Stake | TP1 | 8 | W/E", "8.b | Review with Stake | TP2 | 12 | C/W", "8.c | Review with Stake | TP3 | 24 | W/E",
      "8.d | Review with Stake | TP4 | 12 | W/E", "8.e | Review with Stake | TP5 | 12 | W/E", "8.f | Review with Stake | TP6 | 24 | C/W",
      "8.g | Review with Stake | Drop"
    ],
    stage: [
      "1. No reply", "2. Did not join the meeting", "3. Poor or no reply to questions", "4. Changed scope",
      "5. No reply to proposal", "6. Asked for more", "7. Changed scope after proposal", "8. Reviewing with stakeholders"
    ]
  };
  const STAGE_SHORT = ["No reply", "No-show", "Poor reply", "Scope", "Proposal", "More asks", "Scope", "Stakeholders"];
  const END_LISTS = ["LOST", "KIV"];
  const DAY = 86400000;

  // Steps per stage are read from the Lead Cycle lists: "5.b | No Res to Propose | TP2 | 12 | C/W".
  const CH = { W: "WhatsApp", C: "Call", E: "Email" };
  function stepsFor(n) {
    const list = n <= 4 ? CHOICES.cycleA : CHOICES.cycleB;
    return list.filter(t => t.trim().startsWith(n + ".")).map(t => {
      const p = t.split("|").map(x => x.trim()).filter(Boolean);
      if (/drop/i.test(p[p.length - 1])) return { text: t, drop: true };
      const h = p[3], hours = /min/i.test(h) ? parseFloat(h) / 60 : parseFloat(h);
      return { text: t, drop: false, hours: hours, wait: h, how: (p[4] || "").split("/").map(c => CH[c]).filter(Boolean).join(" or ") };
    });
  }
  const stageNo = stage => stage ? parseInt(stage, 10) || 0 : 0;

  // When is the next chase due? log = [{at, by}], since = when the stage was picked.
  function nextDue(stage, log, since) {
    const n = stageNo(stage); if (!n) return null;
    const steps = stepsFor(n), nxt = steps[log.length];
    if (!nxt || nxt.drop) return null;
    const base = log.length ? new Date(log[log.length - 1].at) : (since ? new Date(since) : null);
    if (!base) return null;
    return { at: new Date(base.getTime() + nxt.hours * 3600000), step: nxt };
  }
  function lastActivity(stage, log, since) {
    if (!stageNo(stage)) return null;
    if (log.length) return new Date(log[log.length - 1].at);
    return since ? new Date(since) : null;
  }
  // Card front chase text, as on mockup-v3. Returns {text, late, dropped} or null.
  function chaseSummary(stage, log, since, now) {
    const n = stageNo(stage); if (!n) return null;
    const steps = stepsFor(n), done = log.length, tps = steps.filter(x => !x.drop).length;
    if (done > tps) return { text: "Dropped", late: true, dropped: true };
    const due = nextDue(stage, log, since), late = !!(due && now > due.at);
    return { text: STAGE_SHORT[n - 1] + (done ? " · chased " + done : " · not chased") + (late ? " · due" : ""), late: late, dropped: false };
  }
  // 60 days with no reply: ask, never move. Not for cards already in LOST, KIV or CLOSED.
  function isQuiet(stage, log, since, listName, now) {
    const last = lastActivity(stage, log, since);
    const ended = END_LISTS.concat(["CLOSED"]).includes(String(listName || "").trim().toUpperCase());
    return !!(last && !ended && (now - last) >= 60 * DAY) ? last : null;
  }

  // Value colours as Amazing Fields has them today (Probability by stage; Margin by band).
  function probColour(p) {
    if (p === null || p === undefined || isNaN(p)) return "";
    if (p <= 10) return "red"; if (p <= 30) return "orange"; if (p <= 50) return "sky";
    if (p <= 70) return "blue"; return "lime";
  }
  function marginColour(m) {
    if (m <= 10) return "red"; if (m <= 15) return "orange"; if (m <= 20) return "sky";
    if (m <= 25) return "blue"; if (m >= 30) return "lime"; return "";
  }
  const sgd = n => "SGD " + Math.round(n).toLocaleString("en-SG");

  // ---------- Server ----------
  async function api(action, payload) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const err = new Error((body && body.error) || ("The server said " + res.status));
      err.status = res.status;
      throw err;
    }
    return body;
  }
  let configPromise = null;
  function getConfig() {
    if (!configPromise) configPromise = api("config").catch(() => ({ appKey: null }));
    return configPromise;
  }

  // The member's Trello token. Trello's helper keeps it in browser storage,
  // which recent Chrome can wall off; a copy sits in the member's own private
  // add-on data on Trello as a fallback (only that member can read it).
  async function getToken(t) {
    let tok = null;
    try { tok = await t.getRestApi().getToken(); } catch (e) { tok = null; }
    if (!tok) { try { tok = await t.get("member", "private", "tk"); } catch (e) { tok = null; } }
    return tok || null;
  }
  async function signIn(t) {
    const tok = await t.getRestApi().authorize({ scope: "read,write", expiration: "never" });
    try { await t.set("member", "private", "tk", tok); } catch (e) { /* helper copy still works */ }
    return tok;
  }
  async function signOut(t) {
    try { await t.getRestApi().clearToken(); } catch (e) { /* ignore */ }
    try { await t.remove("member", "private", "tk"); } catch (e) { /* ignore */ }
  }

  w.PD = {
    API_URL, APP_NAME, CHOICES, STAGE_SHORT, END_LISTS, DAY,
    stepsFor, stageNo, nextDue, lastActivity, chaseSummary, isQuiet,
    probColour, marginColour, sgd, api, getConfig, getToken, signIn, signOut
  };
})(window);
