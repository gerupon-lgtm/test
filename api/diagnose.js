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
  const judgeDate = new Date(judgeDateStr + "T00:00:00Z");
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const isToday = judgeDateStr === todayStr;

  // ========== 一人目の計算 ==========
  const meishikiA = buildMeishiki(birthA, timeA);
  const bioA = calcBiorhythm(diffDays(new Date(birthA + "T00:00:00Z"), judgeDate));
  const dayPillar = calcDayPillar(judgeDateStr);
  const fortuneA = calcDailyFortune(meishikiA, dayPillar);

  // AI診断コメント生成: 自宅Ollama（メイン）→ OpenRouter（フォールバック）

  if (isSolo) {
    const phy = Math.round(((bioA.physical + 1) / 2) * 100);
    const emo = Math.round(((bioA.emotional + 1) / 2) * 100);
    const int_ = Math.round(((bioA.intellectual + 1) / 2) * 100);
    const bioBase = Math.round(phy * 0.3 + emo * 0.4 + int_ * 0.3);
    const overall = Math.min(100, Math.max(0, Math.round(bioBase * 0.6 + fortuneA.fortuneScore * 0.4)));

    // 5運勢スコア
    const fiveScores = calcFiveFortuneScores(fortuneA, meishikiA, bioA, genderA);

    const prompt = buildSoloPrompt({
      name: nameA || "あなた", birthA, genderA, timeA, meishiki: meishikiA,
      fortune: fortuneA, dayPillar, isToday, fiveScores,
      physical: phy, emotional: emo, intellectual: int_, overallScore: overall, judgeDateStr,
    });
    const result = await callAI(prompt);
    if (result.error) return res.status(502).json({ error: result.error });
    const diagText = sanitizeDateWords(result.text, judgeDateStr);

    let weeklyData = [], monthlyData = [], bioGraph = null;
    try {
      weeklyData = buildRangeData(meishikiA, birthA, judgeDateStr, 7, "solo");
      monthlyData = buildRangeData(meishikiA, birthA, judgeDateStr, 30, "solo");
      bioGraph = buildBioGraphData(birthA, judgeDateStr, 30);
    } catch (e) {
      console.error("Range data error:", e);
    }

    const luckyA = calcLucky(meishikiA);

    return res.status(200).json({
      mode: "solo", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
      fiveScores,
      meishikiA, fortuneA, dayPillar: { stem: dayPillar.stem, branch: dayPillar.branch, element: dayPillar.elementJP },
      lucky: luckyA,
      diagnosis: diagText, usedModel: result.model, targetDate: judgeDateStr,
      weeklyData, monthlyData, bioGraph,
    });
  }

  // ========== 相性診断 ==========
  const meishikiB = buildMeishiki(birthB, timeB);
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
    monthlyData = buildRangeData(meishikiA, birthA, judgeDateStr, 30, "pair", meishikiB, birthB);
    bioGraph = buildBioGraphData(birthA, judgeDateStr, 30, birthB);
  } catch (e) {
    console.error("Range data error:", e);
  }

  const luckyA = calcLucky(meishikiA);
  const luckyB = calcLucky(meishikiB);

  return res.status(200).json({
    mode: "pair", overallScore: overall, physical: phy, emotional: emo, intellectual: int_,
    meishikiA, meishikiB, gogyoRelation: gogyoRel, tsuhenCompat: tsuhenCompat.label,
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

function buildMeishiki(dateStr, timeStr) {
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
  const BRANCH_ELEMENT = ["water","earth","wood","wood","earth","fire","fire","earth","metal","metal","earth","water"];
  branches.forEach(b => gogyoCount[BRANCH_ELEMENT[b]]++);
  // 月令（月支の分野蔵干）の五行を加算：命式で最も強く作用するため反映する
  if (monthZoukanStem !== null) gogyoCount[STEM_ELEMENT[monthZoukanStem]]++;

  const dayElement = STEM_ELEMENT[STEMS[dayStem]];

  return {
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
五行の影響: ${f.gogyoEffect}
日運スコア: ${f.fortuneScore}点

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
//  5運勢スコア計算（金運・恋愛運・仕事運・健康運・対人運）
// ================================================================
function calcFiveFortuneScores(fortune, meishiki, biorhythm, gender) {
  const t = fortune.tsuhen;
  const e = fortune.energyScore;
  const bio = biorhythm; // { physical, emotional, intellectual } (-1〜1のsin値)

  // バイオリズムを0-100にスケーリング
  const bioPhy = Math.round(((bio.physical + 1) / 2) * 100);
  const bioEmo = Math.round(((bio.emotional + 1) / 2) * 100);
  const bioInt = Math.round(((bio.intellectual + 1) / 2) * 100);

  // 通変星→各運勢への影響マップ（-15〜+20の補正値）
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

  const tm = TSUHEN_MAP[t] || [0, 0, 0, 0, 0];

  // 性別による恋愛運の追加補正
  let loveBonusGender = 0;
  if (gender === "male" && (t === "正財" || t === "偏財")) loveBonusGender = 5;
  if (gender === "female" && (t === "正官" || t === "偏官")) loveBonusGender = 5;

  // 五行バランスの偏り補正（金の数→金運、水の数→対人運に微補正）
  const gc = meishiki.gogyoCount;
  const metalBonus = Math.min(gc.metal * 3, 9);
  const waterBonus = Math.min(gc.water * 2, 6);

  // 各運勢スコア = 基礎（十二運×0.3 + バイオリズム×0.3）+ 通変星補正 + 固有補正
  const base = (n) => Math.round(e * 0.3 + n * 0.3 + 20);
  const clamp = (v) => Math.min(100, Math.max(5, v));

  const money    = clamp(base(bioInt) + tm[0] + metalBonus);
  const love     = clamp(base(bioEmo) + tm[1] + loveBonusGender);
  const work     = clamp(base(bioInt) + tm[2]);
  const health   = clamp(base(bioPhy) + tm[3]);
  const social   = clamp(base(bioEmo) + tm[4] + waterBonus);

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
      entry.score = Math.min(100, Math.max(0, Math.round(bioBase * 0.6 + fA.fortuneScore * 0.4)));
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
