# NJU 补选助手

这是一个用于南京大学本科选课平台的 Tampermonkey 单文件抢课脚本。

## 能做什么

- 读取当前轮次的收藏课程，并自动抢课。
- 只对已勾选、尚未选中且明确有空位的课程提交选课。
- 一直挂着就行...

脚本只会发起选课操作，不包含退课、换课或取消收藏功能。

## 如何安装

1. 在 Chrome 浏览器中安装 [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)。
2. [安装脚本](https://raw.githubusercontent.com/Eurus07e/NJU-Course-Grabber/main/nju-course-grabber.user.js)。（或在 Tampermonkey 中点击 “添加新脚本” 并复制粘贴...）
3. 登录选课网站 <https://xk.nju.edu.cn/>，在选课平台中收藏目标教学班。
4. 点击面板中的“读取收藏”，选择需要的课程，点击“开始”。

## 注意事项

- 必须保持电脑开机、浏览器页面打开且登录状态有效；电脑休眠、页面关闭或登录过期后或无法继续运行。
- 平台页面或接口发生变化时，脚本可能需要更新。

## 如果有用就留个 STAR 吧～
