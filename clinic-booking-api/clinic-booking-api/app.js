// app.js
// The whole API lives in this file. Read it top to bottom:
//   1. Setup            - load tools, connect to the database
//   2. Helpers          - small reusable functions
//   3. Open routes      - the web page and its config (no key needed)
//   4. The key check    - LEVEL 2: everything after this needs X-API-Key
//   5. The endpoints    - /reset, /slots, /bookings ...
//   6. Error handling   - what to reply when something goes wrong

// ───────────────────────────── 1. SETUP ─────────────────────────────

// "require" loads code other people wrote so we don't have to.
const express = require("express"); // express: listens for web requests
const { Pool } = require("pg"); //     pg: talks to a Postgres database
const crypto = require("crypto"); //   crypto: built into Node, makes ids and hashes
const path = require("path"); //       path: built into Node, builds folder paths

// Secrets are NOT written in the code. They come from "environment
// variables": settings stored on the computer/host running the app.
const API_KEY = (process.env.API_KEY || "").trim(); //           the password for our API
const DATABASE_URL = (process.env.DATABASE_URL || "").trim(); // the address of our database

// A "pool" is a small set of open connections to the database that
// requests borrow and hand back, like tills at a bank.
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

const app = express();

// Let other websites' pages call this API too (CORS). Our own page is on
// the same address so it doesn't need this, but a browser-based checker might.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Idempotency-Key");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Expose-Headers", "Retry-After");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Turn the JSON text people send us into a JavaScript object (req.body).
app.use(express.json());

// ──────────────────────────── 2. HELPERS ────────────────────────────

// Every error in the spec looks like {"error": "<message>"}.
function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

// Is this a real piece of text with something in it (not just spaces)?
function isFilledText(value) {
  return typeof value === "string" && value.trim() !== "";
}

// A simple email shape check: something@something.something, no spaces.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Turn a database row into the booking shape the spec asks for.
function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

// Run several database steps as ONE all-or-nothing unit (a "transaction").
// If anything fails halfway, ROLLBACK undoes every step.
async function inTransaction(work) {
  const client = await pool.connect(); // borrow a connection
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(); // always hand the connection back
  }
}

// ─────────────────────────── 3. OPEN ROUTES ─────────────────────────

// Serve the web page (public/index.html) at the home address.
// (On Vercel the public folder is served automatically; this line makes
// it work the same way on your own computer.)
app.use(express.static(path.join(__dirname, "public")));

// The web page needs the API key to call the API. Instead of typing the key
// into the page's code (which would put it on GitHub), the page loads this
// tiny script, which hands it the key from the environment variable.
app.get("/config.js", (req, res) => {
  res.type("application/javascript");
  res.send(`window.API_KEY = ${JSON.stringify(API_KEY || "")};`);
});

// Browsers always ask for a tab icon. We have none; say so quietly.
app.get("/favicon.ico", (req, res) => res.sendStatus(204));

// ───────────────────── 4. LEVEL 2: THE KEY CHECK ────────────────────

// This runs before every endpoint below it. No key or wrong key: 401, stop.
app.use((req, res, next) => {
  if (!API_KEY || req.get("X-API-Key") !== API_KEY) {
    return sendError(res, 401, "missing or invalid API key");
  }
  next(); // key is fine, carry on to the endpoint
});

// ─────────────────────────── 5. ENDPOINTS ───────────────────────────

// POST /reset (level 1)
// Wipe everything and load the slots that were sent. Koya's checker calls
// this to set up a clean, known starting point before each test.
app.post("/reset", async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) {
    return sendError(res, 400, "slots must be a list");
  }
  for (const slot of slots) {
    const ok =
      slot &&
      isFilledText(slot.id) &&
      typeof slot.provider === "string" &&
      typeof slot.start === "string" &&
      typeof slot.end === "string" &&
      !Number.isNaN(Date.parse(slot.start));
    if (!ok) {
      return sendError(res, 400, "each slot needs id, provider, start and end");
    }
  }

  await inTransaction(async (db) => {
    // TRUNCATE = empty these tables completely.
    await db.query(
      "TRUNCATE slots, bookings, idempotency_keys, booking_attempts RESTART IDENTITY"
    );
    for (const slot of slots) {
      // $1, $2... are placeholders. The values travel separately from the
      // SQL text, so nobody can sneak commands in through the data
      // (this prevents "SQL injection").
      await db.query(
        `INSERT INTO slots (id, provider, start_text, end_text, start_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           provider = EXCLUDED.provider, start_text = EXCLUDED.start_text,
           end_text = EXCLUDED.end_text, start_at = EXCLUDED.start_at`,
        [slot.id, slot.provider, slot.start, slot.end, new Date(slot.start)]
      );
    }
  });

  res.status(200).json({ ok: true, slots: slots.length });
});

// GET /slots (level 1)
// Every slot, earliest first, each marked available true/false.
// Optional: /slots?provider=Dr Ade shows only that provider.
app.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : null;

  // "available" is worked out live: a slot is free when there is NO
  // confirmed booking pointing at it.
  const result = await pool.query(
    `SELECT s.id, s.provider, s.start_text, s.end_text,
            NOT EXISTS (
              SELECT 1 FROM bookings b
              WHERE b.slot_id = s.id AND b.status = 'confirmed'
            ) AS available
     FROM slots s
     WHERE ($1::text IS NULL OR s.provider = $1)
     ORDER BY s.start_at ASC, s.id ASC`,
    [provider]
  );

  res.json({
    slots: result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      start: row.start_text,
      end: row.end_text,
      available: row.available,
    })),
  });
});

// POST /bookings (levels 1 to 5)
// The heart of the project. The steps happen in this order:
//   a. LEVEL 4  have we already answered this Idempotency-Key? repeat the answer
//   b. LEVEL 5  has this email tried too many times this minute? 429
//   c. LEVEL 2  are the details valid? does the slot exist and is it in the future?
//   d. LEVEL 3  try to save. The database rejects it if the slot is taken: 409
//   e. LEVEL 4  remember the answer for this Idempotency-Key
app.post("/bookings", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const idempotencyKey = req.get("Idempotency-Key") || null;

  // A "hash" is a fingerprint of the request details. Same details give the
  // same fingerprint, so we can tell if a retry really is the same request.
  const bodyHash = crypto
    .createHash("sha256")
    .update(JSON.stringify([body.slot_id, body.name, body.email]))
    .digest("hex");

  const outcome = await inTransaction(async (db) => {
    // ── a. LEVEL 4: idempotency ──
    if (idempotencyKey) {
      // Take a "lock" named after this key. If two copies of the same
      // request arrive together, the second waits here until the first is
      // completely finished, then finds the saved answer below.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [
        idempotencyKey,
      ]);
      const saved = await db.query(
        "SELECT body_hash, response_status, response_body FROM idempotency_keys WHERE key = $1",
        [idempotencyKey]
      );
      if (saved.rows.length > 0) {
        if (saved.rows[0].body_hash !== bodyHash) {
          return { status: 422, body: { error: "Idempotency-Key was already used with a different body" } };
        }
        // Same key, same details: repeat the original answer exactly.
        return { status: saved.rows[0].response_status, body: saved.rows[0].response_body };
      }
    }

    // From here on, "finish" means: remember the answer (if a key was sent)
    // and return it.
    const finish = async (status, responseBody) => {
      if (idempotencyKey) {
        await db.query(
          "INSERT INTO idempotency_keys (key, body_hash, response_status, response_body) VALUES ($1, $2, $3, $4)",
          [idempotencyKey, bodyHash, status, JSON.stringify(responseBody)]
        );
      }
      return { status, body: responseBody };
    };

    // LEVEL 2: tidy the details. Trim spaces; email in lower case.
    const slotId = typeof body.slot_id === "string" ? body.slot_id.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    // ── b. LEVEL 5: rate limit, 5 attempts per email per minute ──
    // Done BEFORE validation because failed attempts count too.
    if (email !== "") {
      // Lock on the email so simultaneous requests are counted one at a time.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [email]);
      const recent = await db.query(
        `SELECT COUNT(*)::int AS tries,
                CEIL(EXTRACT(EPOCH FROM (MIN(at) + INTERVAL '60 seconds' - now())))::int AS wait
         FROM booking_attempts
         WHERE email = $1 AND at > now() - INTERVAL '60 seconds'`,
        [email]
      );
      if (recent.rows[0].tries >= 5) {
        // "wait" = seconds until the oldest of those tries is a minute old.
        // A 429 is not saved against the Idempotency-Key, so the same
        // request can succeed when retried later.
        return {
          status: 429,
          retryAfter: Math.max(1, recent.rows[0].wait),
          body: { error: "too many booking attempts for this email, try again later" },
        };
      }
      await db.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
      // Housekeeping: forget this email's tries that are over a minute old.
      await db.query(
        "DELETE FROM booking_attempts WHERE email = $1 AND at <= now() - INTERVAL '60 seconds'",
        [email]
      );
    }

    // ── c. LEVEL 2: validation ──
    if (slotId === "") return finish(400, { error: "slot_id is required" });
    if (name === "") return finish(400, { error: "name is required" });
    if (email === "") return finish(400, { error: "email is required" });
    if (!isValidEmail(email)) return finish(400, { error: "email is not valid" });

    const slot = await db.query(
      "SELECT id, (start_at <= now()) AS started FROM slots WHERE id = $1",
      [slotId]
    );
    if (slot.rows.length === 0) return finish(404, { error: "slot not found" });
    if (slot.rows[0].started) return finish(400, { error: "slot has already started" });

    // ── d. LEVEL 3: save the booking ──
    // We do NOT check "is it free?" first and then save. Two requests could
    // both see "free" and both save. Instead we just try to save, and the
    // unique rule in schema.sql lets exactly one through.
    // "ON CONFLICT ... DO NOTHING" means: if the rule blocks us, save nothing
    // and return zero rows, instead of crashing.
    const inserted = await db.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING *`,
      [crypto.randomUUID(), slotId, name, email]
    );
    if (inserted.rows.length === 0) {
      return finish(409, { error: "slot already booked" });
    }

    // ── e. success ──
    return finish(201, toBooking(inserted.rows[0]));
  });

  if (outcome.retryAfter) res.set("Retry-After", String(outcome.retryAfter));
  res.status(outcome.status).json(outcome.body);
});

// GET /bookings?email=...&limit=...&cursor=... (level 4)
// One person's bookings, oldest first, a page at a time.
// The "cursor" is a bookmark: it says "the last booking you saw was number N",
// so the next page starts right after it.
app.get("/bookings", async (req, res) => {
  if (!isFilledText(req.query.email)) {
    return sendError(res, 400, "email is required");
  }
  const email = req.query.email.trim().toLowerCase(); // ignore upper/lower case

  // limit: how many per page. Whole number from 1 to 50, default 10.
  let limit = 10;
  if (req.query.limit !== undefined) {
    if (typeof req.query.limit !== "string" || !/^\d+$/.test(req.query.limit)) {
      return sendError(res, 400, "limit must be a whole number from 1 to 50");
    }
    limit = Number(req.query.limit);
    if (limit < 1 || limit > 50) {
      return sendError(res, 400, "limit must be a whole number from 1 to 50");
    }
  }

  // cursor: we hand it out as scrambled-looking text (base64) so callers
  // treat it as a bookmark, not a number to fiddle with. Here we unscramble it.
  let afterSeq = 0;
  if (req.query.cursor !== undefined && req.query.cursor !== "") {
    const decoded = Buffer.from(String(req.query.cursor), "base64url").toString("utf8");
    if (!/^\d{1,15}$/.test(decoded)) {
      return sendError(res, 400, "cursor is not valid");
    }
    afterSeq = Number(decoded);
  }

  // Ask for ONE MORE than the page size. If we get it, there is a next page.
  const result = await pool.query(
    `SELECT * FROM bookings
     WHERE email = $1 AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [email, afterSeq, limit + 1]
  );

  const page = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const nextCursor = hasMore
    ? Buffer.from(String(page[page.length - 1].seq)).toString("base64url")
    : null;

  res.json({ bookings: page.map(toBooking), next_cursor: nextCursor });
});

// GET /bookings/:id (level 1)
// Look up one booking by its id.
app.get("/bookings/:id", async (req, res) => {
  const result = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
  if (result.rows.length === 0) return sendError(res, 404, "booking not found");
  res.json(toBooking(result.rows[0]));
});

// DELETE /bookings/:id (level 3)
// Cancel a booking. We don't erase the row; we mark it "cancelled".
// Because the unique rule only looks at CONFIRMED bookings, the slot
// becomes free again automatically.
app.delete("/bookings/:id", async (req, res) => {
  // "Change it to cancelled, but only if it is currently confirmed."
  // Doing the check and the change in one step means two people cancelling
  // at once can't both succeed.
  const updated = await pool.query(
    "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
    [req.params.id]
  );
  if (updated.rows.length > 0) return res.json(toBooking(updated.rows[0]));

  // Nothing changed. Either it doesn't exist (404) or was already cancelled (409).
  const existing = await pool.query("SELECT id FROM bookings WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) return sendError(res, 404, "booking not found");
  return sendError(res, 409, "booking already cancelled");
});

// ───────────────────────── 6. ERROR HANDLING ────────────────────────

// Any address we don't recognise.
app.use((req, res) => sendError(res, 404, "not found"));

// The safety net: any error thrown above lands here.
app.use((err, req, res, next) => {
  // The body wasn't valid JSON.
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return sendError(res, 400, "request body must be valid JSON");
  }
  if (err.type === "entity.too.large") {
    return sendError(res, 413, "request body is too large");
  }
  console.error(err); // write the details to the host's logs for us
  sendError(res, 500, "something went wrong on our side"); // tell the caller little
});

// Hand the app to whoever wants to run it (server.js locally, Vercel online).
module.exports = app;
