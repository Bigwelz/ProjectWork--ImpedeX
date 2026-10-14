/* =============================================
   EIPS — Combined Server (server/both.js)
   Single process for production hosting (Render):
   serves BOTH the student site and the admin portal
   plus both APIs on ONE port.

     Render:  Root Directory = server
              Start Command  = npm run start:combined

   Local development stays the two-process split:
     npm start     → :4000 students
     npm run admin → :4001 admins
============================================= */

"use strict";

const path = require("node:path");
const express = require("express");

const { mountApi, normalizePath } = require("./api");

const FRONTEND_DIR = path.join(__dirname, "..");
const PORT = process.env.PORT || 4000;

const app = express();

/* Both audiences on one port. Admin endpoints remain behind authAdmin
   (JWT + rate-limited login); student endpoints behind authStudent. */
mountApi(app, { student: true, admin: true });

/* Never expose server source code or the SQLite database file. */
app.use((req, res, next) => {
  const p = normalizePath(req);
  if (p === "/server" || p.startsWith("/server/")) return res.status(404).send("Not found");
  next();
});

app.use(express.static(FRONTEND_DIR));

app.listen(PORT, () => {
  console.log(`EIPS combined site running on port ${PORT}`);
  console.log("Serving frontend from " + FRONTEND_DIR);
});
