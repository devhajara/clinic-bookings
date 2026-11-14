# Clinic Booking API

An API that lets patients book clinic appointment slots, plus a web page that uses it.
Built for Task 1 of the Koya Cohort 4 assessment.

- **Stack:** Node.js + Express (the API), PostgreSQL on Neon (the database), Vercel (hosting)
- **Spec:** https://koyaacademy.com/assessment-api

## What is in this folder

| File | What it is |
|---|---|
| `app.js` | The whole API. Every endpoint, with comments explaining each step. |
| `schema.sql` | Creates the database tables. Run once. |
| `public/index.html` | The web page patients use. |
| `api/index.js` + `vercel.json` | Two tiny files that tell Vercel how to run `app.js`. |
| `server.js` | Runs the app on your own computer. |
| `seed.js` | Loads sample slots so the page has something to show. |
| `test.js` | 80 automatic checks covering all five levels. |
| `.env.example` | Template for your secrets (API key, database address). |

## Endpoints

Every request needs the header `X-API-Key: <your key>`. Every error looks like `{"error": "message"}`.

| Method | Path | Does |
|---|---|---|
| POST | `/reset` | Deletes all bookings and replaces all slots |
| GET | `/slots` | Lists slots, earliest first (`?provider=` to filter) |
| POST | `/bookings` | Books a slot |
| GET | `/bookings/{id}` | Looks up one booking |
| DELETE | `/bookings/{id}` | Cancels a booking |
| GET | `/bookings?email=&limit=&cursor=` | Lists a person's bookings, in pages |

## How each level is solved

1. **Level 1, basics.** Slots and bookings are rows in Postgres, so they survive restarts.
2. **Level 2, key and validation.** One check before every endpoint compares `X-API-Key` to the `API_KEY`
   environment variable (401 if wrong). Booking details are trimmed, the email is lower-cased, and bad input gets 400.
3. **Level 3, no double booking.** The database has a unique rule: a slot may appear only once among
   *confirmed* bookings. The API does not "check then save" (two requests could both pass the check). It just
   tries to save and the database lets exactly one through; the rest get 409. Cancelling marks the booking
   `cancelled`, which the rule ignores, so the slot is free again.
4. **Level 4, safe retries and paging.** For each `Idempotency-Key` the API stores a fingerprint of the request
   and the answer it gave. Same key + same request: the stored answer is repeated. Same key + different
   request: 422. Paging uses a cursor: a bookmark of the last booking seen, so the next page starts right after it.
5. **Level 5, anti-spam.** Every attempt is logged per email. Before a booking is processed the API counts that
   email's attempts in the last 60 seconds; at 5 or more it returns 429 with `Retry-After`. The count is in the
   database, so it works across multiple server copies.

## Run it on your own computer (optional)

1. Install Node.js 20.6 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in `API_KEY` and `DATABASE_URL`.
4. Run `schema.sql` in your database once.
5. `npm start`, then open http://localhost:3000
6. In a second terminal: `node seed.js http://localhost:3000 YOUR_API_KEY` for sample slots, or `npm test` to run the checks.

## Deploy

1. **Neon:** create a project (region: AWS US East, N. Virginia), open the SQL Editor, paste `schema.sql`, Run.
   Copy the **pooled** connection string.
2. **GitHub:** put this folder in a public repository.
3. **Vercel:** Add New > Project > import the repository. Before deploying, add two Environment Variables:
   `API_KEY` (a long random string you choose) and `DATABASE_URL` (the Neon string). Deploy.
4. **Check it:** `node test.js https://YOUR-APP.vercel.app YOUR_API_KEY` (this wipes bookings).
5. **Sample data for the page:** `node seed.js https://YOUR-APP.vercel.app YOUR_API_KEY`

The API base URL and the web page URL are the same address: `https://YOUR-APP.vercel.app`.

## A note on the API key and the web page

The web page runs in the patient's browser and must send the API key, so anyone who opens the browser's
developer tools can see it. That is accepted for this assessment, where one shared key is the requirement.
In a real clinic system, patients would sign in and the key would stay on the server.
