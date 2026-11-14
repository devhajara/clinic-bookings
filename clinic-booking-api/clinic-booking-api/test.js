// test.js
// Checks every level of the spec against a running copy of the API.
// WARNING: it calls POST /reset, which deletes all bookings.
//
//   Local:    npm start   (in one terminal), then   npm test   (in another)
//   Deployed: node test.js https://your-app.vercel.app your-api-key

const BASE = (process.argv[2] || process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.argv[3] || process.env.API_KEY;

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== undefined ? "  -> " + JSON.stringify(detail) : ""}`); }
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": KEY, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

const future = (hours) => new Date(Date.now() + hours * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
const SLOTS = [
  { id: "s3", provider: "Dr Bello", start: future(30), end: future(30.5) },
  { id: "s1", provider: "Dr Ade", start: future(24), end: future(24.5) },
  { id: "s2", provider: "Dr Ade", start: future(26), end: future(26.5) },
  { id: "past", provider: "Dr Ade", start: future(-5), end: future(-4.5) },
];
const reset = (slots = SLOTS) => call("POST", "/reset", { slots });
let n = 0;
const mail = () => `user${++n}-${Date.now()}@example.com`; // a fresh email each time

async function main() {
  console.log(`Testing ${BASE}\n\nLevel 1: slots, book, look up`);
  let r = await reset();
  check("reset returns 200", r.status === 200, r);
  r = await call("GET", "/slots");
  check("slots sorted earliest first", r.status === 200 && r.data.slots.map((s) => s.id).join() === "past,s1,s2,s3", r.data);
  check("slot keeps exact start/end text", r.data.slots[1].start === SLOTS[1].start && r.data.slots[1].end === SLOTS[1].end, r.data.slots[1]);
  check("all slots available", r.data.slots.every((s) => s.available === true));
  r = await call("GET", "/slots?provider=Dr%20Ade");
  check("provider filter", r.data.slots.length === 3 && r.data.slots.every((s) => s.provider === "Dr Ade"), r.data);
  r = await call("GET", "/slots?provider=dr%20ade");
  check("provider filter is exact match", r.data.slots.length === 0, r.data);

  const b = await call("POST", "/bookings", { slot_id: "s1", name: "  Ada Obi ", email: "  ADA@Example.com " });
  check("booking returns 201 confirmed", b.status === 201 && b.data.status === "confirmed", b);
  check("booking has all fields", ["id", "slot_id", "name", "email", "status", "created_at"].every((k) => typeof b.data[k] === "string"), b.data);
  check("name trimmed, email trimmed + lower case", b.data.name === "Ada Obi" && b.data.email === "ada@example.com", b.data);
  check("created_at is a date", !Number.isNaN(Date.parse(b.data.created_at)), b.data.created_at);
  r = await call("GET", `/bookings/${b.data.id}`);
  check("look up booking", r.status === 200 && r.data.id === b.data.id && r.data.slot_id === "s1", r);
  r = await call("GET", "/bookings/nope");
  check("unknown booking 404 with error", r.status === 404 && typeof r.data.error === "string", r);
  r = await call("GET", "/slots");
  check("booked slot shows available:false", r.data.slots.find((s) => s.id === "s1").available === false);

  console.log("\nLevel 2: API key and validation");
  for (const [label, headers] of [["missing key", { "X-API-Key": "" }], ["wrong key", { "X-API-Key": "wrong" }]]) {
    for (const [m, p] of [["GET", "/slots"], ["POST", "/bookings"], ["POST", "/reset"], ["GET", "/bookings?email=a@b.co"], ["GET", "/bookings/x"], ["DELETE", "/bookings/x"]]) {
      r = await call(m, p, m === "POST" ? {} : undefined, headers);
      check(`${label}: ${m} ${p} gives 401`, r.status === 401 && typeof r.data.error === "string", r);
    }
  }
  const bad = [
    ["missing slot_id", { name: "A", email: mail() }],
    ["missing name", { slot_id: "s2", email: mail() }],
    ["missing email", { slot_id: "s2", name: "A" }],
    ["empty name", { slot_id: "s2", name: "   ", email: mail() }],
    ["empty slot_id", { slot_id: "", name: "A", email: mail() }],
    ["empty email", { slot_id: "s2", name: "A", email: " " }],
    ["invalid email", { slot_id: "s2", name: "A", email: "not-an-email" }],
    ["email without dot", { slot_id: "s2", name: "A", email: "a@b" }],
    ["number as name", { slot_id: "s2", name: 5, email: mail() }],
    ["slot already started", { slot_id: "past", name: "A", email: mail() }],
  ];
  for (const [label, body] of bad) {
    r = await call("POST", "/bookings", body);
    check(`${label} gives 400`, r.status === 400 && typeof r.data.error === "string", r);
  }
  r = await call("POST", "/bookings", "{not json");
  check("broken JSON gives 400", r.status === 400 && typeof r.data.error === "string", r);
  r = await call("POST", "/bookings", { slot_id: "ghost", name: "A", email: mail() });
  check("unknown slot gives 404", r.status === 404 && typeof r.data.error === "string", r);
  r = await call("GET", "/slots");
  check("failed bookings did not take slot s2", r.data.slots.find((s) => s.id === "s2").available === true);

  console.log("\nLevel 3: no double booking, cancel");
  r = await call("POST", "/bookings", { slot_id: "s1", name: "B", email: mail() });
  check("already booked slot gives 409", r.status === 409 && typeof r.data.error === "string", r);
  await reset();
  const race = await Promise.all(Array.from({ length: 40 }, () => call("POST", "/bookings", { slot_id: "s1", name: "Racer", email: mail() })));
  const wins = race.filter((x) => x.status === 201).length;
  const losses = race.filter((x) => x.status === 409).length;
  check("40 simultaneous bookings: exactly one 201", wins === 1, race.map((x) => x.status));
  check("40 simultaneous bookings: the other 39 get 409", losses === 39, race.map((x) => x.status));
  const winner = race.find((x) => x.status === 201).data;
  r = await call("DELETE", `/bookings/${winner.id}`);
  check("cancel returns 200 cancelled", r.status === 200 && r.data.status === "cancelled" && r.data.id === winner.id, r);
  r = await call("GET", `/bookings/${winner.id}`);
  check("cancelled booking still readable", r.status === 200 && r.data.status === "cancelled", r);
  r = await call("DELETE", `/bookings/${winner.id}`);
  check("cancel twice gives 409", r.status === 409, r);
  r = await call("DELETE", "/bookings/nope");
  check("cancel unknown gives 404", r.status === 404, r);
  r = await call("GET", "/slots");
  check("cancel frees the slot", r.data.slots.find((s) => s.id === "s1").available === true);
  r = await call("POST", "/bookings", { slot_id: "s1", name: "C", email: mail() });
  check("freed slot can be booked again", r.status === 201, r);

  console.log("\nLevel 4: idempotency and paging");
  await reset();
  const body = { slot_id: "s1", name: "Ida", email: mail() };
  const first = await call("POST", "/bookings", body, { "Idempotency-Key": "key-1" });
  const again = await call("POST", "/bookings", body, { "Idempotency-Key": "key-1" });
  check("first request 201", first.status === 201, first);
  check("retry: same status and same booking id", again.status === 201 && again.data.id === first.data.id, again);
  check("retry: identical response body", JSON.stringify(Object.entries(again.data).sort()) === JSON.stringify(Object.entries(first.data).sort()), again.data);
  r = await call("POST", "/bookings", { ...body, name: "Someone Else" }, { "Idempotency-Key": "key-1" });
  check("same key, different body gives 422", r.status === 422 && typeof r.data.error === "string", r);
  r = await call("POST", "/bookings", { ...body, slot_id: "s2" }, { "Idempotency-Key": "key-1" });
  check("same key, different slot gives 422", r.status === 422, r);
  r = await call("GET", `/bookings?email=${encodeURIComponent(body.email)}`);
  check("retry did not create a second booking", r.data.bookings.length === 1, r.data);
  const e404 = { slot_id: "ghost", name: "X", email: mail() };
  const f1 = await call("POST", "/bookings", e404, { "Idempotency-Key": "key-err" });
  const f2 = await call("POST", "/bookings", e404, { "Idempotency-Key": "key-err" });
  check("retry of a failed request repeats the failure", f1.status === 404 && f2.status === 404, [f1.status, f2.status]);
  const cBody = { slot_id: "s2", name: "Twin", email: mail() };
  const twins = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/bookings", cBody, { "Idempotency-Key": "key-twins" })));
  check("10 simultaneous retries: all 201 with one booking id", twins.every((x) => x.status === 201) && new Set(twins.map((x) => x.data.id)).size === 1, twins.map((x) => x.status));

  // paging: 7 bookings for one person (5 by them directly would hit the rate
  // limit, so reset between batches is avoided by spacing them across slots
  // and using a fresh table of slots).
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, provider: "Dr Ade", start: future(48 + i), end: future(48.5 + i) }));
  await reset(many);
  const pager = `Pager${Date.now()}@Example.com`;
  const made = [];
  for (let i = 0; i < 5; i++) made.push((await call("POST", "/bookings", { slot_id: `p${i}`, name: "Pager", email: pager })).data.id);
  await call("DELETE", `/bookings/${made[1]}`);
  await call("POST", "/bookings", { slot_id: "p9", name: "Other", email: mail() });
  r = await call("GET", `/bookings?email=${encodeURIComponent(pager.toUpperCase())}&limit=2`);
  check("page 1 has 2, oldest first, case ignored", r.status === 200 && r.data.bookings.map((x) => x.id).join() === made.slice(0, 2).join() && typeof r.data.next_cursor === "string", r.data);
  check("cancelled bookings are listed too", r.data.bookings[1].status === "cancelled", r.data.bookings[1]);
  let r2 = await call("GET", `/bookings?email=${encodeURIComponent(pager)}&limit=2&cursor=${encodeURIComponent(r.data.next_cursor)}`);
  check("page 2 continues", r2.data.bookings.map((x) => x.id).join() === made.slice(2, 4).join() && typeof r2.data.next_cursor === "string", r2.data);
  let r3 = await call("GET", `/bookings?email=${encodeURIComponent(pager)}&limit=2&cursor=${encodeURIComponent(r2.data.next_cursor)}`);
  check("last page has next_cursor null", r3.data.bookings.map((x) => x.id).join() === made.slice(4).join() && r3.data.next_cursor === null, r3.data);
  r = await call("GET", `/bookings?email=${encodeURIComponent(pager)}`);
  check("default limit returns all 5, next_cursor null", r.data.bookings.length === 5 && r.data.next_cursor === null, r.data);
  r = await call("GET", `/bookings?email=${encodeURIComponent(pager)}&limit=5`);
  check("exact-fit page has next_cursor null", r.data.bookings.length === 5 && r.data.next_cursor === null, r.data);
  r = await call("GET", `/bookings?email=nobody@example.com`);
  check("no bookings: empty list, null cursor", r.status === 200 && r.data.bookings.length === 0 && r.data.next_cursor === null, r.data);
  for (const lim of ["0", "51", "abc", "-1", "1.5", ""]) {
    r = await call("GET", `/bookings?email=${encodeURIComponent(pager)}&limit=${lim}`);
    check(`limit=${JSON.stringify(lim)} gives 400`, r.status === 400 && typeof r.data.error === "string", r);
  }
  for (const lim of ["1", "50"]) {
    r = await call("GET", `/bookings?email=${encodeURIComponent(pager)}&limit=${lim}`);
    check(`limit=${lim} is accepted`, r.status === 200, r);
  }
  r = await call("GET", "/bookings");
  check("missing email gives 400", r.status === 400, r);

  console.log("\nLevel 5: rate limit");
  await reset(many);
  const spammer = mail();
  const codes = [];
  let sixth;
  for (let i = 0; i < 6; i++) {
    sixth = await call("POST", "/bookings", { slot_id: i % 2 ? "ghost" : `p${i}`, name: "Spam", email: spammer.toUpperCase() });
    codes.push(sixth.status);
  }
  check("5 attempts allowed (failed ones count), 6th gives 429", codes.join() === "201,404,201,404,201,429", codes);
  const ra = sixth.headers.get("Retry-After");
  check("429 has Retry-After in whole seconds (1-60)", /^\d+$/.test(ra || "") && Number(ra) >= 1 && Number(ra) <= 60, ra);
  check("429 has error body", typeof sixth.data.error === "string", sixth.data);
  r = await call("POST", "/bookings", { slot_id: "p7", name: "Calm", email: mail() });
  check("other emails are not affected", r.status === 201, r);
  const burstMail = mail();
  const burst = await Promise.all(Array.from({ length: 12 }, () => call("POST", "/bookings", { slot_id: "ghost", name: "Burst", email: burstMail })));
  check("12 simultaneous attempts: exactly 5 get through", burst.filter((x) => x.status === 404).length === 5 && burst.filter((x) => x.status === 429).length === 7, burst.map((x) => x.status));
  await reset(many);
  r = await call("POST", "/bookings", { slot_id: "p1", name: "Spam", email: spammer });
  check("reset clears the rate limit", r.status === 201, r);

  console.log("\nOther");
  r = await call("GET", "/nothing-here");
  check("unknown address gives 404 JSON error", r.status === 404 && typeof r.data.error === "string", r);
  r = await call("POST", "/reset", { slots: "nope" });
  check("bad reset body gives 400", r.status === 400, r);
  r = await reset([]);
  check("reset with empty list works", r.status === 200 && (await call("GET", "/slots")).data.slots.length === 0, r);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
