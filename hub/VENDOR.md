# hub · agent-autoloop（内置副本）

这个目录是 **agent-autoloop** 的源码副本，中台通过它的 HTTP 接口（`:3350`）派活、收事件、读轮次。

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/KKKKhazix/agent-autoloop` |
| 版本 | **v1.8.3** |
| 提交 | `f2ab502`（2026-11-13，offline tarball） |
| 许可 | MIT（见 `LICENSE`） |
| 与上游差异 | 仅剔除 `.git`、`node_modules`、`*.log`，源码未改动 |

## 为什么放在仓库里

中台离开 hub 就跑不起来（规则、事件、轮次都在 hub 里）。把源码一起打包，是为了：

1. **离线可用**——不依赖上游还在、网络还通；
2. **版本锁定**——中台的接口调用是按 v1.8.3 写的，上游改协议不会悄悄打断；
3. **一处可读**——排查问题时不用再去找"当时装的是哪个版本"。

## 怎么跑

```bash
cd hub
node bin/agent-autoloop.ts up      # 起 hub，默认 :3350
node bin/agent-autoloop.ts status  # 看在线、最近几轮
```

运行时数据（规则、卡片、日志、密钥）**不在这个目录**，而在 `%USERPROFILE%\.agent-autoloop\`：

```
~/.agent-autoloop/
├── config.json      # source.key、各 Agent 的 env
├── rules.json       # 规则
├── hub.db           # 轮次、卡片、投影
├── master.key       # 本机密钥（不要提交）
├── logs/
└── worker/runs/     # 每一轮的 context.json、命令输出
```

## 怎么更新

上游发新版时：

1. 解包新版本到临时目录；
2. 用新内容覆盖 `hub/`（**保留本文件**）；
3. 改掉上面表格里的版本号与提交号；
4. `cd hub && npm test` 跑一遍，确认中台的接口调用没被打断。
