"""
段落批注 API 测试
==================
覆盖师门共研核心 - 段落级批注:
  - 批注 CRUD (创建 / 列表 / 删除)
  - 校验: para_index 1 起、内容非空
  - 级联删除: 文档删除连带其批注
  - 归属校验: 删除批注需匹配所属文档

数据库: 复用 SQLite 文件库 (conftest 已初始化表与种子数据)。
测试使用随机 UUID 创建独立 "测试文档-" 文档, 由 conftest 会话结束清理。
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _create_doc(client: AsyncClient) -> str:
    """创建独立测试文档, 返回 doc_id"""
    resp = await client.post(
        "/api/documents",
        json={
            "title": f"测试文档-{uuid.uuid4().hex[:8]}",
            "owner_id": "00000000-0000-4000-8000-000000000001",
            "content": "第一段：背景。\n\n第二段：方法。\n\n第三段：结论。",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_comment_crud(client):
    """批注完整生命周期: 创建 -> 列表核查 -> 删除 -> 清空"""
    doc_id = await _create_doc(client)

    # 创建批注
    resp = await client.post(
        f"/api/documents/{doc_id}/comments",
        json={
            "para_index": 2,
            "para_snapshot": "第二段：方法。",
            "author": "test-user",
            "content": "这里的方法缺少对比实验, 建议补充。",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["para_index"] == 2
    assert body["para_snapshot"] == "第二段：方法。"
    assert body["author"] == "test-user"
    assert body["content"] == "这里的方法缺少对比实验, 建议补充。"
    assert body["id"]
    comment_id = body["id"]

    # 列表核查
    resp = await client.get(f"/api/documents/{doc_id}/comments")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["id"] == comment_id
    assert items[0]["para_index"] == 2

    # 删除
    resp = await client.delete(f"/api/documents/{doc_id}/comments/{comment_id}")
    assert resp.status_code == 204

    resp = await client.get(f"/api/documents/{doc_id}/comments")
    assert resp.json() == []


@pytest.mark.asyncio
async def test_comment_validation(client):
    """非法参数被拒绝: para_index 从 1 起, 内容非空"""
    doc_id = await _create_doc(client)
    base = {
        "para_index": 1,
        "para_snapshot": "第一段：背景。",
        "author": "test-user",
        "content": "批注内容",
    }

    # para_index=0 -> 422
    resp = await client.post(
        f"/api/documents/{doc_id}/comments", json={**base, "para_index": 0}
    )
    assert resp.status_code == 422

    # content 为空 -> 422
    resp = await client.post(
        f"/api/documents/{doc_id}/comments", json={**base, "content": ""}
    )
    assert resp.status_code == 422

    # author 为空 -> 422
    resp = await client.post(
        f"/api/documents/{doc_id}/comments", json={**base, "author": ""}
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_comment_cascade_delete(client):
    """删除文档时级联删除其批注"""
    doc_id = await _create_doc(client)
    await client.post(
        f"/api/documents/{doc_id}/comments",
        json={
            "para_index": 3,
            "para_snapshot": "第三段：结论。",
            "author": "test-user",
            "content": "结论需补充展望。",
        },
    )

    resp = await client.delete(f"/api/documents/{doc_id}")
    assert resp.status_code == 204

    # 文档已删除, 其批注列表返回 404
    resp = await client.get(f"/api/documents/{doc_id}/comments")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_comment_delete_mismatch(client):
    """批注删除需归属匹配: 跨文档删除返回 404"""
    doc_a = await _create_doc(client)
    doc_b = await _create_doc(client)

    resp = await client.post(
        f"/api/documents/{doc_a}/comments",
        json={
            "para_index": 1,
            "para_snapshot": "第一段：背景。",
            "author": "test-user",
            "content": "A 文档批注",
        },
    )
    comment_id = resp.json()["id"]

    # 用 B 文档的 id 删除 A 的批注 -> 404
    resp = await client.delete(f"/api/documents/{doc_b}/comments/{comment_id}")
    assert resp.status_code == 404

    # 原文档删除仍成功
    resp = await client.delete(f"/api/documents/{doc_a}/comments/{comment_id}")
    assert resp.status_code == 204
