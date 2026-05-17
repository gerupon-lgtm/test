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

  // ========== 一人目の計算 ==========
  const meishikiA = buildMeishiki(birthA, timeA);
  const bioA = calcBiorhythm(diffDays(new Date(birthA), judgeDate));

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY未設定" });

  if (isSolo) {
    const phy = Math.round(((bioA.physical + 1) / 2) * 100);
    const emo = Math.round(((bioA.emotional + 1) / 2) * 100);
    const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
    const overall = Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);

    const prompt = buildSoloPrompt({
      name: nameA || "あなた", birthA, genderA, timeA, meishiki: meishikiA,
      physical: phy, emotional: emo, intellectual: int_, overallScore: overall, judgeDateStr,
    });
    const result = await callGemini(GEMINI_API_KEY, prompt);
    if (result.error) return res.status(502).json({ error: result.error });

    return res.status(200).json({
      mode: "solo", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
      meishikiA, diagnosis: result.text, targetDate: judgeDateStr,
    });
  }

  // ========== 相性診断 ==========
  const meishikiB = buildMeishiki(birthB, timeB);
  const bioB = calcBiorhythm(diffDays(new Date(birthB), judgeDate));

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

  const bioScore = Math.round(phy * 0.25 + emo * 0.35 + int_ * 0.25);
  const overall = Math.min(100, Math.max(0, bioScore + bonus + 15)); // 15は基礎点

  const prompt = buildPairPrompt({
    nameA: nameA || "Aさん", nameB: nameB || "Bさん",
    birthA, birthB, genderA, genderB, timeA, timeB,
    meishikiA, meishikiB, gogyoRel, tsuhenCompat,
    physical: phy, emotional: emo, intellectual: int_, overallScore: overall, judgeDateStr,
  });
  const result = await callGemini(GEMINI_API_KEY, prompt);
  if (result.error) return res.status(502).json({ error: result.error });

  return res.status(200).json({
    mode: "pair", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
    meishikiA, meishikiB, gogyoRelation: gogyoRel, tsuhenCompat: tsuhenCompat.label,
    diagnosis: result.text, targetDate: judgeDateStr,
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
  return `あなたはバイオリズムと四柱推命に精通した運勢診断の専門家です。

${formatMeishiki(d.meishiki, d.name)}
性別: ${d.genderA ? (d.genderA==="female"?"女性":"男性") : "未指定"}
判定日: ${d.judgeDateStr}

バイオリズム（0%=最低〜100%=最高）:
身体${d.physical}% 感情${d.emotional}% 知性${d.intellectual}% 総合${d.overallScore}点

【出力指示（厳守）】
プレーンテキスト500〜800字で書く。マークダウン記法（#、**、-、*）は一切禁止。挨拶不要。

【構成】
1. この日の総合コンディション概要（1文）
2. 日干「${d.meishiki.day.stem}」（${d.meishiki.dayElementJP}）の性格特性と今日への影響（2〜3文）
3. 月柱の通変星「${d.meishiki.monthTsuhen}」が示す才能・行動傾向（2文）
4. 日柱の十二運「${d.meishiki.day.juniun}」が示すエネルギー状態（2文）
5. 五行バランスの偏りとその影響（木${d.meishiki.gogyoCount.wood}火${d.meishiki.gogyoCount.fire}土${d.meishiki.gogyoCount.earth}金${d.meishiki.gogyoCount.metal}水${d.meishiki.gogyoCount.water}）（2文）
6. バイオリズムの状態（身体・感情・知性の好不調）（2文）
7. 今日のアドバイス（2文）

親しみやすく前向きなトーンで、あくまで参考情報として伝える。`;
}

function buildPairPrompt(d) {
  return `あなたはバイオリズムと四柱推命に精通した相性診断の専門家です。

${formatMeishiki(d.meishikiA, d.nameA)}
性別: ${d.genderA ? (d.genderA==="female"?"女性":"男性") : "未指定"}

${formatMeishiki(d.meishikiB, d.nameB)}
性別: ${d.genderB ? (d.genderB==="female"?"女性":"男性") : "未指定"}

判定日: ${d.judgeDateStr}
五行の関係: ${d.gogyoRel}
通変星の相性: ${d.tsuhenCompat.label}（${d.tsuhenCompat.detail}）
バイオリズム相性: 身体${d.physical}% 感情${d.emotional}% 知性${d.intellectual}%
総合スコア: ${d.overallScore}%

【出力指示（厳守）】
プレーンテキスト500〜800字で書く。マークダウン記法（#、**、-、*）は一切禁止。挨拶不要。

【構成】
1. 二人の相性の全体像（1文）
2. 五行の関係「${d.gogyoRel}」が二人にどう影響するか（2〜3文）
3. 通変星の相性「${d.tsuhenCompat.label}」の解説（2文）
4. ${d.nameA}の日干「${d.meishikiA.day.stem}」と${d.nameB}の日干「${d.meishikiB.day.stem}」の組み合わせから見た性格の相性（2文）
5. 五行バランスの比較（互いに補い合える点・注意点）（2文）
6. バイオリズムの相性（この日の波長の合い方）（2文）
7. 二人へのアドバイス（2文）

親しみやすく前向きなトーンで、あくまで参考情報として伝える。`;
}

// ================================================================
//  Gemini API
// ================================================================
async function callGemini(apiKey, prompt) {
  const MAX_RETRIES = 2;
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 3072 },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        return { text: d?.candidates?.[0]?.content?.parts?.[0]?.text || "診断文の生成に失敗しました。" };
      }
      if (r.status === 429) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2500));
        lastError = "429"; continue;
      }
      lastError = String(r.status); break;
    } catch (e) { lastError = e.message; }
  }
  return { error: `AI APIエラー: ${lastError}。数分後に再試行してください。` };
}

// ================================================================
//  バイオリズム
// ================================================================
function diffDays(from, to) { return Math.floor((to.getTime() - from.getTime()) / 86400000); }
function calcBiorhythm(days) {
  return { physical: Math.sin((2*Math.PI*days)/23), emotional: Math.sin((2*Math.PI*days)/28), intellectual: Math.sin((2*Math.PI*days)/33) };
}
