"""
文档权限管理测试 (步骤 15)
================================
覆盖:
- GET 权限默认值 (open/optional/allow) + 协作者含 owner + 用户列表完整
- PUT 更新协作模式/水印策略/导出策略 + 协作者集合全量替换
- export_policy=deny: 文档导出与证据包导出均 403; 恢复 allow 后 200
- 未知文档 404
- 协作者集合: owner 始终保留
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from main import app

OWNER_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")
USER_B1 = uuid.UUID("00000000-0000-4000-8000-0000000000b1")


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _new_doc(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/documents",
        json={"title": "测试文档-权限", "owner_id": str(OWNER_ID), "content": "权限测试文档"},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_get_default_permissions(client):
    doc_id = await _new_doc(client)
    resp = await client.get(f"/api/documents/{doc_id}/permissions")
    assert resp.status_code == 200
    data = resp.json()
    assert data["collab_mode"] == "open"
    assert data["watermark_policy"] == "optional"
    assert data["export_policy"] == "allow"
    assert data["owner_id"] == str(OWNER_ID)
    # 协作者默认包含 owner
    assert any(c["user_id"] == str(OWNER_ID) for c in data["collaborators"])
    # 全部人类用户 (演示用户) 供选择
    assert len(data["all_users"]) >= 4


@pytest.mark.asyncio
async def test_update_permissions_and_collaborators(client):
    doc_id = await _new_doc(client)
    resp = await client.put(
        f"/api/documents/{doc_id}/permissions",
        json={
            "collab_mode": "invited",
            "watermark_policy": "enforce",
            "export_policy": "deny",
            "collaborator_ids": [str(USER_B1)],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["collab_mode"] == "invited"
    assert data["watermark_policy"] == "enforce"
    assert data["export_policy"] == "deny"
    ids = {c["user_id"] for c in data["collaborators"]}
    # owner 始终保留 + 新授权 B1
    assert ids == {str(OWNER_ID), str(USER_B1)}

    # 回读一致
    again = (await client.get(f"/api/documents/{doc_id}/permissions")).json()
    assert again["collab_mode"] == "invited"
    assert again["export_policy"] == "deny"


@pytest.mark.asyncio
async def test_export_denied_blocks_export_and_evidence(client):
    doc_id = await _new_doc(client)
    await client.put(
        f"/api/documents/{doc_id}/permissions",
        json={
            "collab_mode": "open",
            "watermark_policy": "optional",
            "export_policy": "deny",
            "collaborator_ids": [],
        },
    )
    # Markdown 导出 403
    assert (await client.get(f"/api/documents/{doc_id}/export")).status_code == 403
    # 证据包导出 403
    for fmt in ("pdf", "md", "json"):
        resp = await client.get(
            f"/api/watermark/documents/{doc_id}/evidence?format={fmt}"
        )
        assert resp.status_code == 403, f"evidence {fmt} 应被 403"

    # 恢复 allow 后导出恢复
    await client.put(
        f"/api/documents/{doc_id}/permissions",
        json={
            "collab_mode": "open",
            "watermark_policy": "optional",
            "export_policy": "allow",
            "collaborator_ids": [],
        },
    )
    assert (await client.get(f"/api/documents/{doc_id}/export")).status_code == 200
    assert (
        await client.get(f"/api/watermark/documents/{doc_id}/evidence?format=json")
    ).status_code == 200


@pytest.mark.asyncio
async def test_permissions_unknown_doc_404(client):
    assert (
        await client.get(f"/api/documents/{uuid.uuid4()}/permissions")
    ).status_code == 404


@pytest.mark.asyncio
async def test_permissions_invalid_values_422(client):
    doc_id = await _new_doc(client)
    resp = await client.put(
        f"/api/documents/{doc_id}/permissions",
        json={
            "collab_mode": "everyone",
            "watermark_policy": "optional",
            "export_policy": "allow",
            "collaborator_ids": [],
        },
    )
    assert resp.status_code == 422
