---

# 📡 VRChat Login Monitor

一个基于 **WebSocket** 的 VRChat 监听服务端程序，支持长时间运行并根据用户自定义规则进行消息推送。

提供简洁的 **Web Dashboard**，支持多用户使用。

---

## ✨ 功能特性

* 🔌 使用 WebSocket 连接 VRChat 服务器进行实时监听
* ⏱ 支持长期运行的自动监听机制
* 🔔 基于规则的消息推送
* 👥 支持多用户管理
* 🖥 内置 Web Dashboard
* 🐳 支持 Docker 一键部署

---

## 🌐 在线示例

👉 已部署实例：
[https://monitor.wenwen12305.top:2053](https://monitor.wenwen12305.top:2053)

---

## ⚠️ 安全说明（务必阅读）

为了实现监听功能：

> ⚠️ **您的 Token 将被存储在服务端**

这意味着：

* 服务器拥有者 **理论上可以访问您的账户信息**
* 甚至可能直接登录您的账号

👉 建议：

* 谨慎使用公共实例
* **强烈建议自行部署**

---

## 🚀 快速开始（本地部署）

### 1️⃣ 环境要求

* Node.js >= 22

---

### 2️⃣ 获取项目

```bash
git clone <your-repo-url>
cd <project-folder>
```

---

### 3️⃣ 安装依赖

```bash
npm install
npm --prefix web install
```

---

### 4️⃣ 构建前端

```bash
npm run web:build
```

---

### 5️⃣ 启动服务

```bash
npm start
```

---

## 🐳 Docker 部署（推荐）

项目已内置 Docker 配置，可直接构建运行。

### 关键点：

👉 **必须持久化数据目录**

```text
/app/data
```

否则数据（包括配置和用户信息）会丢失。

---

## ⚙️ 配置文件

配置文件路径：

```text
/data/config.toml
```

### 示例配置：

```toml
ADMIN_PASSWORD = "123456" # 管理员密码
PORT = 3688              # 服务运行端口
```

---

## 🔐 HTTPS 支持

可以通过在 `/data` 目录放入证书启用 HTTPS：

```text
/data/ssl.crt
/data/ssl.key
```

* 存在 → 启用 HTTPS
* 不存在 → 使用 HTTP

---

## ⚠️ 多账号使用建议

虽然支持多用户：

> ⚠️ 不建议在单台设备运行过多账号

否则可能触发 VRChat 的限制机制。

---

## 🙏 致谢

本项目基于以下 SDK：

👉 [https://github.com/vrchatapi/vrchatapi-javascript](https://github.com/vrchatapi/vrchatapi-javascript)

感谢 VRChat API 提供支持 🙌

---
