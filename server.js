'use strict';
/**
 * 家庭医学存档 Family Medical Archive
 * 零依赖：仅使用 Node.js 内置模块（http / fs / crypto / node:sqlite）
 * 单用户密码登录，支持病历记录、影像附件（图/PDF/视频在线预览）、复诊提醒。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('[启动失败] 当前 Node.js 缺少内置 node:sqlite 模块。');
  console.error('  请安装 Node.js v23.4 或更高版本（推荐 v24 LTS）：https://nodejs.org/');
  console.error('  若使用 v22.5 ~ v23.3，请改用: node --experimental-sqlite server.js');
  process.exit(1);
}

/* ================= 配置 ================= */
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'archive.db');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_JSON = 1024 * 1024;                                   // JSON 请求体上限 1MB
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD || 200 * 1024 * 1024); // 上传文件上限，默认 200MB
const AI_MAX_BODY = Number(process.env.AI_MAX_BODY || 15 * 1024 * 1024); // AI 分析文件上限，默认 15MB
const AI_TIMEOUT = Number(process.env.AI_TIMEOUT || 120000);    // AI 请求超时
const SESSION_TTL_S = 7 * 24 * 60 * 60;                         // 会话有效期 7 天（滑动续期）
const COOKIE_NAME = 'fma_session';
const APP_VERSION = '0.6'; // 功能迭代每次推送 +0.1，与页脚展示一致
const CATEGORIES = ['就诊记录', '检查报告', '诊断分析', '用药记录', '手术记录', '疫苗接种', '体检报告', '其他'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ================= 数据库 ================= */
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  gender      TEXT NOT NULL DEFAULT '',
  birth_date  TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  category        TEXT NOT NULL DEFAULT '就诊记录',
  title           TEXT NOT NULL,
  visit_date      TEXT NOT NULL DEFAULT '',
  hospital        TEXT NOT NULL DEFAULT '',
  doctor          TEXT NOT NULL DEFAULT '',
  chief_complaint TEXT NOT NULL DEFAULT '',
  findings        TEXT NOT NULL DEFAULT '',
  diagnosis       TEXT NOT NULL DEFAULT '',
  treatment       TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  next_visit_date TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER REFERENCES members(id) ON DELETE CASCADE,
  record_id     INTEGER REFERENCES records(id) ON DELETE SET NULL,
  stored_name   TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL DEFAULT 0,
  description   TEXT NOT NULL DEFAULT '',
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_records_member ON records(member_id);
CREATE INDEX IF NOT EXISTS idx_files_member ON files(member_id);
CREATE INDEX IF NOT EXISTS idx_files_record ON files(record_id);
`);

// 旧库升级：为已存在的数据库补充 findings（检查所见/报告原文）列
try { db.exec("ALTER TABLE records ADD COLUMN findings TEXT NOT NULL DEFAULT ''"); } catch { /* 列已存在，无需升级 */ }

const stmtCache = new Map();
function q(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const getSetting = (k) => { const r = q('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

/* ================= 密码（scrypt 哈希存储） ================= */
function setPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  setSetting('password_hash', JSON.stringify({ salt, hash }));
}
function verifyPassword(plain) {
  const raw = getSetting('password_hash');
  if (!raw) return false;
  try {
    const { salt, hash } = JSON.parse(raw);
    const calc = crypto.scryptSync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
    const known = Buffer.from(hash, 'hex');
    return known.length === calc.length && crypto.timingSafeEqual(known, calc);
  } catch { return false; }
}
const hasPassword = () => !!getSetting('password_hash');

/* ================= 会话（HMAC 签名 Cookie） ================= */
function sessionSecret() {
  let s = getSetting('session_secret');
  if (!s) { s = crypto.randomBytes(48).toString('hex'); setSetting('session_secret', s); }
  return s;
}
function sign(payload) { return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url'); }
function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_S * 1000 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const got = Buffer.from(token.slice(i + 1));
  const expect = Buffer.from(sign(payload));
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url')).exp > Date.now(); } catch { return false; }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* 忽略非法编码 */ } }
  });
  return out;
}
function sessionCookie(token) {
  const max = token ? SESSION_TTL_S : 0;
  return `${COOKIE_NAME}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${max}`;
}
function isAuthed(req) { return verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]); }

/* ================= 登录限速（每 IP 连续错 5 次锁 15 分钟） ================= */
const fails = new Map();
function clientIp(req) { return req.socket.remoteAddress || 'unknown'; }
function isLocked(ip) { const f = fails.get(ip); return !!(f && f.until > Date.now()); }
function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  fails.set(ip, f);
}
const clearFails = (ip) => fails.delete(ip);

/* ================= 工具函数 ================= */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const httpError = (status, msg) => new HttpError(status, msg);

function sendJSON(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders || {}),
  });
  res.end(body);
}
function sendText(res, status, text) {
  const body = Buffer.from(String(text));
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(httpError(413, '内容超过大小限制'));
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(httpError(413, '内容超过大小限制')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'JSON 格式错误'); }
}
async function readJsonBig(req) {
  const buf = await readBody(req, AI_MAX_BODY);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'JSON 格式错误'); }
}
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const cleanStr = (v, max) => String(v ?? '').trim().slice(0, max);
const validDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.dcm': 'application/dicom', '.zip': 'application/zip',
};
const mimeFromExt = (ext) => MIME[String(ext || '').toLowerCase()] || '';

/* ================= 业务查询 ================= */
const MEMBER_SELECT = `
SELECT m.*,
  (SELECT COUNT(*) FROM records r WHERE r.member_id = m.id) AS record_count,
  (SELECT COUNT(*) FROM files f WHERE f.member_id = m.id) AS file_count,
  (SELECT COALESCE(MAX(COALESCE(NULLIF(r.visit_date,''), r.created_at)), '') FROM records r WHERE r.member_id = m.id) AS last_activity
FROM members m`;

function getMember(id) { return q(MEMBER_SELECT + ' WHERE m.id=?').get(id); }
function listMembers() { return q(MEMBER_SELECT + ' ORDER BY m.id').all(); }

function listRecords(u) {
  const where = [];
  const params = [];
  const memberId = toId(u.searchParams.get('member_id'));
  if (memberId) { where.push('r.member_id = ?'); params.push(memberId); }
  const cat = cleanStr(u.searchParams.get('category'), 20);
  if (cat) { where.push('r.category = ?'); params.push(cat); }
  const qs = cleanStr(u.searchParams.get('q'), 100);
  if (qs) {
    where.push('(r.title LIKE ? OR r.hospital LIKE ? OR r.doctor LIKE ? OR r.diagnosis LIKE ? OR r.treatment LIKE ? OR r.notes LIKE ? OR r.chief_complaint LIKE ? OR m.name LIKE ?)');
    const like = `%${qs}%`;
    for (let i = 0; i < 8; i++) params.push(like);
  }
  const sql = `SELECT r.*, m.name AS member_name,
    (SELECT COUNT(*) FROM files f WHERE f.record_id = r.id) AS file_count
    FROM records r JOIN members m ON m.id = r.member_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(NULLIF(r.visit_date,''), r.created_at) DESC, r.id DESC LIMIT 500`;
  return q(sql).all(...params);
}

function getRecord(id) {
  const r = q(`SELECT r.*, m.name AS member_name FROM records r JOIN members m ON m.id = r.member_id WHERE r.id=?`).get(id);
  if (!r) throw httpError(404, '记录不存在');
  return r;
}
function recordFiles(recordId) {
  return q('SELECT * FROM files WHERE record_id=? ORDER BY id').all(recordId);
}

function listFiles(u) {
  const where = [];
  const params = [];
  const memberId = toId(u.searchParams.get('member_id'));
  if (memberId) { where.push('f.member_id = ?'); params.push(memberId); }
  const qs = cleanStr(u.searchParams.get('q'), 100);
  if (qs) { where.push('(f.original_name LIKE ? OR f.description LIKE ?)'); const like = `%${qs}%`; params.push(like, like); }
  const sql = `SELECT f.*, m.name AS member_name, r.title AS record_title
    FROM files f LEFT JOIN members m ON m.id = f.member_id LEFT JOIN records r ON r.id = f.record_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY f.id DESC LIMIT 1000`;
  return q(sql).all(...params);
}

function recordInput(b, existing) {
  const memberId = toId(b.member_id ?? existing?.member_id);
  if (!memberId || !q('SELECT id FROM members WHERE id=?').get(memberId)) throw httpError(400, '所属成员不存在');
  const title = cleanStr(b.title, 200);
  if (!title) throw httpError(400, '标题不能为空');
  let category = cleanStr(b.category, 20);
  if (!CATEGORIES.includes(category)) category = '就诊记录';
  return {
    member_id: memberId, category, title,
    visit_date: validDate(b.visit_date), hospital: cleanStr(b.hospital, 100), doctor: cleanStr(b.doctor, 50),
    chief_complaint: cleanStr(b.chief_complaint, 2000), findings: cleanStr(b.findings, 20000),
    diagnosis: cleanStr(b.diagnosis, 4000),
    treatment: cleanStr(b.treatment, 4000), notes: cleanStr(b.notes, 10000),
    next_visit_date: validDate(b.next_visit_date),
  };
}

function overview() {
  const upcoming = q(`SELECT r.id, r.title, r.member_id, r.next_visit_date, r.hospital, m.name AS member_name
    FROM records r JOIN members m ON m.id = r.member_id
    WHERE r.next_visit_date != '' ORDER BY r.next_visit_date ASC LIMIT 50`).all();
  const recent = q(`SELECT r.*, m.name AS member_name,
    (SELECT COUNT(*) FROM files f WHERE f.record_id = r.id) AS file_count
    FROM records r JOIN members m ON m.id = r.member_id
    ORDER BY COALESCE(NULLIF(r.visit_date,''), r.created_at) DESC, r.id DESC LIMIT 10`).all();
  return { members: listMembers(), upcoming, recent };
}

/* ================= 上传（流式写盘） ================= */
function handleUpload(req, res, u) {
  const memberId = toId(u.searchParams.get('member_id'));
  if (!memberId || !q('SELECT id FROM members WHERE id=?').get(memberId)) return sendJSON(res, 400, { error: '所属成员不存在' });
  const recordId = toId(u.searchParams.get('record_id'));
  if (recordId) {
    const r = q('SELECT id, member_id FROM records WHERE id=?').get(recordId);
    if (!r || r.member_id !== memberId) return sendJSON(res, 400, { error: '关联记录不存在或不属于该成员' });
  }
  const description = cleanStr(u.searchParams.get('description'), 500);
  let original = '';
  try { original = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { original = ''; }
  original = path.basename(String(original).replace(/[\\/]+/g, '_')).trim().slice(0, 200) || '未命名文件';
  const extMatch = /\.([A-Za-z0-9]{1,10})$/.exec(original);
  const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  const fp = path.join(UPLOAD_DIR, stored);
  const ws = fs.createWriteStream(fp);
  let size = 0, finished = false;
  const fail = (code, msg) => {
    if (finished) return;
    finished = true;
    try { ws.destroy(); } catch { /* 已关闭 */ }
    try { fs.unlinkSync(fp); } catch { /* 可能未创建 */ }
    try { sendJSON(res, code, { error: msg }); } catch { /* 连接已断开 */ }
  };
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) { fail(413, '文件超过大小限制'); req.destroy(); }
  });
  req.on('error', () => fail(500, '上传中断'));
  ws.on('error', () => fail(500, '写入文件失败'));
  req.on('end', () => {
    if (finished) return;
    finished = true;
    let mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = mimeFromExt(ext);
    const info = q('INSERT INTO files(member_id, record_id, stored_name, original_name, mime_type, size, description) VALUES(?,?,?,?,?,?,?)')
      .run(memberId, recordId, stored, original, mime || 'application/octet-stream', size, description);
    sendJSON(res, 200, { ok: true, id: Number(info.lastInsertRowid), original_name: original, size });
  });
  req.pipe(ws);
}

/* ================= 文件下载 / 在线预览（支持 Range 断点） ================= */
function handleFile(req, res, u) {
  const id = toId(u.pathname.split('/').pop());
  const row = id && q('SELECT * FROM files WHERE id=?').get(id);
  if (!row) return sendJSON(res, 404, { error: '文件不存在' });
  const fp = path.join(UPLOAD_DIR, row.stored_name);
  let stat;
  try { stat = fs.statSync(fp); } catch { return sendJSON(res, 404, { error: '文件已丢失，请删除该记录' }); }
  const type = row.mime_type || 'application/octet-stream';
  // 仅媒体/文档类允许 inline 预览；HTML 等可在浏览器执行的类型一律强制下载，防存储型 XSS
  const inlineOk = /^(image\/|video\/|audio\/|application\/pdf\b|text\/plain\b)/.test(type);
  const disposition = (u.searchParams.get('download') || !inlineOk ? 'attachment' : 'inline') + `; filename*=UTF-8''${encodeURIComponent(row.original_name)}`;
  const base = {
    'Content-Type': type,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  };
  // SVG 可含脚本，单独收紧
  if (type === 'image/svg+xml') base['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...base, 'Content-Length': stat.size });
    return res.end();
  }
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (m) {
    let s = m[1] === '' ? null : Number(m[1]);
    let e = m[2] === '' ? null : Number(m[2]);
    if (s === null && e !== null) { s = Math.max(0, stat.size - e); e = stat.size - 1; }
    else { if (s === null) s = 0; if (e === null || e >= stat.size) e = stat.size - 1; }
    if (s <= e && s < stat.size) {
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${s}-${e}/${stat.size}`, 'Content-Length': e - s + 1 });
      return fs.createReadStream(fp, { start: s, end: e }).pipe(res);
    }
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(200, { ...base, 'Content-Length': stat.size });
  fs.createReadStream(fp).pipe(res);
}

function deleteFileRow(id) {
  const row = q('SELECT stored_name FROM files WHERE id=?').get(id);
  if (!row) throw httpError(404, '文件不存在');
  q('DELETE FROM files WHERE id=?').run(id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, row.stored_name)); } catch { /* 文件可能已不在 */ }
}

/* ================= 静态资源 ================= */
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
function serveStatic(req, res, u) {
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { p = '/'; }
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (fp !== PUBLIC_DIR && !fp.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, '禁止访问');
  // index.html 注入当前版本号到静态资源 URL（?v=x.y），每次发版自动绕过浏览器/CDN 缓存
  const sendIndex = (err, buf) => {
    if (err) return sendText(res, 404, '未找到');
    const b = Buffer.from(String(buf).replaceAll('@@V', APP_VERSION));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' });
    res.end(b);
  };
  fs.readFile(fp, (err, buf) => {
    if (err) {
      // 非文件路径回退到 SPA 首页
      if (!path.extname(p)) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), sendIndex);
      return sendText(res, 404, '未找到');
    }
    if (p.endsWith('/index.html')) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), sendIndex);
    const type = STATIC_TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type, 'Content-Length': buf.length,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache',
    };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

/* ================= AI 智能导入（OpenAI 兼容接口，零依赖 fetch） ================= */
const AI_PROMPT = `你是一名严谨的家庭医疗档案录入助手。用户会提供一份医疗相关资料（报告图片、PDF提取文本、检查单照片、网上问诊对话截图等），请从中提取结构化信息。
输出要求：只输出一个 JSON 对象，不要输出任何解释、前后缀或代码块标记。
字段定义：
- member_name: 患者姓名（资料中明确写出时填写，否则留空字符串；若姓名被脱敏（如"张*三"）或存在疑似错字，原样输出）
- category: 必须恰好是以下之一："就诊记录","检查报告","诊断分析","用药记录","手术记录","疫苗接种","体检报告","其他"
- title: 简明标题，建议"机构+项目"格式，例如"某市人民医院 乳腺超声检查"（必填）
- exam_item: 报告/检查项目简称，如"乳腺超声检查""钼靶X检查""血常规"（必填，用于文件命名）
- visit_date: 就诊/检查日期，格式 YYYY-MM-DD，无法确定留空
- hospital: 医院/机构/互联网医院平台名称
- doctor: 医生姓名
- chief_complaint: 主诉、检查或咨询项目
- findings: 报告正文原文转录（重要，尽量完整）：先一行患者信息（性别、年龄、门诊号/检查号/住院号等），再逐段转录"超声所见/影像所见/检验结果/检查结果"等正文，保留原文表述、数值与单位，不要改写、概括或省略数据；不要以"所见字段：""字段："等元信息标签或"根据资料…"等引语开头，直接从内容本身写起
- diagnosis: 诊断结论，保留关键术语（如 BI-RADS 分级、疾病名称）
- treatment: 处理意见、用药、手术或随访建议
- notes: 报告主要所见 / 对话要点等补充信息（简洁分点）
- next_visit_date: 明确提到的复诊/复查日期，格式 YYYY-MM-DD，否则留空
如果内容是乱码、空白、或与医疗健康完全无关，输出 {"error":"原因简述"}，并省略其他字段。
【字段分工，禁止重复】各字段不得互相复述同一内容：findings 只放描述性内容（所见、数值、异常项明细）；diagnosis 只写结论性判断（1-3 句，如分级、疾病名），禁止重复 findings 中的描述；treatment 只写行动建议（用药/复查/就诊科室），不复述诊断；notes 只写其他补充，无内容留空。同一句话不得出现在多个字段。`;

function aiConfig() {
  return { base: (getSetting('ai_base') || '').trim(), model: (getSetting('ai_model') || '').trim(), key: getSetting('ai_key') || '' };
}

async function aiChat(messages, o = {}) {
  const base = (o.base !== undefined ? o.base : aiConfig().base || '').trim();
  const model = (o.model !== undefined ? o.model : aiConfig().model || '').trim();
  const key = o.key !== undefined ? o.key : aiConfig().key;
  if (!base || !model) throw httpError(400, '尚未配置 AI 服务，请先在“设置 → AI 服务配置”中填写接口地址与模型');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || AI_TIMEOUT);
  let res;
  try {
    res = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model, messages, temperature: 0.1 }),
      signal: ctrl.signal,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? '请求超时（模型响应过慢）' : e.message;
    throw httpError(502, '无法连接 AI 服务：' + msg);
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw httpError(401, 'AI 服务商拒绝了请求：API Key 无效或无权限（' + res.status + '）');
    const msg = (data && data.error && data.error.message) || text.slice(0, 200) || ('HTTP ' + res.status);
    throw httpError(502, 'AI 服务返回错误 ' + res.status + '：' + msg);
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) throw httpError(502, 'AI 服务未返回有效内容');
  return content;
}

/* 提取 AI 回复中的 JSON（容忍代码块围栏、前后说明文字、字符串内未转义的换行等控制字符） */
function extractJson(content) {
  let s = String(content).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  // 同时支持对象 {} 与数组 []（多患者拆分时 AI 返回数组）
  const iObj = s.indexOf('{'), jObj = s.lastIndexOf('}');
  const iArr = s.indexOf('['), jArr = s.lastIndexOf(']');
  let body = null;
  if (iArr >= 0 && (iObj < 0 || iArr < iObj) && jArr > iArr) body = s.slice(iArr, jArr + 1);
  else if (iObj >= 0 && jObj > iObj) body = s.slice(iObj, jObj + 1);
  if (!body) throw httpError(502, 'AI 返回内容无法解析为结构化数据');
  try { return JSON.parse(body); }
  catch { /* 部分模型会在字符串值里输出未转义换行，尝试修复 */ }
  let out = '', inStr = false, esc = false;
  for (const ch of body) {
    if (esc) { out += ch; esc = false; continue; }
    if (inStr && ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') { out += '\\r'; continue; }
    if (inStr && ch === '\t') { out += '\\t'; continue; }
    if (inStr && ch < ' ') { continue; }
    out += ch;
  }
  try { return JSON.parse(out); }
  catch { throw httpError(502, 'AI 返回的 JSON 格式异常，请重试或更换模型'); }
}

/* 极简 PDF 文本提取（尽力而为：FlateDecode 解压 + Tj/TJ 字符串），扫描件/特殊编码会失败 */
function extractPdfText(buf) {
  const zlib = require('zlib');
  const raw = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw)) && out.length < 20000) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    re.lastIndex = end + 9;
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    let data = chunk;
    try { data = zlib.inflateSync(chunk); } catch { /* 未压缩流 */ }
    const s = data.toString('latin1');
    const textRe = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>/g;
    let t;
    while ((t = textRe.exec(s))) {
      if (t[1] !== undefined) {
        out.push(t[1].replace(/\\([nrtbf()\\])/g, ( _, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] || '')));
      } else if (t[2] && t[2].replace(/\s/g, '').length % 2 === 0) {
        const bytes = Buffer.from(t[2].replace(/\s/g, ''), 'hex');
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
          for (let i2 = 0; i2 + 1 < bytes.length; i2 += 2) { const b = bytes[i2]; bytes[i2] = bytes[i2 + 1]; bytes[i2 + 1] = b; }
          out.push(bytes.toString('utf16le'));
        } else {
          out.push(bytes.toString('latin1'));
        }
      }
    }
  }
  return out.join(' ').replace(/[ \t]+/g, ' ').trim();
}

function sanitizeAiFields(f) {
  const g = (k, max) => cleanStr(f && f[k], max);
  let category = g('category', 20);
  if (!CATEGORIES.includes(category)) {
    if (/用药|处方/.test(category)) category = '用药记录';
    else if (/手术/.test(category)) category = '手术记录';
    else if (/疫苗|接种/.test(category)) category = '疫苗接种';
    else if (/体检/.test(category)) category = '体检报告';
    else if (/检查|报告|影像|超声|CT|MR|X光|钼靶|病理|检验/.test(category)) category = '检查报告';
    else if (/诊断|分析/.test(category)) category = '诊断分析';
    else category = '就诊记录';
  }
  const source_files = Array.isArray(f && f.source_files)
    ? f.source_files.slice(0, 20).map((s) => cleanStr(s, 200)).filter(Boolean) : [];
  return {
    member_name: g('member_name', 50),
    category,
    title: g('title', 200) || '未命名记录',
    exam_item: g('exam_item', 60),
    visit_date: validDate(f && f.visit_date),
    hospital: g('hospital', 100),
    doctor: g('doctor', 50),
    chief_complaint: g('chief_complaint', 2000),
    findings: g('findings', 20000),
    diagnosis: g('diagnosis', 4000),
    treatment: g('treatment', 4000),
    notes: g('notes', 10000),
    next_visit_date: validDate(f && f.next_visit_date),
    source_files,
  };
}

/* 多页报告：分批识别提示词（输出纯文本中间结果） */
const AI_PAGES_PROMPT = `你是一名严谨的医疗档案录入助手。用户提供了一份医疗资料（体检报告/住院病历/检查报告/报告截图等）的全部或部分页面图片。
请逐页（或就单张图片）提取关键内容，输出清晰的纯文本（不要输出 JSON）：
- 患者信息（【必查项】姓名、性别、年龄、体检号/门诊号等）：仔细查看每页的页眉、页脚、标题栏、报告头和信息表格——患者姓名几乎总在其中；姓名可能被脱敏为"张*三"形式，请原样转录，不要猜测补全，也不要省略
- 每页的科室/项目名称与主要结果：保留数值、单位、参考范围
- 明确标注异常项（↑/↓/超标/阳性等提示），不要遗漏任何异常
- 各页的结论与医生建议（如有医生书面意见请完整保留原文）
如果某页是封面、导检单、须知或广告等无医疗价值内容，注明"（无有效内容）"即可。不要编造未出现的信息。直接输出内容本身，不要使用"××字段""如下"等元信息标签或前缀。`;

/* 汇总提示词：把分批/分件的识别结果合并为一份病历 */
const AI_CONSOLIDATE_PROMPT = `你是一名严谨的家庭医疗档案录入助手。以下是对同一位患者医疗资料的识别文本——可能是一份多页报告的分批识别结果，也可能是多份检查报告/影像报告/问诊截图各自的识别结果（每段标注了来源文件）。请把它们汇总为"一份"病历记录。
汇总要求：
- 合并重复的患者信息；不同资料的项目与日期不同时，在内容中分别注明。
- 【重要】诊断结论与处理建议**优先采用资料中医生书面给出的意见**（可注明来源文件）；只有当资料中没有医生意见时，才由你根据检查所见撰写规范的诊断描述与随访建议，不得虚构。
- 异常项按科室/系统归类列出（保留数值与参考范围）。
- 【多患者拆分】如果资料涉及**多位患者**（识别文本中的姓名明显不同），必须输出一个 JSON **数组**，每位患者一条记录（字段同下），并每条额外包含 source_files 字段（字符串数组，列出属于该患者的来源文件名，必须与【文件：…】标注中的文件名完全一致）。只有一位患者时输出单个 JSON 对象，不需要 source_files。
- findings 输出整理后的核心内容：个人信息 + 各资料结果要点 + 异常项汇总 + 医生意见，分节分点保证可读性，不要逐字堆砌；内容全面完整、准确，但不要出现"××字段"等元信息标签或"根据资料…"等引语，直接写内容本身。
- 只输出一个 JSON 对象（或多人时的 JSON 数组），不要输出任何解释、前后缀或代码块标记。字段定义：
- member_name: 患者姓名（脱敏如"张*三"或疑似错字时原样输出，由系统负责匹配档案；各段开头的【文件：…】文件名中也可能含姓名线索）
- category: 必须恰好是以下之一："就诊记录","检查报告","诊断分析","用药记录","手术记录","疫苗接种","体检报告","其他"（多资料合并时按主要内容选，整册体检选"体检报告"）
- title: 简明标题，建议"机构+项目"，多资料合并时概括为主要检查（必填）
- exam_item: 报告/检查项目简称（如"乳腺超声检查""钼靶X检查""年度体检"），用于文件命名（必填）
- visit_date: 主要就诊/检查日期，格式 YYYY-MM-DD，无法确定留空
- hospital: 医院/体检机构名称
- doctor: 医生姓名（如有）
- chief_complaint: 就诊原因或检查项目
- findings: 按上述汇总要求整理的核心内容
- diagnosis: 诊断结论（优先医生原意见）
- treatment: 处理与随访建议（优先医生原意见）
- notes: 补充说明（资料构成、未检项目等）
- next_visit_date: 明确的复查/复诊日期，格式 YYYY-MM-DD，否则留空
【字段分工，禁止重复】各字段不得互相复述同一内容：findings 只放描述性汇总（各资料结果要点、异常项明细）；diagnosis 只写结论性判断（1-3 句，如"尿酸升高；轻度脂肪肝"），禁止重复 findings 中的描述；treatment 只写行动建议（复查项目与时间、就诊科室），不复述诊断；notes 只写补充说明（资料构成、未检项等），无内容留空。同一句话不得出现在多个字段。`;

async function handleAiAnalyze(req, res, u) {
  const cfg = aiConfig();
  if (!cfg.base || !cfg.model) throw httpError(400, '尚未配置 AI 服务，请先在“设置 → AI 服务配置”中完成配置');
  const textMode = !!(u && u.searchParams.get('text') === '1'); // 多文件合并流程：只提取文本，不做结构化
  const buf = await readBody(req, AI_MAX_BODY);
  let original = '';
  try { original = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { original = ''; }
  original = path.basename(String(original).replace(/[\\/]+/g, '_')).trim().slice(0, 200) || '未命名文件';
  let mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = mimeFromExt(path.extname(original));
  const srcNameHint = original !== '未命名文件'
    ? `\n资料文件名：${original}（文件名中可能包含患者姓名、日期、检查项目等线索，可与资料内容交叉参考；与资料内容冲突时以资料为准）`
    : '';
  let parts;
  if (/^image\//.test(mime)) {
    const prompt = (textMode
      ? AI_PAGES_PROMPT + '\n本次仅这一份资料（单张图片）。'
      : AI_PROMPT) + srcNameHint;
    parts = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } },
    ];
  } else if (mime === 'application/pdf' || /\.pdf$/i.test(original)) {
    const text = extractPdfText(buf);
    if (text.length < 10) throw httpError(422, 'PDF 中未能提取到文字（可能是扫描件或特殊编码）。请把报告页面截图为图片后再用 AI 导入。');
    parts = [{ type: 'text', text: (textMode ? AI_PAGES_PROMPT : AI_PROMPT) + srcNameHint + '\n\n--- 以下是 PDF 提取文本 ---\n' + text.slice(0, 20000) }];
  } else if (/^text\//.test(mime) || /^(application\/(json|xml))/.test(mime) || /\.(txt|md|csv|json|log|html?)$/i.test(original)) {
    parts = [{ type: 'text', text: (textMode ? AI_PAGES_PROMPT : AI_PROMPT) + srcNameHint + '\n\n--- 以下是文件文本 ---\n' + buf.toString('utf8').slice(0, 20000) }];
  } else {
    throw httpError(415, '暂不支持该文件类型的 AI 识别（支持：图片 / PDF / 文本文件）。视频等资料请用「添加资料 → 手工录入」上传。');
  }
  const content = await aiChat([{ role: 'user', content: parts }]);
  if (textMode) return sendJSON(res, 200, { text: content.slice(0, 60000) });
  const parsed = extractJson(content);
  if (parsed && parsed.error) throw httpError(422, 'AI 无法识别该资料：' + cleanStr(parsed.error, 300));
  sendJSON(res, 200, { fields: sanitizeAiFields(parsed), model: cfg.model });
}

/* ================= API 路由 ================= */
async function handleApi(req, res, u) {
  const method = req.method;
  const p = u.pathname.slice(4); // 去掉 /api
  const seg = p.split('/').filter(Boolean);

  // 免登录接口
  if (p === '/status' && method === 'GET') {
    const memberGate = Number(q('SELECT COUNT(*) c FROM members').get().c) > 0;
    return sendJSON(res, 200, { version: APP_VERSION, needSetup: !hasPassword(), authed: isAuthed(req), memberGate });
  }
  if (p === '/setup' && method === 'POST') {
    if (hasPassword()) throw httpError(403, '密码已设置，如需修改请登录后在设置页操作');
    const b = await readJson(req);
    const pw = String(b.password || '');
    if (pw.length < 6) throw httpError(400, '密码至少 6 位');
    setPassword(pw);
    res.setHeader('Set-Cookie', sessionCookie(issueToken()));
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/login' && method === 'POST') {
    if (isLocked(clientIp(req))) throw httpError(429, '尝试次数过多，请 15 分钟后再试');
    if (!hasPassword()) throw httpError(400, '尚未设置密码');
    const b = await readJson(req);
    // 双因子：密码 + 任一档案成员完整姓名；错误合并提示防试探；无成员时（初装）跳过姓名校验防锁死
    const gateOn = Number(q('SELECT COUNT(*) c FROM members').get().c) > 0;
    const nameOk = !gateOn || !!q('SELECT id FROM members WHERE name=?').get(String(b.member_name || '').trim());
    if (!verifyPassword(String(b.password || '')) || !nameOk) {
      recordFail(clientIp(req));
      throw httpError(401, gateOn ? '密码或档案成员姓名不正确' : '密码错误');
    }
    clearFails(clientIp(req));
    res.setHeader('Set-Cookie', sessionCookie(issueToken()));
    return sendJSON(res, 200, { ok: true });
  }

  // 以下接口一律需要登录
  if (!isAuthed(req)) throw httpError(401, '未登录或会话已过期');
  res.setHeader('Set-Cookie', sessionCookie(issueToken())); // 滑动续期

  if (p === '/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', sessionCookie(null));
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/change-password' && method === 'POST') {
    const b = await readJson(req);
    if (!verifyPassword(String(b.current || ''))) throw httpError(401, '当前密码不正确');
    const pw = String(b.next || '');
    if (pw.length < 6) throw httpError(400, '新密码至少 6 位');
    setPassword(pw);
    setSetting('session_secret', crypto.randomBytes(48).toString('hex')); // 旋转密钥，使所有旧会话失效
    sessionSecret();
    res.setHeader('Set-Cookie', sessionCookie(issueToken()));
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/overview' && method === 'GET') return sendJSON(res, 200, overview());
  if (p === '/export' && method === 'GET') {
    const data = {
      exported_at: new Date().toISOString(),
      members: q('SELECT * FROM members ORDER BY id').all(),
      records: q('SELECT * FROM records ORDER BY id').all(),
      files: q('SELECT id, member_id, record_id, original_name, mime_type, size, description, uploaded_at FROM files ORDER BY id').all(),
    };
    const body = Buffer.from(JSON.stringify(data, null, 2));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('医学存档导出-' + new Date().toISOString().slice(0, 10) + '.json')}`,
    });
    return res.end(body);
  }

  /* ----- 成员 ----- */
  if (p === '/members') {
    if (method === 'GET') return sendJSON(res, 200, listMembers());
    if (method === 'POST') {
      const b = await readJson(req);
      const name = cleanStr(b.name, 50);
      if (!name) throw httpError(400, '姓名不能为空');
      const info = q('INSERT INTO members(name, gender, birth_date, relationship, notes) VALUES(?,?,?,?,?)')
        .run(name, cleanStr(b.gender, 10), validDate(b.birth_date), cleanStr(b.relationship, 30), cleanStr(b.notes, 1000));
      return sendJSON(res, 200, getMember(Number(info.lastInsertRowid)));
    }
  }
  if (seg[0] === 'members' && seg[1]) {
    const id = toId(seg[1]);
    const member = id && getMember(id);
    if (!member) throw httpError(404, '成员不存在');
    if (method === 'GET') return sendJSON(res, 200, member);
    if (method === 'PUT') {
      const b = await readJson(req);
      const name = cleanStr(b.name, 50);
      if (!name) throw httpError(400, '姓名不能为空');
      q('UPDATE members SET name=?, gender=?, birth_date=?, relationship=?, notes=? WHERE id=?')
        .run(name, cleanStr(b.gender, 10), validDate(b.birth_date), cleanStr(b.relationship, 30), cleanStr(b.notes, 1000), id);
      return sendJSON(res, 200, getMember(id));
    }
    if (method === 'DELETE') {
      const filesOnDisk = q('SELECT stored_name FROM files WHERE member_id=?').all(id);
      q('DELETE FROM members WHERE id=?').run(id); // 级联删除其 records 与 files 行
      filesOnDisk.forEach((f) => { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name)); } catch { /* 忽略 */ } });
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* ----- 病历记录 ----- */
  if (p === '/records') {
    if (method === 'GET') return sendJSON(res, 200, listRecords(u));
    if (method === 'POST') {
      const r = recordInput(await readJson(req));
      const info = q(`INSERT INTO records(member_id, category, title, visit_date, hospital, doctor, chief_complaint, findings, diagnosis, treatment, notes, next_visit_date)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.member_id, r.category, r.title, r.visit_date, r.hospital, r.doctor, r.chief_complaint, r.findings, r.diagnosis, r.treatment, r.notes, r.next_visit_date);
      return sendJSON(res, 200, getRecord(Number(info.lastInsertRowid)));
    }
  }
  if (seg[0] === 'records' && seg[1]) {
    const id = toId(seg[1]);
    const existing = id && q('SELECT * FROM records WHERE id=?').get(id);
    if (!existing) throw httpError(404, '记录不存在');
    if (method === 'GET') return sendJSON(res, 200, { record: getRecord(id), files: recordFiles(id) });
    if (method === 'PUT') {
      const r = recordInput(await readJson(req), existing);
      q(`UPDATE records SET member_id=?, category=?, title=?, visit_date=?, hospital=?, doctor=?, chief_complaint=?, findings=?, diagnosis=?, treatment=?, notes=?, next_visit_date=?, updated_at=datetime('now','localtime') WHERE id=?`)
        .run(r.member_id, r.category, r.title, r.visit_date, r.hospital, r.doctor, r.chief_complaint, r.findings, r.diagnosis, r.treatment, r.notes, r.next_visit_date, id);
      return sendJSON(res, 200, getRecord(id));
    }
    if (method === 'DELETE') {
      q('DELETE FROM records WHERE id=?').run(id); // 附件的 record_id 自动置空，文件保留
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* ----- 文件 ----- */
  if (p === '/files' && method === 'GET') return sendJSON(res, 200, listFiles(u));
  if (p === '/upload' && method === 'POST') return handleUpload(req, res, u);
  if (seg[0] === 'files' && seg[1]) {
    const id = toId(seg[1]);
    const row = id && q('SELECT * FROM files WHERE id=?').get(id);
    if (!row) throw httpError(404, '文件不存在');
    if (method === 'GET') return sendJSON(res, 200, row);
    if (method === 'PUT') {
      const b = await readJson(req);
      if (b.description !== undefined) q('UPDATE files SET description=? WHERE id=?').run(cleanStr(b.description, 500), id);
      if (b.original_name !== undefined) {
        // 重命名仅改展示/下载名（磁盘存的是 stored_name）；清掉路径符与换行，未写扩展名时保留原扩展名
        let name = String(b.original_name || '').replace(/[\\/:*?"<>|\r\n]+/g, '').replace(/\s+/g, ' ').trim();
        if (!name) throw httpError(400, '文件名称不能为空');
        if (name.length > 200) name = name.slice(0, 200);
        const ext = (row.original_name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
        if (ext && !/\.[A-Za-z0-9]{1,8}$/.test(name)) name += ext;
        q('UPDATE files SET original_name=? WHERE id=?').run(name, id);
      }
      if (b.record_id !== undefined) {
        const rid = toId(b.record_id);
        if (rid) {
          const r = q('SELECT id, member_id FROM records WHERE id=?').get(rid);
          if (!r || r.member_id !== row.member_id) throw httpError(400, '该记录不属于此成员');
          q('UPDATE files SET record_id=? WHERE id=?').run(rid, id);
        } else {
          q('UPDATE files SET record_id=NULL WHERE id=?').run(id);
        }
      }
      return sendJSON(res, 200, q('SELECT * FROM files WHERE id=?').get(id));
    }
    if (method === 'DELETE') { deleteFileRow(id); return sendJSON(res, 200, { ok: true }); }
  }

  /* ----- AI 智能导入 ----- */
  if (seg[0] === 'ai') {
    if (seg[1] === 'config') {
      if (method === 'GET') {
        const c = aiConfig();
        return sendJSON(res, 200, {
          configured: !!(c.base && c.model),
          base: c.base, model: c.model,
          key_masked: c.key ? c.key.slice(0, 3) + '***' + c.key.slice(-4) : '',
        });
      }
      if (method === 'PUT') {
        const b = await readJson(req);
        setSetting('ai_base', cleanStr(b.base, 300));
        setSetting('ai_model', cleanStr(b.model, 100));
        if (b.clear_key) setSetting('ai_key', '');
        else if (typeof b.key === 'string' && b.key.trim()) setSetting('ai_key', b.key.trim().slice(0, 300));
        const c = aiConfig();
        return sendJSON(res, 200, { configured: !!(c.base && c.model), base: c.base, model: c.model, key_masked: c.key ? c.key.slice(0, 3) + '***' + c.key.slice(-4) : '' });
      }
    }
    if (seg[1] === 'test' && method === 'POST') {
      const b = await readJson(req);
      const base = cleanStr(b.base, 300) || aiConfig().base;
      const model = cleanStr(b.model, 100) || aiConfig().model;
      const key = (typeof b.key === 'string' && b.key.trim()) ? b.key.trim() : aiConfig().key;
      if (!base || !model) throw httpError(400, '请先填写接口地址与模型名称');
      const reply = await aiChat([{ role: 'user', content: '连通性测试，请只回复两个字母：OK' }], { base, model, key, timeoutMs: 25000 });
      return sendJSON(res, 200, { ok: true, reply: reply.slice(0, 60) });
    }
    if (seg[1] === 'analyze' && method === 'POST') return handleAiAnalyze(req, res, u);
    if (seg[1] === 'analyze-pages' && method === 'POST') {
      const b = await readJsonBig(req);
      const pages = Array.isArray(b.pages) ? b.pages.filter((p) => typeof p === 'string' && p.length > 16).slice(0, 20) : [];
      if (!pages.length) throw httpError(400, '缺少页面数据');
      const start = Number(b.start) || 1;
      const total = Number(b.total) || pages.length;
      const srcName = cleanStr(b.name, 200);
      const nameHint = srcName
        ? `\n来源文件名：${srcName}（文件名中可能包含患者姓名、日期、检查项目等线索，可与页面内容交叉参考；与页面内容冲突时以页面为准）`
        : '';
      const prompt = AI_PAGES_PROMPT + nameHint + `\n本批为第 ${start} 至 ${start + pages.length - 1} 页（全册共 ${total} 页）。`;
      const parts = [{ type: 'text', text: prompt }]
        .concat(pages.map((p) => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + p } })));
      const out = await aiChat([{ role: 'user', content: parts }]);
      return sendJSON(res, 200, { text: out.slice(0, 60000) });
    }
    if (seg[1] === 'consolidate' && method === 'POST') {
      const b = await readJsonBig(req);
      const texts = Array.isArray(b.texts) ? b.texts.filter((t) => typeof t === 'string' && t.trim()).slice(0, 20) : [];
      if (!texts.length) throw httpError(400, '缺少识别内容');
      const name = cleanStr(b.name, 100) || '体检报告';
      const prompt = AI_CONSOLIDATE_PROMPT.replace('{NAME}', name)
        + '\n\n--- 分批识别内容 ---\n'
        + texts.map((t, i) => `【第 ${i + 1} 批】\n${t.slice(0, 20000)}`).join('\n\n');
      const out = await aiChat([{ role: 'user', content: prompt }]);
      const parsed = extractJson(out);
      if (Array.isArray(parsed)) {
        // 多患者：AI 返回数组，每人一条记录
        const recs = parsed.filter((x) => x && typeof x === 'object' && !x.error).slice(0, 10).map((x) => sanitizeAiFields(x));
        if (!recs.length) throw httpError(422, 'AI 未返回有效的汇总结果');
        return sendJSON(res, 200, { records: recs, model: aiConfig().model });
      }
      if (parsed && parsed.error) throw httpError(422, 'AI 无法汇总该报告：' + cleanStr(parsed.error, 300));
      return sendJSON(res, 200, { fields: sanitizeAiFields(parsed), model: aiConfig().model });
    }
  }

  throw httpError(404, '接口不存在');
}

/* ================= HTTP 服务 ================= */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.on('finish', () => {
    if (u.pathname.startsWith('/api') || u.pathname.startsWith('/file')) {
      console.log(`${new Date().toLocaleString()} ${req.method} ${u.pathname} -> ${res.statusCode}`);
    }
  });
  Promise.resolve()
    .then(async () => {
      if (u.pathname.startsWith('/api/')) {
        try { await handleApi(req, res, u); }
        catch (e) { sendJSON(res, e instanceof HttpError ? e.status : 500, { error: e.message || '服务器内部错误' }); }
        return;
      }
      if (u.pathname.startsWith('/file/')) {
        if (!isAuthed(req)) return sendJSON(res, 401, { error: '未登录' });
        return handleFile(req, res, u);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, u);
      return sendText(res, 405, '方法不允许');
    })
    .catch((e) => { try { sendText(res, 500, '服务器内部错误'); } catch { /* 已响应 */ } console.error('未捕获错误:', e); });
});

server.listen(PORT, HOST, () => {
  const line = '='.repeat(58);
  console.log(line);
  console.log('  家庭医学存档已启动  v' + APP_VERSION);
  console.log('  本机访问:  http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((k) => nets[k].forEach((n) => {
    if (n.family === 'IPv4' && !n.internal) console.log('  局域网:    http://' + n.address + ':' + PORT);
  }));
  if (!hasPassword()) console.log('  [提示] 尚未设置密码，首次打开网页时会引导你创建管理密码');
  console.log('  数据目录:  ' + DATA_DIR);
  console.log('  停止服务:  Ctrl+C');
  console.log(line);
});
