// seed.js
// Fills your API with sample appointment slots so the web page has
// something to show (for example, before recording your Loom).
//
// WARNING: this calls POST /reset, which deletes ALL bookings.
//
// Use it like this (one line):
//   node seed.js https://your-app.vercel.app your-api-key

const baseUrl = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const apiKey = process.argv[3] || process.env.API_KEY;

// Build slots for the next 5 days: two doctors, 30-minute slots, 09:00-11:00 UTC.
const slots = [];
const providers = ["Dr Ade", "Dr Bello"];
for (let dayOffset = 1; dayOffset <= 5; dayOffset++) {
  for (const [p, provider] of providers.entries()) {
    for (let i = 0; i < 4; i++) {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + dayOffset);
      start.setUTCHours(9, i * 30, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      slots.push({
        id: `d${dayOffset}-p${p + 1}-s${i + 1}`,
        provider,
        start: start.toISOString().replace(".000Z", "Z"),
        end: end.toISOString().replace(".000Z", "Z"),
      });
    }
  }
}

fetch(`${baseUrl}/reset`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
  body: JSON.stringify({ slots }),
})
  .then(async (response) => {
    console.log(response.status, await response.text());
    console.log(response.ok ? `Loaded ${slots.length} sample slots.` : "Seeding failed.");
  })
  .catch((err) => console.error("Could not reach the API:", err.message));
