# NOTICE — 来源、许可与第三方二进制

本仓库整体以 **GNU General Public License v2.0**（见 `LICENSE`）发布，因为 `port/`
目录是 GPL-2.0 项目的衍生作品。各部分来源如下：

| 组件 | 来源 | 许可 |
|---|---|---|
| ns2jb 引擎（Stage 2 / acquisition） | kurumuz/ns2jb（GitLab） | GPL-2.0 |
| `port/` 移植层 | slapah/CivSwitch（GitHub fork，提交 `7d422e52`） | GPL-2.0（继承上游） |
| 本仓库的 8 项补丁与新增内容（`docs/`、`save-tools/`、`*.ps1`、`CHANGES.md` 等） | 本仓库作者 | GPL-2.0 |
| 部分随包文件 / 资源 | Gezine | MIT（原文本见 `LICENSE-MIT-Gezine.txt`） |
| `switch1/civswitch-ldn-nx.nro` | xiaolizi23/civswitch-ldn-nx v0.9 | 上游未声明；见下 |

## 第三方二进制再分发说明

`switch1/civswitch-ldn-nx.nro`（1,486,671 字节，v0.9，本包实测验证版）来自上游
[xiaolizi23/civswitch-ldn-nx](https://github.com/xiaolizi23/civswitch-ldn-nx)。
上游未明确给出该二进制的再分发许可，本仓库按「原样、非商业、仅供研究本人设备」附带。
SHA-256（同时见 `switch1/SHA256.txt`）：

```
4E8DDFA4982A8130470D0FCBD236F2954C5EE911F79FF581F4F1ECC01690A2D9
```

若上游作者提出要求，会从本仓库移除该文件。

## 再分发义务（GPL-2.0）

- 保留本 `NOTICE.md` 与 `LICENSE`；
- 保留上游版权声明与出处；
- 以 GPL-2.0 提供完整对应源码（本仓库即源码形式）。
