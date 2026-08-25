"""
水印检测 API
================
对接 services/watermark_engine.py 的水印检测能力，
对外提供 REST 端点：检测文本是否包含 AI 水印、获取文档溯源链。
"""

import base64
import os
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Document, OpLog, WatermarkRecord
from services.oplog_chain import OpLogHashChain, oplog_append_lock
from services.watermark_engine import WatermarkEngine

router = APIRouter(prefix="/api/watermark", tags=["watermark"])


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class DetectRequest(BaseModel):
    """水印检测请求体"""

    text: str = Field(..., min_length=1, description="待检测文本")


class DetectResponse(BaseModel):
    """水印检测结果"""

    is_ai_generated: bool
    confidence: float
    watermark_chars: int
    model_name: Optional[str] = None


class OpLogOut(BaseModel):
    """溯源链日志条目"""

    id: uuid.UUID
    doc_id: uuid.UUID
    user_id: uuid.UUID
    op_type: str
    operation: dict
    prev_hash: str
    current_hash: str
    created_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------
@router.post("/detect", response_model=DetectResponse)
async def detect_watermark(payload: DetectRequest) -> DetectResponse:
    """
    检测文本中是否包含 Kirchenbauer 水印。
    骨架实现: 调用 WatermarkEngine.detect_watermark()。
    """
    engine = WatermarkEngine()
    result = engine.detect_watermark(payload.text)
    return DetectResponse(
        is_ai_generated=result["is_ai_generated"],
        confidence=result["confidence"],
        watermark_chars=result["watermark_chars"],
        model_name=result.get("model_name"),
    )


@router.post("/documents/{doc_id}/detect", response_model=DetectResponse)
async def detect_document_watermark(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> DetectResponse:
    """
    检测整篇文档的水印, 并将本次检测动作持久化:
      1. 写入 WatermarkRecord (模型参数/密钥/绿名单比例)
      2. 追加一条溯源链操作日志 (op_type='watermark_checked'),
         使"水印检测"动作本身也可追溯, 增强版权证据链。
    """
    from services.oplog_chain import OpLogHashChain  # noqa: F401 (重导入避免歧义)

    # 串行化本文档的溯源链追加 (缺陷 D1): 并发检测/编辑读到相同链尾会算出
    # 相同 current_hash, 违反 op_logs.current_hash UNIQUE 约束 -> 500 + 断链。
    # 锁覆盖「读文档 -> 写 OpLog -> commit」全过程, 提交后释放。
    async with oplog_append_lock(doc_id):
        doc = await db.get(Document, doc_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")

        engine = WatermarkEngine()
        result = engine.detect_watermark(doc.content or "")
        model_name = result.get("model_name") or "kirchenbauer-greenlist"

        # 1. 写入水印记录
        record = WatermarkRecord(
            doc_id=doc.id,
            model_name=model_name,
            gamma=result.get("gamma", 0.5),
            delta=result.get("delta", 2.0),
            secret_key=os.urandom(32),
            token_seq={"watermark_chars": result["watermark_chars"], "detected": result["is_ai_generated"]},
        )
        db.add(record)

        # 2. 追加溯源链操作日志 (watermark_checked)
        last_stmt = (
            select(OpLog)
            .where(OpLog.doc_id == doc.id)
            .order_by(OpLog.created_at.desc())
            .limit(1)
        )
        last = (await db.execute(last_stmt)).scalar_one_or_none()
        prev_hash = last.current_hash if last else ""
        operation = {
            "action": "watermark_checked",
            "model": model_name,
            "is_ai_generated": result["is_ai_generated"],
            "confidence": result["confidence"],
            "watermark_chars": result["watermark_chars"],
            "content_len": len(doc.content or ""),
        }
        log = OpLog(
            doc_id=doc.id,
            user_id=doc.owner_id,
            op_type="watermark_checked",
            operation=operation,
            prev_hash=prev_hash,
            current_hash="",
        )
        db.add(log)
        await db.flush()
        log.current_hash = OpLogHashChain.compute_hash(
            prev_hash=prev_hash,
            operation=operation,
            timestamp=log.created_at,
        )
        await db.commit()

    return DetectResponse(
        is_ai_generated=result["is_ai_generated"],
        confidence=result["confidence"],
        watermark_chars=result["watermark_chars"],
        model_name=model_name,
    )


@router.get("/documents/{doc_id}/records")
async def get_watermark_records(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取某文档的全部水印记录"""
    stmt = select(WatermarkRecord).where(WatermarkRecord.doc_id == doc_id)
    result = await db.execute(stmt)
    records = result.scalars().all()

    return {
        "doc_id": str(doc_id),
        "records": [
            {
                "id": str(r.id),
                "model_name": r.model_name,
                "gamma": r.gamma,
                "delta": r.delta,
                "created_at": r.created_at.isoformat(),
            }
            for r in records
        ],
    }


@router.get("/documents/{doc_id}/provenance", response_model=List[OpLogOut])
async def get_provenance(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> List[OpLog]:
    """
    获取文档完整溯源链 (按时间正序排列的操作日志)。
    前端可据此展示 "灵感时序回溯" 功能。
    """
    stmt = (
        select(OpLog)
        .where(OpLog.doc_id == doc_id)
        .order_by(OpLog.created_at.asc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/documents/{doc_id}/provenance/verify")
async def verify_provenance(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    校验文档溯源哈希链完整性。
    校验规则:
      1. 每条日志的 current_hash 必须等于
         compute_hash(log.prev_hash, log.operation, log.created_at)
      2. 每条日志的 prev_hash 必须等于前一条日志的 current_hash
         (链首 prev_hash 必须为空串 "")
    全部通过则返回 valid=True。
    """
    # 避免循环导入
    from services.oplog_chain import OpLogHashChain

    stmt = (
        select(OpLog)
        .where(OpLog.doc_id == doc_id)
        .order_by(OpLog.created_at.asc())
    )
    try:
        result = await db.execute(stmt)
        logs = list(result.scalars().all())
    except Exception:
        # 日志的 operation 被外部破坏为非法 JSON 时, 查询反序列化即失败,
        # 无法校验 -> 判定该链无效 (返回 200, 避免 500 崩溃)
        return {"doc_id": str(doc_id), "valid": False, "checked": 0}

    if not logs:
        return {"doc_id": str(doc_id), "valid": True, "checked": 0}

    prev_hash = ""
    valid = True
    checked = 0
    for log in logs:
        try:
            operation = log.operation
        except Exception:
            # 单条日志的 operation 被外部破坏为非法 JSON, 无法参与校验,
            # 直接判定该链无效 (返回 200, 避免 500 崩溃)
            valid = False
            break

        # 规则 1: prev_hash 必须与前一条的 current_hash 一致
        if log.prev_hash != prev_hash:
            valid = False
            break

        # 规则 2: 重新计算 current_hash 并比对
        expected = OpLogHashChain.compute_hash(
            prev_hash=log.prev_hash,
            operation=operation,
            timestamp=log.created_at,
        )
        if log.current_hash != expected:
            valid = False
            break

        prev_hash = log.current_hash
        checked += 1

    return {"doc_id": str(doc_id), "valid": valid, "checked": checked}