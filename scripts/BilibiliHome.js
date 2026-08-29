/*
 * Bilibili 首页改造脚本 (Loon http-response)
 *
 * 目的：接管首页（同一脚本按 URL 分流处理两个接口）。
 *   - 拦 /x/resource/show/tab/v2（唯一处理者）：顶栏折叠成单 tab（名字随模式）；
 *     右上角加 收藏夹/稍后再看 入口；底栏只留 首页/动态/我的；删「…」更多菜单。
 *   - 拦 app.bilibili.com/x/v2/feed/index（明文 JSON，identity）：按模式改写 data.items。
 *
 * 【信息流模式】= Loon [Argument] 的 select 参数 homeShow（五档，经 argument= 传入；旧名 homeShowWatchLater 仍兜底认）：
 *   改稍后再看（随机）→ 换成「稍后再看」列表，每次下拉刷新重新洗牌
 *   改稍后再看        → 换成「稍后再看」列表，按 B 站默认顺序
 *   空白界面          → data.items 恒空
 *   过滤信息流        → B 站原生推荐流 + homeFeedFilter/homeBlockWords 生效（旧档名「原生信息流」「每天1次推送」都映射到这里）
 *   默认信息流（默认）→ 完全不动 B 站的东西，两个过滤参数一概不生效（旧档名「关」仍认）
 *
 * 【原生流过滤】两个 input 参数，**只在「过滤信息流」档生效**：
 *   homeFeedFilter  数字开关集合 —— 去广告/去直播/去竖屏/去图文/时长下限/[话题]标题前缀/精简顶栏/每天推送(n)次（见 parseFeedFilter）
 *                   ⚠️「精简顶栏」同时作用于 tab/v2（那条 [Script] 也要传这个参数）
 *   homeBlockWords  屏蔽词 —— 标题/UP名/话题标签，可用 title: up: tag: 限定（见 parseBlockWords）
 *   两者都不启用时「过滤信息流」档仍走零成本 $done({})。
 *   顶栏 tab：是否折叠见 shouldSlimTab；折叠后的名字随模式（稍后再看两档=「稍后再看」，空白界面=「首页」，
 *   过滤信息流=不改名）。右上角入口/底栏精简/删「…」菜单 恒改。
 *
 * 【「稍后再看」两档的实现】
 *   - 脚本内用 $httpClient.get 反查 /x/v2/history/toview/v2/list（需签名）
 *   - 把 toview 的 data.list[] 逐条转成 feed 卡片（单列 large_cover_single_v9 / 双列 small_cover_v2，按请求 column 切换）
 *   - 失败时回退到上次缓存（$persistentStore），无缓存则返回空壳（空 items）
 *
 * 卡片不再用「整卡模板克隆」，改为构造器拼装：菜单等公共片段抽成 builder（去重、不留模板残值），
 * 只有 OPaque 静态资源块（按钮图标 / 点赞动画 / 进度条 / 分享开关）保留成具名常量，照抓包原样。
 *
 * 仅自用，签名所用 appkey/appsec 为公开的 iOS 端固定值。
 */

const APPKEY = "27eb53fc9058f8c3";
const APPSEC = "c2ed53a74eeefe3cf99fbd01d8c9c375";
const CACHE_KEY = "bili_home_watchlater_raw"; // 缓存 toview 原始 list（按列数即时构卡，支持单/双列切换）
const OFFSET_KEY = "bili_home_watchlater_off"; // 分页游标：下一页起始偏移（脚本自己维护，见下）
const DAILY_KEY = "bili_home_daily_feed"; // 「每天推送(n)次」的状态：{date,dbl,n,items}，n=当天已投放次数
const PAGE_SIZE = 20; // 每页显示条数（首屏 + 每次下拉加载）
// ⚠️ 分页游标必须脚本自维护，不能依赖 App 回传的 idx（capture60 实测）：
//    App 下拉加载（pull=0）回传的 idx = 它手里所有卡的「最大 idx」，而首屏顶部那张卡 idx 恒定最大
//    → 不论卡 idx 递增还是递减，App 每次都回传同一个值、游标永不前进 → 反复出前 20 条。
//    所以改用 pull 参数区分「刷新(pull=1)」vs「加载更多(pull=0)」，偏移量自己存 $persistentStore。
//    卡片 idx 仍设成递减（IDX_BASE - 全局序号），仅为与真实 feed 同序（App 若按 idx 排序则新页排在下方）。
const IDX_BASE = 2000000000;

// ⚠️ Loon 的 console.log 疑似在空格处截断且只取首段 → 拼成单串并把所有空白换成·，前缀用 [HWL] 以便辨认新版是否加载
const LOG = (...a) => {
  try {
    const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    console.log(("[HWL] " + s).replace(/\s/g, "·"));
  } catch (e) {}
};

// 按参数名从 $argument 取原始值。官方写法 argument=[{a},{b}] 时 $argument 是按名映射的
// 对象（{a:"x",...}），直接 $argument[name] 取值最稳；JSON 字符串兜底，避免再踩 XHSClean 那次
// 「整段 stringify 后用 /true/ 扫全文」的坑——多个参数时会扫到别的参数，含糊不清。
function getArgRaw(name) {
  const raw = typeof $argument === "undefined" ? null : $argument;
  if (raw == null) return null;
  if (typeof raw === "object") return raw[name];
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed[name] : raw; }
  catch (e) { return raw; } // 非 JSON：单值字符串，原样返回
}

// —— 信息流模式（[Argument] select 参数 homeShow）——
const MODE_LATER_RANDOM = "later_random"; // 稍后再看（随机）
const MODE_LATER = "later";               // 稍后再看
const MODE_BLANK = "blank";               // 空白界面
const MODE_FILTER = "filter";             // 过滤信息流：B 站原生流 + homeFeedFilter/homeBlockWords
const MODE_OFF = "off";                   // 默认信息流：完全不动（旧档名「关」）

// 按关键词判断而不是整串比对（同 XHSClean 的做法）：[Argument] 里的选项文案怎么改都不会打断解析。
// ⚠️ 改档名时必须同步在这里加关键词，否则新档名匹配不上 → 静默走回落分支。
function parseHomeMode() {
  // 参数名 2026-08-15 由 homeShowWatchLater 改成 homeShow；旧名留作兜底——插件与脚本分别住在
  // gist / 公开仓库，更新必有先后，读不到就静默回落默认档（跟"脚本没跑"一个症状），很难查。
  let raw = getArgRaw("homeShow");
  if (raw == null) raw = getArgRaw("homeShowWatchLater");
  if (raw == null) return MODE_OFF;                                // 未接入参数 → 不接管首页
  if (typeof raw === "boolean") return raw ? MODE_LATER_RANDOM : MODE_OFF; // 兼容旧 switch 配置
  const s = String(raw).trim().replace(/^["'\[]+|["'\]]+$/g, "");
  if (s === "true" || s === "1") return MODE_LATER_RANDOM;         // 旧 switch 配置的 true（空串则落到末尾的回落分支）
  if (s === "false" || s === "0") return MODE_OFF;
  if (s.indexOf("随机") !== -1) return MODE_LATER_RANDOM;          // ⚠️ 必须先判：「稍后再看（随机）」也含「稍后」
  if (s.indexOf("稍后") !== -1) return MODE_LATER;
  if (s.indexOf("空白") !== -1) return MODE_BLANK;
  if (s.indexOf("过滤") !== -1) return MODE_FILTER;                // 过滤信息流：原生流 + 两个过滤参数生效
  if (s.indexOf("默认") !== -1) return MODE_OFF;                   // 默认信息流：完全不动 B 站的东西
  // —— 以下全是历史档名，映射到功能等价的新档，免得老配置一更新就变行为 ——
  if (s.indexOf("原生") !== -1) return MODE_FILTER;                // 旧档名「原生信息流」＝原生流+过滤，等价于现在的「过滤信息流」
  if (s.indexOf("每天") !== -1 || s.indexOf("1次") !== -1 || s.indexOf("一次") !== -1) return MODE_FILTER; // 旧档名「每天1次推送」：投放节奏已移进 homeFeedFilter
  if (s.indexOf("关") !== -1) return MODE_OFF;                     // 最早的档名「关」＝什么都不做
  // ⚠️ 认不出的档位回落「默认信息流」而不是稍后再看：插件与 JS 的更新必有先后，档名一改、
  //    旧 JS 就一个都匹配不上（2026-08-26 真机踩过：插件已给「原生信息流」、gist 的 JS 还是旧版
  //    → 静默落回稍后再看，用户以为是 bug）。回落到「不动 B 站的东西」才是最小惊讶。
  return MODE_OFF;
}

// ===== 原生信息流过滤（[Argument] input 参数 homeFeedFilter）=====
// 一个文本框管一串开关，写法形如：「去广告(1) 去直播(1) 去竖屏(1) 过滤(240)秒以下」
//   · 括号里的数字就是取值：开关类 1=开/0=关；「秒」那条填秒数，0 或不写=不按时长丢。
//   · 括号用全角（）半角()都行，写成 去广告=1 / 去广告：1 也认；分隔符任意（空格、中英文逗号、顿号、分号、换行）。
//   · 只按关键词认（广告/直播/竖屏/秒|时长），所以措辞随便改；认不出的段落忽略，整串留空=全不过滤。
//   · 支持注释：每行 // 或 # 之后的内容一律忽略（默认值里就带一句「1=开 0=关」的提醒）。
// ⚠️ 只在 **homeShow=「过滤信息流」** 档生效（含其中的「每天推送(n)次」投放节奏）；「默认信息流」档一概不理。「改稍后再看」两档的卡片是脚本自己造的、
//    是用户自己收藏的内容，不该拿广告/直播/竖屏这套去筛，故不参与。
function parseFeedFilter(raw) {
  const out = { ad: false, live: false, vertical: false, picture: false, ogv: false, minDur: 0, tagPrefix: false, slimTab: null, dailyPush: 0 };
  // 先去掉注释：每行里 // 或 # 之后的内容全部丢掉。默认值里就带一句「1=开 0=关」的提醒，
  // 不去注释的话「秒那项填秒数」这种说明文字会被当成配置项（含"秒"、没数字 → 误设成 1 秒）。
  const s = String(raw == null ? "" : raw)
    .split(/\n/).map((l) => l.replace(/(\/\/|#|＃).*$/, "")).join(" ").trim();
  if (!s) return out;                    // 整串留空 = 全不过滤（含前缀）
  // ⚠️ 非空配置串里**没写**「标签前缀」时按开处理。原因：Loon 会保留用户已存的参数值，
  //    往这个文本框里新加一项，老配置串永远"缺席"→ 新功能到不了老用户（2026-08-26 真机踩过：
  //    去广告/去直播都生效、唯独前缀不出来，就是老串里没有这一项）。前缀是纯展示、不删内容，
  //    缺席按默认（开）最合理；要关就显式写 标签前缀(0)。删卡类规则仍是"缺席=不删"，不擅自开。
  out.tagPrefix = true;
  s.split(/[\s,，、;；]+/).forEach((seg) => {
    if (!seg) return;
    const m = seg.match(/(\d+)/);          // 段里第一个数字就是取值
    const n = m ? parseInt(m[1], 10) : 1;  // 没写数字视为 1（开）
    if (seg.indexOf("广告") >= 0) out.ad = n > 0;
    else if (seg.indexOf("直播") >= 0) out.live = n > 0;
    else if (seg.indexOf("竖屏") >= 0 || /vertical/i.test(seg)) out.vertical = n > 0;
    else if (seg.indexOf("图文") >= 0) out.picture = n > 0;
    // 番剧/纪录片/电影/电视剧 = OGV(PGC) 整类，这四个词任一都认（见 isOgvCard 的说明）
    else if (seg.indexOf("番剧") >= 0 || seg.indexOf("纪录片") >= 0 || seg.indexOf("电影") >= 0
             || seg.indexOf("电视剧") >= 0 || /ogv|pgc|bangumi/i.test(seg)) out.ogv = n > 0;
    else if (seg.indexOf("顶栏") >= 0 || /tab/i.test(seg)) out.slimTab = n > 0;   // 三态：1/0/缺席(null)
    else if (seg.indexOf("推送") >= 0 || seg.indexOf("每天") >= 0) out.dailyPush = n > 0 ? n : 0;  // 每天投放几次，0=不启用
    else if (seg.indexOf("标签") >= 0 || seg.indexOf("前缀") >= 0) out.tagPrefix = n > 0;
    else if (seg.indexOf("秒") >= 0 || seg.indexOf("时长") >= 0) out.minDur = n > 0 ? n : 0;
  });
  return out;
}

// 判据全部来自 capture156 的原生 feed/index（column=4）实测：
//   广告   → card_type=cm_v2(card_goto=ad_av / ad_web_s / ad_live_v2) 与 banner_v8(card_goto=banner) 都属此类
//   直播   → card_goto/goto = "live"（card_type=small_cover_v9）
//   图文   → card_goto/goto = "picture"（card_type=small_cover_v2，B 站的图文动态卡）
//   竖屏   → goto = "vertical_av"（注意 card_goto 仍是 "av"，只看 card_goto 认不出来）
//   时长   → player_args.duration（秒）；直播/图文卡没有这个字段 → 视为 0 = 不按时长丢
//
// ⚠️【2026-08-29 capture176 字段变更】ad_info 不再等于"这张卡是广告"。
//    B 站现在给**自然卡**也挂一个 ad_info「广告位占位」对象——只有排期元数据、没有素材：
//      {resource, source, request_id, index, is_ad_loc:true, card_index, client_ip}
//    真广告的 ad_info 则额外带素材字段（is_ad / creative_id / ad_cb / creative_content /
//    cm_mark / creative_type / creative_style / extra，12KB+）。
//    老判据 `it.ad_info != null` 于是把占位当广告，**误杀正常视频/直播/图文卡**
//    （capture176 实测 4 份 feed 共误杀 7 张，且每次都是第 1 张——首位就是广告位）。
//    ⚠️ is_ad_loc 是"这个**位置**是广告位"，不是"这张**卡**是广告"，别拿它当判据。
//    ⚠️ 也不能只认 is_ad：capture176 里有真广告只给 creative_id 不给 is_ad（cm_v2/ad_web_s）。
//    改成只认「素材类字段」正向判定；banner_v8 两者都不给，仍靠下面 card_goto==="banner" 兜住。
//    全量回归（HTTP_Capture 下所有 HAR 共 134 张卡）：新旧判据仅在上述 7 张占位卡上有差异，
//    老抓包结果完全一致；且素材判据未多抓到任何 card_type/card_goto 漏掉的广告（它是纯兜底）。
const AD_CREATIVE_KEYS = ["is_ad", "creative_id", "ad_cb", "creative_content"];
function hasAdCreative(a) {
  if (!a || typeof a !== "object") return false;
  return AD_CREATIVE_KEYS.some((k) => a[k] != null && a[k] !== false);
}
function isAdCard(it) {
  if (!it) return false;
  if (hasAdCreative(it.ad_info)) return true;
  const cg = String(it.card_goto || ""), ct = String(it.card_type || "");
  return cg.indexOf("ad") === 0 || ct.indexOf("cm") === 0 || cg === "banner";
}
function isLiveCard(it) {
  return String((it && it.card_goto) || "") === "live" || String((it && it.goto) || "") === "live";
}
function isVerticalCard(it) {
  return /vertical/i.test(String((it && it.goto) || "") + "|" + String((it && it.card_goto) || ""));
}
function isPictureCard(it) {
  return String((it && it.card_goto) || "") === "picture" || String((it && it.goto) || "") === "picture";
}
// OGV = B 站的 PGC 内容：番剧 / 纪录片 / 电影 / 电视剧，`176_` 实测形如
//   card_type="ogv_small_cover"  card_goto="bangumi"  goto="bangumi"
//   args={up_id,up_name:"哔哩哔哩纪录片",aid,ip_id}  uri=".../bangumi/play/ep517745"
// ⚠️ 这类卡**没有 args.tname、也没有 player_args** → 标签前缀 / tag 屏蔽词 / 时长下限对它一概不生效，
//    所以在此之前它是唯一漏网的卡类（139 张卡的全量普查：av/广告/直播/图文/竖屏都有开关，只有它没有）。
// ⚠️ **无法只滤「纪录片」而放行「番剧」**：结构上只有 bangumi 这一个类别标记，子类型没有独立字段
//    （类别名只出现在 talk_back 这种无障碍朗读串里，靠它匹配太脆）。要精确到纪录片，用 homeBlockWords
//    写 up:哔哩哔哩纪录片 —— UP 名是实打实的字段，已在 cardTexts 里参与匹配。
function isOgvCard(it) {
  const cg = String((it && it.card_goto) || ""), g = String((it && it.goto) || "");
  const ct = String((it && it.card_type) || "");
  return cg === "bangumi" || g === "bangumi" || ct.indexOf("ogv") === 0;
}
function cardDuration(it) {
  const pa = (it && it.player_args) || {};
  return parseInt(pa.duration, 10) || 0;
}

// ===== 屏蔽词（[Argument] input 参数 homeBlockWords）=====
// 空格分隔多个词；默认「标题 / UP名 / 话题标签」三处任一命中即丢。可加前缀只匹配其中一处：
//   title:测评   只看标题（也认 标题:）
//   up:某某UP    只看 UP 名（也认 up主:）
//   tag:石头A30   只看话题标签（也认 标签:）
// 同样支持 // 与 # 注释；大小写不敏感；子串匹配（"抽奖"能命中"新春抽奖活动"）。
// ⚠️ 话题标签 = feed 卡片 args.tname，**一张卡只有一个**（不是视频详情页那种多标签），
//    抓包实测是话题/IP/活动名（爽文、杀戮尖塔2、石头A30Pro2.0），不是一级分区。
//    注意它与 toview（稍后再看）里的 tid/tname 不是一个体系——那边才是 17=单机游戏 这种分区。
function parseBlockWords(raw) {
  const out = { any: [], up: [], tag: [], title: [] };
  const s = String(raw == null ? "" : raw)
    .split(/\n/).map((l) => l.replace(/(\/\/|#|＃).*$/, "")).join(" ").trim();
  if (!s) return out;
  s.split(/[\s,，、;；]+/).forEach((seg) => {
    if (!seg) return;
    const m = seg.match(/^(up主|up|tag|标签|title|标题)[:：](.+)$/i);
    if (!m) { out.any.push(seg.toLowerCase()); return; }
    const k = m[1].toLowerCase(), w = m[2].trim().toLowerCase();
    if (!w) return;
    if (k === "up" || k === "up主") out.up.push(w);
    else if (k === "tag" || k === "标签") out.tag.push(w);
    else out.title.push(w);
  });
  return out;
}
const bwEmpty = (bw) => !bw || !(bw.any.length || bw.up.length || bw.tag.length || bw.title.length);

// ⚠️【2026-08-29 capture176 新增字段】translated_title / translated_status
//    本机 App locale=en，B 站现在会把中文标题机翻一份下发：
//      title="职业选手的大后期女娲到底有多恐怖？"
//      translated_title="How terrifying is a pro player's endgame Nuwa?"  translated_status="TRANSLATED"
//    （capture176 的 81 张卡里 22 张带；156/160 一张都没有 → 确认是新字段。）
//    App 显示的是译文，所以两处都得跟上：这里把译文并进标题干草堆（用户照屏幕上的英文写
//    屏蔽词也要能命中；原中文标题还在，中文词照旧命中），以及 injectTagPrefix 两个标题都要加前缀。
const TITLE_FIELDS = ["title", "translated_title"];
function cardTexts(it) {
  const a = (it && it.args) || {};
  const up = (it && it.up) || {};   // items.up 也是 176 新增，目前只在广告卡上见过，留作兜底
  return {
    title: TITLE_FIELDS.map((k) => String((it && it[k]) || "")).join("\n").toLowerCase(),
    up: String(a.up_name || up.name || (it && it.desc_button && it.desc_button.text) || "").toLowerCase(),
    tag: String(a.tname || "").toLowerCase(),
  };
}
function hitsBlockWords(it, bw) {
  if (bwEmpty(bw)) return false;
  const t = cardTexts(it);
  const has = (arr, hay) => arr.some((w) => hay.indexOf(w) >= 0);
  if (has(bw.title, t.title) || has(bw.up, t.up) || has(bw.tag, t.tag)) return true;
  return bw.any.length > 0 && (has(bw.any, t.title) || has(bw.any, t.up) || has(bw.any, t.tag));
}

// 标题前缀注入：「[话题] 原标题」，参考 XHSClean 的 injectTitlePrefix。
// 不截断（B 站标题本来就由服务端给定，App 自己会按行数截显示）；已带前缀的不重复加 →
// 「每天推送(n)次」缓存里存的是注入后的卡，冷启动回放会再过一次，靠这个判断保持幂等。
// ⚠️ title 与 translated_title 都要加：locale=en 时 App 渲染的是 translated_title，
//    只加 title 的话前缀在屏幕上根本不出现（见上方 TITLE_FIELDS 处的字段说明）。
function injectTagPrefix(items) {
  let n = 0;
  (items || []).forEach((it) => {
    const tag = it && it.args && it.args.tname;
    if (!tag || !it.title) return;
    const prefix = "[" + tag + "] ";
    let changed = false;
    TITLE_FIELDS.forEach((k) => {
      const v = it[k];
      if (typeof v !== "string" || !v) return;
      if (v.indexOf(prefix) === 0) return;  // 已带前缀 → 幂等跳过（缓存回放会再过一遍）
      it[k] = prefix + v;
      changed = true;
    });
    if (changed) n++;
  });
  return n;
}

// 按 homeFeedFilter 过滤一批原生卡片；返回 {items, dropped:{ad,live,vertical,dur}}
function filterNativeItems(items, ff, bw) {
  const anyRule = ff && (ff.ad || ff.live || ff.vertical || ff.picture || ff.ogv || ff.minDur || ff.tagPrefix);
  if (!Array.isArray(items) || (!anyRule && bwEmpty(bw))) {
    return { items: items || [], dropped: null };
  }
  const d = { ad: 0, live: 0, vertical: 0, picture: 0, ogv: 0, dur: 0, word: 0, tagged: 0 };
  const kept = items.filter((it) => {
    if (ff.ad && isAdCard(it)) { d.ad++; return false; }
    if (ff.live && isLiveCard(it)) { d.live++; return false; }
    if (ff.vertical && isVerticalCard(it)) { d.vertical++; return false; }
    if (ff.picture && isPictureCard(it)) { d.picture++; return false; }
    if (ff.ogv && isOgvCard(it)) { d.ogv++; return false; }
    if (ff.minDur > 0) { const sec = cardDuration(it); if (sec > 0 && sec < ff.minDur) { d.dur++; return false; } }
    if (hitsBlockWords(it, bw)) { d.word++; return false; } // ⚠️ 必须在注入前缀之前判，否则 title: 规则会撞上注入的 [话题]
    return true;
  });
  if (ff.tagPrefix) d.tagged = injectTagPrefix(kept);
  return { items: kept, dropped: d };
}
const ffLog = (d) => d ? ("广告" + d.ad + "/直播" + d.live + "/竖屏" + d.vertical + "/图文" + d.picture + "/番剧" + d.ogv + "/短片" + d.dur
  + "/屏蔽词" + d.word + "·加前缀" + d.tagged) : "未启用";

// —— 紧凑 md5（Joseph Myers 实现，UTF-8 安全）——
function md5(str) {
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function add(a, b) {
    const l = (a & 0xffff) + (b & 0xffff);
    return (((a >> 16) + (b >> 16) + (l >> 16)) << 16) | (l & 0xffff);
  }
  function cmn(q, a, b, x, s, t) { return add(rl(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function toBlocks(s) {
    const n = s.length, b = [];
    for (let i = 0; i < n * 8; i += 8) b[i >> 5] |= (s.charCodeAt(i / 8) & 0xff) << (i % 32);
    return b;
  }
  function utf8(s) {
    s = unescape(encodeURIComponent(s));
    return s;
  }
  function hex(num) {
    let s = "", j;
    for (j = 0; j <= 3; j++) s += ("0" + ((num >> (j * 8)) & 0xff).toString(16)).slice(-2);
    return s;
  }
  const s8 = utf8(str);
  const x = toBlocks(s8);
  const len = s8.length * 8;
  x[len >> 5] |= 0x80 << (len % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

// —— 解析 feed 请求 URL 的 query ——
function parseQuery(url) {
  const q = {};
  const i = url.indexOf("?");
  if (i < 0) return q;
  url.slice(i + 1).split("&").forEach((kv) => {
    const j = kv.indexOf("=");
    if (j < 0) return;
    const k = kv.slice(0, j);
    const v = kv.slice(j + 1);
    try { q[k] = decodeURIComponent(v); } catch (e) { q[k] = v; }
  });
  return q;
}

// —— 用 appsec 计算 sign，并产出可直接拼接的 query 串 ——
function signedQuery(params) {
  const keys = Object.keys(params).sort();
  const pairs = keys.map((k) => `${k}=${encodeURIComponent(params[k])}`);
  const sign = md5(pairs.join("&") + APPSEC);
  pairs.push(`sign=${sign}`);
  return pairs.join("&");
}

// —— 解析 toview 响应：先当明文 JSON，失败再尝试 ungzip ——
// 为何两条都留：Loon $httpClient 是否自动解 gzip 随版本而变。会解压 → 走 JSON.parse；不解压 → 走 ungzip。
// 删任一条都可能在另一种 Loon 上挂掉，这是廉价的防御性兜底（cap45 加的 ungzip 分支）。
function parseMaybeGzip(data) {
  if (data == null) return null;
  try { return JSON.parse(data); } catch (e) {}
  try {
    if (typeof $utils !== "undefined" && $utils.ungzip) {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      const out = $utils.ungzip(bytes);
      let str;
      if (typeof out === "string") {
        str = out;
      } else {
        let bin = "";
        for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
        try { str = decodeURIComponent(escape(bin)); } catch (e2) { str = bin; }
      }
      return JSON.parse(str);
    }
  } catch (e) {}
  return null;
}

// ===== 卡片「…」菜单的共享片段（两种卡共用，集中定义，不再各写一份）=====
const TOAST_DISLIKE = "将减少相似内容推荐";
const TOAST_FEEDBACK = "将优化首页此类内容";

// 反馈四项（与视频无关，固定）
const FEEDBACKS = [
  { id: 1, name: "恐怖血腥" }, { id: 2, name: "色情低俗" },
  { id: 3, name: "封面恶心" }, { id: 4, name: "标题党/封面党" },
].map((r) => ({ id: r.id, name: r.name, toast: TOAST_FEEDBACK }));

// 「我不想看」原因（含本视频 UP/频道，随条目即时生成 → 不留模板残值，省掉旧版的 fixReason 后处理）
function dislikeReasons(upName, tname, tid) {
  const list = [{ id: 4, name: "UP主:" + upName }];
  if (tname) {
    const r = { id: 3, name: "频道:" + tname };
    if (tid) r.extend = JSON.stringify({ tid: String(tid) });
    list.push(r);
  }
  list.push({ id: 12, name: "此类内容过多" }, { id: 13, name: "推荐过" }, { id: 1, name: "这个内容" });
  return list.map((r) => Object.assign({}, r, { toast: TOAST_DISLIKE }));
}

// three_point（v1 菜单数据）
function threePoint(upName, tname, tid) {
  return { dislike_reasons: dislikeReasons(upName, tname, tid), feedbacks: FEEDBACKS, watch_later: 1 };
}

// three_point_v2（新菜单数据）；small 卡首项多一个「添加至稍后再看」入口
const WATCH_LATER_ENTRY = {
  title: "添加至稍后再看", type: "watch_later",
  icon: "https://i0.hdslb.com/bfs/activity-plat/static/20240103/0977767b2e79d8ad0a36a731068a83d7/8VhmmUeWnO.png",
  icon_night: "https://i0.hdslb.com/bfs/activity-plat/static/20240103/0977767b2e79d8ad0a36a731068a83d7/eIyDu5U7GA.png",
};
function threePointV2(upName, tname, tid, withWatchLater) {
  const arr = [];
  if (withWatchLater) arr.push(WATCH_LATER_ENTRY);
  arr.push({ title: "反馈", subtitle: "（选择后将优化首页此类内容）", reasons: FEEDBACKS, type: "feedback" });
  arr.push({ title: "我不想看", subtitle: "（选择后将减少相似内容推荐）", reasons: dislikeReasons(upName, tname, tid), type: "dislike" });
  return arr;
}

// 封面四角文字（播放量 / 弹幕 / 时长），两种卡共用
function coverStats(views, danmaku, dur) {
  return {
    cover_left_text_1: views, cover_left_icon_1: 1, cover_left_1_content_description: views + "观看",
    cover_left_text_2: danmaku, cover_left_icon_2: 3, cover_left_2_content_description: danmaku + "弹幕",
    cover_right_text: dur, cover_right_content_description: dur,
  };
}

const REPORT_FLOW_DATA = '{"flow_card_type":"av","flow_source":"query_content"}';

// ===== 大卡（large_cover_single_v9）专属静态资源块（图标 / 动画 / 进度条 URL 为通用静态件，照抓包，不随视频变）=====
const ICON_BTN = "https://i0.hdslb.com/bfs/activity-plat/static/ce06d65bc0a8d8aa2a463747ce2a4752/";
const FUNCTIONAL_BUTTONS = [
  { type: 1, button_metas: [{ icon: ICON_BTN + "lJVNJwZCfW.png", text: "我不想看" }] },
  { type: 2, button_metas: [{ icon: ICON_BTN + "NyPAqcn0QF.png", text: "稍后再看" }] },
  { type: 3, button_metas: [
    { icon: ICON_BTN + "1gIJ91DqKx.png", text: "收藏", button_status: "collect" },
    { icon: ICON_BTN + "MqCrPs0cNW.png", text: "收藏", button_status: "collected" },
  ] },
  { type: 4, button_metas: [
    { icon: ICON_BTN + "TVoxpmCjvd.png", text: "倍速播放", button_status: "0.5x" },
    { icon: ICON_BTN + "gRhcAhjuAN.png", text: "倍速播放", button_status: "0.75x" },
    { icon: ICON_BTN + "3cjWGnLzWt.png", text: "倍速播放", button_status: "1.0x" },
    { icon: ICON_BTN + "qlwZFJfB9L.png", text: "倍速播放", button_status: "1.25x" },
    { icon: ICON_BTN + "G9vdWrFHmt.png", text: "倍速播放", button_status: "1.5x" },
    { icon: ICON_BTN + "shm60E8ATG.png", text: "倍速播放", button_status: "2.0x" },
  ] },
  { type: 5, button_metas: [{ icon: ICON_BTN + "fPIoe4K0dA.png", text: "自动播放" }] },
];
const LIKE_RESOURCES = {
  like_resource: { url: "https://i0.hdslb.com/bfs/archive/b9f49c9b33532c5d05f5ea701ecd063f81910e94.json", content_hash: "c8b42c2a76890e703b15874175268b4b" },
  dislike_resource: { url: "https://i0.hdslb.com/bfs/archive/8aee6952487d118b4207c1afa2fd38616bd7545a.json", content_hash: "bdbc35ebc88d178d1f409145dadec806" },
  like_night_resource: { url: "https://i0.hdslb.com/bfs/archive/3ed718f59e9e9cf1ce148105c9db9559951d5a7d.json", content_hash: "bc9fecf2624a569c05cef8097e20eb37" },
  dislike_night_resource: { url: "https://i0.hdslb.com/bfs/archive/c9a20055b712068bfe293878639dc9066ba2690b.json", content_hash: "c370e8d031381f4716d7564956a8b182" },
};
const SHARE_TO = { copy: true, dynamic: true, im: true, more: true, qq: true, qzone: true, wechat: true, wechatmonment: true, weibo: true };
const INLINE_PROGRESS_BAR = {
  icon_drag: "https://i0.hdslb.com/bfs/archive/c1461e2c6ca97783ac0298b6ebb2d85d94b8f37c.json", icon_drag_hash: "31df8ce99de871afaa66a7a78f44deec",
  icon_stop: "https://i0.hdslb.com/bfs/archive/6ee2f9b016f20714705cb5b8f15da1446587d172.json", icon_stop_hash: "5648c2926c1c93eb2d30748994ba7b96",
};

// 从 toview 一条记录抽出构卡要用的公共字段
function pick(it) {
  const owner = it.owner || {};
  const stat = it.stat || {};
  return {
    aid: it.aid,
    cid: it.cid || (it.page && it.page.cid) || 0,
    upName: owner.name || "",
    upMid: owner.mid || 0,
    upFace: owner.face || "",
    tid: it.tid || 0,
    tname: it.tname || "",
    bvid: it.bvid || "",
    title: it.title || "",
    cover: it.pic || it.cover43 || "",
    views: it.view_text_1 || it.left_text || fmtCount(stat.view),
    danmaku: it.right_text || fmtCount(stat.danmaku),
    dur: fmtDuration(it.duration),
    duration: it.duration || 0,
    like: stat.like || 0,
    pubdate: it.pubdate,
  };
}

// 分发：双列出 small_cover_v2，单列出 large_cover_single_v9
function toCard(it, idx, isDouble) {
  return isDouble ? toSmallCard(it, idx) : toLargeCard(it, idx);
}

// —— 单列大卡（large_cover_single_v9）：带 avatar / like_button / share_plane / functional_buttons，显示 UP 名 + 发布日期 ——
function toLargeCard(it, idx) {
  const v = pick(it);
  const dateStr = fmtDate(v.pubdate);
  const descTxt = dateStr ? v.upName + " · " + dateStr : v.upName;
  return Object.assign({
    card_type: "large_cover_single_v9", card_goto: "av", goto: "av",
    param: String(v.aid), cover: v.cover, title: v.title,
    uri: "bilibili://video/" + v.aid + "?cid=" + v.cid, track_id: "",
    three_point: threePoint(v.upName, v.tname, v.tid),
    args: { up_id: v.upMid, up_name: v.upName, tid: v.tid, tname: v.tname, aid: v.aid, ip_id: 1 },
    player_args: { aid: v.aid, cid: v.cid, type: "av", duration: v.duration, hide_play_button: true, report_history: 1, report_required_play_duration: 10, report_required_time: 10 },
    up_args: { up_id: v.upMid, up_name: v.upName, up_face: v.upFace },
    idx: idx, // 绝对序号，作为下拉加载的分页游标
    three_point_v2: threePointV2(v.upName, v.tname, v.tid, false),
    three_point_meta: { panel_type: 1, share_origin: "tm_inline", share_id: "tm.recommend.ugc.0", functional_buttons: FUNCTIONAL_BUTTONS },
    talk_back: ["视频", v.title, v.views + "观看", v.danmaku + "弹幕", descTxt].join(","),
    report_flow_data: REPORT_FLOW_DATA, three_point_v: "v5",
    dislike_info: JSON.stringify({ feedback_type: 2, ip_id: v.tid, ip_content: v.tname }),
    avatar: { cover: v.upFace, text: v.upName, uri: v.upMid ? "bilibili://space/" + v.upMid : "", event: "up_click", event_v2: "up-click", up_id: v.upMid },
    can_play: 1,
    like_button: Object.assign({ aid: v.aid, count: v.like, show_count: true, event: "like_click", event_v2: "button" }, LIKE_RESOURCES),
    share_plane: { title: v.title, cover: v.cover, aid: v.aid, bvid: v.bvid, share_to: SHARE_TO, author: v.upName, author_id: v.upMid, short_link: v.bvid ? "https://b23.tv/" + v.bvid : "https://b23.tv/av" + v.aid, play_number: v.views + "次", cid: v.cid },
    inline_progress_bar: INLINE_PROGRESS_BAR,
    desc: descTxt,
    multiply_desc: { author_name: v.upName, extra: dateStr ? " · " + dateStr : "" },
  }, coverStats(v.views, v.danmaku, v.dur));
}

// —— 双列小卡（small_cover_v2）：字段更少，无 avatar/like_button/share_plane，UP 名走 desc_button，双列卡原生不显示发布日期 ——
function toSmallCard(it, idx) {
  const v = pick(it);
  return Object.assign({
    card_type: "small_cover_v2", card_goto: "av", goto: "av",
    param: String(v.aid), cover: v.cover, title: v.title,
    uri: "bilibili://video/" + v.aid + "?cid=" + v.cid, track_id: "",
    three_point: threePoint(v.upName, v.tname, v.tid),
    args: { up_id: v.upMid, up_name: v.upName, tid: v.tid, tname: v.tname, aid: v.aid, ip_id: 1 },
    player_args: { aid: v.aid, cid: v.cid, type: "av", duration: v.duration },
    idx: idx,
    three_point_v2: threePointV2(v.upName, v.tname, v.tid, true),
    report_flow_data: REPORT_FLOW_DATA, three_point_v: "v5",
    dislike_info: JSON.stringify({ feedback_type: 2, ip_id: v.tid, ip_content: v.tname }),
    desc_button: { text: v.upName, uri: v.upMid ? "bilibili://space/" + v.upMid : "", event: "nickname", type: 1 },
    can_play: 1, cover_info_priority: 123,
    talk_back: ["视频", v.title, v.views + "观看", v.danmaku + "弹幕", "UP主" + v.upName, ""].join(","),
  }, coverStats(v.views, v.danmaku, v.dur));
}

function fmtDuration(sec) {
  sec = parseInt(sec, 10) || 0;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${s < 10 ? "0" + s : s}`;
}

// 时间戳 → "M月D日"（今年）/ "YYYY年M月D日"（往年）
function fmtDate(ts) {
  ts = parseInt(ts, 10);
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const m = d.getMonth() + 1, day = d.getDate();
  if (d.getFullYear() === new Date().getFullYear()) return m + "月" + day + "日";
  return d.getFullYear() + "年" + m + "月" + day + "日";
}

// 数字 → "x.x万"
function fmtCount(n) {
  n = parseInt(n, 10) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  return String(n);
}

// —— 组装最终 feed 响应壳 ——
function buildFeed(items, config) {
  const data = { items };
  if (config) data.config = config;
  return JSON.stringify({ code: 0, message: "OK", ttl: 1, data });
}

// —— 原地洗牌（Fisher-Yates），用于稍后再看随机排列 ——
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// —— 从缓存的原始 toview list 切一页并按列数构卡 ——
// start 为绝对偏移；卡 idx = IDX_BASE - 全局序号（递减，与真实 feed 同序，作为下拉加载游标）。
function buildPage(rawList, start, isDouble) {
  return rawList.slice(start, start + PAGE_SIZE).map((it, i) => toCard(it, IDX_BASE - (start + i), isDouble));
}

// —— tab/v2：右上角入口/底栏恒改；顶栏 tab 是否折叠见 shouldSlimTab、折叠后叫什么名随模式 ——
// ⚠️ 本脚本是 tab/v2 的【唯一】处理者：Loon 同 URL「最后一个脚本整体覆盖、各自读原始响应」(§13b)，
//    多脚本各改一部分会互相吞掉 → 故把 data.top 入口 + data.bottom 精简 + 删 top_more（恒改）
//    与 data.tab 折叠（受模式）全收进本函数一次性产出（原 BilibiliTabFeed.js 已删除，逻辑并入此处）。
//    模式与过滤参数经 [Script] 的 argument=[{homeShow},{homeFeedFilter}] 传入 → $argument。
//    data.tab：默认信息流 = 整档不动；其余档按 shouldSlimTab 决定，折叠后的名字见 TAB_NAME_BY_MODE。
const TAB_FAV_URI = "bilibili://main/favorite";             // 收藏夹（原生页 deeplink）
const TAB_LATER_URI = "bilibili://user_center/watch_later"; // 稍后再看（原生页 deeplink）
const TAB_ICON_FAV = "http://i0.hdslb.com/bfs/archive/d79b19d983067a1b91614e830a7100c05204a821.png";
const TAB_ICON_LATER = "http://i0.hdslb.com/bfs/archive/63bb768caa02a68cb566a838f6f2415f0d1d02d6.png";
const TAB_BOTTOM_KEEP = ["main/home", "following/home", "user_center"]; // 底栏只留 首页/动态/我的
// 折叠后的单 tab 叫什么（MODE_FILTER 不在表里 → 折叠但不改名，因为它本来就是「推荐」tab、名副其实）
const TAB_NAME_BY_MODE = {
  [MODE_LATER_RANDOM]: "稍后再看",
  [MODE_LATER]: "稍后再看",
  [MODE_BLANK]: "首页", // 内容为空，同上
};
// 顶栏是否折叠成单 tab：「默认信息流」档整档不生效；其余档看 homeFeedFilter 的「精简顶栏」三态 ——
// 1 强制折叠、0 强制保留原生 tab、缺席(null) 按模式（稍后再看/空白 折叠，过滤信息流 不折叠）。
// ⚠️ 缺席不敢按「开」处理：折叠是删东西，老配置串里没这一项的用户会突然丢掉热门/直播/追番等 tab。
//    （与「标签前缀」缺席=开的取舍不同，因为那个是纯展示、不删内容。）
function shouldSlimTab(mode, ff) {
  if (mode === MODE_OFF) return false;                 // 默认信息流：这一档什么都不改，「精简顶栏」也不生效
  if (ff && ff.slimTab !== null && ff.slimTab !== undefined) return ff.slimTab;
  return mode !== MODE_FILTER;                         // 缺席：稍后再看/空白 折叠；过滤信息流 不折叠（沿用老行为）
}
function handleTab() {
  let body = $response.body;
  try {
    const obj = JSON.parse(body);
    const data = obj && obj.data;
    if (data) {
      // 顶栏 data.tab：是否折叠成单 tab 见 shouldSlimTab（模式 + homeFeedFilter 的「精简顶栏」）
      const mode = parseHomeMode();
      const slim = shouldSlimTab(mode, parseFeedFilter(getArgRaw("homeFeedFilter")));
      if (slim && Array.isArray(data.tab) && data.tab.length) {
        const n0 = data.tab.length;
        let kept = data.tab.filter((t) => ((t && t.uri) || "").indexOf("pegasus/promo") >= 0);
        if (!kept.length) kept = [data.tab[0]]; // 容错：没匹配到就留第一个，免得顶栏空掉被 App 回退成默认全栏
        const tabName = TAB_NAME_BY_MODE[mode];
        if (tabName) kept[0].name = tabName;    // 原生档不改名：它本来就是「推荐」
        kept[0].default_selected = 1;
        data.tab = [kept[0]]; // ⚠️ 必须是数组！赋单个对象 App 会判无效、保留原生 tab（踩过的坑）
        LOG("tab 顶栏折叠 " + n0 + "->1 名=" + kept[0].name);
      } else if (!slim) {
        LOG("tab 顶栏保留原生 " + ((data.tab || []).length) + " 个");
      }
      // 右上角 data.top：保留「消息」，加 收藏夹 + 稍后再看入口（点击跳转原生页，零白屏）—— 恒改
      const msg = (Array.isArray(data.top) ? data.top : []).filter(
        (t) => ((t && t.uri) || "").indexOf("im_home") >= 0
      );
      data.top = [
        ...msg,
        { id: 900001, icon: TAB_ICON_FAV, name: "收藏夹", uri: TAB_FAV_URI, tab_id: "custom_fav", pos: 90 },
        { id: 900002, icon: TAB_ICON_LATER, name: "稍后再看", uri: TAB_LATER_URI, tab_id: "custom_later", pos: 91 },
      ];
      // 底栏 data.bottom：只保留 首页/动态/我的
      if (Array.isArray(data.bottom)) {
        data.bottom = data.bottom.filter((t) => TAB_BOTTOM_KEEP.some((k) => ((t && t.uri) || "").indexOf(k) >= 0));
      }
      delete data.top_more; // 去掉右上角「…」更多菜单
    }
    body = JSON.stringify(obj);
  } catch (e) {
    body = $response.body; // 解析失败原样返回，别影响 App
  }
  $done({ body });
}

// —— 主流程 ——
(function main() {
  const url = $request.url;

  // tab/v2 请求走 tab 改写分支（与 feed/index 共用本脚本，按 URL 分流）
  if (/\/x\/resource\/show\/tab\/v2/.test(url)) {
    handleTab();
    return;
  }

  // 模式经 feed/index 那条 [Script] 的 argument=[{homeShow},…] 传入。
  // ⚠️ 那条 [Script] 不能用 enable={homeShow} 门控：enable= 只认 true/false，select 给的是中文档名
  //    → 每一档都会被判成 false、脚本永不执行。故恒开、脚本内自己分流，「默认信息流」在这里原样放行。
  const mode = parseHomeMode();
  if (mode === MODE_OFF) {          // 默认信息流：完全不动 B 站的东西，两个过滤参数一概不生效
    LOG("mode=默认信息流·原样放行");
    $done({});
    return;
  }
  const ff = parseFeedFilter(getArgRaw("homeFeedFilter"));
  const bw = parseBlockWords(getArgRaw("homeBlockWords"));
  if (mode === MODE_FILTER) {
    // 「每天推送(n)次」：原生流的投放节奏，n>0 时接管本档（含过滤，见 handleDaily）
    if (ff.dailyPush > 0) {
      const q0 = parseQuery(url);
      let cfg0 = null;
      try { const o = JSON.parse($response.body); if (o && o.data && o.data.config) cfg0 = o.data.config; } catch (e) {}
      const c0 = parseInt(q0.column, 10);
      handleDaily(q0, c0 === 2 || c0 === 4, cfg0, ff, bw);
      return;
    }
    // 全不过滤 → 零成本放行；否则只删卡、其余原样（不动 config/顺序）
    if (!ff.ad && !ff.live && !ff.vertical && !ff.picture && !ff.ogv && !ff.minDur && !ff.tagPrefix && bwEmpty(bw)) {
      LOG("mode=过滤信息流·各项均未启用·原样放行");
      $done({});
      return;
    }
    try {
      const orig = JSON.parse($response.body);
      const items = orig && orig.data && Array.isArray(orig.data.items) ? orig.data.items : null;
      if (items) {
        const f = filterNativeItems(items, ff, bw);
        LOG("mode=过滤信息流·过滤 " + items.length + "->" + f.items.length + "·丢弃" + ffLog(f.dropped));
        orig.data.items = f.items;
        $done({ body: JSON.stringify(orig) });
        return;
      }
    } catch (e) {
      LOG("mode=过滤信息流·响应解析失败·原样放行");
    }
    $done({});
    return;
  }

  const q = parseQuery(url);

  // 保留原 feed 的 config（feed/index 响应是明文 JSON，可直接 parse；上游若已清空则没有，可接受）
  let config = null;
  try {
    const orig = JSON.parse($response.body);
    if (orig && orig.data && orig.data.config) config = orig.data.config;
  } catch (e) {}

  // 首页列数：column=4(或旧版 2)=双列 → small_cover_v2；column=3/1/缺省=单列 → large_cover_single_v9
  const col = parseInt(q.column, 10);
  const isDouble = (col === 2 || col === 4);

  if (mode === MODE_BLANK) {
    LOG("mode=空白界面·返回空 items·col=" + col);
    $done({ body: buildFeed([], config) });
    return;
  }

  // —— 以下是「稍后再看」两档（随机档每次刷新洗牌）——
  const randomOn = (mode === MODE_LATER_RANDOM);

  // 刷新 vs 加载更多：靠 pull 参数判定（capture60 实测：下拉刷新 pull=1，上滑加载更多 pull=0）。
  // 不能用 App 回传的 idx 当游标——它恒为首屏顶部卡的 idx、永不前进（见文件头说明）。
  const isLoadMore = q.pull === "0";

  // 下拉加载更多：从缓存（原始 list）按自维护游标切下一页，不重新请求 toview；游标随之后移。
  if (isLoadMore) {
    const all = readCache();
    const start = readOffset();
    const page = buildPage(all, start, isDouble);
    writeOffset(start + PAGE_SIZE); // 推进游标；到底后 page 为空 → App 停止加载
    LOG("load-more start=" + start + " col=" + col + " 缓存共" + all.length + " 返回" + page.length + "条");
    $done({ body: buildFeed(page, config) });
    return;
  }

  const accessKey = q.access_key;
  if (!accessKey) {
    LOG("无 access_key（未登录？）→ 回退缓存/空");
    fallbackAndDone(config, isDouble);
    return;
  }

  // 复用 feed 请求里的公共参数构造 toview 请求
  const now = Math.floor(Date.now() / 1000);
  const p = {
    access_key: accessKey,
    actionKey: "appkey",
    appkey: APPKEY,
    asc: "false",
    build: q.build || "89801100",
    c_locale: q.c_locale || "zh-Hans_CN",
    channel: q.channel || "bili",
    device: q.device || "phone",
    disable_rcmd: q.disable_rcmd || "0",
    mobi_app: q.mobi_app || "iphone",
    platform: q.platform || "ios",
    ps: "100", // 一次最多取 100 条（实测接口认；不足则返回全部）
    s_locale: q.s_locale || "zh-Hans_CN",
    sort_field: "1",
    split_key: "",
    start_key: "",
    statistics: q.statistics || '{"appId":1,"platform":1,"version":"8.98.1"}',
    ts: String(now),
  };
  // ⚠️ 必须用 api.bilibili.com（App 真实请求的 :authority）；app.bilibili.com 无此路由 → 404 page not found
  const toviewUrl =
    "https://api.bilibili.com/x/v2/history/toview/v2/list?" + signedQuery(p);

  const ua = $request.headers
    ? $request.headers["User-Agent"] || $request.headers["user-agent"] || "bili-universal/89801100"
    : "bili-universal/89801100";
  // ⚠️ 不手动设 Accept-Encoding：实测设了会让 Loon $httpClient 请求发不出去（pre-flight 挂）。
  //    gzip 响应交给下方 parseMaybeGzip 用 $utils.ungzip 兜底解压。
  const req = { url: toviewUrl, headers: { "User-Agent": ua } };

  LOG("发起 toview 子请求 …");
  $httpClient.get(req, (err, resp, data) => {
    try {
      if (err) { LOG("toview 请求失败 err=" + err); fallbackAndDone(config, isDouble); return; }
      const ce = resp && resp.headers ? (resp.headers["Content-Encoding"] || resp.headers["content-encoding"] || "") : "";
      const head = typeof data === "string" ? data.slice(0, 24) : ("[" + typeof data + "]");
      LOG("toview 收到 status=" + (resp && resp.status) + " ce=" + ce + " len=" + (data ? data.length : 0) + " head=" + JSON.stringify(head));
      const j = parseMaybeGzip(data);
      if (!j) { LOG("toview 响应解析失败（ungzip 也失败）"); fallbackAndDone(config, isDouble); return; }
      if (j.code !== 0 || !j.data || !Array.isArray(j.data.list)) {
        LOG("toview 返回异常 code=" + j.code + " msg=" + j.message);
        fallbackAndDone(config, isDouble);
        return;
      }
      // 缓存原始 list（构卡延迟到出页时按列数决定），首屏返回前 PAGE_SIZE 条
      const raw = j.data.list;
      // 随机排列（「稍后再看（随机）」档）：只在刷新这一刻洗一次牌并存进缓存，
      // 之后翻页读的是同一份已洗序 → 不重复/不漏；每次下拉刷新重新进到这里 = 重洗。
      if (randomOn) shuffle(raw);
      LOG("注入稍后再看 共" + raw.length + "条 col=" + col + " 首屏" + Math.min(PAGE_SIZE, raw.length) + "条 双列=" + isDouble + " 随机=" + randomOn);
      try { $persistentStore.write(JSON.stringify(raw), CACHE_KEY); } catch (e) {}
      writeOffset(PAGE_SIZE); // 刷新后游标归位到第二页起点，供后续 pull=0 加载更多
      $done({ body: buildFeed(buildPage(raw, 0, isDouble), config) });
    } catch (e) {
      LOG("解析 toview 失败", e);
      fallbackAndDone(config, isDouble);
    }
  });
})();

function readCache() {
  try {
    const cached = $persistentStore.read(CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (e) {}
  return [];
}

// 分页游标读写（脚本自维护，刷新归位到 PAGE_SIZE、每加载一页 +PAGE_SIZE）
function readOffset() {
  try {
    const v = parseInt($persistentStore.read(OFFSET_KEY), 10);
    if (!isNaN(v) && v >= 0) return v;
  } catch (e) {}
  return PAGE_SIZE; // 没游标时（如冷启直接上滑）从第二页起，避免重复首屏
}
function writeOffset(n) {
  try { $persistentStore.write(String(n), OFFSET_KEY); } catch (e) {}
}

// ===== 「每天推送(n)次」（homeFeedFilter 里的一项，n>0 时接管「过滤信息流」档）=====
// 规则：一天最多投放 n 屏原生内容，每屏**只在 App 冷启动那一帧**给；会话内刷新/加载更多一律给空。
//   1. 冷启动 且 当天已投放次数 < n → 放行 B 站原生推荐（过滤后存下来），计数 +1。
//      （当天一次都还没投过时，会话内刷新也放行——跨零点后 App 一直开着的情况。）
//   2. 配额用完 + 冷启动 → **回放**最后那一屏（此时 App 列表是空的，回放是"填满"）。
//   3. 配额用完 + 会话内刷新 / 任何加载更多 → 返回空 items。
//   4. 跨天（设备本地日期变化）自动重置计数。
//   ⇒ n=1 就是原来的「每天1次推送」；n=3 大致是「一天开三次 App、每次给一屏」。
//   2026-08-26 由 homeShow 的独立档位改成这里的一项：它本质是原生流的投放节奏，
//   和 homeFeedFilter 其余各项作用范围一致（都只在「过滤信息流」档生效）。
//
// ⚠️ 两次真机 bug 都出在这里，判据全靠下面这条抓包结论（cap56/58/60/66/68/71/72，14 条 feed/index）：
//    | 请求         | open_event | pull | idx            |
//    | 冷启动首帧   | cold       | 1    | 0              |
//    | 刷新(含自动) | 无         | 1    | 它手里最大 idx |
//    | 加载更多     | 无         | 0    | 它手里最大 idx |
//    ① 初版「当天之后的刷新回放缓存」→ **同一批视频出现两遍**（"多次下拉还是只有 2 次同样的列表"）：
//       App 对**会话内刷新**的响应是**追加**语义，回放被当成新一页拼在了列表后面。
//    ② 改成「一律返回空」→ **整档完全加载不出来**：App 冷启动后手里什么都没有，全给空 = 空白页。
//    ⇒ 正解是按 open_event 分流：冷启动＝App 手里是空的，回放不会重复；刷新才是会追加的那种，给空。
//
// 单/双列：卡型由服务器按请求的 column 下发，缓存的卡塞进另一种列数渲染不出来（整页空白，§14 双列坑）
//          → 状态里记 dbl，中途切列数就重投并按新列数存，但**不计次**（同一天内容的重新排版）。
// 空/异常响应不消耗当天配额（不写缓存），免得因为一次网络抖动把首页锁死一整天。
// LOG 里带 pull/idx/open：要复查 App 到底发了几次、各是什么请求，直接看 Loon 日志的 [HWL] 行即可。
function todayStamp() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

// 冷启动判据：以 open_event=cold 为准（当前 build 必带）。万一日后 build 不再下发 open_event，
// 才退回用 idx 判——14 条抓包里 idx=0 只出现在冷启动那几条，会话内请求都带着它手里的最大 idx。
function isColdStart(q) {
  if (q.open_event != null) return /cold/i.test(q.open_event);
  return q.pull !== "0" && !parseInt(q.idx, 10);
}

// 这一档当天不会再有新内容 → 关掉 App 的自动刷新（真实 config：auto_refresh_time=1200、
// auto_refresh_time_by_appear=1800、…_by_biz），省得它每 20/30 分钟白跑一次请求；
// 同时清掉 toast，免得弹「发现N条新内容」而实际什么也没来。
function dailyConfig(config) {
  if (!config) return config;
  const c = Object.assign({}, config);
  Object.keys(c).forEach((k) => { if (k.indexOf("auto_refresh_time") === 0) c[k] = 86400; });
  if (c.toast) c.toast = {};
  return c;
}

function handleDaily(q, isDouble, config, ff, bw) {
  const N = ff.dailyPush;                       // 每天允许投放几次
  const today = todayStamp();
  let st = null;
  try { const raw = $persistentStore.read(DAILY_KEY); if (raw) st = JSON.parse(raw); } catch (e) {}
  if (!st || st.date !== today) st = { date: today, dbl: isDouble, n: 0, items: [] };
  const cold = isColdStart(q);
  const colChanged = st.n > 0 && st.dbl !== isDouble;   // 中途切了单/双列：缓存的卡型对不上，得重投
  const trace = "·pull=" + q.pull + "·open=" + q.open_event + "·双列=" + isDouble
    + "·今日" + st.n + "/" + N + "次";

  // 加载更多永远给空：它是半截内容，不配当「一屏」，也不能回放（回放会被 App 追加成重复）
  if (q.pull === "0") {
    LOG("daily 加载更多返回空" + trace);
    $done({ body: buildFeed([], dailyConfig(config)) });
    return;
  }

  // 该不该投放新的一屏：冷启动且配额没用完 / 当天一次都还没投过（跨零点后的会话内刷新）/ 切了列数
  const push = colChanged || st.n === 0 || (cold && st.n < N);
  if (push) {
    try {
      const orig = JSON.parse($response.body);
      const raw0 = orig && orig.data && Array.isArray(orig.data.items) ? orig.data.items : null;
      const f0 = filterNativeItems(raw0, ff, bw);   // 先过滤，缓存里存的就是干净的
      if (raw0 && f0.items.length) {
        // 切列数导致的重投不消耗配额：它是同一天内容的重新排版，不是新的一次推送
        if (!colChanged) st.n += 1;
        st.dbl = isDouble; st.items = f0.items;
        try { $persistentStore.write(JSON.stringify(st), DAILY_KEY); } catch (e) {}
        LOG("daily 投放第" + st.n + "屏·" + raw0.length + "->" + f0.items.length + "条·丢弃" + ffLog(f0.dropped)
          + (colChanged ? "·(切列数重投不计次)" : "") + trace);
        orig.data.items = f0.items;
        orig.data.config = dailyConfig(orig.data.config);
        $done({ body: JSON.stringify(orig) });
        return;
      }
      LOG("daily 响应无 items·原样放行·不消耗配额" + trace);   // 网络抖动不该把首页锁死一整天
    } catch (e) {
      LOG("daily 响应解析失败·原样放行·不消耗配额" + trace);
    }
    $done({});
    return;
  }

  // 配额用完：冷启动回放最后那一屏（此时 App 手里是空的，回放是「填满」不会重复）
  if (cold && st.items.length) {
    const fr = filterNativeItems(st.items, ff, bw);  // 再过一遍：中途改了参数也立刻生效
    LOG("daily 配额已满·冷启动回放" + st.items.length + "->" + fr.items.length + "条" + trace);
    $done({ body: buildFeed(fr.items, dailyConfig(config)) });
    return;
  }
  // 会话内刷新：给空，绝不能回放（会被追加 → 重复）
  LOG("daily 配额已满·会话内刷新返回空" + trace);
  $done({ body: buildFeed([], dailyConfig(config)) });
}

function fallbackAndDone(config, isDouble) {
  // 拉取失败时用上次缓存（原始 list）的首屏（前 PAGE_SIZE 条）按当前列数构卡
  writeOffset(PAGE_SIZE); // 同刷新：游标归位到第二页起点
  $done({ body: buildFeed(buildPage(readCache(), 0, isDouble), config) });
}
