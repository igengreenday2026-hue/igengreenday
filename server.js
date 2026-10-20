require('dotenv').config();
const express = require('express'), session = require('cookie-session'), Database = require('better-sqlite3'),
  multer = require('multer'), { OAuth2Client } = require('google-auth-library'),
  crypto = require('crypto'), path = require('path'), fs = require('fs');
const { PORT = 3000, BASE_URL = `http://localhost:${PORT}`, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = 'change-me', ADMIN_EMAILS = '' } = process.env;
const admins = ADMIN_EMAILS.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const UP = path.join(__dirname, 'private_uploads'); fs.mkdirSync(UP, { recursive: true });

/* ---------- Database ---------- */
const db = new Database(process.env.DB_FILE || 'greenday.db');
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS organisations(id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, type TEXT, coordinator_id INTEGER,
  coordinator_name TEXT, email TEXT, phone TEXT, city TEXT, state TEXT, country TEXT, website TEXT, expected INTEGER,
  status TEXT DEFAULT 'Pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, google_id TEXT UNIQUE, email TEXT UNIQUE, name TEXT, photo TEXT,
  role TEXT DEFAULT 'participant', ptype TEXT, dept TEXT, org_id INTEGER REFERENCES organisations(id), consent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY, category TEXT, name TEXT, description TEXT, unit TEXT, target INTEGER DEFAULT 0, own INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), org_id INTEGER, activity_id INTEGER REFERENCES activities(id),
  own_idea TEXT, title TEXT, impl_date TEXT, location TEXT, beneficiaries INTEGER DEFAULT 0, product TEXT, description TEXT, before_after TEXT,
  sdgs TEXT, pancha TEXT, outcome TEXT, status TEXT DEFAULT 'Submitted', created_at TEXT DEFAULT CURRENT_TIMESTAMP, approved_at TEXT);
CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY, submission_id INTEGER REFERENCES submissions(id), file TEXT, name TEXT, mime TEXT);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, submission_id INTEGER, reviewer_id INTEGER, decision TEXT, comments TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
if (!db.prepare('SELECT COUNT(*) n FROM activities').get().n) {
  const ins = db.prepare('INSERT INTO activities(category,name,description,unit,target,own) VALUES(?,?,?,?,?,?)');
  const A = [['Water Conservation Awareness', 'water conservation, rainwater harvesting and preventing water wastage'],
    ['Energy Conservation Awareness', 'electricity saving through #ENSAV9MANTRAS'], ['Tree Plantation & Green Cover Awareness', 'native tree planting and tree care'],
    ['Clean Air & Green Mobility Awareness', 'cycling, walking, public transport and reducing air pollution'], ['Soil Conservation Awareness', 'soil protection, composting and sustainable land use'],
    ['Waste Segregation & Plastic Reduction Awareness', 'waste segregation, recycling and avoiding single-use plastics'], ['Biodiversity Conservation Awareness', 'protecting native plants, birds and pollinators'],
    ['Sustainable Food & Food Waste Reduction Awareness', 'reducing food waste, composting and responsible food consumption'], ['Climate Action & Sustainable Living Awareness', 'reducing carbon emissions and adopting sustainable daily habits']];
  const B = [['LED Bulb Distribution', 3, 'households'], ['Water Flow Controller Distribution', 5, 'households'], ['Waste Segregation Bin Distribution', 3, 'households'],
    ['Reusable Cloth Bag Distribution', 5, 'individuals'], ['Native Sapling Distribution', 5, 'individuals'], ['Household Compost Bin Distribution', 3, 'households'],
    ['Solar Lamp Distribution', 1, 'households'], ['Reusable Water Bottle Distribution', 5, 'individuals'], ['Native Seed Kit Distribution', 5, 'individuals']];
  const C = [['One-Day Energy Detective Project', 'Mini energy audit of a classroom or home; implement corrective actions (SDG 7)'], ['One-Day Home Water Audit Project', 'Record household water use, find wastage, implement savings (SDG 6)'],
    ['Nine-Hour Food Waste Audit Project', 'Measure food waste at home/canteen/college and implement prevention (SDG 12)'], ['Industry Waste Audit Project', 'Audit industrial waste streams and recommend reduction, reuse, recycling (SDG 12)'],
    ['Paper Consumption Audit Project', 'Audit paper use and implement paper-saving measures (SDG 12)'], ['Rainwater Harvesting Inspection Project', 'Inspect an existing system and arrange corrective action (SDG 6)'],
    ['Biodiversity Audit Project', 'Survey birds, butterflies and native plants; recommend habitat protection (SDG 15)'], ['Campus Water Leak Detection Project', 'Inspect taps, pipes, toilets, storage; report and facilitate repairs (SDG 6)'],
    ['Campus Plastic Usage Audit Project', 'Quantify single-use plastic and implement reduction measures (SDG 12)']];
  db.transaction(() => {
    A.forEach(([n, d]) => ins.run('A', n, 'Create awareness among at least 9 citizens about ' + d, 'citizens', 9, 0)); ins.run('A', 'Own idea (needs IGEN approval)', 'Own awareness topic aligned with Panchabhutas and SDGs', 'citizens', 9, 1);
    B.forEach(([n, t, u]) => ins.run('B', n, 'Distribute to ' + t + ' ' + u, u, t, 0)); ins.run('B', 'Own idea (needs IGEN approval)', 'Own sustainability product distribution', 'beneficiaries', 1, 1);
    C.forEach(([n, d]) => ins.run('C', n, d, 'project', 0, 0)); ins.run('C', 'Own idea (needs IGEN approval)', 'Own Green Action Project, completed within one week', 'project', 0, 1);
  })();
}

/* ---------- Helpers ---------- */
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CATS = { A: 'Awareness & Implementation', B: 'Sustainability Product Distribution', C: 'Green Action Projects' };
const ORG_TYPES = ['College', 'University', 'School', 'Industry', 'NGO', 'Other'], PTYPES = ['Student', 'Faculty', 'Employee', 'Volunteer', 'Other'];
const ELEMENTS = ['Earth', 'Water', 'Fire', 'Air', 'Space'];
const csv = rows => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
const sel = (name, opts, cur, extra = '') => `<select name="${name}" ${extra}>${opts.map(o => `<option ${o === cur ? 'selected' : ''}>${h(o)}</option>`).join('')}</select>`;
const flash = (req, m) => { req.session.flash = m; };
const back = (req, res, m) => { if (m) flash(req, m); res.redirect(req.get('referer') || '/'); };

function board(f = {}) {
  const w = ["o.status='Approved'"], p = [];
  if (f.q) { w.push('o.name LIKE ?'); p.push('%' + f.q + '%'); }
  if (f.country) { w.push('o.country = ?'); p.push(f.country); }
  if (f.type) { w.push('o.type = ?'); p.push(f.type); }
  const rows = db.prepare(`SELECT o.id,o.name,o.type,o.city,o.country,
    (SELECT COUNT(DISTINCT user_id) FROM submissions WHERE org_id=o.id AND status='Approved') vp,
    (SELECT COUNT(*) FROM submissions WHERE org_id=o.id AND status='Approved') aa,
    (SELECT MAX(t) FROM (SELECT MIN(approved_at) t FROM submissions WHERE org_id=o.id AND status='Approved' GROUP BY user_id)) reached
    FROM organisations o WHERE ${w.join(' AND ')} ORDER BY vp DESC, aa DESC, reached ASC, o.name`).all(...p);
  rows.forEach(r => r.rank = 1 + rows.filter(x => x.vp > r.vp).length); // equal verified participants share a rank
  return rows;
}
const stats = () => ({
  orgs: db.prepare("SELECT COUNT(*) n FROM organisations WHERE status='Approved'").get().n,
  vp: db.prepare("SELECT COUNT(DISTINCT user_id) n FROM submissions WHERE status='Approved'").get().n,
  aa: db.prepare("SELECT COUNT(*) n FROM submissions WHERE status='Approved'").get().n,
  ben: db.prepare("SELECT COALESCE(SUM(beneficiaries),0) n FROM submissions WHERE status='Approved'").get().n });

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,sans-serif;color:#1b2b1f;background:#f4f9f4}a{color:#17692f}
header{background:#0f5a2a;color:#fff;padding:.7rem 1rem;display:flex;flex-wrap:wrap;gap:.8rem;align-items:center;justify-content:space-between}
header a{color:#fff;text-decoration:none;margin-left:.8rem}header b{font-size:1.1rem}main{max-width:1050px;margin:auto;padding:1rem}
.hero{background:linear-gradient(135deg,#0f5a2a,#2e9d4f);color:#fff;border-radius:14px;padding:2rem 1.2rem;margin-bottom:1rem}.hero h1{margin:.2rem 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;margin:1rem 0}.card{background:#fff;border-radius:12px;padding:1rem;box-shadow:0 1px 4px #0002;margin-bottom:1rem}
.num{font-size:2rem;font-weight:700;color:#17692f}.btn,button{background:#17692f;color:#fff;border:0;border-radius:8px;padding:.55rem 1rem;text-decoration:none;cursor:pointer;display:inline-block;font:inherit}
.btn.alt{background:#fff;color:#17692f;border:1px solid #17692f}.btn.red,button.red{background:#b3261e}label{display:block;margin:.6rem 0 .1rem;font-weight:600}
input,select,textarea{width:100%;padding:.5rem;border:1px solid #9bb;border-radius:6px;font:inherit}input[type=checkbox]{width:auto}label.i{display:inline-block;font-weight:400;margin-right:.8rem}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#fff}td,th{padding:.45rem .6rem;border-bottom:1px solid #dde;text-align:left;font-size:.93rem}
.tag{padding:.1rem .5rem;border-radius:99px;background:#e1efe3;font-size:.8rem}.msg{background:#fff7d6;border:1px solid #e0c85a;padding:.6rem 1rem;border-radius:8px;margin:.5rem 0}
form.inline{display:inline}.f{display:flex;gap:.5rem;flex-wrap:wrap}.f>*{flex:1;min-width:140px}`;
function render(req, res, title, body) {
  const m = req.session.flash; req.session.flash = null; const u = req.user;
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} | IGEN GREENDAY 2026</title><style>${CSS}</style></head><body>
<header><b>🌍 IGEN GREENDAY 2026</b><nav><a href="/">Home</a>${u ? `<a href="/dashboard">Dashboard</a><a href="/logout">Logout (${h(u.name)})</a>` : '<a href="/auth/google">Sign in with Google</a>'}</nav></header>
<main>${m ? `<div class="msg">${h(m)}</div>` : ''}${body}</main></body></html>`);
}

/* ---------- App & auth ---------- */
const app = express(); app.set('trust proxy', 1);
app.use(session({ name: 'gd', keys: [SESSION_SECRET], maxAge: 7 * 864e5, sameSite: 'lax', httpOnly: true, secure: BASE_URL.startsWith('https') }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => { req.user = (req.session.uid && db.prepare('SELECT * FROM users WHERE id=?').get(req.session.uid)) || null; next(); });
const login = (req, res, next) => { if (req.user) return next(); req.session.returnTo = req.originalUrl; res.redirect('/auth/google'); };
const adminOnly = [login, (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).send('IGEN administrators only')];
const gc = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL + '/auth/google/callback');

app.get('/auth/google', (req, res) => {
  req.session.state = crypto.randomBytes(16).toString('hex');
  res.redirect(gc.generateAuthUrl({ scope: ['openid', 'email', 'profile'], state: req.session.state, prompt: 'select_account' }));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.state) throw new Error('invalid state');
    const { tokens } = await gc.getToken(req.query.code);
    const p = (await gc.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID })).getPayload();
    if (!p.email_verified) throw new Error('Google email not verified');
    const email = p.email.toLowerCase(), isAdmin = admins.includes(email);
    let u = db.prepare('SELECT * FROM users WHERE google_id=?').get(p.sub);
    if (!u) u = { id: db.prepare('INSERT INTO users(google_id,email,name,photo,role) VALUES(?,?,?,?,?)').run(p.sub, email, p.name, p.picture, isAdmin ? 'admin' : 'participant').lastInsertRowid };
    else if (isAdmin) db.prepare("UPDATE users SET role='admin' WHERE id=?").run(u.id);
    req.session.uid = u.id; req.session.state = null;
    const to = req.session.returnTo || '/dashboard'; req.session.returnTo = null; res.redirect(to);
  } catch (e) { console.error(e); flash(req, 'Sign-in failed: ' + e.message); res.redirect('/'); }
});
app.get('/logout', (req, res) => { req.session = null; res.redirect('/'); });
app.get('/dashboard', login, (req, res) => res.redirect(req.user.role === 'admin' ? '/admin' : req.user.role === 'coordinator' ? '/org' : '/me'));

/* ---------- Public home ---------- */
app.get('/', (req, res) => {
  const s = stats(), q = req.query, rows = board(q);
  const countries = db.prepare("SELECT DISTINCT country FROM organisations WHERE status='Approved' ORDER BY 1").all().map(r => r.country);
  const acts = db.prepare('SELECT * FROM activities WHERE own=0').all();
  render(req, res, 'Home', `
<div class="hero"><small>22 October – 2 November 2026</small><h1>IGEN GREENDAY 2026 · #Act4Green</h1>
<p><b>“Hammer the Heat, Defend 1.5°C — My Green Action, My Climate Impact!”</b></p>
<p>Move beyond pledges: implement a Panchabhuta-based green action, upload your evidence, get verified and recognised.</p>
${req.user ? '<a class="btn alt" href="/dashboard">Go to my dashboard</a>' : '<a class="btn alt" href="/auth/google">Participate – Sign in with Google</a>'}
<a class="btn alt" href="/orgs/register">Register Your Organisation</a></div>
<div class="grid"><div class="card"><div class="num">${s.orgs}</div>Registered Organisations</div><div class="card"><div class="num">${s.vp}</div>Verified Participants</div>
<div class="card"><div class="num">${s.aa}</div>Approved Actions</div><div class="card"><div class="num">${s.ben}</div>Beneficiaries Reached</div></div>
<p><small>All figures count IGEN-approved records only.</small></p>
<div class="card"><h2>How to participate</h2><ol><li>Sign in with your Google (Gmail) account and complete your profile (join your organisation with its code, if any).</li>
<li>Choose <b>ONE</b> category: A) Awareness &amp; Implementation, B) Sustainability Product Distribution, C) Green Action Projects.</li>
<li>Implement your action, then submit details with photos/videos as evidence. Share it in the <a href="https://www.linkedin.com/groups/40616269/">IGEN GREENDAY LinkedIn Group</a> with #igenGreenDay2026 #igenGreenDay.</li>
<li>IGEN verifies your submission; approved participants receive recognition and a certificate.</li></ol></div>
<div class="card"><h2>The 27 suggested activities</h2>${Object.keys(CATS).map(c => `<details><summary><b>${c}) ${CATS[c]}</b></summary><ul>${acts.filter(a => a.category === c).map(a => `<li><b>${h(a.name)}</b> – ${h(a.description)}</li>`).join('')}</ul><small>Own ideas are accepted after IGEN approval.</small></details>`).join('')}</div>
<div class="card"><h2>Organisation leaderboard</h2><form class="f"><input name="q" placeholder="Search organisation" value="${h(q.q)}">
<select name="country"><option value="">All countries</option>${countries.map(c => `<option ${c === q.country ? 'selected' : ''}>${h(c)}</option>`).join('')}</select>
<select name="type"><option value="">All types</option>${ORG_TYPES.map(t => `<option ${t === q.type ? 'selected' : ''}>${t}</option>`).join('')}</select><button>Filter</button></form>
<div class="tw"><table><tr><th>Rank</th><th>Organisation</th><th>Type</th><th>Location</th><th>Verified participants</th><th>Approved actions</th></tr>
${rows.map(r => `<tr><td>${r.rank}</td><td>${h(r.name)}</td><td>${h(r.type)}</td><td>${h(r.city)}, ${h(r.country)}</td><td>${r.vp}</td><td>${r.aa}</td></tr>`).join('') || '<tr><td colspan=6>No approved organisations yet.</td></tr>'}</table></div>
<small>Ranking: unique verified participants → approved actions → earliest to reach final count. Equal verified counts share a rank.</small></div>`);
});

/* ---------- Organisation registration ---------- */
app.get('/orgs/register', login, (req, res) => render(req, res, 'Register organisation', `<div class="card"><h2>Register Your Organisation</h2>
<form method="post"><label>Organisation name*<input name="name" required></label><label>Organisation type*${sel('type', ORG_TYPES)}</label>
<label>Coordinator name*<input name="coordinator_name" required value="${h(req.user.name)}"></label>
<label>Official email (verified through your Google sign-in)<input value="${h(req.user.email)}" disabled></label>
<label>Phone*<input name="phone" required></label><div class="f"><label>City*<input name="city" required></label><label>State*<input name="state" required></label><label>Country*<input name="country" required></label></div>
<label>Website<input name="website" type="url"></label><label>Expected participants<input name="expected" type="number" min="0"></label>
<label class="i"><input type="checkbox" name="consent" required> I accept the participation terms and data policy*</label><br><br><button>Submit for IGEN approval</button></form></div>`));
app.post('/orgs/register', login, (req, res) => {
  const b = req.body; if (!b.consent || !b.name || !b.phone || !b.city || !b.state || !b.country) return back(req, res, 'Please fill all mandatory fields.');
  if (db.prepare('SELECT 1 FROM organisations WHERE coordinator_id=?').get(req.user.id)) return back(req, res, 'You have already registered an organisation.');
  if (db.prepare('SELECT 1 FROM organisations WHERE lower(name)=lower(?) AND lower(city)=lower(?)').get(b.name.trim(), b.city.trim())) return back(req, res, 'This organisation appears to be registered already.');
  const code = 'IGD26-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const id = db.prepare(`INSERT INTO organisations(code,name,type,coordinator_id,coordinator_name,email,phone,city,state,country,website,expected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, b.name.trim(), ORG_TYPES.includes(b.type) ? b.type : 'Other', req.user.id, b.coordinator_name, req.user.email, b.phone, b.city.trim(), b.state, b.country.trim(), b.website, +b.expected || 0).lastInsertRowid;
  db.prepare("UPDATE users SET role=CASE WHEN role='admin' THEN role ELSE 'coordinator' END, org_id=?, consent=1 WHERE id=?").run(id, req.user.id);
  flash(req, `Registered! Your Organisation ID is ${code}. IGEN will review and approve it.`); res.redirect('/org');
});

/* ---------- Participant: profile, submit, my page ---------- */
app.get('/join/:code', (req, res) => res.redirect('/profile?code=' + encodeURIComponent(req.params.code)));
app.get('/profile', login, (req, res) => {
  const u = req.user, cur = u.org_id ? db.prepare('SELECT code FROM organisations WHERE id=?').get(u.org_id) : null;
  render(req, res, 'My profile', `<div class="card"><h2>Participant profile</h2><form method="post">
<label>Participant type*${sel('ptype', PTYPES, u.ptype)}</label><label>Department / class / designation<input name="dept" value="${h(u.dept)}"></label>
<label>Organisation ID or invitation code (leave blank to participate as an individual)<input name="code" value="${h(req.query.code || cur?.code || '')}"></label>
<label class="i"><input type="checkbox" name="consent" required ${u.consent ? 'checked' : ''}> I accept the participation terms and privacy notice*</label><br><br><button>Save</button></form></div>`);
});
app.post('/profile', login, (req, res) => {
  const b = req.body, u = req.user; if (!b.consent) return back(req, res, 'Consent is required.');
  let org = u.org_id;
  if (b.code && b.code.trim()) {
    const o = db.prepare("SELECT * FROM organisations WHERE upper(code)=upper(?) AND status='Approved'").get(b.code.trim());
    if (!o) return back(req, res, 'Organisation code not found or not yet approved.');
    if (u.org_id && u.org_id !== o.id && db.prepare('SELECT 1 FROM submissions WHERE user_id=?').get(u.id)) return back(req, res, 'You cannot change organisation after submitting an action.');
    org = o.id;
  } else if (!db.prepare('SELECT 1 FROM submissions WHERE user_id=?').get(u.id)) org = u.role === 'coordinator' ? u.org_id : null;
  db.prepare('UPDATE users SET ptype=?,dept=?,org_id=?,consent=1 WHERE id=?').run(PTYPES.includes(b.ptype) ? b.ptype : 'Other', b.dept, org, u.id);
  flash(req, 'Profile saved.'); res.redirect('/me');
});
const mySubs = uid => db.prepare('SELECT s.*,a.name aname,a.category FROM submissions s JOIN activities a ON a.id=s.activity_id WHERE s.user_id=? ORDER BY s.id DESC').all(uid);
app.get('/me', login, (req, res) => {
  const u = req.user, subs = mySubs(u.id), ok = subs.filter(s => s.status === 'Approved');
  const org = u.org_id ? db.prepare('SELECT * FROM organisations WHERE id=?').get(u.org_id) : null;
  render(req, res, 'My portal', `<h2>Welcome, ${h(u.name)}</h2><div class="card">Organisation: <b>${org ? h(org.name) + ' (' + org.status + ')' : 'Individual participant'}</b> · Type: ${h(u.ptype || '–')}
<br><a class="btn" href="/submit">Choose &amp; submit a Green Action</a> <a class="btn alt" href="/profile">Edit profile / join organisation</a>${ok.length ? ' <a class="btn alt" href="/certificate">Recognition certificate</a>' : ''}</div>
<div class="grid"><div class="card"><div class="num">${ok.length}</div>Approved actions</div><div class="card"><div class="num">${ok.reduce((a, s) => a + s.beneficiaries, 0)}</div>Beneficiaries reached (verified)</div></div>
<div class="card"><h3>My submissions</h3>${subsTable(subs)}</div>`);
});
const subsTable = (rows, adm) => `<div class="tw"><table><tr><th>#</th>${adm ? '<th>Participant</th>' : ''}<th>Category / Activity</th><th>Title</th><th>Status</th><th></th></tr>${rows.map(s => `<tr><td>${s.id}</td>${adm ? `<td>${h(s.uname)}</td>` : ''}<td>${s.category}) ${h(s.aname)}</td><td>${h(s.title)}</td><td><span class="tag">${s.status}</span></td><td><a href="${adm ? '/admin/review/' : '/submission/'}${s.id}">Open</a></td></tr>`).join('') || '<tr><td colspan=6>Nothing yet.</td></tr>'}</table></div>`;

const up = multer({ storage: multer.diskStorage({ destination: UP, filename: (q, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')) }),
  limits: { fileSize: 25 * 1024 * 1024, files: 6 }, fileFilter: (q, f, cb) => cb(null, /^(image\/|video\/mp4$|application\/pdf$)/.test(f.mimetype)) });
const upload = (req, res, next) => up.array('evidence', 6)(req, res, e => e ? back(req, res, 'Upload error: ' + e.message) : next());
const lockedCat = uid => db.prepare("SELECT a.category c FROM submissions s JOIN activities a ON a.id=s.activity_id WHERE s.user_id=? AND s.status!='Rejected' LIMIT 1").get(uid)?.c;

app.get('/submit', login, (req, res) => {
  if (!req.user.consent) { flash(req, 'Please complete your profile first.'); return res.redirect('/profile'); }
  const acts = db.prepare('SELECT id,category,name,unit,target,own FROM activities').all(), lock = lockedCat(req.user.id);
  const cats = lock ? [lock] : Object.keys(CATS);
  render(req, res, 'Submit action', `<div class="card"><h2>Submit a completed Green Action</h2>${lock ? `<p class="msg">You have chosen Category ${lock}. Each participant implements ONE category.</p>` : ''}
<form method="post" enctype="multipart/form-data">
<label>Category*<select name="category" id="cat">${cats.map(c => `<option value="${c}">${c}) ${CATS[c]}</option>`).join('')}</select></label>
<label>Activity*<select name="activity_id" id="act"></select></label><small id="hint"></small>
<div id="own"><label>Describe your own idea* (reviewed by IGEN before it counts)<input name="own_idea"></label></div>
<label>Action title*<input name="title" required maxlength="150"></label>
<div class="f"><label>Implementation date*<input type="date" name="impl_date" required max="${new Date().toISOString().slice(0, 10)}"></label><label>Location*<input name="location" required></label></div>
<div id="ben"><label id="benl">Beneficiaries reached*</label><input type="number" name="beneficiaries" min="0" value="0"></div>
<div id="prod"><label>Product type distributed<input name="product"></label></div>
<label>Action description* (what was implemented and how)<textarea name="description" rows="4" required></textarea></label>
<label>Before / after details (optional)<textarea name="before_after" rows="2"></textarea></label>
<label>Measurable outcome (quantity saved, distributed, repaired, planted…)<input name="outcome"></label>
<label>SDG alignment</label><div>${Array.from({ length: 17 }, (_, i) => `<label class="i"><input type="checkbox" name="sdgs" value="${i + 1}"> ${i + 1}</label>`).join('')}</div>
<label>Panchabhuta alignment</label><div>${ELEMENTS.map(e => `<label class="i"><input type="checkbox" name="pancha" value="${e}"> ${e}</label>`).join('')}</div>
<label>Evidence* – photos, videos (mp4) or PDF, up to 6 files / 25 MB each<input type="file" name="evidence" multiple required accept="image/*,video/mp4,application/pdf"></label>
<label class="i"><input type="checkbox" name="declare" required> I declare this action is genuine and completed.*</label><br><br><button>Submit for verification</button></form></div>
<script>var A=${JSON.stringify(acts).replace(/</g, '\\u003c')},cat=document.getElementById('cat'),act=document.getElementById('act');
function $(i){return document.getElementById(i)}
function fill(){act.innerHTML=A.filter(function(a){return a.category==cat.value}).map(function(a){return '<option value="'+a.id+'">'+a.name+'</option>'}).join('');upd()}
function upd(){var a=A.find(function(x){return x.id==act.value})||{},c=cat.value;
$('hint').textContent=c=='C'?'Complete within one week and document the outcome.':(a.own?'Minimum '+a.target+' '+a.unit+' (own ideas need IGEN approval).':'Minimum '+a.target+' '+a.unit+'.');
$('own').style.display=a.own?'block':'none';$('prod').style.display=c=='B'?'block':'none';$('ben').style.display=c=='C'?'none':'block';
$('benl').textContent=c=='B'?'Households / individuals reached*':'Citizens reached*'}
cat.onchange=fill;act.onchange=upd;fill();</script>`);
});
app.post('/submit', login, upload, (req, res) => {
  const b = req.body, files = req.files || [], fail = m => { files.forEach(f => fs.unlink(f.path, () => {})); back(req, res, m); };
  if (!req.user.consent) return fail('Please complete your profile first.');
  const a = db.prepare('SELECT * FROM activities WHERE id=?').get(+b.activity_id); if (!a) return fail('Choose a valid activity.');
  const lock = lockedCat(req.user.id); if (lock && lock !== a.category) return fail(`You already chose Category ${lock}; only one category is allowed.`);
  const ben = a.category === 'C' ? 0 : parseInt(b.beneficiaries, 10) || 0;
  if (!b.declare || !b.title?.trim() || !b.impl_date || !b.location?.trim() || !b.description?.trim()) return fail('Please fill all mandatory fields.');
  if (a.own && !b.own_idea?.trim()) return fail('Please describe your own idea.');
  if (a.category !== 'C' && ben < a.target) return fail(`Minimum target for this activity is ${a.target} ${a.unit}.`);
  if (!files.length) return fail('Upload at least one photo, video or PDF as evidence.');
  if (db.prepare('SELECT 1 FROM submissions WHERE user_id=? AND activity_id=? AND lower(title)=lower(?)').get(req.user.id, a.id, b.title.trim())) return fail('Duplicate: you already submitted this action.');
  const id = db.prepare(`INSERT INTO submissions(user_id,org_id,activity_id,own_idea,title,impl_date,location,beneficiaries,product,description,before_after,sdgs,pancha,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, req.user.org_id, a.id, b.own_idea, b.title.trim(), b.impl_date, b.location, ben, b.product, b.description, b.before_after,
      [].concat(b.sdgs || []).join(','), [].concat(b.pancha || []).filter(e => ELEMENTS.includes(e)).join(','), b.outcome).lastInsertRowid;
  files.forEach(f => db.prepare('INSERT INTO evidence(submission_id,file,name,mime) VALUES(?,?,?,?)').run(id, f.filename, f.originalname, f.mimetype));
  flash(req, 'Submitted for IGEN verification.'); res.redirect('/submission/' + id);
});
function subDetail(s, ev, logs) {
  return `<h3>#${s.id} ${h(s.title)} <span class="tag">${s.status}</span></h3><p><b>${s.category}) ${h(s.aname)}</b>${s.own_idea ? ' · Own idea: ' + h(s.own_idea) : ''}<br>
Participant: ${h(s.uname)} · Date: ${h(s.impl_date)} · Location: ${h(s.location)} · Beneficiaries: ${s.beneficiaries} ${h(s.product)}<br>SDGs: ${h(s.sdgs) || '–'} · Panchabhutas: ${h(s.pancha) || '–'}</p>
<p>${h(s.description)}</p>${s.before_after ? `<p><b>Before/after:</b> ${h(s.before_after)}</p>` : ''}${s.outcome ? `<p><b>Outcome:</b> ${h(s.outcome)}</p>` : ''}
<div>${ev.map(e => /^image/.test(e.mime) ? `<a href="/evidence/${e.id}"><img src="/evidence/${e.id}" style="max-width:220px;margin:4px;border-radius:6px"></a>` : /^video/.test(e.mime) ? `<video src="/evidence/${e.id}" controls style="max-width:260px"></video>` : `<a href="/evidence/${e.id}">📄 ${h(e.name)}</a>`).join(' ')}</div>
<h4>Review history</h4><ul>${logs.map(l => `<li>${l.at} – <b>${l.decision}</b> by ${h(l.rname)}: ${h(l.comments)}</li>`).join('') || '<li>None yet</li>'}</ul>`;
}
const loadSub = id => db.prepare('SELECT s.*,a.name aname,a.category,u.name uname FROM submissions s JOIN activities a ON a.id=s.activity_id JOIN users u ON u.id=s.user_id WHERE s.id=?').get(id);
const evOf = id => db.prepare('SELECT * FROM evidence WHERE submission_id=?').all(id);
const logsOf = id => db.prepare('SELECT r.*,u.name rname FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE submission_id=? ORDER BY r.id').all(id);
app.get('/submission/:id', login, (req, res) => {
  const s = loadSub(+req.params.id); if (!s || (s.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).send('Not found');
  render(req, res, 'Submission', `<div class="card">${subDetail(s, evOf(s.id), logsOf(s.id))}${s.status === 'Correction Required' ? `<h4>Resubmit with corrections</h4>
<form method="post" action="/submission/${s.id}/resubmit" enctype="multipart/form-data"><label>Updated description<textarea name="description" rows="3">${h(s.description)}</textarea></label>
<label>Extra evidence<input type="file" name="evidence" multiple accept="image/*,video/mp4,application/pdf"></label><br><button>Resubmit</button></form>` : ''}</div>`);
});
app.post('/submission/:id/resubmit', login, upload, (req, res) => {
  const s = loadSub(+req.params.id); if (!s || s.user_id !== req.user.id || s.status !== 'Correction Required') return res.status(403).send('Not allowed');
  db.prepare("UPDATE submissions SET description=?,status='Resubmitted' WHERE id=?").run(req.body.description || s.description, s.id);
  (req.files || []).forEach(f => db.prepare('INSERT INTO evidence(submission_id,file,name,mime) VALUES(?,?,?,?)').run(s.id, f.filename, f.originalname, f.mimetype));
  flash(req, 'Resubmitted for review.'); res.redirect('/submission/' + s.id);
});
app.get('/evidence/:id', login, (req, res) => { // private: owner or IGEN reviewers only
  const e = db.prepare('SELECT e.*,s.user_id FROM evidence e JOIN submissions s ON s.id=e.submission_id WHERE e.id=?').get(+req.params.id);
  if (!e || (e.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).send('Not found');
  res.type(e.mime).sendFile(path.join(UP, e.file));
});
app.get('/certificate', login, (req, res) => {
  const ok = db.prepare("SELECT 1 FROM submissions WHERE user_id=? AND status='Approved'").get(req.user.id); if (!ok) return res.status(403).send('No approved action yet.');
  const org = req.user.org_id && db.prepare('SELECT name FROM organisations WHERE id=?').get(req.user.org_id);
  res.send(`<!doctype html><title>Certificate</title><body style="font-family:Georgia,serif;text-align:center;border:12px double #17692f;margin:2rem;padding:3rem">
<h1 style="color:#0f5a2a">IGEN GREENDAY 2026</h1><h2>Recognition &amp; Certification</h2><p>This is to certify that</p><h1>${h(req.user.name)}</h1>${org ? `<p>of ${h(org.name)}</p>` : ''}
<p>has successfully implemented and had verified a Green Action as part of <b>#Act4Green</b> – “Hammer the Heat, Defend 1.5°C”.</p><p>Certificate No: IGD26-${String(req.user.id).padStart(6, '0')}</p>
<button onclick="print()">Print / Save PDF</button></body>`);
});

/* ---------- Organisation coordinator ---------- */
const orgOf = u => db.prepare('SELECT * FROM organisations WHERE coordinator_id=?').get(u.id);
app.get('/org', login, (req, res) => {
  const o = orgOf(req.user); if (!o) return res.redirect('/orgs/register');
  const me = board().find(r => r.id === o.id), mem = memberRows(o.id);
  const cnt = st => db.prepare('SELECT COUNT(*) n FROM submissions WHERE org_id=? AND status IN (' + st.map(() => '?').join() + ')').get(o.id, ...st).n;
  render(req, res, 'Organisation', `<h2>${h(o.name)} <span class="tag">${o.status}</span></h2>
<div class="card">Organisation ID / invitation code: <b>${o.code}</b><br>Invitation link: <code>${BASE_URL}/join/${o.code}</code>${o.status !== 'Approved' ? '<p>Awaiting IGEN approval. Members can join once approved.</p>' : ''}</div>
<div class="grid"><div class="card"><div class="num">${me ? me.rank : '–'}</div>Current rank</div><div class="card"><div class="num">${me ? me.vp : 0}</div>Verified participants</div>
<div class="card"><div class="num">${cnt(['Approved'])}</div>Approved</div><div class="card"><div class="num">${cnt(['Submitted', 'Under Review', 'Resubmitted'])}</div>Pending</div><div class="card"><div class="num">${cnt(['Rejected'])}</div>Rejected</div></div>
<div class="card"><h3>Members (verification is done by IGEN only)</h3><a class="btn alt" href="/org/export.csv">Export CSV</a><div class="tw"><table><tr><th>Name</th><th>Type</th><th>Dept</th><th>Category</th><th>Approved</th><th>Pending</th></tr>
${mem.map(m => `<tr><td>${h(m.name)}</td><td>${h(m.ptype)}</td><td>${h(m.dept)}</td><td>${h(m.cat)}</td><td>${m.ap}</td><td>${m.pe}</td></tr>`).join('') || '<tr><td colspan=6>No members yet.</td></tr>'}</table></div></div>`);
});
const memberRows = oid => db.prepare(`SELECT u.name,u.ptype,u.dept,
 (SELECT group_concat(DISTINCT a.category) FROM submissions s JOIN activities a ON a.id=s.activity_id WHERE s.user_id=u.id) cat,
 (SELECT COUNT(*) FROM submissions WHERE user_id=u.id AND status='Approved') ap,
 (SELECT COUNT(*) FROM submissions WHERE user_id=u.id AND status IN ('Submitted','Under Review','Resubmitted')) pe FROM users u WHERE u.org_id=?`).all(oid);
app.get('/org/export.csv', login, (req, res) => {
  const o = orgOf(req.user); if (!o) return res.status(403).send('Coordinators only');
  res.type('text/csv').attachment('members.csv').send(csv([['Name', 'Type', 'Dept', 'Category', 'Approved', 'Pending'], ...memberRows(o.id).map(m => [m.name, m.ptype, m.dept, m.cat, m.ap, m.pe])]));
});

/* ---------- IGEN administrator / verifier ---------- */
app.get('/admin', adminOnly, (req, res) => {
  const s = stats(), orgs = db.prepare("SELECT * FROM organisations ORDER BY status='Pending' DESC, id DESC").all();
  const queue = db.prepare(`SELECT s.*,a.name aname,a.category,u.name uname FROM submissions s JOIN activities a ON a.id=s.activity_id JOIN users u ON u.id=s.user_id WHERE s.status IN ('Submitted','Under Review','Resubmitted') ORDER BY s.created_at`).all();
  const audit = db.prepare('SELECT r.*,u.name rname FROM reviews r JOIN users u ON u.id=r.reviewer_id ORDER BY r.id DESC LIMIT 15').all();
  render(req, res, 'Admin', `<h2>IGEN Administration</h2><div class="grid"><div class="card"><div class="num">${s.orgs}</div>Approved orgs</div><div class="card"><div class="num">${s.vp}</div>Verified participants</div>
<div class="card"><div class="num">${s.aa}</div>Approved actions</div><div class="card"><div class="num">${queue.length}</div>In verification queue</div></div>
<div class="card"><h3>Verification queue</h3>${subsTable(queue, true)}<a class="btn alt" href="/admin/export.csv">Export approved actions (CSV)</a></div>
<div class="card"><h3>Organisations</h3><div class="tw"><table><tr><th>ID</th><th>Name</th><th>Type</th><th>Coordinator</th><th>Status</th><th>Action</th></tr>${orgs.map(o => `<tr><td>${o.code}</td><td>${h(o.name)}<br><small>${h(o.city)}, ${h(o.country)}</small></td><td>${o.type}</td><td>${h(o.coordinator_name)}<br><small>${h(o.email)}</small></td><td><span class="tag">${o.status}</span></td>
<td>${['Approved', 'Rejected', 'Suspended'].filter(x => x !== o.status).map(x => `<form class="inline" method="post" action="/admin/org/${o.id}"><input type="hidden" name="status" value="${x}"><button class="${x === 'Approved' ? '' : 'red'}">${x}</button></form>`).join(' ')}</td></tr>`).join('')}</table></div></div>
<div class="card"><h3>Audit log (latest)</h3><ul>${audit.map(l => `<li>${l.at} · #${l.submission_id} · <b>${l.decision}</b> · ${h(l.rname)} · ${h(l.comments)}</li>`).join('') || '<li>No reviews yet</li>'}</ul></div>`);
});
app.post('/admin/org/:id', adminOnly, (req, res) => {
  if (['Approved', 'Rejected', 'Suspended', 'Pending'].includes(req.body.status)) db.prepare('UPDATE organisations SET status=? WHERE id=?').run(req.body.status, +req.params.id);
  back(req, res, 'Organisation updated.');
});
app.get('/admin/review/:id', adminOnly, (req, res) => {
  let s = loadSub(+req.params.id); if (!s) return res.status(404).send('Not found');
  if (['Submitted', 'Resubmitted'].includes(s.status)) { db.prepare("UPDATE submissions SET status='Under Review' WHERE id=?").run(s.id); s.status = 'Under Review'; }
  render(req, res, 'Review', `<div class="card">${subDetail(s, evOf(s.id), logsOf(s.id))}<form method="post"><label>Decision${sel('decision', ['Approved', 'Correction Required', 'Rejected'])}</label>
<label>Comments${s.status === 'Approved' ? ' (required – changing an approved record is audited)' : ''}<textarea name="comments" rows="3"></textarea></label><br><button>Record decision</button></form></div>`);
});
app.post('/admin/review/:id', adminOnly, (req, res) => {
  const s = loadSub(+req.params.id), d = req.body.decision, c = (req.body.comments || '').trim();
  if (!s || !['Approved', 'Correction Required', 'Rejected'].includes(d)) return back(req, res, 'Invalid decision.');
  if ((s.status === 'Approved' || d !== 'Approved') && !c) return back(req, res, 'Comments are required for this decision.');
  db.transaction(() => {
    db.prepare('UPDATE submissions SET status=?, approved_at=CASE WHEN ?=\'Approved\' THEN datetime(\'now\') ELSE NULL END WHERE id=?').run(d, d, s.id);
    db.prepare('INSERT INTO reviews(submission_id,reviewer_id,decision,comments) VALUES(?,?,?,?)').run(s.id, req.user.id, d, c);
  })();
  flash(req, 'Decision recorded.'); res.redirect('/admin');
});
app.get('/admin/export.csv', adminOnly, (req, res) => {
  const r = db.prepare(`SELECT s.id,o.name org,u.name uname,u.email,a.category,a.name aname,s.title,s.impl_date,s.location,s.beneficiaries,s.product,s.sdgs,s.pancha,s.outcome
    FROM submissions s JOIN users u ON u.id=s.user_id JOIN activities a ON a.id=s.activity_id LEFT JOIN organisations o ON o.id=s.org_id WHERE s.status='Approved'`).all();
  res.type('text/csv').attachment('approved_actions.csv').send(csv([['ID', 'Organisation', 'Participant', 'Email', 'Category', 'Activity', 'Title', 'Date', 'Location', 'Beneficiaries', 'Product', 'SDGs', 'Panchabhutas', 'Outcome'], ...r.map(x => Object.values(x))]));
});

app.listen(PORT, () => console.log(`IGEN GREENDAY 2026 running at ${BASE_URL}`));
