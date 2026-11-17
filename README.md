# 行为特征分析与事件溯源平台

面向用户行为打点采集、事件参数规范、会话重放、热力图分析、特征工程提取与行为标签体系管理的本地化数据分析应用平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/feature-label-service.ts  行为特征标签版本服务：试算、复核、发布、迁移
│   ├── src/domain/           行为特征向量 / 标签命中 / 发布仲裁的纯计算内核
│   ├── src/components/       FeatureLabelWorkbench：特征工程与行动标签共用的版本工作台
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   ├── scripts/              行为特征标签版本验收脚本
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 事件规范 | `eventspec` | 事件定义 | 事件编号、事件名称、事件类别 |
| 会话重放 | `session` | 会话记录 | 会话编号、用户标识、开始时间 |
| 热力分析 | `heatmap` | 热力方案 | 方案编号、目标页面、点击热力图 |
| 特征工程 | `feature` | 特征模板 | 模板编号、特征名称、特征类型 |
| 行动标签 | `action` | 标签规则 | 规则编号、标签名称、标签类别 |
| 路径分析 | `pathmap` | 路径模型 | 模型编号、起始页面、终止页面 |
| 事件溯源 | `eventtrace` | 事件链路 | 链路编号、事件链序列、链长度 |
| 时段分析 | `timewindow` | 时段配置 | 配置编号、时段名称、起始时分 |
| 设备分析 | `device` | 设备画像 | 画像编号、设备类型、操作系统 |
| 异常检测 | `anomaly` | 检测器 | 检测器编号、监控事件、异常模式 |
| 群组对比 | `cohortcmp` | 对比任务 | 任务编号、群组A、群组B |
| 漏斗诊断 | `funnel` | 诊断报告 | 报告编号、漏斗名称、步骤定义 |
| 浏览深度 | `scrollmap` | 深度分析 | 分析编号、页面名称、首屏占比 |
| 表单分析 | `formfield` | 表单诊断 | 诊断编号、表单名称、总字段数 |
| 点击流 | `clickstream` | 点击序列 | 序列编号、用户标识、起始时间 |
| 回访分析 | `retention` | 回访模式 | 模式编号、用户分群、首次访问窗口 |
| 数据视图 | `dataview` | 分析视图 | 视图编号、视图名称、数据源组合 |
| 参数字典 | `paramdef` | 参数定义 | 参数编号、参数名称、参数类型 |

## 行为特征标签版本

特征工程与行动标签两个页面底部共用 `FeatureLabelWorkbench`，把「特征模板 + 标签规则」绑定成
一次可复算的版本，并按同一业务版本复核后发布。数据单独存放在
`behavior-event-trace-hub:feature-label`，与 18 个模块的登记数据分开。

- **试算与绑定**：同一模板版本、业务版本、输出字段与标签规则版本生成唯一绑定键，样本向量由这些
  输入确定性生成；标签命中、覆盖率与特征模板版本一起写进命中结果，向量摘要 `VD-xxxx` 参与复核。
- **按同一业务版本复核**：模板版本、规则版本、绑定键、向量摘要、覆盖率、标签命中数逐项重算比对；
  任何一项对不上，发布会被拒绝。
- **字段争用仲裁**：同一输出字段全局一次只允许完整发布一份命中结果（跨业务版本同样成立）。
  - `模板发布完成顺序`：先完成发布的模板保留命中结果，另一模板收到字段冲突单并保留草稿。
  - `字段占用业务顺序`：字段归属顺序更靠前的模板替换结果，被替换标签进入待迁移清单。
  - 需要换模板占用字段时，先对已发布版本执行「归档释放字段」，再发布新的命中结果。
- **重复提交**：同一绑定键只保留首个命中结果，其余回执进入冲突队列；重复发布同样收冲突单。
- **行动标签消费**：行动标签清单只从已发布的命中结果取行为特征向量，同时保留特征模板版本、
  规则版本、绑定键与向量摘要。

验收脚本覆盖上述全部场景：

```bash
cd frontend
npm run verify:label
```

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 行为特征标签版本的流转只允许在 `src/domain/feature-label.ts` 与 `feature-label-flow.ts` 里改，
  页面与 `feature-label-service.ts` 只做搬运。
- 想回到初始数据：清掉浏览器里 `behavior-event-trace-hub:entries` 这一项，或调用 `resetModule(模块)`；
  行为特征标签版本清 `behavior-event-trace-hub:feature-label`，或点工作台的「重置版本数据」。

领域：数据工程
子方向：数据分析与数据应用
