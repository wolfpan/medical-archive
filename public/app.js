'use strict';
/* 家庭医学存档 — 前端单页应用（无框架、无内联事件，配合服务端 CSP） */
const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast-root');

const CATEGORIES = ['就诊记录', '检查报告', '诊断分析', '用药记录', '手术记录', '疫苗接种', '体检报告', '其他'];
const S = { authed: false, needSetup: false, memberGate: false, version: '', members: [], previewList: [], previewIdx: 0, confirmCb: null, q: '', aiQueue: [], needRouteRefresh: false, consult: null, consultCtrl: null };

/* ---------- 工具 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nlbr = (s) => esc(s).replace(/\n/g, '<br>');
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function daysUntil(dateStr) { return Math.round((new Date(dateStr + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000); }
function ageStr(birth) { if (!birth) return ''; const d = daysUntil(birth); if (Number.isNaN(d)) return ''; const age = Math.floor(-d / 365.25); return age >= 0 && age < 130 ? age + '岁' : ''; }
function fmtDateShort(s) { return s ? s.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2') : ''; }

/* ---------- 成员名智能匹配（脱敏 张*三 / AI 错字 李四→李思） ---------- */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function matchMember(raw) {
  const name = String(raw || '').trim();
  if (!name || !S.members.length) return null;
  const exact = S.members.find((m) => m.name === name);
  if (exact) return { member: exact, how: 'exact' };
  // 脱敏姓名（含 * × ✱）：按通配符匹配，唯一命中才采用
  if (/[*×✱]/.test(name)) {
    const pat = name.split('').map((ch) => (/[*×✱]/.test(ch) ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    const re = new RegExp('^' + pat + '$');
    const hits = S.members.filter((m) => re.test(m.name));
    if (hits.length === 1) return { member: hits[0], how: 'masked' };
  }
  // AI 错字：编辑距离唯一最近且在阈值内（短名≤1，长名≤2）
  const maxD = name.length <= 3 ? 1 : 2;
  let best = null, bestD = Infinity, tie = false;
  for (const m of S.members) {
    const d = levenshtein(name, m.name);
    if (d > 0 && d <= maxD) {
      if (d < bestD) { best = m; bestD = d; tie = false; }
      else if (d === bestD) tie = true;
    }
  }
  if (best && !tie) return { member: best, how: 'fuzzy' };
  return null;
}

/* ---------- 附件自动命名：时间 + 项目 + 机构 + 姓名 ---------- */
/* 机构名简化：去掉"XX大学（医学院）附属"等前缀，如 中山大学附属第一医院 → 第一医院、北京大学深圳医院 → 深圳医院；深圳人民医院龙华分院保持不变 */
function simplifyHospital(name) {
  let s = String(name || '').trim();
  s = s.replace(/^.{0,20}?(?:大学|学院)(?:医学院)?附属(?=[^\s]{2,})/, '');
  const m = s.match(/^[^\s]{0,15}大学(?=[^\s]*医院)(.+)$/);
  if (m && m[1].length >= 3) s = m[1];
  return s;
}
function buildAttachName(fields, memberName, file) {
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '').replace(/\s+/g, ' ').trim();
  const date = (fields.visit_date || '').replace(/-/g, '');
  const proj = clean(fields.exam_item) || clean(fields.title) || '资料';
  const parts = [date || '日期未注明', proj, simplifyHospital(clean(fields.hospital)), clean(memberName)].filter(Boolean);
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
  return parts.join(' ') + ext;
}
function fileKind(mime, name) {
  const m = String(mime || '');
  if (/^image\//.test(m)) return 'IMG';
  if (/^video\//.test(m)) return 'VIDEO';
  if (/^audio\//.test(m)) return 'AUDIO';
  if (m === 'application/pdf' || /\.pdf$/i.test(name || '')) return 'PDF';
  if (/word|excel|msword|spreadsheet/.test(m)) return 'DOC';
  return 'FILE';
}
function toast(msg, ok = true) {
  const el = document.createElement('div');
  el.className = 'toast' + (ok ? '' : ' err');
  el.textContent = msg;
  $toast.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (res.status === 401) {
    S.authed = false;
    if (!['#/login', '#/setup'].includes(location.hash)) location.hash = '#/login';
    throw new Error(data.error || '请先登录');
  }
  if (!res.ok) throw new Error(data.error || '请求失败 ' + res.status);
  return data;
}

/* ---------- 布局 ---------- */
function layout(content, active) {
  $app.innerHTML = `
  <header class="topbar"><div class="topbar-inner">
    <a class="brand" href="#/"><span class="brand-dot">+</span>家庭医学存档</a>
    <nav class="nav">
      <a href="#/" class="${active === 'home' ? 'active' : ''}">首页</a>
      <a href="#/records" class="${active === 'records' ? 'active' : ''}">病历记录</a>
      <a href="#/files" class="${active === 'files' ? 'active' : ''}">影像资料</a>
      <a href="#/consult" class="${active === 'consult' ? 'active' : ''}">AI 问诊</a>
      <a href="#/add" class="cta ${active === 'add' ? 'active' : ''}">添加病历或资料</a>
    </nav>
    <form class="searchbar" id="global-search"><input name="q" placeholder="搜索病历 / 诊断 / 医院…" value="${esc(S.q)}"><button class="btn" type="submit">搜索</button></form>
    <button type="button" class="nav-toggle" data-action="toggle-nav" aria-label="菜单" aria-expanded="false"><span></span><span></span><span></span></button>
  </div></header>
  <main class="container">${content}</main>
  <footer class="site-footer">
    <a href="#/settings">设置</a>
    <span class="sep">·</span>
    <button type="button" class="link" data-action="logout">退出登录</button>
    <span class="sep">·</span>
    <a href="https://github.com/wolfpan/medical-archive" target="_blank" rel="noopener">GitHub 开源</a>
    <span class="sep">·</span>
    <span class="muted">V${esc(S.version)}</span>
  </footer>`;
}
/* 空状态：加号可点，默认直达「添加病历或资料」页 */
const empty = (t, href = '#/add', title = '添加病历或资料') => `<div class="empty"><a class="empty-icon" href="${href}" title="${esc(title)}">+</a><p>${t}</p></div>`;
const catBadge = (c) => `<span class="badge" data-cat="${esc(c)}">${esc(c)}</span>`;

/* ---------- 首页 ---------- */
function reminderHtml(list) {
  if (!list.length) return '';
  const rows = list.map((r) => {
    const d = daysUntil(r.next_visit_date);
    const cls = d < 0 ? 'overdue' : d <= 30 ? 'soon' : 'later';
    const label = d < 0 ? `已逾期 ${-d} 天` : d === 0 ? '今天' : `${d} 天后`;
    return `<div class="reminder-row">
      <span class="pill ${cls}">${label}</span>
      <span class="reminder-date">${esc(r.next_visit_date)}</span>
      <a href="#/record/${r.id}"><b>${esc(r.title)}</b></a>
      <span class="muted small">${esc(r.member_name)}${r.hospital ? ' · ' + esc(r.hospital) : ''}</span>
      <a class="link" href="#/consult/new?member_id=${r.member_id}&record_ids=${r.id}&auto=1&auto_q=${encodeURIComponent('复诊日期是 ' + r.next_visit_date + '。请基于这份报告提醒我就诊前要注意什么、要向医生问哪些问题。')}">问 AI</a>
    </div>`;
  }).join('');
  return `<h2 class="sec-title">复诊提醒</h2><div class="card reminder-card">${rows}</div>`;
}
function memberCard(m) {
  const age = ageStr(m.birth_date);
  const tags = [];
  if (m.relationship) tags.push(esc(m.relationship));
  if (age) tags.push(age);
  const stats = [`<span>${m.record_count} 条记录</span>`, `<span>${m.file_count} 份文件</span>`];
  if (m.last_activity) stats.push(`<span>最近 ${esc(fmtDateShort(m.last_activity))}</span>`);
  return `<a class="card member-card" href="#/member/${m.id}">
    <div class="avatar">${esc((m.name || '?').slice(-1))}</div>
    <div class="member-info">
      <div class="member-name">${esc(m.name)}${m.gender ? `<span class="gender-tag">${esc(m.gender)}</span>` : ''}</div>
      ${tags.length ? `<div class="member-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>` : ''}
      <div class="member-stats">${stats.join('')}</div>
    </div>
  </a>`;
}
function recordRow(r) {
  const vd = r.visit_date || r.created_at?.slice(0, 10) || '';
  const [y, mo, d] = vd.split('-');
  const md = mo && d ? mo + '/' + d : (d || '');
  const nextCls = r.next_visit_date ? (daysUntil(r.next_visit_date) < 0 ? 'overdue' : daysUntil(r.next_visit_date) <= 30 ? 'soon' : 'later') : '';
  return `<a class="card record-row" href="#/record/${r.id}">
    <div class="date-block"><span class="d-day">${md}</span><span class="d-ym">${y || ''}</span></div>
    <div class="record-main">
      <div class="record-title">${catBadge(r.category)} ${esc(r.title)}</div>
      <div class="muted small">${esc(r.member_name)}${r.hospital ? ' · ' + esc(r.hospital) : ''}${r.file_count ? ' · 附件 ' + r.file_count + ' 份' : ''}</div>
      ${r.diagnosis ? `<div class="muted small clamp">${esc(r.diagnosis)}</div>` : ''}
    </div>
    ${r.next_visit_date ? `<span class="pill ${nextCls}">复诊 ${esc(r.next_visit_date)}</span>` : ''}
  </a>`;
}

async function viewDashboard() {
  const ov = await api('/api/overview');
  layout(`
    ${reminderHtml(ov.upcoming)}
    <h2 class="sec-title">家庭成员</h2>
    <div class="grid members-grid">${ov.members.map(memberCard).join('') || empty('还没有家庭成员，到 <a href="#/settings">设置 → 家庭成员管理</a> 中添加', '#/settings', '家庭成员管理')}</div>
    <h2 class="sec-title">最近记录</h2>
    <div class="card-list">${ov.recent.map(recordRow).join('') || empty('暂无病历记录')}</div>
  `, 'home');
}

/* ---------- 成员页 ---------- */
async function viewMember(id) {
  const [mem, records, files] = await Promise.all([
    api('/api/members/' + id),
    api('/api/records?member_id=' + id),
    api('/api/files?member_id=' + id),
  ]);
  const byYear = {};
  records.forEach((r) => {
    const y = (r.visit_date || r.created_at || '').slice(0, 4) || '其他';
    (byYear[y] = byYear[y] || []).push(r);
  });
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  S.previewList = files;
  const age = ageStr(mem.birth_date);
  layout(`
    <div class="page-head">
      <div class="row" style="gap:14px">
        <div class="avatar" style="width:56px;height:56px;font-size:24px">${esc((mem.name || '?').slice(-1))}</div>
        <div>
          <h1 style="display:flex;gap:10px;align-items:center">${esc(mem.name)}${mem.gender ? `<span class="gender-tag">${esc(mem.gender)}</span>` : ''}</h1>
          <div class="muted small">${esc(mem.relationship || '')}${age ? (mem.relationship ? ' · ' : '') + age : ''}${mem.birth_date ? ' · ' + esc(mem.birth_date) : ''} · ${mem.record_count} 条记录 · ${mem.file_count} 份文件</div>
          ${mem.notes ? `<div class="muted small">${esc(mem.notes)}</div>` : ''}
        </div>
      </div>
      <div class="row no-print">
        <a class="btn" href="#/consult/new?member_id=${mem.id}">AI 问诊</a>
        <a class="btn" href="#/consult/new?member_id=${mem.id}&kind=trends&auto=1">健康趋势</a>
        <a class="btn" href="#/consult/new?member_id=${mem.id}&kind=visit-prep&auto=1">复诊准备</a>
        <button class="btn" data-action="open-member-form" data-id="${mem.id}">编辑资料</button>
      </div>
    </div>
    <h2 class="sec-title">病历记录</h2>
    ${records.length ? years.map((y) => `
      <div class="year-group"><h4>${esc(y)} 年（${byYear[y].length} 条）</h4>
      <div class="card-list">${byYear[y].map(recordRow).join('')}</div></div>`).join('') : empty('该成员暂无病历记录。点上方加号上传报告，由 AI 整理成病历')}
    <h2 class="sec-title">影像与附件</h2>
    ${files.length ? `<div class="grid files-grid">${files.map(fileCard).join('')}</div>` : empty('暂无文件。点上方加号可上传检查图片、PDF 报告或影像视频')}
  `, 'records');
}

/* ---------- 病历列表 / 搜索 ---------- */
async function viewRecords(qs) {
  const params = new URLSearchParams();
  const mid = qs.get('member_id') || ''; const cat = qs.get('category') || ''; const q = qs.get('q') || ''; const range = qs.get('range') || '';
  S.q = q;
  if (mid) params.set('member_id', mid);
  if (cat) params.set('category', cat);
  if (q) params.set('q', q);
  if (range) params.set('range', range);
  const records = await api('/api/records' + (params.toString() ? '?' + params : ''));
  layout(`
    ${q ? `<div class="page-head"><span class="muted">搜索“${esc(q)}”的结果</span></div>` : ''}
    <form id="record-filters" class="card filter-bar">
      <div class="form-grid-3">
        <label>成员<select name="member_id" data-autosubmit><option value="">全部成员</option>${S.members.map((m) => `<option value="${m.id}" ${String(mid) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <label>分类<select name="category" data-autosubmit><option value="">全部分类</option>${CATEGORIES.map((c) => `<option ${cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>时间范围<select name="range" data-autosubmit>
          <option value="">全部时间</option>
          <option value="3m" ${range === '3m' ? 'selected' : ''}>近 3 个月</option>
          <option value="6m" ${range === '6m' ? 'selected' : ''}>近半年</option>
          <option value="1y" ${range === '1y' ? 'selected' : ''}>近一年</option>
          <option value="2y" ${range === '2y' ? 'selected' : ''}>近 2 年</option>
        </select></label>
      </div>
    </form>
    <div class="card-list">${records.map(recordRow).join('') || empty('没有符合条件的记录')}</div>
  `, 'records');
}

/* ---------- 病历详情 ---------- */
function detailSec(title, content) {
  return content ? `<div class="detail-sec"><h3>${title}</h3><p>${nlbr(content)}</p></div>` : '';
}
async function viewRecord(id) {
  const { record: r, files } = await api('/api/records/' + id);
  S.previewList = files;
  const nextPill = r.next_visit_date
    ? `<span class="pill ${daysUntil(r.next_visit_date) < 0 ? 'overdue' : 'soon'}">下次复诊：${esc(r.next_visit_date)}</span>` : '';
  layout(`
    <div class="record-detail card print-area">
      <div class="record-head no-print">
        <a href="#/records" class="small">&larr; 返回列表</a>
        <div class="row">
          <a class="btn primary" href="#/consult/new?member_id=${r.member_id}&record_ids=${r.id}&auto=1">AI 解读</a>
          <button class="btn" data-action="open-record-form" data-id="${r.id}">编辑</button>
          <button class="btn" data-action="manage-attachments" data-record="${r.id}">管理附件</button>
          <button class="btn" data-action="print-record">打印</button>
        </div>
      </div>
      <h1>${catBadge(r.category)} ${esc(r.title)}</h1>
      <div class="muted" style="margin:8px 0 16px">
        <a href="#/member/${r.member_id}">${esc(r.member_name)}</a>
        · 就诊 ${esc(r.visit_date || '未填日期')} ${r.hospital ? '· ' + esc(r.hospital) : ''} ${r.doctor ? '· ' + esc(r.doctor) + ' 医生' : ''}
        ${nextPill}
      </div>
      <div class="meta-grid">
        <div><div class="k">就诊日期</div>${esc(r.visit_date || '—')}</div>
        <div><div class="k">医院 / 科室</div>${esc(r.hospital || '—')}</div>
        <div><div class="k">医生</div>${esc(r.doctor || '—')}</div>
        <div><div class="k">下次复诊</div>${esc(r.next_visit_date || '—')}</div>
      </div>
      ${detailSec('主诉 / 检查项目', r.chief_complaint)}
      ${detailSec('检查所见 / 报告原文', r.findings)}
      ${detailSec('诊断结果', r.diagnosis)}
      ${detailSec('处理与治疗', r.treatment)}
      ${detailSec('备注与分析', r.notes)}
      <div class="detail-sec no-print">
        <h3>附件（${files.length}）</h3>
        ${files.length ? `<div class="grid files-grid">${files.map(fileCard).join('')}</div>` : `<p class="muted small">暂无附件。可到顶部「添加病历或资料」上传，或点上方"管理附件"关联已有文件。</p>`}
      </div>
    </div>
  `, 'records');
}

/* ---------- 文件页 ---------- */
function fileCard(f, idx) {
  const kind = fileKind(f.mime_type, f.original_name);
  const thumb = kind === 'IMG'
    ? `<img loading="lazy" src="/file/${f.id}" alt="">`
    : `<span class="thumb-icon ti-${kind}">${kind === 'VIDEO' ? '视频' : kind === 'AUDIO' ? '音频' : kind}</span>`;
  return `<div class="card file-card">
    <button class="file-thumb" data-action="preview" data-idx="${idx ?? f.__idx}" title="预览">${thumb}</button>
    <div class="file-meta">
      <div class="file-name" title="${esc(f.original_name)}">${esc(f.original_name)}</div>
      <div class="muted small">${fmtSize(f.size)} · ${esc(fmtDateShort(f.uploaded_at))} · ${esc(f.member_name || '')}</div>
      ${f.description ? `<div class="muted small clamp">${esc(f.description)}</div>` : ''}
      ${f.record_title ? `<a class="small" href="#/record/${f.record_id}">关联：${esc(f.record_title)}</a>` : ''}
      <div class="row small file-actions">
        <button class="link" data-action="edit-file" data-id="${f.id}">编辑</button>
        <a class="link" href="/file/${f.id}?download=1">下载</a>
      </div>
    </div>
  </div>`;
}
async function viewFiles(qs) {
  const mid = qs.get('member_id') || ''; const q = qs.get('q') || ''; const range = qs.get('range') || '';
  S.q = '';
  const params = new URLSearchParams();
  if (mid) params.set('member_id', mid);
  if (q) params.set('q', q);
  if (range) params.set('range', range);
  const files = await api('/api/files' + (params.toString() ? '?' + params : ''));
  S.previewList = files.map((f, i) => ({ ...f, __idx: i }));
  layout(`
    <form id="file-filters" class="card filter-bar">
      <div class="form-grid">
        <label>成员<select name="member_id" data-autosubmit><option value="">全部成员</option>${S.members.map((m) => `<option value="${m.id}" ${String(mid) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <label>时间范围<select name="range" data-autosubmit>
          <option value="">全部时间</option>
          <option value="3m" ${range === '3m' ? 'selected' : ''}>近 3 个月</option>
          <option value="6m" ${range === '6m' ? 'selected' : ''}>近半年</option>
          <option value="1y" ${range === '1y' ? 'selected' : ''}>近一年</option>
          <option value="2y" ${range === '2y' ? 'selected' : ''}>近 2 年</option>
        </select></label>
      </div>
    </form>
    ${files.length ? `<div class="grid files-grid">${S.previewList.map((f) => fileCard(f)).join('')}</div>` : empty('暂无文件。点上方加号可上传 JPG/PNG 检查图片、PDF 报告、MP4 影像视频等')}
  `, 'files');
}

/* ---------- AI 智能导入 ---------- */
const AI_PRESETS = [
  { id: 'custom', name: '自定义（OpenAI 兼容接口）', base: '', model: '' },
  { id: 'zhipu', name: '智谱 GLM（支持视觉，推荐）', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus' },
  { id: 'qwen', name: '阿里通义千问（支持视觉）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-plus' },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'kimi', name: 'Moonshot Kimi（支持视觉）', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k-vision-preview' },
  { id: 'deepseek', name: 'DeepSeek（仅文本，不能识别图片）', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'ollama', name: 'Ollama 本地模型（数据不出内网）', base: 'http://localhost:11434/v1', model: '' },
];

async function viewAdd() {
  const cfg = await api('/api/ai/config');
  S.aiQueue = [];
  layout(`
    <div class="card settings-sec">
      <h3>第 1 步 · 选择文件与归档成员</h3>
      <label>归档成员
        <select id="ai-member">
          <option value="">AI 自动识别（按资料中姓名匹配，未匹配则新建成员）</option>
          ${S.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
        </select>
      </label>
      <div class="file-picker">
        <input type="file" id="ai-files" multiple>
        <div class="file-picker-zone" data-action="pick-files" role="button" tabindex="0">
          <div class="fp-icon">+</div>
          <b>点击选择文件，或把文件拖到这里</b>
          <span class="small">支持图片 / PDF / 视频 / 文档，可多选；选错可在下方清单中移除</span>
        </div>
      </div>
      <ul class="file-pick-list hidden" id="pick-list"></ul>
    </div>
    <div class="card settings-sec">
      <h3>第 2 步 · 选择录入方式（二选一）</h3>
      <div class="row">
        <button class="btn primary" data-action="ai-analyze" ${cfg.configured ? '' : 'disabled'}>AI 智能识别</button>
        <button class="btn" data-action="toggle-manual" ${S.members.length ? '' : 'disabled'}>手工录入</button>
      </div>
      <div class="mode-desc">
        ${cfg.configured ? '' : `<p class="hint">AI 识别尚未配置，<a href="#/settings">前往设置</a> 开启后可用。</p>`}
        <p class="hint">AI 智能识别：AI 读资料、自动写病历${cfg.configured ? `（当前模型 ${esc(cfg.model)}）` : ''}<br>
        手工录入：自己填病历，或只传视频等附件</p>
      </div>
      <div class="status-head hidden" id="status-head">
        <span class="muted small">处理进度</span>
        <button type="button" class="link" data-action="clear-status">清空</button>
      </div>
      <ul class="upload-list" id="ai-status"></ul>
    </div>
    <div class="card settings-sec hidden" id="manual-box">
      <h3>手工录入</h3>
      <form id="add-manual-form">
        <div class="form-grid">
          <label>家庭成员 *<select name="member_id" required>${S.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
          <label>分类<select name="category">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
        </div>
        <label>标题（留空 = 不创建病历，仅上传附件）<input name="title" maxlength="200" placeholder="如：乳腺超声检查"></label>
        <div class="form-grid-3">
          <label>就诊日期<input type="date" name="visit_date"></label>
          <label>医院 / 科室<input name="hospital" maxlength="100"></label>
          <label>医生<input name="doctor" maxlength="50"></label>
        </div>
        <label>下次复诊日期<input type="date" name="next_visit_date"></label>
        <label>主诉 / 检查项目<textarea name="chief_complaint" rows="2" maxlength="2000"></textarea></label>
        <label>检查所见 / 报告原文<textarea name="findings" rows="3" maxlength="20000" placeholder="可粘贴报告原文"></textarea></label>
        <label>诊断结果<textarea name="diagnosis" rows="2" maxlength="4000"></textarea></label>
        <label>处理与治疗<textarea name="treatment" rows="2" maxlength="4000"></textarea></label>
        <label>备注与分析<textarea name="notes" rows="2" maxlength="10000"></textarea></label>
        <div class="row-end"><button class="btn primary">上传并保存</button></div>
      </form>
    </div>
    <div id="ai-results"></div>
  `, 'add');
  renderPickList();
  // 拖拽选文件
  const zone = document.querySelector('.file-picker-zone');
  if (zone) {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const input = document.getElementById('ai-files');
      if (!input) return;
      const dt = new DataTransfer();
      [...input.files].forEach((f) => dt.items.add(f));
      [...(e.dataTransfer.files || [])].forEach((f) => dt.items.add(f));
      input.files = dt.files;
      renderPickList();
    });
  }
}

async function addManualSubmit(form) {
  const f = formToObject(form);
  const memberId = Number(f.member_id);
  if (!memberId) throw new Error('请选择归档成员');
  const input = document.getElementById('ai-files');
  const files = [...(input?.files || [])];
  const title = (f.title || '').trim();
  if (!title && !files.length) throw new Error('请填写病历标题或选择要上传的文件');
  let rec = null;
  if (title) {
    rec = await api('/api/records', { method: 'POST', json: { ...f, member_id: memberId } });
  }
  let ok = 0;
  const memberName = (S.members.find((m) => String(m.id) === String(memberId)) || {}).name || '';
  const usedNames = {};
  const statusUl = document.getElementById('ai-status');
  for (const file of files) {
    const row = statusUl ? makeProgressRow(file.name, statusUl) : null;
    if (row) row.set(2, '连接中…');
    const base = buildAttachName(f, memberName, file);
    let finalName = base, k = 2;
    while (usedNames[finalName]) finalName = base.replace(/(\.[^.]+)$/, `_${k++}$1`);
    usedNames[finalName] = true;
    const qs = new URLSearchParams({ member_id: memberId });
    if (rec) qs.set('record_id', rec.id);
    const r = await uploadOne(file, qs.toString(), finalName, (loaded, total) => {
      if (row) row.set((loaded / total) * 100, `上传中 ${Math.round((loaded / total) * 100)}%`);
    });
    if (r.ok) { ok++; if (row) row.done('上传成功'); }
    else if (row) row.fail('上传失败(' + r.status + ')');
  }
  if (input) input.value = '';
  toast(`完成${rec ? '：病历已保存' : ''}${files.length ? `，附件上传 ${ok}/${files.length}` : ''}`, ok === files.length);
  if (rec) location.hash = '#/record/' + rec.id;
  else { form.reset(); route(); }
}

const PDF_MAX_PAGES = 40;   // 整份阅读的页数上限
const AI_PAGE_BATCH = 4;    // 每次识别请求携带的页数（页数越少单页越清晰，宁可多批）

/* 用浏览器内的 pdf.js 把 PDF 整份渲染为 JPEG 页面（扫描件/特殊编码均可用） */
async function pdfToPageJpegs(file) {
  const mod = await import('/vendor/pdf.min.mjs');
  const pdfjs = mod.default || mod;
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = Math.min(doc.numPages, PDF_MAX_PAGES);
  const images = [];
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    let vp = page.getViewport({ scale: 2.5 });
    const maxSide = Math.max(vp.width, vp.height);
    if (maxSide > 2200) vp = page.getViewport({ scale: 2200 / maxSide });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    images.push(blob);
  }
  return { images, total: doc.numPages };
}

function blobToB64(blob) {
  return blob.arrayBuffer().then((ab) => {
    const buf = new Uint8Array(ab);
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
}

async function aiAnalyzeAll() {
  const memberSel = document.getElementById('ai-member');
  const input = document.getElementById('ai-files');
  const statusUl = document.getElementById('ai-status');
  const files = [...(input?.files || [])];
  if (!files.length) { toast('请先选择要分析的文件', false); return; }
  const presetMemberId = memberSel?.value || '';
  const btn = document.querySelector('[data-action="ai-analyze"]');
  btn.disabled = true;
  const multi = files.length > 1;
  const startCount = S.aiQueue.length; // 本轮新增草稿卡计数

  /* 单个文件 → 直接结构化；多个文件 → 逐一提取文本后合并为一份病历 */
  const recognized = []; // { file, text, pageTotal }
  for (const file of files) {
    const row = makeProgressRow(file.name, statusUl);
    try {
      let text = '', pageTotal = 0;
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        row.set(8, '整份阅读中（渲染页面）…');
        row.status('<span class="spin"></span>处理中');
        const { images, total } = await pdfToPageJpegs(file);
        if (total > images.length) toast(`该 PDF 共 ${total} 页，仅处理前 ${images.length} 页`, false);
        const texts = [];
        const batches = Math.ceil(images.length / AI_PAGE_BATCH);
        let done = 0;
        for (let i = 0; i < images.length; i += AI_PAGE_BATCH) {
          const batch = images.slice(i, i + AI_PAGE_BATCH);
          const pct = 10 + Math.round((done / batches) * 60);
          row.set(pct, `识别中：第 ${i + 1}–${i + batch.length}/${total} 页（${done + 1}/${batches} 批）`);
          const res = await fetch('/api/ai/analyze-pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pages: await Promise.all(batch.map(blobToB64)), start: i + 1, total, name: file.name }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || '识别失败 ' + res.status);
          texts.push(data.text || '');
          done++;
        }
        row.set(85, '汇总提取关键信息…');
        if (multi) {
          /* 多文件：PDF 识别文本并入公共汇总，由统一的 consolidate 合并全部资料 */
          text = texts.join('\n\n');
          pageTotal = total;
        } else {
          /* 单文件：此处直接汇总并生成草稿卡，不进入公共汇总 */
          const res2 = await fetch('/api/ai/consolidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts, name: file.name }),
          });
          const data2 = await res2.json().catch(() => ({}));
          if (!res2.ok) throw new Error(data2.error || '汇总失败 ' + res2.status);
          const idx = S.aiQueue.length;
          S.aiQueue.push({ files: [file], fields: data2.fields, model: data2.model, presetMemberId, done: false, pageTotal: total });
          row.done('识别完成，请核对下方草稿');
          appendAiCard(idx);
          continue;
        }
      } else if (multi) {
        row.set(30, 'AI 提取资料内容中…');
        row.status('<span class="spin"></span>处理中');
        const buf = await file.arrayBuffer();
        const res = await fetch('/api/ai/analyze?text=1', {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' },
          body: buf,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '识别失败 ' + res.status);
        text = data.text || '';
        row.set(100, '');
      } else {
        row.set(30, 'AI 识别中…');
        row.status('<span class="spin"></span>处理中');
        const buf = await file.arrayBuffer();
        const res = await fetch('/api/ai/analyze', {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' },
          body: buf,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '分析失败 ' + res.status);
        const idx = S.aiQueue.length;
        S.aiQueue.push({ files: [file], fields: data.fields, model: data.model, presetMemberId, done: false, pageTotal: 0 });
        row.done('识别完成，请核对下方草稿');
        appendAiCard(idx);
        continue;
      }
      recognized.push({ file, text, pageTotal });
      row.done(multi ? '识别完成，待汇总' : '识别完成');
    } catch (err) {
      row.fail(err.message || '失败');
    }
  }

  if (recognized.length) {
    const li = document.createElement('li');
    const mergingLabel = multi ? `汇总 ${recognized.length} 份资料` : '汇总识别结果';
    li.innerHTML = `<div class="u-row"><span class="clamp">${esc(mergingLabel)}</span><span class="muted"><span class="spin"></span>生成病历草稿…</span></div>`;
    statusUl.appendChild(li);
    syncStatusHead();
    try {
      const res = await fetch('/api/ai/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: recognized.map((r) => `【文件：${r.file.name}】\n${r.text}`), name: recognized[0].file.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '汇总失败 ' + res.status);
      /* 多患者：AI 返回 records 数组，按 source_files 分配附件，各自生成草稿卡 */
      const groups = [];
      if (Array.isArray(data.records)) {
        const claimed = new Set();
        for (const rf of data.records) {
          const names = (rf.source_files || []).map((s) => String(s).trim()).filter(Boolean);
          const fs = [];
          names.forEach((n) => {
            const hit = recognized.find((r) => r.file.name === n && !claimed.has(r.file.name));
            if (hit) { claimed.add(hit.file.name); fs.push(hit.file); }
          });
          groups.push({ fields: rf, files: fs });
        }
        const leftover = recognized.filter((r) => !claimed.has(r.file.name)).map((r) => r.file);
        if (leftover.length && groups.length) groups[0].files.push(...leftover); // 未明归属的文件挂到第一位患者，可在"管理附件"调整
      } else {
        groups.push({ fields: data.fields, files: recognized.map((r) => r.file) });
      }
      let added = 0;
      for (const gp of groups) {
        if (!gp.fields) continue;
        const idx = S.aiQueue.length;
        S.aiQueue.push({
          files: gp.files,
          fields: gp.fields,
          model: data.model,
          presetMemberId,
          done: false,
          pageTotal: recognized.reduce((s, r) => s + r.pageTotal, 0),
        });
        appendAiCard(idx);
        added++;
      }
      const sp = li.querySelector('span:last-child');
      sp.textContent = groups.length > 1 ? `检测到 ${groups.length} 位患者，已分开生成 ${added} 份病历草稿` : '汇总完成，请核对下方草稿';
      sp.className = 'ok';
    } catch (err) {
      const sp = li.querySelector('span:last-child');
      sp.textContent = err.message || '失败';
      sp.className = 'fail';
    }
  }
  const added = S.aiQueue.length - startCount;
  if (added > 0) {
    toast(`已生成 ${added} 份病历草稿，请核对后保存`);
    const results = document.getElementById('ai-results');
    if (results && results.children.length) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  btn.disabled = false;
}

function aiMemberOptions(selected) {
  const opts = [`<option value="">AI 自动（姓名匹配 / 新建）</option>`]
    .concat(S.members.map((m) => `<option value="${m.id}" ${String(selected) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`));
  return opts.join('');
}

function appendAiCard(idx) {
  const item = S.aiQueue[idx];
  const f = item.fields;
  const mm = matchMember(f.member_name);
  const defaultMember = item.presetMemberId || (mm ? String(mm.member.id) : '');
  const box = document.getElementById('ai-results');
  const div = document.createElement('div');
  const headName = item.files.length === 1 ? item.files[0].name : `${item.files[0].name} 等 ${item.files.length} 个文件`;
  const totalSize = item.files.reduce((s, x) => s + x.size, 0);
  const matchHint = mm && mm.how !== 'exact'
    ? `<p class="hint match-hint">已自动匹配档案成员「${esc(mm.member.name)}」（资料中识别为“${esc(f.member_name)}”${mm.how === 'masked' ? '，脱敏名' : '，疑似识别偏差'}），可在下方修改</p>` : '';
  div.innerHTML = `
  <form class="card ai-card" data-idx="${idx}">
    <div class="ai-card-head">
      <div><b>${esc(headName)}</b> <span class="muted small">（${fmtSize(totalSize)}${item.pageTotal ? ` · AI 已整份阅读 ${item.pageTotal} 页` : ''} · 模型 ${esc(item.model)}）</span></div>
      <span class="badge" data-cat="${esc(f.category)}">${esc(f.category)}</span>
    </div>
    ${matchHint}
    ${item.files.length ? `<p class="hint">保存后 ${item.files.length} 个原始文件（${item.files.map((x) => esc(x.name)).join('、')}）将作为附件挂到这条病历，并按“日期 项目 机构 姓名”自动重命名。</p>` : ''}
    <div class="form-grid">
      <label>标题 *<input name="title" required maxlength="200" value="${esc(f.title)}"></label>
      <label>分类<select name="category">${CATEGORIES.map((c) => `<option ${f.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>
    <div class="form-grid">
      <label>资料中的患者姓名<input name="member_name" maxlength="50" value="${esc(f.member_name)}" placeholder="用于匹配或新建成员"></label>
      <label>归档成员<select name="member_choice">${aiMemberOptions(defaultMember)}</select></label>
    </div>
    <div class="form-grid-3">
      <label>就诊日期<input type="date" name="visit_date" value="${esc(f.visit_date)}"></label>
      <label>医院 / 平台<input name="hospital" maxlength="100" value="${esc(f.hospital)}"></label>
      <label>医生<input name="doctor" maxlength="50" value="${esc(f.doctor)}"></label>
    </div>
    <label>下次复诊日期<input type="date" name="next_visit_date" value="${esc(f.next_visit_date)}"></label>
    <label>主诉 / 检查项目<textarea name="chief_complaint" rows="2" maxlength="2000">${esc(f.chief_complaint)}</textarea></label>
    <label>检查所见 / 报告原文（AI 转录，请核对）<textarea name="findings" rows="5" maxlength="20000">${esc(f.findings)}</textarea></label>
    <label>诊断结果<textarea name="diagnosis" rows="2" maxlength="4000">${esc(f.diagnosis)}</textarea></label>
    <label>处理与治疗<textarea name="treatment" rows="2" maxlength="4000">${esc(f.treatment)}</textarea></label>
    <label>备注与分析<textarea name="notes" rows="3" maxlength="10000">${esc(f.notes)}</textarea></label>
    <div class="row-end">
      <button type="button" class="btn danger" data-action="discard-ai-card" data-idx="${idx}">放弃</button>
      <button class="btn primary">保存到档案（含附件）</button>
    </div>
  </form>`;
  box.prepend(div.firstElementChild);
}

async function saveAiCard(form) {
  const idx = Number(form.dataset.idx);
  const item = S.aiQueue[idx];
  if (!item || item.done) return;
  const f = formToObject(form);
  let memberId = f.member_choice || '';
  if (!memberId) {
    const name = (f.member_name || '').trim();
    if (!name) throw new Error('请填写患者姓名或选择归档成员');
    const mm = matchMember(name); // 脱敏/错字 → 已有档案优先
    if (mm) memberId = mm.member.id;
    else {
      const m = await api('/api/members', { method: 'POST', json: { name } });
      memberId = m.id;
      await loadMembers();
      toast('已新建成员：' + name);
    }
  }
  const memberName = (S.members.find((m) => String(m.id) === String(memberId)) || {}).name || '';
  const rec = await api('/api/records', {
    method: 'POST',
    json: {
      member_id: memberId, category: f.category, title: f.title,
      visit_date: f.visit_date, hospital: f.hospital, doctor: f.doctor,
      chief_complaint: f.chief_complaint, findings: f.findings, diagnosis: f.diagnosis,
      treatment: f.treatment, notes: f.notes, next_visit_date: f.next_visit_date,
    },
  });
  // 附件按“日期 项目 机构 姓名”自动重命名（同批次重名自动加序号），卡内显示逐文件进度
  let okCount = 0;
  const usedNames = {};
  const rowEnd = form.querySelector('.row-end');
  const pEl = document.createElement('div');
  pEl.className = 'progress';
  pEl.innerHTML = '<div class="progress-bar" style="width:0%"></div><div class="progress-text"></div>';
  rowEnd.before(pEl);
  const bar = pEl.querySelector('.progress-bar');
  const barText = pEl.querySelector('.progress-text');
  for (let fi = 0; fi < item.files.length; fi++) {
    const file = item.files[fi];
    const base = buildAttachName({ ...f, exam_item: item.fields.exam_item }, memberName, file);
    let finalName = base, k = 2;
    while (usedNames[finalName]) finalName = base.replace(/(\.[^.]+)$/, `_${k++}$1`);
    usedNames[finalName] = true;
    const qs = new URLSearchParams({ member_id: memberId, record_id: rec.id, description: 'AI 导入' });
    const r = await uploadOne(file, qs.toString(), finalName, (loaded, total) => {
      const pct = Math.round(((fi + loaded / total) / item.files.length) * 100);
      bar.style.width = pct + '%';
      barText.textContent = `上传附件 ${fi + 1}/${item.files.length} · ${pct}%`;
    });
    if (r.ok) okCount++;
  }
  bar.style.width = '100%'; barText.textContent = '';
  if (okCount < item.files.length) throw new Error(`病历已保存，但附件仅上传 ${okCount}/${item.files.length}，可在记录页"管理附件"补传`);
  item.done = true;
  [...form.elements].forEach((el) => { if (el.tagName !== 'BUTTON') el.disabled = true; });
  form.querySelector('.row-end').innerHTML = `<span class="ok small">已保存</span> <a class="btn" href="#/record/${rec.id}">查看病历</a>`;
  toast('已保存并挂载附件');
}


/* ---------- 设置页 ---------- */
async function viewSettings() {
  const members = await api('/api/members');
  const files = await api('/api/files');
  const ai = await api('/api/ai/config');
  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
  const recordCount = members.reduce((s, m) => s + m.record_count, 0);
  const presetId = (AI_PRESETS.find((p) => p.base && p.base === ai.base) || {}).id || 'custom';
  layout(`
    <div class="card settings-sec">
      <h3>家庭成员管理</h3>
      <ul class="settings-member-list">
        ${members.map((m) => `
        <li class="settings-member-row">
          <div class="avatar" style="width:36px;height:36px;font-size:15px">${esc((m.name || '?').slice(-1))}</div>
          <div style="flex:1;min-width:0">
            <div><b>${esc(m.name)}</b> <span class="muted small">${esc(m.relationship || '')}${m.gender ? ' · ' + esc(m.gender) : ''}${ageStr(m.birth_date) ? ' · ' + ageStr(m.birth_date) : ''}</span></div>
            <div class="muted small">${m.record_count} 条记录 · ${m.file_count} 份文件${m.notes ? ' · ' + esc(m.notes) : ''}</div>
          </div>
          <div class="row">
            <a class="btn" href="#/member/${m.id}">查看档案</a>
            <button class="btn" data-action="open-member-form" data-id="${m.id}">编辑</button>
          </div>
        </li>`).join('') || '<li class="muted">暂无成员</li>'}
      </ul>
      <button class="btn primary" data-action="open-member-form">+ 添加家庭成员</button>
    </div>
    <div class="card settings-sec">
      <h3>AI 服务配置（智能导入 / AI 问诊）</h3>
      <form id="ai-config-form">
        <div class="form-grid">
          <label>服务商预设
            <select name="preset" id="ai-preset">
              ${AI_PRESETS.map((p) => `<option value="${p.id}" ${presetId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </label>
          <label>接口地址（OpenAI 兼容，一般以 /v1 结尾）
            <input name="base" id="ai-base" placeholder="https://api.example.com/v1" value="${esc(ai.base || '')}">
          </label>
        </div>
        <div class="form-grid">
          <label>模型名称（识别图片需选择视觉模型）
            <input name="model" id="ai-model" placeholder="如 glm-4v-plus / qwen-vl-plus / gpt-4o" value="${esc(ai.model || '')}">
          </label>
          <label>API Key ${ai.key_masked ? `（已保存：${esc(ai.key_masked)}，留空表示不修改）` : '（本地模型如 Ollama 可留空）'}
            <input type="password" name="key" id="ai-key" placeholder="${ai.key_masked ? '留空保持现有 Key 不变' : 'sk-...'}" autocomplete="new-password">
          </label>
        </div>
        <div class="form-grid">
          <label>问诊模型（可选，用于 AI 问诊 / 健康趋势 / 复诊准备）
            <input name="consult_model" id="ai-consult-model" placeholder="留空则使用上方模型；文本模型即可，如 deepseek-chat" value="${esc(ai.consult_model || '')}">
          </label>
          <p class="hint" style="align-self:end;margin:0">识别图片需视觉模型；问诊只需文本模型，分开配置可降低成本。</p>
        </div>
        <div class="row">
          <button class="btn primary">保存配置</button>
          <button type="button" class="btn" data-action="ai-test">测试连接</button>
          <span class="muted small" id="ai-test-result">${ai.configured ? '当前状态：已配置' : '当前状态：未配置'}</span>
        </div>
      </form>
      <p class="hint" style="margin-top:16px">
        说明：使用"AI 导入"时，所上传的资料会发送给你在此配置的 AI 服务商做识别；使用"AI 问诊"时，所选成员的病历档案会发送给该服务商做解读，请自行评估隐私风险；
        如需完全不离内网，可选 Ollama 本地部署的模型（识别图片需视觉模型如 qwen2.5vl，问诊用文本模型即可）。Key 仅保存在本服务器数据库中。
      </p>
    </div>
    <div class="card settings-sec">
      <h3>修改管理密码</h3>
      <form id="change-password-form" style="max-width:380px">
        <label>当前密码<input type="password" name="current" required></label>
        <label>新密码（至少 6 位）<input type="password" name="next" required minlength="6"></label>
        <label>确认新密码<input type="password" name="next2" required></label>
        <button class="btn primary">修改密码</button>
      </form>
    </div>
    <div class="card settings-sec">
      <h3>数据概览</h3>
      <div class="stats-grid">
        <div class="stat-box"><b>${members.length}</b>家庭成员</div>
        <div class="stat-box"><b>${recordCount}</b>病历记录</div>
        <div class="stat-box"><b>${files.length}</b>附件文件</div>
        <div class="stat-box"><b>${fmtSize(totalSize)}</b>占用空间</div>
      </div>
      <div class="row export-controls" style="margin-top:16px">
        <select id="export-member"><option value="">全部成员数据</option>${members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
        <a class="btn primary" id="export-btn" href="/api/export">导出数据（JSON）</a>
      </div>
      <div class="row" style="margin-top:10px">
        <a class="btn" href="/api/backup">一键完整备份（ZIP，含数据库与全部附件）</a>
      </div>
    </div>
    <div class="card settings-sec">
      <h3>备份与安全提示</h3>
      <p class="muted small">
        · 全部数据保存在服务器 <b>data/</b> 目录（SQLite 数据库 + uploads 附件），定期停止服务后复制该目录即可完成备份。<br>
        · 恢复备份：将备份的 data/ 目录覆盖回来，重启服务即可。<br>
        · 请牢记管理密码；若遗忘，在服务器上运行 <b>node reset-password.js</b> 可重置（之后首次打开网页重新设置密码）。<br>
        · 登录为双重验证：除管理密码外还需输入任一档案成员的完整姓名（存在成员时自动启用；成员全部删除后该校验失效）。<br>
        · 本系统为单用户密码登录，适合家庭私用。若部署在公网，务必通过 HTTPS（nginx 反向代理 + 证书）访问。
      </p>
    </div>
  `, 'settings');
}

/* ---------- AI 问诊（对话式报告解读） ---------- */
const CONSULT_CHIPS_REPORT = ['用大白话总结这份报告', '逐项解释异常指标', '整体情况严重吗？', '日常生活要注意什么？', '下次复诊要问医生什么？'];
const CONSULT_CHIPS_GENERAL = ['总结最近的健康状况', '哪些项目需要复查？', '有需要尽快就医的问题吗？', '下一步建议做什么检查？'];
const CONSULT_CHIPS_TRENDS = ['哪些指标在变差？', '哪些项目好久没复查了？', '总体健康状况怎么样？', '接下来优先复查什么？'];
const CONSULT_CHIPS_PREP = ['还有哪些问题值得问医生？', '就诊前要做什么准备？', '怎么向医生描述症状变化？'];
const CONSULT_KINDS = ['chat', 'trends', 'visit-prep'];

/* 迷你 Markdown 渲染：先整体 esc 转义，再做受限格式化（AI 输出不可信，杜绝 XSS；不引外部库，符合 CSP） */
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
function mdLite(src) {
  const lines = esc(String(src ?? '')).split(/\r?\n/);
  const out = [];
  let i = 0, listType = null, para = [];
  const closeList = () => { if (listType) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; } };
  const closePara = () => { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) { // 围栏代码块
      closePara(); closeList();
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre>' + buf.join('\n') + '</pre>');
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) { // 表格
      closePara(); closeList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closePara(); closeList(); const lv = Math.min(h[1].length + 2, 6); out.push(`<h${lv}>` + mdInline(h[2]) + `</h${lv}>`); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { closePara(); closeList(); out.push('<hr>'); i++; continue; }
    if (/^\s*&gt;\s?/.test(line)) { // 引用（esc 后 > 变为 &gt;）
      closePara(); closeList();
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++; }
      out.push('<blockquote>' + buf.map(mdInline).join('<br>') + '</blockquote>');
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.、)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      closePara();
      const t = ul ? 'ul' : 'ol';
      if (listType !== t) { closeList(); out.push(t === 'ul' ? '<ul>' : '<ol>'); listType = t; }
      out.push('<li>' + mdInline((ul || ol)[1]) + '</li>');
      i++;
      continue;
    }
    if (!line.trim()) { closePara(); closeList(); i++; continue; }
    closeList();
    para.push(line);
    i++;
  }
  closePara(); closeList();
  return out.join('');
}

function abortConsult() {
  if (S.consultCtrl) { try { S.consultCtrl.abort(); } catch { /* 忽略 */ } S.consultCtrl = null; }
}
function msgHtml(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="msg-bubble">${nlbr(m.content)}</div></div>`;
  return `<div class="msg ai"><div class="msg-bubble md">${mdLite(m.content)}${m.pending ? '<span class="md-cursor"></span>' : ''}</div></div>`;
}
function consultWelcome() {
  return `<div class="consult-welcome card">
    <b>我能帮你做什么？</b>
    <ul>
      <li>把检查报告翻译成大白话：术语、箭头 ↑↓、分级分类是什么意思</li>
      <li>解释异常指标的可能含义与需要关注的程度</li>
      <li>梳理医生的诊断与处理意见，给出复诊准备建议</li>
    </ul>
    <p class="muted small">我不做确诊、不开药；一切医疗决策请以执业医师意见为准。</p>
  </div>`;
}
function scrollConsultBottom(force) {
  const box = document.getElementById('consult-messages');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}
function updateConsultInputState() {
  const busy = !!(S.consult && S.consult.streaming);
  const ta = document.getElementById('consult-question');
  const btn = document.getElementById('consult-send');
  const stop = document.getElementById('consult-stop');
  if (ta) ta.disabled = busy;
  if (btn) { btn.disabled = busy; btn.textContent = busy ? '回答中…' : '发送'; }
  if (stop) stop.classList.toggle('hidden', !busy);
}
function renderConsultChat() {
  const c = S.consult;
  if (!c) return;
  const scopeText = c.kind === 'trends' ? `${esc(c.memberName)} 的历年病历（趋势对比）`
    : c.kind === 'visit-prep' ? `${esc(c.memberName)} 的近期病历（复诊准备）`
    : c.scopeRecords.length ? `${esc(c.memberName)} 的 ${c.scopeRecords.length} 条病历全文`
    : `${esc(c.memberName)} 的近期病历摘要`;
  const kindBadge = c.kind === 'trends' ? '<span class="badge badge-kind">趋势分析</span> ' : c.kind === 'visit-prep' ? '<span class="badge badge-kind">复诊准备</span> ' : '';
  const chips = c.kind === 'trends' ? CONSULT_CHIPS_TRENDS : c.kind === 'visit-prep' ? CONSULT_CHIPS_PREP : c.recordIds.length ? CONSULT_CHIPS_REPORT : CONSULT_CHIPS_GENERAL;
  layout(`
    <div class="consult-wrap">
      <div class="card consult-head">
        <div class="consult-head-main">
          <a href="#/consult" class="small">&larr; 全部会话</a>
          <h1 id="consult-title">${kindBadge}${esc(c.title || '新问诊')}</h1>
          <div class="muted small">上下文：${scopeText} · <a href="#/member/${c.memberId}">查看档案</a>${c.scopeRecords.length ? ' · ' + c.scopeRecords.map((r) => `<a href="#/record/${r.id}">${esc(r.title)}</a>`).join('、') : ''}</div>
        </div>
        <div class="row no-print">
          ${c.id ? `<button type="button" class="btn" data-action="rename-chat" data-id="${c.id}" data-title="${esc(c.title)}">重命名</button>` : ''}
          <button type="button" class="btn" data-action="print-record">打印</button>
          <a class="btn" href="#/consult?member_id=${c.memberId}">新会话</a>
        </div>
      </div>
      <p class="hint consult-privacy no-print">档案内容会发送给你配置的 AI 服务商处理；AI 解读仅供参考，不能替代执业医师面诊。</p>
      <div id="consult-messages" class="consult-messages">${c.messages.map(msgHtml).join('') || consultWelcome()}</div>
      <div id="consult-error">${c.error ? `<div class="consult-error card">回答失败：${esc(c.error)} <button type="button" class="link" data-action="consult-retry">重试</button></div>` : ''}</div>
      <div class="consult-chips no-print">${chips.map((t) => `<button type="button" class="chip" data-action="consult-chip" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <form id="consult-form" class="consult-input card no-print">
        <textarea name="question" id="consult-question" rows="2" maxlength="2000" placeholder="问点什么：这个指标什么意思？严重吗？要注意什么？（Enter 发送，Shift+Enter 换行）"></textarea>
        <div class="consult-input-btns">
          <button type="button" class="btn hidden" id="consult-stop" data-action="consult-stop">停止</button>
          <button class="btn primary" id="consult-send">发送</button>
        </div>
      </form>
    </div>
  `, 'consult');
  updateConsultInputState();
  scrollConsultBottom(true);
}
function chatRowHtml(c) {
  const kb = c.kind === 'trends' ? '<span class="badge badge-kind">趋势</span> ' : c.kind === 'visit-prep' ? '<span class="badge badge-kind">复诊准备</span> ' : '';
  return `<div class="card chat-row">
    <a class="chat-row-main" href="#/consult/${c.id}">
      <div class="chat-row-title">${kb}${esc(c.title || '未命名会话')}</div>
      <div class="muted small">${esc(c.member_name)} · ${c.message_count} 条消息 · 更新于 ${esc(c.updated_at)}</div>
    </a>
    <div class="row chat-row-actions">
      <button type="button" class="link" data-action="rename-chat" data-id="${c.id}" data-title="${esc(c.title)}">重命名</button>
      <button type="button" class="link danger" data-action="delete-chat" data-id="${c.id}">删除</button>
    </div>
  </div>`;
}
async function viewConsultHome(qs) {
  abortConsult();
  S.consult = null;
  const [chats, cfg] = await Promise.all([api('/api/ai/chats'), api('/api/ai/config')]);
  const preset = qs.get('member_id') || '';
  layout(`
    <div class="page-head">
      <h1>AI 问诊</h1>
      <span class="muted small">基于家庭档案的报告解读与健康答疑 · 仅供参考，不能替代医生面诊</span>
    </div>
    ${cfg.configured ? '' : `<div class="card consult-warn">尚未配置 AI 服务：请先到 <a href="#/settings">设置 → AI 服务配置</a> 填写接口地址与模型（问诊只需文本模型）。</div>`}
    <div class="card settings-sec">
      <h3>新建问诊</h3>
      ${S.members.length ? `
      <form id="consult-new-form">
        <label>家庭成员<select name="member_id" id="consult-member" required>
          ${S.members.map((m) => `<option value="${m.id}" ${String(preset) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select></label>
        <div class="consult-scope-label muted small">勾选要解读的病历（提供报告全文，解读更准确；不勾选则参考最近病历摘要）：</div>
        <div id="consult-scope"></div>
        <p class="hint">问诊时档案内容会发送给你配置的 AI 服务商，请自行评估隐私；敏感资料建议使用 Ollama 本地模型。</p>
        <button class="btn primary" ${cfg.configured ? '' : 'disabled'}>开始问诊</button>
      </form>` : `<p class="muted">还没有家庭成员，请先到 <a href="#/settings">设置 → 家庭成员管理</a> 添加。</p>`}
    </div>
    <h2 class="sec-title">历史会话（${chats.length}）</h2>
    <div class="card-list">${chats.map(chatRowHtml).join('') || '<div class="empty"><p>暂无会话。上方选择成员开始第一次问诊，或到病历详情页点「AI 解读」。</p></div>'}</div>
  `, 'consult');
  await renderConsultScope();
}
async function renderConsultScope() {
  const sel = document.getElementById('consult-member');
  const box = document.getElementById('consult-scope');
  if (!sel || !box) return;
  const mid = sel.value;
  if (!mid) { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="muted small">正在加载病历…</p>';
  try {
    const recs = await api('/api/records?member_id=' + mid);
    const cur = document.getElementById('consult-member');
    if (!cur || cur.value !== mid) return; // 期间已切换成员/页面
    box.innerHTML = recs.length
      ? `<div class="consult-scope-list">${recs.map((r) => `
        <label class="attach-check"><input type="checkbox" name="record_ids" value="${r.id}">
          ${catBadge(r.category)}<span class="attach-name">${esc(r.title)}</span>
          <span class="muted small">${esc(r.visit_date || '')}</span>
        </label>`).join('')}</div>`
      : '<p class="muted small">该成员暂无病历。可先到「添加病历或资料」上传报告；也可以直接开始，AI 将基于成员档案回答。</p>';
  } catch (e) {
    box.innerHTML = `<p class="muted small">病历加载失败：${esc(e.message)}</p>`;
  }
}
async function viewConsultNew(qs) {
  abortConsult();
  const memberId = Number(qs.get('member_id')) || (S.members[0] ? S.members[0].id : 0);
  if (!memberId) { location.hash = '#/consult'; return; }
  let member = S.members.find((m) => m.id === memberId);
  if (!member) member = await api('/api/members/' + memberId);
  const kind = CONSULT_KINDS.includes(qs.get('kind')) ? qs.get('kind') : 'chat';
  const wanted = (qs.get('record_ids') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  let scopeRecords = [];
  if (wanted.length && kind === 'chat') {
    const recs = await api('/api/records?member_id=' + memberId);
    scopeRecords = recs.filter((r) => wanted.includes(r.id)).map((r) => ({ id: r.id, title: r.title, visit_date: r.visit_date }));
  }
  S.consult = {
    id: null, memberId, memberName: member.name, kind,
    recordIds: scopeRecords.map((r) => r.id),
    title: kind === 'trends' ? '健康趋势 · ' + member.name : kind === 'visit-prep' ? '复诊准备 · ' + member.name : '',
    messages: [], streaming: false, error: null, retryQuestion: '', scopeRecords,
  };
  renderConsultChat();
  if (qs.get('auto') === '1') {
    const autoQ = String(qs.get('auto_q') || '').slice(0, 2000);
    const q = kind === 'trends' ? '请对这份档案做历年健康趋势分析：关键指标变化、需要关注的加重/新发项、总体概况与复查建议。'
      : kind === 'visit-prep' ? '请生成复诊准备清单：给医生的病情摘要、近期关键结果、当前治疗、要问医生的问题清单和就诊前注意事项。'
      : autoQ || (S.consult.recordIds.length ? '请用通俗语言解读这份报告：整体情况如何、异常项分别是什么意思、需要注意什么、下次复诊可以问医生哪些问题。' : '');
    if (q) consultSend(q);
  }
}
async function viewConsultChat(id) {
  abortConsult();
  const data = await api('/api/ai/chats/' + id);
  S.consult = {
    id: data.chat.id, memberId: data.chat.member_id, memberName: data.chat.member_name,
    kind: CONSULT_KINDS.includes(data.chat.kind) ? data.chat.kind : 'chat',
    recordIds: data.chat.record_ids || [], title: data.chat.title || '',
    messages: data.messages.map((m) => ({ role: m.role, content: m.content })),
    streaming: false, error: null, retryQuestion: '', scopeRecords: data.records || [],
  };
  renderConsultChat();
}
function openChatRename(id, title) {
  openModal(`<h3>重命名会话</h3>
  <form id="chat-rename-form" data-id="${id}">
    <label>会话标题<input name="title" required maxlength="100" value="${esc(title || '')}"></label>
    <div class="row-end">
      <button type="button" class="btn" data-action="close-modal">取消</button>
      <button class="btn primary">保存</button>
    </div>
  </form>`);
}
/* 发送问题并流式接收回答（SSE）；成功/中断落库由服务端负责，失败可一键重试 */
async function consultSend(text) {
  const c = S.consult;
  if (!c || c.streaming) return;
  const question = String(text || '').trim().slice(0, 2000);
  if (!question) return;
  c.error = null;
  c.retryQuestion = '';
  const errBox = document.getElementById('consult-error');
  if (errBox) errBox.innerHTML = '';
  c.messages.push({ role: 'user', content: question });
  const aiMsg = { role: 'assistant', content: '', pending: true };
  c.messages.push(aiMsg);
  c.streaming = true;
  const box = document.getElementById('consult-messages');
  if (box) {
    const welcome = box.querySelector('.consult-welcome');
    if (welcome) welcome.remove();
    box.insertAdjacentHTML('beforeend', msgHtml({ role: 'user', content: question }));
    box.insertAdjacentHTML('beforeend', msgHtml(aiMsg));
  }
  const aiBubble = box && box.lastElementChild ? box.lastElementChild.querySelector('.msg-bubble') : null;
  const ta = document.getElementById('consult-question');
  if (ta) ta.value = '';
  updateConsultInputState();
  scrollConsultBottom(true);
  const ctrl = new AbortController();
  S.consultCtrl = ctrl;
  let renderTimer = null;
  const flush = () => {
    renderTimer = null;
    if (S.consult !== c || !aiBubble) return;
    aiBubble.innerHTML = mdLite(aiMsg.content) + (aiMsg.pending ? '<span class="md-cursor"></span>' : '');
    scrollConsultBottom();
  };
  const schedule = () => { if (!renderTimer) renderTimer = setTimeout(flush, 80); };
  let done = false;
  try {
    const body = c.id ? { chat_id: c.id, question } : { member_id: c.memberId, record_ids: c.recordIds, kind: c.kind || 'chat', question };
    const res = await fetch('/api/ai/consult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      let d = {}; try { d = await res.json(); } catch { /* 非 JSON */ }
      throw new Error(d.error || '请求失败 ' + res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done: rd, value } = await reader.read();
      if (rd) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let ev = null; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'meta') {
          if (!c.id && ev.chat_id) {
            c.id = ev.chat_id;
            c.title = ev.title || c.title;
            if (S.consult === c) {
              history.replaceState(null, '', '#/consult/' + ev.chat_id); // 不触发 hashchange，避免打断流式渲染
              const t = document.getElementById('consult-title');
              if (t) t.textContent = c.title || '新问诊';
            }
          }
        } else if (ev.type === 'delta') {
          aiMsg.content += String(ev.text || '');
          schedule();
        } else if (ev.type === 'done') {
          done = true;
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'AI 回答失败');
        }
      }
    }
    if (!done && !aiMsg.content.trim()) throw new Error('连接中断，未收到回答，请重试');
    aiMsg.pending = false;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    flush();
  } catch (err) {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    if (ctrl.signal.aborted) {
      // 主动停止或离开页面：服务端会把已生成部分落库，这里保留显示
      aiMsg.pending = false;
      if (aiMsg.content.trim()) { if (S.consult === c && aiBubble) aiBubble.innerHTML = mdLite(aiMsg.content); }
      else {
        c.messages.pop();
        if (c.messages.length && c.messages[c.messages.length - 1].role === 'user') c.messages.pop();
        if (S.consult === c && box) {
          if (box.lastElementChild && box.lastElementChild.classList.contains('ai')) box.lastElementChild.remove();
          if (box.lastElementChild && box.lastElementChild.classList.contains('user')) box.lastElementChild.remove();
        }
      }
    } else {
      // 失败：服务端未落库，撤掉本次提问与回答气泡，显示错误与重试
      c.messages.pop();
      if (c.messages.length && c.messages[c.messages.length - 1].role === 'user') c.messages.pop();
      c.error = err.message || '回答失败';
      c.retryQuestion = question;
      if (S.consult === c) {
        if (box) {
          if (box.lastElementChild && box.lastElementChild.classList.contains('ai')) box.lastElementChild.remove();
          if (box.lastElementChild && box.lastElementChild.classList.contains('user')) box.lastElementChild.remove();
        }
        const eb = document.getElementById('consult-error');
        if (eb) eb.innerHTML = `<div class="consult-error card">回答失败：${esc(c.error)} <button type="button" class="link" data-action="consult-retry">重试</button></div>`;
      }
    }
  } finally {
    c.streaming = false;
    if (S.consultCtrl === ctrl) S.consultCtrl = null;
    if (S.consult === c) { updateConsultInputState(); scrollConsultBottom(); }
  }
}

/* ---------- 登录 / 初始化 ---------- */
function renderLogin() {
  $app.innerHTML = `
  <div class="auth-wrap"><form class="card auth-card" id="login-form">
    <div class="auth-logo">+</div>
    <h1>家庭医学存档</h1>
    <p class="muted">${S.memberGate ? '双重验证：档案成员姓名 + 管理密码' : '单用户密码登录'}</p>
    ${S.memberGate
      ? '<input name="member_name" placeholder="请输入任一档案成员的完整姓名" required maxlength="50" autofocus>'
      : '<p class="muted small" style="margin-top:10px">暂无档案成员：添加成员后将自动启用成员姓名校验</p>'}
    <input type="password" name="password" placeholder="请输入管理密码" required${S.memberGate ? ' style="margin-top:10px"' : ' autofocus'}>
    <div class="auth-error" id="login-error"></div>
    <button class="btn primary block">登 录</button>
  </form></div>`;
}
function renderSetup() {
  $app.innerHTML = `
  <div class="auth-wrap"><form class="card auth-card" id="setup-form">
    <div class="auth-logo">+</div>
    <h1>初始化系统</h1>
    <p class="muted">首次使用，请设置管理密码（至少 6 位）</p>
    <input type="password" name="password" placeholder="设置管理密码" required minlength="6" autofocus>
    <input type="password" name="password2" placeholder="再次输入密码" required minlength="6" style="margin-top:10px">
    <div class="auth-error" id="login-error"></div>
    <button class="btn primary block">保存并进入</button>
  </form></div>`;
}
function renderError(msg) {
  layout(`<div class="empty">出错了：${esc(msg)}<br><br><a href="#/">返回首页</a></div>`, '');
}

/* ---------- 弹窗 ---------- */
function openModal(html, cls = '') {
  $modal.innerHTML = `<div class="modal-overlay" data-action="overlay-close"><div class="modal ${cls}">${html}</div></div>`;
}
function closeModal() {
  $modal.innerHTML = '';
  if (S.needRouteRefresh) { S.needRouteRefresh = false; route(); }
}
function openConfirm(msg, cb) {
  S.confirmCb = cb;
  openModal(`<h3>确认操作</h3><p>${esc(msg)}</p>
    <div class="row-end"><button type="button" class="btn" data-action="close-modal">取消</button>
    <button type="button" class="btn danger" data-action="confirm-ok">确认</button></div>`);
}

function openMemberForm(m) {
  openModal(`<h3>${m ? '编辑家庭成员' : '添加家庭成员'}</h3>
  <form id="member-form">
    <label>姓名 *<input name="name" required maxlength="50" value="${esc(m?.name || '')}"></label>
    <div class="form-grid">
      <label>性别<select name="gender">
        <option value="">未填写</option><option ${m?.gender === '女' ? 'selected' : ''}>女</option><option ${m?.gender === '男' ? 'selected' : ''}>男</option>
      </select></label>
      <label>出生日期<input type="date" name="birth_date" value="${esc(m?.birth_date || '')}"></label>
    </div>
    <label>与我的关系<input name="relationship" maxlength="30" placeholder="本人 / 配偶 / 父母 / 子女…" value="${esc(m?.relationship || '')}"></label>
    <label>备注（既往史、过敏史等）<textarea name="notes" rows="2" maxlength="1000">${esc(m?.notes || '')}</textarea></label>
    <div class="row-end" ${m ? 'style="justify-content:space-between"' : ''}>
      ${m ? `<button type="button" class="btn danger" data-action="delete-member" data-id="${m.id}" data-name="${esc(m.name)}">删除</button>` : ''}
      <div class="row">
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <button class="btn primary">保存</button>
      </div>
    </div>
  </form>`);
}

async function openRecordForm(existingId, presetMemberId) {
  let r = null;
  if (existingId) {
    const res = await api('/api/records/' + existingId);
    r = res.record;
  }
  const mid = r?.member_id || presetMemberId || (S.members[0]?.id ?? '');
  openModal(`<h3>${r ? '编辑病历记录' : '病历记录'}</h3>
  <form id="record-form">
    <div class="form-grid">
      <label>家庭成员 *<select name="member_id" required>${S.members.map((m) => `<option value="${m.id}" ${String(mid) === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      <label>分类<select name="category">${CATEGORIES.map((c) => `<option ${r?.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>
    <label>标题 *<input name="title" required maxlength="200" placeholder="如：乳腺超声检查 / 心内科复诊" value="${esc(r?.title || '')}"></label>
    <div class="form-grid-3">
      <label>就诊日期<input type="date" name="visit_date" value="${esc(r?.visit_date || '')}"></label>
      <label>医院 / 科室<input name="hospital" maxlength="100" value="${esc(r?.hospital || '')}"></label>
      <label>医生<input name="doctor" maxlength="50" value="${esc(r?.doctor || '')}"></label>
    </div>
    <label>下次复诊日期（用于首页提醒）<input type="date" name="next_visit_date" value="${esc(r?.next_visit_date || '')}"></label>
    <label>主诉 / 检查项目<textarea name="chief_complaint" rows="2" maxlength="2000" placeholder="症状、检查原因或检查项目">${esc(r?.chief_complaint || '')}</textarea></label>
    <label>检查所见 / 报告原文（AI 会逐字转录报告正文）<textarea name="findings" rows="4" maxlength="20000" placeholder="报告原文：患者信息、超声所见/影像所见/检验结果等">${esc(r?.findings || '')}</textarea></label>
    <label>诊断结果<textarea name="diagnosis" rows="2" maxlength="4000" placeholder="医生的诊断结论，如 BI-RADS 分级等">${esc(r?.diagnosis || '')}</textarea></label>
    <label>处理与治疗<textarea name="treatment" rows="2" maxlength="4000" placeholder="用药、手术、随访建议等">${esc(r?.treatment || '')}</textarea></label>
    <label>备注与分析<textarea name="notes" rows="3" maxlength="10000" placeholder="自己的记录、对比分析、医嘱摘要等">${esc(r?.notes || '')}</textarea></label>
    <div class="row-end" ${r ? 'style="justify-content:space-between"' : ''}>
      ${r ? `<button type="button" class="btn danger" data-action="delete-record" data-id="${r.id}">删除</button>` : ''}
      <div class="row">
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <button class="btn primary">保存</button>
      </div>
    </div>
  </form>`);
  // 编辑模式：在表单上标记记录 id，保存时走 PUT 更新而非新建
  if (r) { const form = document.getElementById('record-form'); if (form) form.dataset.id = r.id; }
}

/* ---------- 附件管理（关联/取消关联到病历） ---------- */
async function openManageAttachments(recordId) {
  const { record } = await api('/api/records/' + recordId);
  const files = await api('/api/files?member_id=' + record.member_id);
  const rows = files.map((f) => `
    <li class="attach-item">
      <label class="attach-check">
        <input type="checkbox" data-action="toggle-attach" data-id="${f.id}" data-record="${recordId}" ${f.record_id === recordId ? 'checked' : ''}>
        <span class="badge" data-cat="其他">${fileKind(f.mime_type, f.original_name)}</span>
        <span class="attach-name" title="${esc(f.original_name)}">${esc(f.original_name)}</span>
      </label>
      <span class="muted small">${fmtSize(f.size)} · ${f.record_title ? '当前关联：' + esc(f.record_title) : '未关联任何病历'}</span>
    </li>`).join('');
  openModal(`<h3>管理附件 · ${esc(record.title)}</h3>
    <p class="hint">勾选 = 关联到本条病历（保存后显示在该病历下）；取消勾选 = 仅保留在成员影像库。上传新文件请到顶部「<a href="#/add">添加病历或资料</a>」。</p>
    <ul class="attach-list">${rows || '<li class="muted">该成员还没有任何文件</li>'}</ul>
    <div class="row-end">
      <a class="btn" href="#/add">上传新文件</a>
      <button type="button" class="btn" data-action="close-modal">关闭</button>
    </div>`);
}

/* ---------- 文件编辑（重命名 / 说明） ---------- */
async function openFileForm(id) {
  const f = await api('/api/files/' + id);
  openModal(`<h3>编辑文件资料</h3>
  <form id="file-form" data-id="${f.id}">
    <label>文件名称 *<input name="original_name" required maxlength="200" value="${esc(f.original_name)}"></label>
    <p class="hint">不写扩展名时自动保留原扩展名（如 .mp4 / .pdf）</p>
    <label>说明<textarea name="description" rows="2" maxlength="500">${esc(f.description)}</textarea></label>
    <p class="muted small">${fmtSize(f.size)} · 上传于 ${esc(f.uploaded_at)}</p>
    <div class="row-end" style="justify-content:space-between">
      <button type="button" class="btn danger" data-action="delete-file" data-id="${f.id}" data-name="${esc(f.original_name)}">删除</button>
      <div class="row">
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <button class="btn primary">保存</button>
      </div>
    </div>
  </form>`);
}
async function fileSubmit(form) {
  const b = formToObject(form);
  await api('/api/files/' + form.dataset.id, {
    method: 'PUT',
    json: { original_name: b.original_name, description: b.description },
  });
  closeModal(); toast('已保存');
  route();
}

/* ---------- 文件预览 ---------- */
function openPreview(idx) {
  const list = S.previewList;
  if (!list.length) return;
  S.previewIdx = (idx + list.length) % list.length;
  const f = list[S.previewIdx];
  const kind = fileKind(f.mime_type, f.original_name);
  let media = '';
  if (kind === 'IMG') media = `<img src="/file/${f.id}" alt="${esc(f.original_name)}">`;
  else if (kind === 'VIDEO') media = `<video controls autoplay src="/file/${f.id}"></video>`;
  else if (kind === 'AUDIO') media = `<audio controls autoplay src="/file/${f.id}" style="width:90%"></audio>`;
  else if (kind === 'PDF') media = `<iframe src="/file/${f.id}" title="PDF 预览"></iframe>`;
  else media = `<a class="btn primary" href="/file/${f.id}?download=1" style="margin:30px">该格式不支持在线预览，点击下载查看</a>`;
  openModal(`
    <div class="preview-head">
      <div><b>${esc(f.original_name)}</b><div class="muted small">${fmtSize(f.size)} · ${esc(f.uploaded_at)}${f.member_name ? ' · ' + esc(f.member_name) : ''}</div></div>
      <div class="row">
        <button class="btn" data-action="preview-prev">&larr; 上一个</button>
        <button class="btn" data-action="preview-next">下一个 &rarr;</button>
        <a class="btn" href="/file/${f.id}?download=1">下载</a>
        <button class="btn" data-action="close-modal">关闭</button>
      </div>
    </div>
    <div class="preview-body">${media}</div>
    <div class="preview-foot">
      <span>${S.previewIdx + 1} / ${list.length}${f.description ? ' · ' + esc(f.description) : ''}</span>
      <span class="muted">${kind === 'PDF' ? 'PDF 内嵌预览' : kind === 'VIDEO' ? '视频在线播放' : ''}</span>
    </div>
  `, 'preview-modal');
}

/* ---------- 表单提交 ---------- */
function formToObject(form) {
  const o = {};
  new FormData(form).forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; });
  return o;
}
async function loginSubmit(form) {
  const b = formToObject(form);
  await api('/api/login', { method: 'POST', json: b });
  S.authed = true;
  await loadMembers();
  location.hash = '#/';
}
async function setupSubmit(form) {
  const b = formToObject(form);
  if (b.password !== b.password2) throw new Error('两次输入的密码不一致');
  await api('/api/setup', { method: 'POST', json: { password: b.password } });
  S.authed = true; S.needSetup = false;
  await loadMembers();
  location.hash = '#/';
  toast('密码设置成功，欢迎使用');
}
async function memberSubmit(form) {
  const b = formToObject(form);
  const m = form.dataset.id ? await api('/api/members/' + form.dataset.id, { method: 'PUT', json: b })
    : await api('/api/members', { method: 'POST', json: b });
  await loadMembers();
  closeModal(); toast('已保存');
  if (location.hash.startsWith('#/member/')) location.hash = '#/member/' + m.id; else route();
}
async function recordSubmit(form) {
  const b = formToObject(form);
  const isEdit = !!form.dataset.id;
  const r = isEdit ? await api('/api/records/' + form.dataset.id, { method: 'PUT', json: b })
    : await api('/api/records', { method: 'POST', json: b });
  closeModal(); toast(isEdit ? '病历已更新' : '病历已保存');
  const target = '#/record/' + r.id;
  if (location.hash === target) route(); // 编辑保存在原页面时地址不变，手动刷新视图
  else location.hash = target;
}
async function pwSubmit(form) {
  const b = formToObject(form);
  if (b.next !== b.next2) throw new Error('两次输入的新密码不一致');
  await api('/api/change-password', { method: 'POST', json: { current: b.current, next: b.next } });
  S.authed = false;
  toast('密码已修改，请重新登录');
  location.hash = '#/login';
}
function uploadOne(file, qs, nameOverride, onprogress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?' + qs);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(nameOverride || file.name));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onprogress) onprogress(e.loaded, e.total);
    };
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => resolve({ ok: false, status: 0, body: '' });
    xhr.send(file);
  });
}

/* 状态列表中的单文件进度行：名称 + 状态 + 进度条 */
function makeProgressRow(name, list) {
  const li = document.createElement('li');
  li.innerHTML = `<div class="u-row"><span class="clamp">${esc(name)}</span><span class="muted">等待中…</span></div>
    <div class="progress"><div class="progress-bar" style="width:0%"></div><div class="progress-text"></div></div>`;
  list.appendChild(li);
  syncStatusHead();
  const bar = li.querySelector('.progress-bar');
  const barText = li.querySelector('.progress-text');
  const st = li.querySelector('.u-row span:last-child');
  return {
    el: li,
    set(pct, text) { bar.style.width = Math.max(0, Math.min(100, pct)) + '%'; if (text !== undefined) barText.textContent = text; },
    status(html, cls) { st.innerHTML = html; st.className = cls || 'muted'; },
    done(text) { this.set(100, ''); this.status(esc(text || '完成'), 'ok'); },
    fail(text) { li.querySelector('.progress').remove(); this.status(esc(text || '失败'), 'fail'); },
  };
}

/* 已选文件清单：列出名称/大小，可逐个移除（防错选） */
function renderPickList() {
  const input = document.getElementById('ai-files');
  const ul = document.getElementById('pick-list');
  if (!input || !ul) return;
  const files = [...input.files];
  ul.classList.toggle('hidden', files.length === 0);
  ul.innerHTML = files.map((f, i) => `
    <li class="pick-item">
      <span class="pick-icon">${fileKind(f.type, f.name)}</span>
      <span class="pick-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="pick-size">${fmtSize(f.size)}</span>
      <button type="button" class="link danger" data-action="pick-remove" data-idx="${i}">移除</button>
    </li>`).join('');
}
function removePickedFile(idx) {
  const input = document.getElementById('ai-files');
  if (!input) return;
  const keep = [...input.files].filter((_, i) => i !== idx);
  const dt = new DataTransfer();
  keep.forEach((f) => dt.items.add(f));
  input.files = dt.files;
  renderPickList();
}

/* 处理进度区有内容时才显示表头（含清空按钮） */
function syncStatusHead() {
  const head = document.getElementById('status-head');
  const list = document.getElementById('ai-status');
  if (head && list) head.classList.toggle('hidden', list.children.length === 0);
}

/* ---------- 事件委托 ---------- */
document.addEventListener('click', async (e) => {
  const overlay = e.target.closest('[data-action="overlay-close"]');
  if (overlay && e.target === overlay) { closeModal(); return; }
  const el = e.target.closest('[data-action]');
  if (!el || el.dataset.action === 'overlay-close') return;
  const id = el.dataset.id ? Number(el.dataset.id) : null;
  try {
    switch (el.dataset.action) {
      case 'logout': await api('/api/logout', { method: 'POST', json: {} }); S.authed = false; location.hash = '#/login'; break;
      case 'toggle-nav': {
        const nav = document.querySelector('.topbar .nav');
        const tgl = document.querySelector('.nav-toggle');
        if (nav && tgl) {
          const open = nav.classList.toggle('open');
          tgl.classList.toggle('open', open);
          tgl.setAttribute('aria-expanded', open);
        }
        break;
      }
      case 'close-modal': closeModal(); break;
      case 'confirm-ok': { const cb = S.confirmCb; S.confirmCb = null; closeModal(); if (cb) await cb(); break; }
      case 'open-member-form': {
        const m = id ? await api('/api/members/' + id) : null;
        openMemberForm(m);
        const form = document.getElementById('member-form');
        if (m) form.dataset.id = m.id;
        break;
      }
      case 'delete-member':
        openConfirm(`确定删除成员“${el.dataset.name}”？其名下所有病历记录与附件文件将被一并删除，不可恢复。`, async () => {
          await api('/api/members/' + id, { method: 'DELETE' });
          await loadMembers();
          toast('成员已删除');
          location.hash = '#/'; route();
        });
        break;
      case 'open-record-form':
        openRecordForm(id || null, el.dataset.member ? Number(el.dataset.member) : null);
        break;
      case 'delete-record':
        openConfirm('确定删除这条病历记录？（已上传的附件会保留在“影像资料”中）', async () => {
          await api('/api/records/' + id, { method: 'DELETE' });
          toast('记录已删除');
          location.hash = '#/records'; route();
        });
        break;
      case 'print-record': window.print(); break;
      case 'ai-analyze': aiAnalyzeAll(); break;
      case 'toggle-manual': {
        const box = document.getElementById('manual-box');
        if (box) box.classList.toggle('hidden');
        break;
      }
      case 'pick-remove': removePickedFile(Number(el.dataset.idx)); break;
      case 'pick-files': {
        const input = document.getElementById('ai-files');
        if (input) input.click();
        break;
      }
      case 'clear-status': {
        const list = document.getElementById('ai-status');
        if (list) list.innerHTML = '';
        syncStatusHead();
        break;
      }
      case 'manage-attachments': openManageAttachments(Number(el.dataset.record)); break;
      case 'edit-file': openFileForm(Number(el.dataset.id)); break;
      case 'discard-ai-card': {
        const idx = Number(el.dataset.idx);
        if (S.aiQueue[idx]) S.aiQueue[idx].done = true;
        const form = el.closest('form.ai-card');
        if (form) form.remove();
        break;
      }
      case 'ai-test': {
        const form = document.getElementById('ai-config-form');
        const fd = new FormData(form);
        const result = document.getElementById('ai-test-result');
        result.textContent = '测试中…';
        try {
          const r = await api('/api/ai/test', { method: 'POST', json: { base: fd.get('base'), model: fd.get('model'), key: fd.get('key') } });
          result.textContent = '连接成功，模型回复：' + r.reply;
        } catch (err) { result.textContent = '失败：' + err.message; }
        break;
      }
      case 'preview': openPreview(Number(el.dataset.idx)); break;
      case 'preview-prev': openPreview(S.previewIdx - 1); break;
      case 'preview-next': openPreview(S.previewIdx + 1); break;
      case 'delete-file':
        openConfirm(`确定删除文件“${el.dataset.name}”？不可恢复。`, async () => {
          await api('/api/files/' + id, { method: 'DELETE' });
          toast('文件已删除');
          route();
        });
        break;
      case 'consult-chip': consultSend(el.dataset.text); break;
      case 'consult-stop': abortConsult(); break;
      case 'consult-retry': { const c = S.consult; if (c && c.retryQuestion) consultSend(c.retryQuestion); break; }
      case 'rename-chat': openChatRename(id, el.dataset.title || ''); break;
      case 'delete-chat':
        openConfirm('确定删除这个问诊会话？全部问答记录将被一并删除，不可恢复。', async () => {
          await api('/api/ai/chats/' + id, { method: 'DELETE' });
          toast('会话已删除');
          if (S.consult && S.consult.id === id) location.hash = '#/consult';
          route();
        });
        break;
    }
  } catch (err) { toast(err.message || '操作失败', false); }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.classList && form.classList.contains('ai-card')) {
    e.preventDefault();
    try { await saveAiCard(form); }
    catch (err) { toast(err.message || '保存失败', false); }
    return;
  }
  const handlers = {
    'login-form': loginSubmit,
    'setup-form': setupSubmit,
    'member-form': memberSubmit,
    'record-form': recordSubmit,
    'file-form': fileSubmit,
    'change-password-form': pwSubmit,
    'add-manual-form': addManualSubmit,
    'ai-config-form': async (f) => {
      const fd = new FormData(f);
      await api('/api/ai/config', {
        method: 'PUT',
        json: { base: fd.get('base'), model: fd.get('model'), key: fd.get('key') || '', consult_model: fd.get('consult_model') || '' },
      });
      toast('AI 配置已保存');
      viewSettings();
    },
    'global-search': (f) => { const q = f.q.value.trim(); location.hash = q ? '#/records?q=' + encodeURIComponent(q) : '#/records'; },
    'record-filters': () => {},
    'file-filters': () => {},
    'consult-form': (f) => { consultSend(f.question.value); },
    'consult-new-form': (f) => {
      const fd = new FormData(f);
      const params = new URLSearchParams();
      params.set('member_id', fd.get('member_id'));
      const ids = fd.getAll('record_ids');
      if (ids.length) params.set('record_ids', ids.join(','));
      location.hash = '#/consult/new?' + params;
    },
    'chat-rename-form': async (f) => {
      const title = String(new FormData(f).get('title') || '').trim();
      await api('/api/ai/chats/' + f.dataset.id, { method: 'PUT', json: { title } });
      toast('已重命名');
      closeModal();
      if (S.consult && String(S.consult.id) === f.dataset.id) {
        S.consult.title = title;
        const t = document.getElementById('consult-title');
        if (t) t.textContent = title;
      } else route();
    },
  };
  const fn = handlers[form.id];
  if (!fn) return;
  e.preventDefault();
  const errEl = form.querySelector('.auth-error');
  if (errEl) errEl.textContent = '';
  try { await fn(form); }
  catch (err) {
    if (errEl) errEl.textContent = err.message || '操作失败';
    else toast(err.message || '操作失败', false);
  }
});

document.addEventListener('change', async (e) => {
  // 选择文件后刷新已选清单
  if (e.target && e.target.id === 'ai-files') { renderPickList(); return; }
  // 附件关联/取消关联（管理附件弹窗中的复选框）
  if (e.target && e.target.dataset && e.target.dataset.action === 'toggle-attach') {
    const cb = e.target;
    const fileId = Number(cb.dataset.id);
    const recordId = Number(cb.dataset.record);
    try {
      await api('/api/files/' + fileId, { method: 'PUT', json: { record_id: cb.checked ? recordId : null } });
      toast(cb.checked ? '已关联到本病历' : '已取消关联');
      S.needRouteRefresh = true; // 关闭弹窗后刷新背后的病历页
      openManageAttachments(recordId); // 刷新弹窗内关联状态
    } catch (err) {
      cb.checked = !cb.checked;
      toast(err.message || '操作失败', false);
    }
    return;
  }
  // 数据导出：按选择的成员更新导出链接
  if (e.target && e.target.id === 'export-member') {
    const btn = document.getElementById('export-btn');
    if (btn) btn.href = '/api/export' + (e.target.value ? '?member_id=' + e.target.value : '');
    return;
  }
  // AI 服务商预设自动填充接口地址与模型
  if (e.target && e.target.id === 'ai-preset') {
    const p = AI_PRESETS.find((x) => x.id === e.target.value);
    if (p) {
      document.getElementById('ai-base').value = p.base;
      document.getElementById('ai-model').value = p.model;
    }
    return;
  }
  // 问诊：切换成员后刷新可勾选的病历范围
  if (e.target && e.target.id === 'consult-member') { renderConsultScope(); return; }
  const el = e.target.closest('[data-autosubmit]');
  if (!el) return;
  const form = el.closest('form');
  if (!form) return;
  const fd = new FormData(form);
  const params = new URLSearchParams();
  if (form.id === 'record-filters') {
    if (fd.get('member_id')) params.set('member_id', fd.get('member_id'));
    if (fd.get('category')) params.set('category', fd.get('category'));
    if (fd.get('range')) params.set('range', fd.get('range'));
    location.hash = '#/records' + (params.toString() ? '?' + params : '');
  } else if (form.id === 'file-filters') {
    if (fd.get('member_id')) params.set('member_id', fd.get('member_id'));
    if (fd.get('range')) params.set('range', fd.get('range'));
    location.hash = '#/files' + (params.toString() ? '?' + params : '');
  }
});

/* 问诊输入框：Enter 发送，Shift+Enter 换行（兼容中文输入法组合态） */
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'consult-question' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    consultSend(e.target.value);
  }
});

/* ---------- 路由 ---------- */
async function route() {
  const hash = location.hash || '#/';
  if (S.needSetup) {
    if (hash !== '#/setup') { location.hash = '#/setup'; return; }
    return renderSetup();
  }
  if (!S.authed) {
    if (hash !== '#/login') { location.hash = '#/login'; return; }
    return renderLogin();
  }
  if (hash === '#/login' || hash === '#/setup') { location.hash = '#/'; return; }
  const [pathPart, queryPart] = hash.slice(1).split('?');
  const qs = new URLSearchParams(queryPart || '');
  const seg = pathPart.split('/').filter(Boolean);
  closeModal();
  abortConsult(); // 离开问诊页即中断流式回答（服务端保留已生成部分）
  try {
    if (seg.length === 0) await viewDashboard();
    else if (seg[0] === 'member' && seg[1]) await viewMember(Number(seg[1]));
    else if (seg[0] === 'record' && seg[1]) await viewRecord(Number(seg[1]));
    else if (seg[0] === 'records') await viewRecords(qs);
    else if (seg[0] === 'files') await viewFiles(qs);
    else if (seg[0] === 'consult') {
      if (seg[1] === 'new') await viewConsultNew(qs);
      else if (seg[1] && /^\d+$/.test(seg[1])) await viewConsultChat(Number(seg[1]));
      else await viewConsultHome(qs);
    }
    else if (seg[0] === 'add' || seg[0] === 'ai-import') await viewAdd();
    else if (seg[0] === 'settings') await viewSettings();
    else await viewDashboard();
  } catch (e) { renderError(e.message); }
}
window.addEventListener('hashchange', route);

async function loadMembers() {
  try { S.members = await api('/api/members'); }
  catch { S.members = []; }
}

(async function boot() {
  try {
    const st = await api('/api/status');
    S.needSetup = st.needSetup;
    S.authed = st.authed;
    S.memberGate = !!st.memberGate;
    S.version = st.version || '';
  } catch (e) { renderError('无法连接服务器：' + e.message); return; }
  if (S.authed) await loadMembers();
  route();
})();
