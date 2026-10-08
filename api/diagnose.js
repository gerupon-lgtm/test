// api/diagnose.js — バイオリズム × 四柱推命 本格版
// 四柱八字・通変星・十二運・五行バランスを計算

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応" });

  const { nameA, birthA, genderA, timeA, nameB, birthB, genderB, timeB, targetDate, mode, timezone, placeA, placeB } = req.body;
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
  const judgeDate = new Date(judgeDateStr + "T00:00:00Z");
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const isToday = judgeDateStr === todayStr;

  // ========== 一人目の計算 ==========
  const meishikiA = await buildMeishiki(birthA, timeA, placeA, timezone);
  const bioA = calcBiorhythm(diffDays(new Date(birthA + "T00:00:00Z"), judgeDate));
  const dayPillar = calcDayPillar(judgeDateStr);
  const fortuneA = calcDailyFortune(meishikiA, dayPillar);

  // AI診断コメント生成: 自宅Ollama（メイン）→ OpenRouter（フォールバック）

  if (isSolo) {
    const phy = Math.round(((bioA.physical + 1) / 2) * 100);
    const emo = Math.round(((bioA.emotional + 1) / 2) * 100);
    const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
    const bioBase = Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);
    // 4.0.0〜: 四柱推命スコア（年3：月3：日4）とバイオリズムを半々で合わせる（六星占術アプリと同じ形）
    const shichu = calcShichuFortune(meishikiA, judgeDateStr, fortuneA);
    const overall = calcOverall(shichu.score, bioBase);
    // 大運（点数には混ぜない。表示専用）
    const daiunA = calcDaiun(meishikiA, birthA, genderA, judgeDateStr);

    // 5運勢スコア
    const fiveScores = calcFiveFortuneScores(fortuneA, meishikiA, bioA, genderA, overall);
    // 命式スコア（生まれ持った素質）。overall には混ぜず別枠で返す。
    const meishikiScoreA = calcMeishikiScore(meishikiA);

    const prompt = buildSoloPrompt({
      name: nameA || "あなた", birthA, genderA, timeA, meishiki: meishikiA,
      fortune: fortuneA, dayPillar, isToday, fiveScores, meishikiScore: meishikiScoreA, shichu,
      physical: phy, emotional: emo, intellectual: int_, overallScore: overall, judgeDateStr,
    });
    const result = await callAI(prompt);
    if (result.error) return res.status(502).json({ error: result.error });
    const diagText = sanitizeDateWords(result.text, judgeDateStr);

    let weeklyData = [], monthlyData = [], bioGraph = null;
    try {
      weeklyData = buildRangeData(meishikiA, birthA, judgeDateStr, 7, "solo");
      monthlyData = buildRangeData(meishikiA, birthA, judgeDateStr, 31, "solo");
      bioGraph = buildBioGraphData(birthA, judgeDateStr, 30);
    } catch (e) {
      console.error("Range data error:", e);
    }

    const luckyA = calcLucky(meishikiA);

    return res.status(200).json({
      mode: "solo", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
      // 総合スコアの内訳を画面に出せるようにする。shichuScore は 4.0.0〜 年運・月運・日運の合成
      bioBase, shichuScore: shichu.score, shichu,
      fiveScores, meishikiScore: meishikiScoreA, daiun: daiunA,
      meishikiA, fortuneA, dayPillar: { stem: dayPillar.stem, branch: dayPillar.branch, element: dayPillar.elementJP },
      lucky: luckyA,
      diagnosis: diagText, usedModel: result.model, targetDate: judgeDateStr,
      weeklyData, monthlyData, bioGraph,
    });
  }

  // ========== 相性診断 ==========
  const meishikiB = await buildMeishiki(birthB, timeB, placeB, timezone);
  const bioB = calcBiorhythm(diffDays(new Date(birthB + "T00:00:00Z"), judgeDate));
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
  const result = await callAI(prompt);
  if (result.error) return res.status(502).json({ error: result.error });
  let diagText = sanitizeDateWords(result.text, judgeDateStr);

  // 2セクションに分割
  let baseDiagnosis = diagText;
  let dailyDiagnosis = "";
  const sepIdx = diagText.indexOf("===SEPARATOR===");
  if (sepIdx !== -1) {
    baseDiagnosis = diagText.substring(0, sepIdx).trim();
    dailyDiagnosis = diagText.substring(sepIdx + "===SEPARATOR===".length).trim();
  } else {
    // セパレーターがない場合: 全文の前半を基本、後半を日運として概算分割
    const mid = Math.floor(diagText.length * 0.5);
    const splitAt = diagText.indexOf("。", mid);
    if (splitAt !== -1 && splitAt < diagText.length * 0.8) {
      baseDiagnosis = diagText.substring(0, splitAt + 1).trim();
      dailyDiagnosis = diagText.substring(splitAt + 1).trim();
    }
  }

  // 週間・月間データ + バイオリズムグラフ（エラーが起きても診断は返す）
  let weeklyData = [], monthlyData = [], bioGraph = null;
  try {
    weeklyData = buildRangeData(meishikiA, birthA, judgeDateStr, 7, "pair", meishikiB, birthB);
    monthlyData = buildRangeData(meishikiA, birthA, judgeDateStr, 31, "pair", meishikiB, birthB);
    bioGraph = buildBioGraphData(birthA, judgeDateStr, 30, birthB);
  } catch (e) {
    console.error("Range data error:", e);
  }

  const luckyA = calcLucky(meishikiA);
  const luckyB = calcLucky(meishikiB);

  return res.status(200).json({
    mode: "pair", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
    // 総合スコアの内訳（相性は bioScore に四柱推命由来のボーナスを足す形）
    bioBase: bioScore, shichuScore: Math.round(avgFortune),
    meishikiScoreA: calcMeishikiScore(meishikiA), meishikiScoreB: calcMeishikiScore(meishikiB),
    meishikiA, meishikiB, gogyoRelation: gogyoRel, tsuhenCompat: tsuhenCompat.label,
    baseCompatBonus: bonus,
    fortuneA, fortuneB, dayPillar: { stem: dayPillar.stem, branch: dayPillar.branch, element: dayPillar.elementJP },
    luckyA, luckyB,
    baseDiagnosis, dailyDiagnosis,
    diagnosis: baseDiagnosis + "\n\n" + dailyDiagnosis,
    usedModel: result.model, targetDate: judgeDateStr,
    weeklyData, monthlyData, bioGraph,
  });
}

// ================================================================
//  四柱推命 命式計算
// ================================================================

const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const STEM_ELEMENT = {"甲":"wood","乙":"wood","丙":"fire","丁":"fire","戊":"earth","己":"earth","庚":"metal","辛":"metal","壬":"water","癸":"water"};
const JP = {wood:"木",fire:"火",earth:"土",metal:"金",water:"水"};

// 通変星名は getTsuhen() の TSUHEN_BY_RELATION（五行関係×陰陽の2次元表）で持つ。
// 「日干からの差分1本のフラット配列」は陰干日主で破綻するため、置かないこと。

// 十二運名
const JUNIUNN = ["長生","沐浴","冠帯","建禄","帝旺","衰","病","死","墓","絶","胎","養"];

// 十二運テーブル: dayStemIndex → branchIndex → juniunIndex
// 各日干の長生の地支を起点に、陽干は順行・陰干は逆行で12運を配当。
// 長生の地支: 甲=亥,乙=午,丙戊=寅,丁己=酉,庚=巳,辛=子,壬=申,癸=卯
const JUNIUN_TABLE = [
  [1,2,3,4,5,6,7,8,9,10,11,0],  // 甲
  [6,5,4,3,2,1,0,11,10,9,8,7],  // 乙
  [10,11,0,1,2,3,4,5,6,7,8,9],  // 丙
  [9,8,7,6,5,4,3,2,1,0,11,10],  // 丁
  [10,11,0,1,2,3,4,5,6,7,8,9],  // 戊
  [9,8,7,6,5,4,3,2,1,0,11,10],  // 己
  [7,8,9,10,11,0,1,2,3,4,5,6],  // 庚
  [0,11,10,9,8,7,6,5,4,3,2,1],  // 辛
  [4,5,6,7,8,9,10,11,0,1,2,3],  // 壬
  [3,2,1,0,11,10,9,8,7,6,5,4],  // 癸
];

// 節入り日テーブル（簡易版：各月のおおよその節入り日）
const SETSUIRI = [0,6,4,6,5,6,7,7,8,8,8,7,7]; // 月1-12の節入り日（index0はダミー）

// 地支の五行（本気ベース）。地支の文字そのものをキーにする。
const BRANCH_ELEMENT_MAP = {
  "子":"water","丑":"earth","寅":"wood","卯":"wood","辰":"earth","巳":"fire",
  "午":"fire","未":"earth","申":"metal","酉":"metal","戌":"earth","亥":"water",
};

// 月律分野蔵干テーブル（地支 → [[天干, 日数], ...] 余気→中気→本気の順）
// 節入りからの経過日数で作用する蔵干（月支の分野蔵干）を決定する
const ZOUKAN_TABLE = {
  "子": [["壬",10],["癸",20]],
  "丑": [["癸",9],["辛",3],["己",18]],
  "寅": [["戊",7],["丙",7],["甲",16]],
  "卯": [["甲",10],["乙",20]],
  "辰": [["乙",9],["癸",3],["戊",18]],
  "巳": [["戊",5],["庚",9],["丙",16]],
  "午": [["丙",10],["己",9],["丁",11]],
  "未": [["丁",9],["乙",3],["己",18]],
  "申": [["戊",7],["壬",7],["庚",16]],
  "酉": [["庚",10],["辛",20]],
  "戌": [["辛",9],["丁",3],["戊",18]],
  "亥": [["戊",7],["甲",5],["壬",18]],
};

// 経過日数から月支の分野蔵干を引く（節入りからの日数）
function pickMonthZoukan(branch, daysFromSetsuiri) {
  const table = ZOUKAN_TABLE[branch];
  if (!table) return null;
  let acc = 0;
  for (const [stem, dur] of table) {
    acc += dur;
    if (daysFromSetsuiri < acc) return stem;
  }
  return table[table.length - 1][0]; // 範囲を超えたら本気
}

// ================================================================
//  命式計算：命名サービスのエンジンを HTTP 参照（Phase B / B-2 方式）
//  命名サービス側 /api/bazi が「本物の節入り（天文計算）＋出生地の経度・均時差
//  補正＋早子時」まで反映した四柱・五行カウントを返す。通変星・十二運は
//  返却された四柱の上でこちら側が再計算する（命名サービスは五行しか持たないため）。
//  呼び出しに失敗したら旧ローカル計算（buildMeishikiLocal）へフォールバックし、
//  命名サービス障害時でも診断が止まらないようにする。
// ================================================================
const NAMING_SERVICE_URL = (process.env.NAMING_SERVICE_URL || "https://naming-service-red.vercel.app").replace(/\/$/, "");
const BAZI_TIMEOUT_MS = Number(process.env.BAZI_TIMEOUT_MS) || 6000;

async function buildMeishiki(dateStr, timeStr, placeCode, timezone) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BAZI_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(`${NAMING_SERVICE_URL}/api/bazi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          birthDate: dateStr,
          birthTime: timeStr || undefined,
          birthPlace: placeCode || undefined,
          timezone,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new Error(`bazi HTTP ${r.status}`);
    const d = await r.json();
    if (!d || !d.meishiki) throw new Error("bazi: 空レスポンス");
    // strength / targetElements は命名サービス v2.6.0 以降のフィールド。
    // 旧バージョンが返ってきても落ちないよう、無ければローカルで算出する。
    return enrichFromRemoteMeishiki(d.meishiki, d.strength, d.targetElements);
  } catch (e) {
    console.error("命名サービス /api/bazi 呼び出し失敗→ローカル計算にフォールバック:", e && e.message);
    return buildMeishikiLocal(dateStr, timeStr);
  }
}

// 命名サービスが返す命式（四柱＋五行カウント＋月令蔵干）に、通変星・十二運を
// 付与して、既存コードが期待する buildMeishikiLocal と同一形状に整える。
function enrichFromRemoteMeishiki(rm, remoteStrength, remoteTargets) {
  const dayStem = STEMS.indexOf(rm.day.stem);
  const yearStem = STEMS.indexOf(rm.year.stem);
  const monthStem = STEMS.indexOf(rm.month.stem);
  const yb = BRANCHES.indexOf(rm.year.branch);
  const mb = BRANCHES.indexOf(rm.month.branch);
  const db = BRANCHES.indexOf(rm.day.branch);

  const yearTsuhen = getTsuhen(dayStem, yearStem);
  const monthTsuhen = getTsuhen(dayStem, monthStem);
  const monthZoukanIdx = rm.monthZoukan ? STEMS.indexOf(rm.monthZoukan) : -1;
  const monthZoukanTsuhen = monthZoukanIdx >= 0 ? getTsuhen(dayStem, monthZoukanIdx) : null;

  const yearJuniun = JUNIUNN[JUNIUN_TABLE[dayStem][yb]];
  const monthJuniun = JUNIUNN[JUNIUN_TABLE[dayStem][mb]];
  const dayJuniun = JUNIUNN[JUNIUN_TABLE[dayStem][db]];

  let time = null;
  if (rm.time) {
    const tb = BRANCHES.indexOf(rm.time.branch);
    const ts = STEMS.indexOf(rm.time.stem);
    time = {
      stem: rm.time.stem,
      branch: rm.time.branch,
      tsuhen: getTsuhen(dayStem, ts),
      juniun: JUNIUNN[JUNIUN_TABLE[dayStem][tb]],
    };
  }

  const dayElement = rm.dayElement; // "wood" | "fire" | ...

  // 身強／身弱と用神は命名サービスの判定を正とする（エンジン一元化）。
  // 旧版が返ってこない場合のみローカル簡易判定にフォールバックする。
  const strength = (remoteStrength && remoteStrength.strength)
    ? remoteStrength
    : judgeStrengthLocal({
        dayElement,
        monthBranch: rm.month.branch,
        monthZoukan: rm.monthZoukan || null,
        branches: [rm.year.branch, rm.day.branch, ...(rm.time ? [rm.time.branch] : [])],
        stems: [rm.year.stem, rm.month.stem, ...(rm.time ? [rm.time.stem] : [])],
      });
  const targetElements = (Array.isArray(remoteTargets) && remoteTargets.length)
    ? remoteTargets
    : decideTargetElementsLocal(dayElement, strength.strength, rm.gogyoCount);

  return {
    year: { stem: rm.year.stem, branch: rm.year.branch, tsuhen: yearTsuhen, juniun: yearJuniun },
    month: { stem: rm.month.stem, branch: rm.month.branch, tsuhen: monthTsuhen, juniun: monthJuniun,
             zoukan: rm.monthZoukan || null, zoukanTsuhen: monthZoukanTsuhen },
    day: { stem: rm.day.stem, branch: rm.day.branch, juniun: dayJuniun },
    time,
    dayElement,
    dayElementJP: JP[dayElement],
    gogyoCount: rm.gogyoCount,
    monthTsuhen,
    monthZoukan: rm.monthZoukan || null,
    monthZoukanTsuhen,
    strength,
    targetElements,
  };
}

function buildMeishikiLocal(dateStr, timeStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();

  // 年柱（立春=2/4前後で切り替え）
  let yearForPillar = y;
  if (m < 2 || (m === 2 && day < 4)) yearForPillar--;
  const yearIdx = ((yearForPillar - 4) % 60 + 60) % 60;
  const yearStem = yearIdx % 10;
  const yearBranch = yearIdx % 12;

  // 月柱（節入り日で切り替え）
  // 節入り前ならその月の節がまだ来ていないので前月扱い。
  // 節切りの月支: 立春(2月節)=寅、以降 卯…丑 と続く。暦月mの節後の月支idxは m%12
  //   （2月→寅=2, 3月→卯=3, … 12月→子=0, 1月→丑=1）
  let solarMonth = m;
  const setsuiri = SETSUIRI[m] || 6;
  if (day < setsuiri) solarMonth--;
  if (solarMonth <= 0) solarMonth += 12;
  const monthBranchIdx = solarMonth % 12;
  const monthBranch = monthBranchIdx;
  // 月干（五虎遁）: 年干group=yearStem%5。寅月の月干先頭を group*2+2 とし、寅からの経過月を加算。
  //   甲己→丙寅, 乙庚→戊寅, 丙辛→庚寅, 丁壬→壬寅, 戊癸→甲寅
  const monthsFromTiger = (monthBranchIdx - 2 + 12) % 12;
  const monthStem = ((yearStem % 5) * 2 + 2 + monthsFromTiger) % 10;

  // 月支の分野蔵干（節入りからの経過日数で決定）
  // 節入り前で前月扱いになった場合は、前月の節入りからの経過日数を用いる
  let daysFromSetsuiri;
  if (day >= setsuiri) {
    daysFromSetsuiri = day - setsuiri;
  } else {
    // 前月の節入り日から今月の日までの経過日数
    const prevM = m === 1 ? 12 : m - 1;
    const prevSetsuiri = SETSUIRI[prevM] || 6;
    const prevMonthDays = new Date(Date.UTC(m === 1 ? y - 1 : y, prevM, 0)).getUTCDate();
    daysFromSetsuiri = (prevMonthDays - prevSetsuiri) + day;
  }
  const monthZoukanStem = pickMonthZoukan(BRANCHES[monthBranchIdx], daysFromSetsuiri);
  const monthZoukanIdx = monthZoukanStem !== null ? STEMS.indexOf(monthZoukanStem) : null;

  // 日柱（UTC基準で日数計算）
  const baseMs = Date.UTC(1900, 0, 1);
  const daysDiff = Math.floor((d.getTime() - baseMs) / 86400000);
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
  // 月支蔵干の通変星（日干と蔵干の関係）
  const monthZoukanTsuhen = monthZoukanIdx !== null ? getTsuhen(dayStem, monthZoukanIdx) : null;

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
  branches.forEach(b => gogyoCount[BRANCH_ELEMENT_MAP[BRANCHES[b]]]++);
  // 月令（月支の分野蔵干）の五行を加算：命式で最も強く作用するため反映する
  if (monthZoukanStem !== null) gogyoCount[STEM_ELEMENT[monthZoukanStem]]++;

  const dayElement = STEM_ELEMENT[STEMS[dayStem]];

  // 身強／身弱と用神（日運の採点に使う）
  const strength = judgeStrengthLocal({
    dayElement,
    monthBranch: BRANCHES[monthBranchIdx],
    monthZoukan: monthZoukanStem,
    branches: [BRANCHES[yearBranch], BRANCHES[dayBranch], ...(timeBranch !== null ? [BRANCHES[timeBranch]] : [])],
    stems: [STEMS[yearStem], STEMS[monthStem], ...(timeStem !== null ? [STEMS[timeStem]] : [])],
  });
  const targetElements = decideTargetElementsLocal(dayElement, strength.strength, gogyoCount);

  return {
    strength,
    targetElements,
    year: { stem: STEMS[yearStem], branch: BRANCHES[yearBranch], tsuhen: yearTsuhen, juniun: yearJuniun },
    month: { stem: STEMS[monthStem], branch: BRANCHES[monthBranchIdx], tsuhen: monthTsuhen, juniun: monthJuniun,
             zoukan: monthZoukanStem, zoukanTsuhen: monthZoukanTsuhen },
    day: { stem: STEMS[dayStem], branch: BRANCHES[dayBranch], juniun: dayJuniun },
    time: timeStem !== null ? { stem: STEMS[timeStem], branch: BRANCHES[timeBranch], tsuhen: timeTsuhen, juniun: timeJuniun } : null,
    dayElement,
    dayElementJP: JP[dayElement],
    gogyoCount,
    monthTsuhen,
    monthZoukan: monthZoukanStem,
    monthZoukanTsuhen,
  };
}


// ================================================================
//  ラッキー要素判定（日干・五行バランスから算出）
// ================================================================
function calcLucky(meishiki) {
  if (!meishiki || !meishiki.dayElement || !meishiki.gogyoCount) return null;

  const cycle = ["wood", "fire", "earth", "metal", "water"];
  const dayElement = meishiki.dayElement;
  const supportElement = cycle[(cycle.indexOf(dayElement) + 4) % 5]; // 日干を生む五行

  const counts = meishiki.gogyoCount;
  const order = ["wood", "fire", "earth", "metal", "water"];
  // weakElement: 最も少ない五行（同数なら日干以外を優先）
  let weakElement = order.reduce((min, e) => {
    if (counts[e] < counts[min]) return e;
    if (counts[e] === counts[min] && min === dayElement && e !== dayElement) return e;
    return min;
  }, order[0]);
  // 全て同数かつweakが日干と同じ場合、supportElementに変更
  if (weakElement === dayElement) weakElement = supportElement;

  const jp = { wood:"木", fire:"火", earth:"土", metal:"金", water:"水" };
  const colors = {
    wood:["緑"],
    fire:["赤", "紫"],
    earth:["黄", "ベージュ"],
    metal:["白", "金色"],
    water:["水色", "青"]
  };
  const numbers = { wood:["3", "8"], fire:["2", "7"], earth:["5", "0"], metal:["4", "9"], water:["1", "6"] };
  const items = {
    wood:"植物・木製品",
    fire:"照明・赤い小物",
    earth:"陶器・天然石",
    metal:"金属小物・アクセサリー",
    water:"飲み物・水晶"
  };
  const directions = { wood:"東", fire:"南", earth:"中央", metal:"西", water:"北" };
  const foods = {
    wood:"酸っぱいもの・緑の野菜",
    fire:"苦いもの・赤い食材",
    earth:"甘いもの・黄色い食材",
    metal:"辛いもの",
    water:"塩辛いもの・黒い食材"
  };
  const times = {
    wood:"寅～卯の時間（3～7時）",
    fire:"巳～午の時間（9～13時）",
    earth:"丑・辰・未・戌の時間帯",
    metal:"申～酉の時間（15～19時）",
    water:"亥～子の時間（21～1時）"
  };
  const days = { wood:"木曜・水曜", fire:"火曜", earth:"土曜", metal:"金曜・月曜", water:"水曜" };

  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const colorList = uniq([...(colors[supportElement] || []), ...(colors[dayElement] || []), ...(colors[weakElement] || [])]);
  const numberList = uniq([...(numbers[dayElement] || []), ...(numbers[weakElement] || [])]).slice(0, 3);

  // 方角の重複除去
  const dirList = uniq([directions[weakElement], directions[dayElement]]);

  return {
    dayElement, dayElementJP: jp[dayElement],
    weakElement, weakElementJP: jp[weakElement],
    supportElement, supportElementJP: jp[supportElement],
    color: colorList.join("・"),
    number: numberList.join("・"),
    item: items[weakElement] || items[dayElement],
    material: items[weakElement] || items[dayElement],
    direction: dirList.join("・"),
    food: foods[weakElement] || foods[dayElement],
    time: times[dayElement],
    day: days[dayElement],
    note: "日干の" + jp[dayElement] + "を活かし、不足しがちな" + jp[weakElement] + "を補う要素です。"
  };
}

// ================================================================
//  身強／身弱 と 用神（ローカル簡易版）
//
//  【正は命名サービス側】api/_lib/bazi/strength.ts・wuxing.ts。
//  ここは /api/bazi が落ちたとき用のフォールバックなので、点数の刻みと
//  閾値は命名サービスと同じ値に揃えてある。向こうを変えたらここも合わせること。
//
//  【用神論】補うべき五行は「最も少ない五行」ではなく用神で決める。
//    身弱 → 印星（日干を生む）・比劫（日干と同じ）
//    身強 → 食傷（日干が生む）・財（日干が剋す）・官（日干を剋す）
// ================================================================
const STRENGTH_CONFIG = {
  monthSameElement: 6, monthSupports: 4, monthDrains: -3,
  branchSameElement: 2, branchSupports: 1, branchDrains: -1,
  stemSameElement: 2, stemSupports: 1, stemDrains: -1,
  monthZoukanSupports: 2,
  strongThreshold: 6, weakThreshold: 1,
};

function elGenerates(a, b) { return WUXING_CYCLE[(WUXING_CYCLE.indexOf(a) + 1) % 5] === b; }
/** 日干を生む五行（印星）。 */
function elThatGenerates(t) { return WUXING_CYCLE[(WUXING_CYCLE.indexOf(t) + 4) % 5]; }
/** 日干が生む五行（食傷）。 */
function elGeneratedBy(t) { return WUXING_CYCLE[(WUXING_CYCLE.indexOf(t) + 1) % 5]; }
/** 日干が剋す五行（財）。 */
function elControlledBy(t) { return WUXING_CYCLE[(WUXING_CYCLE.indexOf(t) + 2) % 5]; }
/** 日干を剋す五行（官殺）。 */
function elThatControls(t) { return WUXING_CYCLE[(WUXING_CYCLE.indexOf(t) + 3) % 5]; }

function supportKind(element, dayElement) {
  if (element === dayElement) return "same";
  if (elGenerates(element, dayElement)) return "supports";
  return "drains";
}

/** 地支に含まれる五行（蔵干ベース）。通根の判定に使う。 */
function branchElementsOf(branch) {
  const table = ZOUKAN_TABLE[branch] || [];
  return [...new Set(table.map(([stem]) => STEM_ELEMENT[stem]))];
}

function judgeStrengthLocal({ dayElement, monthBranch, monthZoukan, branches, stems }) {
  const c = STRENGTH_CONFIG;
  let score = 0;

  // 1. 月令（判定の中心）
  const rootedInMonth = branchElementsOf(monthBranch).includes(dayElement);
  const monthKind = supportKind(BRANCH_ELEMENT_MAP[monthBranch], dayElement);
  if (monthKind === "same") score += c.monthSameElement;
  else if (monthKind === "supports") score += c.monthSupports;
  else score += c.monthDrains;
  if (monthZoukan) {
    const zk = supportKind(STEM_ELEMENT[monthZoukan], dayElement);
    if (zk === "same" || zk === "supports") score += c.monthZoukanSupports;
  }

  // 2. 月支以外の地支への通根
  for (const b of branches) {
    const kind = supportKind(BRANCH_ELEMENT_MAP[b], dayElement);
    if (kind === "same") score += c.branchSameElement;
    else if (kind === "supports") score += c.branchSupports;
    else score += c.branchDrains;
  }

  // 3. 日干以外の天干による支え
  for (const s of stems) {
    const kind = supportKind(STEM_ELEMENT[s], dayElement);
    if (kind === "same") score += c.stemSameElement;
    else if (kind === "supports") score += c.stemSupports;
    else score += c.stemDrains;
  }

  let strength;
  if (score >= c.strongThreshold) strength = "strong";
  else if (score <= c.weakThreshold) strength = "weak";
  else strength = "neutral";

  const summary = strength === "strong"
    ? "生まれ持ったエネルギーが強めのタイプです。"
    : strength === "weak"
    ? "生まれ持ったエネルギーが穏やかなタイプです。"
    : "生まれ持ったエネルギーのバランスが取れたタイプです。";

  return { strength, score, rootedInMonth, summary };
}

function decideTargetElementsLocal(dayElement, strength, gogyoCount) {
  const list = [];
  if (strength === "weak") {
    list.push(elThatGenerates(dayElement)); // 印星
    list.push(dayElement);                  // 比劫
  } else if (strength === "strong") {
    list.push(elGeneratedBy(dayElement));   // 食傷
    list.push(elControlledBy(dayElement));  // 財
    list.push(elThatControls(dayElement));  // 官
  } else {
    // 中和: 最も少ない五行を穏やかに補う
    let best = WUXING_CYCLE[0];
    for (const e of WUXING_CYCLE) {
      if ((gogyoCount?.[e] ?? 0) < (gogyoCount?.[best] ?? 0)) best = e;
    }
    if (best === dayElement) best = elThatGenerates(dayElement);
    list.push(best);
    list.push(elThatGenerates(dayElement));
  }
  return [...new Set(list)];
}

const STRENGTH_LABEL = { strong: "身強", neutral: "中和", weak: "身弱" };

/**
 * 通変星（日干と他の天干の関係）。
 *
 * 【重要・バグ修正 v3.b.2】
 * 素朴に `TSUHEN_NAMES[(other - day) % 10]` とするのは **日干が陽干のときだけ**
 * 成立する。通変星は「五行の関係（比和／我生／我剋／剋我／生我）」と
 * 「日干と相手の陰陽が同じか異なるか」の2軸で決まるため、日干が陰干
 * （乙・丁・己・辛・癸）だと陰陽が反転し、差分テーブルは10通り中5通り
 * （＝相手が陽干になる奇数diffの側）が誤った星名になる。
 *   例) 日干=己 のとき 甲→誤「正財」/正「正官」、壬→誤「傷官」/正「正財」
 * 通変星は monthTsuhen（相性判定）・日運スコア・運勢補正にも流れるため、
 * 陰干生まれの結果全体が狂う。**差分テーブル方式に戻さないこと。**
 *
 * 修正方針: 差分は使わず、五行関係＋陰陽から素直に導出する。
 */
const TSUHEN_BY_RELATION = [
  // [陰陽が同じ, 陰陽が異なる]
  ["比肩", "劫財"], // 0: 比和（相手＝日干と同じ五行）
  ["食神", "傷官"], // 1: 我生（日干が生む）
  ["偏財", "正財"], // 2: 我剋（日干が剋す）
  ["偏官", "正官"], // 3: 剋我（日干を剋す）
  ["偏印", "印綬"], // 4: 生我（日干を生む）
];

const WUXING_CYCLE = ["wood", "fire", "earth", "metal", "water"];

function getTsuhen(dayStemIdx, otherStemIdx) {
  const dayEl = WUXING_CYCLE.indexOf(STEM_ELEMENT[STEMS[dayStemIdx]]);
  const otherEl = WUXING_CYCLE.indexOf(STEM_ELEMENT[STEMS[otherStemIdx]]);
  // 相生の並び順（木→火→土→金→水→木）での距離が、そのまま関係の種別になる。
  //   0=比和 / 1=我生 / 2=我剋 / 3=剋我 / 4=生我
  const relation = ((otherEl - dayEl) % 5 + 5) % 5;
  // 十干は偶数index=陽干、奇数index=陰干。
  const samePolarity = (dayStemIdx % 2) === (otherStemIdx % 2);
  return TSUHEN_BY_RELATION[relation][samePolarity ? 0 : 1];
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
  s += `月柱: ${m.month.stem}${m.month.branch}（通変星:${m.month.tsuhen}、十二運:${m.month.juniun}${m.month.zoukan ? `、蔵干:${m.month.zoukan}（${m.month.zoukanTsuhen}）` : ""}）\n`;
  s += `日柱: ${m.day.stem}${m.day.branch}（十二運:${m.day.juniun}）\n`;
  if (m.time) s += `時柱: ${m.time.stem}${m.time.branch}（通変星:${m.time.tsuhen}、十二運:${m.time.juniun}）\n`;
  s += `五行バランス: 木${m.gogyoCount.wood} 火${m.gogyoCount.fire} 土${m.gogyoCount.earth} 金${m.gogyoCount.metal} 水${m.gogyoCount.water}\n`;
  return s;
}

function buildSoloPrompt(d) {
  const f = d.fortune;
  return `あなたは四柱推命とバイオリズムに精通した占いライターです。以下のデータに基づいて、わかりやすい言葉で運勢を伝えてください。専門用語（通変星、十二運、五行、相生、相剋など）は使わず、その意味を日常的な表現に置き換えてください。データにない情報は書かないでください。

${formatMeishiki(d.meishiki, d.name)}
性別: ${d.genderA ? (d.genderA==="female"?"女性":"男性") : "未指定"}
判定日: ${d.judgeDateStr}

【判定日の日運】
日柱: ${f.dayPillarStr}（${f.dayElement}の日）
日運の通変星: ${f.tsuhen}
日運の十二運: ${f.juniun}
五行の影響: ${f.gogyoEffect}${f.yojinLabel ? "／" + f.yojinLabel : ""}
日運スコア: ${f.fortuneScore}点
${d.shichu ? `年運（${d.shichu.year.pillar}）${d.shichu.year.score}点・月運（${d.shichu.month.pillar}）${d.shichu.month.score}点 → 四柱推命スコア ${d.shichu.score}点（年3割・月3割・日4割）` : ""}

【生まれ持った素質（命式そのもの。日によって変わらない）】
エネルギーの強さ: ${d.meishikiScore?.strengthLabel ?? "不明"}（${d.meishikiScore?.strengthSummary ?? ""}）
命式の整い方: ${d.meishikiScore?.stars ?? "-"}（${d.meishikiScore?.starLabel ?? ""}）※点数では伝えないこと
この人にとって追い風になる五行: ${(d.meishikiScore?.targetElementsJP || []).join("・") || "不明"}
命式に無い五行: ${(d.meishikiScore?.missingElementsJP || []).join("・") || "なし"}

バイオリズム（0%=最低〜100%=最高）:
身体${d.physical}% 感情${d.emotional}% 知性${d.intellectual}% 総合${d.overallScore}点

【各運勢スコア（0〜100）】
金運${d.fiveScores.money} 恋愛運${d.fiveScores.love} 仕事運${d.fiveScores.work} 健康運${d.fiveScores.health} 対人運${d.fiveScores.social}

=== 出力ルール（必ず全て守ること） ===
形式: プレーンテキストのみ。改行で段落を区切る。
文字数: 500〜700字。
禁止: マークダウン記法（#、##、**、*、-、・ など）を一切使わないこと。見出しや箇条書きも禁止。「以下に」「それでは」等の前置きも禁止。診断内容から直接書き始めること。
日付表現: 「今日は」「本日は」は使わないこと。「この日は」と表現すること。
言葉遣い: 専門用語は一切使わない。「通変星に食神が」→「楽しいことに恵まれやすい運気が」、「十二運が帝旺」→「エネルギーがピークに近い状態」のように、意味だけを伝える。語尾は丁寧に「です」「ます」調とすること。断言しすぎずに提案するような言い回しを意識すること。

=== 構成 ===
[1] この日のコンディションを一言で。（1文）
[2] 生まれ持った性格の傾向（長所）。（2文）
[3] この日の運気の流れ。どんなことがうまくいきやすいか、何に気をつけるとよいか。（2文）
[4] 金運・恋愛運・仕事運・健康運・対人運のうち特に好調なものと注意が必要なものに触れる。スコアが70以上なら好調、40以下なら注意。全部を羅列せず、目立つ2〜3項目だけ。（2文）
[5] 体力・気分・頭の回転それぞれの調子。（2文）
[6] この日を楽しく過ごすための具体的なアドバイス。（2文）`;
}

function buildPairPrompt(d) {
  const fA = d.fortuneA, fB = d.fortuneB;
  return `あなたは四柱推命とバイオリズムに精通した占いライターです。以下のデータに基づいて、わかりやすい言葉で運勢を伝えてください。専門用語（通変星、十二運、五行、相生、相剋など）は使わず、その意味を日常的な表現に置き換えてください。データにない情報は書かないでください。

${formatMeishiki(d.meishikiA, d.nameA)}
性別: ${d.genderA ? (d.genderA==="female"?"女性":"男性") : "未指定"}

${formatMeishiki(d.meishikiB, d.nameB)}
性別: ${d.genderB ? (d.genderB==="female"?"女性":"男性") : "未指定"}

判定日: ${d.judgeDateStr}
判定日の日柱: ${fA.dayPillarStr}（${fA.dayElement}の日）

【${d.nameA}のこの日の運気】
通変星: ${fA.tsuhen}　十二運: ${fA.juniun}　五行影響: ${fA.gogyoEffect}　スコア: ${fA.fortuneScore}点

【${d.nameB}のこの日の運気】
通変星: ${fB.tsuhen}　十二運: ${fB.juniun}　五行影響: ${fB.gogyoEffect}　スコア: ${fB.fortuneScore}点

五行の関係: ${d.gogyoRel}
通変星の相性: ${d.tsuhenCompat.label}（${d.tsuhenCompat.detail}）
バイオリズム相性: 身体${d.physical}% 感情${d.emotional}% 知性${d.intellectual}%
総合スコア: ${d.overallScore}%

=== 出力ルール（必ず全て守ること） ===
形式: プレーンテキストのみ。改行で段落を区切る。
禁止: マークダウン記法（#、##、**、*、-、・ など）を一切使わないこと。見出しや箇条書きも禁止。前置き禁止。
日付表現: 「今日」「本日」は使わない。「この日」と表現すること。
セクション区切り: 2つのセクションの間に「===SEPARATOR===」を1行だけ入れること。
言葉遣い: 専門用語は一切使わない。「通変星に食神が」→「楽しいことに恵まれやすい運気が」、「十二運が帝旺」→「エネルギーがピークに近い状態」のように、意味だけを伝える。語尾は丁寧に「です」「ます」調とすること。断言しすぎずに提案するような言い回しを意識すること。

=== セクション1: ふたりの基本相性（250〜400字） ===
日付に関係なく、ずっと変わらないふたりの相性。
[1] ふたりの相性を一言で。（1文）
[2] ふたりの性格がどう噛み合うか。どんな場面で相性の良さが出るか、すれ違いやすいポイントは何か。（3文）
[3] ふたりのコミュニケーションの特徴。（2文）

===SEPARATOR===

=== セクション2: この日の相性（250〜400字） ===
[4] この日のふたりの調子。（1文）
[5] それぞれの運気がふたりの関係にどう影響するか。（3文）
[6] 体力・気分・頭の回転の波長の合い方。（2文）
[7] この日のふたりへのアドバイス。（2文）`;
}

// ================================================================
//  Gemini API
// ================================================================
// ================================================================
//  AI診断コメント生成: 自宅Ollama（メイン）→ OpenRouter（フォールバック）
//  OpenAI互換のchat completions形式で統一（Ollama/OpenRouterとも対応）
// ================================================================

// 必要な環境変数:
//   OLLAMA_BASE_URL   自宅Ollamaを外部公開したURL（例: Cloudflare Tunnel等）
//                      https://xxxx.example.com のようにhttp(s)込みで設定。末尾スラッシュ不要
//   OLLAMA_MODEL       自宅Ollamaで使うモデル名（未設定時 "llama3.1"）
//   OLLAMA_TIMEOUT_MS  自宅Ollamaの応答待ちタイムアウト（未設定時 8000ms。自宅サーバー停止時に長時間待たないため）
//   OPENROUTER_API_KEY OpenRouterのAPIキー
//   OPENROUTER_MODEL   OpenRouterで使うモデル名（未設定時 "meta-llama/llama-3.1-8b-instruct:free"）
//   GEMINI_API_KEY     Google AI StudioのAPIキー
//   GEMINI_MODEL       Geminiで使うモデル名（未設定時 "gemini-2.5-flash"）
//   LLM_FALLBACK_ORDER  試行順をカンマ区切りで指定（例: "gemini,ollama,openrouter"）。
//                      未設定時の既定は "ollama,openrouter,gemini"。
//                      未知の名前は無視。設定済み（キー/URLあり）のプロバイダのみ実際に試行する。

async function callAI(prompt) {
  const DEFAULT_ORDER = ["ollama", "openrouter", "gemini"];

  // 各プロバイダの定義。key/urlが無い（未設定）ものはavailable:falseで自動スキップ
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  const PROVIDERS = {
    ollama: {
      available: !!OLLAMA_BASE_URL,
      build: () => ({
        url: `${OLLAMA_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`,
        headers: { "Content-Type": "application/json" },
        model: process.env.OLLAMA_MODEL || "llama3.1",
        timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 8000,
        providerLabel: "ollama",
        retryOn429: false, // 自宅サーバーにレート制限は通常無いため429リトライは行わない
      }),
    },
    openrouter: {
      available: !!OPENROUTER_API_KEY,
      build: () => ({
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        },
        model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free",
        timeoutMs: 15000,
        providerLabel: "openrouter",
        retryOn429: true,
      }),
    },
    gemini: {
      available: !!GEMINI_API_KEY,
      build: () => ({
        // OpenAI互換エンドポイントを使用
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GEMINI_API_KEY}`,
        },
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        timeoutMs: 15000,
        providerLabel: "gemini",
        retryOn429: true,
      }),
    },
  };

  // 試行順の決定: LLM_FALLBACK_ORDER を優先。未知名は無視し、既定順で補完（漏れ防止）
  const requested = (process.env.LLM_FALLBACK_ORDER || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(name => PROVIDERS[name]);
  const order = [...requested];
  for (const name of DEFAULT_ORDER) {
    if (!order.includes(name)) order.push(name);
  }

  let lastError = null;
  let anyAvailable = false;

  for (const name of order) {
    const p = PROVIDERS[name];
    if (!p || !p.available) continue; // 未設定プロバイダはスキップ
    anyAvailable = true;
    const r = await callOpenAICompatible({ ...p.build(), prompt });
    if (r.text !== undefined) return r;
    lastError = r.error;
  }

  if (!anyAvailable) {
    return { error: "AI API未設定: OLLAMA_BASE_URL・OPENROUTER_API_KEY・GEMINI_API_KEYのいずれかを設定してください。" };
  }
  return { error: `AI APIエラー: ${lastError}。数分後に再試行してください。` };
}

// OpenAI互換chat completions呼び出し（Ollama/OpenRouter共通処理）
// テキスト後処理（マークダウン除去・MAX_TOKENS時の短縮リトライ・文末補完）はGemini版から変更なし
async function callOpenAICompatible({ url, headers, model, prompt, timeoutMs, providerLabel, retryOn429 }) {
  const MAX_RETRIES = 1; // 429・タイムアウト時に1回リトライ（Gemini版と同数）
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
          max_tokens: 3072,
        }),
      });
      clearTimeout(timer);

      if (r.ok) {
        const d = await r.json();
        const choice = d?.choices?.[0];
        let text = choice?.message?.content || "";
        const finishReason = choice?.finish_reason || "";

        // マークダウン記号の除去
        text = text.replace(/^#{1,4}\s*/gm, "").replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1").replace(/^[-*]\s+/gm, "").trim();

        // 出力上限で途切れた場合：1回だけリトライ（短縮プロンプトで再試行）
        if (finishReason === "length" && attempt === 0) {
          console.log(`Text truncated (${providerLabel}:${model}), retrying with shorter instruction...`);
          prompt = prompt
            .replace(/500〜800字/g, "400〜600字")
            .replace(/600〜900字/g, "450〜700字");
          continue;
        }

        // それでも途切れた場合：文末を自然に補完
        if (text && !text.match(/[。！？]$/)) {
          const lastPeriod = text.lastIndexOf("。");
          if (lastPeriod > text.length * 0.6) {
            text = text.substring(0, lastPeriod + 1);
          } else {
            text = text.replace(/[、，,\s]+$/, "") + "。";
          }
        }

        return { text: text || "診断文の生成に失敗しました。", model: `${providerLabel}:${model}` };
      }

      if (r.status === 429 && retryOn429 && attempt < MAX_RETRIES) {
        await new Promise(res => setTimeout(res, 2000));
        continue;
      }
      lastError = `${r.status} (${providerLabel}:${model})`;
      break;
    } catch (e) {
      clearTimeout(timer);
      lastError = e.name === "AbortError" ? `timeout (${providerLabel}:${model})` : `${e.message} (${providerLabel}:${model})`;
      break;
    }
  }
  return { error: lastError };
}

// ================================================================
//  日運（指定日の干支が命式に及ぼす影響）
// ================================================================

function calcDayPillar(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const baseMs = Date.UTC(1900, 0, 1);
  const daysDiff = Math.floor((d.getTime() - baseMs) / 86400000);
  const offset = 10;
  const idx = ((daysDiff + offset) % 60 + 60) % 60;
  const stemIdx = idx % 10;
  const branchIdx = idx % 12;
  return { stemIdx, branchIdx, stem: STEMS[stemIdx], branch: BRANCHES[branchIdx], element: STEM_ELEMENT[STEMS[stemIdx]], elementJP: JP[STEM_ELEMENT[STEMS[stemIdx]]] };
}

// 干支インデックスから柱オブジェクトを作る（calcDayPillar と同じ形。calcDailyFortune にそのまま渡せる）
function pillarFromIdx(stemIdx, branchIdx) {
  return { stemIdx, branchIdx, stem: STEMS[stemIdx], branch: BRANCHES[branchIdx], element: STEM_ELEMENT[STEMS[stemIdx]], elementJP: JP[STEM_ELEMENT[STEMS[stemIdx]]] };
}

// 判定日の年柱・月柱（流年・流月。4.0.0〜）。
// 年は立春（2/4）、月は節入り（SETSUIRI の固定日）で切り替わる。規則は buildMeishikiLocal() と同じ。
// ※ 節入り当日の前後は天文計算と1日ずれることがある（固定日テーブルの限界）。
function calcYearMonthPillars(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  let yearForPillar = y;
  if (m < 2 || (m === 2 && day < 4)) yearForPillar--;
  const yearIdx = ((yearForPillar - 4) % 60 + 60) % 60;
  const yearStem = yearIdx % 10;
  let solarMonth = m;
  if (day < (SETSUIRI[m] || 6)) solarMonth--;
  if (solarMonth <= 0) solarMonth += 12;
  const monthBranch = solarMonth % 12;
  const monthStem = ((yearStem % 5) * 2 + 2 + (monthBranch - 2 + 12) % 12) % 10; // 五虎遁
  return { year: pillarFromIdx(yearStem, yearIdx % 12), month: pillarFromIdx(monthStem, monthBranch) };
}

// 四柱推命スコア＝年運・月運・日運の合成（4.0.0〜。六星占術アプリの「六星スコア」と同じ形）。
// 年運・月運は日運と同じ calcDailyFortune() で、判定日の年柱・月柱を渡して出す（配点表も共通なので平均は50）。
const SHICHU_SCORE_WEIGHTS = { year: 0.3, month: 0.3, day: 0.4 };
// 総合＝四柱推命スコア×0.5 ＋ バイオリズム×0.5（六星占術アプリと同じ）
const OVERALL_WEIGHTS = { shichu: 0.5, bio: 0.5 };

function calcShichuFortune(meishiki, dateStr, dayFortune) {
  const { year, month } = calcYearMonthPillars(dateStr);
  const fy = calcDailyFortune(meishiki, year);
  const fm = calcDailyFortune(meishiki, month);
  const fd = dayFortune || calcDailyFortune(meishiki, calcDayPillar(dateStr));
  const w = SHICHU_SCORE_WEIGHTS;
  const score = Math.min(100, Math.max(0, Math.round(
    fy.fortuneScore * w.year + fm.fortuneScore * w.month + fd.fortuneScore * w.day)));
  const brief = (f) => ({ pillar: f.dayPillarStr, tsuhen: f.tsuhen, juniun: f.juniun, score: f.fortuneScore });
  return { score, year: brief(fy), month: brief(fm), day: brief(fd) };
}

function calcOverall(shichuScore, bioBase) {
  return Math.min(100, Math.max(0, Math.round(
    shichuScore * OVERALL_WEIGHTS.shichu + bioBase * OVERALL_WEIGHTS.bio)));
}

// ================================================================
//  大運（10年ごとの運気の流れ。4.0.0〜）
//  点数には混ぜない。「追い風の五行（用神）が巡る10年か」を表示するためだけに使う。
// ================================================================
const DAIUN_COUNT = 8;
// 段階の出現率（400人の実測）: big 22% / good 48% / steady 30%。
// good まで「追い風」と強く言うと7割が該当して特別感が無くなるので、ボーナス期として目立たせるのは big だけにする。
const DAIUN_LEVELS = {
  big:    { label: "ボーナス期", text: "追い風になる五行が天干・地支の両方に巡る、特別な10年です。" },
  good:   { label: "おだやかな追い風", text: "追い風になる五行が、少し巡る10年です。" },
  steady: { label: "力を蓄える時期", text: "地力を蓄えて、次の流れに備える10年です。" },
};

// 生まれから「次の節入り」（順行）または「前の節入り」（逆行）までの日数
function daysToSetsuiri(birthStr, forward) {
  const b = new Date(birthStr + "T00:00:00Z");
  const y = b.getUTCFullYear(), m = b.getUTCMonth(); // m: 0-11
  const setsu = (yy, mm) => { // mm: 0-11（はみ出しは Date.UTC が繰り上げる）
    const real = new Date(Date.UTC(yy, mm, 1));
    return Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), SETSUIRI[real.getUTCMonth() + 1] || 6);
  };
  const thisSetsu = setsu(y, m);
  let target;
  if (forward) target = b.getTime() < thisSetsu ? thisSetsu : setsu(y, m + 1);
  else target = b.getTime() >= thisSetsu ? thisSetsu : setsu(y, m - 1);
  return Math.abs(target - b.getTime()) / 86400000;
}

// 満年齢
function ageAt(birthStr, dateStr) {
  const b = new Date(birthStr + "T00:00:00Z"), d = new Date(dateStr + "T00:00:00Z");
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

function calcDaiun(meishiki, birthStr, gender, judgeDateStr) {
  // 順行・逆行は性別で決まる。未選択のときは補完せず（「男性とみなす」等をしない）、案内だけ返す
  if (gender !== "male" && gender !== "female") return { available: false, reason: "gender" };
  const yearStemIdx = STEMS.indexOf(meishiki.year.stem);
  const dayStemIdx = STEMS.indexOf(meishiki.day.stem);
  const monthStemIdx = STEMS.indexOf(meishiki.month.stem);
  const monthBranchIdx = BRANCHES.indexOf(meishiki.month.branch);
  if (yearStemIdx < 0 || dayStemIdx < 0 || monthStemIdx < 0 || monthBranchIdx < 0) return { available: false, reason: "meishiki" };

  // 陽年生まれの男性・陰年生まれの女性は順行、それ以外は逆行
  const forward = (gender === "male") === (yearStemIdx % 2 === 0);
  // 起運: 節入りまでの日数 ÷ 3 = 歳（3日で1年）。固定日テーブルなので前後1年ほどずれうる
  const startAge = Math.max(1, Math.round(daysToSetsuiri(birthStr, forward) / 3));

  // 月柱の60干支インデックス
  let monthIdx60 = 0;
  for (let i = 0; i < 60; i++) if (i % 10 === monthStemIdx && i % 12 === monthBranchIdx) { monthIdx60 = i; break; }

  const targets = Array.isArray(meishiki.targetElements) ? meishiki.targetElements : [];
  const list = [];
  for (let k = 1; k <= DAIUN_COUNT; k++) {
    const idx = ((monthIdx60 + (forward ? k : -k)) % 60 + 60) % 60;
    const stemIdx = idx % 10, branchIdx = idx % 12;
    const stem = STEMS[stemIdx], branch = BRANCHES[branchIdx];
    const stemEl = STEM_ELEMENT[stem], branchEl = BRANCH_ELEMENT_MAP[branch];
    const hits = (targets.includes(stemEl) ? 1 : 0) + (targets.includes(branchEl) ? 1 : 0);
    const level = hits >= 2 ? "big" : hits === 1 ? "good" : "steady";
    const yojinJP = [...new Set([stemEl, branchEl].filter(e => targets.includes(e)))].map(e => JP[e]);
    list.push({
      pillar: stem + branch,
      ageFrom: startAge + (k - 1) * 10, ageTo: startAge + k * 10 - 1,
      tsuhen: getTsuhen(dayStemIdx, stemIdx),
      juniun: JUNIUNN[JUNIUN_TABLE[dayStemIdx][branchIdx]],
      elementsJP: JP[stemEl] + "・" + JP[branchEl],
      yojinJP, level, label: DAIUN_LEVELS[level].label, text: DAIUN_LEVELS[level].text,
    });
  }
  const age = ageAt(birthStr, judgeDateStr);
  const currentIdx = list.findIndex(x => age >= x.ageFrom && age <= x.ageTo);
  const current = currentIdx >= 0 ? list[currentIdx] : null;
  // 次に来るボーナス期（今がボーナス期でも、その次を案内する）
  const from = currentIdx >= 0 ? currentIdx + 1 : list.findIndex(x => x.ageFrom > age);
  const nextBonus = from >= 0 ? list.slice(from).find(x => x.level === "big") || null : null;
  return {
    available: true, direction: forward ? "順行" : "逆行", startAge, age,
    beforeStart: age < startAge, current, nextBonus, list,
    targetElementsJP: targets.map(e => JP[e]),
  };
}

function calcDailyFortune(meishiki, dayPillar) {
  // 日干のインデックスを逆引き
  const dayStemIdx = STEMS.indexOf(meishiki.day.stem);

  // 日運の通変星: 指定日の天干と本人の日干の関係
  const tsuhen = getTsuhen(dayStemIdx, dayPillar.stemIdx);

  // 日運の十二運: 指定日の地支と本人の日干の関係
  const juniun = JUNIUNN[JUNIUN_TABLE[dayStemIdx][dayPillar.branchIdx]];

  // 十二運のエネルギースコア（0-100）
  // 3.d.0〜: 12段階の平均が 50 になるよう等間隔に割り直した（中立＝50）。強弱の順序は不変。
  // ※ calcMeishikiScore() の同名テーブルは旧値のまま（命式は星表示で、閾値が旧分布基準のため）
  const juniinScores = { "帝旺":95, "建禄":87, "冠帯":79, "長生":71, "沐浴":62, "養":54, "胎":46, "衰":38, "病":29, "墓":21, "死":13, "絶":5 };
  const energyScore = juniinScores[juniun] ?? 50;

  // 五行の作用: 指定日の五行が本人の日干五行にどう作用するか（説明用の文言）
  const dayElem = dayPillar.element;
  const selfElem = meishiki.dayElement;
  let gogyoEffect = "";
  const cycle = WUXING_CYCLE;
  const iDay = cycle.indexOf(dayElem), iSelf = cycle.indexOf(selfElem);
  if (dayElem === selfElem) gogyoEffect = "比和（同じ" + JP[dayElem] + "の気が巡る日）";
  else if (cycle[(iDay+1)%5] === selfElem) gogyoEffect = "相生（" + JP[dayElem] + "が" + JP[selfElem] + "を生む日）";
  else if (cycle[(iSelf+1)%5] === dayElem) gogyoEffect = "泄気（" + JP[selfElem] + "が" + JP[dayElem] + "を生み出す日）";
  else if (cycle[(iDay+2)%5] === selfElem) gogyoEffect = "相剋（" + JP[dayElem] + "が" + JP[selfElem] + "を剋す日）";
  else if (cycle[(iSelf+2)%5] === dayElem) gogyoEffect = "克出（" + JP[selfElem] + "が" + JP[dayElem] + "を剋す日）";
  else gogyoEffect = JP[dayElem] + "の気が巡る日";

  // 通変星の日運スコア（0-100）
  // 3.d.0〜: 10種の平均が 50 になるよう等差（初項77・公差-6）で付け直した。吉凶の順序は不変。
  const tsuhenScores = { "比肩":47, "劫財":29, "食神":77, "傷官":35, "偏財":59, "正財":71, "偏官":23, "正官":53, "偏印":41, "印綬":65 };
  const tsuhenScore = tsuhenScores[tsuhen] ?? 50;

  // --- 五行スコアは「用神が巡っているか」で採点する（v3.c.0〜）--------------
  //
  // 【重要】単純な相生・相剋で採点してはいけない。吉凶は身強／身弱で逆転する。
  //   身強の人が印星（自分を生む五行）の日を迎えれば過剰で重くなり、
  //   身弱の人にとっては同じ日が支えになる。相生＝常に吉、ではない。
  // そこで命式から決めた用神（身弱→印星・比劫／身強→食傷・財・官）に
  // 指定日の五行が当たるかで採点する。用神は優先順位つきリストで、
  // 先頭ほど効きが強い。用神に入らない五行は忌神寄りとして低めに置く。
  // 3.d.0〜: 出現頻度込みの平均が 50 になるよう全段を下げた（90/75/50/35 → 80/65/45/30）。
  //   値は tools/score-distribution.mjs で実測して決めた。順序は不変。
  const targets = Array.isArray(meishiki.targetElements) ? meishiki.targetElements : [];
  const targetIdx = targets.indexOf(dayElem);
  let gogyoScore, yojinLabel;
  if (targetIdx === 0)      { gogyoScore = 80; yojinLabel = "用神（最も効く五行）が巡る日"; }
  else if (targetIdx > 0)   { gogyoScore = 65; yojinLabel = "喜神（次に効く五行）が巡る日"; }
  else if (dayElem === selfElem) { gogyoScore = 45; yojinLabel = "日干と同じ五行が巡る日"; }
  else                      { gogyoScore = 30; yojinLabel = "忌神寄りの五行が巡る日"; }
  // 用神が決まらない（命式取得に失敗した等）ときは中立に倒す
  if (targets.length === 0) { gogyoScore = 50; yojinLabel = ""; }

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
    yojinLabel,
    gogyoScore,
    fortuneScore,
  };
}

// ================================================================
//  命式スコア（生まれ持った素質。0〜100）
//
//  日運（その日の干支×日干。毎日変わる）とは別軸で、命式そのものの
//  整い方を採点する。**総合スコアには混ぜない**（別枠表示）。
//  総合スコアは「その日の運勢」であり、毎日変わらない値を混ぜると
//  日々の変動が薄まって日運の意味が読み取れなくなるため。
// ================================================================
const MEISHIKI_SCORE_WEIGHTS = {
  juniun: 0.35,    // 日柱の十二運＝生まれ持ったエネルギーの量
  gogyoSpread: 0.30, // 五行がどれだけ揃っているか（偏りの少なさ）
  balance: 0.25,   // 身強／身弱の極端さ（中和に近いほど高い）
  rooted: 0.10,    // 月令に通根しているか（命式の芯の強さ）
};

// 命式スコア → 星。上から順に評価し、最初に min を満たした段階を採る。
const MEISHIKI_STAR_LEVELS = [
  { min: 78, level: 3, label: "しっかり整った配置" },
  { min: 60, level: 2, label: "整った配置" },
  { min: 0,  level: 1, label: "個性的な配置" },
];

function calcMeishikiScore(meishiki) {
  const juniinScores = { "帝旺":100, "建禄":95, "冠帯":85, "長生":80, "沐浴":70, "養":65, "胎":55, "衰":45, "病":35, "墓":25, "死":15, "絶":10 };
  const juniunScore = juniinScores[meishiki.day.juniun] ?? 50;

  // 五行の揃い具合: 5種そろえば満点。欠けるほど下がる。
  const gc = meishiki.gogyoCount || {};
  const kinds = WUXING_CYCLE.filter(e => (gc[e] ?? 0) > 0).length;
  const spreadScore = { 0:20, 1:20, 2:40, 3:65, 4:85, 5:100 }[kinds] ?? 50;

  // 強弱バランス: 命名サービスの閾値（身弱<=1 / 身強>=6）の中央 3.5 を中和の芯とし、
  // そこから離れるほど下げる。極端な身強・身弱は扱いが難しいという見立て。
  const sc = meishiki.strength?.score ?? 3.5;
  const balanceScore = Math.max(20, Math.round(100 - Math.abs(sc - 3.5) * 9));

  const rootedScore = meishiki.strength?.rootedInMonth ? 100 : 55;

  const w = MEISHIKI_SCORE_WEIGHTS;
  const score = Math.min(100, Math.max(0, Math.round(
    juniunScore * w.juniun + spreadScore * w.gogyoSpread +
    balanceScore * w.balance + rootedScore * w.rooted
  )));

  // 画面には点数でなく星を出す（3.d.0〜）。閾値は 3.c.0 実測の分位点（中央68 / p10=49 / p90=84）基準。
  // 命式は本人そのものなので「該当なし」の ☆☆☆ は作らず3段階。どの段階も肯定的な言葉にする。
  const star = MEISHIKI_STAR_LEVELS.find(lv => score >= lv.min);

  const missing = WUXING_CYCLE.filter(e => (gc[e] ?? 0) === 0).map(e => JP[e]);
  const strengthLabel = STRENGTH_LABEL[meishiki.strength?.strength] || "中和";
  const targetsJP = (meishiki.targetElements || []).map(e => JP[e]);

  return {
    score,                       // 内部値。画面には出さない（デバッグ・閾値調整用）
    stars: "★".repeat(star.level) + "☆".repeat(3 - star.level),
    starLevel: star.level,
    starLabel: star.label,
    strength: meishiki.strength?.strength || "neutral",
    strengthLabel,
    strengthSummary: meishiki.strength?.summary || "",
    rootedInMonth: !!meishiki.strength?.rootedInMonth,
    targetElementsJP: targetsJP,
    missingElementsJP: missing,
    breakdown: {
      juniun: juniunScore,
      gogyoSpread: spreadScore,
      balance: balanceScore,
      rooted: rootedScore,
    },
  };
}

// ================================================================
//  5運勢スコア計算（金運・恋愛運・仕事運・健康運・対人運）
// ================================================================
// 通変星→各運勢への補正値（金運・恋愛・仕事・健康・対人）。
// 作者の意図（どの星がどの分野に効くか）を残すため表は手書きのまま持ち、
// 使うときに calcFiveFortuneScores() 側で「星そのものの良し悪し」と「分野ごとの偏り」を差し引く。
const TSUHEN_MAP = {
  //            金運  恋愛  仕事  健康  対人
  "比肩":   [  -5,   -5,    5,    5,   -5 ],
  "劫財":   [ -10,    0,    0,   -5,  -10 ],
  "食神":   [  10,   15,    5,   10,   15 ],
  "傷官":   [   5,    5,   -5,   -5,   -5 ],
  "偏財":   [  20,   10,   10,    0,   10 ],
  "正財":   [  15,   15,   15,    5,    5 ],
  "偏官":   [  -5,   -5,   10,  -10,   -5 ],
  "正官":   [   5,   10,   20,    0,   10 ],
  "偏印":   [   0,   -5,    5,   -5,    0 ],
  "印綬":   [   5,    5,   15,    5,   10 ],
};
// 列（分野）ごとの平均。差し引かないと、健康運が常に低め・仕事運が常に高めに出る（実測で健康運の中央値44）。
const TSUHEN_FIELD_MEAN = [0, 1, 2, 3, 4].map(j =>
  Object.values(TSUHEN_MAP).reduce((a, r) => a + r[j], 0) / Object.keys(TSUHEN_MAP).length);
const TSUHEN_GRAND_MEAN = TSUHEN_FIELD_MEAN.reduce((a, v) => a + v, 0) / 5;

// 5運勢のバイオリズム寄与の係数。対応するバイオリズムが5分野の平均より 10 高いと +3。
const FIVE_BIO_WEIGHT = 0.3;

// 3.e.0〜: 5運勢は「総合スコアを分野ごとに振り分けたもの」。
//   運勢 = 総合 + 分野ごとの上下（5分野の上下の合計は 0）
// なので 5運勢の平均は総合と一致する（0〜100 で切れたときだけわずかにずれる）。
// 以前は 十二運×0.3 + バイオリズム1本×0.3 + 20 + 補正 という総合とは別の式で、
// 同じ材料から出ているのに総合との関係が説明できなかった。
// 上下の材料:
//   - 通変星: その日の星がどの分野に効くか（星そのものの良し悪しは日運経由で総合に入っているので差し引く）
//   - バイオリズム: 金運・仕事運=知性、恋愛運・対人運=感情、健康運=身体 が他より高いか低いか
//   - 命式: 金の五行が多い→金運、水が多い→対人運、性別と財星・官星→恋愛運
function calcFiveFortuneScores(fortune, meishiki, biorhythm, gender, overall) {
  const t = fortune.tsuhen;
  const bio = biorhythm; // { physical, emotional, intellectual } (-1〜1のsin値)

  // バイオリズムを0-100にスケーリング
  const bioPhy = Math.round(((bio.physical + 1) / 2) * 100);
  const bioEmo = Math.round(((bio.emotional + 1) / 2) * 100);
  const bioInt = Math.round(((bio.intellectual + 1) / 2) * 100);

  // 通変星: 行の平均（星の良し悪し）と列の平均（分野の偏り）を差し引いた「分野への振り分け」だけを使う
  const row = TSUHEN_MAP[t] || [0, 0, 0, 0, 0];
  const rowMean = row.reduce((a, v) => a + v, 0) / 5;
  const tsuhenAdj = row.map((v, j) => TSUHEN_MAP[t] ? v - rowMean - TSUHEN_FIELD_MEAN[j] + TSUHEN_GRAND_MEAN : 0);

  // バイオリズム: 分野に対応する周期
  const fieldBio = [bioInt, bioEmo, bioInt, bioPhy, bioEmo];
  const fieldBioMean = fieldBio.reduce((a, v) => a + v, 0) / 5;

  // 命式・性別の補正
  let loveBonusGender = 0;
  if (gender === "male" && (t === "正財" || t === "偏財")) loveBonusGender = 5;
  if (gender === "female" && (t === "正官" || t === "偏官")) loveBonusGender = 5;
  const gc = meishiki.gogyoCount;
  const metalBonus = Math.min(gc.metal * 3, 9);
  const waterBonus = Math.min(gc.water * 2, 6);
  const extra = [metalBonus, loveBonusGender, 0, 0, waterBonus];

  // 上下の合計を 0 に揃える（＝5運勢の平均が総合になる）
  const adj = [0, 1, 2, 3, 4].map(j =>
    tsuhenAdj[j] + (fieldBio[j] - fieldBioMean) * FIVE_BIO_WEIGHT + extra[j]);
  const adjMean = adj.reduce((a, v) => a + v, 0) / 5;
  const clamp = (v) => Math.min(100, Math.max(0, Math.round(v)));
  const [money, love, work, health, social] = adj.map(a => clamp(overall + a - adjMean));

  return { money, love, work, health, social };
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
//  週間・月間データ生成
// ================================================================
function buildRangeData(meishikiA, birthA, baseDateStr, days, mode, meishikiB, birthB) {
  const result = [];
  const baseMs = new Date(baseDateStr + "T00:00:00Z").getTime();
  const birthAMs = new Date(birthA + "T00:00:00Z").getTime();
  const birthBMs = birthB ? new Date(birthB + "T00:00:00Z").getTime() : 0;
  for (let i = 0; i < days; i++) {
    const dMs = baseMs + i * 86400000;
    const d = new Date(dMs);
    const ds = d.toISOString().slice(0, 10);
    const dp = calcDayPillar(ds);
    const fA = calcDailyFortune(meishikiA, dp);
    const bioA = calcBiorhythm(Math.floor((dMs - birthAMs) / 86400000));

    const entry = { date: ds, dayPillar: dp.stem + dp.branch, dayElement: dp.elementJP };

    if (mode === "solo") {
      const phy = Math.round(((bioA.physical + 1) / 2) * 100);
      const emo = Math.round(((bioA.emotional + 1) / 2) * 100);
      const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
      const bioBase = Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);
      const shichu = calcShichuFortune(meishikiA, ds, fA);
      entry.score = calcOverall(shichu.score, bioBase);
      entry.shichu = shichu.score;
      entry.fortune = fA.fortuneScore;
      entry.tsuhen = fA.tsuhen;
      entry.juniun = fA.juniun;
    } else {
      const bioB = calcBiorhythm(Math.floor((dMs - birthBMs) / 86400000));
      const fB = calcDailyFortune(meishikiB, dp);
      const phy = Math.round((1 - Math.abs(bioA.physical - bioB.physical) / 2) * 100);
      const emo = Math.round((1 - Math.abs(bioA.emotional - bioB.emotional) / 2) * 100);
      const int_ = Math.round((1 - Math.abs(bioA.intellectual - bioB.intellectual) / 2) * 100);
      const bioScore = Math.round(phy * 0.25 + emo * 0.35 + int_ * 0.25);
      const avgF = (fA.fortuneScore + fB.fortuneScore) / 2;
      const fBonus = Math.round((avgF - 50) / 10);
      entry.score = Math.min(100, Math.max(0, bioScore + fBonus + 15));
      entry.fortuneA = fA.fortuneScore;
      entry.fortuneB = fB.fortuneScore;
    }
    result.push(entry);
  }
  return result;
}

// ================================================================
//  バイオリズムグラフデータ（前後15日 = 30日分）
// ================================================================
function buildBioGraphData(birthA, baseDateStr, span, birthB) {
  const baseMs = new Date(baseDateStr + "T00:00:00Z").getTime();
  const birthAMs = new Date(birthA + "T00:00:00Z").getTime();
  const birthBMs = birthB ? new Date(birthB + "T00:00:00Z").getTime() : 0;
  const half = Math.floor(span / 2);
  const result = { labels: [], a: { physical: [], emotional: [], intellectual: [] } };
  if (birthB) result.b = { physical: [], emotional: [], intellectual: [] };

  for (let i = -half; i <= half; i++) {
    const dMs = baseMs + i * 86400000;
    const d = new Date(dMs);
    const ds = d.toISOString().slice(0, 10);
    result.labels.push(ds);
    const bioA = calcBiorhythm(Math.floor((dMs - birthAMs) / 86400000));
    result.a.physical.push(Math.round(((bioA.physical + 1) / 2) * 100));
    result.a.emotional.push(Math.round(((bioA.emotional + 1) / 2) * 100));
    result.a.intellectual.push(Math.round(((bioA.intellectual + 1) / 2) * 100));
    if (birthB) {
      const bioB = calcBiorhythm(Math.floor((dMs - birthBMs) / 86400000));
      result.b.physical.push(Math.round(((bioB.physical + 1) / 2) * 100));
      result.b.emotional.push(Math.round(((bioB.emotional + 1) / 2) * 100));
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
  return { physical: Math.sin((2*Math.PI*days)/23), emotional: Math.sin((2*Math.PI*days)/28), intellectual: Math.sin((2*Math.PI*days)/33) };
}
