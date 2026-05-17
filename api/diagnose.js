// api/diagnose.js
// Vercel Serverless Function: GitHub Pages → ここ → Google Gemini API

export default async function handler(req, res) {
  // ---------- CORS設定 ----------
  // 本番では "*" を GitHub Pages の実際のURLに変更してください
  // 例: "https://your-username.github.io"
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // プリフライトリクエストへの応答
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST のみ対応しています" });
  }

  // ---------- リクエスト解析 ----------
  const { nameA, nameB, birthA, birthB } = req.body;

  if (!birthA || !birthB) {
    return res.status(400).json({ error: "生年月日が不足しています" });
  }

  // ---------- バイオリズム計算（サーバー側で実施） ----------
  const today = new Date();
  const daysA = diffDays(new Date(birthA), today);
  const daysB = diffDays(new Date(birthB), today);

  const bioA = calcBiorhythm(daysA);
  const bioB = calcBiorhythm(daysB);

  // 相性 = 各周期の波形差の近さ（0〜100に正規化）
  const physical     = Math.round((1 - Math.abs(bioA.physical - bioB.physical) / 2) * 100);
  const emotional    = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
  const intellectual = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);
  const overallScore = Math.round(physical * 0.3 + emotional * 0.4 + intellectual * 0.3);

  // ---------- Gemini API で診断文を生成 ----------
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY が設定されていません" });
  }

  const prompt = `あなたはバイオリズム相性診断の専門家です。以下のデータに基づき、2人の相性診断を日本語で行ってください。

## 入力情報
- ${nameA || "Aさん"}の生年月日: ${birthA}
- ${nameB || "Bさん"}の生年月日: ${birthB}
- 診断日: ${today.toISOString().slice(0, 10)}

## バイオリズム相性スコア（今日時点）
- 身体リズム相性: ${physical}%
- 感情リズム相性: ${emotional}%
- 知性リズム相性: ${intellectual}%
- 総合相性: ${overallScore}%

## ${nameA || "Aさん"}の今日のバイオリズム値
- 身体: ${(bioA.physical * 100).toFixed(0)}%
- 感情: ${(bioA.emotional * 100).toFixed(0)}%
- 知性: ${(bioA.intellectual * 100).toFixed(0)}%

## ${nameB || "Bさん"}の今日のバイオリズム値
- 身体: ${(bioB.physical * 100).toFixed(0)}%
- 感情: ${(bioB.emotional * 100).toFixed(0)}%
- 知性: ${(bioB.intellectual * 100).toFixed(0)}%

## 出力指示（厳守）
以下の構成でプレーンテキストの診断文を書いてください。

【絶対ルール】
- マークダウン記法（#、##、**、- など）は一切使わないでください
- 見出しや箇条書きは使わず、自然な文章で書いてください
- 全体で300〜400字以内に収めてください（超過厳禁）
- 挨拶や前置きは不要。診断結果から直接始めてください

【構成】
1文目: 総合的な相性の一言まとめ
続けて: 身体リズムの相性（2文程度）
続けて: 感情リズムの相性（2文程度）
続けて: 知性リズムの相性（2文程度）
最後に: 二人へのアドバイス（1文）

親しみやすく前向きなトーンで、バイオリズムに基づく参考情報として伝えてください。`;

  // ---------- Gemini API 呼び出し（リトライ付き） ----------
  // モデルの優先順位: gemini-2.5-flash → gemini-2.0-flash（フォールバック）
  const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
  const MAX_RETRIES = 2;

  try {
    let lastError = null;

    for (const model of models) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

          const geminiRes = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.8,
                maxOutputTokens: 2048,
              },
            }),
          });

          // 成功
          if (geminiRes.ok) {
            const geminiData = await geminiRes.json();
            const diagnosis =
              geminiData?.candidates?.[0]?.content?.parts?.[0]?.text
              || "診断文の生成に失敗しました。";

            return res.status(200).json({
              overallScore,
              physical,
              emotional,
              intellectual,
              diagnosis,
            });
          }

          // 429 → リトライ（少し待つ）
          if (geminiRes.status === 429) {
            const waitMs = (attempt + 1) * 2000; // 2秒, 4秒
            console.log(`429 from ${model}, retry ${attempt + 1} after ${waitMs}ms`);
            await new Promise((r) => setTimeout(r, waitMs));
            lastError = `429 (${model})`;
            continue;
          }

          // その他のエラー → このモデルを諦めて次へ
          const errBody = await geminiRes.text();
          console.error(`Gemini ${model} error ${geminiRes.status}:`, errBody);
          lastError = `${geminiRes.status} (${model})`;
          break; // 次のモデルへ

        } catch (fetchErr) {
          console.error(`Fetch error (${model}, attempt ${attempt}):`, fetchErr);
          lastError = fetchErr.message;
        }
      }
    }

    return res.status(502).json({
      error: `AI APIからのエラー: ${lastError}。数分待ってから再試行してください。`,
    });
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: "サーバー内部エラー: " + e.message });
  }
}

// ========== ユーティリティ ==========

/** 2つのDateの日数差を返す */
function diffDays(from, to) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((to.getTime() - from.getTime()) / msPerDay);
}

/** 誕生日からの経過日数でバイオリズム値（-1〜+1）を計算 */
function calcBiorhythm(days) {
  return {
    physical:     Math.sin((2 * Math.PI * days) / 23),
    emotional:    Math.sin((2 * Math.PI * days) / 28),
    intellectual: Math.sin((2 * Math.PI * days) / 33),
  };
}