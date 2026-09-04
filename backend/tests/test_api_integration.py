"""
REST API 集成测试
==================
通过 httpx ASGITransport 直接驱动 FastAPI 应用, 覆盖:
  - 健康检查 / bootstrap
  - 文档 CRUD 与溯源链 (content 变更写 OpLog, verify 通过)
  - 导出 Markdown (含溯源元数据)
  - 水印检测 + 记录留痕 (WatermarkRecord + watermark_checked 日志)
  - 文献检索 / 引文生成
  - Agent 触发 (research 检索真实文献 / supervisor 学术审查)

数据库: 复用 SQLite 文件库 (conftest 已初始化表与种子数据)。
测试使用随机 UUID 创建独立文档, 避免污染演示数据。
"""

import asyncio
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture
def demo_doc_id() -> str:
    return "00000000-0000-4000-8000-0000000000a1"


async def _create_doc(client: AsyncClient) -> str:
    """创建独立测试文档, 返回 doc_id"""
    resp = await client.post(
        "/api/documents",
        json={
            "title": f"测试文档-{uuid.uuid4().hex[:8]}",
            "owner_id": "00000000-0000-4000-8000-000000000001",
            "content": "",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# 基础服务
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_bootstrap(client, demo_doc_id):
    resp = await client.get("/api/bootstrap")
    body = resp.json()
    assert resp.status_code == 200
    assert body["demo_doc_id"] == demo_doc_id
    assert len(body["documents"]) >= 1
    assert "content" in body["documents"][0]


# ---------------------------------------------------------------------------
# 文档 CRUD + 溯源链
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_document_create_update_provenance(client):
    doc_id = await _create_doc(client)

    # 更新内容 -> 应写入 insert 日志
    r1 = await client.patch(
        f"/api/documents/{doc_id}",
        json={
            "content": "第一段内容。",
            "operator_id": "00000000-0000-4000-8000-000000000001",
        },
    )
    assert r1.status_code == 200
    assert r1.json()["content"] == "第一段内容。"

    # 再次更新 -> replace 日志
    r2 = await client.patch(
        f"/api/documents/{doc_id}",
        json={
            "content": "第一段内容。第二段内容。",
            "operator_id": "00000000-0000-4000-8000-000000000001",
        },
    )
    assert r2.status_code == 200

    # 溯源链应有 2 条日志且校验通过
    logs = (await client.get(f"/api/watermark/documents/{doc_id}/provenance")).json()
    assert len(logs) == 2
    assert [l["op_type"] for l in logs] == ["insert", "replace"]

    verify = (await client.get(f"/api/watermark/documents/{doc_id}/provenance/verify")).json()
    assert verify["valid"] is True
    assert verify["checked"] == 2


@pytest.mark.asyncio
async def test_export_markdown(client, demo_doc_id):
    resp = await client.get(f"/api/documents/{demo_doc_id}/export")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/markdown")
    text = resp.text
    assert text.startswith("# ")
    assert "溯源哈希链校验" in text
    # 正文不应残留 HTML 标签
    assert "<author" not in text


# ---------------------------------------------------------------------------
# 水印检测 + 留痕
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_detect_text_watermark(client):
    resp = await client.post(
        "/api/watermark/detect", json={"text": "一段普通的人类创作文本内容，用于检测。" * 3}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "is_ai_generated" in body
    assert "confidence" in body


@pytest.mark.asyncio
async def test_document_watermark_detect_persists(client):
    doc_id = await _create_doc(client)
    await client.patch(
        f"/api/documents/{doc_id}",
        json={"content": "人类创作的检测文本段落。" * 2,
              "operator_id": "00000000-0000-4000-8000-000000000001"},
    )

    # 文档级检测: 写入 WatermarkRecord + watermark_checked 日志
    resp = await client.post(f"/api/watermark/documents/{doc_id}/detect")
    assert resp.status_code == 200
    assert resp.json()["model_name"] == "kirchenbauer-v1"

    records = (await client.get(f"/api/watermark/documents/{doc_id}/records")).json()
    assert len(records["records"]) == 1

    logs = (await client.get(f"/api/watermark/documents/{doc_id}/provenance")).json()
    assert logs[-1]["op_type"] == "watermark_checked"

    # 哈希链在追加检测日志后仍然完整
    verify = (await client.get(f"/api/watermark/documents/{doc_id}/provenance/verify")).json()
    assert verify["valid"] is True


# ---------------------------------------------------------------------------
# 文献检索
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_literature_search_and_citation(client):
    resp = await client.get("/api/literature/search?q=watermark&limit=10")
    assert resp.status_code == 200
    body = resp.json()
    # 统一响应信封: {status, message?, data: SearchPaper[]} (arXiv 在线优先,
    # 本地降级), 与前端 searchLiterature 消费的格式一致
    assert body["status"] == "success"
    items = body["data"]
    assert len(items) >= 1
    # 命中结果应包含水印相关文献
    titles = " ".join(i["title"] for i in items).lower()
    assert "watermark" in titles

    # 引文生成 (GB/T 7714): 引文接口面向本地库文献 (UUID 主键);
    # 在线 arXiv 命中项的 id 为 arXiv 编号不走此路径, 故用空关键词
    # 取本地入库文献做断言 (结果确定性不依赖网络)
    local = (await client.get("/api/literature/search?q=&limit=10")).json()
    assert local["status"] == "success" and local["data"]
    lit_id = local["data"][0]["id"]
    cite = (await client.get(f"/api/literature/{lit_id}/citation")).json()
    assert cite["citation"].endswith(".")
    assert cite["bibtex"].startswith("@article") or cite["bibtex"].startswith("@misc")


@pytest.mark.asyncio
async def test_literature_empty_search_returns_seed(client):
    resp = await client.get("/api/literature/search?q=&limit=10")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "success"
    # 空关键词 -> 本地文献库最近入库文献 (种子语料 9 条, limit=10)
    assert len(body["data"]) >= 8


# ---------------------------------------------------------------------------
# 并发写入回归 (缺陷 D1): 并发 PATCH + 水印检测不得 500, 溯源链保持 valid
# 背景: op_logs.current_hash 有 UNIQUE 约束, 并发追加若读到相同链尾会算出
#       相同哈希, 违反约束 -> 500 且断链。修复后同文档追加被串行化。
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_concurrent_writes_no_500_and_chain_valid(client):
    """并发向同一文档追加溯源链日志: 不返回 500, verify 仍为 valid"""
    doc_id = await _create_doc(client)
    demo_user = "00000000-0000-4000-8000-000000000001"

    # 先写入一段正文, 建立链首 (insert 日志)
    r0 = await client.patch(
        f"/api/documents/{doc_id}",
        json={"content": "并发写入前的正文内容。", "operator_id": demo_user},
    )
    assert r0.status_code == 200

    async def do_patch(i: int):
        return await client.patch(
            f"/api/documents/{doc_id}",
            json={"content": f"并发写入正文内容-{i}。", "operator_id": demo_user},
        )

    async def do_detect():
        return await client.post(f"/api/watermark/documents/{doc_id}/detect")

    # 混合并发: 内容 PATCH x2 + 水印检测 x2 (水印检测的 operation 相同,
    # 并发时最容易算出相同哈希, 是 D1 的最短复现路径)
    results = await asyncio.gather(
        do_patch(1),
        do_detect(),
        do_patch(2),
        do_detect(),
        return_exceptions=True,
    )
    for r in results:
        assert not isinstance(r, Exception), f"并发请求异常: {r!r}"
        assert r.status_code < 500, f"并发写入返回 {r.status_code}: {r.text}"

    # 1 (insert) + 2 (replace) + 2 (watermark_checked) = 5 条日志
    logs = (await client.get(f"/api/watermark/documents/{doc_id}/provenance")).json()
    assert len(logs) == 5, f"日志条数异常: {len(logs)}"

    verify = (await client.get(f"/api/watermark/documents/{doc_id}/provenance/verify")).json()
    assert verify["valid"] is True
    assert verify["checked"] == 5


# ---------------------------------------------------------------------------
# Agent 编排
# ---------------------------------------------------------------------------
async def _wait_for_messages(
    client: AsyncClient, session_id: str, expected_total: int, timeout: float = 60.0
) -> dict:
    """轮询会话消息直至达到期望条数 (invoke 返回 202, 编排在后台任务中执行)"""
    deadline = asyncio.get_running_loop().time() + timeout
    body: dict = {"total": -1}
    while asyncio.get_running_loop().time() < deadline:
        body = (await client.get(f"/api/agents/sessions/{session_id}/messages")).json()
        if body["total"] >= expected_total:
            return body
        await asyncio.sleep(0.05)
    raise AssertionError(
        f"会话 {session_id} 消息在 {timeout}s 内未达到 {expected_total} 条 "
        f"(当前 {body.get('total')})"
    )


@pytest.mark.asyncio
async def test_agent_research_retrieves_real_literature(client, demo_doc_id):
    resp = await client.post(
        "/api/agents/invoke",
        json={
            "doc_id": demo_doc_id,
            "agent_type": "research",
            "instruction": "帮我检索关于 AI 水印 (watermark) 与版权溯源的文献",
        },
    )
    assert resp.status_code == 202
    session_id = resp.json()["session_id"]

    messages = await _wait_for_messages(client, session_id, 1)
    research_msgs = [m for m in messages["messages"] if m["agentType"] == "research"]
    assert len(research_msgs) == 1
    content = research_msgs[0]["content"]
    # 真实检索结果 (arXiv 实时 或 本地文献库), 带来源标注与条目列表
    assert "【文献检索结果" in content
    assert "来源:" in content
    assert "- (" in content  # 至少一条检索条目


@pytest.mark.asyncio
async def test_agent_supervisor_review(client, demo_doc_id):
    resp = await client.post(
        "/api/agents/invoke",
        json={
            "doc_id": demo_doc_id,
            "agent_type": "supervisor",
            "instruction": "审查当前草稿是否符合学术规范",
        },
    )
    assert resp.status_code == 202
    session_id = resp.json()["session_id"]

    messages = await _wait_for_messages(client, session_id, 1)
    sup_msgs = [m for m in messages["messages"] if m["agentType"] == "supervisor"]
    assert len(sup_msgs) == 1
    assert "导师审稿意见" in sup_msgs[0]["content"]
