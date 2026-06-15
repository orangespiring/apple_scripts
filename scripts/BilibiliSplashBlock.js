/*
 * Bilibili 开屏广告「清空」脚本  (QuantumultX script-response-body)
 * 配合 BilibiliFeedBlock.conf 使用。
 *
 * 目标接口：app.bilibili.com/x/v2/splash/list（identity JSON）
 * 响应结构：{"code":0,"data":{"list":[...广告...],"keep_ids":[...],...}}
 *
 * 清空 data.list（广告图片列表）和 data.keep_ids（本地缓存 ID），
 * 返回"成功但无广告"，App 不展示开屏广告且不读本地缓存旧广告。
 */

let body = $response.body;

try {
  const obj = JSON.parse(body);
  if (obj && obj.data) {
    obj.data.list = [];
    obj.data.keep_ids = [];
  }
  body = JSON.stringify(obj);
} catch (e) {
  body = JSON.stringify({ code: 0, message: "OK", ttl: 1, data: { list: [], keep_ids: [] } });
}

$done({ body });
