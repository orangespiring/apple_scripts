/*
 * Bilibili 首页改造脚本 (Loon http-response)
 *
 * 目的：把整个首页打造成纯「稍后再看」页（同一脚本按 URL 分流处理两个接口）。
 *   - 拦 /x/resource/show/tab/v2（唯一处理者）：顶栏只留一个 tab、改名「稍后再看」；
 *     右上角加 收藏夹/稍后再看 入口；底栏只留 首页/动态/我的；删「…」更多菜单。
 *   - 拦 app.bilibili.com/x/v2/feed/index（明文 JSON，identity）：把 data.items 换成「稍后再看」列表。
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

// —— tab/v2：右上角入口/底栏恒改；顶栏 tab 折叠成单「稍后再看」仅在 homeShowWatchLater 开启时 ——
// ⚠️ 本脚本是 tab/v2 的【唯一】处理者：Loon 同 URL「最后一个脚本整体覆盖、各自读原始响应」(§13b)，
//    多脚本各改一部分会互相吞掉 → 故把 data.top 入口 + data.bottom 精简 + 删 top_more（恒改）
//    与 data.tab 折叠（受开关）全收进本函数一次性产出（原 BilibiliTabFeed.js 已删除，逻辑并入此处）。
//    开关状态经 [Script] 的 argument={homeShowWatchLater} 传入 → $argument（"true"/"false"）。
//    data.tab 受开关：关 = 不动原生 tab（feed 也回原生推荐，名实相符）；开 = 只留单「稍后再看」tab。
const TAB_FAV_URI = "bilibili://main/favorite";             // 收藏夹（原生页 deeplink）
const TAB_LATER_URI = "bilibili://user_center/watch_later"; // 稍后再看（原生页 deeplink）
const TAB_ICON_FAV = "http://i0.hdslb.com/bfs/archive/d79b19d983067a1b91614e830a7100c05204a821.png";
const TAB_ICON_LATER = "http://i0.hdslb.com/bfs/archive/63bb768caa02a68cb566a838f6f2415f0d1d02d6.png";
const TAB_BOTTOM_KEEP = ["main/home", "following/home", "user_center"]; // 底栏只留 首页/动态/我的
function handleTab() {
  let body = $response.body;
  try {
    const obj = JSON.parse(body);
    const data = obj && obj.data;
    if (data) {
      // 顶栏 data.tab：仅当 homeShowWatchLater 开启时折叠成单「稍后再看」；关闭则保留原生 tab 不动
      // ⚠️ Loon 对 argument=[{name}] 传入的 $argument 是「具名对象」或其 JSON 串（如 {homeShowWatchLater:true}），
      //    不是纯值 "true"。直接 String(对象)="[object Object]" 会让 /true/ 永远不匹配（反复踩的坑）→ 先 stringify。
      const argStr = typeof $argument === "undefined" ? ""
        : (typeof $argument === "object" ? JSON.stringify($argument) : String($argument));
      const wlOn = /true/i.test(argStr);
      if (wlOn && Array.isArray(data.tab) && data.tab.length) {
        let kept = data.tab.filter((t) => ((t && t.uri) || "").indexOf("pegasus/promo") >= 0);
        if (!kept.length) kept = [data.tab[0]]; // 容错：没匹配到就留第一个，免得顶栏空掉被 App 回退成默认全栏
        kept[0].name = "稍后再看";
        kept[0].default_selected = 1;
        data.tab = [kept[0]]; // ⚠️ 必须是数组！赋单个对象 App 会判无效、保留原生 tab（踩过的坑）
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

  // 随机排列开关：feed/index 那条 [Script] 传 argument=[{randomWatchLater}] → $argument。
  // 与 handleTab 同样按「具名对象 → JSON 串里找 true」解析（该行只传这一个参数，无歧义）。
  const randomOn = /true/i.test(typeof $argument === "undefined" ? ""
    : (typeof $argument === "object" ? JSON.stringify($argument) : String($argument)));

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
      // 随机排列（randomWatchLater 开时）：只在刷新这一刻洗一次牌并存进缓存，
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

function fallbackAndDone(config, isDouble) {
  // 拉取失败时用上次缓存（原始 list）的首屏（前 PAGE_SIZE 条）按当前列数构卡
  writeOffset(PAGE_SIZE); // 同刷新：游标归位到第二页起点
  $done({ body: buildFeed(buildPage(readCache(), 0, isDouble), config) });
}
