# 分镜脚本生成器 Web 产品

这是把 `$storyboard` skill 产品化后的本地/服务器 Web 应用。前端提供表单、分步生成、Markdown 编辑预览和下载入口；后端负责 Kimi 调用、项目保存、Markdown 输出和沿用现有 `scripts/generate_docx.py` 导出 Word。

## 功能

- 项目信息表单：客户类型、影片类型、时长、比例、风格、参考样片、品牌资产。
- 内容单元管理：动态添加产品、景点、服务、案例等内容单元。
- 分步生成：参考方向、内容逻辑、创意主轴、旁白文案、分镜表、制作建议、提案摘要。
- 最终稿编辑：右侧 Markdown 可直接改，预览区会同步渲染。
- 文件导出：生成 `.md` 和 `.docx`，Word 导出逻辑暂时保持原样。

## Docker 部署

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 编辑 `.env`：

```env
LLM_API_KEY=你的模型_API_Key
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
LLM_MODEL=glm-5.1
APP_PORT=8000
```

3. 启动：

```bash
npm --prefix frontend install
npm --prefix frontend run build
docker compose up --build -d
```

4. 访问：

```text
http://服务器IP:8000
```

`outputs/` 会挂载到容器内 `/app/outputs`，容器重建后项目状态和导出文件不会丢失。

## 本地开发

后端：

```bash
cd C:\Users\Administrator\Desktop\storyboard
python -m venv .venv
.venv\Scripts\activate
pip install -r backend\requirements.txt
uvicorn backend.main:app --reload
```

前端：

```bash
cd frontend
npm install
npm run dev
```

开发时前端默认运行在 `http://localhost:5173`，并将 `/api` 代理到 `http://localhost:8000`。

## 验收步骤

- 打开 `/api/health`，返回 `{"status":"ok"}`。
- 打开页面顶部能看到 Kimi 配置状态。
- 未配置 `KIMI_API_KEY` 时，生成按钮不可用并提示服务器未配置。
- 填写项目信息和内容单元后，点击保存，`outputs/{project_id}/project.json` 会生成。
- 配置 Kimi 后依次生成 7 个步骤，每一步可编辑和确认。
- 导出 Markdown 后可下载 `.md` 文件。
- 导出 Word 后可下载 `.docx` 文件。

## 安全说明

第一版不做登录，适合内网或受防火墙保护的服务器使用。如果需要公网访问，建议在 Nginx、宝塔、Caddy 或云厂商网关层增加 Basic Auth、IP 白名单或 VPN 访问控制。
