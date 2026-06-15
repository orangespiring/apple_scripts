/*
 * Bilibili 推荐 feed「清空内容」脚本  (QuantumultX script-response-body)
 * 配合 BilibiliFeedBlock.conf 使用，多文件方式（与 conf 放同一个 gist）。
 *
 * 目的：保留 App 需要的外层结构(code/message/ttl/data.config 等)，只把推荐
 *       列表 items 清空，返回「成功但空列表」。App 据此用空结果覆盖本地缓存，
 *       手动刷新后旧缓存内容也会消失，且不会因缺字段而崩。
 *
 * 仅处理明文 JSON 响应（app.bilibili.com/x/v2/feed/index 为 identity 编码）。
 * 直播 feed 是 gzip 且结构不确定，默认不用本脚本（conf 里仍用 reject-200）。
 */

let body = $request.body;

try {
  const obj = JSON.parse(body);
  if (obj && obj.data) {
    // 首页推荐列表
    if (Array.isArray(obj.data.items)) obj.data.items = [];
    // 兼容其它可能的列表字段（存在才清，不存在不动）
    if (Array.isArray(obj.data.card_list)) obj.data.card_list = [];
    if (Array.isArray(obj.data.cards)) obj.data.cards = [];
  }
  body = JSON.stringify(obj);
} catch (e) {
  // 解析失败兜底：返回最小“成功空列表”
  body = JSON.stringify({ code: 0, message: "OK", ttl: 1, data: { items: [] } });
}

$done({ body });
