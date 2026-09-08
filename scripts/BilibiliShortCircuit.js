/*
 * Bilibili gRPC 请求阶段短路 (Loon http-request, binary-body-mode)
 *
 * 只做一件事：对**输出与服务器返回什么无关**的 gRPC 请求，在请求阶段直接
 * $done({response}) 交回一个合法的空帧，**不发上游**。判据见 CLAUDE.md
 * 「请求阶段短路：$done({response})」一节。
 *
 * 覆盖两个端点（按 URL 分流）：
 *   1. viewunite.v1.View/RelatesFeed —— 播放页「相关推荐」的下滑加载更多。
 *      cleanRelates=on 时 gRPC 响应脚本会把 relates(f1) 清成 []，即
 *      **建模部分的输入对输出零贡献** → 整条请求白发。由 [Script] 行的
 *      enable={cleanRelates} 门控，关掉开关这条规则整条不装载、自动走真实响应。
 *   2. polymer.app.search.v1.Search/SearchAll —— 只短路**翻页**那一半，
 *      且只在 searchMaxItems 配额已用完时。第 1 页永远放行（判据见下）。
 *
 * ── gRPC 帧格式 ───────────────────────────────────────────────────────────
 *   1 B flag(0=不压缩) + 4 B 大端长度 + protobuf body
 *   空消息 = 5 字节 00 00 00 00 00
 * 请求帧实测 **flag=1（gzip）**，所以解请求体前必须先 $utils.ungzip。
 *
 * ── 为什么是 $done({response}) 而不是 [Rewrite] mock-response-body ────────
 *   mock 是静态规则、读不到 $argument，而这里要读 searchMaxItems、还要按请求
 *   参数（分页游标）变化。Loon 上 bodyBytes 只是 body 的别名（上游 Sparkle
 *   框架的 createResponse 就是这么代理的），所以二进制响应写成
 *   $done({response:{status,headers,body:<Uint8Array>}})。
 *   空降助手（DmSegMobile）现在每天都在用同一条路径，能力已被证实。
 *
 * ── 失败模式 ─────────────────────────────────────────────────────────────
 *   · script-path 拉不到 = 静默 no-op → 请求照常走上游，由 gRPC 响应脚本兜底，
 *     只是没省到流量，不会挂（这也是对应的 http-response 规则要保留的原因）。
 *   · 本脚本任何异常一律 $done({}) 放行，绝不把请求搞挂。
 */

// 空 gRPC 帧：flag=0 + 长度 0。⚠️ RelatesFeed 故意**不带分页游标**（见下）。
const EMPTY_FRAME = [0, 0, 0, 0, 0];

const CAP_KEY = "bili_search_cap"; // 由 BilibiliProtobufResponse.js 写，本脚本只读不写
const CAP_TTL = 6e5;               // 10 分钟，与 fork 里的判定保持一致

const LOG = (s) => { try { console.log(("[SC] " + s).replace(/\s/g, "·")); } catch (e) {} };

function pass(why) { if (why) LOG("放行·" + why); $done({}); }

function shortCircuit(why) {
  LOG("短路·不发上游·" + why);
  $done({
    response: {
      status: 200,
      // grpc-status 必须给，否则客户端按错误处理（上游 Sparkle 的 bn 中间件做的也是这件事）
      headers: { "Content-Type": "application/grpc", "grpc-status": "0" },
      body: new Uint8Array(EMPTY_FRAME),
    },
  });
}

function getArgRaw(name) {
  const raw = typeof $argument === "undefined" ? null : $argument;
  if (raw == null) return null;
  if (typeof raw === "object") return raw[name];
  try { const p = JSON.parse(raw); return p && typeof p === "object" ? p[name] : raw; }
  catch (e) { return raw; }
}

// searchMaxItems 的解析与 fork 里 /*+SR*/ 那段**必须一致**，否则两边对「配额是多少」的
// 理解会漂移。⚠️ 字符串 "0" 在 JS 里是真值，不能直接 if(raw) —— 这个坑 2026-08-26 踩过。
function parseMaxItems() {
  const raw = getArgRaw("searchMaxItems");
  // ⚠️ 参数**完全取不到**时回落「不限」而不是默认 15 —— 插件与 JS 是两次独立拉取、可以版本错位
  //    （CLAUDE.md「$done 独有的版本错位风险」）。这里默认值的方向和 fork 里相反是刻意的：
  //    fork 的默认只影响放行几条，本脚本的默认决定**要不要短路**，取不到就别短路最安全。
  if (raw == null) return 0;
  const s = String(raw).replace(/\s/g, "");
  if (s === "" || s === "0" || s === "false" || s === "关") return 0; // 0/留空/关 = 不限
  const m = s.match(/\d+/);
  if (!m) return 15;                       // 认不出回落默认 15，不静默关功能
  const n = parseInt(m[0], 10);
  return n > 0 ? n : 0;
}

// ===== 迷你 protobuf 扫描器：只认顶层字段，够用就行 =====
// 遇到坏字节就返回已解出的部分（同 fork 里 pb() 的做法），绝不抛出去。
function scanTop(buf) {
  const out = {};
  let i = 0;
  const rv = () => {
    let s = 0, r = 0;
    for (;;) {
      if (i >= buf.length) throw new Error("eof");
      const b = buf[i++];
      r |= (b & 0x7f) << s;
      s += 7;
      if (!(b & 0x80)) return r >>> 0;
    }
  };
  try {
    while (i < buf.length) {
      const key = rv();
      const f = key >>> 3, w = key & 7;
      if (w === 0) { rv(); }
      else if (w === 2) { const n = rv(); out[f] = buf.subarray(i, i + n); i += n; }
      else if (w === 5) { i += 4; }
      else if (w === 1) { i += 8; }
      else break;
    }
  } catch (e) {}
  return out;
}

function u8ToStr(u8) {
  try { return decodeURIComponent(escape(String.fromCharCode.apply(null, u8))); }
  catch (e) { try { return String.fromCharCode.apply(null, u8); } catch (e2) { return ""; } }
}

// 取请求体的 protobuf 载荷（去 5 字节帧头 + 按 flag 解 gzip）
// ⚠️⚠️ **Loon 原生的 `$request` 没有 `bodyBytes`** —— binary-body-mode 下二进制在 `$request.body`。
//    上游 Sparkle 之所以到处写 `s.request.bodyBytes`，是因为它的 Loon 适配层自己造了这个别名：
//      createRequest(e){ return Object.create(e,{bodyBytes:{get(){return this.body},set(t){this.body=t}}}) }
//    2026-09-08 `201_` 抓包就栽在这：只读 `$request.bodyBytes` → undefined → 11 条 SearchAll
//    全部「读不到请求体·放行」，下行一分没省，而 Loon 日志里请求脚本明明每条都触发了
//    （症状＝脚本跑了但判据永远不成立，比不触发更难查）。⇒ 两个名字都试。
function requestPayload() {
  let b = $request.bodyBytes;
  if (!b) b = $request.body;
  if (b && typeof b === "object" && !b.length && b.byteLength) b = new Uint8Array(b); // ArrayBuffer 兜底
  if (!b || b.length < 5) return null;
  const flag = b[0];
  const len = (b[1] << 24 | b[2] << 16 | b[3] << 8 | b[4]) >>> 0;
  let body = b.subarray(5, 5 + len);
  if (flag) body = $utils.ungzip(body);
  return body;
}

// ===== 主流程 =====
(function main() {
  let url = "";
  try { url = $request.url || ""; } catch (e) {}

  try {
    // —— RelatesFeed：无条件短路（本规则由 enable={cleanRelates} 门控，装载即代表要清空）——
    // ⚠️ 空帧**不带分页游标**是刻意的。原脚本清空 relates 却把游标原样还回去
    //    （21 B 帧 = 5 B 帧头 + f2{f2:"cmVsYXRlNA=="}，base64 解出是 "relate4"、逐页递增），
    //    App 因此以为「还有下一页」继续翻 —— `34_` 抓包里同一个视频连发 3 次、共 57,406 B
    //    全下完即丢。不给游标 = 省流量之外顺手掐掉翻页。
    if (url.indexOf("viewunite.v1.View/RelatesFeed") !== -1) {
      shortCircuit("RelatesFeed");
      return;
    }

    // —— SearchAll：只短路「配额已用完之后的翻页」——
    if (url.indexOf("Search/SearchAll") !== -1) {
      const MX = parseMaxItems();
      if (MX <= 0) { pass("SearchAll·未限条数"); return; }

      const payload = requestPayload();
      if (!payload) { pass("SearchAll·读不到请求体"); return; }
      const top = scanTop(payload);

      // f10 = 分页消息 {f1:pageSize, f2:cursor}。第 1 页只有 f1（实测 f10=0814），
      // 第 2 页起才带 f2（`152_` 六页实证，cursor 里还编着页码 CAI/CAM/CAQ/CAU/CAY=2~6）。
      // ⚠️ 第 1 页永远放行 —— 新搜索必然走上游、状态必然被响应脚本重置，安全由构造保证。
      const pg = top[10];
      if (!pg) { pass("SearchAll·无分页字段"); return; }
      const inner = scanTop(pg);
      if (!inner[2]) { pass("SearchAll·第 1 页"); return; }

      // f1 = query 串。必须与累计状态里的 query 一致，否则是另一次搜索。
      const q = top[1] ? u8ToStr(top[1]) : "";
      if (!q) { pass("SearchAll·读不到 query"); return; }

      let st = null;
      try { const raw = $persistentStore.read(CAP_KEY); if (raw) st = JSON.parse(raw); } catch (e) {}
      if (!st || st.q !== q) { pass("SearchAll·无状态或换了词·q=" + q); return; }
      if (st.ts && Date.now() - st.ts > CAP_TTL) { pass("SearchAll·状态已过期"); return; }
      const sent = parseInt(st.sent, 10) || 0;
      if (sent < MX) { pass("SearchAll·配额未满 " + sent + "/" + MX); return; }

      shortCircuit("SearchAll·翻页·配额已满 " + sent + "/" + MX + "·q=" + q);
      return;
    }

    pass("未匹配端点");
  } catch (e) {
    // 任何异常都放行：宁可没省到流量，也不能把搜索/播放页搞挂
    LOG("异常·放行·" + e);
    try { $done({}); } catch (e2) {}
  }
})();
