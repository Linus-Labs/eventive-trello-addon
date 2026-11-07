/* Project Details: the section on the back of each card. Behaviour follows
   mockup-v3.html; every change is saved to Supabase through the lock. */
(function () {
  "use strict";
  const PD = window.PD;
  const CHOICES = PD.CHOICES;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const isEnd = name => PD.END_LISTS.includes(String(name || "").trim().toUpperCase());

  let t = null, token = null, cardId = null;
  let member = { id: "", fullName: "" };
  let card = { listName: "" };
  let moves = [];
  let state = {};
  const paints = {};

  // ---------- Status line ----------
  function status(text, bad, retry) {
    const el = $("#status");
    el.className = "bar-status" + (bad ? " bar-status-bad" : "");
    el.textContent = text || "";
    if (retry) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "bar-retry"; b.textContent = "Try again";
      b.addEventListener("click", retry);
      el.appendChild(b);
    }
  }

  // ---------- Size the frame inside Trello ----------
  function resize() { if (t) t.sizeTo("#app").catch(() => {}); }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.getElementById("app"));
  // An open menu near the bottom needs room below it inside the frame.
  function makeRoom(menu) {
    const app = $("#app");
    app.style.paddingBottom = "";
    if (!menu) { resize(); return; }
    const need = menu.getBoundingClientRect().bottom - app.getBoundingClientRect().bottom + 12;
    if (need > 0) app.style.paddingBottom = need + "px";
    resize();
  }

  // ---------- Saving ----------
  let pending = {}, timer = null, inFlight = null;
  function queue(field, value, now) {
    pending[field] = value;
    clearTimeout(timer);
    timer = setTimeout(flush, now ? 0 : 700);
  }
  async function flush() {
    clearTimeout(timer);
    if (inFlight) { await inFlight.catch(() => {}); }
    const patch = pending; pending = {};
    if (!Object.keys(patch).length) return;
    status("Saving...");
    inFlight = PD.api("save", { token: token, cardId: cardId, patch: patch });
    try {
      const res = await inFlight;
      if (res && res.data) {
        state.last_update_at = res.data.last_update_at;
        state.last_update_by = res.data.last_update_by;
        state.margin = res.data.margin;
      }
      paintStamp();
      status("");
    } catch (e) {
      pending = Object.assign(patch, pending); // keep what did not save
      if (e.status === 401) return needSignIn();
      status("Not saved: " + e.message, true, flush);
    } finally {
      inFlight = null;
    }
  }
  window.addEventListener("beforeunload", () => { if (Object.keys(pending).length) flush(); });

  // ---------- Dropdowns ----------
  function renderValue(kind, v) {
    if (!v) return '<span class="dd-placeholder">' + (kind === "stage" ? "What are you waiting on?" : "Select...") + "</span>";
    if (kind === "priority") {
      const o = CHOICES.priority.find(x => x.t === v);
      return '<span class="chip ' + (o ? o.c : "") + '">' + esc(v) + "</span>";
    }
    return '<span class="dd-value">' + esc(v) + "</span>";
  }
  function buildDropdown(el) {
    const kind = el.dataset.kind, field = el.dataset.field;
    let menu = '<button type="button" class="dd-opt dd-clear" data-v="">Clear</button>';
    CHOICES[kind].forEach(o => {
      const txt = typeof o === "string" ? o : o.t;
      const inner = kind === "priority" ? '<span class="chip ' + o.c + '">' + esc(txt) + "</span>" : esc(txt);
      menu += '<button type="button" class="dd-opt" data-v="' + esc(txt) + '">' + inner + "</button>";
    });
    el.innerHTML = '<button type="button" class="dd-btn" aria-haspopup="listbox"></button><div class="dd-menu" role="listbox">' + menu + "</div>";
    const btn = $(".dd-btn", el);
    const paint = () => {
      btn.innerHTML = renderValue(kind, state[field]) + '<span class="dd-caret">&#8964;</span>';
      $$(".dd-opt", el).forEach(b => b.classList.toggle("dd-opt-on", !!state[field] && b.dataset.v === state[field]));
    };
    paints[field] = paint;
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const open = el.classList.contains("dd-open");
      closeAll();
      if (!open) { el.classList.add("dd-open"); makeRoom($(".dd-menu", el)); }
    });
    $$(".dd-opt", el).forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      el.classList.remove("dd-open"); makeRoom(null);
      if (field === "chase_stage") return pickStage(b.dataset.v);
      state[field] = b.dataset.v || null;
      paint(); queue(field, state[field], true); changed();
    }));
  }
  function closeAll() { $$(".dd-open").forEach(d => d.classList.remove("dd-open")); makeRoom(null); }
  document.addEventListener("click", () => { closeAll(); closePop(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeAll(); closePop(); } });
  $$(".dd").forEach(buildDropdown);

  // ---------- Tabs ----------
  $$(".tab").forEach(tb => tb.addEventListener("click", () => {
    $$(".tab").forEach(x => { x.classList.toggle("tab-on", x === tb); x.setAttribute("aria-selected", x === tb); });
    $$(".panel").forEach(p => p.classList.toggle("panel-on", p.dataset.panel === tb.dataset.tab));
    resize();
  }));

  // ---------- Helpers ----------
  const numOf = v => { const s = String(v === null || v === undefined ? "" : v).replace(/[^0-9.\-]/g, ""); return s === "" ? NaN : parseFloat(s); };
  const fieldNum = f => { const el = $('[data-field="' + f + '"]'); return el ? numOf(el.value) : NaN; };
  const fmt = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const fmtFull = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const money = n => Math.round(n).toLocaleString("en-SG");

  // ---------- Margin (Auto) ----------
  function paintMargin() {
    const r = fieldNum("projected_revenue"), c = fieldNum("cogs"), box = $("#margin");
    if (isNaN(r) || isNaN(c) || r === 0) {
      box.innerHTML = '<span class="readonly-muted">Fills in from Projected Revenue and C.O.G.S.</span>';
      return;
    }
    const m = ((r - c) / r) * 100, col = PD.marginColour(m);
    box.innerHTML = '<span class="' + (col ? "val-" + col : "") + '">' + m.toFixed(1) + "%</span>";
  }
  // Required boxes left empty show a soft red, as Amazing Fields flags them today.
  function paintEmpty() { $$(".req-box").forEach(el => el.classList.toggle("is-empty-req", el.value.trim() === "")); }
  function paintProb() {
    const el = $('[data-field="probability"]'), col = PD.probColour(fieldNum("probability"));
    ["val-red", "val-orange", "val-sky", "val-blue", "val-lime"].forEach(c => el.classList.remove(c));
    if (col) el.classList.add("val-" + col);
  }
  function paintStamp() {
    const el = $("#stamp");
    if (!state.last_update_at) { el.innerHTML = '<span class="readonly-muted">Not changed yet</span>'; return; }
    el.textContent = fmtFull(new Date(state.last_update_at)) + (state.last_update_by ? ", by " + state.last_update_by : "");
  }

  // ---------- Qualified lead ----------
  function paintQualified() {
    const q = state.qualified || "";
    $$(".seg-btn").forEach(b => {
      b.classList.toggle("seg-yes-on", b.dataset.q === "yes" && q === "yes");
      b.classList.toggle("seg-no-on", b.dataset.q === "no" && q === "no");
      b.setAttribute("aria-pressed", b.dataset.q === q);
    });
    $("#whyBox").classList.toggle("why-on", q === "no");
  }
  $$(".seg-btn").forEach(b => b.addEventListener("click", () => {
    state.qualified = state.qualified === b.dataset.q ? null : b.dataset.q;
    paintQualified(); queue("qualified", state.qualified, true); changed();
    if (state.qualified === "no") $('[data-field="why_not_qualified"]').focus();
  }));

  // ---------- Chase ----------
  const chaseLog = () => Array.isArray(state.chase_log) ? state.chase_log : [];
  const waitText = h => /min/i.test(h) ? parseFloat(h) + " min" : parseFloat(h) + " hrs";
  function setCycle() {
    const n = PD.stageNo(state.chase_stage), done = chaseLog().length;
    state.lead_cycle_contacted = null; state.lead_cycle_proposed = null;
    if (n && done) state[n <= 4 ? "lead_cycle_contacted" : "lead_cycle_proposed"] = PD.stepsFor(n)[done - 1].text;
    paints.lead_cycle_contacted(); paints.lead_cycle_proposed();
    queue("lead_cycle_contacted", state.lead_cycle_contacted);
    queue("lead_cycle_proposed", state.lead_cycle_proposed);
    queue("chase_log", chaseLog());
  }
  function pickStage(v) {
    if ((v || "") === (state.chase_stage || "")) return;
    state.chase_stage = v || null;
    state.chase_log = [];
    state.chase_since = v ? new Date().toISOString() : null;
    paints.chase_stage();
    queue("chase_stage", state.chase_stage);
    queue("chase_since", state.chase_since);
    setCycle();
    queue("chase_log", [], true);
    changed();
  }
  function paintChase() {
    const btn = $("#chaseBtn"), n = PD.stageNo(state.chase_stage), log = chaseLog();
    btn.classList.remove("chase-btn-drop");
    $("#chaseUndo").style.display = log.length ? "" : "none";
    $(".chase-row").style.display = n ? "" : "none";
    if (!n) {
      btn.disabled = true; btn.textContent = "+1 chase";
      $("#chaseCount").textContent = "";
      $("#chaseMeta").textContent = "Pick what you are waiting on first.";
      return;
    }
    const steps = PD.stepsFor(n), done = log.length, tps = steps.filter(x => !x.drop).length;
    const lastBy = done ? (log[done - 1].by || "") : "";
    if (done > tps) {
      btn.disabled = true; btn.textContent = "Dropped";
      $("#chaseCount").textContent = "Chased " + tps + " times, then dropped";
      $("#chaseMeta").textContent = "Dropped " + fmt(new Date(log[done - 1].at)) + (lastBy ? " by " + lastBy : "") + ".";
      return;
    }
    btn.disabled = false;
    if (done === tps) { btn.textContent = "Drop lead"; btn.classList.add("chase-btn-drop"); }
    else btn.textContent = "+1 chase";
    $("#chaseCount").textContent = done ? "Chased " + done + " of " + tps : "Not chased yet";
    const due = PD.nextDue(state.chase_stage, log, state.chase_since);
    const since = state.chase_since ? new Date(state.chase_since) : new Date();
    let html = done ? "Last chase " + esc(fmt(new Date(log[done - 1].at))) + (lastBy ? " by " + esc(lastBy) : "") + "."
                    : "Waiting since " + esc(fmt(since)) + " (" + waitText(steps[0].wait) + " before the first chase).";
    if (due) {
      const late = new Date() > due.at;
      html += ' <span class="' + (late ? "chase-late" : "stamp") + '">Next: chase ' + (done + 1) + " by " + esc(due.step.how) +
        (late ? ", overdue since " : ", due ") + esc(fmt(due.at)) + ".</span>";
    } else html += " No reply after the last chase: drop the lead when you are ready.";
    $("#chaseMeta").innerHTML = html;
  }
  let dropPending = false;
  $("#chaseBtn").addEventListener("click", e => {
    e.stopPropagation();
    if ($("#chaseBtn").classList.contains("chase-btn-drop")) {
      openPop("LOST", "No reply after " + chaseLog().length + " chases"); dropPending = true; return;
    }
    state.chase_log = chaseLog().concat([{ at: new Date().toISOString(), by: member.fullName }]);
    setCycle(); flush(); changed();
  });
  $("#chaseUndo").addEventListener("click", () => {
    state.chase_log = chaseLog().slice(0, -1);
    setCycle(); flush(); changed();
  });

  // ---------- How the lead ended: Move to LOST / KIV ----------
  let popFor = "", popMode = "move", reasonFor = null;
  function openPop(to, prefill, mode, moveId) {
    popFor = to; popMode = mode || "move"; reasonFor = moveId || null;
    $("#endTitle").textContent = popMode === "reason" ? "Why is it in " + to + "?" : "Move to " + to;
    $("#endAsk").textContent = to === "LOST" ? "Why was it lost?" : "Why is it on hold?";
    $("#endWhy").placeholder = to === "LOST" ? "Price, our service, no reply..." : "Event moved to next year, waiting on budget...";
    $("#endGo").textContent = popMode === "reason" ? "Save the reason" : "Move";
    $("#endWhy").value = prefill || "";
    $("#endWhy").classList.remove("end-need"); $("#endHint").classList.remove("end-hint-on");
    $("#endPop").classList.add("end-pop-on");
    window.scrollTo(0, 0);
    makeRoom($("#endPop"));
    $("#endWhy").focus();
  }
  function closePop() {
    if (!$("#endPop").classList.contains("end-pop-on")) return;
    $("#endPop").classList.remove("end-pop-on"); dropPending = false; makeRoom(null);
  }
  function paintEnding() {
    const note = $("#endNote"), last = moves[0];
    const show = !!(last && isEnd(card.listName) && last.to_list === card.listName);
    note.classList.toggle("end-note-on", show);
    note.classList.toggle("end-note-kiv", show && last.to_list.toUpperCase() === "KIV");
    if (!show) { note.innerHTML = ""; return; }
    const when = esc(fmt(new Date(last.at))), who = last.by_member_name ? " by " + esc(last.by_member_name) : "";
    if (last.needs_reason) {
      note.innerHTML = "Moved to " + esc(last.to_list) + " on " + when + who + " (dragged by hand). No reason yet." +
        '<button type="button" class="end-undo" id="endReason">Add the reason</button>';
      $("#endReason").addEventListener("click", e => { e.stopPropagation(); openPop(last.to_list.toUpperCase(), "", "reason", last.id); });
      return;
    }
    note.innerHTML = "Moved to " + esc(last.to_list) + " on " + when + who + ". Why: " + esc(last.why || "") + "." +
      (last.comment_posted ? " Also posted as a comment on the card." : "") +
      (last.from_list ? '<button type="button" class="end-undo" id="endUndo">Move back</button>' : "");
    const undo = $("#endUndo");
    if (undo) undo.addEventListener("click", e => { e.stopPropagation(); doMove("BACK", ""); });
  }
  async function doMove(to, why) {
    $$(".end-btn, #endGo").forEach(b => b.disabled = true);
    status(to === "BACK" ? "Moving back..." : "Moving to " + to + "...");
    try {
      await flush();
      const res = await PD.api("move", { token: token, cardId: cardId, to: to, why: why });
      card.listName = res.listName; card.idList = res.idList; moves = res.moves || [];
      if (res.data) { state.last_update_at = res.data.last_update_at; state.last_update_by = res.data.last_update_by; paintStamp(); }
      if (dropPending && to === "LOST") {
        state.chase_log = chaseLog().concat([{ at: new Date().toISOString(), by: member.fullName }]);
        setCycle(); await flush();
      }
      closePop();
      status("");
      paintEnding(); changed();
    } catch (e) {
      if (e.status === 401) return needSignIn();
      status("Not moved: " + e.message, true);
    } finally {
      $$(".end-btn, #endGo").forEach(b => b.disabled = false);
    }
  }
  async function doReason(why) {
    $("#endGo").disabled = true;
    status("Saving the reason...");
    try {
      const res = await PD.api("reason", { token: token, cardId: cardId, moveId: reasonFor, why: why });
      moves = res.moves || [];
      closePop(); status(""); paintEnding(); changed();
    } catch (e) {
      if (e.status === 401) return needSignIn();
      status("Reason not saved: " + e.message, true);
    } finally {
      $("#endGo").disabled = false;
    }
  }
  $$(".end-btn[data-to]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); dropPending = false; openPop(b.dataset.to); }));
  $("#endPop").addEventListener("click", e => e.stopPropagation());
  $("#endClose").addEventListener("click", closePop);
  $("#endQuick").addEventListener("click", () => { $("#endWhy").value = "No reason given"; $("#endWhy").focus(); });
  $("#endGo").addEventListener("click", () => {
    const why = $("#endWhy").value.trim();
    if (!why) { $("#endWhy").classList.add("end-need"); $("#endHint").classList.add("end-hint-on"); $("#endWhy").focus(); return; }
    if (popMode === "reason") doReason(why); else doMove(popFor, why);
  });

  // ---------- 60 days of silence: ask, never move ----------
  function paintSilence() {
    const box = $("#silence");
    const last = PD.isQuiet(state.chase_stage, chaseLog(), state.chase_since, card.listName, new Date());
    box.classList.toggle("silence-on", !!last);
    if (!last) { box.innerHTML = ""; return; }
    box.innerHTML = "<span>No reply for 60 days (since " + esc(fmt(last)) + "). Is this lead lost?</span>" +
      '<button type="button" class="end-btn" id="silLost">Move to LOST</button><button type="button" class="end-btn" id="silKiv">Move to KIV</button>';
    $("#silLost").addEventListener("click", e => { e.stopPropagation(); dropPending = false; openPop("LOST", "No reply for 60 days"); });
    $("#silKiv").addEventListener("click", e => { e.stopPropagation(); dropPending = false; openPop("KIV"); });
  }

  function changed() { paintChase(); paintMargin(); paintEmpty(); paintProb(); paintSilence(); resize(); }

  // ---------- Typing in a box ----------
  $$("input[data-field], textarea[data-field]").forEach(el => {
    const f = el.dataset.field;
    if (el.type === "checkbox") {
      el.addEventListener("change", () => { state[f] = el.checked; queue(f, el.checked, true); changed(); });
      return;
    }
    el.addEventListener("input", () => {
      const v = el.value;
      state[f] = el.dataset.num ? (isNaN(numOf(v)) ? null : numOf(v)) : (v === "" ? null : v);
      queue(f, state[f]); changed();
    });
    el.addEventListener("blur", () => { if (Object.keys(pending).length) flush(); });
  });
  $$(".money").forEach(el => el.addEventListener("blur", () => {
    const n = numOf(el.value);
    if (!isNaN(n)) el.value = money(n);
  }));

  // ---------- Fill the boxes from the saved row ----------
  function fillAll() {
    $$("input[data-field], textarea[data-field]").forEach(el => {
      const f = el.dataset.field, v = state[f];
      if (el.type === "checkbox") { el.checked = v === true; return; }
      if (v === null || v === undefined) { el.value = ""; return; }
      el.value = el.classList.contains("money") ? money(Number(v)) : String(v);
    });
    Object.keys(paints).forEach(k => paints[k]());
    paintQualified(); paintStamp(); paintEnding(); changed();
  }

  // ---------- Start ----------
  function needSignIn() {
    PD.signOut(t).catch(() => {});
    token = null;
    $("#frame").classList.add("hidden");
    $("#endBar").classList.add("hidden");
    $("#signin").classList.remove("hidden");
    status("");
    resize();
  }
  async function load() {
    status("Loading...");
    try {
      const res = await PD.api("load", { token: token, cardId: cardId });
      member = res.member; card = res.card; moves = res.moves || []; state = res.data || {};
      $("#signin").classList.add("hidden");
      $("#frame").classList.remove("hidden");
      $("#endBar").classList.remove("hidden");
      fillAll();
      status("");
    } catch (e) {
      if (e.status === 401) return needSignIn();
      $("#frame").classList.add("hidden");
      status(e.message, true, load);
    }
    resize();
  }
  $("#signinBtn").addEventListener("click", async () => {
    try {
      token = await PD.signIn(t);
      await load();
    } catch (e) {
      status("Sign-in did not finish. Try again.", true);
    }
  });

  function setTheme(theme) { document.documentElement.setAttribute("data-pd-theme", theme === "light" ? "light" : "dark"); }

  PD.getConfig().then(async cfg => {
    if (!cfg || !cfg.appKey) { status("The add-on is not set up yet (no Trello app key on the server).", true); return; }
    t = window.TrelloPowerUp.iframe({ appKey: cfg.appKey, appName: PD.APP_NAME });
    try {
      const ctx = t.getContext() || {};
      setTheme(ctx.initialTheme || ctx.theme);
      if (typeof t.subscribeToThemeChanges === "function") t.subscribeToThemeChanges(setTheme);
      cardId = ctx.card;
    } catch (e) { /* default dark */ }
    t.render(() => {});
    token = await PD.getToken(t);
    if (!token) return needSignIn();
    load();
  });
})();
