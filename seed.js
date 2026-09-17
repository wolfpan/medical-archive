'use strict';
/**
 * 演示数据导入脚本（不含任何真实医疗信息）
 * 用法:  node seed.js [资料目录] [成员姓名]
 *   - 把指定目录下的图片/PDF/视频等文件导入为指定成员（默认"示例成员"）的附件
 *   - 每个文件自动创建一条"示例记录"，可登录后在网页中编辑或删除
 * 可重复运行，已导入的文件会自动跳过。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {
  console.error('[错误] 需要 Node.js v23.4+（内置 node:sqlite）。');
  process.exit(1);
}

const SRC = path.resolve(process.argv[2] || '.');
const MEMBER_NAME = process.argv[3] || '示例成员';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'archive.db');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, gender TEXT DEFAULT '',
  birth_date TEXT DEFAULT '', relationship TEXT DEFAULT '', notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  category TEXT DEFAULT '就诊记录', title TEXT NOT NULL, visit_date TEXT DEFAULT '',
  hospital TEXT DEFAULT '', doctor TEXT DEFAULT '', chief_complaint TEXT DEFAULT '',
  findings TEXT DEFAULT '', diagnosis TEXT DEFAULT '', treatment TEXT DEFAULT '',
  notes TEXT DEFAULT '', next_visit_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  record_id INTEGER REFERENCES records(id) ON DELETE SET NULL,
  stored_name TEXT NOT NULL, original_name TEXT NOT NULL,
  mime_type TEXT DEFAULT 'application/octet-stream', size INTEGER DEFAULT 0,
  description TEXT DEFAULT '', uploaded_at TEXT DEFAULT (datetime('now','localtime')));
`);

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.txt': 'text/plain', '.json': 'application/json',
};

console.log('家庭医学存档 · 演示数据导入');
console.log('资料目录: ' + SRC);

let member = db.prepare('SELECT id FROM members WHERE name=?').get(MEMBER_NAME);
if (member) {
  console.log('  [跳过] 成员已存在: ' + MEMBER_NAME);
} else {
  const r = db.prepare('INSERT INTO members(name, notes) VALUES(?,?)')
    .run(MEMBER_NAME, '演示数据，可在网页中编辑或删除');
  member = { id: Number(r.lastInsertRowid) };
  console.log('  [新建] 成员：' + MEMBER_NAME);
}

const files = fs.readdirSync(SRC).filter((f) => {
  const ext = path.extname(f).toLowerCase();
  return MIME[ext] && !f.startsWith('.');
});
if (!files.length) {
  console.log('  目录中没有可导入的文件（支持 ' + Object.keys(MIME).join(' ') + '）');
}
for (const name of files) {
  const already = db.prepare('SELECT id FROM files WHERE member_id=? AND original_name=?').get(member.id, name);
  if (already) { console.log('  [跳过] 已导入: ' + name); continue; }
  const buf = fs.readFileSync(path.join(SRC, name));
  const ext = path.extname(name).toLowerCase();
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  const rec = db.prepare('INSERT INTO records(member_id, category, title, visit_date) VALUES(?,?,?,?)')
    .run(member.id, '就诊记录', '示例记录：' + path.basename(name, ext), '');
  db.prepare('INSERT INTO files(member_id, record_id, stored_name, original_name, mime_type, size, description) VALUES(?,?,?,?,?,?,?)')
    .run(member.id, Number(rec.lastInsertRowid), stored, name, MIME[ext], buf.length, '演示导入');
  console.log(`  [导入] ${name}（${(buf.length / 1024).toFixed(0)} KB）`);
}

const counts = {
  members: db.prepare('SELECT COUNT(*) c FROM members').get().c,
  records: db.prepare('SELECT COUNT(*) c FROM records').get().c,
  files: db.prepare('SELECT COUNT(*) c FROM files').get().c,
};
console.log(`导入完成：成员 ${counts.members}，病历 ${counts.records}，附件 ${counts.files}。`);
console.log('启动服务后打开网页即可查看（首次打开需先设置管理密码）。');
