#!/usr/bin/env node
/* ============================================================
   1on1練習シミュレーター E2E自動テスト

   使い方:
     cd test
     npm install          # 初回のみ（Puppeteer＋Chromiumが入ります）
     npm test             # game.dev.html を対象にテスト
     npm test -- --release  # ビルド産物 index.html を対象にテスト

   テスト内容:
     [T1] スモーク       : 起動時のJSエラー・リソース読込失敗ゼロ
     [T2] シナリオlint    : 括弧の不整合・連続重複セリフ・空セリフ・話者名の表記ゆれ
     [T3] 全シーン巡回    : 全シーンに直接ジャンプして全ビートを実際に描画し、
                           JSエラー / 空表示 / テキストボックスあふれ / 画像未読込を検出
     [T4] 通しプレイ×4   : 戦略別（全誠実/全ふざけ/全weird/ランダム）にエンディングまで
                           自動プレイし、想定どおりの診断・判定に到達するか検証
     [T5] UI機能         : バックログ表示・オートモードの動作確認

   結果: コンソール出力 ＋ report/report.md ＋ report/screenshots/
   ============================================================ */
const fs = require('fs');
const path = require('path');

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch {
  console.error('puppeteer が見つかりません。test/ ディレクトリで `npm install` を実行してください。');
  process.exit(1);
}

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const RELEASE = process.argv.includes('--release');
const TARGET = 'file://' + path.join(ROOT, RELEASE ? path.join('public', 'index.html') : 'game.dev.html');
const REPORT_DIR = path.join(HERE, 'report');
const SHOT_DIR = path.join(REPORT_DIR, 'screenshots');
const KNOWN_SPEAKERS = new Set(['', 'あなた', '真受田', '石割', '鈴木', '人事部代表']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];   // {test, status, detail}
const warns = [];
let shots = 0;

function loadGame() {
  const src = fs.readFileSync(path.join(ROOT, 'scenario.js'), 'utf8');
  const s = src.indexOf('const GAME = ') + 'const GAME = '.length;
  const e = src.lastIndexOf('};') + 1;
  return eval('(' + src.slice(s, e) + ')');
}

/* ---------- T2: シナリオlint（静的・厳密） ---------- */
function lintScenario(GAME) {
  const issues = [];
  const pairs = [['「', '」'], ['（', '）'], ['『', '』']];
  for (const [sid, sc] of Object.entries(GAME.scenes)) {
    const beats = sc.beats || [];
    let prev = null;
    beats.forEach((b, i) => {
      const t = b.t ?? '';
      if (['d', 'thought', 'stage', 'system'].includes(b.k) && t.trim() === '')
        issues.push(`${sid}#${i}: 空のテキスト`);
      for (const [open, close] of pairs) {
        const o = (t.match(new RegExp(open, 'g')) || []).length;
        const c = (t.match(new RegExp(close, 'g')) || []).length;
        if (o !== c) issues.push(`${sid}#${i}: 括弧の不整合 ${open}×${o} vs ${close}×${c} …「${t.slice(0, 28)}…」`);
      }
      if (prev !== null && t === prev && t.length > 8)
        issues.push(`${sid}#${i}: 直前と同一のテキストが連続 …「${t.slice(0, 28)}…」`);
      prev = t;
      if (b.k === 'd' && b.s !== undefined && !KNOWN_SPEAKERS.has(b.s))
        issues.push(`${sid}#${i}: 未知の話者名「${b.s}」（表記ゆれ？）`);
      if (/\s$|^\s/.test(t)) issues.push(`${sid}#${i}: 先頭/末尾に余分な空白`);
    });
    (sc.choices || []).forEach((c, i) => {
      if (!c.label || !c.label.trim()) issues.push(`${sid} 選択肢${i + 1}: ラベルが空`);
    });
  }
  return issues;
}

/* ---------- ブラウザ共通 ---------- */
async function newPage(browser, collector) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', e => collector.push(`[JSエラー] ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return; // GA/フォント等の外部CDN（オフライン時は失敗して当然）
    collector.push(`[console.error] ${t.slice(0, 120)}`);
  });
  page.on('requestfailed', r => {
    const u = r.url();
    // 外部ドメイン（GA/フォント）はオフライン環境で失敗して当然なので除外
    if (u.startsWith('file://')) collector.push(`[読込失敗] ${u}`);
  });
  return page;
}

const readState = page => page.evaluate(() => ({
  cur: state.current,
  beat: state.beatIndex,
  choice: document.getElementById('choices-overlay')?.classList.contains('visible') || false,
  end: document.getElementById('end-screen')?.classList.contains('visible') || false,
  dlg: document.getElementById('dialogue-text')?.textContent || '',
  speaker: document.getElementById('speaker-name')?.textContent || '',
}));

const checkRender = page => page.evaluate(() => {
  const out = [];
  const dlg = document.getElementById('dialogue-text');
  if (dlg && dlg.scrollHeight > dlg.clientHeight + 6)
    out.push(`テキストあふれ(scroll ${dlg.scrollHeight} > box ${dlg.clientHeight}): 「${dlg.textContent.slice(0, 30)}…」`);
  document.querySelectorAll('img.visible, img[style*="opacity: 1"]').forEach(img => {
    const attr = img.getAttribute('src');
    if (attr && img.complete && img.naturalWidth === 0) out.push(`画像未読込: ${img.id || attr.slice(0, 60)}`);
  });
  return out;
});

/* ---------- T3: 全シーン巡回 ---------- */
async function crawlAllScenes(browser, GAME) {
  const errs = [];
  const pageErrs = [];
  const page = await newPage(browser, pageErrs);
  const ids = Object.keys(GAME.scenes);
  let visitedBeats = 0;

  for (const sid of ids) {
    await page.goto(`${TARGET}?scene=${sid}`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const maxClicks = ((GAME.scenes[sid].beats || []).length + 4) * 3;
    for (let i = 0; i < maxClicks; i++) {
      const st = await readState(page).catch(() => null);
      if (!st) break;
      const render = await checkRender(page);
      render.forEach(r => errs.push(`${sid}: ${r}`));
      if (st.cur !== sid || st.end) break;                 // 次シーンへ遷移した
      if (st.choice) {                                      // 選択肢到達＝このシーン踏破
        await page.screenshot({ path: path.join(SHOT_DIR, `choice_${sid}.png`) }); shots++;
        break;
      }
      if (st.speaker && !KNOWN_SPEAKERS.has(st.speaker))
        errs.push(`${sid}: 画面上の話者名が未知「${st.speaker}」`);
      visitedBeats++;
      await page.mouse.click(640, 300);
      await sleep(70);
    }
  }
  await page.close();
  return { errs: [...errs, ...pageErrs], visitedBeats, sceneCount: ids.length };
}

/* ---------- T4: 戦略別通しプレイ ---------- */
async function playthrough(browser, GAME, strategyName, pickFn, expect) {
  const pageErrs = [];
  const page = await newPage(browser, pageErrs);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.click('#btn-start');
  await sleep(1200);

  let picks = 0;
  let lastScene = '';
  for (let i = 0; i < 1500; i++) {
    const st = await readState(page).catch(() => null);
    if (!st) break;
    lastScene = st.cur;
    if (st.end) break;
    if (st.choice) {
      const scene = GAME.scenes[st.cur];
      const idx = pickFn(scene.choices);
      await page.evaluate(n => document.querySelectorAll('#choices-overlay .choice-btn')[n]?.click(), idx);
      picks++;
      await sleep(300);
      continue;
    }
    await page.mouse.click(640, 300);
    await sleep(60);
  }
  const endInfo = await page.evaluate(() => ({
    end: document.getElementById('end-screen')?.classList.contains('visible') || false,
    body: document.getElementById('end-body')?.textContent || '',
    score: document.getElementById('end-score')?.textContent || '',
  }));
  await page.screenshot({ path: path.join(SHOT_DIR, `ending_${strategyName}.png`) }); shots++;
  await page.close();

  const errs = [...pageErrs];
  if (!endInfo.end) errs.push(`エンディングに到達できませんでした（選択${picks}回 / 最終シーン: ${lastScene}）`);
  if (expect.type && !endInfo.body.includes(expect.type))
    errs.push(`診断タイプ不一致: 期待「${expect.type}」が結果本文に見つかりません`);
  if (expect.risk && !endInfo.body.includes(expect.risk))
    errs.push(`リスク判定不一致: 期待「${expect.risk}」が結果本文に見つかりません`);
  return { errs, endInfo, picks };
}

const pickByType = prefer => choices => {
  for (const p of prefer) {
    const i = choices.findIndex(c => c.type === p);
    if (i >= 0) return i;
  }
  return 0;
};

/* ---------- T5: UI機能 ---------- */
async function uiTest(browser) {
  const pageErrs = [];
  const page = await newPage(browser, pageErrs);
  const errs = [...pageErrs];
  await page.goto(`${TARGET}?scene=mauta_001`, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  for (let i = 0; i < 6; i++) { await page.mouse.click(640, 300); await sleep(100); }

  // バックログ
  await page.click('#btn-log');
  await sleep(400);
  const logCount = await page.evaluate(() => document.querySelectorAll('#log-body > *').length);
  if (logCount < 2) errs.push(`バックログの行数が不足（${logCount}行）`);
  await page.click('#log-close');
  await sleep(300);

  // オートモード：クリックなしでビートが進むか
  const b0 = (await readState(page)).beat;
  await page.click('#btn-auto');
  await sleep(4500);
  const b1 = (await readState(page)).beat;
  if (b1 === b0) errs.push(`オートモードでビートが進みません（${b0}→${b1}）`);
  await page.close();
  return errs;
}

/* ---------- メイン ---------- */
(async () => {
  fs.rmSync(REPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const t0 = Date.now();
  const GAME = loadGame();
  console.log(`対象: ${TARGET}\nシーン数: ${Object.keys(GAME.scenes).length}\n`);

  // T2 lint（ブラウザ不要なので先に）
  const lint = lintScenario(GAME);
  results.push({ test: 'T2 シナリオlint', status: lint.length ? 'WARN' : 'PASS', detail: lint });
  warns.push(...lint.map(l => 'lint: ' + l));

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-gpu'],
    headless: 'new',
  });

  // T1 スモーク
  {
    const errs = [];
    const page = await newPage(browser, errs);
    await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const title = await page.evaluate(() => ({
      visible: !!document.getElementById('title-screen'),
      startBtn: !!document.getElementById('btn-start'),
    }));
    if (!title.visible || !title.startBtn) errs.push('タイトル画面またはスタートボタンが表示されません');
    await page.screenshot({ path: path.join(SHOT_DIR, 'title.png') }); shots++;
    await page.close();
    results.push({ test: 'T1 スモーク', status: errs.length ? 'FAIL' : 'PASS', detail: errs });
  }

  // T3 全シーン巡回
  {
    const { errs, visitedBeats, sceneCount } = await crawlAllScenes(browser, GAME);
    results.push({
      test: `T3 全シーン巡回（${sceneCount}シーン・${visitedBeats}ビート描画）`,
      status: errs.length ? 'FAIL' : 'PASS', detail: errs,
    });
  }

  // T4 通しプレイ×4
  const strategies = [
    ['all_normal', pickByType(['normal']), { type: '教科書', risk: 'リストラ対象外' }],
    ['all_crazy', pickByType(['crazy', 'weird']), { type: 'フリースタイル', risk: 'リストラ確定' }],
    ['all_weird', pickByType(['weird', 'crazy']), {}],
    ['random', cs => Math.floor(Math.random() * cs.length), {}],
  ];
  for (const [name, fn, expect] of strategies) {
    const { errs, endInfo, picks } = await playthrough(browser, GAME, name, fn, expect);
    const verdict = ['リストラ対象外', 'リストラ候補', 'リストラ確定'].find(v => endInfo.body.includes(v)) || '未到達';
    const m = endInfo.body.match(/あなたのタイプ(.{4,12}?)あなたは/);
    results.push({
      test: `T4 通しプレイ[${name}]（選択${picks}回 → ${m ? m[1] : '?'} / ${verdict} / ${endInfo.score}）`,
      status: errs.length ? 'FAIL' : 'PASS', detail: errs,
    });
  }

  // T5 UI機能
  {
    const errs = await uiTest(browser);
    results.push({ test: 'T5 UI機能（バックログ・オート）', status: errs.length ? 'FAIL' : 'PASS', detail: errs });
  }

  await browser.close();

  // レポート出力
  const fails = results.filter(r => r.status === 'FAIL');
  const lines = [`# E2Eテストレポート`, ``, `- 対象: ${TARGET}`, `- 実行: ${new Date().toLocaleString('ja-JP')}`,
    `- 所要: ${((Date.now() - t0) / 1000).toFixed(0)}秒 / スクリーンショット: ${shots}枚`, ``];
  for (const r of results) {
    lines.push(`## ${r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️' : '❌'} ${r.test}`);
    (r.detail || []).forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }
  fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), lines.join('\n'));

  console.log('────────────────────────────');
  for (const r of results) {
    console.log(`${r.status === 'PASS' ? '✔' : r.status === 'WARN' ? '△' : '✘'} ${r.test}`);
    (r.detail || []).slice(0, 8).forEach(d => console.log('   -', d));
    if ((r.detail || []).length > 8) console.log(`   … 他${r.detail.length - 8}件（report.md参照）`);
  }
  console.log('────────────────────────────');
  console.log(`結果: ${results.filter(r => r.status === 'PASS').length} PASS / ${fails.length} FAIL / 所要 ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
  console.log(`詳細レポート: test/report/report.md / スクショ: test/report/screenshots/`);
  process.exit(fails.length ? 1 : 0);
})();
