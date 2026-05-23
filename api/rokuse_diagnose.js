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

  // 総合スコア: バイオ35% + 年運15% + 月運15% + 日運35%
  const overallA = Math.min(100, Math.max(0,
    Math.round(bioBase * 0.35 + nenunA.score * 0.15 + tsukinA.score * 0.15 + hiUnA.score * 0.35)
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

  // 年運・日運の平均スコアによる相性補正
  const nenunAvg = Math.round((nenunA.score + nenunB.score) / 2);
  const hiUnAvg  = Math.round((hiUnA.score  + hiUnB.score)  / 2);

  // 総合相性: バイオ30% + 六星相性30% + 年運平均20% + 日運平均20%
  const overallPair = Math.min(100, Math.max(0,
    Math.round(bioCompat * 0.30 + compat.score * 0.30 + nenunAvg * 0.20 + hiUnAvg * 0.20)
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

// ================================================================
//  六星占術 運命数表（細木数子式正式計算）
//  ステップ1: 年・月から運命数(1〜60)を引く
//  ステップ2: 運命数 - 生日 → 1桁になるまで桁和 → 1〜12
//  ステップ3: 1〜12を星とプラス/マイナスに対応
// ================================================================

// 月オフセット（1月=index0、1月の値に加算してmod60）
const MONTH_OFFSET_NORMAL = [0, 31, 59, 30, 0, 31, 1, 32, 3, 33, 4, 34];
const MONTH_OFFSET_LEAP   = [0, 31, 60, 31, 1, 32, 2, 33, 4, 34, 5, 35];

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

// 年・月から運命数(1〜60)を取得
function getUnmeiBase(year, month) {
  // 1950年1月=33 を基準に毎年 +5（閏年は+6）
  let base = 33;
  for (let y = 1950; y < year; y++) {
    base += isLeapYear(y) ? 6 : 5;
  }
  const janBase = ((base - 1) % 60) + 1;
  const offsets = isLeapYear(year) ? MONTH_OFFSET_LEAP : MONTH_OFFSET_NORMAL;
  const raw = janBase + offsets[month - 1];
  return ((raw - 1 + 120) % 60) + 1;
}

// プラス/マイナスは星数で決まる（干支ではなく星数の範囲）
// 星数 1〜30 → マイナス(−)
// 星数 31〜60 → プラス(+)
// 根拠: 1972/1/17(星数44)=木星人+、1972/4/8(星数6)=土星人− で検証済み
function getSignFromSeiSu(seiSu) {
  return seiSu > 30 ? "+" : "−";
}

// 霊合星人の副星テーブル（主星→副星）
const REIGOU_PAIR = {
  1: 2, // 土星人霊合: 副=金星人
  2: 3, // 金星人霊合: 副=火星人
  3: 6, // 火星人霊合: 副=水星人
  4: 5, // 天王星人霊合: 副=木星人
  5: 4, // 木星人霊合: 副=天王星人
  6: 3, // 水星人霊合: 副=火星人
};

// 星数(1〜60)から運命星(1〜6)を取得
// 0〜10:土星, 11〜20:金星, 21〜30:火星, 31〜40:天王, 41〜50:木星, 51〜60:水星
function starFromSeiSu(seiSu) {
  if (seiSu <= 10) return 1;
  if (seiSu <= 20) return 2;
  if (seiSu <= 30) return 3;
  if (seiSu <= 40) return 4;
  if (seiSu <= 50) return 5;
  return 6;
}

function calcRokuse(birthStr) {
  const d = new Date(birthStr + "T00:00:00");
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const day   = d.getDate();

  // 星数 = 運命数 - 1 + 生日（61以上は-60）
  const unmeiBase = getUnmeiBase(year, month);
  let seiSu = unmeiBase - 1 + day;
  if (seiSu > 60) seiSu -= 60;

  // 霊合判定: 星数が10の倍数
  const isReigou = (seiSu % 10 === 0);

  const star     = starFromSeiSu(seiSu);
  const sign     = getSignFromSeiSu(seiSu); // 星数で決定

  const pairStar  = isReigou ? REIGOU_PAIR[star] : null;
  const reigouDesc = isReigou
    ? `${ROKUSE_NAMES[star]}と${ROKUSE_NAMES[pairStar]}の気質を持つ霊合星人`
    : null;

  return {
    star,
    name: ROKUSE_NAMES[star],
    symbol: ROKUSE_SYMBOLS[star],
    color: ROKUSE_COLORS[star],
    desc: isReigou
      ? `${ROKUSE_DESC[star]}・${ROKUSE_DESC[pairStar]}（霊合）`
      : ROKUSE_DESC[star],
    sign,
    fullName: ROKUSE_NAMES[star] + sign + (isReigou ? "（霊合）" : ""),
    isReigou,
    pairStar,
    pairName: pairStar ? ROKUSE_NAMES[pairStar] : null,
    reigouDesc,
    seiSu,
    unmeiBase,
    birthYear: year,
    birthMonth: month,
    birthDay: day,
  };
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

// 六星ごとの年サイクル開始オフセット
// プラスとマイナスでサイクルが異なる
// プラスの基準年（その年が「種」）
const STAR_BASE_YEAR_PLUS = {
  1: 1984, // 土星人+
  2: 1988, // 金星人+
  3: 1986, // 火星人+
  4: 1990, // 天王星人+
  5: 1988, // 木星人+
  6: 1992, // 水星人+
};
// マイナスの基準年
const STAR_BASE_YEAR_MINUS = {
  1: 1985, // 土星人-
  2: 1983, // 金星人-
  3: 1987, // 火星人-
  4: 1985, // 天王星人-
  5: 1989, // 木星人-
  6: 1987, // 水星人-
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

function getCycleIndex(star, sign, year) {
  const baseMap = (sign === "+") ? STAR_BASE_YEAR_PLUS : STAR_BASE_YEAR_MINUS;
  const base = baseMap[star] || 1984;
  let idx = (year - base) % 12;
  if (idx < 0) idx += 12;
  return idx;
}

function getCycleName(star, sign, year) {
  return CYCLE_NAMES[getCycleIndex(star, sign, year)];
}

// 年運
function calcNenun(rokuse, year) {
  const cycle = getCycleName(rokuse.star, rokuse.sign, year);
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
  const baseIdx = getCycleIndex(rokuse.star, rokuse.sign, year);
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

  const monthIdx = (getCycleIndex(rokuse.star, rokuse.sign, year) + (month - 1)) % 12;
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
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ];
  const MAX_RETRIES = 1;
  let lastError = null;
  let usedModel = "";

  for (const model of MODELS) {
    let got429 = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

          // MAX_TOKENSで途切れた場合：1回だけリトライ
          if (finishReason === "MAX_TOKENS" && attempt === 0) {
            prompt = prompt
              .replace(/400〜500字/g, "300〜400字")
              .replace(/300字程度/g, "250字程度")
              .replace(/600文字程度/g, "450文字程度");
            continue;
          }

          // それでも途切れた場合：最後の句点で自然に補完
          if (text && !text.match(/[。！？]$/)) {
            const lastPeriod = text.lastIndexOf("。");
            if (lastPeriod > text.length * 0.6) {
              text = text.substring(0, lastPeriod + 1);
            } else {
              text = text.replace(/[、，,\s]+$/, "") + "。";
            }
          }

          usedModel = model;
          return { text: text || "診断文の生成に失敗しました。", model: usedModel };
        }
        if (r.status === 429) {
          got429 = true;
          if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          lastError = `429 (${model})`;
          break;
        }
        lastError = `${r.status} (${model})`;
        break;
      } catch (e) { lastError = e.message; break; }
    }
    if (got429) continue;
    if (usedModel) break;
  }
  if (usedModel) return { text: "", model: usedModel };
  return { error: `AI APIエラー: ${lastError}。数分後に再試行してください。` };
}

// ================================================================
//  Geminiプロンプト（ソロ）
// ================================================================

function buildSoloPrompt({ name, birthA, genderA, rokuse, nenun, tsukinun, hiun, fiveScores, physical, emotional, intellectual, overallScore, judgeDateStr, isToday }) {
  const dateLabel = isToday ? "今日" : judgeDateStr;
  const gLabel = genderA === "male" ? "男性" : genderA === "female" ? "女性" : "";
  const daiW = nenun.isDaiKasai ? "今年は大殺界（エネルギーが低下しやすい年）です。" : "";
  const hiDaiW = hiun.isDaiKasai ? "この日は大殺界の日運です。" : "";

  return `あなたは六星占術とバイオリズムに精通した占いライターです。以下のデータに基づいて、わかりやすい言葉で運勢を伝えてください。データにない情報は書かないでください。

【${name}さんの情報】
六星: ${rokuse.fullName}（${rokuse.symbol}） 性別: ${gLabel}
特性: ${rokuse.desc}
今年（${nenun.year}年）の運気サイクル: ${nenun.cycle}（${nenun.desc}）${daiW ? " ※" + daiW : ""}
今月の運気サイクル: ${tsukinun.cycle}（${tsukinun.desc}）
判定日の日運サイクル: ${hiun.cycle}（${hiun.desc}）${hiDaiW ? " ※" + hiDaiW : ""}

バイオリズム（0%=最低〜100%=最高）:
身体${physical}% 感情${emotional}% 知性${intellectual}% 総合${overallScore}点

各運勢スコア（0〜100）:
金運${fiveScores.money} 恋愛運${fiveScores.love} 仕事運${fiveScores.work} 健康運${fiveScores.health} 対人運${fiveScores.social}

=== 出力ルール（必ず全て守ること） ===
形式: プレーンテキストのみ。改行で段落を区切る。
文字数: 400〜500字。必ず400字以上書くこと。
禁止: マークダウン記法（#、##、**、*、-、・ など）を一切使わないこと。見出しや箇条書きも禁止。「以下に」「それでは」等の前置きも禁止。診断内容から直接書き始めること。
日付表現: 「今日は」「本日は」は使わないこと。「この日は」と表現すること。
言葉遣い: 専門用語は一切使わない。サイクル名（花・実・大殺界など）はそのまま使ってよいが、必ず意味を添えること。

=== 構成 ===
[1] この日のコンディションを一言で。（1文）
[2] ${rokuse.name}の特性と今年のサイクル（${nenun.cycle}）の組み合わせから見える傾向。大殺界なら怖がらせすぎず建設的なアドバイスを。（2文）
[3] この日の日運（${hiun.cycle}）の流れ。何がうまくいきやすく、何に気をつけるとよいか。（2文）
[4] 各運勢スコアのうち特に高いもの（70以上）と注意が必要なもの（40以下）に触れる。全部羅列せず目立つ2〜3項目だけ。（2文）
[5] 体力・気分・頭の回転それぞれの調子。（2文）
[6] この日を楽しく過ごすための具体的なアドバイス。（2文）`;
}

// ================================================================
//  Geminiプロンプト（ペア）
// ================================================================

function buildPairPrompt({ nameA, nameB, birthA, birthB, genderA, genderB, rokuseA, rokuseB, nenunA, nenunB, tsukinA, tsukinB, hiUnA, hiUnB, compat, daiCompat, physical, emotional, intellectual, overallScore, judgeDateStr, isToday }) {
  const dateLabel = isToday ? "今日" : judgeDateStr;
  const daiA = nenunA.isDaiKasai ? "（大殺界の年）" : "";
  const daiB = nenunB.isDaiKasai ? "（大殺界の年）" : "";

  return `あなたは六星占術とバイオリズムに精通した占いライターです。以下のデータに基づいて、わかりやすい言葉で相性を伝えてください。データにない情報は書かないでください。

【${nameA}さん】
六星: ${rokuseA.fullName}（${rokuseA.symbol}） 特性: ${rokuseA.desc}
今年（${nenunA.year}年）のサイクル: ${nenunA.cycle}${daiA} / 今月: ${tsukinA.cycle}
判定日の日運: ${hiUnA.cycle}

【${nameB}さん】
六星: ${rokuseB.fullName}（${rokuseB.symbol}） 特性: ${rokuseB.desc}
今年（${nenunB.year}年）のサイクル: ${nenunB.cycle}${daiB} / 今月: ${tsukinB.cycle}
判定日の日運: ${hiUnB.cycle}

六星の相性: ${compat.label}（スコア${compat.score}）
バイオリズム相性: 身体${physical}% 感情${emotional}% 知性${intellectual}%
総合相性スコア: ${overallScore}%

=== 出力ルール（必ず全て守ること） ===
形式: プレーンテキストのみ。改行で段落を区切る。
禁止: マークダウン記法（#、##、**、*、-、・ など）を一切使わないこと。見出しや箇条書きも禁止。前置き禁止。
日付表現: 「今日」「本日」は使わない。「この日」と表現すること。
セクション区切り: 2つのセクションの間に「===SEPARATOR===」を1行だけ入れること。それ以外の場所には入れないこと。
言葉遣い: 専門用語は使わない。サイクル名はそのまま使ってよいが必ず意味を添えること。
合計文字数: セクション1・2合わせて700〜800字。必ず700字以上書くこと。

=== セクション1: ふたりの基本相性（300〜350字） ===
[1] ふたりの相性を一言で。（1文）
[2] ${rokuseA.name}と${rokuseB.name}の組み合わせ（${compat.label}）がどう噛み合うか。どんな場面で相性の良さが出るか、すれ違いやすいポイントは何か。（3文）
[3] ふたりへの長期的なアドバイス。（1文）

===SEPARATOR===

=== セクション2: この日のふたりの運気（350〜450字） ===
[4] この日のふたりの総合的な調子を一言で。（1文）
[5] ${nameA}さんの今年の流れ（${nenunA.cycle}）とこの日の日運（${hiUnA.cycle}）が、ふたりの関係にどんな影響をもたらすか。（2文）
[6] ${nameB}さんの今年の流れ（${nenunB.cycle}）とこの日の日運（${hiUnB.cycle}）について同様に。大殺界があれば相手への配慮ある助言を含める。（2文）
[7] バイオリズムの身体${physical}%・感情${emotional}%・知性${intellectual}%から見た、この日のふたりの波長の合い方。（2文）
[8] この日のふたりにおすすめの過ごし方や、避けた方がよいことの具体的なアドバイス。（2文）`;
}
