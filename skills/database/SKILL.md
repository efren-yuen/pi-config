---
name: database
description: 通过固定 wrapper 使用 MySQL 的只读 tables、schema、query、explain 能力。
---

# Database skill

固定使用 `/home/efren/.pi/agent/bin/db`，不要直接调用 `mycli`。当前只支持 MySQL 的四种只读操作：

```bash
/home/efren/.pi/agent/bin/db mysql tables
/home/efren/.pi/agent/bin/db mysql schema users
/home/efren/.pi/agent/bin/db mysql query 'SELECT id, name FROM users LIMIT 20'
/home/efren/.pi/agent/bin/db mysql explain 'SELECT id FROM users WHERE id = 1'
```

SQL 参数必须用 shell 引号包裹；SQL 含单引号时改用合适的外层引号，禁止把密码放入命令行。
连接认证使用用户已有的 mycli/MySQL native 机制，本 skill 和 wrapper 不读取、展示或修改连接配置，也不解析 `.env`、`DATABASE_URL` 或凭据文件。

CLI 只做保守的命令形状和 SQL 检查，真正的只读边界仍依赖最小权限数据库账号。查询结果可能包含业务敏感数据；不要把结果中的凭据、个人信息或生产数据复制到上下文、日志或审查报告。

不支持任何写入命令、迁移、导入导出、连接配置修改或 mycli 参数透传。不要直接调用 `mycli`；subagent 只能调用受 permission gate 约束的 `db` CLI。真实数据库查询仅在任务明确要求时执行。
