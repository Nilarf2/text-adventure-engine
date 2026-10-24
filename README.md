# Text Adventure Engine

An independent, Web-first foundation for deterministic text adventures. The core has no DOM, filesystem, network, clock, or ambient randomness dependency. User interface, audio, storage, and game-specific systems plug in through adapters and modules.

## Requirements

- Node.js 20.19 or newer
- npm 10 or newer

## Setup

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run check:flow
```

## Packages

- `@text-adventure/module-api`: shared story, runtime, module, and save types
- `@text-adventure/content`: JSON validation, graph diagnostics, and compilation
- `@text-adventure/core`: deterministic session runtime
- `@text-adventure/save`: snapshot validation and save stores
- `@text-adventure/web-adapter`: browser audio and local storage adapters
- `@text-adventure/cli`: content inspection and validation commands

## Content commands

```sh
npm run story -- validate path/to/story.json
npm run story -- validate path/to/story.json --json
npm run story -- inspect path/to/story.json
npm run story -- compile path/to/story.json --out build/story
```

Story files use `packages/content/schema/story.schema.json`; `validateStory` adds reference checks and plugin-aware validation beyond JSON Schema. A Chinese blank authoring template is at `templates/剧情填写模板.md`.

## Runtime example

```ts
import { compileStory } from "@text-adventure/content";
import { createSession } from "@text-adventure/core";

const compiled = compileStory(story);
const session = createSession(compiled, { seed: 42 });
const first = session.start();
console.log(first.view);
const next = session.dispatch({ type: "continue" });
```

Commands are synchronous and deterministic. A command either commits one state revision with events/effects or throws without changing session state. The host applies returned effects. Plugin calls pause as a serializable request; a matching `module.result` command resumes the story.

## Validation scope

Focused checks cover transactional runtime behavior, snapshots, content validation, browser adapter races, offline art tools, and two real example routes. CI runs the same compact checks; it does not run load tests or claim multi-device visual coverage.

## 中文制作流程与工具

[完整中文制作流程](docs/WORKFLOW.zh-CN.md)说明设计、权威源与产物、分支接线、显式舞台、美术一致性、完整头发/头纱/手/道具、可视化审阅、真实路线、多端打包、隐私清理与发布前人工审阅。

- [最小可运行示例](examples/minimal/README.md)：`npm run example:build` 后用静态 HTTP 服务打开 `build/minimal/`；`npm run check:example` 验证两条实际路线。
- [Markdown 编译示例](examples/minimal-markdown/README.md)：`npm run example:markdown` 生成可验证的故事 JSON；章节、选项反馈、标签与显式舞台均由输入文件配置。
- [剧情地图、立绘审核与路线工具](tools/authoring/README.md)：显式 `--story/--manifest/--out`，不依赖某个游戏目录。
- [通用生图客户端与离线抠图](tools/image/README.md)：默认无网络预览；真正生成需显式 `--execute`。无提供方或模型硬编码、无自动下载。
- [通用提示词模板](templates/prompts/)：游戏专属正文、角色基准、参考图和提示词留在游戏项目。

`core` imports `@text-adventure/save` for shared snapshot validation. Browser/vendor deployments must include all five runtime packages (`module-api`, `content`, `save`, `core`, `web-adapter`) from the same engine build. Public import names are unchanged.

## License

Code, documentation, prompt templates, and the original minimal examples in this repository are available under the [MIT License](LICENSE). Images, stories, fonts, or other material supplied to the tools keep their own licenses; this repository does not grant rights to third-party inputs or guarantee rights in a provider's output.
