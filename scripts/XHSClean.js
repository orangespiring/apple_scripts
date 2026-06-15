// XHSClean.js — XiaoHongShu QX script  @orangespiring
// ============================================================================
//  用户可维护配置（改这里即可，无需动下方逻辑）
// ============================================================================

// 【分类黑名单】recommend.category_name 命中即隐藏。
// 现由 Loon 插件设置「首页屏蔽分类」(input 参数 blockCategories) 注入，多个分类用【空格】分隔：
//   • 未接入参数（非 Loon，或 [Script] 行没写 argument=）→ 回退 DEFAULT_BLOCK_CATEGORIES；
//   • 设置里留空 → 空数组 = 不按分类过滤。
// ⚠️ 别在文本框里用逗号：逗号是 Loon 配置行的选项分隔符，值里带逗号会把整行截断/作废，
//    导致这条响应脚本根本不加载（首页过滤静默失效，照样刷到被屏蔽分类）。故 [Script] 行用
//    argument=[{blockCategories}] 方括号包裹兜底，本函数也容错空格/逗号/顿号/竖线 + 去包裹符号。
// 分类名见 XIAOHONGSHU_REFERENCE.md 的 29 类映射表（非全集，新分类按需补）。
var DEFAULT_BLOCK_CATEGORIES = ['科技数码', '二次元', '娱乐', '资讯', '汽车', '游戏', '人文', '职场', '商业财经'];
var BLOCK_CATEGORIES = parseBlockCategories();

function parseBlockCategories() {
  var raw = (typeof $argument !== 'undefined') ? $argument : null;
  if (raw == null) return DEFAULT_BLOCK_CATEGORIES;       // 未接入参数 → 回退默认
  if (typeof raw === 'object') {                          // Loon「按名映射」成对象 {blockCategories:"..."}
    raw = (raw.blockCategories != null)
      ? raw.blockCategories
      : Object.keys(raw).map(function (k) { return raw[k]; }).join(' ');
  }
  // 去首尾包裹符号：空白 / 引号 / 方括号（argument=[{...}] 形式 $argument 可能带 []）
  raw = String(raw).replace(/^[\s"'\[]+|[\s"'\]]+$/g, '');
  if (!raw) return [];                                    // 显式留空 = 不过滤
  // 空格/逗号/顿号/竖线均可分隔（推荐空格；逗号仅作兜底，正常配置里不该出现）
  return raw.split(/[\s,，、|]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// 【是否过滤视频帖】true = 首页只看图文，删掉所有 type==='video'
var FILTER_VIDEO = true;

// 【标题前注入分类名】true = 卡片标题前加「[分类] 」，方便一眼看出每条属于哪类
var SHOW_CATEGORY_IN_TITLE = true;
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
var BLOCK_VIDEO_SCROLL = true;

// ============================================================================
//  以下为逻辑，一般不用改
// ============================================================================
//  homefeed (request)              → 强制 Accept-Encoding: gzip（默认 br，QX 不解 br）
//  homefeed (response)             → 删视频/黑名单分类 + 可选给标题注入 [分类]
//  imagefeed/videofeed (request)   → 同样强制 gzip（笔记详情也默认 br）
//  imagefeed (response)            → 解除复制(删 note_statement)/下载(function_switch)限制
//  videofeed (response)            → 同上 + 可选只留当前视频（阻止下滑）
//
//  注：note/longpress 不碰（与复制无关，见上）；底栏「市集」移除已放弃（删 name_2tab_config
//      无效）；首页换收藏已放弃（拦 faved 会搞挂原生收藏页）。详见 XIAOHONGSHU_REFERENCE.md。

const url = $request.url;

if (typeof $response === 'undefined') {
  // ── 请求阶段：homefeed / imagefeed / videofeed 强制 gzip ──
  forceGzip();
} else if (/\/homefeed(\?|$)/.test(url)) {
  filterFeed();
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
      body.data = body.data
        .filter(function (item) {
          if (FILTER_VIDEO && item.type === 'video') return false;
          var cat = item.recommend && item.recommend.category_name;
          if (cat && BLOCK_CATEGORIES.indexOf(cat) !== -1) return false;
          return true;
        })
        .map(injectCategory);
    }
    $done({ body: JSON.stringify(body) });
  } catch (e) {
    $done({});
  }
}

// 在标题前注入「[分类] 」。卡片展示用 display_title，同步改 title/name 保持一致。
function injectCategory(item) {
  if (!SHOW_CATEGORY_IN_TITLE) return item;
  var cat = item.recommend && item.recommend.category_name;
  if (!cat) return item;
  var prefix = '[' + cat + '] ';
  // 原始展示标题（display_title 恒有值；个别为空则用 title/name 兜底）
  var orig = item.display_title || item.title || item.name || '';
  // 总长上限：超了截断原标题尾部，给省略号留 1 位
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

    // 阻止下滑到下一个视频。videofeed 实测是「一次返一条」：
    //   - 你点开的视频 → 该次响应 data[0].id === 请求的 note_id；
    //   - App 为「下一个/预取」发的请求 note_id 仍是你点的，但响应返回的是别的 id。
    // 所以判据 = 响应里这条 id 是否等于请求 note_id：等于=你点的，保留；不等=下一个，清空。
    // 清空(data:[]) 让 App 没有下一条可加载 → 划不动。
    if (isVideoFeed && BLOCK_VIDEO_SCROLL) {
      var noteId = getQueryParam(url, 'note_id');
      if (noteId) {
        var isCurrent = body.data.some(function (it) { return it && it.id === noteId; });
        if (isCurrent) {
          body.data = body.data.filter(function (it) { return it && it.id === noteId; });
        } else {
          body.data = []; // 这是「下一个视频」的请求，直接清空
        }
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
