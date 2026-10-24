# 最小示例

仅包含通用示例文本，不引用任何游戏角色、剧情、美术或服务。

```sh
npm ci --ignore-scripts
npm run build
npm run example:build
npm run check:example
python3 -m http.server 8000 --bind 127.0.0.1 --directory build/minimal
```

打开 `http://127.0.0.1:8000/`。点击继续、选择两条路线之一；可保存、读取或重新开始。`story.json` 是示例剧情权威源，`app.js` 是浏览器宿主；构建输出在 `build/minimal/`，不直接编辑产物。示例依赖浏览器 localStorage；禁用存储时会显示保存/读取错误。

两份 `route-*.json` 通过公开 session API 从开场运行到不同结局，验证结局 ID 与变量；不证明浏览器实际点击、触摸或多端视觉效果。
