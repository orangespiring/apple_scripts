/*
 * 两步路户外助手 净化脚本
 * 适配 App 9.2.3 (build 9.2.3.1)
 * Loon http-response，API 与 QuantumultX script-response-body 兼容
 *
 * ★ 本脚本只剩 4 个分支 —— 绝大多数接口已改由插件的 [Rewrite] mock-response-body 处理
 *   （不发上游请求 + 直接返回合法 JSON，实测省 390KB、延迟从 ~1.5s 降到 ~2ms）。
 *   留在这里的，全都是「必须读到服务器真实响应才能处理」的：
 *     /getAppEntranceConfig      要保住 tiandiAppkey 等功能参数，只能删广告键
 *     /v9/home/getNavigationBar  要从真实 tab 列表里筛，不能写死
 *     /promote/getAppUserModule  同上
 *     /adConfig/get              要在真实配置上翻开关，保留其余字段
 *
 *     /v9/heatmap/info           只清 tipText，保留真实免费额度
 *     /mapSource/offlineAreaPack 只清 hintText，保留真实价格
 *
 * ★ 诗词与各类占位对象【不在本文件】，见 tools/build_2bulu_mocks.js
 *   （它生成 mocks/*.json，供插件的 mock data-path 引用）。别在这里再放一份，会漂移。
 *
 * ★ 核心原则：强制重写旧缓存
 *   两步路在「响应非法」或「列表为空」时会回退渲染磁盘缓存，reject-200 的 0 字节同样不覆盖缓存。
 *   所以下面凡是列表，一律过 ensureNonEmpty() 保证长度 ≥1。
 *
 * ★ 代理 host：saas-h5.2bulu.com/helperapi/* 是 helper.2bulu.com 的完整代理，
 *   normPath() 把两者归一后再分发。
 */

// getAppEntranceConfig.configData 里要删的广告键。
// ⚠️ 不要整个置成 "{}" —— 这份配置里还装着 tiandiAppkey（天地图三个 appkey）、
//    recordKalmanFilter / availableTrackFilter / recordDataFilter（轨迹记录滤波）、
//    reverseGeocodeType、showNewTrack3DVideo 等功能参数，抹掉会影响地图图层和轨迹记录。
const ENTRANCE_AD_KEYS = [
  "adPlatform", "adsConfig", "adIntertitialShowType",
  "adIntertitialDisplayedLimit", "adIntertitialDayDisplayedMaxCount",
  "adSplashShowTypeWhenHotStart", "od_adsType", "showMeBaiHeAdView"
];
// ⚠️ 不要把 shopSearchApi 加进上面这个列表。
//    它不是广告键，是底栏「商城」的入口 URL（shop45920354.m.youzan.com/wscshop/...）。
//    删掉它 → App 拿不到商城地址 → WebView 无处可去、永远转圈，而且一个请求都不发
//    （抓包 192 实证：点商城时零条有赞请求）。商城本来就靠 [Rule] 层
//    DOMAIN-SUFFIX,youzan.com,REJECT 拦，配置里留着这个 URL 不会漏任何流量。

// 首页子 tab 保留哪些（新版共 7 个：关注/在路上/同城/搭子/赛事/保险/旅行）
const KEEP_TABS = ["在路上", "关注"];

// ============================================================
// 工具
// ============================================================

// 去掉 scheme+host，并把 saas-h5 的 /helperapi 代理前缀削掉，与 helper 归一
function normPath(u) {
  var s = String(u || "").replace(/^https?:\/\/[^/]+/i, "");
  if (s.indexOf("/helperapi/") === 0) s = s.slice("/helperapi".length);
  return s;
}

// 前缀锚定匹配：只在路径边界（串尾 / ? / /）处命中。
// 用它而不是 indexOf，避免 "/outing/reqIndex" 误命中 "/outing/reqIndexOutingBriefInfoList" 这类陷阱。
function at(p, seg) {
  if (p.indexOf(seg) !== 0) return false;
  var c = p.charAt(seg.length);
  return c === "" || c === "?" || c === "/";
}

// ★ 覆盖缓存的唯一入口：保证列表合法且长度 ≥1
function ensureNonEmpty(list, makeFn) {
  if (Object.prototype.toString.call(list) === "[object Array]" && list.length > 0) return list;
  return [makeFn(0)];
}

// ============================================================
// 分发
// ============================================================
const url = ($request && $request.url) || "";
let body = $response.body;

try {
  const p = normPath(url);

  // 首页子 tab → 只留「在路上」「关注」，清「旅行」的红点 badge
  if (at(p, "/v9/home/getNavigationBar")) {
    const o = JSON.parse(body);
    if (o && o.data && Object.prototype.toString.call(o.data.columns) === "[object Array]") {
      let cols = o.data.columns.filter(function (c) { return c && KEEP_TABS.indexOf(c.name) >= 0; });
      cols = ensureNonEmpty(cols, function () { return o.data.columns[0]; });
      cols.forEach(function (c) { if (c) c.badge = null; });
      // 「在路上」本来是默认打开项，筛完要保证仍有一个默认项
      if (!cols.some(function (c) { return c && c.defaultOpen === 1; })) cols[0].defaultOpen = 1;
      o.data.columns = cols;
    }
    body = JSON.stringify(o);
  }

  // ★ 广告总开关：在真实配置上翻开关，保留其余字段
  else if (at(p, "/adConfig/get")) {
    const o = JSON.parse(body);
    if (o && o.data) {
      const d = o.data;
      d.freeAdEnabled = true;
      d.newUserFreeAdDuration = 315360000000;        // ~10 年
      d.returningUserFreeAdDuration = 315360000000;
      d.returningUserThreshold = 0;
      if (d.splashAd) {
        d.splashAd.on = false;
        d.splashAd.dailyMaxDisplayCount = 0;
        d.splashAd.randomDisplay = false;
        if (Object.prototype.toString.call(d.splashAd.adList) === "[object Array]") {
          d.splashAd.adList.forEach(function (a) { if (a) a.num = 0; });
        }
        if (d.splashAd.hotStart) {
          d.splashAd.hotStart.on = false;
          d.splashAd.hotStart.displayInterval = 315360000000;
        }
      }
      if (d.interstitialAd) {
        d.interstitialAd.on = false;
        d.interstitialAd.dailyMaxDisplayCount = 0;
        if (d.interstitialAd.hotStart) d.interstitialAd.hotStart.on = false;
      }
    }
    body = JSON.stringify(o);
  }

  // 入口配置 → ⚠️ 只删广告键，保留功能参数
  else if (at(p, "/getAppEntranceConfig")) {
    const o = JSON.parse(body);
    if (o && typeof o.configData === "string") {
      try {
        const cfg = JSON.parse(o.configData);
        ENTRANCE_AD_KEYS.forEach(function (k) { delete cfg[k]; });
        o.configData = JSON.stringify(cfg);
      } catch (e) { /* configData 解析失败就原样放行，别把功能参数一起废掉 */ }
    }
    body = JSON.stringify(o);
  }

  // 热力图页 → 只清推广文案。
  // ⚠️ 只动 tipText。vipFreeQuotaTotal/Used/Remaining 是这个账号真实的免费额度，
  //    buttonType/buttonTarget 决定按钮行为 —— 这些是服务端下发的真实状态，不能改，
  //    也正因为如此这个接口【不能整条 mock】（那等于把非会员的额度写死，
  //    真买了会员反而会被假数据覆盖）。
  else if (at(p, "/v9/heatmap/info")) {
    const o = JSON.parse(body);
    if (o && o.data && typeof o.data.tipText === "string") o.data.tipText = "";
    body = JSON.stringify(o);
  }

  // 离线地图包列表 → 只清每个包上的「开通VIP解锁热力图」角标文案。
  // ⚠️ originPrice / vipPrice / svipPrice / vipBadge / targetVipType 一律不动：
  //    那是真实价格与折扣信息，改了就成了篡改付费门控。
  else if (at(p, "/mapSource/offlineAreaPack")) {
    const o = JSON.parse(body);
    if (o && Object.prototype.toString.call(o.data) === "[object Array]") {
      o.data.forEach(function (x) { if (x && typeof x.hintText === "string") x.hintText = ""; });
    }
    body = JSON.stringify(o);
  }

  // 我的页 → 只留「户外工具」
  else if (at(p, "/promote/getAppUserModule")) {
    const o = JSON.parse(body);
    if (o && Object.prototype.toString.call(o.data) === "[object Array]") {
      const kept = o.data.filter(function (m) { return m && m.name === "户外工具"; });
      o.data = ensureNonEmpty(kept, function () { return o.data[0]; });
    }
    body = JSON.stringify(o);
  }

} catch (e) { /* 出错静默放行原始 body */ }

$done({ body });
