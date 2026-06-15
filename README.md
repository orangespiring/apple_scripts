# apple_scripts

Loon 去广告/净化插件集 — **个人自用**，仅供学习研究。

## 说明

1. 本项目所有内容**仅供学习和研究使用**，不得用于任何违反法律法规的用途。
2. 请不要在中国大陆的任何平台转载、发布本项目中的任何内容。
3. 本项目规则与脚本部分参考了开源社区的成果，详见下方[致谢](#致谢)。
4. 他人基于本项目代码的任何修改、二次发布与本项目无关。
5. 使用本项目所产生的一切后果由使用者自行承担。
6. 直接或间接使用本项目的个人和组织，应在 **24 小时内**完成学习研究并删除全部内容；如有功能需求，请自行开发。
7. 本声明可能随时更新，请定期查阅。

## 目录结构

```
Loon/plugins/     # Loon 插件（.lnplugin）
scripts/          # 共享脚本（.js）
```

## 插件列表

| App | 插件 | 部分功能 |
|-----|------|------|
| 哔哩哔哩 | [BilibiliFeedBlock.lnplugin](Loon/plugins/BiliBili/BilibiliFeedBlock.lnplugin) | 首页/播放页信息流清空 · 搜索页结果过滤 · tab 自定义 |
| 两步路户外助手 | [Lvtu2bulu.lnplugin](Loon/plugins/Lvtu2bulu/Lvtu2bulu.lnplugin) | 首页/搜索/我的页净化 · 推荐流诗词替换 · 广告 SDK 拒绝 |
| 小红书 | [XiaoHongShu.lnplugin](Loon/plugins/XiaoHongShu/XiaoHongShu.lnplugin) | 首页信息流按分类过滤 · 视频下滑阻止 · 首页视频屏蔽 · 解除复制/下载限制 |

## 致谢

本项目参考/引用了以下开源项目，特此致谢（排名不分先后）：

- [@kokoryh/Sparkle](https://github.com/kokoryh/Sparkle) — B 站 gRPC/JSON 去广告脚本（核心基底）
- [@fmz200/wool_scripts](https://github.com/fmz200/wool_scripts) — Loon/QX 配置与通用去广告规则
- [@blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) — 分流规则与重写规则
- [@Script-Hub-Org/Script-Hub](https://github.com/Script-Hub-Org/Script-Hub) — 重写规则格式转换工具
- [@luestr/IconResource](https://github.com/luestr/IconResource) — App 图标资源

