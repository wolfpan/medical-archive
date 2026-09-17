'use strict';
/**
 * 忘记密码时使用：清除已设置的密码与所有登录会话，
 * 之后重新打开网页会进入“初始化系统”页面，可设置新密码。
 * 用法:  node reset-password.js
 */
const path = require('path');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {
  console.error('[错误] 需要 Node.js v23.4+（内置 node:sqlite）。');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, 'data', 'archive.db');
try {
  const db = new DatabaseSync(DB_PATH);
  db.exec("DELETE FROM settings WHERE key IN ('password_hash', 'session_secret')");
  console.log('[完成] 管理密码已重置，所有登录会话已失效。');
  console.log('请重新打开网页（或刷新），按提示设置新的管理密码。');
  console.log('注意：病历与附件数据不受影响。');
} catch (e) {
  console.error('[失败] 无法打开数据库：' + e.message);
  console.error('请确认在项目目录下运行本脚本，且 data/archive.db 存在。');
}
