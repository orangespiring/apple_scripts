// XHSClean.js — XiaoHongShu QX script  @orangespiring
// ============================================================================
//  用户可维护配置（改这里即可，无需动下方逻辑）
// ============================================================================

// 【分类黑名单】recommend.category_name 命中即隐藏。
// 现由 Loon 插件设置「首页屏蔽分类」(input 参数 blockCategories) 注入，多个分类用【空格】分隔：
//   • 未接入参数（非 Loon，或 [Script] 行没写 argument=）→ 回退 DEFAULT_BLOCK_CATEGORIES；
//   • 设置里留空 → 空数组 = 不按分类过滤。
// ⚠️ 别在文本框里用逗号：逗号是 Loon 配置行的选项分隔符，值里带逗号会把整行截断/作废，
//    导致这条响应脚本根本不加载（首页过滤静默失效，照样刷到被屏蔽分类）。
// 分类名见 XIAOHONGSHU_REFERENCE.md 的 29 类映射表（非全集，新分类按需补）。
//
// ⚠️ 多参数传递坑（曾用 `argument=[{blockCategories}]##[{dailyLimit}]` 自造分隔符，实测
//    dailyLimit 改了也不生效，一直按默认 100 算）：Loon 官方文档给的标准写法是单个方括号内
//    用逗号分隔多个 `{name}`，即 `argument=[{a},{b}]`，脚本侧按 `$argument.a`/`$argument.b`
//    取值（$argument 本身就是按参数名映射的对象，不是字符串）。改回这个标准写法后才正常。
var DEFAULT_BLOCK_CATEGORIES = ['科技数码', '二次元', '娱乐', '资讯', '汽车', '游戏', '人文', '职场', '商业财经'];
var BLOCK_CATEGORIES = parseBlockCategories();

// 按参数名从 $argument 取原始值；非对象（非 Loon/未传参）时返回 null，由各 parse* 函数回退默认。
function getArgRaw(name) {
  var raw = (typeof $argument !== 'undefined') ? $argument : null;
  if (raw == null) return null;
  if (typeof raw === 'object') return raw[name];
  try {                                          // 极少数环境 $argument 是 JSON 字符串，兜底解析
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed[name] : null;
  } catch (e) { return null; }
}

function parseBlockCategories() {
  var raw = getArgRaw('blockCategories');
  if (raw == null) return DEFAULT_BLOCK_CATEGORIES;       // 未接入参数 → 回退默认
  raw = String(raw).trim();
  if (!raw) return [];                                    // 显式留空 = 不过滤
  // 空格/逗号/顿号/竖线均可分隔（推荐空格；逗号仅作兜底，正常配置里不该出现）
  return raw.split(/[\s,，、|]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// 按参数名取 Loon switch 开关值；未接入参数（非 Loon/没在该 [Script] 行的 argument= 里
// 列出这个名字）时回退 defaultValue。容错 $argument 给的是布尔/字符串/"1"/"0" 任意形式。
function parseSwitch(name, defaultValue) {
  var raw = getArgRaw(name);
  if (raw == null) return defaultValue;
  if (typeof raw === 'boolean') return raw;
  var s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultValue;
}

// 【是否过滤视频帖】true = 首页只看图文，删掉所有 type==='video'
// 现由 Loon [Argument] switch 参数 filterVideo 注入（默认开）。
var FILTER_VIDEO = parseSwitch('filterVideo', true);

// 【首页「热点」/「直播」卡片】四值，由 Loon [Argument] select 参数 blockFeedCards 注入
// （默认「热点和直播都关」）：热点和直播都关 / 只关直播 / 只关热点 / 都不关。
// 这两种是混在信息流里的非笔记卡片，跟 type==='video'（视频笔记）是两回事，各管各的。
//
//   直播卡片：⭐抓包实证（127_1785938280570）—— `type:"live"` + `model_type:"live_v2"`，
//             整条只有 {cursor_score,dislike_optional,is_ads,is_tracking,live,model_type,
//             recommend,track_id_mix_rank,type}，没有 id/display_title，是纯卡片不是笔记。
//   热点卡片：⚠️**未经抓包实证** —— 现有四份抓包里一次都没出现过热点卡片，
//             判据是照着直播卡的命名规律猜的（type/model_type 里含 hot/trend）。
//             如果实测没生效，去 Loon 日志里找下面 logUnknownCard() 打出的
//             「[XHS] 未识别卡片」行，把 type/model_type 告诉我，改成精确匹配。
var CARD_BLOCK = parseFeedCardMode();
var BLOCK_LIVE_CARD = CARD_BLOCK.live;
var BLOCK_HOT_CARD = CARD_BLOCK.hot;

// 按关键词判断而不是整串比对，这样 [Argument] 里的选项文案怎么改都不会打断解析。
// 现行标签：热点和直播 / 直播 / 热点 / 都不过滤
// 旧标签  ：热点和直播都关 / 只关直播 / 只关热点 / 都不关   ← 同一套逻辑也能认
function parseFeedCardMode() {
  var raw = getArgRaw('blockFeedCards');
  if (raw == null) return { live: true, hot: true };           // 未接入参数 → 都关
  var s = String(raw).trim().replace(/^["'\[]+|["'\]]+$/g, '');
  if (s === '') return { live: true, hot: true };
  // 「都不过滤」/「都不关」：必须先判——这两个串里也含「直播」以外的字，但都带「都不」
  if (s.indexOf('都不') !== -1) return { live: false, hot: false };
  var hot = s.indexOf('热点') !== -1;
  var live = s.indexOf('直播') !== -1;
  if (!hot && !live) return { live: true, hot: true };         // 认不出的值 → 都关，别静默放行
  return { live: live, hot: hot };
}

// 直播卡片判据（实证）：type==='live'，或 model_type 以 live 开头（live_v2 之类的版本后缀）。
function isLiveCard(item) {
  if (!item) return false;
  if (item.type === 'live') return true;
  return /^live/i.test(String(item.model_type || ''));
}

// 热点卡片判据（⚠️ 猜测，未实证）：type/model_type 里出现 hot 或 trend。
function isHotCard(item) {
  if (!item) return false;
  return /hot|trend/i.test(String(item.type || '') + '|' + String(item.model_type || ''));
}

// 诊断：把非笔记类卡片的 type/model_type 打到 Loon 日志，用来抓「热点」卡的真实签名。
// 正常笔记是 model_type==='note'，刷一屏只会打出寥寥几行，不会刷屏。
function logUnknownCard(item) {
  if (!item || item.model_type === 'note') return;
  if (isLiveCard(item) || isHotCard(item)) return;             // 已经认识的不用打
  console.log('[XHS] 未识别卡片 type=' + item.type + ' model_type=' + item.model_type
    + ' keys=' + Object.keys(item).join(','));
}

// 【每日浏览上限】按「过滤后」（已删视频/黑名单分类）条数计数，跨天（设备本地日期变化）自动清零。
// 现由 Loon 插件设置「每日浏览上限」(input 参数 dailyLimit) 注入；<=0 或留空 = 不限。
// 未接入参数（非 Loon，或 [Script] 行没写 argument=）→ 回退 DEFAULT_DAILY_LIMIT。
var DEFAULT_DAILY_LIMIT = 100;
var DAILY_LIMIT = parseDailyLimit();
var DAILY_USAGE_KEY = 'xhs_homefeed_daily_usage';

function parseDailyLimit() {
  var raw = getArgRaw('dailyLimit');
  if (raw == null) return DEFAULT_DAILY_LIMIT;
  raw = String(raw).trim();
  if (raw === '') return DEFAULT_DAILY_LIMIT;
  var n = parseInt(raw, 10);
  return (isNaN(n) || n < 0) ? DEFAULT_DAILY_LIMIT : n; // 0 = 不限
}

// 【首页分类：注入标题 / 按分类过滤】三值，由 Loon [Argument] select 参数
// showCategoryInTitle 注入（默认「注入并过滤」）：
//   注入并过滤 → 标题前加「[分类] 」 + 删掉 BLOCK_CATEGORIES 里的帖子
//   只注入     → 只加「[分类] 」前缀，不按分类删帖（想先看看各分类都是啥时用）
//   不注入     → 两样都不做（分类相关行为全关）
// ⚠️ 只管「分类」这一路：FILTER_VIDEO（过滤视频卡片）和 DAILY_LIMIT（日浏览上限）
//    是独立开关，不受这里影响。
// 兼容老配置：拿到布尔 true → 注入并过滤；false → 不注入（老版里 false 只关注入、
//    过滤照旧，但新三值没有「只过滤」这档，就近映射到 off 并在此注明）。
var CATEGORY_MODE = parseCategoryMode();                       // 'inject+filter' | 'inject' | 'off'
var SHOW_CATEGORY_IN_TITLE = (CATEGORY_MODE !== 'off');
var FILTER_BY_CATEGORY = (CATEGORY_MODE === 'inject+filter');

function parseCategoryMode() {
  var raw = getArgRaw('showCategoryInTitle');
  if (raw == null) return 'inject+filter';                     // 未接入参数 → 老的默认行为
  if (typeof raw === 'boolean') return raw ? 'inject+filter' : 'off';
  var s = String(raw).trim().replace(/^["'\[]+|["'\]]+$/g, '');
  if (s === '') return 'inject+filter';
  if (s === 'true' || s === '1') return 'inject+filter';
  if (s === 'false' || s === '0') return 'off';
  if (s.indexOf('不注入') !== -1) return 'off';
  if (s.indexOf('过滤') !== -1) return 'inject+filter';        // 「注入并过滤」
  if (s.indexOf('注入') !== -1) return 'inject';               // 「只注入」
  return 'inject+filter';                                      // 认不出的值 → 回落默认，别静默关功能
}
// 注入后标题总长上限（含前缀，按字符计）。超出则截断原标题尾部补「…」。
// 前缀永远在最前，必然可见；上限只为防个别超长标题触发异常/破版。
var MAX_TITLE_LEN = 40;

// 【解除复制/下载限制】true 时，对笔记详情(imagefeed/videofeed)做：
//   ① 复制门控 = note.note_text_press_options（长按菜单项）。⭐135108 关脚本对照实证：
//      可复制笔记 = [{"key":"copy"}]（菜单有复制项），不可复制 = []（空）。空数组→注入 copy 项即解锁。
//   ② note.function_switch 里每项 enable 设 true（如 image_download/video_download
//      enable:false "作者已关闭下载权限" → 真·下载门控，不是 media_save_config）。
//   ③ 顺手删 note_statement（声明徽标，非门控）+ media_save_config disable_* 设 false（无害净化）。
//   ⚠️ 不碰 note/longpress：那只是「选中→搜该词」搜索气泡，与复制无关，强改反而抑制选择菜单。
//   ⚠️ 走过的弯路：曾以为门控是 note_statement（删它），实测 140759 删了仍不能复制 → 真门控
//      是 note_text_press_options 有无「copy」项；曾反向「清空」该字段，等于把复制删掉，更错。
var UNLOCK_SAVE_COPY = true;

// 【阻止视频流下滑到下一个视频】true = 进入沉浸式视频流(videofeed)时只保留你点开的
// 那条（note_id 对应项），删掉后面推荐的「下一个视频」→ 上滑无内容可加载。
// 现由 Loon [Argument] switch 参数 blockVideoScroll 注入（默认开）。
var BLOCK_VIDEO_SCROLL = parseSwitch('blockVideoScroll', true);
// ⚠️⚠️ 「下滑出一张空白视频页」是本功能【已知且接受】的表现，不要再去修它。
//   129_1785939424185（关掉本功能的对照抓包）证明：翻页由 cursor_score 驱动，服务器无限
//   往下发，has_no_more/final_feed_item 全程 false —— 这个播放器在服务端语义里根本没有
//   「到底」这个状态，坑位是 App 单方面建的，跟响应内容无关。
//   以下四种写法**全部真机实测失败**，别再重走：
//     ① has_no_more/final_feed_item 翻 true  → 拦不住，App 照发翻页请求
//     ② data:[]（success:true）              → 空白页
//     ③ {code:-1,success:false}              → 空白页
//     ④ data:null                            → 空白页
//     ⑤ 缓存当前条、翻页时原样重放            → 也失败（已回退，代码已删）
//   结论：网络层改不掉，接受空白页作为「划不动了」的表现。
// 【首页顶部固定 tab 改可编辑】homefeed/categories 里 fixed:true 的 tab（实测 RED/直播/短剧）
// 原生不可长按删除/排序。true = 统一把 fixed 改成 false，跟其它分类 tab 一样可编辑，
// 用户自己在 App 里长按移除/排序；按 fixed 字段通用判断，以后新增的固定 tab 也会被一并放开。
var UNFIX_HOMEFEED_TABS = true;

// 【同城丢弃"已刷完"的填充内容】localfeed 单条 note 上若带
// local_content_exhausted 字段，说明真同城内容已经刷完，这条及之后都是降级填充的"附近地区"
// 内容（实测一旦出现，当批后续条目全带此字段）。true = 直接丢弃这些条目：
//   • 真有同城内容时只丢填充的尾部，正常内容照常刷新；
//   • 同城内容本来就是 0 条（如所在地区/IP 没有覆盖）时，整批被丢空，
//     App 没有新内容可渲染 → 不会继续触发"刷新"。
// 现由 Loon [Argument] switch 参数 filterLocalfeedExhausted 注入（默认开）。
var FILTER_LOCALFEED_EXHAUSTED = parseSwitch('filterLocalfeedExhausted', true);

// ============================================================================
//  以下为逻辑，一般不用改
// ============================================================================
//  homefeed (request)              → 强制 Accept-Encoding: gzip（默认 br，QX 不解 br）
//  homefeed (response)             → 删视频/黑名单分类 + 可选给标题注入 [分类]
//  homefeed/categories (response)  → 把固定 tab 的 fixed 改 false，变成可编辑
//  localfeed (request/response)    → 同样强制 gzip；丢弃"已刷完"填充内容
//  imagefeed/videofeed (request)   → 同样强制 gzip（笔记详情也默认 br）
//  imagefeed (response)            → 解除复制(删 note_statement)/下载(function_switch)限制
//  videofeed (response)            → 同上 + 可选只留当前视频（阻止下滑）
//
//  注：note/longpress 不碰（与复制无关，见上）；底栏「市集」移除已放弃（删 name_2tab_config
//      无效）；首页换收藏已放弃（拦 faved 会搞挂原生收藏页）。详见 XIAOHONGSHU_REFERENCE.md。

const url = $request.url;

if (typeof $response === 'undefined') {
  // ── 请求阶段：homefeed / categories / localfeed / imagefeed / videofeed 强制 gzip ──
  forceGzip();
} else if (/\/homefeed\/categories(\?|$)/.test(url)) {
  unfixCategories();
} else if (/\/homefeed(\?|$)/.test(url)) {
  filterFeed();
} else if (/\/localfeed(\?|$)/.test(url)) {
  filterLocalfeed();
} else {
  // imagefeed / videofeed → 笔记详情净化
  cleanNoteDetail();
}

// ─── 请求阶段：去掉 br，强制 gzip ─────────────────────────────────────────────
// homefeed/imagefeed/videofeed 默认返回 brotli(br)，QX 只能自动解压 gzip。不改的话
// 响应阶段拿到的是 br 二进制，JSON.parse 直接抛错 → 改写失效。锁成 gzip 最稳。
function forceGzip() {
  var headers = $request.headers || {};
  Object.keys(headers).forEach(function (k) {
    if (k.toLowerCase() === 'accept-encoding') delete headers[k];
  });
  headers['Accept-Encoding'] = 'gzip';
  $done({ headers: headers });
}

// ─── 响应阶段：首页过滤 + 注入分类 ───────────────────────────────────────────
// homefeed 结构：{ success, data: [ { type, display_title, recommend:{category_name}, ... } ] }
function filterFeed() {
  try {
    var body = JSON.parse($response.body);
    if (body && Array.isArray(body.data)) {
      var filtered = body.data.filter(function (item) {
        logUnknownCard(item);                                  // 诊断用，见其定义处
        if (BLOCK_LIVE_CARD && isLiveCard(item)) return false;
        if (BLOCK_HOT_CARD && isHotCard(item)) return false;
        if (FILTER_VIDEO && item.type === 'video') return false;
        if (!FILTER_BY_CATEGORY) return true;                  // 「只注入」/「不注入」两档不按分类删帖
        var cat = item.recommend && item.recommend.category_name;
        if (cat && BLOCK_CATEGORIES.indexOf(cat) !== -1) return false;
        return true;
      });
      body.data = applyDailyLimit(filtered).map(injectCategory);
    }
    $done({ body: JSON.stringify(body) });
  } catch (e) {
    $done({});
  }
}

// 每日浏览上限：DAILY_LIMIT<=0 视为不限。按「过滤后」条数计数（已删视频/黑名单分类），
// 存 $persistentStore，跨天（设备本地日期变化）自动清零。当日额度用尽后多余条目直接砍掉，
// 用尽当次返回空列表 → App 当天再刷不到新内容。
function applyDailyLimit(items) {
  if (DAILY_LIMIT <= 0) {
    console.log('[XHS] dailyLimit=不限，本次过滤后 ' + items.length + ' 条全部放行');
    return items;
  }
  var usage = readDailyUsage();
  var remaining = Math.max(0, DAILY_LIMIT - usage.count);
  var kept = items.slice(0, remaining);
  usage.count += kept.length;
  writeDailyUsage(usage);
  console.log('[XHS] dailyLimit=' + DAILY_LIMIT + ' 今日(' + usage.date + ')已计数=' + usage.count
    + ' 本次过滤后=' + items.length + ' 实际放行=' + kept.length
    + (kept.length < items.length ? '（已被砍到额度上限）' : ''));
  return kept;
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function readDailyUsage() {
  try {
    var cached = JSON.parse($persistentStore.read(DAILY_USAGE_KEY));
    if (cached && cached.date === todayStr() && typeof cached.count === 'number') return cached;
  } catch (e) {}
  return { date: todayStr(), count: 0 };
}

function writeDailyUsage(usage) {
  try { $persistentStore.write(JSON.stringify(usage), DAILY_USAGE_KEY); } catch (e) {}
}

// 在标题前注入「[分类] 」。卡片展示用 display_title，同步改 title/name 保持一致。
function injectCategory(item) {
  if (!SHOW_CATEGORY_IN_TITLE) return item;
  return injectTitlePrefix(item, item.recommend && item.recommend.category_name);
}

// 通用标题前缀注入：[label] + 原标题（超 MAX_TITLE_LEN 截断尾部补「…」）。
// label 为空则不改。display_title 恒有值优先，title/name 兜底，三者同步改保持一致。
function injectTitlePrefix(item, label) {
  if (!label) return item;
  var prefix = '[' + label + '] ';
  var orig = item.display_title || item.title || item.name || '';
  var room = MAX_TITLE_LEN - prefix.length;
  if (room < 0) room = 0;
  if (orig.length > room) {
    orig = room > 0 ? orig.slice(0, room - 1) + '…' : '';
  }
  var newTitle = prefix + orig;
  item.display_title = newTitle;
  if (item.title) item.title = newTitle;
  if (item.name) item.name = newTitle;
  return item;
}

// ─── 响应阶段：首页顶部分类 Tab — 把固定 tab 改可编辑 ───────────────────────
// homefeed/categories 结构：{ data: { categories:[ {fixed,name,oid,...} ], rec_categories:[...] } }
function unfixCategories() {
  try {
    var body = JSON.parse($response.body);
    if (UNFIX_HOMEFEED_TABS && body && body.data && Array.isArray(body.data.categories)) {
      body.data.categories.forEach(function (c) {
        if (c && c.fixed === true) c.fixed = false;
      });
    }
    $done({ body: JSON.stringify(body) });
  } catch (e) {
    $done({});
  }
}

// ─── 响应阶段：同城信息流 — 丢弃已刷完的填充内容 ─────────────────────────────
// localfeed 结构：{ data: [ { local_content_exhausted?, ... } ] }
// local_content_exhausted 出现 = 真同城内容已刷完，这条及之后是降级的"附近地区"填充内容。
function filterLocalfeed() {
  try {
    var body = JSON.parse($response.body);
    if (body && Array.isArray(body.data) && FILTER_LOCALFEED_EXHAUSTED) {
      body.data = body.data.filter(function (item) { return !item.local_content_exhausted; });
    }
    $done({ body: JSON.stringify(body) });
  } catch (e) {
    $done({});
  }
}

// ─── 响应阶段：笔记详情（imagefeed / videofeed）净化 ─────────────────────────
// 笔记体里的 note 位置因接口而异：
//   imagefeed → data[].note_list[]（图文帖，note 嵌在 note_list）
//   videofeed → data[]            （视频帖，note 直接是 data 项；data[0] = 你点开的那条）
// 每个 note 上：
//   note_statement: {...}       → ⭐复制门控（有此块即禁复制，删掉即可复制）
//   function_switch: [{type,enable,reason}] → ⭐下载门控（enable=false 即禁，拉 true 解锁）
//   media_save_config: {...}    → 水印/兜底（非下载门控）
function cleanNoteDetail() {
  try {
    var body = JSON.parse($response.body);
    if (!body || !Array.isArray(body.data)) { $done({}); return; }

    var isVideoFeed = /\/videofeed(\?|$)/.test(url);

    // 阻止下滑到下一个视频。⭐126_1785934806867 抓包修正机制（此前记的「一次返一条」已过时）：
    // videofeed 一次返 **3 条** —— data[0]=你点开的那条，data[1]/[2]=推荐的「下两条」。
    // 每条上带这几个判据字段：
    //   source_note: true   ← ⭐只有「你点开的那条」是 true，推荐项全 false（比 id===note_id 更稳，
    //                          翻页请求里也照样有效，不依赖 URL 参数）
    //   has_no_more / final_feed_item: 到底标记（原始响应恒 false）
    //   cursor_score: 翻页游标（你点的那条为空串，推荐项带值）
    // 只 filter 掉推荐项是不够的：App 见 has_no_more=false 仍会预留「下一页」坑位并去请求下一批，
    // 那批被清空成 data:[] → 坑位填不上 = 下滑出一个空白视频页（用户实测症状）。
    // 所以保留当前条的同时必须把「到底了」标记打上，让 App 根本不预留坑位、也不再发翻页请求。
    if (isVideoFeed && BLOCK_VIDEO_SCROLL) {
      var noteId = getQueryParam(url, 'note_id');
      var hasSourceFlag = body.data.some(function (it) {
        return it && typeof it.source_note === 'boolean';
      });
      // 两个判据一个都没有（字段又改名了 / URL 没带 note_id）→ 整批放行不动，
      // 宁可这次没拦住，也不能把 data 误清空导致视频页整个打不开。
      if (hasSourceFlag || noteId) {
        var kept = body.data.filter(function (it) {
          if (!it) return false;
          if (typeof it.source_note === 'boolean') return it.source_note === true; // 新版判据
          return it.id === noteId;                                                 // 老版兜底
        });
        // 整批都是推荐项、没有「你点开的那条」= App 在翻下一页要新视频 → 清空。
        // ⚠️ 下滑会出现一张空白视频页，这是**已知且接受**的表现，别再去"修"它，见 BLOCK_VIDEO_SCROLL 注释。
        body.data = kept;
        markFeedEnd(kept);
      }
    }

    if (UNLOCK_SAVE_COPY) {
      body.data.forEach(function (entry) {
        if (entry && Array.isArray(entry.note_list)) {
          entry.note_list.forEach(unlockNote); // imagefeed
        } else {
          unlockNote(entry);                   // videofeed
        }
      });
    }

    $done({ body: JSON.stringify(body) });
  } catch (e) {
    $done({});
  }
}

// 给保留下来的最后一条打「feed 到此为止」标记。
// ⚠️ **实测无效，纯属无害兜底**：127_1785938280570 就是在本函数生效的状态下抓的，
//    page=1 响应里这两个字段已经是 true，App 照样发了 page=2、照样出空白页。
//    留着只为万一别的入口（explore_feed 以外的 source）认这个字段。
//    别因为看到它就以为「阻止下滑」是靠它实现的——真正起作用的是上面的 filter。
//   has_no_more / final_feed_item：原始响应里恒 false，翻 true 即声明没有下一条。
//   cursor_score 不动：「你点开的那条」本来就是空串，清了等于没清。
// 只标最后一条：万一以后要放行多条（比如保留 N 条），前面几条不该被当成结尾。
function markFeedEnd(items) {
  if (!items || !items.length) return;
  var last = items[items.length - 1];
  if (!last || typeof last !== 'object') return;
  last.has_no_more = true;
  last.final_feed_item = true;
}

// 解除单条 note 的下载/复制限制。
function unlockNote(note) {
  if (!note || typeof note !== 'object') return;

  // ① 复制门控 = note_text_press_options（长按文字菜单项）。⭐135108 关脚本对照实证：
  //    可复制笔记 = [{"key":"copy","extra":""}]（菜单里有「复制」项），不可复制 = []（空，无复制项）。
  //    视频帖该字段为 null（无正文复制概念），不动。
  //    判据：是数组且为空 → 注入 copy 项；已有内容/null → 不碰。
  if (Array.isArray(note.note_text_press_options) && note.note_text_press_options.length === 0) {
    note.note_text_press_options = [{ key: 'copy', extra: '' }];
  }

  // ② note_statement「个人观点/原创声明」徽标：与可复制笔记对齐，顺手删掉（非门控，纯净化）。
  if (note.note_statement) delete note.note_statement;

  // ③ 下载门控：function_switch 是真开关，如 {type:"image_download",enable:false,
  //    reason:"作者已关闭下载权限"}。每项 enable 拉 true。
  if (Array.isArray(note.function_switch)) {
    note.function_switch.forEach(function (sw) {
      if (sw && typeof sw === 'object') sw.enable = true;
    });
  }

  // ④ 兜底：media_save_config 三个 disable_* 设 false（抓包里它本就 false，但保留无害）。
  if (note.media_save_config && typeof note.media_save_config === 'object') {
    note.media_save_config.disable_save = false;
    note.media_save_config.disable_watermark = false;
    note.media_save_config.disable_weibo_cover = false;
  } else {
    note.media_save_config = { disable_save: false, disable_watermark: false, disable_weibo_cover: false };
  }
}

// 从 URL query 取参数（QX 环境无 URL 类，手动解析）。
function getQueryParam(u, name) {
  var m = u.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
