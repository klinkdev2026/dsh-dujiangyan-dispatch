# 踩坑记录 / Lessons

每一条都是真实运行中遇到的问题。“插件怎么处理”一栏说明它现在是被自动规避了，还是需要驱动方注意。驱动方可以随时调用 MCP 工具 `djy_guide`，拿到同样内容的机器可读版本。

| # | 现象 | 原因 | 插件怎么处理 |
|---|---|---|---|
| 1 | Windows 上，worker 往工作区的某个子目录写文件时报 “访问被拒绝”，但往根目录写没问题 | 沙箱进程运行在 **Low 完整性级别**。Harness 只给工作区根目录打了可继承的 Low 标签，**在打标签之前就已存在的子目录**仍是 Medium 标签 | `djy_session_create` 默认先做预检，列出缺标签的目录并给出修复命令（只读，不会自动修）；worker 提示词里写明“不要改 ACL，报告目录路径即可”；闸门直接拒绝 `icacls /grant`、`/setintegritylevel`、`Set-Acl`、`takeown` 等命令 |
| 2 | worker 先“自作主张”给目录加了完全控制权限，并没有解决问题，还留下一条多余的 ACE | 没有查清原因就修改权限 | 同上：改 ACL 属于环境问题，一律交给驱动方处理；审批手册要求审批人**自己核实**原因，不能相信 worker 的诊断 |
| 3 | 任务一提交就失败：`format v4 message requires a producer-owned source kind` | 会话格式 v4 废弃了 `{ kind: 'plugin' }` 这种消息来源，必须使用生产者自己声明的 kind | 消息来源改为 `{ kind: 'dujiangyan-dispatch', taskId }`；有回归测试 |
| 4 | 任务立刻显示“完成”，但一个工具调用都没有 | `agent.whenIdle()` 在 agent 拿到刚投递的 followup 之前就返回了 | 先等 `agent/status: running` 或 `agent/error`，再等空闲；agent 的报错会写进 `task.result.errors`；有回归测试 |
| 5 | `djy_events_watch` 不带参数调用时报错 “expected nonoptional” | MCP SDK 按原始 schema 校验参数，用 zod 的 `.default()` 声明的字段会被当成必填 | 参数全部改为可选，默认值在处理函数里补上 |
| 6 | 工具参数里的 Windows 路径导致 JSON 解析失败（Bad escaped character） | 反斜杠在 JSON 里是转义字符，经过 shell 传参时又会被处理一遍 | `djy_guide` 和 worker 提示词建议**用正斜杠写路径**（`D:/work/x`），Harness 的工具、pwsh 和闸门都能识别 |
| 7 | 一个 key 上开了多个 worker，频繁出现 429 | 中转网关的 key 常常只允许 3–5 个并发 | 按 provider 分别限制并发（可配置）；遇到 429 时并发减半；熔断后切换到备用模型 |
| 8 | 基准测试的数据噪声大 | 其他 worker 在同时编译或跑测试 | 闸门规定：只有持有 `bench` 锁的任务才能运行基准测试命令；任务提交时声明 `resources: ["bench"]`，就会自动排队 |
| 9 | headless 模式拿不到桌面版的 API key | 桌面版的凭据存在 headless 配置读不到的地方 | 插件运行在桌面版进程内，直接复用桌面版的凭据和模型路由 |
| 10 | 子 agent 的审批请求被悄悄拒绝，你看不到任何弹窗 | 进程内子 agent 的审批策略被固定为 `never`，返回 `ask` 等同于拒绝 | 闸门在内部等待外部审批人的决定，然后直接返回 allow 或 deny；只有根会话在超时后才回退到桌面版弹窗 |
| 11 | 某个模型在渠道的目录里列出来了，实际一调用就失败（例如中转网关上的某个 Gemini 模型返回 400：`Unknown name "anthropic_version"`） | 渠道配置的 API 格式和这个模型不匹配（例如网关配的是 `anthropic-messages` 格式），这类错误重试多少次都一样 | `djy_routes_probe` 用一个极小的真实请求逐个探测模型；会话运行中遇到这类确定性错误（400/401/403/404/422，因上下文过长导致的 400 除外）时，把这条路由停用 30 分钟、重试当前这一步，并沿模型链切换到下一个模型 |
| 12 | 服务端返回 429 时带的 `Retry-After: 2` 没有起作用，重试间隔是 0.5 s、1.1 s、1.9 s | harness 的 openai-completions 适配器没有把 `Retry-After` 透传到错误信息里（`providerRetryAfterMs` 为空），重试的间隔完全由 harness 自己的退避策略决定 | 宝瓶口在拿得到 `Retry-After` 时会遵守它；拿不到时，靠收窄并发和熔断来兜底。用本地模拟服务实测：一个连续 3 次返回 429 后才放行的模型，在约 4 s 内由 harness 重试成功；每次重试都经过准入控制，没有重复重试 |
