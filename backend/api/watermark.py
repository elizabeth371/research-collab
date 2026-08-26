"""
水印检测 API
================
对接 services/watermark_engine.py 的水印检测能力，
对外提供 REST 端点：检测文本是否包含 AI 水印、获取文档溯源链。
"""

import base64
import hashlib
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
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
    # ---- 论文级统计量 (步骤 10: 前端可视化展示) ----
    z_score: float = 0.0            # z 统计量 (判定依据, >4 判为 AI 生成)
    green_fraction: float = 0.0     # 绿名单命中比例
    num_tokens_scored: int = 0      # 参与评分的字符对数
    p_value: float = 1.0            # 单侧尾概率


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
        z_score=result.get("z_score", 0.0),
        green_fraction=result.get("green_fraction", 0.0),
        num_tokens_scored=result.get("num_tokens_scored", 0),
        p_value=result.get("p_value", 1.0),
    )


# ---------------------------------------------------------------------------
# 真实 LLM + 水印生成演示 (需要配置 LLM_API_KEY, 失败返回 503)
# ---------------------------------------------------------------------------
class LLMGenerateRequest(BaseModel):
    """真实 LLM 生成 + 字符级水印注入请求体"""

    prompt: str = Field(..., min_length=1, max_length=2000, description="写作指令")
    max_tokens: int = Field(default=400, ge=50, le=2000, description="生成长度上限")
    delta: Optional[float] = Field(
        default=None, ge=0.0, le=10.0, description="绿名单 logits 偏移 (默认取配置 2.0)"
    )
    doc_id: Optional[uuid.UUID] = Field(
        default=None, description="所属文档 ID (可选): 传入时使用文档独立密钥/参数注入"
    )


@router.post("/generate-llm")
async def generate_llm_watermarked(payload: LLMGenerateRequest) -> dict:
    """
    端到端演示: 真实 LLM 生成 + 本地 logprobs 重采样注入字符级水印。

    流程: DeepSeek (OpenAI 兼容) 逐位置返回 top-N (token, logprob)
          -> WatermarkEngine.resample_with_watermark 按绿名单重新采样
          -> detect_watermark 立即自检。
    未配置 API Key 或调用失败返回 503 (调用方降级, 不产生半成品)。
    步骤 12: 可传 doc_id, 用该文档的独立密钥/参数注入 (插入文档后可检出)。
    """
    from services.llm_client import llm_client
    from services.watermark_engine import WatermarkEngine, load_document_engine

    if not llm_client.is_available():
        raise HTTPException(
            status_code=503, detail="未配置 LLM_API_KEY, 无法调用真实 LLM 生成"
        )
    engine = (
        await load_document_engine(str(payload.doc_id))
        if payload.doc_id
        else WatermarkEngine(delta=payload.delta)
        if payload.delta is not None
        else WatermarkEngine()
    )
    text = await engine.generate_watermarked(
        llm_client,
        [{"role": "user", "content": payload.prompt}],
        max_tokens=payload.max_tokens,
    )
    if not text:
        raise HTTPException(
            status_code=503,
            detail="LLM logprobs 生成失败 (网络/鉴权/空结果), 未产出含水印文本",
        )
    detect = engine.detect_watermark(text)
    return {
        "text": text,
        "chars": len(text),
        "detect": detect,
        "engine": "deepseek-logprobs-resample",
        "doc_id": str(payload.doc_id) if payload.doc_id else None,
        "note": "文本越长 z 值越高; 建议 max_tokens>=300 (约 300 字) 以获得稳定检出 (z>4)",
    }


# ---------------------------------------------------------------------------
# 水印对抗鲁棒性实验 (步骤 11)
# ---------------------------------------------------------------------------
class RobustnessRequest(BaseModel):
    """鲁棒性攻击矩阵请求体"""

    text: str = Field(..., min_length=1, description="已注入水印的待测文本")
    include_translation: bool = Field(
        default=False, description="是否执行真实机器翻译回译攻击 (需 LLM_API_KEY, 耗时较长)"
    )
    doc_id: Optional[uuid.UUID] = Field(
        default=None, description="所属文档 ID (可选): 传入时用文档独立密钥/参数检测"
    )


@router.post("/robustness")
async def watermark_robustness(payload: RobustnessRequest) -> dict:
    """
    对抗鲁棒性实验: 对水印文本施加攻击矩阵并度量检测衰减。

    攻击: 随机删除 10%/30%、截断末尾 20%、中文同义替换、插入噪声、
    局部乱序, 可选真实机器翻译回译 (zh->en->zh)。
    返回基线 z 值 + 各攻击后的 z/绿名单占比/检出判定 + 汇总
    (检出率 / 平均 z / 最小 z), 供论文实验表与前端可视化。
    步骤 12: 可传 doc_id 以文档独立密钥检测 (与生成端一致)。
    """
    from services.watermark_attack import WatermarkAttackSuite
    from services.watermark_engine import load_document_engine

    engine = (
        await load_document_engine(str(payload.doc_id)) if payload.doc_id else None
    )
    suite = WatermarkAttackSuite(engine=engine)
    llm = None
    if payload.include_translation:
        from services.llm_client import llm_client

        llm = llm_client
    result = await suite.run_async(
        payload.text,
        include_translation=payload.include_translation,
        llm_client=llm,
    )
    result["engine"] = "kirchenbauer-v1"
    result["doc_id"] = str(payload.doc_id) if payload.doc_id else None
    return result


# ---------------------------------------------------------------------------
# 步骤 12: 每文档独立水印参数 (密钥 / γ / δ)
# ---------------------------------------------------------------------------
class WatermarkParamsOut(BaseModel):
    """文档水印参数 (密钥以 hex 与指纹形式返回, 不回传原始字节)"""

    gamma: float
    delta: float
    secret_key_hex: str
    key_fingerprint: str
    updated_at: datetime


class WatermarkParamsUpdate(BaseModel):
    """文档水印参数更新请求体"""

    gamma: Optional[float] = Field(default=None, ge=0.05, le=0.95, description="绿名单比例")
    delta: Optional[float] = Field(
        default=None, ge=0.0, le=10.0, description="注入强度 (LLM 重采样偏移)"
    )
    regenerate_key: bool = Field(
        default=False, description="重新生成独立密钥 (旧密钥注入的水印将无法再检出)"
    )


def _params_out(doc: Document) -> WatermarkParamsOut:
    import hashlib

    from config import settings

    key = doc.watermark_key or settings.WATERMARK_SECRET_KEY
    return WatermarkParamsOut(
        gamma=doc.watermark_gamma,
        delta=doc.watermark_delta,
        secret_key_hex=key.hex(),
        key_fingerprint=hashlib.sha256(key).hexdigest()[:16],
        updated_at=doc.updated_at,
    )


@router.get("/documents/{doc_id}/params", response_model=WatermarkParamsOut)
async def get_document_watermark_params(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> WatermarkParamsOut:
    """读取文档的水印参数 (γ / δ / 独立密钥指纹)"""
    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return _params_out(doc)


@router.patch("/documents/{doc_id}/params", response_model=WatermarkParamsOut)
async def update_document_watermark_params(
    doc_id: uuid.UUID,
    payload: WatermarkParamsUpdate,
    db: AsyncSession = Depends(get_db),
) -> WatermarkParamsOut:
    """
    更新文档水印参数 (γ / δ / 重新生成密钥), 并写入溯源链日志。

    regenerate_key=True 会生成新的独立密钥: 新注入的水印用新密钥,
    但旧密钥注入的历史内容将无法再检出 (面板需提示用户)。
    """
    from config import settings
    from services.watermark_engine import generate_secret_key

    async with oplog_append_lock(doc_id):
        doc = await db.get(Document, doc_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")

        old_key = (doc.watermark_key or settings.WATERMARK_SECRET_KEY).hex()
        if payload.gamma is not None:
            doc.watermark_gamma = payload.gamma
        if payload.delta is not None:
            doc.watermark_delta = payload.delta
        if payload.regenerate_key:
            doc.watermark_key = generate_secret_key()
        new_key = (doc.watermark_key or settings.WATERMARK_SECRET_KEY).hex()

        # 溯源链日志: 参数变更本身也留痕 (op_type='watermark_params')
        last_stmt = (
            select(OpLog)
            .where(OpLog.doc_id == doc.id)
            .order_by(OpLog.created_at.desc())
            .limit(1)
        )
        last = (await db.execute(last_stmt)).scalar_one_or_none()
        prev_hash = last.current_hash if last else ""
        operation = {
            "action": "watermark_params_changed",
            "gamma": doc.watermark_gamma,
            "delta": doc.watermark_delta,
            "key_regenerated": payload.regenerate_key,
            "key_fingerprint": hashlib.sha256(bytes.fromhex(new_key)).hexdigest()[:16],
        }
        log = OpLog(
            doc_id=doc.id,
            user_id=doc.owner_id,
            op_type="watermark_params",
            operation=operation,
            prev_hash=prev_hash,
            current_hash="",
        )
        db.add(log)
        await db.flush()
        log.current_hash = OpLogHashChain.compute_hash(
            prev_hash=prev_hash, operation=operation, timestamp=log.created_at
        )
        await db.commit()
        await db.refresh(doc)

    return _params_out(doc)


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

        # 步骤 12: 用文档独立密钥/参数构建检测引擎 (与注入端一致)
        from config import settings

        engine = WatermarkEngine(
            gamma=doc.watermark_gamma,
            delta=doc.watermark_delta,
            secret_key=doc.watermark_key or settings.WATERMARK_SECRET_KEY,
        )
        result = engine.detect_watermark(doc.content or "")
        model_name = result.get("model_name") or "kirchenbauer-greenlist"

        # 1. 写入水印记录 (落库实际使用的文档密钥/参数, 供证据链还原)
        record = WatermarkRecord(
            doc_id=doc.id,
            model_name=model_name,
            gamma=engine.gamma,
            delta=engine.delta,
            secret_key=doc.watermark_key or settings.WATERMARK_SECRET_KEY,
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
            "gamma": engine.gamma,
            "delta": engine.delta,
            "key_fingerprint": hashlib.sha256(
                doc.watermark_key or settings.WATERMARK_SECRET_KEY
            ).hexdigest()[:16],
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
        z_score=result.get("z_score", 0.0),
        green_fraction=result.get("green_fraction", 0.0),
        num_tokens_scored=result.get("num_tokens_scored", 0),
        p_value=result.get("p_value", 1.0),
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
    return await _verify_chain(db, doc_id)


async def _verify_chain(db: AsyncSession, doc_id: uuid.UUID) -> dict:
    """溯源哈希链校验公共实现 (被 verify 端点与证据包导出复用)"""
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


# ---------------------------------------------------------------------------
# 版权证据包导出 (步骤 13)
# ---------------------------------------------------------------------------
@router.get("/documents/{doc_id}/evidence")
async def export_evidence_package(
    doc_id: uuid.UUID,
    fmt: str = Query("pdf", alias="format", pattern="^(pdf|md|json)$"),
    db: AsyncSession = Depends(get_db),
):
    """
    导出文档版权证据包 (PDF / Markdown / JSON)。

    证据包内容: 文档元信息与全文快照、每文档水印参数与密钥指纹、全部水印
    检测历史、完整溯源链与哈希链校验结果、导出时刻的实时检测观察。
    三种格式均附带 package_hash (对去除该字段后规范化 JSON 的 SHA-256),
    接收方可离线重算校验证据包未被篡改。
    """
    from services.evidence_package import (
        build_evidence_data,
        render_markdown,
        render_pdf,
    )
    from config import settings

    doc = await db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # 权限策略: 导出限制 (export_policy=deny 时证据包亦禁止导出)
    from api.documents import _export_denied

    if await _export_denied(db, doc_id):
        raise HTTPException(
            status_code=403,
            detail="文档已设置禁止导出 (export_policy=deny)",
        )

    # 水印检测历史 (时间正序)
    rec_stmt = (
        select(WatermarkRecord)
        .where(WatermarkRecord.doc_id == doc_id)
        .order_by(WatermarkRecord.created_at.asc())
    )
    records = list((await db.execute(rec_stmt)).scalars().all())

    # 溯源链 (时间正序) + 哈希链校验
    log_stmt = (
        select(OpLog)
        .where(OpLog.doc_id == doc_id)
        .order_by(OpLog.created_at.asc())
    )
    logs = list((await db.execute(log_stmt)).scalars().all())
    chain_verify = await _verify_chain(db, doc_id)

    # 导出时刻实时检测 (仅作为观察记录, 不落库)
    engine = WatermarkEngine(
        gamma=doc.watermark_gamma,
        delta=doc.watermark_delta,
        secret_key=doc.watermark_key or settings.WATERMARK_SECRET_KEY,
    )
    live = engine.detect_watermark(doc.content or "")
    live_detect = {
        "is_ai_generated": live["is_ai_generated"],
        "confidence": live["confidence"],
        "watermark_chars": live["watermark_chars"],
        "model_name": live.get("model_name"),
        "z_score": live.get("z_score", 0.0),
        "green_fraction": live.get("green_fraction", 0.0),
        "num_tokens_scored": live.get("num_tokens_scored", 0),
        "p_value": live.get("p_value", 1.0),
    }

    data = build_evidence_data(doc, records, logs, chain_verify, live_detect)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    fname = f"evidence-{doc_id}-{stamp}"

    if fmt == "json":
        return JSONResponse(
            data,
            headers={"Content-Disposition": f'attachment; filename="{fname}.json"'},
        )
    if fmt == "md":
        return Response(
            render_markdown(data),
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{fname}.md"'},
        )
    return Response(
        render_pdf(data),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}.pdf"'},
    )