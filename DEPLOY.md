# 本地构建与 GitHub Pages 部署

## 本地处理照片

1. 把原始照片放进 `raw_images/`。这个目录已被 `.gitignore` 忽略，不会上传到 GitHub。
2. 首次运行 `npm install` 安装 Sharp。
3. 运行 `npm run build`。脚本会识别横竖比例、生成自适应宝丽来边框、转为 WebP，并更新 `public/data.json`。
4. 运行 `npm run serve`，然后打开 <http://localhost:8000> 预览。

## 本地一键上传

`npm run serve` 现在会启动仅绑定 `127.0.0.1` 的本地管理服务。打开相册后，右上角会出现“＋上传回忆”：

1. 拖入照片并填写标题、日期和故事。
2. 本地服务把原图保存到被 Git 忽略的 `raw_images/`。
3. Sharp 自动重建 WebP、白边和 `public/data.json`。
4. 成功后服务自动执行 `git add`、`git commit` 和 `git push`，页面随后刷新。

上传期间请保持终端窗口开启，并确保 Git 已登录、当前分支可正常 push。该接口使用本地会话令牌，并且不会监听局域网地址。

## 添加背景音乐

将你自己的 MP3 音乐命名为 `bgm.mp3`，放到 `public/audio/bgm.mp3`。播放器默认音量为 35%、循环播放，并会在用户首次点击照片或翻页按钮时尝试淡入。音乐文件需要一并提交到 GitHub 才能在 Pages 上播放；请确认你拥有该音乐的公开使用权。

`public/` 是完整的部署成品，需要提交到 Git。新增或替换原图后，再次运行 `npm run build` 即可更新。

## 整理事件与关联照片

每条 `public/data.json` 记录都可以填写 `tag`、`location`、`story`，并通过可选的 `subImages` 关联同一事件的副图。副图放入 `public/images/`，然后填写相对于 `public/` 的路径，例如：

```json
"tag": "#毕业&散伙",
"location": "学校礼堂",
"story": "大家聊到很晚才舍得离开。",
"subImages": ["./images/graduation-02.webp", "./images/graduation-03.webp"]
```

`npm run build` 会保留这些字段和非 `memory-数字.webp` 的副图。网站会从 `tag` 自动生成筛选胶囊；按 `/` 搜索，按 `Space`/`Enter` 查看事件详情，按 `D` 导出当前明信片。

## 推送和开启 GitHub Pages（4 步）

```bash
git init && git add . && git commit -m "Build graduation memories gallery"
git branch -M main && git remote add origin https://github.com/YOUR_NAME/YOUR_REPOSITORY.git
git push -u origin main
```

然后进入 GitHub 仓库的 **Settings → Pages → Build and deployment**，把 **Source** 设为 **GitHub Actions**。仓库内的 `.github/workflows/deploy-pages.yml` 会自动发布 `public/`。

以后更新只需：

```bash
npm run build
git add public index.html package.json package-lock.json scripts .github
git commit -m "Update memories"
git push
```

> 浏览器编辑器保存的数据位于 localStorage，不会自动写回磁盘。整理完成后点击“导出 JSON”，用下载的文件替换 `public/data.json`，再运行一次 `npm run build`。脚本会保留标题、年份、活动与日期，并把新的标签重新合成到白色边框里；提交 `public/` 后所有访客即可看到。
