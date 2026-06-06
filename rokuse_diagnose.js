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
  const judgeDate = new Date(judgeDateStr + "T00:00:00Z");
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const isToday = judgeDateStr === todayStr;

  // ======== 六星算出 ========
  const rokuseA = calcRokuse(birthA);
  const bioA = calcBiorhythm(diffDays(new Date(birthA + "T00:00:00Z"), judgeDate));

  // 年運・月運・日運
  const nenunA  = calcNenun(rokuseA, judgeDate.getUTCFullYear());
  const tsukinA = calcTsukinun(rokuseA, judgeDate.getUTCFullYear(), judgeDate.getUTCMonth() + 1);
  const hiUnA   = calcHiun(rokuseA, judgeDateStr);

  const fiveScoresA = calcFiveScores(rokuseA, nenunA, hiUnA, bioA, genderA);

  const phy  = Math.round(((bioA.physical + 1) / 2) * 100);
  const emo  = Math.round(((bioA.emotional + 1) / 2) * 100);
  const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
  // バイオリズムスコア: 身体30% + 感情40% + 知性30%
  const bioScoreA = Math.min(100, Math.max(0, Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3)));
  // 六星スコア: 年運30% + 月運30% + 日運40%
  const rokuseScoreA = Math.min(100, Math.max(0,
    Math.round(nenunA.score * 0.30 + tsukinA.score * 0.30 + hiUnA.score * 0.40)
  ));

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY未設定" });

  if (isSolo) {
    const prompt = buildSoloPrompt({
      name: nameA || "あなた", birthA, genderA,
      rokuse: rokuseA, nenun: nenunA, tsukinun: tsukinA, hiun: hiUnA,
      fiveScores: fiveScoresA,
      physical: phy, emotional: emo, intellectual: int_,
      rokuseScore: rokuseScoreA, bioScore: bioScoreA, judgeDateStr, isToday,
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

    const luckyA = calcLucky(rokuseA, hiUnA);

    return res.status(200).json({
      mode: "solo",
      rokuseScore: rokuseScoreA, bioScore: bioScoreA,
      physical: phy, emotional: emo, intellectual: int_,
      rokuseA, nenunA, tsukinA, hiUnA, fiveScores: fiveScoresA,
      lucky: luckyA,
      diagnosis: diagText, usedModel: result.model, targetDate: judgeDateStr,
      weeklyData, monthlyData, bioGraph,
    });
  }

  // ======== 相性診断 ========
  const rokuseB = calcRokuse(birthB);
  const bioB    = calcBiorhythm(diffDays(new Date(birthB + "T00:00:00Z"), judgeDate));
  const nenunB  = calcNenun(rokuseB, judgeDate.getUTCFullYear());
  const tsukinB = calcTsukinun(rokuseB, judgeDate.getUTCFullYear(), judgeDate.getUTCMonth() + 1);
  const hiUnB   = calcHiun(rokuseB, judgeDateStr);

  // 相性スコア計算
  const bioCompat = calcBioCompat(bioA, bioB);
  const compat    = calcRokuseCompat(rokuseA, rokuseB);
  const daiCompat = calcDaiKasaiCompat(nenunA, nenunB);

  // 年運・日運の平均スコアによる六星相性スコア
  const nenunAvg = Math.round((nenunA.score + nenunB.score) / 2);
  const hiUnAvg  = Math.round((hiUnA.score  + hiUnB.score)  / 2);

  // バイオリズム相性スコア
  const phyP  = Math.round((1 - Math.abs(bioA.physical  - bioB.physical)  / 2) * 100);
  const emoP  = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
  const intP_ = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);
  const bioScorePair = Math.min(100, Math.max(0, Math.round(bioCompat)));

  // 六星相性スコア: 六星相性40% + 年運平均30% + 日運平均30%
  const rokuseScorePair = Math.min(100, Math.max(0,
    Math.round(compat.score * 0.40 + nenunAvg * 0.30 + hiUnAvg * 0.30)
  ));

  const prompts = buildPairPrompt({
    nameA: nameA || "Aさん", nameB: nameB || "Bさん",
    birthA, birthB, genderA, genderB,
    rokuseA, rokuseB, nenunA, nenunB, tsukinA, tsukinB, hiUnA, hiUnB,
    compat, daiCompat,
    physical: phyP, emotional: emoP, intellectual: intP_,
    rokuseScore: rokuseScorePair, bioScore: bioScorePair, judgeDateStr, isToday,
  });

  // 基本相性とこの日の運気を順番に生成（レート制限回避のため直列）
  const result1 = await callGemini(GEMINI_API_KEY, prompts.prompt1);
  if (result1.error) return res.status(502).json({ error: result1.error });
  // 連続呼び出しによるレート制限を避けるため少し待機
  await new Promise(r => setTimeout(r, 500));
  const result2 = await callGemini(GEMINI_API_KEY, prompts.prompt2);
  if (result2.error) return res.status(502).json({ error: result2.error });

  const baseDiagnosis  = sanitizeDateWords(result1.text, judgeDateStr);
  const dailyDiagnosis = sanitizeDateWords(result2.text, judgeDateStr);

  let weeklyData = [], monthlyData = [], bioGraph = null;
  try {
    weeklyData  = buildRangeData(rokuseA, birthA, judgeDateStr, 7,  rokuseB, birthB);
    monthlyData = buildRangeData(rokuseA, birthA, judgeDateStr, 30, rokuseB, birthB);
    bioGraph    = buildBioGraphData(birthA, judgeDateStr, 30, birthB);
  } catch (e) { console.error("Range error:", e); }

  const luckyA = calcLucky(rokuseA, hiUnA);
  const luckyB = calcLucky(rokuseB, hiUnB);

  return res.status(200).json({
    mode: "pair",
    rokuseScore: rokuseScorePair, bioScore: bioScorePair,
    luckyA, luckyB,
    physical: phyP, emotional: emoP, intellectual: intP_,
    rokuseA, rokuseB, nenunA, nenunB, tsukinA, tsukinB, hiUnA, hiUnB,
    compat: compat.label, compatScore: compat.score, daiCompat,
    baseDiagnosis, dailyDiagnosis,
    diagnosis: baseDiagnosis + "\n\n" + dailyDiagnosis,
    usedModel: result1.model, targetDate: judgeDateStr,
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
// 符号は生まれ年の干支で決定（正式ルール）
// +: 子寅辰午申戌 (index 0,2,4,6,8,10)
// −: 丑卯巳未酉亥 (index 1,3,5,7,9,11)
const ETO_SIGN_TABLE = ["+","−","+","−","+","−","+","−","+","−","+","−"];
function getEtoSign(year) {
  const idx = ((year - 1900) % 12 + 12) % 12;
  return ETO_SIGN_TABLE[idx];
}

// 霊合星人の副星テーブル（正式: 土星⇔天王星, 金星⇔木星, 火星⇔水星）
const REIGOU_PAIR = {
  1: 4, // 土星人霊合: 副=天王星人
  2: 5, // 金星人霊合: 副=木星人
  3: 6, // 火星人霊合: 副=水星人
  4: 1, // 天王星人霊合: 副=土星人
  5: 2, // 木星人霊合: 副=金星人
  6: 3, // 水星人霊合: 副=火星人
};

// 霊合判定テーブル: 各星人が停止(10)になる干支インデックス
// 干支: 子=0,丑=1,寅=2,卯=3,辰=4,巳=5,午=6,未=7,申=8,酉=9,戌=10,亥=11
// 根拠: STAR_BASE_YEAR+10 で停止年を算出し干支インデックスを確認
const REIGOU_ETO = {
  "1+": 10, // 土星人+: 戌年生まれが霊合
  "1−": 11, // 土星人-: 亥年生まれが霊合
  "2+":  8, // 金星人+: 申年生まれが霊合
  "2−":  9, // 金星人-: 酉年生まれが霊合
  "3+":  0, // 火星人+: 子年生まれが霊合
  "3−":  1, // 火星人-: 丑年生まれが霊合
  "4+":  4, // 天王星人+: 辰年生まれが霊合
  "4−":  5, // 天王星人-: 巳年生まれが霊合
  "5+":  2, // 木星人+: 寅年生まれが霊合
  "5−":  3, // 木星人-: 卯年生まれが霊合
  "6+":  6, // 水星人+: 午年生まれが霊合
  "6−":  1, // 水星人-: 丑年生まれが霊合
};

function getEtoIndex(year) {
  return ((year - 1900) % 12 + 12) % 12;
}

// 星数(1〜60)から運命星(1〜6)を取得
function starFromSeiSu(seiSu) {
  if (seiSu <= 10) return 1;
  if (seiSu <= 20) return 2;
  if (seiSu <= 30) return 3;
  if (seiSu <= 40) return 4;
  if (seiSu <= 50) return 5;
  return 6;
}

function calcRokuse(birthStr) {
  const d = new Date(birthStr + "T00:00:00Z");
  const year  = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day   = d.getUTCDate();

  const unmeiBase = getUnmeiBase(year, month);
  let seiSu = unmeiBase - 1 + day;
  if (seiSu > 60) seiSu -= 60;

  const star = starFromSeiSu(seiSu);
  const sign = getEtoSign(year);

  // 霊合判定: 生まれ年の干支がその星人の停止干支と一致するか
  const etoIdx  = getEtoIndex(year);
  const isReigou = (REIGOU_ETO[star + sign] === etoIdx);

  const pairStar   = isReigou ? REIGOU_PAIR[star] : null;
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
//  12サイクル（正式名称）
//  種子(0)→緑生(1)→立花(2)→健弱(3)→達成(4)→乱気(5)→
//  再会(6)→財成(7)→安定(8)→陰影(9)→停止(10)→減退(11)
//  大殺界: 陰影・停止・減退 (hosokikazuko.com / plus-a.net 確認済み)
// ================================================================

const CYCLE_NAMES = [
  "種子", "緑生", "立花", "健弱", "達成", "乱気",
  "再会", "財成", "安定", "陰影", "停止", "減退"
];

// 大殺界: 陰影(9)・停止(10)・減退(11)  ← Wikipedia確認済み
const DAI_KASAI_SET   = new Set(["陰影", "停止", "減退"]);
// 中殺界: 乱気(5)             ← Wikipedia「乱気=中殺界」
const CHU_KASAI_SET   = new Set(["乱気"]);
// 小殺界: 健弱(3)             ← Wikipedia「健弱=小殺界」
const SMALL_KASAI_SET = new Set(["健弱"]);

// 六星ごとの年運基準年（種子=0になる年）
// plus-a.net 2026年全星種年運データから逆算・全件検証済み
const STAR_BASE_YEAR_PLUS = {
  1: 1996, // 土星人+  (2026年=再会)
  2: 1994, // 金星人+  (2026年=安定)
  3: 1998, // 火星人+  (2026年=達成)
  4: 1990, // 天王星人+ (2026年=種子)
  5: 2000, // 木星人+  (2026年=立花)
  6: 1992, // 水星人+  (2026年=停止)
};
const STAR_BASE_YEAR_MINUS = {
  1: 1997, // 土星人-  (2026年=乱気)
  2: 1995, // 金星人-  (2026年=財成)
  3: 1999, // 火星人-  (2026年=健弱)
  4: 1991, // 天王星人- (2026年=減退)
  5: 1989, // 木星人-  (2026年=緑生)
  6: 1999, // 水星人-  (2026年=健弱)
};

// サイクル説明
const CYCLE_DESC = {
  "種子": "大きなエネルギーが眠る準備期間。内側を整える時",
  "緑生": "新しい可能性が芽吹く時。動き出しのチャンス",
  "立花": "才能が花開く最高潮。積極的に行動を",
  "健弱": "健康面に注意。無理は禁物。慎重に",
  "達成": "努力が実を結ぶ収穫期。成果が表れる",
  "乱気": "中殺界。精神面が不安定に。積極的な行動は慎んで",
  "再会": "過去の縁が戻る時。人脈を大切に",
  "財成": "財運が安定する時。コツコツ積み上げを",
  "安定": "心身ともに安定した充実期",
  "陰影": "⚠️ 大殺界。影の時期。内省・現状維持が最善",
  "停止": "⚠️ 大殺界。動きが止まる時。無理な前進より休息を",
  "減退": "⚠️ 大殺界。エネルギーが低下。体調管理に注意",
};

// スコアマップ
const CYCLE_SCORE = {
  "立花": 95, "達成": 88, "緑生": 80, "再会": 72,
  "財成": 68, "安定": 65, "種子": 58,
  "健弱": 40, "乱気": 35,
  "陰影": 20, "停止": 15, "減退": 10,
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
  const isDaiKasai   = DAI_KASAI_SET.has(cycle);
  const isChuKasai   = CHU_KASAI_SET.has(cycle);
  const isSmallKasai = SMALL_KASAI_SET.has(cycle);
  const score = CYCLE_SCORE[cycle] ?? 50;
  return {
    year,
    cycle,
    desc: CYCLE_DESC[cycle] || "",
    score,
    isDaiKasai,
    isChuKasai,
    isSmallKasai,
  };
}

// 月運: 正式計算式 = (yearIdx + month + 6) % 12
// 根拠: plus-a.net 全星種 2026年データから導出・3星種で検証済み
function calcTsukinun(rokuse, year, month) {
  const yearIdx = getCycleIndex(rokuse.star, rokuse.sign, year);
  const cycleIdx = (yearIdx + month + 6) % 12;
  const cycle = CYCLE_NAMES[cycleIdx];
  const isDaiKasai   = DAI_KASAI_SET.has(cycle);
  const isChuKasai   = CHU_KASAI_SET.has(cycle);
  const isSmallKasai = SMALL_KASAI_SET.has(cycle);
  const score = CYCLE_SCORE[cycle] ?? 50;
  return {
    year, month,
    cycle,
    desc: CYCLE_DESC[cycle] || "",
    score,
    isDaiKasai,
    isChuKasai,
    isSmallKasai,
  };
}

// 日運: 共通基準日(2026-02-01)から星ごとの固定オフセットで計算
// 根拠: plus-a.net 全12星種 2026年2月1日一覧表から導出・全件検証済み
const DAY_OFFSET = {
  "1+": 6, "1−": 5,  // 土星人
  "2+": 8, "2−": 7,  // 金星人
  "3+":10, "3−": 9,  // 火星人
  "4+": 0, "4−":11,  // 天王星人
  "5+": 2, "5−": 1,  // 木星人
  "6+": 4, "6−": 3,  // 水星人
};
const DAY_BASE = new Date("2026-02-01T00:00:00Z"); // UTC明示

function calcHiun(rokuse, dateStr) {
  // UTC midnight として解釈（タイムゾーンに依存しない日付計算）
  const d = new Date(dateStr + "T00:00:00Z");
  const diff = Math.round((d - DAY_BASE) / 86400000);
  const key = rokuse.star + rokuse.sign;
  const offset = DAY_OFFSET[key] ?? 0;
  const dayIdx = ((diff + offset) % 12 + 12) % 12;
  const cycle = CYCLE_NAMES[dayIdx];
  const isDaiKasai   = DAI_KASAI_SET.has(cycle);
  const isChuKasai   = CHU_KASAI_SET.has(cycle);
  const isSmallKasai = SMALL_KASAI_SET.has(cycle);
  const score = CYCLE_SCORE[cycle] ?? 50;
  return {
    date: dateStr,
    cycle,
    desc: CYCLE_DESC[cycle] || "",
    score,
    isDaiKasai,
    isChuKasai,
    isSmallKasai,
  };
}


// ================================================================
//  ラッキー要素判定
//  星の属性 × サイクル（日運）から導出（六星占術独自マッピング）
// ================================================================

// 星ごとの基本属性カラー
const STAR_BASE_COLORS = {
  1: ["ブラウン","ゴールド","ベージュ"],     // 土星人: 土=大地の色
  2: ["ホワイト","シルバー","クリーム"],       // 金星人: 金=白銀
  3: ["レッド","オレンジ","コーラル"],         // 火星人: 火=炎の色
  4: ["グリーン","エメラルド","ライム"],       // 天王星人: 木=緑
  5: ["ブルー","ネイビー","スカイブルー"],     // 木星人: 水=青
  6: ["パープル","ラベンダー","インディゴ"],   // 水星人: 水=紫
};

// サイクルごとのカラー補正（日運に応じてカラーが変化）
const CYCLE_COLOR_ACCENT = {
  "種子": "イエロー", "緑生": "ライトグリーン", "立花": "ピンク",
  "健弱": "ライトブルー", "達成": "ゴールド", "乱気": "グレー",
  "再会": "オレンジ", "財成": "ワインレッド", "安定": "アイボリー",
  "陰影": "ダークブルー", "停止": "チャコール", "減退": "モスグリーン",
};

// 星ごとのラッキーナンバーベース
const STAR_BASE_NUMBERS = {
  1: [1, 6], 2: [4, 9], 3: [3, 7], 4: [5, 8], 5: [2, 11], 6: [0, 10],
};

// 星ごとの方位
const STAR_DIRECTION = {
  1: "南西",   // 土星人: 土=中央・南西
  2: "西",     // 金星人: 金=西
  3: "南",     // 火星人: 火=南
  4: "東",     // 天王星人: 木=東
  5: "北",     // 木星人: 水=北
  6: "北西",   // 水星人: 水=北西
};

// サイクルごとの方位補正
const CYCLE_DIRECTION_SUB = {
  "種子": "北", "緑生": "北東", "立花": "東", "健弱": "東",
  "達成": "南東", "乱気": "南", "再会": "南西", "財成": "西",
  "安定": "北西", "陰影": "南", "停止": "西", "減退": "北",
};

// 星×サイクルのラッキーアイテム
const STAR_ITEMS = {
  1: {good: "革製品・時計・天然石", kasai: "お守り・ハンカチ"},
  2: {good: "アクセサリー・香水・鏡", kasai: "シルバーリング・白い花"},
  3: {good: "キャンドル・スポーツグッズ・赤い小物", kasai: "アロマオイル・ストレッチマット"},
  4: {good: "観葉植物・手帳・木製アイテム", kasai: "ハーブティー・深呼吸グッズ"},
  5: {good: "ノート・ペン・青い小物", kasai: "入浴剤・音楽プレイヤー"},
  6: {good: "クリスタル・書籍・紫の小物", kasai: "ラベンダーグッズ・日記帳"},
};

// 星ごとのラッキーフード（五行ベース）
const STAR_FOODS = {
  1: {good: "根菜・さつまいも・かぼちゃ・はちみつ", kasai: "生姜湯・梅干し・おかゆ"},
  2: {good: "白身魚・豆腐・チーズ・梨", kasai: "大根おろし・ヨーグルト・白湯"},
  3: {good: "唐辛子・ニンニク・トマト・赤ワイン", kasai: "緑茶・サラダ・柑橘類"},
  4: {good: "葉物野菜・アボカド・オリーブオイル", kasai: "ハーブサラダ・青汁・ナッツ"},
  5: {good: "魚介類・海藻・ブルーベリー・蕎麦", kasai: "温かいスープ・黒豆・ゴマ"},
  6: {good: "ぶどう・ベリー類・紫キャベツ・ナス", kasai: "ハーブティー・プルーン・玄米"},
};

// サイクルごとの開運アクション
const CYCLE_ACTIONS = {
  "種子": "新しい習慣の種まき・情報収集・準備",
  "緑生": "学びの開始・人脈づくり・小さな一歩",
  "立花": "プレゼン・告白・自己アピール",
  "健弱": "早寝早起き・軽い運動・体調チェック",
  "達成": "契約・交渉・大きな決断",
  "乱気": "瞑想・深呼吸・一人の時間を確保",
  "再会": "旧友に連絡・過去の整理・リトライ",
  "財成": "貯蓄・投資の見直し・副業検討",
  "安定": "感謝を伝える・日常を楽しむ・掃除",
  "陰影": "読書・内省・日記を書く",
  "停止": "完全休養・デジタルデトックス",
  "減退": "断捨離・手放す練習・無理しない",
};

// 星ごとのパワースポット属性
const STAR_POWERSPOT = {
  1: "山・岩場・古い神社・城跡",
  2: "湖・鍾乳洞・白砂のビーチ・美術館",
  3: "温泉・火山・南向きの丘・スタジアム",
  4: "森・公園・植物園・渓谷",
  5: "川・滝・港・水族館",
  6: "海・天文台・図書館・紫陽花の名所",
};

function calcLucky(rokuse, hiun) {
  const s = rokuse.star;
  const cycle = hiun.cycle;
  const isKasai = hiun.isDaiKasai || hiun.isChuKasai || hiun.isSmallKasai;

  // ラッキーカラー: 星の基本色 + 日運アクセント
  const baseColors = STAR_BASE_COLORS[s];
  const accentColor = CYCLE_COLOR_ACCENT[cycle] || "";
  const luckyColor = isKasai
    ? baseColors[1] + "・" + accentColor
    : baseColors[0] + "・" + accentColor;

  // ラッキーナンバー: 星のベース + 日運インデックスから導出
  const dayIdx = CYCLE_NAMES.indexOf(cycle);
  const baseNums = STAR_BASE_NUMBERS[s];
  const luckyNumber = ((baseNums[0] + dayIdx) % 9) + 1;
  const luckyNumber2 = ((baseNums[1] + dayIdx) % 9) + 1;

  // ラッキー方位
  const mainDir = STAR_DIRECTION[s];
  const subDir = CYCLE_DIRECTION_SUB[cycle] || "";

  // ラッキーアイテム
  const items = STAR_ITEMS[s];
  const luckyItem = isKasai ? items.kasai : items.good;

  // ラッキーフード
  const foods = STAR_FOODS[s];
  const luckyFood = isKasai ? foods.kasai : foods.good;

  // 開運アクション
  const luckyAction = CYCLE_ACTIONS[cycle] || "";

  // パワースポット
  const powerSpot = STAR_POWERSPOT[s];

  return {
    color: luckyColor,
    number: luckyNumber !== luckyNumber2 ? luckyNumber + "・" + luckyNumber2 : String(luckyNumber),
    direction: subDir !== mainDir ? mainDir + "・" + subDir : mainDir,
    item: luckyItem,
    food: luckyFood,
    action: luckyAction,
    powerSpot: powerSpot,
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
  "立花": { money:25, love:25, work:25, health:15, social:25 },
  "達成": { money:20, love:20, work:25, health:10, social:15 },
  "緑生": { money:15, love:15, work:15, health:10, social:15 },
  "再会": { money:12, love:18, work:12, health: 8, social:20 },
  "財成": { money:18, love:10, work:15, health: 8, social:10 },
  "安定": { money:10, love:10, work:10, health:12, social:10 },
  "種子": { money: 5, love: 5, work: 5, health: 5, social: 5 },
  "健弱": { money:-8, love:-5, work:-8, health:-15,social:-5 },
  "乱気": { money:-12,love:-10,work:-12,health:-8, social:-12},
  "陰影": { money:-20,love:-15,work:-20,health:-15,social:-15},
  "停止": { money:-22,love:-15,work:-22,health:-12,social:-15},
  "減退": { money:-18,love:-12,work:-18,health:-18,social:-12},
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
  const baseDate = new Date(baseDateStr + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const hiA = calcHiun(rokuseA, ds);
    const bioA = calcBiorhythm(diffDays(new Date(birthA + "T00:00:00Z"), d));

    const entry = {
      date: ds,
      cycle: hiA.cycle,
      isDaiKasai: hiA.isDaiKasai,
      isChuKasai: hiA.isChuKasai,
      isSmallKasai: hiA.isSmallKasai,
    };

    if (!rokuseB) {
      // ソロ: 六星スコア(年運+月運+日運)とバイオスコアの平均
      const dObj = new Date(ds + "T00:00:00Z");
      const yr = dObj.getUTCFullYear(), mo = dObj.getUTCMonth() + 1;
      const nenScore  = calcNenun(rokuseA, yr).score;
      const tsukScore = calcTsukinun(rokuseA, yr, mo).score;
      const rokuseScore = Math.min(100, Math.max(0, Math.round(nenScore * 0.30 + tsukScore * 0.30 + hiA.score * 0.40)));
      const phy  = Math.round(((bioA.physical    + 1) / 2) * 100);
      const emo  = Math.round(((bioA.emotional   + 1) / 2) * 100);
      const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
      const bioScore = Math.min(100, Math.max(0, Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3)));
      // 総合スコア: 六星スコア50% + バイオスコア50%（「この日」タブと同一計算式）
      entry.score = Math.min(100, Math.max(0, Math.round(rokuseScore * 0.5 + bioScore * 0.5)));
      entry.hiScore = hiA.score;
      entry.bioScore = bioScore;
      entry.rokuseScore = rokuseScore;
    } else {
      const hiB  = calcHiun(rokuseB, ds);
      const bioB = calcBiorhythm(diffDays(new Date(birthB + "T00:00:00Z"), d));
      const bioCompat = calcBioCompat(bioA, bioB);
      const rComp = calcRokuseCompat(rokuseA, rokuseB);
      // 年運平均を加味（「この日」タブと同一計算式）
      const dObj = new Date(ds + "T00:00:00Z");
      const yr = dObj.getUTCFullYear();
      const nenAvg = Math.round((calcNenun(rokuseA, yr).score + calcNenun(rokuseB, yr).score) / 2);
      const hiAvg  = Math.round((hiA.score + hiB.score) / 2);
      // 六星相性スコア: 六星相性40% + 年運平均30% + 日運平均30%
      const rokuseScore = Math.min(100, Math.max(0, Math.round(rComp.score * 0.40 + nenAvg * 0.30 + hiAvg * 0.30)));
      const bioScore = Math.min(100, Math.max(0, Math.round(bioCompat)));
      // 総合スコア: 六星相性スコア50% + バイオ相性50%
      entry.score = Math.min(100, Math.max(0, Math.round(rokuseScore * 0.5 + bioScore * 0.5)));
      entry.hiScore = hiAvg;
      entry.bioScore = bioScore;
      entry.rokuseScore = rokuseScore;
      entry.cycleA = hiA.cycle;
      entry.cycleB = hiB.cycle;
      entry.isDaiKasaiB = hiB.isDaiKasai;
      entry.isChuKasaiB = hiB.isChuKasai;
      entry.isSmallKasaiB = hiB.isSmallKasai;
    }
    result.push(entry);
  }
  return result;
}

// ================================================================
//  バイオリズムグラフデータ
// ================================================================

function buildBioGraphData(birthA, baseDateStr, span, birthB) {
  const baseDate = new Date(baseDateStr + "T00:00:00Z");
  const half = Math.floor(span / 2);
  const result = { labels: [], a: { physical: [], emotional: [], intellectual: [] } };
  if (birthB) result.b = { physical: [], emotional: [], intellectual: [] };

  for (let i = -half; i <= half; i++) {
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    result.labels.push(ds);
    const bioA = calcBiorhythm(diffDays(new Date(birthA + "T00:00:00Z"), d));
    result.a.physical.push(   Math.round(((bioA.physical    + 1) / 2) * 100));
    result.a.emotional.push(  Math.round(((bioA.emotional   + 1) / 2) * 100));
    result.a.intellectual.push(Math.round(((bioA.intellectual + 1) / 2) * 100));
    if (birthB) {
      const bioB = calcBiorhythm(diffDays(new Date(birthB + "T00:00:00Z"), d));
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
    "gemini-2.5-flash",        // 第1候補: 最新安定版・高品質
    "gemini-2.5-flash-lite",   // 第2候補: 軽量・高速
    "gemini-2.0-flash-lite",   // 第3候補: フォールバック（2026/6/1まで）
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

function buildSoloPrompt({ name, birthA, genderA, rokuse, nenun, tsukinun, hiun, fiveScores, physical, emotional, intellectual, rokuseScore, bioScore, judgeDateStr, isToday }) {
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
身体${physical}% 感情${emotional}% 知性${intellectual}% → バイオリズムスコア${bioScore}点
六星サイクルスコア（年運・月運・日運の合算）: ${rokuseScore}点

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

function buildPairPrompt({ nameA, nameB, birthA, birthB, genderA, genderB, rokuseA, rokuseB, nenunA, nenunB, tsukinA, tsukinB, hiUnA, hiUnB, compat, daiCompat, physical, emotional, intellectual, rokuseScore, bioScore, judgeDateStr, isToday }) {
  const dateLabel = isToday ? "今日" : judgeDateStr;
  const daiA = nenunA.isDaiKasai ? "（大殺界の年）" : "";
  const daiB = nenunB.isDaiKasai ? "（大殺界の年）" : "";

  // ペア診断は2回のAPI呼び出しで確実に分割する
  return { isDouble: true,
    prompt1: `あなたは六星占術とバイオリズムに精通した占いライターです。以下のデータをもとに、ふたりの基本的な相性を300〜350字で書いてください。

【${nameA}さん】六星: ${rokuseA.fullName} 特性: ${rokuseA.desc}
【${nameB}さん】六星: ${rokuseB.fullName} 特性: ${rokuseB.desc}
六星の相性: ${compat.label}（スコア${compat.score}）

出力ルール: プレーンテキストのみ。マークダウン・箇条書き・見出し・前置き禁止。300〜350字。
内容: ①相性を一言で ②${rokuseA.name}と${rokuseB.name}の組み合わせの特徴（良い点・注意点） ③長期的なアドバイス`,

    prompt2: `あなたは六星占術とバイオリズムに精通した占いライターです。以下のデータをもとに、この日のふたりの運気を350〜450字で書いてください。

【${nameA}さん】今年のサイクル: ${nenunA.cycle}${daiA} / この日の日運: ${hiUnA.cycle}
【${nameB}さん】今年のサイクル: ${nenunB.cycle}${daiB} / この日の日運: ${hiUnB.cycle}
バイオリズム相性: 身体${physical}% 感情${emotional}% 知性${intellectual}%

出力ルール: プレーンテキストのみ。マークダウン・箇条書き・見出し・前置き禁止。「今日」「本日」は「この日」と表現。350〜450字。
内容: ①この日の総合的な調子 ②${nameA}さんの年運・日運がふたりに与える影響 ③${nameB}さんの年運・日運について${nenunB.isDaiKasai ? '（大殺界のため配慮ある助言を含める）' : ''} ④バイオリズムの波長の合い方 ⑤この日のふたりへの具体的なアドバイス`
  };
}
