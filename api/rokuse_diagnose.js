// api/rokuse_diagnose.js — 六星占術 × バイオリズム 運勢判定
// 六星（土星人・金星人・火星人・天王星人・木星人・水星人）+ 大殺界判定
// Gemini API を使ったAI診断付き

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応" });

  const { nameA, birthA, genderA, nameB, birthB, genderB, targetDate, mode, timezone } = req.body;
  if (!birthA) return res.status(400).json({ error: "一人目の生年月日が不足" });

  const isSolo = mode === "solo" || !birthB;
  const tz = timezone || "Asia/Tokyo";

  let judgeDateStr;
  if (targetDate) {
    judgeDateStr = targetDate;
  } else {
    const now = new Date();
    judgeDateStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  }
  const judgeDate = new Date(judgeDateStr + "T00:00:00");
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const isToday = judgeDateStr === todayStr;

  // ======== 六星算出 ========
  const rokuseA = calcRokuse(birthA);
  const bioA = calcBiorhythm(diffDays(new Date(birthA), judgeDate));

  // 年運・月運・日運
  const nenunA  = calcNenun(rokuseA, judgeDate.getFullYear());
  const tsukinA = calcTsukinun(rokuseA, judgeDate.getFullYear(), judgeDate.getMonth() + 1);
  const hiUnA   = calcHiun(rokuseA, judgeDateStr);

  const fiveScoresA = calcFiveScores(rokuseA, nenunA, hiUnA, bioA, genderA);

  const phy  = Math.round(((bioA.physical + 1) / 2) * 100);
  const emo  = Math.round(((bioA.emotional + 1) / 2) * 100);
  const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
  const bioBase = Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);

  // 総合スコア: バイオ50% + 日運50%
  const overallA = Math.min(100, Math.max(0,
    Math.round(bioBase * 0.5 + hiUnA.score * 0.5)
  ));

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY未設定" });

  if (isSolo) {
    const prompt = buildSoloPrompt({
      name: nameA || "あなた", birthA, genderA,
      rokuse: rokuseA, nenun: nenunA, tsukinun: tsukinA, hiun: hiUnA,
      fiveScores: fiveScoresA,
      physical: phy, emotional: emo, intellectual: int_,
      overallScore: overallA, judgeDateStr, isToday,
    });
    const result = await callGemini(GEMINI_API_KEY, prompt);
    if (result.error) return res.status(502).json({ error: result.error });
    const diagText = sanitizeDateWords(result.text, judgeDateStr);

    let weeklyData = [], monthlyData = [], bioGraph = null;
    try {
      weeklyData  = buildRangeData(rokuseA, birthA, judgeDateStr, 7);
      monthlyData = buildRangeData(rokuseA, birthA, judgeDateStr, 30);
      bioGraph    = buildBioGraphData(birthA, judgeDateStr, 30);
    } catch (e) { console.error("Range error:", e); }

    return res.status(200).json({
      mode: "solo",
      overallScore: overallA, physical: phy, emotional: emo, intellectual: int_,
      rokuseA, nenunA, tsukinA, hiUnA, fiveScores: fiveScoresA,
      diagnosis: diagText, usedModel: result.model, targetDate: judgeDateStr,
      weeklyData, monthlyData, bioGraph,
    });
  }

  // ======== 相性診断 ========
  const rokuseB = calcRokuse(birthB);
  const bioB    = calcBiorhythm(diffDays(new Date(birthB), judgeDate));
  const nenunB  = calcNenun(rokuseB, judgeDate.getFullYear());
  const tsukinB = calcTsukinun(rokuseB, judgeDate.getFullYear(), judgeDate.getMonth() + 1);
  const hiUnB   = calcHiun(rokuseB, judgeDateStr);

  // 相性スコア計算
  const bioCompat = calcBioCompat(bioA, bioB);
  const compat    = calcRokuseCompat(rokuseA, rokuseB);
  const daiCompat = calcDaiKasaiCompat(nenunA, nenunB);

  const overallPair = Math.min(100, Math.max(0,
    Math.round(bioCompat * 0.4 + compat.score * 0.4 + daiCompat * 0.2)
  ));

  const phyP  = Math.round((1 - Math.abs(bioA.physical  - bioB.physical)  / 2) * 100);
  const emoP  = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
  const intP_ = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);

  const prompt = buildPairPrompt({
    nameA: nameA || "Aさん", nameB: nameB || "Bさん",
    birthA, birthB, genderA, genderB,
    rokuseA, rokuseB, nenunA, nenunB, tsukinA, tsukinB, hiUnA, hiUnB,
    compat, daiCompat,
    physical: phyP, emotional: emoP, intellectual: intP_,
    overallScore: overallPair, judgeDateStr, isToday,
  });
  const result = await callGemini(GEMINI_API_KEY, prompt);
  if (result.error) return res.status(502).json({ error: result.error });
  let diagText = sanitizeDateWords(result.text, judgeDateStr);

  let baseDiagnosis = diagText, dailyDiagnosis = "";
  const sepIdx = diagText.indexOf("===SEPARATOR===");
  if (sepIdx !== -1) {
    baseDiagnosis  = diagText.substring(0, sepIdx).trim();
    dailyDiagnosis = diagText.substring(sepIdx + 15).trim();
  } else {
    const mid = Math.floor(diagText.length * 0.5);
    const sp  = diagText.indexOf("。", mid);
    if (sp !== -1 && sp < diagText.length * 0.8) {
      baseDiagnosis  = diagText.substring(0, sp + 1).trim();
      dailyDiagnosis = diagText.substring(sp + 1).trim();
    }
  }

  let weeklyData = [], monthlyData = [], bioGraph = null;
  try {
    weeklyData  = buildRangeData(rokuseA, birthA, judgeDateStr, 7,  rokuseB, birthB);
    monthlyData = buildRangeData(rokuseA, birthA, judgeDateStr, 30, rokuseB, birthB);
    bioGraph    = buildBioGraphData(birthA, judgeDateStr, 30, birthB);
  } catch (e) { console.error("Range error:", e); }

  return res.status(200).json({
    mode: "pair",
    overallScore: overallPair, physical: phyP, emotional: emoP, intellectual: intP_,
    rokuseA, rokuseB, nenunA, nenunB, tsukinA, tsukinB, hiUnA, hiUnB,
    compat: compat.label, compatScore: compat.score, daiCompat,
    baseDiagnosis, dailyDiagnosis,
    diagnosis: baseDiagnosis + "\n\n" + dailyDiagnosis,
    usedModel: result.model, targetDate: judgeDateStr,
    weeklyData, monthlyData, bioGraph,
  });
}

// ================================================================
//  六星占術コア計算
// ================================================================

// 六星テーブル: 生まれ年の数字合計 → 星
// 細木数子式: 生年月日の各桁を1桁になるまで足す
// 1=土星人, 2=金星人, 3=火星人, 4=天王星人, 5=木星人, 6=水星人
// ※1/1〜1/1（元旦）生まれは前年扱いなし（簡易版）

const ROKUSE_NAMES = {
  1: "土星人", 2: "金星人", 3: "火星人",
  4: "天王星人", 5: "木星人", 6: "水星人"
};

const ROKUSE_SYMBOLS = {
  1: "♄", 2: "♀", 3: "♂", 4: "⛢", 5: "♃", 6: "♆"
};

const ROKUSE_COLORS = {
  1: "#a78bfa", 2: "#fbbf24", 3: "#f87171",
  4: "#60a5fa", 5: "#4ade80", 6: "#e2e8f0"
};

// 六星の特性
const ROKUSE_DESC = {
  1: "堅実・安定志向・誠実・粘り強い",
  2: "美的センス・社交的・享楽的・金運強い",
  3: "情熱的・行動力・正義感・直情型",
  4: "独創的・自由人・先見の明・天才肌",
  5: "大器晩成・包容力・信念の人・守護星",
  6: "感受性豊か・変化を好む・直感力・神秘的"
};

function calcRokuse(birthStr) {
  const d = new Date(birthStr + "T00:00:00");
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const day   = d.getDate();

  // 六星占術では、1月1日生まれは前年として計算
  const adjustedYear = (month === 1 && day === 1) ? year - 1 : year;

  // 年の各桁を繰り返し足して1〜9に
  let n = digitSum(adjustedYear);

  // 六星の周期は6なので mod6 (0→6)
  let star = n % 6;
  if (star === 0) star = 6;

  // プラス・マイナス判定
  // 大きく分類: 奇数年生まれ → プラス / 偶数年生まれ → マイナス（簡易版）
  const sign = (adjustedYear % 2 === 1) ? "+" : "−";

  return {
    star,
    name: ROKUSE_NAMES[star],
    symbol: ROKUSE_SYMBOLS[star],
    color: ROKUSE_COLORS[star],
    desc: ROKUSE_DESC[star],
    sign,
    fullName: ROKUSE_NAMES[star] + sign,
    birthYear: adjustedYear,
    birthMonth: month,
    birthDay: day,
  };
}

function digitSum(n) {
  let s = Math.abs(n);
  while (s >= 10) {
    s = String(s).split('').reduce((a, c) => a + parseInt(c), 0);
  }
  return s === 0 ? 6 : s;
}

// ================================================================
//  12サイクル（霊合星人の判定は省略、標準版）
// ================================================================

const CYCLE_NAMES = [
  "種", "芽", "花", "実", "陰影", "乱気", "停止", "減退", "小殺界", "大殺界（壊）", "大殺界（乱）", "大殺界（種）"
];

// 大殺界かどうか
const DAI_KASAI_SET = new Set(["大殺界（壊）", "大殺界（乱）", "大殺界（種）"]);
const SMALL_KASAI_SET = new Set(["小殺界"]);

// 六星ごとの年サイクル開始オフセット（star → 年開始インデックス）
// 六星占術では1984年を基準に周期が知られている
// 各星の年サイクル: star 1(土星) 基準年1984→種
// 実際の実装: star番号ごとに起点年を設定し mod12
const STAR_BASE_YEAR = {
  1: 1984, // 土星人: 1984年=種
  2: 1985, // 金星人
  3: 1986, // 火星人
  4: 1987, // 天王星人
  5: 1988, // 木星人
  6: 1989, // 水星人
};

// サイクル説明
const CYCLE_DESC = {
  "種":      "大きなエネルギーが眠る準備期間。内側を整える時",
  "芽":      "新しい可能性が芽吹く時。動き出しのチャンス",
  "花":      "才能が花開く最高潮。積極的に行動を",
  "実":      "努力が実を結ぶ収穫期。成果が表れる",
  "陰影":    "影の時期。焦らず内省が◎",
  "乱気":    "乱れの気配。冷静な判断を心がけて",
  "停止":    "動きが止まる時。無理な前進より休息を",
  "減退":    "エネルギーが下がり気味。体調管理に注意",
  "小殺界":  "小さな障害が出やすい。慎重に行動を",
  "大殺界（壊）": "⚠️ 大殺界。壊れる時期。現状維持が最善",
  "大殺界（乱）": "⚠️ 大殺界。乱れの極。大きな決断は避けて",
  "大殺界（種）": "⚠️ 大殺界。終わりと始まりの境。静かに過ごして",
};

// スコアマップ
const CYCLE_SCORE = {
  "花": 95, "実": 88, "芽": 80, "種": 65,
  "陰影": 50, "乱気": 42, "減退": 38, "停止": 35,
  "小殺界": 28, "大殺界（種）": 18, "大殺界（乱）": 15, "大殺界（壊）": 12,
};

function getCycleIndex(star, year) {
  const base = STAR_BASE_YEAR[star] || 1984;
  let idx = (year - base) % 12;
  if (idx < 0) idx += 12;
  return idx;
}

function getCycleName(star, year) {
  return CYCLE_NAMES[getCycleIndex(star, year)];
}

// 年運
function calcNenun(rokuse, year) {
  const cycle = getCycleName(rokuse.star, year);
  const isDaiKasai = DAI_KASAI_SET.has(cycle);
  const isSmallKasai = SMALL_KASAI_SET.has(cycle);
  const score = CYCLE_SCORE[cycle] ?? 50;
  return {
    year,
    cycle,
    desc: CYCLE_DESC[cycle] || "",
    score,
    isDaiKasai,
    isSmallKasai,
  };
}

// 月運: 年サイクルインデックス基準でさらに月でずらす
function calcTsukinun(rokuse, year, month) {
  const baseIdx = getCycleIndex(rokuse.star, year);
  // 月運は年運インデックスを起点に1月ずつ進む
  const monthOffset = month - 1;
  const cycleIdx = (baseIdx + monthOffset) % 12;
  const cycle = CYCLE_NAMES[cycleIdx];
  const isDaiKasai = DAI_KASAI_SET.has(cycle);
  const score = CYCLE_SCORE[cycle] ?? 50;
  return {
    year, month,
    cycle,
    desc: CYCLE_DESC[cycle] || "",
    score,
    isDaiKasai,
  };
}

// 日運: 月運インデックスを起点に日ごとに進む
function calcHiun(rokuse, dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const day   = d.getDate();

  const monthIdx = (getCycleIndex(rokuse.star, year) + (month - 1)) % 12;
  const dayIdx = (monthIdx + (day - 1)) % 12;
  const cycle = CYCLE_NAMES[dayIdx];
  const isDaiKasai = DAI_KASAI_SET.has(cycle);
  const isSmallKasai = SMALL_KASAI_SET.has(cycle);
  const score = CYCLE_SCORE[cycle] ?? 50;
  return {
    date: dateStr,
    cycle,
    desc: CYCLE_DESC[cycle] || "",
    score,
    isDaiKasai,
    isSmallKasai,
  };
}

// ================================================================
//  六星相性計算
// ================================================================

// 六星の相性マップ（対角・補完・衝突）
const COMPAT_MAP = {
  // [star1][star2] → {label, score}
};

function calcRokuseCompat(rA, rB) {
  const a = rA.star, b = rB.star;
  if (a === b) return { label: "同じ星（同調）", score: 72 };

  const diff = Math.abs(a - b);
  // 向かい合う星（距離3）: 強い相性
  if (diff === 3) return { label: "向かい星（強い絆）", score: 88 };
  // 隣の星（距離1）: まずまず
  if (diff === 1 || diff === 5) return { label: "隣の星（自然な縁）", score: 68 };
  // 2つ隔てた星（距離2）: 刺激的
  if (diff === 2 || diff === 4) return { label: "隔たりの星（刺激的な関係）", score: 58 };

  return { label: "普通", score: 60 };
}

// 両者の大殺界状態から相性補正
function calcDaiKasaiCompat(nenA, nenB) {
  if (nenA.isDaiKasai && nenB.isDaiKasai) return 40; // 共倒れリスク
  if (nenA.isDaiKasai || nenB.isDaiKasai) return 55; // 片方が厳しい
  return 75;
}

// バイオリズム相性
function calcBioCompat(bioA, bioB) {
  const phy  = Math.round((1 - Math.abs(bioA.physical  - bioB.physical)  / 2) * 100);
  const emo  = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
  const int_ = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);
  return Math.round(phy * 0.25 + emo * 0.35 + int_ * 0.25 + 15);
}

// ================================================================
//  5運勢スコア
// ================================================================

const CYCLE_FORTUNE_MAP = {
  "花":           { money:25, love:25, work:25, health:15, social:25 },
  "実":           { money:20, love:20, work:25, health:10, social:15 },
  "芽":           { money:15, love:15, work:15, health:10, social:15 },
  "種":           { money: 5, love: 5, work: 5, health: 5, social: 5 },
  "陰影":         { money:-5, love:-5, work:-5, health:-5, social:-5 },
  "乱気":         { money:-10,love:-8, work:-10,health:-8, social:-10},
  "停止":         { money:-12,love:-8, work:-12,health:-5, social:-8 },
  "減退":         { money:-8, love:-5, work:-8, health:-8, social:-5 },
  "小殺界":       { money:-15,love:-10,work:-12,health:-10,social:-10},
  "大殺界（壊）": { money:-25,love:-20,work:-25,health:-15,social:-20},
  "大殺界（乱）": { money:-20,love:-20,work:-20,health:-20,social:-20},
  "大殺界（種）": { money:-18,love:-15,work:-18,health:-15,social:-15},
};

// 六星ごとの得意運勢ボーナス
const STAR_BONUS = {
  1: { money: 8, health: 5 },                          // 土星人: 金・健
  2: { money:12, love: 8 },                            // 金星人: 金・恋
  3: { work: 10, social: 5 },                          // 火星人: 仕・対
  4: { work: 12, love: 5 },                            // 天王星人: 仕・恋
  5: { health: 8, social: 8 },                         // 木星人: 健・対
  6: { love: 10, social: 10 },                         // 水星人: 恋・対
};

function calcFiveScores(rokuse, nenun, hiun, bio, gender) {
  const base = 50;
  const bioPhy = Math.round(((bio.physical    + 1) / 2) * 100);
  const bioEmo = Math.round(((bio.emotional   + 1) / 2) * 100);
  const bioInt = Math.round(((bio.intellectual + 1) / 2) * 100);

  const cm = CYCLE_FORTUNE_MAP[hiun.cycle] || {};
  const nm = CYCLE_FORTUNE_MAP[nenun.cycle] || {};
  const sb = STAR_BONUS[rokuse.star] || {};

  const clamp = v => Math.min(100, Math.max(5, v));
  const bio_w = (phy, emo, int_) => Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);

  const bioBase = bio_w(bioPhy, bioEmo, bioInt);

  const money  = clamp(base + (cm.money||0)*0.7 + (nm.money||0)*0.3 + (sb.money||0) + (bioInt - 50)*0.2);
  const love   = clamp(base + (cm.love||0)*0.7  + (nm.love||0)*0.3  + (sb.love||0)  + (bioEmo - 50)*0.25 + (gender === "female" ? 3 : 0));
  const work   = clamp(base + (cm.work||0)*0.7  + (nm.work||0)*0.3  + (sb.work||0)  + (bioInt - 50)*0.25);
  const health = clamp(base + (cm.health||0)*0.7 + (nm.health||0)*0.3 + (sb.health||0) + (bioPhy - 50)*0.3);
  const social = clamp(base + (cm.social||0)*0.7 + (nm.social||0)*0.3 + (sb.social||0) + (bioEmo - 50)*0.2);

  return { money, love, work, health, social };
}

// ================================================================
//  週間・月間データ
// ================================================================

function buildRangeData(rokuseA, birthA, baseDateStr, days, rokuseB, birthB) {
  const result = [];
  const baseDate = new Date(baseDateStr + "T00:00:00");
  for (let i = 0; i < days; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const hiA = calcHiun(rokuseA, ds);
    const bioA = calcBiorhythm(diffDays(new Date(birthA), d));

    const entry = { date: ds, cycle: hiA.cycle, isDaiKasai: hiA.isDaiKasai };

    if (!rokuseB) {
      const phy  = Math.round(((bioA.physical    + 1) / 2) * 100);
      const emo  = Math.round(((bioA.emotional   + 1) / 2) * 100);
      const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
      const bioBase = Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);
      entry.score = Math.min(100, Math.max(0, Math.round(bioBase * 0.5 + hiA.score * 0.5)));
      entry.hiScore = hiA.score;
    } else {
      const hiB  = calcHiun(rokuseB, ds);
      const bioB = calcBiorhythm(diffDays(new Date(birthB), d));
      const bioCompat = calcBioCompat(bioA, bioB);
      const rComp = calcRokuseCompat(rokuseA, rokuseB);
      const avgHi = (hiA.score + hiB.score) / 2;
      entry.score = Math.min(100, Math.max(0, Math.round(bioCompat * 0.4 + rComp.score * 0.3 + avgHi * 0.3)));
      entry.cycleA = hiA.cycle;
      entry.cycleB = hiB.cycle;
    }
    result.push(entry);
  }
  return result;
}

// ================================================================
//  バイオリズムグラフデータ
// ================================================================

function buildBioGraphData(birthA, baseDateStr, span, birthB) {
  const baseDate = new Date(baseDateStr + "T00:00:00");
  const half = Math.floor(span / 2);
  const result = { labels: [], a: { physical: [], emotional: [], intellectual: [] } };
  if (birthB) result.b = { physical: [], emotional: [], intellectual: [] };

  for (let i = -half; i <= half; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    result.labels.push(ds);
    const bioA = calcBiorhythm(diffDays(new Date(birthA), d));
    result.a.physical.push(   Math.round(((bioA.physical    + 1) / 2) * 100));
    result.a.emotional.push(  Math.round(((bioA.emotional   + 1) / 2) * 100));
    result.a.intellectual.push(Math.round(((bioA.intellectual + 1) / 2) * 100));
    if (birthB) {
      const bioB = calcBiorhythm(diffDays(new Date(birthB), d));
      result.b.physical.push(    Math.round(((bioB.physical    + 1) / 2) * 100));
      result.b.emotional.push(   Math.round(((bioB.emotional   + 1) / 2) * 100));
      result.b.intellectual.push(Math.round(((bioB.intellectual + 1) / 2) * 100));
    }
  }
  return result;
}

// ================================================================
//  バイオリズム
// ================================================================

function diffDays(from, to) { return Math.floor((to.getTime() - from.getTime()) / 86400000); }
function calcBiorhythm(days) {
  return {
    physical:     Math.sin((2 * Math.PI * days) / 23),
    emotional:    Math.sin((2 * Math.PI * days) / 28),
    intellectual: Math.sin((2 * Math.PI * days) / 33),
  };
}

// ================================================================
//  日付サニタイズ
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
//  Gemini API 呼び出し
// ================================================================

async function callGemini(apiKey, prompt) {
  const MODELS = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
  ];
  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 900 },
          }),
        }
      );
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (r.status === 429 || r.status === 503) continue;
        return { error: `Gemini ${model} error: ${err?.error?.message || r.status}` };
      }
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;
      return { text, model };
    } catch (e) {
      if (MODELS.indexOf(model) < MODELS.length - 1) continue;
      return { error: e.message };
    }
  }
  return { error: "全Geminiモデルへの接続に失敗しました" };
}

// ================================================================
//  Geminiプロンプト（ソロ）
// ================================================================

function buildSoloPrompt({ name, birthA, genderA, rokuse, nenun, tsukinun, hiun, fiveScores, physical, emotional, intellectual, overallScore, judgeDateStr, isToday }) {
  const dateLabel = isToday ? "今日" : `${judgeDateStr}`;
  const gLabel = genderA === "male" ? "男性" : genderA === "female" ? "女性" : "";
  const daiW = nenun.isDaiKasai ? "【重要】今年は大殺界です。" : "";
  const hiDaiW = hiun.isDaiKasai ? "【この日は大殺界日運】" : "";

  return `あなたは六星占術の熟練した占い師です。以下の情報をもとに、${name}さんへの${dateLabel}の運勢診断を行ってください。

【基本情報】
名前: ${name}（${gLabel}）
生年月日: ${birthA}
六星: ${rokuse.fullName}（${rokuse.symbol}）
特性: ${rokuse.desc}

【年運 ${nenun.year}年】
サイクル: ${nenun.cycle} — ${nenun.desc}
${daiW}

【月運 ${tsukinun.month}月】
サイクル: ${tsukinun.cycle} — ${tsukinun.desc}

【${dateLabel}の日運】
サイクル: ${hiun.cycle} — ${hiun.desc}
${hiDaiW}

【バイオリズム（0〜100点）】
身体: ${physical} / 感情: ${emotional} / 知性: ${intellectual}

【5運勢スコア】
金運:${fiveScores.money} 恋愛運:${fiveScores.love} 仕事運:${fiveScores.work} 健康運:${fiveScores.health} 対人運:${fiveScores.social}

【総合スコア】${overallScore}点

---
上記をもとに、${name}さんへの${dateLabel}の運勢診断を400〜500文字で書いてください。

・六星（${rokuse.name}）の特性と今年のサイクル（${nenun.cycle}）を絡めて語ってください
・大殺界の場合は丁寧にアドバイスを（怖がらせすぎず建設的に）
・今日の日運（${hiun.cycle}）の具体的なアドバイスを含めてください
・5運勢の中で特に高いものと低いものに触れてください
・親しみやすく温かみのある口調で、専門用語には説明を添えてください
・「${dateLabel}は」から始めないでください`;
}

// ================================================================
//  Geminiプロンプト（ペア）
// ================================================================

function buildPairPrompt({ nameA, nameB, birthA, birthB, genderA, genderB, rokuseA, rokuseB, nenunA, nenunB, tsukinA, tsukinB, hiUnA, hiUnB, compat, daiCompat, physical, emotional, intellectual, overallScore, judgeDateStr, isToday }) {
  const dateLabel = isToday ? "今日" : judgeDateStr;
  const daiA = nenunA.isDaiKasai ? "（大殺界）" : "";
  const daiB = nenunB.isDaiKasai ? "（大殺界）" : "";

  return `あなたは六星占術の熟練した占い師です。以下の情報をもとに、${nameA}さんと${nameB}さんの相性診断を行ってください。

【${nameA}さん】
六星: ${rokuseA.fullName}（${rokuseA.symbol}）特性: ${rokuseA.desc}
今年（${nenunA.year}年）のサイクル: ${nenunA.cycle}${daiA} / 今月のサイクル: ${tsukinA.cycle}
${dateLabel}の日運: ${hiUnA.cycle}

【${nameB}さん】
六星: ${rokuseB.fullName}（${rokuseB.symbol}）特性: ${rokuseB.desc}
今年（${nenunB.year}年）のサイクル: ${nenunB.cycle}${daiB} / 今月のサイクル: ${tsukinB.cycle}
${dateLabel}の日運: ${hiUnB.cycle}

【六星相性】${compat.label}（スコア${compat.score}）
【大殺界相性補正】スコア${daiCompat}
【バイオリズム相性（0〜100）】身体:${physical} 感情:${emotional} 知性:${intellectual}
【総合相性スコア】${overallScore}点

---
以下の2部構成でお願いします（合計600文字程度）：

【基本相性パート（300字程度）】
・二人の六星の組み合わせ（${compat.label}）の特徴と深い縁
・それぞれの特性が補い合う点、気をつけるべき点
・長期的な関係性へのアドバイス

===SEPARATOR===

【${dateLabel}の二人の運気パート（300字程度）】
・今日の日運（${nameA}:${hiUnA.cycle}, ${nameB}:${hiUnB.cycle}）の重ね合わせ
・どちらかが大殺界なら配慮ある助言を
・二人で過ごすとよいこと、避けた方がよいこと

親しみやすく温かい口調でお願いします。`;
}
