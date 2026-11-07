# Eventive Project Details (Trello add-on)

Our own Trello Power-Up for the Eventive Sales board. It replaces Amazing Fields with one
"Project Details" section on the back of each card and a few badges on the front.

- `docs/` is the add-on, served by GitHub Pages. `index.html` is the connector Trello loads;
  `section.html` is the Project Details section.
- `supabase/` holds the database tables and two server functions:
  - `api`: the lock. Every read and write carries the member's own Trello token; the function
    checks with Trello who the member is and that they belong to the card's board before it
    touches the database. The browser never gets a database key.
  - `trello-webhook`: notices a card dragged by hand into LOST or KIV, so the card can ask why.

No data, keys or tokens live in this repo. Server settings live in Supabase.
