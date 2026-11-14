// server.js
// Runs the app on YOUR computer (npm start). Vercel does not use this file;
// it uses api/index.js instead.
const app = require("./app");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic booking API running at http://localhost:${PORT}`);
});
