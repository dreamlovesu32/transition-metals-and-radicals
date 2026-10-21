# 私有文献导读工作台

当前入口为 `http://127.0.0.1:8765/` 文献导航，阅读为 `/read?article=<id>`。服务仅监听本机。管理员私有审稿入口由账号菜单打开；历史版本只读且按版本隔离正文、原图及批注。公开网站与本机演示身份互不相通。

所有文章复用 `public-site/read.html` 和 `reader-core.js`。`reader-contract.js` 与 `reader_contract.py` 校验同一版本化切图契约；前者供阅读运行时使用，后者供制作和构建检查。`reader-prelude.js` 与 `reader-boot.js` 只维护上下文和加载，`workbench-reader.js` 仅在本机注入只读数据传输。公开构建直接串联完整文件，不再逐个函数抽取。

文章数据从 `articles/*.json` 自动发现；正文优先使用已保存 state，缺失时才解析作者 Markdown。新稿不必改阅读源码或目录白名单。字段、模板及标准 validate/plan/build 入口见[文章模板.md](文章模板.md)。新稿的自动发现与构建均不构成发布许可，公开站仍核验批准名单、revision、正文和完整资源哈希。

默认中文、左文右图；支持单栏、左右互换、可拖动分栏和图片缩放拖动。自动切图使用稳定块ID、配置锚点、上行滞回及正文触底末图兜底；手动切图暂停联动。切图保持倍率并回到目标图左上角；旧异步请求不会覆盖当前图。图像未就绪时隐藏旧图，加载状态位于图视口中央。

旧本地编辑适配器仍可在 `/workbench.html?article=<id>` 访问，并使用相同阅读核心。其编辑/审计接口仅在本机；用户此前关闭的编辑工具保持原配置。`data/backups/` 保存显式编辑前的旧版本。不要把本地编辑页或私有审稿预览当成公开发布目录。

检查纯运行时与会员交互：在本目录运行 `node --test tests/*.test.cjs member-system/*.test.cjs`；需浏览器的历史导航端到端测试默认明确跳过，只有设置 `READ_BROWSER_E2E=1` 才运行，当前视觉验收通过 Codex CUA 完成。契约/发现接口检查：`python -m unittest discover -s tests -p test_article_interface.py -v`。
