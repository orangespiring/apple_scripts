/*
 * Bilibili tab/v2 重写脚本  (QuantumultX script-response-body)
 * 只处理 app.bilibili.com/x/resource/show/tab/v2。
 *
 * ⚠️ 关键认知（抓包验证，踩过白屏的坑）：
 *   顶栏 data.tab 是「内嵌原生信息流 fragment」的容器，只认这几类原生路由：
 *     pegasus/promo（推荐）、pegasus/hottopic（热门）、live/home（直播）、
 *     pgc/*（番剧/影视）、following/home_activity_tab/<id>（运营活动）。
 *   把 bilibili://search?keyword=  或  bilibili://browser?url=（webview）
 *   这类「点了会自己开新页面的 deeplink」塞进 data.tab → 标题能显示、
 *   内容区空白（白屏）。data.bottom 同理（也是内嵌 fragment）。
 *   ⇒ 自定义入口（收藏夹 / 搜索）必须放在「点击跳转」的位置：
 *      data.top（右上角图标）或 data.top_more（… 菜单）。本脚本用 data.top。
 *
 * 本脚本做三件事：
 *   1) 顶栏 data.tab     只保留「推荐」(pegasus/promo) —— 配合 BilibiliEmptyFeed.js
 *                        已被清空，等于一个干净空白首页；也不会触发热门 gRPC。
 *   2) 右上角 data.top   保留「消息」，再加 收藏夹 + 稍后再看（去掉游戏中心等其它原生项）。
 *   3) 底栏 data.bottom  只保留 首页/动态/我的；删 top_more（… 菜单）。
 *
 * 注意：墨鱼「哔哩广告净化」也改 tab/v2，QX 同一 URL 只生效一条 →
 *      本模块要排在墨鱼【前面】。底栏精简已复刻，不丢墨鱼效果。
 */

// 顶栏 tab 只保留这些原生信息流（按 uri 关键字匹配）。
// 想加回更多原生 tab 就往这里加：直播 "live/home" / 番剧动画 "pgc/" / 影视 "pgc/cinema"
const TAB_KEEP = ["pegasus/promo"];

// 【测试开关】把首页那个 tab 的 uri 强行换成这个 deeplink，验证 tab 能否内嵌 deeplink。
//   留空 "" = 不注入、维持原生「推荐」(清空)。测完想恢复，把它改回 "" 即可。
//   预期：按之前结论 tab 只内嵌原生信息流，多半白屏；user_center/* 是 fragment 区，待测。
const TAB_INJECT_URI = "bilibili://user_center/watch_later";

// 底栏只保留：首页 / 动态 / 我的
const BOTTOM_KEEP = ["main/home", "following/home", "user_center"];

// 收藏夹 & 稍后再看：直接用 B 站【原生页 deeplink】，开 App 原生页、不碰网页、零白屏。
const FAV_URI = "bilibili://main/favorite";             // 收藏夹（原生「我的收藏」全部列表）
const LATER_URI = "bilibili://user_center/watch_later"; // 稍后再看（原生页）
//   兜底（万一你的版本上某个没反应就换成抓包里「我的」页实际用的值）：
//     收藏夹    bilibili://user_center/favourite?version=2
//     稍后再看  bilibili://user_center/watch_later_v2
//   想直达某个【具体收藏夹】而非全部列表，可把 FAV_URI 改回 webview：
//     "bilibili://browser?url=" + encodeURIComponent("https://www.bilibili.com/medialist/detail/ml726689729")

// 图标：用 B 站「我的」页同款原生图标（抓包取得，对得上语义）
const ICON_FAV = "http://i0.hdslb.com/bfs/archive/d79b19d983067a1b91614e830a7100c05204a821.png"; // 收藏
const ICON_LATER = "http://i0.hdslb.com/bfs/archive/63bb768caa02a68cb566a838f6f2415f0d1d02d6.png"; // 稍后再看

let body = $response.body;

try {
  const obj = JSON.parse(body);
  const data = obj && obj.data;

  if (data) {
    // 1) 顶栏 tab：只留原生信息流（默认仅「推荐」，内容已被 EmptyFeed 清空）
    if (Array.isArray(data.tab) && data.tab.length) {
      const kept = data.tab.filter((t) => {
        const uri = (t && t.uri) || "";
        return TAB_KEEP.some((k) => uri.indexOf(k) >= 0);
      });
      // 容错：万一一个都没匹配上就别动，避免顶栏空掉被 App 回退成默认全栏
      if (kept.length) {
        kept[0].default_selected = 1; // 默认选中第一个
        if (TAB_INJECT_URI) {
          kept[0].uri = TAB_INJECT_URI; // 【测试】强行注入 deeplink
          kept[0].name = "稍后再看";
        }
        data.tab = kept;
      }
    }

    // 2) 右上角图标 data.top：保留「消息」，再加 收藏夹 + 稍后再看（去掉游戏中心等其它原生项）
    //    （这些位置是「点击跳转新页面」，deeplink 才会正常打开）
    const msg = (Array.isArray(data.top) ? data.top : []).filter(
      (t) => ((t && t.uri) || "").indexOf("im_home") >= 0 // 消息（私信）
    );
    data.top = [
      ...msg,
      { id: 900001, icon: ICON_FAV, name: "收藏夹", uri: FAV_URI, tab_id: "custom_fav", pos: 90 },
      { id: 900002, icon: ICON_LATER, name: "稍后再看", uri: LATER_URI, tab_id: "custom_later", pos: 91 },
    ];

    // 3) 底栏只保留 首页/动态/我的；隐藏右上角 … 菜单
    if (Array.isArray(data.bottom)) {
      data.bottom = data.bottom.filter((t) => {
        const uri = (t && t.uri) || "";
        return BOTTOM_KEEP.some((k) => uri.indexOf(k) >= 0);
      });
    }
    delete data.top_more;
  }

  body = JSON.stringify(obj);
} catch (e) {
  // 解析失败：原样返回，避免影响 App
  body = $response.body;
}

$done({ body });
