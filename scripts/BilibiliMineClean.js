/*
 * Bilibili「我的」页净化脚本 (Loon / QuantumultX script-response-body)
 * 处理 app.bilibili.com/x/v2/account/mine + account/myinfo
 *
 * 参考 linuszlx/Bili.js 逻辑，适配中英文 locale：
 *   1) 删除 VIP/广告/重做模块（rework_v1, vip_section, vip_section_v2）
 *   2) sections_v2 只保留 style=1|2 的入口区块，删创作中心/推荐服务
 *   3)「更多服务」只留 联系客服+设置，其余推广入口全删
 *   4) 删除每个 section 的 button（推广按钮）
 *
 * 配合 BilibiliFeedBlock.lnplugin 使用。与 BilibiliTabFeed.js（tab/v2）互补——
 *   tab/v2 管顶栏/底栏/右上角入口；本脚本管「我的」页内部。
 */

// 可配置：要删除的 data 顶层 key（中文版已验证，英文版同样适用）
const DELETE_KEYS = ["rework_v1", "vip_section", "vip_section_v2"];

// 要跳过（删除）的 section 标题（中英文）
const SKIP_TITLES = new Set([
  "创作中心", "Creator Center", "Creation Center",
  "推荐服务", "Recommended Services", "Recommended",
  "我的服务", "My Services", "我的业务", "Services",
]);

// 「更多服务」标题候选（中英文）
const MORE_SERVICES_TITLES = new Set([
  "更多服务", "More Services", "More",
]);

// 「更多服务」里要保留的入口——按 uri 关键字匹配（语言无关）
const KEEP_URI_PATTERNS = [
  /user_center\/feedback/,   // 联系客服 / Contact Customer Service
  /user_center\/setting/,    // 设置 / Settings
];

function keepItemByUri(item) {
  if (!item || !item.uri) return false;
  return KEEP_URI_PATTERNS.some((re) => re.test(item.uri));
}

function cleanMine(obj) {
  const data = obj && obj.data;
  if (!data) return obj;

  // 1) 删顶层广告/VIP key
  for (const k of DELETE_KEYS) {
    delete data[k];
  }

  // 2) 清理 sections_v2
  const sections = data.sections_v2;
  if (!Array.isArray(sections) || !sections.length) return obj;

  const newSections = [];
  for (const sec of sections) {
    if (!sec) continue;

    // 删除推广按钮
    delete sec.button;

    // 只保留 style 1 或 2 的区块（入口网格/列表）
    if (sec.style !== 1 && sec.style !== 2) continue;

    // 跳过创作中心 / 推荐服务
    if (sec.title && SKIP_TITLES.has(sec.title)) continue;

    // 「更多服务」精简：只留 联系客服 + 设置
    if (sec.title && MORE_SERVICES_TITLES.has(sec.title)) {
      delete sec.title; // 去掉标题本身
      if (Array.isArray(sec.items) && sec.items.length) {
        sec.items = sec.items.filter(keepItemByUri);
      }
    }

    newSections.push(sec);
  }
  data.sections_v2 = newSections;

  return obj;
}

// ===== 入口 =====

let body = $response.body;

try {
  const obj = JSON.parse(body);
  cleanMine(obj);
  body = JSON.stringify(obj);
} catch (e) {
  // 解析失败：原样返回，不破坏页面
}

$done({ body });
