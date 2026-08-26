"""
协作聊天测试 (步骤 16)
================================
覆盖:
- WebSocket 房间广播: 发送者与同房间其他连接均收到消息
- 消息持久化: 广播后历史 API 可查 (username/content 一致)
- 房间隔离: 不同文档房间消息互不串扰
- 未知文档历史 404
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from main import app

OWNER_ID = "00000000-0000-4000-8000-000000000001"

_client = None


def _tc():
    """模块级单例 TestClient (避免反复触发 lifespan)"""
    global _client
    if _client is None:
        _client = TestClient(app)
    return _client


def _new_doc(client: TestClient) -> str:
    r = client.post(
        "/api/documents",
        json={"title": "测试文档-聊天", "owner_id": OWNER_ID, "content": "聊天测试"},
    )
    assert r.status_code == 201
    return r.json()["id"]


def test_ws_chat_broadcast_and_persist():
    client = _tc()
    doc_id = _new_doc(client)
    try:
        with client.websocket_connect(f"/ws/chat/{doc_id}") as ws_a, \
             client.websocket_connect(f"/ws/chat/{doc_id}") as ws_b:
            ws_a.send_json({
                "type": "chat",
                "content": "大家好，这里是步骤16的协作聊天",
                "user_id": OWNER_ID,
                "username": "测试员甲",
            })
            # 发送者自己收到广播
            msg_a = ws_a.receive_json()
            assert msg_a["type"] == "chat"
            assert "协作聊天" in msg_a["content"]
            # 同房间其他连接收到
            msg_b = ws_b.receive_json()
            assert msg_b["content"] == msg_a["content"]
            assert msg_b["username"] == "测试员甲"

        # 消息已持久化到历史
        msgs = client.get(f"/api/documents/{doc_id}/chat/messages").json()
        assert len(msgs) >= 1
        assert msgs[-1]["content"] == "大家好，这里是步骤16的协作聊天"
        assert msgs[-1]["username"] == "测试员甲"
    finally:
        client.delete(f"/api/documents/{doc_id}")


def test_chat_room_isolation():
    client = _tc()
    d1 = _new_doc(client)
    d2 = _new_doc(client)
    try:
        with client.websocket_connect(f"/ws/chat/{d1}") as a, \
             client.websocket_connect(f"/ws/chat/{d2}") as b:
            a.send_json({
                "type": "chat",
                "content": "只发给房间1的秘密消息",
                "user_id": OWNER_ID,
                "username": "甲",
            })
            _ = a.receive_json()  # a 自己收到
        m1 = client.get(f"/api/documents/{d1}/chat/messages").json()
        m2 = client.get(f"/api/documents/{d2}/chat/messages").json()
        assert any("只发给房间1" in m["content"] for m in m1)
        assert not any("只发给房间1" in m["content"] for m in m2)
    finally:
        client.delete(f"/api/documents/{d1}")
        client.delete(f"/api/documents/{d2}")


def test_chat_messages_unknown_doc_404():
    client = _tc()
    assert (
        client.get(f"/api/documents/{uuid.uuid4()}/chat/messages").status_code == 404
    )


def test_ws_chat_invalid_payload_ignored():
    client = _tc()
    doc_id = _new_doc(client)
    try:
        with client.websocket_connect(f"/ws/chat/{doc_id}") as ws:
            # 非 chat 类型 / 空内容: 服务端忽略, 不广播不落库
            ws.send_json({"type": "ping"})
            ws.send_json({"type": "chat", "content": "   ", "user_id": OWNER_ID, "username": "甲"})
        msgs = client.get(f"/api/documents/{doc_id}/chat/messages").json()
        assert len(msgs) == 0
    finally:
        client.delete(f"/api/documents/{doc_id}")
