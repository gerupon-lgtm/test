// api/diagnose.js
// Vercel Serverless Function: バイオリズム × 四柱推命 統合診断

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応" });

  const { nameA, nameB, birthA, birthB, genderA, genderB, timeA, timeB, targetDate } = req.body;
  if (!birthA || !birthB) return res.status(400).json({ error: "生年月日が不足" });

  // ========== 判定日（指定なければ今日） ==========
  const judgeDate = targetDate ? new Date(targetDate) : new Date();
  const judgeDateStr = judgeDate.toISOString().slice(0, 10);

  // ========== バイオリズム計算 ==========
  const daysA = diffDays(new Date(birthA), judgeDate);
  const daysB = diffDays(new Date(birthB), judgeDate);
  const bioA = calcBiorhythm(daysA);
  const bioB = calcBiorhythm(daysB);
  const physical     = Math.round((1 - Math.abs(bioA.physical - bioB.physical) / 2) * 100);
  const emotional    = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
  const intellectual = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);

  // ========== 四柱推命 五行計算 ==========
  const pillarA = calcDayPillar(birthA);
  const pillarB = calcDayPillar(birthB);
  const elementA = STEM_ELEMENT[pillarA.stem];
  const elementB = STEM_ELEMENT[pillarB.stem];
  const gogyoRelation = getGogyoRelation(elementA, elementB);

  // 五行相性ボーナス: 相生=+15, 比和=+10, 相剋=-5
  let gogyoBonus = 0;
  if (gogyoRelation.includes("相生")) gogyoBonus = 15;
  else if (gogyoRelation.includes("比和")) gogyoBonus = 10;
  else if (gogyoRelation.includes("相剋")) gogyoBonus = -5;

  const bioScore = Math.round(physical * 0.3 + emotional * 0.4 + intellectual * 0.3);
  const overallScore = Math.min(100, Math.max(0, bioScore + gogyoBonus));

  // ========== 時柱（出生時間）情報 ==========
  const shichiuA = timeA ? getShichu(timeA) : null;
  const shichiuB = timeB ? getShichu(timeB) : null;

  // ========== Gemini API ==========
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY未設定" });

  const ELEM_JP = { wood:"木", fire:"火", earth:"土", metal:"金", water:"水" };

  const prompt = `あなたはバイオリズムと四柱推命の両方に精通した相性診断の専門家です。以下のデータに基づき、2人の相性診断を日本語で行ってください。

## 入力情報
- ${nameA || "Aさん"}：${birthA}生まれ、${genderA === "female" ? "女性" : "男性"}${timeA ? "、出生時間 " + timeA : ""}
- ${nameB || "Bさん"}：${birthB}生まれ、${genderB === "female" ? "女性" : "男性"}${timeB ? "、出生時間 " + timeB : ""}

## バイオリズム相性（判定日: ${judgeDateStr}）
- 身体: ${physical}%　感情: ${emotional}%　知性: ${intellectual}%

## 四柱推命 五行情報
- ${nameA || "Aさん"}の日干: ${pillarA.stemName}（五行: ${ELEM_JP[elementA]}）${shichiuA ? "、時柱の十二支: " + shichiuA : ""}
- ${nameB || "Bさん"}の日干: ${pillarB.stemName}（五行: ${ELEM_JP[elementB]}）${shichiuB ? "、時柱の十二支: " + shichiuB : ""}
- 五行の関係: ${gogyoRelation}
- 総合相性スコア: ${overallScore}%

## 出力指示（厳守）
プレーンテキストで診断文を書いてください。

【絶対ルール】
- マークダウン記法（#、##、**、-、* など）は一切使わない
- 見出しや箇条書きは使わず、自然な文章のみ
- 全体で350〜500字以内
- 挨拶・前置きは不要。診断から直接始める

【構成】
1文目: 二人の相性の全体像（五行の関係性に触れる）
続けて: 五行の相性について（${ELEM_JP[elementA]}と${ELEM_JP[elementB]}の関係がどう影響するか）
続けて: バイオリズムの相性について（身体・感情・知性の波長）
${(shichiuA || shichiuB) ? "続けて: 出生時間から読み取れる補足（1〜2文）" : ""}
最後に: 二人へのアドバイス（1〜2文）

親しみやすく前向きなトーンで。占いの断定ではなく参考情報として伝えてください。`;

  const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
  const MAX_RETRIES = 2;

  try {
    let lastError = null;
    for (const model of models) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
            }),
          });
          if (r.ok) {
            const d = await r.json();
            const diagnosis = d?.candidates?.[0]?.content?.parts?.[0]?.text || "診断文の生成に失敗しました。";
            return res.status(200).json({
              overallScore, physical, emotional, intellectual,
              elementA, elementB, gogyoRelation, diagnosis,
              stemA: pillarA.stemName, stemB: pillarB.stemName,
              targetDate: judgeDateStr,
            });
          }
          if (r.status === 429) {
            await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
            lastError = `429 (${model})`; continue;
          }
          lastError = `${r.status} (${model})`; break;
        } catch (e) { lastError = e.message; }
      }
    }
    return res.status(502).json({ error: `AI APIエラー: ${lastError}。数分後に再試行してください。` });
  } catch (e) {
    return res.status(500).json({ error: "サーバー内部エラー: " + e.message });
  }
}

// ========== 四柱推命 計算 ==========

// 天干（十干）
const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
// 地支（十二支）
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
// 天干 → 五行マッピング
const STEM_ELEMENT = {
  "甲":"wood","乙":"wood","丙":"fire","丁":"fire",
  "戊":"earth","己":"earth","庚":"metal","辛":"metal",
  "壬":"water","癸":"water",
};

// 日柱の天干・地支を計算（簡易アルゴリズム）
// 基準日: 1900年1月1日 = 甲子（干支サイクル0）
function calcDayPillar(dateStr) {
  const base = new Date(1900, 0, 1); // 1900-01-01 = 甲子日
  const target = new Date(dateStr);
  const days = Math.floor((target - base) / 86400000);
  // 1900-01-01 は甲子日（干支サイクルindex=0）として計算
  // 実際は1900-01-01は甲戌日(index=10)なので補正
  const offset = 10;
  const idx = ((days + offset) % 60 + 60) % 60;
  const stemIdx = idx % 10;
  const branchIdx = idx % 12;
  return {
    stem: STEMS[stemIdx],
    branch: BRANCHES[branchIdx],
    stemName: STEMS[stemIdx],
    branchName: BRANCHES[branchIdx],
    pillarName: STEMS[stemIdx] + BRANCHES[branchIdx],
  };
}

// 五行の相性関係を判定
function getGogyoRelation(a, b) {
  if (a === b) return `比和（${JP[a]}と${JP[b]}）— 同じ気質で共鳴`;
  const cycle = ["wood","fire","earth","metal","water"];
  const iA = cycle.indexOf(a), iB = cycle.indexOf(b);
  // 相生（生む関係）: wood→fire→earth→metal→water→wood
  if (cycle[(iA + 1) % 5] === b) return `相生（${JP[a]}が${JP[b]}を生む）— 自然に支え合う関係`;
  if (cycle[(iB + 1) % 5] === a) return `相生（${JP[b]}が${JP[a]}を生む）— 自然に支え合う関係`;
  // 相剋（剋す関係）: wood→earth, earth→water, water→fire, fire→metal, metal→wood
  if (cycle[(iA + 2) % 5] === b) return `相剋（${JP[a]}が${JP[b]}を剋す）— 緊張感のある刺激的な関係`;
  if (cycle[(iB + 2) % 5] === a) return `相剋（${JP[b]}が${JP[a]}を剋す）— 緊張感のある刺激的な関係`;
  return `${JP[a]}と${JP[b]}の関係`;
}
const JP = { wood:"木", fire:"火", earth:"土", metal:"金", water:"水" };

// 出生時間 → 十二支（時柱の地支）
function getShichu(timeStr) {
  const [h] = timeStr.split(":").map(Number);
  const branches = ["子","丑","丑","寅","寅","卯","卯","辰","辰","巳","巳","午",
                     "午","未","未","申","申","酉","酉","戌","戌","亥","亥","子"];
  // 23:00-00:59=子, 01:00-02:59=丑, ...
  const idx = (h + 1) % 24;
  return branches[idx] + "の刻";
}

// ========== バイオリズム ==========
function diffDays(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}
function calcBiorhythm(days) {
  return {
    physical:     Math.sin((2 * Math.PI * days) / 23),
    emotional:    Math.sin((2 * Math.PI * days) / 28),
    intellectual: Math.sin((2 * Math.PI * days) / 33),
  };
}
