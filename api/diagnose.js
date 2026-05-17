// api/diagnose.js
// Vercel Serverless Function: バイオリズム × 四柱推命（個人診断 / 相性診断 両対応）

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応" });

  const { nameA, birthA, genderA, timeA, nameB, birthB, genderB, timeB, targetDate, mode } = req.body;
  if (!birthA) return res.status(400).json({ error: "一人目の生年月日が不足しています" });

  const isSolo = mode === "solo" || !birthB;
  const judgeDate = targetDate ? new Date(targetDate) : new Date();
  const judgeDateStr = judgeDate.toISOString().slice(0, 10);

  // ========== 一人目の計算 ==========
  const daysA = diffDays(new Date(birthA), judgeDate);
  const bioA = calcBiorhythm(daysA);
  const pillarA = calcDayPillar(birthA);
  const elementA = STEM_ELEMENT[pillarA.stem];
  const shichiuA = timeA ? getShichu(timeA) : null;

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY未設定" });

  // ==========================================
  //  個人診断モード (solo)
  // ==========================================
  if (isSolo) {
    const physical     = Math.round(((bioA.physical + 1) / 2) * 100);
    const emotional    = Math.round(((bioA.emotional + 1) / 2) * 100);
    const intellectual = Math.round(((bioA.intellectual + 1) / 2) * 100);
    const overallScore = Math.round(physical * 0.3 + emotional * 0.4 + intellectual * 0.3);

    const prompt = buildSoloPrompt({
      name: nameA || "あなた", birthA, genderA, timeA, shichiuA,
      pillarA, elementA, physical, emotional, intellectual,
      overallScore, judgeDateStr,
    });

    const result = await callGemini(GEMINI_API_KEY, prompt);
    if (result.error) return res.status(502).json({ error: result.error });

    return res.status(200).json({
      mode: "solo",
      overallScore, physical, emotional, intellectual,
      elementA,
      stemA: pillarA.stemName,
      diagnosis: result.text,
      targetDate: judgeDateStr,
    });
  }

  // ==========================================
  //  相性診断モード (pair)
  // ==========================================
  const daysB = diffDays(new Date(birthB), judgeDate);
  const bioB = calcBiorhythm(daysB);
  const pillarB = calcDayPillar(birthB);
  const elementB = STEM_ELEMENT[pillarB.stem];
  const shichiuB = timeB ? getShichu(timeB) : null;

  const physical     = Math.round((1 - Math.abs(bioA.physical - bioB.physical) / 2) * 100);
  const emotional    = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
  const intellectual = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);
  const gogyoRelation = getGogyoRelation(elementA, elementB);

  let gogyoBonus = 0;
  if (gogyoRelation.includes("相生")) gogyoBonus = 15;
  else if (gogyoRelation.includes("比和")) gogyoBonus = 10;
  else if (gogyoRelation.includes("相剋")) gogyoBonus = -5;

  const bioScore = Math.round(physical * 0.3 + emotional * 0.4 + intellectual * 0.3);
  const overallScore = Math.min(100, Math.max(0, bioScore + gogyoBonus));

  const prompt = buildPairPrompt({
    nameA: nameA || "Aさん", nameB: nameB || "Bさん",
    birthA, birthB, genderA, genderB, timeA, timeB,
    shichiuA, shichiuB, pillarA, pillarB, elementA, elementB,
    physical, emotional, intellectual, gogyoRelation, overallScore,
    judgeDateStr,
  });

  const result = await callGemini(GEMINI_API_KEY, prompt);
  if (result.error) return res.status(502).json({ error: result.error });

  return res.status(200).json({
    mode: "pair",
    overallScore, physical, emotional, intellectual,
    elementA, elementB, gogyoRelation,
    stemA: pillarA.stemName, stemB: pillarB.stemName,
    diagnosis: result.text,
    targetDate: judgeDateStr,
  });
}

// ========== プロンプト ==========

function buildSoloPrompt(d) {
  const E = JP;
  return `あなたはバイオリズムと四柱推命に精通した個人運勢診断の専門家です。

## 対象者
- ${d.name}：${d.birthA}生まれ、${d.genderA === "female" ? "女性" : "男性"}${d.timeA ? "、出生時間 " + d.timeA : ""}

## 判定日: ${d.judgeDateStr}

## バイオリズム値（0%=最低 〜 100%=最高）
- 身体: ${d.physical}%　感情: ${d.emotional}%　知性: ${d.intellectual}%
- 総合コンディション: ${d.overallScore}点

## 四柱推命
- 日干: ${d.pillarA.stemName}（五行: ${E[d.elementA]}）${d.shichiuA ? "、時柱: " + d.shichiuA : ""}

## 出力指示（厳守）
プレーンテキストで診断文を書いてください。

【絶対ルール】
- マークダウン記法（#、##、**、-、* など）は一切使わない
- 見出しや箇条書きは使わず、自然な文章のみ
- 全体で350〜500字以内
- 挨拶・前置きは不要。診断から直接始める

【構成】
1文目: この日の総合コンディション概要
続けて: 身体リズムの状態（活動量やエネルギー）
続けて: 感情リズムの状態（気分や人間関係）
続けて: 知性リズムの状態（集中力や判断力）
続けて: 五行「${E[d.elementA]}」の特徴がこの日どう影響するか
最後に: この日のアドバイス（1〜2文）

親しみやすく前向きなトーンで。`;
}

function buildPairPrompt(d) {
  const E = JP;
  return `あなたはバイオリズムと四柱推命の両方に精通した相性診断の専門家です。

## 入力情報
- ${d.nameA}：${d.birthA}生まれ、${d.genderA === "female" ? "女性" : "男性"}${d.timeA ? "、出生時間 " + d.timeA : ""}
- ${d.nameB}：${d.birthB}生まれ、${d.genderB === "female" ? "女性" : "男性"}${d.timeB ? "、出生時間 " + d.timeB : ""}

## バイオリズム相性（判定日: ${d.judgeDateStr}）
- 身体: ${d.physical}%　感情: ${d.emotional}%　知性: ${d.intellectual}%

## 四柱推命 五行情報
- ${d.nameA}の日干: ${d.pillarA.stemName}（五行: ${E[d.elementA]}）${d.shichiuA ? "、時柱: " + d.shichiuA : ""}
- ${d.nameB}の日干: ${d.pillarB.stemName}（五行: ${E[d.elementB]}）${d.shichiuB ? "、時柱: " + d.shichiuB : ""}
- 五行の関係: ${d.gogyoRelation}
- 総合相性スコア: ${d.overallScore}%

## 出力指示（厳守）
プレーンテキストで診断文を書いてください。

【絶対ルール】
- マークダウン記法（#、##、**、-、* など）は一切使わない
- 見出しや箇条書きは使わず、自然な文章のみ
- 全体で350〜500字以内
- 挨拶・前置きは不要。診断から直接始める

【構成】
1文目: 二人の相性の全体像（五行の関係性に触れる）
続けて: 五行の相性（${E[d.elementA]}と${E[d.elementB]}の関係がどう影響するか）
続けて: バイオリズムの相性（身体・感情・知性の波長）
${(d.shichiuA || d.shichiuB) ? "続けて: 出生時間から読み取れる補足（1〜2文）" : ""}
最後に: 二人へのアドバイス（1〜2文）

親しみやすく前向きなトーンで。`;
}

// ========== Gemini API 呼び出し ==========

async function callGemini(apiKey, prompt) {
  const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
  const MAX_RETRIES = 2;
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
          return { text: d?.candidates?.[0]?.content?.parts?.[0]?.text || "診断文の生成に失敗しました。" };
        }
        if (r.status === 429) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          lastError = `429 (${model})`; continue;
        }
        lastError = `${r.status} (${model})`; break;
      } catch (e) { lastError = e.message; }
    }
  }
  return { error: `AI APIエラー: ${lastError}。数分後に再試行してください。` };
}

// ========== 四柱推命 ==========
const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const STEM_ELEMENT = {"甲":"wood","乙":"wood","丙":"fire","丁":"fire","戊":"earth","己":"earth","庚":"metal","辛":"metal","壬":"water","癸":"water"};
const JP = { wood:"木", fire:"火", earth:"土", metal:"金", water:"水" };

function calcDayPillar(dateStr) {
  const base = new Date(1900, 0, 1);
  const target = new Date(dateStr);
  const days = Math.floor((target - base) / 86400000);
  const offset = 10;
  const idx = ((days + offset) % 60 + 60) % 60;
  return { stem: STEMS[idx % 10], branch: BRANCHES[idx % 12], stemName: STEMS[idx % 10], branchName: BRANCHES[idx % 12], pillarName: STEMS[idx % 10] + BRANCHES[idx % 12] };
}

function getGogyoRelation(a, b) {
  if (a === b) return `比和（${JP[a]}と${JP[b]}）— 同じ気質で共鳴`;
  const cycle = ["wood","fire","earth","metal","water"];
  const iA = cycle.indexOf(a), iB = cycle.indexOf(b);
  if (cycle[(iA + 1) % 5] === b) return `相生（${JP[a]}が${JP[b]}を生む）— 自然に支え合う関係`;
  if (cycle[(iB + 1) % 5] === a) return `相生（${JP[b]}が${JP[a]}を生む）— 自然に支え合う関係`;
  if (cycle[(iA + 2) % 5] === b) return `相剋（${JP[a]}が${JP[b]}を剋す）— 緊張感のある刺激的な関係`;
  if (cycle[(iB + 2) % 5] === a) return `相剋（${JP[b]}が${JP[a]}を剋す）— 緊張感のある刺激的な関係`;
  return `${JP[a]}と${JP[b]}の関係`;
}

function getShichu(timeStr) {
  const [h] = timeStr.split(":").map(Number);
  const branches = ["子","丑","丑","寅","寅","卯","卯","辰","辰","巳","巳","午","午","未","未","申","申","酉","酉","戌","戌","亥","亥","子"];
  return branches[(h + 1) % 24] + "の刻";
}

// ========== バイオリズム ==========
function diffDays(from, to) { return Math.floor((to.getTime() - from.getTime()) / 86400000); }
function calcBiorhythm(days) {
  return { physical: Math.sin((2 * Math.PI * days) / 23), emotional: Math.sin((2 * Math.PI * days) / 28), intellectual: Math.sin((2 * Math.PI * days) / 33) };
}
