// Vercel serverless entrypoint. The actual Express app (routes, static
// file serving for local dev, etc.) lives in ../server.js; this file just
// exposes it in the shape Vercel's Node runtime expects. In production,
// Vercel serves everything under /public directly from its CDN, so this
// function only ever receives the /api/* requests routed to it (see
// vercel.json) — express.static in server.js is effectively unused there,
// but keeps `node server.js` working unchanged for local development.
module.exports = require("../server");
