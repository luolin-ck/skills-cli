# ck-skills

[English](README.md) · [维护与恢复](MAINTENANCE.zh-CN.md) · [变更日志](CHANGELOG.zh-CN.md)

通过本机 Codex 或 Claude Code 安装、升级、卸载和调用作者已登记的 skill。CLI 版本 **0.1.0** 与各 skill 的版本分别管理。初始目录包含 [aesthetic-design](https://github.com/luolin-ck/aesthetic-design)；后续 skill 通过审查后的目录修改及 CLI 新版本加入，不会自动发现作者账户下的全部仓库。

## 安装 CLI

请使用仍受支持的 Node.js LTS 版本，**最低 Node 22**，并确保 PATH 中有 Git。不包含 npm 运行时依赖、安装钩子、模型密钥或后台更新器。

```sh
npm install -g --ignore-scripts 'git+https://github.com/luolin-ck/skills-cli.git#v0.1.0'
ck-skills --version
ck-skills --help
```

Git URL 安装的是这个公开仓库，无须发布 npm registry 包。卸载 CLI 本身使用 `npm uninstall -g @luolin-ck/skills-cli`。卸载 CLI 会保留已安装 skill；需要安全卸载这些 skill 时，可重新安装 CLI。

本次在 macOS arm64、Node 24 上测试。设计上可兼容 Linux，但尚未在 Linux 运行；拒绝原生 Windows，WSL/Linux 也未经验证。Git 访问需要正常 HTTPS 连接；自定义 Git 配置会被刻意隔离，不会通过关闭 TLS 校验解决连接问题。

## 管理 skill

命令默认使用 `--agent codex --scope user`：

```sh
ck-skills list
ck-skills install aesthetic-design
ck-skills update aesthetic-design
ck-skills use aesthetic-design -- '将这个设计与包豪斯和瑞士国际主义风格进行比较。'
ck-skills uninstall aesthetic-design
```

Claude Code 添加 `--agent claude`。若只安装到一个现有项目，使用 `--scope project --project <directory>`：

```sh
ck-skills install aesthetic-design --agent claude --scope project --project .
ck-skills use aesthetic-design --agent claude --scope project --project . -- '解释可见的风格及最接近的另一种风格。'
ck-skills update aesthetic-design --agent claude --scope project --project .
ck-skills uninstall aesthetic-design --agent claude --scope project --project .
```

项目范围省略 `--project` 时使用当前目录；用户范围同时指定 `--project` 会被拒绝。使用用户级 skill 时，先 `cd` 到目标工作目录，再执行 `use`。每条命令只管理一个宿主和一个范围，不会隐式操作全部宿主。

| 命令 | 结果 |
| --- | --- |
| `list` | 离线列出已登记目录，以及所选范围的受管理版本、提交与状态；不声称列出的版本已经联网确认为最新。忙碌或中断的管理根报告 `busy-or-recovery`。 |
| `install <skill>` | 安装最新稳定标签；现有受管理副本保持不变，查找后续版本请用 `update`。 |
| `update <skill>` | 将未改动的受管理副本升级到最高稳定版本。同版本同提交不操作；拒绝降级及同版本标签改指其他提交。 |
| `uninstall <skill>` | 只移除该未改动受管理副本及其所有权记录，保留其他 skill、宿主设置和凭证。 |
| `use <skill> -- [prompt]` | 启动本机宿主，初始单一提示包含 skill 调用、准确安装 SKILL 路径和你的文字；不隐式安装或升级。 |

未知名称、选项和缺失参数会失败。提示文字放在 `--` 后；在自己的 shell 中为元字符加引号，如上例。CLI 不把提示文字解释成 shell 代码或额外的宿主参数。

## 安装位置与保护

| 宿主 | 用户范围 | 项目范围 |
| --- | --- | --- |
| Codex | `~/.agents/skills/<name>` | `<project>/.agents/skills/<name>` |
| Claude Code | `~/.claude/skills/<name>` | `<project>/.claude/skills/<name>` |

所有权记录与恢复数据放在 skill 旁边、相应 `skills/.ck-skills/` 下，不写入安装的 skill 内部。保留完整相对布局与字节，不复制 Git 数据库。美学 skill 的公开版含 **9 张图片**，**28 个方向缺少离线视觉参照**；CLI 不下载或再分发私有完整图片集合。请阅读该 skill 自身的限制与第三方许可说明。

- 仅接受随 CLI 登记并审查过的 `luolin-ck` 公开 HTTPS 来源。“最新”是按数字排序的最高稳定 `vMAJOR.MINOR.PATCH` Git 标签，不是主分支或预发布版本。注释标签解析为提交，抓取后的提交必须与选定提交一致。
- 不 checkout，直接读取 Git blob，检查普通文件模式和路径，并校验公开 manifest 的精确文件集合、长度与 SHA-256；不执行下载的校验器、npm 脚本、过滤器或钩子。首个格式契约为 schema-3 `public-conservative` manifest；加入其他格式须审查后发布 CLI 新版。
- 拒绝现有未受管理目录、符号链接、损坏的所有权记录，以及本地修改、新增或缺失的文件。没有强制覆盖或接管选项；请先备份编辑并解决差异，再管理该副本。
- 写操作使用协作锁、暂存区、日志与备份。提交前的普通异常会恢复旧安装及所有权记录。进程中断或残留事务会阻止后续操作，等待[人工恢复](MAINTENANCE.zh-CN.md#中断的操作)。提交后清理失败会保留新版和备份，不回滚已提交安装。
- `use` 在宿主退出前持有所选范围的锁。检查已知用户、项目、祖先目录中的同名副本和可读 frontmatter 别名；遇到歧义或不安全检查则拒绝调用。Git 项目到最近仓库标记为止；非 Git 目录保守检查到文件系统根。不修改宿主配置来消解冲突。

Git 命令超时为120秒；提取包限制为10000个文件、单文件32 MiB、合计128 MiB。这些限制不能完整约束 Git 下载本身的网络或磁盘占用。TLS、固定提交和自描述 manifest 不能证明发布者未被入侵或 skill 内容安全。旁置记录是本机所有权标记，不是密码学凭证；协作锁和路径检查不是防御同用户恶意进程的沙箱。

## 调用与验证限制

使用前请通过 Codex 或 Claude Code 官方 CLI 安装并登录相应宿主。`ck-skills` 继承宿主已有认证、审批、沙箱和网络设置，不降低这些设置。缺少可执行文件会明确失败；子进程非零退出码原样返回，信号退出映射为 `128 + 信号编号`。

终端 Ctrl-C 直接到达同进程组宿主，不重复转发；包装进程等待宿主退出后释放锁。若以程序方式只终止包装进程，请用 SIGTERM，它会转发给宿主。强制终止仍可能需要恢复。

无法在此穷举插件、企业、同步和其他宿主管理来源。带明确 skill 提示启动宿主，不等于证明模型正确激活或遵循 skill；宿主策略仍可能禁用它。本版通过真实本地 mock 可执行文件测试字面 shell 样文字、非零退出与信号，没有运行付费模型会话或测量分类准确率。

宿主官方参考：[Codex skills](https://learn.chatgpt.com/docs/build-skills)、[Codex CLI](https://learn.chatgpt.com/docs/developer-commands)、[Claude skills](https://code.claude.com/docs/en/skills)、[Claude CLI](https://code.claude.com/docs/en/cli-reference)。运行时及安装参考：[Node releases](https://nodejs.org/en/about/previous-releases)、[npm Git installation](https://docs.npmjs.com/cli/v10/commands/npm-install/)。

## 开发

```sh
npm test
npm pack --dry-run
```

请在仓库 checkout 内运行这些开发命令，运行包不含测试。测试使用 Node 内置测试器、真实临时 Git 仓库和标签、显式内部测试上下文、隔离目录与 mock 宿主。不改设 HOME 或 CODEX_HOME，不安装到真实用户 skill，不调用模型，不依赖远端服务。生产参数或环境没有用于替换目录或 home 的测试专用覆盖；仍遵循正常 OS、Node 的 home 解析。版本和真实 Red/Green 证据见[维护约定](MAINTENANCE.zh-CN.md)及[首版变更记录](changes/0.1.0.zh-CN.md)。

原创 CLI 代码、测试和文档使用 [MIT](LICENSE)。安装的 skill 保留各自许可和第三方条件，CLI 不授予其内容的使用权。不暗示与 OpenAI 或 Anthropic 存在关联。
