/*
 * 两步路户外助手 净化脚本（QuantumultX script-response-body）
 */

// ============================================================
// 诗词数据（按 queryType 分 tab，每 tab 3 首）
// ============================================================
const TAB_POEMS = {
  0: [ // 推荐
    { title:"小径红稀，芳郊绿遍，高台树色阴阴见。", author:"晏殊" },
    { title:"行乐直须年少，尊前看取衰翁。",         author:"欧阳修" },
    { title:"池上碧苔三四点，叶底黄鹂一两声。日长飞絮轻。",     author:"晏殊" }
  ],
  1: [ // 视频
    { title:"两岸猿声啼不住，轻舟已过万重山。", author:"李白" },
    { title:"飞流直下三千尺，疑是银河落九天。", author:"李白" },
    { title:"举头望明月，低头思故乡。",         author:"李白" }
  ],
  2: [ // 动态
    { title:"会当凌绝顶，一览众山小。", author:"杜甫" },
    { title:"烽火连三月，家书抵万金。", author:"杜甫" },
    { title:"随风潜入夜，润物细无声。", author:"杜甫" }
  ],
  3: [ // 游记
    { title:"空山新雨后，天气晚来秋。", author:"王维" },
    { title:"行到水穷处，坐看云起时。", author:"王维" },
    { title:"深林人不知，明月来相照。", author:"王维" }
  ],
  4: [ // 热点
    { title:"采菊东篱下，悠然见南山。", author:"陶渊明" },
    { title:"问君何能尔，心远地自偏。", author:"陶渊明" },
    { title:"此中有真意，欲辨已忘言。", author:"陶渊明" }
  ],
  5: [ // 话题
    { title:"山光悦鸟性，潭影空人心。", author:"常建" },
    { title:"松风吹解带，山月照弹琴。", author:"王维" },
    { title:"横看成岭侧成峰，远近高低各不同。", author:"苏轼" }
  ]
};
// ============================================================

const url = ($request && $request.url) || "";
let body = $response.body;

try {
  const p = url;

  // === 首页「推荐」流 ===
  if (p.indexOf("/dynamic/recommandDynamicList") >= 0) {
    const o = JSON.parse(body);
    if (o && Array.isArray(o.dynamicInfos)) {
      for (let i=0;i<o.dynamicInfos.length;i++) { o.dynamicInfos[i].title="T_推荐流"; o.dynamicInfos[i].text="T_推荐流"; }
    }
    body = JSON.stringify(o);
  }

  // === 关注流 ===
  else if (p.indexOf("/feed/list") >= 0) {
    const o = JSON.parse(body);
    if (o) { o.data = []; }
    body = JSON.stringify(o);
  }

  // === 推荐/视频/动态/游记/热点/话题 6tab 流 ===
  else if (p.indexOf("/outing/reqFoundNewList") >= 0) {
    function makePoem(pm, idx) {
      const userObj = { userId:0, userName:"poet", nickName:pm.author, picId:0, level:1, fanType:0 };
      const ti = { id:idx+1, title:pm.title, brief_content:"", promulgator:userObj, issue_time:0, browse_count:0, comment_count:0, pics:[], url:"", cityId:0, praiseNum:0 };
      return { id:idx+1, user:userObj, userSettingInfo:null, typeInfo:JSON.stringify(ti), type:13, subType:0, isPraised:0, isTop:0, time:0, topTime:null };
    }
    var qt = 0;
    var qtm = p.match(/queryType=(\d+)/);
    if (qtm) qt = parseInt(qtm[1], 10);
    var isFirstPage = p.indexOf("loadType=2") < 0;
    var poems = isFirstPage ? (TAB_POEMS[qt] || TAB_POEMS[0]) : [];
    const o = JSON.parse(body);
    if (o && Array.isArray(o.foundNewListInfos)) {
      o.foundNewListInfos = poems.map(function(pm, i) { return makePoem(pm, i); });
    }
    body = JSON.stringify(o);
  }

  // === 首页运营卡片 ===
  else if (p.indexOf("/outing/reqIndex") >= 0) {
    const o = JSON.parse(body);
    if (o) { o.modules = []; }
    body = JSON.stringify(o);
  }

  // === 活动 tab 模块 + 周边列表 ===
  // 公共占位 outing item：字段齐全，枚举合法，文本/URL 字段无意义
  else if (p.indexOf("/outing/reqOutingIndex") >= 0 ||
           p.indexOf("/outing/reqAroundBusiOutingBriefInfoList") >= 0) {

    if (p.indexOf("/outing/reqOutingIndex") >= 0) {
      const o = JSON.parse(body);
      if (o) {
        // 注入与原始相同 type 的所有模块，每个 data 填一个无意义 outing
        // type=1 保险无 data；type=7/9/10/11 有 data（活动卡片列表）
        // 只保留赛事（type=10），其余 type 全不注入
        o.modules = o.modules.filter(function(m) { return m && m.type === 10; });
      }
      body = JSON.stringify(o);
    } else {
      body = JSON.stringify({ errCode: "0", outings: [], total: 0 });
    }
  }

  // === 入口配置 ===
  else if (p.indexOf("/getAppEntranceConfig") >= 0) {
    body = JSON.stringify({ configData:"{}", errCode:"0" });
  }

  else if (p.indexOf("/communityArticle/") >= 0 || p.indexOf("/proSpecial/allData") >= 0 || p.indexOf("/greenPea/queryTasks") >= 0) {
    body = JSON.stringify({ errCode:"0", data:[] });
  }

  // === 需保留结构的接口（导航/搜索/我的页/广告）===
  else if (p.indexOf("/app/getNavigationBar") >= 0) {
    const o = JSON.parse(body);
    if (o && Array.isArray(o.data)) { const rec=o.data.filter(function(t){return t&&t.name==="推荐"}); if(rec.length){rec[0].sort=0;o.data=rec;} }
    body = JSON.stringify(o);
  }
  else if (p.indexOf("/app/getSearchPromptWords") >= 0 || p.indexOf("/app/getRecommendWords") >= 0) {
    const o = JSON.parse(body); o.data=null; body=JSON.stringify(o);
  }
  else if (p.indexOf("/search/searchHotKeyList") >= 0) {
    const o = JSON.parse(body); o.data=[]; body=JSON.stringify(o);
  }
  else if (p.indexOf("/promote/getAppUserModule") >= 0) {
    const o = JSON.parse(body);
    if (o && Array.isArray(o.data)) { o.data=o.data.filter(function(m){return m&&m.name==="户外工具"}); }
    body = JSON.stringify(o);
  }
  else if (p.indexOf("/advert/getAllAdInfo") >= 0) {
    const o = JSON.parse(body); o.data={}; body=JSON.stringify(o);
  }
  else if (p.indexOf("/advert/getAdInfo") >= 0) {
    const o = JSON.parse(body); o.data=null; body=JSON.stringify(o);
  }

} catch (e) {}

$done({ body });
