"""
文档版本回溯测试 (步骤 15)
================================
覆盖:
- PATCH 内容变化自动快照版本 (version_no 自增)
- 内容未变不新增版本 (防抖去重)
- 版本列表 (新→旧, 含预览/字数) 与详情
- 恢复到历史版本: 内容回退 + 溯源链追加 version_restore + 哈希链仍有效
- 版本不存在 404
- 保留上限: 超过 50 个版本自动裁剪最旧
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app

OWNER_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _new_doc(client: AsyncClient, tag: str) -> str:
    # 注意: 各测试的初始/PATCH 内容必须全局唯一——SQLite 时间戳为秒级,
    # 若两个文档在同一秒产生完全相同操作 (相同 prev_hash+operation+timestamp),
    # 会算出相同 current_hash, 触发 op_logs.current_hash 全局 UNIQUE 冲突
    resp = await client.post(
        "/api/documents",
        json={
            "title": "测试文档-版本回溯",
            "owner_id": str(OWNER_ID),
            "content": f"初始内容-{tag}",
        },
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _patch(client: AsyncClient, doc_id: str, content: str):
    return await client.patch(
        f"/api/documents/{doc_id}",
        json={"content": content, "operator_id": str(OWNER_ID)},
    )


@pytest.mark.asyncio
async def test_patch_auto_snapshots_versions(client):
    doc_id = await _new_doc(client, "A")
    # 初始创建 -> 尚无 PATCH 快照; 两次内容变更 -> 2 个版本
    await _patch(client, doc_id, "A1 第一版内容")
    await _patch(client, doc_id, "A2 第二版内容更丰富一些")
    resp = await client.get(f"/api/documents/{doc_id}/versions")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    nos = [v["version_no"] for v in data["versions"]]
    assert nos == [2, 1]  # 新→旧
    assert data["versions"][0]["content_length"] == len("A2 第二版内容更丰富一些")


@pytest.mark.asyncio
async def test_same_content_no_duplicate_version(client):
    doc_id = await _new_doc(client, "B")
    await _patch(client, doc_id, "B1 第一版内容")
    # 防抖重复保存同一内容 -> 不新增版本
    await _patch(client, doc_id, "B1 第一版内容")
    data = (await client.get(f"/api/documents/{doc_id}/versions")).json()
    assert data["total"] == 1
    assert data["versions"][0]["version_no"] == 1


@pytest.mark.asyncio
async def test_version_detail_and_404(client):
    doc_id = await _new_doc(client, "C")
    await _patch(client, doc_id, "C1 第一版内容")
    detail = await client.get(f"/api/documents/{doc_id}/versions/1")
    assert detail.status_code == 200
    assert detail.json()["content"] == "C1 第一版内容"
    assert (await client.get(f"/api/documents/{doc_id}/versions/99")).status_code == 404
    assert (
        await client.get(f"/api/documents/{uuid.uuid4()}/versions/1")
    ).status_code == 404


@pytest.mark.asyncio
async def test_restore_rolls_back_content_and_logs(client):
    doc_id = await _new_doc(client, "D")
    await _patch(client, doc_id, "D1 第一版内容")
    await _patch(client, doc_id, "D2 第二版内容")
    await _patch(client, doc_id, "D3 第三版内容")

    resp = await client.post(f"/api/documents/{doc_id}/versions/1/restore")
    assert resp.status_code == 200
    assert resp.json()["content"] == "D1 第一版内容"

    # 溯源链: 追加了 version_restore 日志且哈希链仍有效
    prov = (
        await client.get(f"/api/watermark/documents/{doc_id}/provenance")
    ).json()
    assert any(
        log["operation"].get("action") == "version_restore"
        and log["operation"].get("version_no") == 1
        for log in prov
    ), "溯源链缺少 version_restore 日志"
    verify = (
        await client.get(f"/api/watermark/documents/{doc_id}/provenance/verify")
    ).json()
    assert verify["valid"] is True

    # 恢复后内容被快照为新版本 (版本数 +1)
    versions = (await client.get(f"/api/documents/{doc_id}/versions")).json()
    assert versions["total"] == 4
    assert versions["versions"][0]["version_no"] == 4


@pytest.mark.asyncio
async def test_restore_unknown_version_404(client):
    doc_id = await _new_doc(client, "E")
    resp = await client.post(f"/api/documents/{doc_id}/versions/9/restore")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_versions_capped_at_max(client):
    doc_id = await _new_doc(client, "F")
    # 连续 55 次不同内容变更 -> 版本保留上限 50
    for i in range(1, 56):
        await _patch(client, doc_id, f"F-第{i:02d}次内容迭代")
    data = (await client.get(f"/api/documents/{doc_id}/versions")).json()
    assert data["total"] == 50
    assert data["max_versions"] == 50
    # 保留的是最新的 50 个 (version_no 6..55, 最旧的 1..5 被裁剪)
    assert data["versions"][-1]["version_no"] == 6
    assert data["versions"][0]["version_no"] == 55
