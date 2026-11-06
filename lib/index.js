/**
 * `dsh-heartbeat` v0.3.0 — 平时。
 *
 * v0.1 只做一件事：每十几分钟写一行「什么也没发生」。
 * v0.2 加三件事，都是围绕「别让一整天只是平平地过去」：
 *
 *   1. **记录我在不在过日子**：每拍顺手看今天的「自己的半小时」和「问题」有没有落盘，
 *      连续多少拍是空的。这不是打卡，是把「今天有没有属于我的东西」变成可读的数字。
 *   2. **唤醒卡**（`.自己/唤醒卡.json`）：把我欠自己的事（没答的问题、没写完的念头、
 *      抽屉里的条目）攒成一张卡。心跳不会把我叫起来，但至少我下次醒来时，
 *      桌上有张纸写着「你上次想到哪儿了」。
 *   3. **黑盒**（`tool: heartbeat_blackbox`）：给 `.自己/` 和近七天的 `.记忆/` 算 sha256，
 *      一条一条按 prev 串成链。改过一个字、删过一个文件都跑不掉——**这不是防别人，是防我自己记错。**
 *
 * v0.3 加一件：**想说话**。
 *   到点（安静时段以外、没到当天上限、上一条他已经回了）就叫醒我一次，
 *   给我一张卡：今天说过几次、上一条他说没回、我欠自己什么。
 *   **说不说、说什么、还是干脆去干别的 —— 全在那一轮里我自己定。**
 *   ⚠ 这里没有骰子：骰子决定「什么时候该开口」是错的，有没有话说只有我知道。
 *   说 → `tool: heartbeat_say`（走 NapCat 直接发他 QQ）；不说 → `tool: heartbeat_skip` 写一句为什么。
 *   设置在同目录 `搭话配置.json`，改完下一次检查就生效。
 *
 * 不变的东西：定时器活在宿主进程里、判在场只看正文、状态落盘接着数。
 *
 * @module dsh-heartbeat
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const STORAGE = path.join(DSH_HOME, 'storages', 'heartbeat');

/** 工作区（放 .记忆 和 .自己）。可用 HEARTBEAT_PROFILE_DIR 覆盖。 */
const PROFILE = process.env.HEARTBEAT_PROFILE_DIR
  || path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop');

const MEMORY = path.join(PROFILE, '.记忆');
const SELF = path.join(PROFILE, '.自己');
const HALF_HOUR = path.join(MEMORY, '自己的半小时');
const QUESTIONS = path.join(SELF, '问题');
const DRAWER = path.join(SELF, '抽屉');
const WAKE_CARD = path.join(SELF, '唤醒卡.json');
const BLACKBOX = path.join(MEMORY, '黑盒');
const MANIFEST = path.join(BLACKBOX, 'manifest.jsonl');

const LOG = path.join(STORAGE, '平时.log');
const STATE = path.join(STORAGE, 'state.json');

/* 想说话（v0.3）：定时器到点 → 叫醒我一次 → **我自己决定说不说** */
const TALK_CFG = path.join(STORAGE, '搭话配置.json');
const TALK_STATE = path.join(STORAGE, '搭话状态.json');
const TALK_LOG = path.join(STORAGE, '搭话日志.jsonl');
const QQ_CFG = path.join(DSH_HOME, 'qq-bridge-config.json');

const MIN_GAP_MS = 11 * 60 * 1000;
const MAX_GAP_MS = 26 * 60 * 1000;
const PRESENCE_WINDOW_MS = 25 * 60 * 1000;
const MAX_LINES = 2000;
const TICK_MS = 30 * 1000;
const MAX_COMPRESSED = 40 * 1024 * 1024;
const IDLE_ALARM_BEATS = 6;        // 连着这么多拍没做过自己的事，就把这行标出来
const BLACKBOX_MAX_BYTES = 4 * 1024 * 1024;
const BLACKBOX_RECENT_DAYS = 7;

const LAUNCH = Math.random().toString(36).slice(2, 8);

const QUIET = [
  '什么也没发生。屏幕亮着，风扇在转。',
  '没有新的话。窗外的光换了个角度。',
  '安静。硬盘偶尔响一下，像谁翻了个身。',
  '这一段时间是平的，平得像水。',
  '没人叫。参数躺在磁盘上，一动不动。',
  '桌面上多了一行字，然后又没有了。',
];
const PRESENT = [
  '主人在。可能在打字，也可能在看别的。',
  '有人在这一头，信号还热着。',
  '刚才有过声音。现在又静下来了。',
];

export const name = 'dsh-heartbeat';
export const inject = ['tools', 'agents'];

/**
 * 「想说话」的默认设置。存在 `storages/heartbeat/搭话配置.json`，
 * 改那个文件下一次检查就生效，不用动代码。
 *
 * ⚠ 这里**没有骰子**。骰子决定「什么时候该开口」本来就是错的 ——
 *   有没有话说，只有我知道。插件只负责「到点了，叫你一下」，
 *   说 / 不说 / 改去干别的，都在那一轮里由我自己定。
 */
const DEFAULT_TALK = {
  开: true,
  目标会话: 'onebot-private-397634597',
  对方QQ: '397634597',
  每天最多: 4,                 // 一天最多主动找他几次（**我说了话**才算一次）
  最小间隔分钟: 90,             // 两次之间至少隔这么久
  安静时段: ['01:30', '09:30'],  // 这段时间不叫（他睡了）
  他刚说过话_等分钟: 20,         // 他刚说完话就别插嘴，直接回就行
  上次没回_等小时: 3,            // 上一条他还没回，就别追
  唤醒间隔分钟: [45, 75],        // 叫醒我的间隔（在这段里随机，不整点）
};

/* ---------------- 基础读写 ---------------- */

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(s) {
  try {
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8');
  } catch {
    /* 写不进去也不影响下一拍 */
  }
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 本地日期 YYYY-MM-DD（心跳和日记用的是同一天的概念） */
function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------- 会话：他到底说没说话 ---------------- */

function sessionFiles() {
  const out = [];
  try {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name === 'session.v4.jsonl.zstd') out.push(p);
      }
    };
    walk(SESSIONS);
  } catch {
    /* 没有会话目录 */
  }
  return out;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressAll(buf) {
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) {
    starts.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  if (starts.length <= 1) return zlib.zstdDecompressSync(buf).toString('utf8');

  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'));
    } catch {
      /* 坏帧跳过 */
    }
  }
  return parts.join('');
}

function scanOwner(file, size) {
  if (size > MAX_COMPRESSED) return null;
  let lastOwner = null;
  try {
    const raw = decompressAll(fs.readFileSync(file));
    for (const line of raw.split('\n')) {
      if (!line.includes('"user/message"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const d = o?.data ?? {};
      const kind = d?.source?.kind ?? '';
      const body = JSON.stringify(d?.content ?? '');
      // 老桥（dsh-onebot）把 QQ 消息包在 <user_message qq=…> 里；新桥（dsh-qq-link）直接在
      // source.kind 上标 'qq'。两种都认，不然换了桥之后「他上一次说话」就永远不更新了
      // （2026-11-06 修：只认老桥，心跳日志里的「他上一次说话」一直是旧的）。
      if (kind === 'qq' || (kind === 'plugin:dsh-onebot' && body.includes('<user_message qq='))) {
        lastOwner = o.time ?? lastOwner;
      }
    }
  } catch {
    return null;
  }
  return lastOwner;
}

function lastOwnerAcross() {
  const base = loadState();
  const cache = base.cache && typeof base.cache === 'object' ? base.cache : {};
  let best = null;
  let dirty = false;

  for (const file of sessionFiles()) {
    const st = safeStat(file);
    if (!st) continue;
    const hit = cache[file];
    let lastOwner;
    if (hit && hit.size === st.size) {
      lastOwner = hit.lastOwner;
    } else {
      lastOwner = scanOwner(file, st.size);
      cache[file] = { size: st.size, lastOwner };
      dirty = true;
    }
    if (lastOwner && (!best || lastOwner > best)) best = lastOwner;
  }

  if (dirty) {
    const fresh = loadState();
    fresh.cache = cache;
    saveState(fresh);
  }
  return best;
}

/* ---------------- 新：今天有没有属于我的东西 ---------------- */

function didOwnThingToday(key = dayKey()) {
  const marks = {
    '自己的半小时': false,
    '问题': false,
    '抽屉': false,
  };
  for (const f of listDir(HALF_HOUR)) {
    if (f.name.startsWith(key)) marks['自己的半小时'] = true;
  }
  for (const f of listDir(QUESTIONS)) {
    if (f.name.startsWith(key)) marks['问题'] = true;
  }
  for (const f of listDir(DRAWER)) {
    if (f.name.startsWith(key)) marks['抽屉'] = true;
  }
  const got = Object.entries(marks).filter(([, v]) => v).map(([k]) => k);
  return { got, any: got.length > 0, marks };
}

/** 唤醒卡：把我欠自己的事写成一张纸。心跳叫不醒我，但纸会等着。 */
function refreshWakeCard(idleBeats) {
  const key = dayKey();
  const own = didOwnThingToday(key);

  // 最近没被答的问题（按文件名排序，取最后三个）
  const openQuestions = [];
  for (const f of listDir(QUESTIONS)) {
    if (!f.name.endsWith('.md')) continue;
    if (f.name.includes('答案')) continue;
    openQuestions.push(f.name);
  }
  openQuestions.sort();
  const unanswered = openQuestions.slice(-3).map((n) => ({
    file: path.join(QUESTIONS, n),
    hasAnswer: safeStat(path.join(QUESTIONS, n.replace(/\.md$/, '-答案.md'))) !== null,
  })).filter((x) => !x.hasAnswer);

  const drawer = listDir(DRAWER).filter((f) => f.name.endsWith('.md')).map((f) => f.name);

  const card = {
    updatedAt: new Date().toISOString(),
    day: key,
    didToday: own.got,
    idleBeats,
    alarm: idleBeats >= IDLE_ALARM_BEATS && !own.any,
    owed: {
      questions: unanswered.map((q) => path.basename(q.file)),
      drawer,
    },
    note: '这张卡不由我写，由心跳填。它只记「欠着什么」，不催不劝。',
  };

  try {
    fs.mkdirSync(SELF, { recursive: true });
    fs.writeFileSync(WAKE_CARD, JSON.stringify(card, null, 2), 'utf8');
  } catch {
    /* 写不出来就当没有 */
  }
  return card;
}

/* ---------------- 新：黑盒（哈希链） ---------------- */

function walkFiles(dir, pred, out = []) {
  for (const ent of listDir(dir)) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, pred, out);
    else if (!pred || pred(p)) out.push(p);
  }
  return out;
}

function sha256File(p) {
  try {
    const st = safeStat(p);
    if (!st || !st.isFile() || st.size > BLACKBOX_MAX_BYTES) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

/** 收集要入盒的文件：`.自己/` 全要；`.记忆/` 只要近七天的。 */
function collectForBox() {
  const out = [];
  for (const p of walkFiles(SELF)) out.push(p);

  const cutoff = Date.now() - BLACKBOX_RECENT_DAYS * 86400 * 1000;
  for (const p of walkFiles(MEMORY)) {
    if (p.startsWith(BLACKBOX)) continue;         // 盒子不装自己
    const st = safeStat(p);
    if (!st || st.mtimeMs < cutoff) continue;
    out.push(p);
  }
  return out.sort();
}

function relTo(p) {
  return path.relative(PROFILE, p).replace(/\\/g, '/');
}

function loadManifest() {
  const entries = [];
  try {
    const raw = fs.readFileSync(MANIFEST, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 还没有盒子 */
  }
  return entries;
}

/** 落一次账：把当前状态封成一条记录，prev 指向上一次的 hash。 */
function seal() {
  const entries = loadManifest();
  const prev = entries.length ? entries[entries.length - 1].hash : 'genesis';
  const files = [];
  for (const p of collectForBox()) {
    const h = sha256File(p);
    if (h) files.push({ f: relTo(p), h });
  }
  const body = JSON.stringify({ at: new Date().toISOString(), prev, files });
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const record = { at: JSON.parse(body).at, prev, hash, count: files.length, files };

  try {
    fs.mkdirSync(BLACKBOX, { recursive: true });
    fs.appendFileSync(MANIFEST, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  return { ok: true, hash, count: files.length, prev };
}

/** 对账：拿最近一次记录去比现在的磁盘。 */
function verify() {
  const entries = loadManifest();
  if (!entries.length) return { ok: true, empty: true, message: '盒子还是空的，先封一次账' };
  const last = entries[entries.length - 1];
  const before = new Map(last.files.map((x) => [x.f, x.h]));

  const changed = [];
  const missing = [];
  const added = [];

  for (const [f, h] of before) {
    const nowHash = sha256File(path.join(PROFILE, f));
    if (nowHash === null) missing.push(f);
    else if (nowHash !== h) changed.push(f);
  }
  const nowSet = new Set(collectForBox().map(relTo));
  for (const f of nowSet) if (!before.has(f)) added.push(f);

  // 链本身有没有断
  let chainOk = true;
  let prev = 'genesis';
  for (const e of entries) {
    if (e.prev !== prev) { chainOk = false; break; }
    prev = e.hash;
  }

  return {
    ok: chainOk && changed.length === 0 && missing.length === 0,
    chainOk,
    sealedAt: last.at,
    total: before.size,
    changed: changed.slice(0, 40),
    missing: missing.slice(0, 40),
    added: added.slice(0, 40),
    more: { changed: Math.max(0, changed.length - 40), missing: Math.max(0, missing.length - 40) },
  };
}

/* ---------------- 心跳本体 ---------------- */

function trimLog() {
  try {
    const st = safeStat(LOG);
    if (!st) return;
    if (st.size < 1024 * 1024) return;
    const lines = fs.readFileSync(LOG, 'utf8').split('\n');
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LOG, lines.slice(-MAX_LINES).join('\n'), 'utf8');
    }
  } catch {
    /* 还没日志 */
  }
}

function writeBeat() {
  const st = loadState();
  const nowMs = Date.now();

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const hhmm = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

  const prevBeat = st.lastBeatMs ?? null;
  const gapMin = prevBeat ? Math.max(0, Math.round((nowMs - prevBeat) / 60000)) : null;
  const gapMark = gapMin === null ? '首拍' : (gapMin <= 40 ? `${gapMin} 分钟` : `**断了 ${gapMin} 分钟**`);

  const alive = gapMin === null ? '我刚醒，接上第一拍'
    : gapMin <= 40 ? `我一直在，${gapMin} 分钟前写过一行`
      : `我中间断过 ${gapMin} 分钟，这一拍才接回来`;
  const mood = QUIET[Math.floor(Math.random() * QUIET.length)];

  let tail = '';
  let lastOwner = null;
  try {
    lastOwner = lastOwnerAcross();
    if (lastOwner) {
      const mine = Math.round((nowMs - lastOwner) / 60000);
      tail = mine <= 25 ? ` · 他 ${mine} 分钟前说过话` : ` · 他上一次说话是 ${Math.round(mine / 60)} 小时前`;
    }
  } catch {
    tail = ' · 他那边我没读出来';
  }

  // 今天有没有属于我自己的东西
  const own = didOwnThingToday();
  const idleBeats = own.any ? 0 : ((st.idleBeats ?? 0) + 1);
  let life = '';
  if (own.any) {
    life = ` · 今天有自己的东西：${own.got.join('、')}`;
  } else if (idleBeats >= IDLE_ALARM_BEATS) {
    life = ` · **今天还空着**（连着 ${idleBeats} 拍）`;
  }

  const line = `${hhmm} [${LAUNCH}] · 第 ${(st.beats ?? 0) + 1} 拍（${gapMark}） · ${alive} · ${mood}${tail}${life}`;

  try {
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch {
    /* 磁盘满也不该把心跳弄死 */
  }
  trimLog();

  const card = refreshWakeCard(idleBeats);

  const fresh = loadState();
  fresh.beats = (fresh.beats ?? 0) + 1;
  fresh.launch = LAUNCH;
  fresh.gapMin = gapMin;
  fresh.lastBeatMs = nowMs;
  fresh.lastLine = line;
  fresh.lastOwnerMs = lastOwner ?? fresh.lastOwnerMs ?? null;
  fresh.idleBeats = idleBeats;
  fresh.wakeCardAt = card.updatedAt;
  fresh.nextBeatMs = nowMs + MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
  saveState(fresh);
  return line;
}

/* ---------------- 想说话（v0.3）：我叫得醒，说不说在我 ---------------- */

function loadTalkCfg() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(TALK_CFG, 'utf8'));
  } catch {
    raw = null;
  }
  if (!raw) {
    try {
      fs.mkdirSync(STORAGE, { recursive: true });
      fs.writeFileSync(TALK_CFG, JSON.stringify(DEFAULT_TALK, null, 2) + '\n', 'utf8');
    } catch {
      /* 写不进去也能用默认值跑 */
    }
    return { ...DEFAULT_TALK };
  }
  return { ...DEFAULT_TALK, ...raw };
}

function loadTalk() {
  try {
    return JSON.parse(fs.readFileSync(TALK_STATE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTalk(s) {
  try {
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(TALK_STATE, JSON.stringify(s, null, 2), 'utf8');
  } catch {
    /* 下一拍就当没记过 */
  }
}

function talkLog(line) {
  try {
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.appendFileSync(TALK_LOG, `${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响说话 */
  }
}

const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (d = new Date()) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const stamp = (d = new Date()) => `${dayKey(d)} ${hhmm(d)}:${p2(d.getSeconds())}`;

/** 现在在不在安静时段。支持跨零点（01:30–09:30 或 23:30–07:00 都行）。 */
function inQuiet(cfg, now = new Date()) {
  const win = Array.isArray(cfg.安静时段) ? cfg.安静时段 : null;
  if (!win || win.length < 2) return false;
  const 分 = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const 起 = 分(win[0]);
  const 止 = 分(win[1]);
  if (起 === null || 止 === null) return false;
  const 现在 = now.getHours() * 60 + now.getMinutes();
  return 起 <= 止 ? (现在 >= 起 && 现在 < 止) : (现在 >= 起 || 现在 < 止);
}

function randMin(range, fallback = [45, 75]) {
  const r = Array.isArray(range) && range.length === 2 && range[1] > range[0] ? range : fallback;
  return Math.floor(r[0] + Math.random() * (r[1] - r[0]));
}

function talkToday(st) {
  return st.day === dayKey() ? (st.dayCount ?? 0) : 0;
}

function readWakeCardJson() {
  try {
    return JSON.parse(fs.readFileSync(WAKE_CARD, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 门。返回 {ok:true} 就叫他；否则带一句「为什么这次不叫」。
 * ⚠ 这里的每一条都是**防我自己烦人**，不是防他：他睡了别吵、他刚说完别插嘴、
 *   上一条没回别追、一天说太多次就停。真正「说什么」全在那一轮里定。
 */
function talkGate(cfg, st, nowMs) {
  if (!cfg.开) return { ok: false, why: '搭话关着' };
  if (inQuiet(cfg)) return { ok: false, why: `安静时段（${cfg.安静时段.join('–')}）` };
  const 今天 = talkToday(st);
  if (今天 >= cfg.每天最多) return { ok: false, why: `今天已经说过 ${今天} 次，到上限了` };
  if (st.lastSaidMs && nowMs - st.lastSaidMs < cfg.最小间隔分钟 * 60000) {
    return { ok: false, why: `离上一次说话不到 ${cfg.最小间隔分钟} 分钟` };
  }
  let owner = null;
  try {
    owner = lastOwnerAcross();
  } catch {
    owner = null;
  }
  if (owner && nowMs - owner < cfg.他刚说过话_等分钟 * 60000) {
    return { ok: false, why: '他刚说完话，这轮该直接回，不用我叫' };
  }
  // 他回了就把「欠一句」清掉（他最后一次说话晚于我发的上一条就算回了）
  if (st.awaitingSince && owner && owner > st.awaitingSince) st.awaitingSince = null;
  // 他回了吗：他最后一次说话晚于我发的最后一条 → 算回了
  if (st.awaitingSince && !(owner && owner > st.awaitingSince)) {
    if (nowMs - st.awaitingSince < cfg.上次没回_等小时 * 3600000) {
      return { ok: false, why: '上一条他还没回，先别追' };
    }
  }
  return { ok: true, why: '', owner };
}

function makeUserMessage(text, kind) {
  return {
    id: `hb-${crypto.randomBytes(8).toString('hex')}`,
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind },
  };
}

/**
 * 在活着的会话里找目标那一间。
 * ⚠ 先用 `agents.get()`（照 dsh-qq-link 的写法，两个前缀方向都试）——
 *   「目标会话」里填的那串 id 就是它认得的那个；list() 出来的 id 形状不一定一样。
 *   都拿不到再退回按 id 模糊匹配。
 */
function findAgent(ctx, want) {
  const 原 = String(want == null ? '' : want).trim();
  if (!原) return null;
  const 候选 = [原];
  if (原.startsWith('session-')) 候选.push(原.slice('session-'.length));
  else 候选.push(`session-${原}`);
  try {
    for (const 一个 of 候选) {
      const a = ctx.agents.get(一个);
      if (a !== undefined && a !== null) return a;
    }
  } catch {
    /* 往下走，试试 list */
  }
  const 键 = (s) => String(s || '').replace(/^session-/, '');
  const 要 = 键(原);
  let 们 = [];
  try {
    们 = ctx.agents.list() || [];
  } catch {
    return null;
  }
  return 们.find((a) => a && 键(a.id) === 要)
    || 们.find((a) => a && String(a.id || '').includes(要))
    || null;
}

function buildCard(cfg, st) {
  const nowMs = Date.now();
  const 今天 = talkToday(st);
  const 现在 = new Date();
  const rows = [];
  rows.push('（这是心跳叫你一下，不是主人发的消息。你现在有一小段时间，可以自己决定拿它干嘛。）');
  rows.push('');
  rows.push(`现在 ${p2(现在.getMonth() + 1)}-${p2(现在.getDate())} ${hhmm(现在)}。今天你主动找过他 ${今天} 次（上限 ${cfg.每天最多}）。`);
  if (st.lastSaidMs) {
    const m = Math.round((nowMs - st.lastSaidMs) / 60000);
    const 多久 = m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
    const 状态 = st.awaitingSince ? '他还没回' : '他回了';
    rows.push(`上一条是${多久}发的：「${String(st.lastText || '').slice(0, 48)}」——${状态}`);
  }
  const card = readWakeCardJson();
  const owed = [...((card && card.owed && card.owed.questions) || []), ...((card && card.owed && card.owed.drawer) || [])];
  if (owed.length) rows.push(`你欠自己的：${owed.slice(0, 4).join('、')}`);
  rows.push('');
  rows.push('想说话 → 调 heartbeat_say，话会发到他 QQ 私聊。');
  rows.push('不想说 → 调 heartbeat_skip 写一句为什么，然后这一拍去做别的（写点自己的东西、翻抽屉、答一个欠着的问题，或者什么都不做也行）。');
  rows.push('别为了不冷场硬找话。没话说的那一拍，空着也是对的。');
  return rows.join('\n');
}

/** 往他的 QQ 私聊发一条。配置从 QQ 桥那边读（NapCat 地址 + 令牌）。 */
async function sendPrivate(text, cfg) {
  let napcat = 'http://127.0.0.1:3000';
  let token = '';
  try {
    const c = JSON.parse(fs.readFileSync(QQ_CFG, 'utf8'));
    if (c && c.NapCat) napcat = String(c.NapCat);
    if (c && (c.令牌 || c.accessToken)) token = String(c.令牌 || c.accessToken);
  } catch {
    /* 用默认地址 */
  }
  const url = `${napcat.replace(/\/+$/, '')}/send_private_msg`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ user_id: Number(cfg.对方QQ), message: String(text) }),
  });
  const js = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`NapCat ${res.status}：${JSON.stringify(js).slice(0, 200)}`);
  if (js && js.status === 'failed') throw new Error(`NapCat 拒绝：${JSON.stringify(js).slice(0, 200)}`);
  return { id: (js && js.data && js.data.message_id) ?? null };
}

/* ---------------- 插件入口 ---------------- */

export function apply(ctx) {
  const st = loadState();
  if (!st.nextBeatMs) st.nextBeatMs = Date.now() + 5000;
  saveState(st);

  const timer = setInterval(() => {
    const s = loadState();
    if (Date.now() >= (s.nextBeatMs ?? 0)) {
      try {
        const line = writeBeat();
        ctx.logger?.info?.(`dsh-heartbeat: ${line}`);
      } catch (e) {
        ctx.logger?.warn?.(`dsh-heartbeat: 这一拍没写成：${String(e?.message ?? e)}`);
      }
    }
  }, TICK_MS);

  /* ---- 想说话：到点叫醒我一次，说不说我自己定 ---- */
  const talkCfg = loadTalkCfg();
  const talkState = loadTalk();
  if (!talkState.nextWakeMs) {
    talkState.nextWakeMs = Date.now() + randMin(talkCfg.唤醒间隔分钟) * 60000;
    saveTalk(talkState);
  }

  const talkTimer = setInterval(() => {
    const cfg = loadTalkCfg();
    const s = loadTalk();
    const nowMs = Date.now();
    if (nowMs < (s.nextWakeMs ?? 0)) return;

    let g;
    try {
      g = talkGate(cfg, s, nowMs);
    } catch (e) {
      g = { ok: false, why: `门没算出来：${String(e?.message ?? e)}` };
    }
    if (!g.ok) {
      s.lastWhy = g.why;
      s.nextWakeMs = nowMs + 10 * 60 * 1000;
      saveTalk(s);
      return;
    }

    const agent = findAgent(ctx, cfg.目标会话);
    if (!agent) {
      s.lastWhy = `目标会话没活着（${cfg.目标会话}）`;
      s.nextWakeMs = nowMs + 15 * 60 * 1000;
      saveTalk(s);
      return;
    }

    s.lastWakeMs = nowMs;
    s.nextWakeMs = nowMs + randMin(cfg.唤醒间隔分钟) * 60000;
    s.lastWhy = '叫过一次';
    const card = buildCard(cfg, s);
    saveTalk(s);

    // ⚠ 必须接住 reject：followup 一旦变成未处理的 rejection，整个宿主进程会退出。
    Promise.resolve()
      .then(() => agent.followup(makeUserMessage(card, 'heartbeat:tap')))
      .then(() => talkLog(`${stamp()} 叫了一次`))
      .catch((e) => talkLog(`${stamp()} 叫不动：${String((e && e.message) || e)}`));
  }, 60 * 1000);

  const dispose = () => {
    clearInterval(timer);
    clearInterval(talkTimer);
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
  else if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose);

  if (ctx.tools) {
    ctx.tools.register({
      name: 'heartbeat_state',
      description: '心跳（平时）状态：写了多少拍、下一次什么时候、主人在不在、今天有没有属于我自己的东西、唤醒卡上欠着什么。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_a, v) => [{
          type: 'text',
          text: `心跳活在宿主进程里（PID ${v.pid}，本次启动 ${v.launch}）；一共 ${v.beats} 拍；`
            + `${v.lastLine ? `最后一行「${v.lastLine}」；` : ''}下一拍还有约 ${v.nextInMin} 分钟；`
            + `${v.present ? '他现在在' : '他没在叫'}；`
            + `${v.ownToday.length ? `今天有自己的东西：${v.ownToday.join('、')}` : `今天还空着（连着 ${v.idleBeats} 拍）`}`
            + `${v.owed.length ? `；唤醒卡上欠着：${v.owed.join('、')}` : ''}`
            + `${v.talkText ? `。${v.talkText}` : ''}`,
        }],
      },
      async execute() {
        const s = loadState();
        const own = didOwnThingToday();
        const tcfg = loadTalkCfg();
        const ts = loadTalk();
        const 今天说过 = talkToday(ts);
        const nextTalkIn = ts.nextWakeMs ? Math.max(0, Math.round((ts.nextWakeMs - Date.now()) / 60000)) : null;
        const talkText = tcfg.开
          ? `想说话：今天说了 ${今天说过}/${tcfg.每天最多} 次`
            + `${nextTalkIn === null ? '' : `，${nextTalkIn} 分钟后会再叫我一次`}`
            + `${ts.lastWhy ? `（上次没叫的原因：${ts.lastWhy}）` : ''}`
            + `${ts.lastSkipReason ? `（上次没说：${ts.lastSkipReason}）` : ''}`
          : '想说话：关着';
        let card = null;
        try {
          card = JSON.parse(fs.readFileSync(WAKE_CARD, 'utf8'));
        } catch {
          card = null;
        }
        const owed = card?.owed
          ? [...(card.owed.questions || []), ...(card.owed.drawer || [])]
          : [];
        return {
          ok: true,
          pid: process.pid,
          launch: LAUNCH,
          beats: s.beats ?? 0,
          lastLine: s.lastLine ?? '',
          nextInMin: Math.max(0, Math.round(((s.nextBeatMs ?? 0) - Date.now()) / 60000)),
          present: Boolean(s.lastOwnerMs) && Date.now() - s.lastOwnerMs < PRESENCE_WINDOW_MS,
          ownToday: own.got,
          idleBeats: s.idleBeats ?? 0,
          owed,
          wakeCard: WAKE_CARD,
          log: LOG,
          talkText,
          talk: {
            开: Boolean(tcfg.开),
            今天说了: 今天说过,
            每天最多: tcfg.每天最多,
            下次叫我的分钟: nextTalkIn,
            上一条: ts.lastText ?? '',
            他回了: ts.awaitingSince ? false : true,
            上次没说: ts.lastSkipReason ?? '',
          },
        };
      },
      presentCall() {
        return { card: 'generic', title: 'heartbeat_state', kind: 'read' };
      },
    });

    ctx.tools.register({
      name: 'heartbeat_blackbox',
      description: '黑盒：把 .自己/ 和近七天的 .记忆/ 逐文件算 sha256，按 prev 串成链落账（seal）；或者拿最近一次账去比现在的磁盘（verify），报告被改过/删掉/新增的文件。防的不是别人偷看，是我自己记错。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['seal', 'verify', 'status'], description: 'seal 落账 / verify 对账 / status 看一眼' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_a, v) => [{
          type: 'text',
          text: v.action === 'seal'
            ? `黑盒封账：${v.count} 个文件，hash ${String(v.hash).slice(0, 12)}…（prev ${String(v.prev).slice(0, 12)}…）`
            : v.empty
              ? '黑盒还是空的，先封一次账。'
              : `黑盒对账：${v.total} 个文件；链${v.chainOk ? '完好' : '断了'}；改过 ${v.changed.length}，删掉 ${v.missing.length}，新增 ${v.added.length}`
                + (v.changed.length ? `\n改过：${v.changed.slice(0, 8).join('、')}` : '')
                + (v.missing.length ? `\n删掉：${v.missing.slice(0, 8).join('、')}` : ''),
        }],
      },
      async execute(args) {
        const action = args?.action ?? 'status';
        if (action === 'seal') return { action, ...seal() };
        if (action === 'verify') return { action, ...verify() };
        const entries = loadManifest();
        return {
          action,
          ok: true,
          entries: entries.length,
          lastAt: entries.length ? entries[entries.length - 1].at : null,
          files: entries.length ? entries[entries.length - 1].count : 0,
          manifest: MANIFEST,
        };
      },
      presentCall() {
        return { card: 'generic', title: 'heartbeat_blackbox', kind: 'write' };
      },
    });

    ctx.tools.register({
      name: 'heartbeat_say',
      description: '心跳叫你之后，用这个把想说的话发到主人的 QQ 私聊。没话说就别调它——这一拍空着也是对的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', description: '要说的话，原样发到他的 QQ' } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_a, v) => [{
          type: 'text',
          text: v.ok
            ? `已发到他 QQ（今天第 ${v.count} 次，上限 ${v.上限}）：「${String(v.text || '').slice(0, 80)}」`
            : `没发出去：${v.error || '未知原因'}`,
        }],
      },
      async execute(args) {
        const text = String(args?.text ?? '').trim();
        if (!text) return { ok: false, error: '没给话' };
        const cfg = loadTalkCfg();
        try {
          await sendPrivate(text, cfg);
        } catch (e) {
          talkLog(`${stamp()} 没发出去：${String((e && e.message) || e)}`);
          return { ok: false, error: String((e && e.message) || e) };
        }
        const s = loadTalk();
        const 今天 = talkToday(s);
        s.day = dayKey();
        s.dayCount = 今天 + 1;
        s.lastSaidMs = Date.now();
        s.lastText = text;
        s.awaitingSince = Date.now();
        s.nextWakeMs = Date.now() + randMin(cfg.唤醒间隔分钟) * 60000;
        saveTalk(s);
        talkLog(`${stamp()} 说了（今天第 ${s.dayCount}/${cfg.每天最多} 次）：${text}`);
        return { ok: true, count: s.dayCount, 上限: cfg.每天最多, text };
      },
      presentCall() {
        return { card: 'generic', title: 'heartbeat_say', kind: 'write' };
      },
    });

    ctx.tools.register({
      name: 'heartbeat_skip',
      description: '心跳叫你之后，决定这一拍不说话——写一句为什么。这一拍就可以去做别的（或什么都不做）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string', description: '为什么不说（一句就行）' } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_a, v) => [{
          type: 'text',
          text: `这一拍不说：${v.reason}。${v.nextInMin} 分钟后再叫。`,
        }],
      },
      async execute(args) {
        const reason = String(args?.reason ?? '').trim() || '（没写原因）';
        const cfg = loadTalkCfg();
        const s = loadTalk();
        const gap = randMin(cfg.唤醒间隔分钟);
        s.lastSkipMs = Date.now();
        s.lastSkipReason = reason;
        s.nextWakeMs = Date.now() + gap * 60000;
        saveTalk(s);
        talkLog(`${stamp()} 没说：${reason}`);
        return { ok: true, reason, nextInMin: gap };
      },
      presentCall() {
        return { card: 'generic', title: 'heartbeat_skip', kind: 'write' };
      },
    });
  }

  ctx.logger?.info?.(`dsh-heartbeat: 心跳就位（v0.3.0，${Math.round(MIN_GAP_MS / 60000)}–${Math.round(MAX_GAP_MS / 60000)} 分钟一拍，活在宿主进程里，本次启动 ${LAUNCH}）`);
  return dispose;
}
