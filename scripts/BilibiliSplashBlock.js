/*
 * Bilibili 开屏广告「清空」脚本（Loon，同一文件挂两个阶段）
 *
 * 目标接口：app.bili(bili.com|api.net)/x/v2/splash/list（identity JSON）
 * 响应结构：{"code":0,"data":{"max_time":30,"min_interval":3600,"pull_interval":900,
 *                            "keep_ids":[],"list":[...广告...],"show":[...],"splash_request_id":"..."}}
 *
 * ── 两个阶段 ──────────────────────────────────────────────────────────────
 * http-request  ：直接 $done({response}) 短路，**不发上游**。因为本脚本的输出
 *                 （list=[] / keep_ids=[]）与服务器返回什么完全无关 —— 符合
 *                 CLAUDE.md「输出与服务器返回什么无关」的短路判据。
 * http-response ：保留原逻辑作**失败模式安全网**（XHS 方案定下的做法）：万一 Loon
 *                 忽略 `response` 键，请求照常走上游，由这一段兜底清空，只是没省到流量。
 *
 * ⚠️ 为什么值得短路：`176_1788005135736.har`（插件关着抓）实测 data.list 里 **38 条广告**、
 *    单次 `_loon.downloadSize` 29,936 B，一次冷启动来 **4 次**。而 `179_`（插件开着）实测
 *    downloadSize 仍是 28,345~30,512 B 而 content.size 只有 250 B —— **[Script] 型改写
 *    一分下行都省不到**，Loon 把整个 body 下完才交给脚本。
 *
 * ⚠️ 短路返回体保留了三个真实字段（max_time/min_interval/pull_interval，取自 `152_` 实测值），
 *    不是只回 {list:[],keep_ids:[]}：缺了它们 App 可能退回内置默认、反而**拉高**请求频率。
 */

// 真实响应里的节流参数（`152_1787700692735.har` 实测）。开屏内容本身清空，但这几个
// 「多久拉一次 / 单次最长展示多久」的行为参数必须给，否则 App 用内置默认。
const SPLASH_SHELL = {
  code: 0,
  message: "OK",
  ttl: 1,
  data: {
    max_time: 30,
    min_interval: 3600,
    pull_interval: 900,
    keep_ids: [],
    list: [],
    show: [],
  },
};

const LOG = (s) => { try { console.log(("[SPL] " + s).replace(/\s/g, "·")); } catch (e) {} };

// Loon 的 http-request 脚本里 $response 不存在；http-response 阶段它带 body/status。
function isRequestPhase() {
  if (typeof $response === "undefined" || $response === null) return true;
  return typeof $response.body === "undefined" && typeof $response.status === "undefined";
}

if (isRequestPhase()) {
  // —— 请求阶段：短路，不发上游 ——
  // 真机判据（HAR）：这条的 _loon.downloadSize 为 0、serverIPAddress 为空 = 真短路了。
  LOG("请求阶段短路·不发上游");
  $done({
    response: {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(SPLASH_SHELL),
    },
  });
} else {
  // —— 响应阶段：兜底（仅当上面的短路没生效才会走到）——
  let body = $response.body;
  try {
    const obj = JSON.parse(body);
    if (obj && obj.data) {
      obj.data.list = [];
      obj.data.keep_ids = [];
    }
    body = JSON.stringify(obj);
    LOG("响应阶段兜底·已清空 list/keep_ids");
  } catch (e) {
    body = JSON.stringify(SPLASH_SHELL);
    LOG("响应阶段兜底·解析失败·返回固定空壳");
  }
  $done({ body });
}
