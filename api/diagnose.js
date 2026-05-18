// api/diagnose.js — バイオリズム × 四柱推命 本格版
// 四柱八字・通変星・十二運・五行バランスを計算

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応" });

  const { nameA, birthA, genderA, timeA, nameB, birthB, genderB, timeB, targetDate, mode, timezone } = req.body;
  if (!birthA) return res.status(400).json({ error: "一人目の生年月日が不足" });

  const isSolo = mode === "solo" || !birthB;

  // ユーザーのタイムゾーンで「今日」を判定
  const tz = timezone || "Asia/Tokyo";
  let judgeDateStr;
  if (targetDate) {
    judgeDateStr = targetDate; // ユーザー指定日はそのまま使用
  } else {
    // Vercelサーバー(UTC)上で動くが、ユーザーのTZでの「今日」を求める
    const now = new Date();
    judgeDateStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD形式
  }
  const judgeDate = new Date(judgeDateStr + "T00:00:00");
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const isToday = judgeDateStr === todayStr;

  // ========== 一人目の計算 ==========
  const meishikiA = buildMeishiki(birthA, timeA);
  const bioA = calcBiorhythm(diffDays(new Date(birthA), judgeDate));
  const dayPillar = calcDayPillar(judgeDateStr);
  const fortuneA = calcDailyFortune(meishikiA, dayPillar);

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY未設定" });

  if (isSolo) {
    const phy = Math.round(((bioA.physical + 1) / 2) * 100);
    const emo = Math.round(((bioA.emotional + 1) / 2) * 100);
    const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
    // 日運スコアもコンディションに反映（バイオ60% + 日運40%）
    const bioBase = Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);
    const overall = Math.min(100, Math.max(0, Math.round(bioBase * 0.6 + fortuneA.fortuneScore * 0.4)));

    const prompt = buildSoloPrompt({
      name: nameA || "あなた", birthA, genderA, timeA, meishiki: meishikiA,
      fortune: fortuneA, dayPillar, isToday,
      physical: phy, emotional: emo, intellectual: int_, overallScore: overall, judgeDateStr,
    });
    const result = await callGemini(GEMINI_API_KEY, prompt);
    if (result.error) return res.status(502).json({ error: result.error });
    const diagText = isToday ? result.text : sanitizeDateWords(result.text, judgeDateStr);

    return res.status(200).json({
      mode: "solo", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
      meishikiA, fortuneA, dayPillar: { stem: dayPillar.stem, branch: dayPillar.branch, element: dayPillar.elementJP },
      diagnosis: diagText, usedModel: result.model, targetDate: judgeDateStr,
    });
  }

  // ========== 相性診断 ==========
  const meishikiB = buildMeishiki(birthB, timeB);
  const bioB = calcBiorhythm(diffDays(new Date(birthB), judgeDate));
  const fortuneB = calcDailyFortune(meishikiB, dayPillar);

  const phy = Math.round((1 - Math.abs(bioA.physical - bioB.physical) / 2) * 100);
  const emo = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
  const int_ = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);
  const gogyoRel = getGogyoRelation(meishikiA.dayElement, meishikiB.dayElement);

  let bonus = 0;
  if (gogyoRel.includes("相生")) bonus = 12;
  else if (gogyoRel.includes("比和")) bonus = 8;
  else if (gogyoRel.includes("相剋")) bonus = -5;

  // 通変星の相性ボーナス
  const tsuhenCompat = getTsuhenCompatibility(meishikiA.monthTsuhen, meishikiB.monthTsuhen);
  bonus += tsuhenCompat.bonus;

  // 日運の相性ボーナス（二人の日運スコアの平均が高いほどボーナス）
  const avgFortune = (fortuneA.fortuneScore + fortuneB.fortuneScore) / 2;
  const fortuneBonus = Math.round((avgFortune - 50) / 10); // -5 〜 +5

  const bioScore = Math.round(phy * 0.25 + emo * 0.35 + int_ * 0.25);
  const overall = Math.min(100, Math.max(0, bioScore + bonus + fortuneBonus + 15));

  const prompt = buildPairPrompt({
    nameA: nameA || "Aさん", nameB: nameB || "Bさん",
    birthA, birthB, genderA, genderB, timeA, timeB,
    meishikiA, meishikiB, gogyoRel, tsuhenCompat,
    fortuneA, fortuneB, dayPillar, isToday,
    physical: phy, emotional: emo, intellectual: int_, overallScore: overall, judgeDateStr,
  });
  const result = await callGemini(GEMINI_API_KEY, prompt);
  if (result.error) return res.status(502).json({ error: result.error });
  const diagText = isToday ? result.text : sanitizeDateWords(result.text, judgeDateStr);

  return res.status(200).json({
    mode: "pair", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
    meishikiA, meishikiB, gogyoRelation: gogyoRel, tsuhenCompat: tsuhenCompat.label,
    fortuneA, fortuneB, dayPillar: { stem: dayPillar.stem, branch: dayPillar.branch, element: dayPillar.elementJP },
    diagnosis: diagText, usedModel: result.model, targetDate: judgeDateStr,
  });
}

// ================================================================
//  四柱推命 命式計算
// ================================================================

const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const STEM_ELEMENT = {"甲":"wood","乙":"wood","丙":"fire","丁":"fire","戊":"earth","己":"earth","庚":"metal","辛":"metal","壬":"water","癸":"water"};
const JP = {wood:"木",fire:"火",earth:"土",metal:"金",water:"水"};

// 通変星名
const TSUHEN_NAMES = ["比肩","劫財","食神","傷官","偏財","正財","偏官","正官","偏印","印綬"];

// 十二運名
const JUNIUNN = ["長生","沐浴","冠帯","建禄","帝旺","衰","病","死","墓","絶","胎","養"];

// 十二運テーブル: dayStemIndex → branchIndex → juniunIndex
const JUNIUN_TABLE = [
  [1,2,3,4,5,6,7,8,9,10,11,0],  // 甲
  [6,5,4,3,2,1,0,11,10,9,8,7],  // 乙
  [10,11,0,1,2,3,4,5,6,7,8,9],  // 丙
  [7,6,5,4,3,2,1,0,11,10,9,8],  // 丁
  [10,11,0,1,2,3,4,5,6,7,8,9],  // 戊
  [7,6,5,4,3,2,1,0,11,10,9,8],  // 己
  [4,5,6,7,8,9,10,11,0,1,2,3],  // 庚
  [9,8,7,6,5,4,3,2,1,0,11,10],  // 辛
  [1,2,3,4,5,6,7,8,9,10,11,0],  // 壬
  [6,5,4,3,2,1,0,11,10,9,8,7],  // 癸
];

// 節入り日テーブル（簡易版：各月のおおよその節入り日）
const SETSUIRI = [0,6,4,6,5,6,7,7,8,8,8,7,7]; // 月1-12の節入り日（index0はダミー）

function buildMeishiki(dateStr, timeStr) {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();

  // 年柱（立春=2/4前後で切り替え）
  let yearForPillar = y;
  if (m < 2 || (m === 2 && day < 4)) yearForPillar--;
  const yearIdx = ((yearForPillar - 4) % 60 + 60) % 60;
  const yearStem = yearIdx % 10;
  const yearBranch = yearIdx % 12;

  // 月柱（節入り日で切り替え）
  let monthForPillar = m;
  const setsuiri = SETSUIRI[m] || 6;
  if (day < setsuiri) monthForPillar--;
  if (monthForPillar <= 0) { monthForPillar += 12; yearForPillar--; }
  // 月干の計算: 年干 × 2 + 月の地支index
  const monthBranch = ((monthForPillar + 1) % 12); // 1月=寅(2), 2月=卯(3)...
  const monthBranchIdx = (monthForPillar + 1) % 12;
  // 年干から月干を求める（年干×2 + 月支の序数）
  const monthStemBase = (yearStem % 5) * 2;
  const monthStem = (monthStemBase + monthBranchIdx) % 10;

  // 日柱
  const base = new Date(1900, 0, 1);
  const daysDiff = Math.floor((d - base) / 86400000);
  const dayOffset = 10;
  const dayIdx = ((daysDiff + dayOffset) % 60 + 60) % 60;
  const dayStem = dayIdx % 10;
  const dayBranch = dayIdx % 12;

  // 時柱
  let timeStem = null, timeBranch = null;
  if (timeStr) {
    const [h] = timeStr.split(":").map(Number);
    timeBranch = Math.floor(((h + 1) % 24) / 2);
    const timeStemBase = (dayStem % 5) * 2;
    timeStem = (timeStemBase + timeBranch) % 10;
  }

  // 通変星（日干と他の天干の関係）
  const yearTsuhen = getTsuhen(dayStem, yearStem);
  const monthTsuhen = getTsuhen(dayStem, monthStem);
  const timeTsuhen = timeStem !== null ? getTsuhen(dayStem, timeStem) : null;

  // 十二運（日干と各柱の地支の関係）
  const yearJuniun = JUNIUNN[JUNIUN_TABLE[dayStem][yearBranch]];
  const monthJuniun = JUNIUNN[JUNIUN_TABLE[dayStem][monthBranchIdx]];
  const dayJuniun = JUNIUNN[JUNIUN_TABLE[dayStem][dayBranch]];
  const timeJuniun = timeBranch !== null ? JUNIUNN[JUNIUN_TABLE[dayStem][timeBranch]] : null;

  // 五行バランス
  const elements = [yearStem, monthStem, dayStem];
  if (timeStem !== null) elements.push(timeStem);
  const branches = [yearBranch, monthBranchIdx, dayBranch];
  if (timeBranch !== null) branches.push(timeBranch);

  const gogyoCount = { wood:0, fire:0, earth:0, metal:0, water:0 };
  elements.forEach(s => gogyoCount[STEM_ELEMENT[STEMS[s]]]++);
  // 地支の五行も加算
  const BRANCH_ELEMENT = ["water","earth","wood","wood","earth","fire","fire","earth","metal","metal","earth","water"];
  branches.forEach(b => gogyoCount[BRANCH_ELEMENT[b]]++);

  const dayElement = STEM_ELEMENT[STEMS[dayStem]];

  return {
    year: { stem: STEMS[yearStem], branch: BRANCHES[yearBranch], tsuhen: yearTsuhen, juniun: yearJuniun },
    month: { stem: STEMS[monthStem], branch: BRANCHES[monthBranchIdx], tsuhen: monthTsuhen, juniun: monthJuniun },
    day: { stem: STEMS[dayStem], branch: BRANCHES[dayBranch], juniun: dayJuniun },
    time: timeStem !== null ? { stem: STEMS[timeStem], branch: BRANCHES[timeBranch], tsuhen: timeTsuhen, juniun: timeJuniun } : null,
    dayElement,
    dayElementJP: JP[dayElement],
    gogyoCount,
    monthTsuhen,
  };
}

function getTsuhen(dayStemIdx, otherStemIdx) {
  const diff = ((otherStemIdx - dayStemIdx) % 10 + 10) % 10;
  return TSUHEN_NAMES[diff];
}

function getTsuhenCompatibility(tsuhenA, tsuhenB) {
  // 通変星の相性マトリクス（簡易版）
  const good = [
    ["食神","正財"], ["正官","印綬"], ["偏財","偏官"],
    ["食神","偏財"], ["正財","正官"], ["印綬","比肩"],
  ];
  const challenging = [
    ["比肩","偏官"], ["劫財","正官"], ["傷官","正官"],
    ["偏印","食神"],
  ];
  for (const [a, b] of good) {
    if ((tsuhenA === a && tsuhenB === b) || (tsuhenA === b && tsuhenB === a))
      return { bonus: 5, label: "好相性（" + a + "×" + b + "）", detail: "互いの長所が引き出される組み合わせ" };
  }
  for (const [a, b] of challenging) {
    if ((tsuhenA === a && tsuhenB === b) || (tsuhenA === b && tsuhenB === a))
      return { bonus: -3, label: "刺激的（" + a + "×" + b + "）", detail: "ぶつかりやすいが成長につながる組み合わせ" };
  }
  return { bonus: 0, label: tsuhenA + "×" + tsuhenB, detail: "穏やかな関係" };
}

// ================================================================
//  五行の相性
// ================================================================
function getGogyoRelation(a, b) {
  if (a === b) return "比和（" + JP[a] + "同士）— 同じ気質で共鳴";
  const cycle = ["wood","fire","earth","metal","water"];
  const iA = cycle.indexOf(a), iB = cycle.indexOf(b);
  if (cycle[(iA+1)%5]===b) return "相生（"+JP[a]+"→"+JP[b]+"）— "+JP[a]+"が"+JP[b]+"を生む関係";
  if (cycle[(iB+1)%5]===a) return "相生（"+JP[b]+"→"+JP[a]+"）— "+JP[b]+"が"+JP[a]+"を生む関係";
  if (cycle[(iA+2)%5]===b) return "相剋（"+JP[a]+"→"+JP[b]+"）— 緊張感のある刺激的な関係";
  if (cycle[(iB+2)%5]===a) return "相剋（"+JP[b]+"→"+JP[a]+"）— 緊張感のある刺激的な関係";
  return JP[a]+"と"+JP[b]+"の関係";
}

// ================================================================
//  プロンプト
// ================================================================
function formatMeishiki(m, name) {
  let s = `【${name}の命式】\n`;
  s += `日干: ${m.day.stem}（${m.dayElementJP}）\n`;
  s += `年柱: ${m.year.stem}${m.year.branch}（通変星:${m.year.tsuhen}、十二運:${m.year.juniun}）\n`;
  s += `月柱: ${m.month.stem}${m.month.branch}（通変星:${m.month.tsuhen}、十二運:${m.month.juniun}）\n`;
  s += `日柱: ${m.day.stem}${m.day.branch}（十二運:${m.day.juniun}）\n`;
  if (m.time) s += `時柱: ${m.time.stem}${m.time.branch}（通変星:${m.time.tsuhen}、十二運:${m.time.juniun}）\n`;
  s += `五行バランス: 木${m.gogyoCount.wood} 火${m.gogyoCount.fire} 土${m.gogyoCount.earth} 金${m.gogyoCount.metal} 水${m.gogyoCount.water}\n`;
  return s;
}

function buildSoloPrompt(d) {
  const f = d.fortune;
  return `あなたはバイオリズムと四柱推命に精通した運勢診断の専門家です。以下のデータのみに基づいて診断文を書いてください。データにない情報を捏造しないでください。

${formatMeishiki(d.meishiki, d.name)}
性別: ${d.genderA ? (d.genderA==="female"?"女性":"男性") : "未指定"}
判定日: ${d.judgeDateStr}

【判定日の日運】
日柱: ${f.dayPillarStr}（${f.dayElement}の日）
日運の通変星: ${f.tsuhen}
日運の十二運: ${f.juniun}
五行の影響: ${f.gogyoEffect}
日運スコア: ${f.fortuneScore}点

バイオリズム（0%=最低〜100%=最高）:
身体${d.physical}% 感情${d.emotional}% 知性${d.intellectual}% 総合${d.overallScore}点

=== 出力ルール（必ず全て守ること） ===
形式: プレーンテキストのみ。改行で段落を区切る。
文字数: 500〜800字。
禁止: マークダウン記法（#、##、**、*、-、・ など）を一切使わないこと。見出しや箇条書きも禁止。「以下に」「それでは」等の前置きも禁止。診断内容から直接書き始めること。
日付表現: ${d.isToday ? "判定日は本日なので「今日は」「本日は」を使ってよい。" : "判定日は本日ではないため「今日は」「本日は」は使わないこと。代わりに「この日は」「" + d.judgeDateStr + "は」と表現すること。"}

=== 構成（この順番で、各項目を自然な文章としてつなげて書く） ===
[1] 総合コンディションの一言まとめ。（1文）
[2] 日干「${d.meishiki.day.stem}」（${d.meishiki.dayElementJP}）が持つ本質的な性格と強み。（2文）
[3] 判定日に巡る通変星「${f.tsuhen}」の意味と、十二運「${f.juniun}」のエネルギーレベルがこの日にどう作用するか。具体的に「何をすると良いか、何に注意すべきか」を含めること。（3文）
[4] 五行の日運「${f.gogyoEffect}」の影響。命式の五行バランスと照らし合わせて述べること。（2文）
[5] バイオリズム3値の好不調。特に高い値や低い値があればその影響を具体的に。（2文）
[6] この日を過ごすための具体的なアドバイス。行動や心がけを1つ以上提案すること。（2文）

トーン: 親しみやすく前向き。断定ではなく「〜の傾向があります」「〜かもしれません」のように参考情報として伝える。`;
}

function buildPairPrompt(d) {
  const fA = d.fortuneA, fB = d.fortuneB;
  return `あなたはバイオリズムと四柱推命に精通した相性診断の専門家です。以下のデータのみに基づいて診断文を書いてください。データにない情報を捏造しないでください。

${formatMeishiki(d.meishikiA, d.nameA)}
性別: ${d.genderA ? (d.genderA==="female"?"女性":"男性") : "未指定"}

${formatMeishiki(d.meishikiB, d.nameB)}
性別: ${d.genderB ? (d.genderB==="female"?"女性":"男性") : "未指定"}

判定日: ${d.judgeDateStr}
判定日の日柱: ${fA.dayPillarStr}（${fA.dayElement}の日）

【${d.nameA}のこの日の日運】
通変星: ${fA.tsuhen}　十二運: ${fA.juniun}　五行影響: ${fA.gogyoEffect}　日運スコア: ${fA.fortuneScore}点

【${d.nameB}のこの日の日運】
通変星: ${fB.tsuhen}　十二運: ${fB.juniun}　五行影響: ${fB.gogyoEffect}　日運スコア: ${fB.fortuneScore}点

五行の関係（生涯固定）: ${d.gogyoRel}
通変星の相性（生涯固定）: ${d.tsuhenCompat.label}（${d.tsuhenCompat.detail}）
バイオリズム相性（判定日）: 身体${d.physical}% 感情${d.emotional}% 知性${d.intellectual}%
総合スコア: ${d.overallScore}%

=== 出力ルール（必ず全て守ること） ===
形式: プレーンテキストのみ。改行で段落を区切る。
文字数: 600〜900字。
禁止: マークダウン記法（#、##、**、*、-、・ など）を一切使わないこと。見出しや箇条書きも禁止。「以下に」「それでは」等の前置きも禁止。診断内容から直接書き始めること。
日付表現: ${d.isToday ? "判定日は本日なので「今日は」「本日は」を使ってよい。" : "判定日は本日ではないため「今日は」「本日は」は使わないこと。代わりに「この日は」「" + d.judgeDateStr + "は」と表現すること。"}

=== 構成（この順番で、各項目を自然な文章としてつなげて書く） ===
[1] この日の二人の相性を一言でまとめる。（1文）
[2] 生涯を通じた根本的な相性の解説。五行「${d.gogyoRel}」がどのような関係をもたらすか、通変星「${d.tsuhenCompat.label}」が二人のコミュニケーションにどう影響するか。（3文）
[3] 判定日の日運が二人にどう作用するか。${d.nameA}には「${fA.tsuhen}」「${fA.juniun}」が巡り、${d.nameB}には「${fB.tsuhen}」「${fB.juniun}」が巡る。この組み合わせがこの日の二人の関係にどんな変化をもたらすか、具体的に述べること。（3文）
[4] バイオリズムの波長の合い方。身体・感情・知性のうち特に高い相性と低い相性に触れること。（2文）
[5] この日の二人への具体的なアドバイス。日運の特徴を踏まえた行動提案を1つ以上含めること。（2文）

「生涯固定の相性」と「この日ならではの相性」を明確に区別して述べること。
トーン: 親しみやすく前向き。断定ではなく「〜の傾向があります」「〜かもしれません」のように参考情報として伝える。`;
}

// ================================================================
//  Gemini API
// ================================================================
async function callGemini(apiKey, prompt) {
  // Flash優先、429ならFlash-Liteにフォールバック
  const MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ];
  const MAX_RETRIES = 1; // 各モデルにつき1回リトライ
  let lastError = null;
  let usedModel = "";

  for (const model of MODELS) {
    let got429 = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const r = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 3072 },
          }),
        });
        if (r.ok) {
          const d = await r.json();
          const candidate = d?.candidates?.[0];
          let text = candidate?.content?.parts?.[0]?.text || "";
          const finishReason = candidate?.finishReason || "";

          // マークダウン記号の除去
          text = text.replace(/^#{1,4}\s*/gm, "").replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1").replace(/^[-*]\s+/gm, "").trim();

          // MAX_TOKENSで途切れた場合：1回だけリトライ（短縮プロンプトで再試行）
          if (finishReason === "MAX_TOKENS" && attempt === 0) {
            console.log(`Text truncated (${model}), retrying with shorter instruction...`);
            // 文字数指示を短縮してリトライ
            prompt = prompt
              .replace(/500〜800字/g, "400〜600字")
              .replace(/600〜900字/g, "450〜700字");
            continue;
          }

          // それでも途切れた場合：文末を自然に補完
          if (text && !text.match(/[。！？]$/)) {
            // 最後の句点までを採用
            const lastPeriod = text.lastIndexOf("。");
            if (lastPeriod > text.length * 0.6) {
              // 60%以上書けていれば、最後の句点で切る
              text = text.substring(0, lastPeriod + 1);
            } else {
              // あまりに短い場合はそのまま句点を付加
              text = text.replace(/[、，,\s]+$/, "") + "。";
            }
          }

          usedModel = model;
          return { text: text || "診断文の生成に失敗しました。", model: usedModel };
        }
        if (r.status === 429) {
          got429 = true;
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          lastError = `429 (${model})`;
          break;
        }
        lastError = `${r.status} (${model})`;
        break;
      } catch (e) { lastError = e.message; break; }
    }
    if (got429) continue; // 429なら次モデルへ
    if (usedModel) break; // 成功済みなら終了
    // 429以外のエラーでも次モデルを試す
  }
  if (usedModel) return { text: "", model: usedModel }; // ここには来ないはず
  return { error: `AI APIエラー: ${lastError}。数分後に再試行してください。` };
}

// ================================================================
//  日運（指定日の干支が命式に及ぼす影響）
// ================================================================

function calcDayPillar(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const base = new Date(1900, 0, 1);
  const daysDiff = Math.floor((d - base) / 86400000);
  const offset = 10;
  const idx = ((daysDiff + offset) % 60 + 60) % 60;
  const stemIdx = idx % 10;
  const branchIdx = idx % 12;
  return { stemIdx, branchIdx, stem: STEMS[stemIdx], branch: BRANCHES[branchIdx], element: STEM_ELEMENT[STEMS[stemIdx]], elementJP: JP[STEM_ELEMENT[STEMS[stemIdx]]] };
}

function calcDailyFortune(meishiki, dayPillar) {
  // 日干のインデックスを逆引き
  const dayStemIdx = STEMS.indexOf(meishiki.day.stem);

  // 日運の通変星: 指定日の天干と本人の日干の関係
  const tsuhen = getTsuhen(dayStemIdx, dayPillar.stemIdx);

  // 日運の十二運: 指定日の地支と本人の日干の関係
  const juniun = JUNIUNN[JUNIUN_TABLE[dayStemIdx][dayPillar.branchIdx]];

  // 十二運のエネルギースコア（0-100）
  const juniinScores = { "帝旺":100, "建禄":95, "冠帯":85, "長生":80, "沐浴":70, "養":65, "胎":55, "衰":45, "病":35, "墓":25, "死":15, "絶":10 };
  const energyScore = juniinScores[juniun] ?? 50;

  // 五行の相性: 指定日の五行が本人の日干五行にどう作用するか
  const dayElem = dayPillar.element;
  const selfElem = meishiki.dayElement;
  let gogyoEffect = "";
  let gogyoBonus = 0;
  const cycle = ["wood","fire","earth","metal","water"];
  const iDay = cycle.indexOf(dayElem), iSelf = cycle.indexOf(selfElem);
  if (dayElem === selfElem) { gogyoEffect = "比和（同じ" + JP[dayElem] + "の気が巡り、自分らしさが増す日）"; gogyoBonus = 8; }
  else if (cycle[(iDay+1)%5] === selfElem) { gogyoEffect = "相生（" + JP[dayElem] + "が" + JP[selfElem] + "を生む追い風の日）"; gogyoBonus = 10; }
  else if (cycle[(iSelf+1)%5] === dayElem) { gogyoEffect = "泄気（" + JP[selfElem] + "が" + JP[dayElem] + "を生み出すため消耗しやすい日）"; gogyoBonus = -3; }
  else if (cycle[(iDay+2)%5] === selfElem) { gogyoEffect = "相剋（" + JP[dayElem] + "が" + JP[selfElem] + "を剋す試練の日）"; gogyoBonus = -6; }
  else if (cycle[(iSelf+2)%5] === dayElem) { gogyoEffect = "克出（" + JP[selfElem] + "が" + JP[dayElem] + "を剋す力を使う活動的な日）"; gogyoBonus = 3; }
  else { gogyoEffect = JP[dayElem] + "の気が巡る日"; gogyoBonus = 0; }

  // 通変星の日運スコア（0-100）
  const tsuhenScores = { "比肩":55, "劫財":40, "食神":85, "傷官":45, "偏財":70, "正財":80, "偏官":35, "正官":65, "偏印":50, "印綬":75 };
  const tsuhenScore = tsuhenScores[tsuhen] ?? 50;

  // 五行相性スコア（0-100）
  const gogyoScore = Math.max(0, Math.min(100, 50 + gogyoBonus * 5));

  // 総合日運スコア (0-100): 十二運50% + 通変星35% + 五行15%
  const fortuneScore = Math.min(100, Math.max(0, Math.round(
    energyScore * 0.50 + tsuhenScore * 0.35 + gogyoScore * 0.15
  )));

  return {
    dayPillarStr: dayPillar.stem + dayPillar.branch,
    dayElement: dayPillar.elementJP,
    tsuhen,
    juniun,
    energyScore,
    gogyoEffect,
    fortuneScore,
  };
}

// ================================================================
//  日付表現サニタイズ（判定日が今日でない場合に適用）
// ================================================================
function sanitizeDateWords(text, dateStr) {
  return text
    .replace(/本日は/g, "この日は")
    .replace(/今日は/g, "この日は")
    .replace(/本日の/g, "この日の")
    .replace(/今日の/g, "この日の")
    .replace(/本日も/g, "この日も")
    .replace(/今日も/g, "この日も");
}

// ================================================================
//  バイオリズム
// ================================================================
function diffDays(from, to) { return Math.floor((to.getTime() - from.getTime()) / 86400000); }
function calcBiorhythm(days) {
  return { physical: Math.sin((2*Math.PI*days)/23), emotional: Math.sin((2*Math.PI*days)/28), intellectual: Math.sin((2*Math.PI*days)/33) };
}
