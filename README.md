# IGEN GREENDAY 2026 – Digital Green Action Dashboard

Node.js + Express + SQLite website with **Google (Gmail) sign-in**, built from the concept note.

## What it does (first release scope from the note)
- Public home: live counters (approved records only), 27 activities, searchable organisation leaderboard.
- Google login for everyone (participants, coordinators, IGEN admins) – no passwords stored.
- Organisation registration -> IGEN approval -> unique Organisation ID / invitation link.
- Participant profile, join organisation by code, ONE category per participant.
- Dynamic submission form (A / B / C), targets enforced server-side, evidence upload (images, mp4, PDF; private).
- IGEN verification: approve / correction required / reject, comments, audit log. Coordinators cannot approve.
- Ranking = unique verified participants -> approved actions -> earliest to reach final count (equal counts share rank).
- Organisation dashboard + CSV export, admin CSV export, printable certificate.

## 1. Google setup (one time)
1. https://console.cloud.google.com -> create project -> **APIs & Services > OAuth consent screen** (External).
2. **Credentials > Create credentials > OAuth client ID > Web application**.
3. Authorised redirect URI: `http://localhost:3000/auth/google/callback` (add your real domain's URI when deploying).
4. Copy Client ID and Secret.

## 2. Run
```bash
npm install
cp .env.example .env      # fill in Google keys, SESSION_SECRET, ADMIN_EMAILS
npm start                 # http://localhost:3000
```
Emails listed in `ADMIN_EMAILS` become IGEN administrators when they sign in.

## 3. Before going live
- Serve over HTTPS and set `BASE_URL=https://your-domain` (cookies become secure automatically).
- Keep `private_uploads/` and `greenday.db` on persistent storage and back them up.
- Add rate limiting (e.g. `express-rate-limit`), and privacy handling for minors/school students.
- Not yet included (later phases in the note): phone OTP, public approved-action gallery, charts, SDG/Panchabhuta reports, certificate numbering table, campaign-settings screen.
- Note: Google sign-in accepts any Google account, not only @gmail.com. To restrict, check `email.endsWith('@gmail.com')` in the callback.
