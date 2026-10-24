# Markdown 编译最小示例

从引擎根目录运行，不需要图片、联网或 API 密钥：

```sh
node tools/authoring/compile-markdown.mjs --config examples/minimal-markdown/compiler.json
node packages/cli/bin/story.mjs validate build/minimal-markdown/story.json
```

配置路径相对于配置文件；命令行显式路径相对于当前目录。可用 `--out` 覆盖配置的输出位置。`--source`、`--out` 和故事 `id` 必须给出；`id/version/title/locale` 可以直接写配置，也可置于 `metadata`。`--portraits`、`--stage` 可省略；省略舞台时生成空在场快照，不根据角色名字推断入镜。

本例的 `portraits.json` 只登记姓名与别名，没有图片。`stage.json` 明确两人左右站位；配置把历史在场 ID `attendant` 映射为 `guide`，把条件用语“记下车次”映射为显式标签 `noted`。这些映射都属于示例配置，编译器不内置游戏角色或标签。

现有语法保持不变：`## ID 标题` 分章，`@场景/音乐/环境音/视点/线/记录/立绘` 标注章节，`【旁白】/【动作】/【角色】` 写正文；选项使用 `{变量增量} [标签]`、`[?条件]` 或 `[?!禁用条件:原因]`，用 `【反馈 A/角色】` 写该选项独立反馈。`【分支】` 按从上到下顺序判断，必须有 `[*]` 默认目标。比较、`且/或/!`、`visited 节点ID` 沿用原语义；括号仅支持原有全角原子括号，不增加表达式语法。

角色表中的 `portrait/expressions/poses/variants` 是相对于 `--assets-root`（默认角色表所在目录）的本地栅格图片路径。文件编译会检查引用图片存在，输出故事保留其相对路径；编译不会复制图片。图像目录名不固定。

选择 A 会记录标签并显示站务员反馈，抵达“下一程”；选择 B 保持空标签，抵达“再等一班”。测试始终从新会话走真实选择。

也可直接调用同步纯函数，避免创建临时项目目录：

```js
import { compileMarkdown } from '../../tools/authoring/compile-markdown.mjs';
const story = compileMarkdown(markdownText, {
  id: 'my-story', version: '1.0.0',
  portraits: portraitManifest, stage: stagePlan,
  tagAliases: {}, characterAliases: {},
});
```

`compileMarkdownFile(options)` 是同一工具的异步文件入口。纯函数不读文件、不写文件，文件入口读取显式参数并只在全部编译和图片检查成功后写出故事。
