/* Project Details add-on: the connector Trello loads once per board.
   Two jobs: the "Project Details" section on the back of each card, and the
   badges on the front. */
(function () {
  "use strict";
  const PD = window.PD;
  const ICON = new URL("./icon.svg", window.location.href).href;
  // Card front, in this order: flag, Priority, Expected Close, Probability, Projected Revenue, Chase, 60 days.
  const SLOTS = ["flag", "priority", "close", "prob", "rev", "chase", "quiet"];

  // One call per board fetches every card's badge values; kept for 15 seconds.
  const boardData = {};
  function getBoard(t, boardId) {
    const hit = boardData[boardId];
    if (hit && Date.now() - hit.at < 15000) return hit.promise;
    const promise = PD.getToken(t).then(token => {
      if (!token) return null;
      return PD.api("board", { token: token, boardId: boardId });
    }).catch(() => null);
    boardData[boardId] = { at: Date.now(), promise: promise };
    return promise;
  }

  async function badgesFor(t) {
    const [card, board, lists] = await Promise.all([t.card("id", "idList"), t.board("id"), t.lists("id", "name")]);
    const data = await getBoard(t, board.id);
    if (!data) return {};
    const row = (data.cards || []).find(c => c.card_id === card.id);
    const move = (data.lastMove || {})[card.id];
    const list = lists.find(l => l.id === card.idList);
    const listName = list ? list.name : "";
    const out = {};
    const now = new Date();

    // A card dragged by hand into LOST / KIV with no reason yet.
    if (move && move.needs_reason && move.to_list === listName) {
      out.flag = { text: listName + " · no reason yet", color: "red" };
    }
    if (!row) return out;
    if (row.priority) {
      const o = PD.CHOICES.priority.find(x => x.t === row.priority);
      out.priority = { text: row.priority, color: o ? o.badge : null };
    }
    if (row.expected_close) out.close = { text: "Close " + row.expected_close };
    if (row.probability !== null && row.probability !== undefined) {
      out.prob = { text: Number(row.probability) + "%", color: PD.probColour(Number(row.probability)) || null };
    }
    if (row.projected_revenue !== null && row.projected_revenue !== undefined) {
      out.rev = { text: PD.sgd(Number(row.projected_revenue)) };
    }
    const log = row.chase_log || [];
    const ch = PD.chaseSummary(row.chase_stage, log, row.chase_since, now);
    if (ch) out.chase = { text: ch.text, color: ch.late ? "red" : null };
    if (PD.isQuiet(row.chase_stage, log, row.chase_since, listName, now)) {
      out.quiet = { text: "No reply 60 days", color: "red" };
    }
    return out;
  }

  function start(appKey) {
    const caps = {
      "card-back-section": function (t) {
        return {
          title: "Project Details",
          icon: ICON,
          content: {
            type: "iframe",
            url: t.signUrl("./section.html", { appKey: appKey || "" }),
            height: 640
          }
        };
      },
      // Fixed slots, each refreshed every 30 seconds, so a change on the back
      // shows on the front. An empty slot shows nothing.
      "card-badges": function (t) {
        return SLOTS.map(slot => ({
          dynamic: function () {
            return badgesFor(t).then(all => {
              const b = all[slot];
              return b ? { text: b.text, color: b.color || null, refresh: 30 } : { text: "", refresh: 30 };
            }).catch(() => ({ text: "", refresh: 60 }));
          }
        }));
      }
    };
    const opts = appKey ? { appKey: appKey, appName: PD.APP_NAME } : {};
    window.TrelloPowerUp.initialize(caps, opts);
  }

  PD.getConfig().then(c => start(c && c.appKey), () => start(null));
})();
