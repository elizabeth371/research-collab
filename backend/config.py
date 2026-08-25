"""
全局配置模块
================
集中管理数据库连接、COR、Agent 模型 API Key 等环境配置。
使用 pydantic-settings 从环境变量 / .env 文件读取。
"""

from functools import lru_cache
from typing import List, Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用全局配置"""

    # ---- 基础 ----
    APP_NAME: str = "Research Colab Backend"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True

    # ---- CORS ----
    # 允许跨域的前端来源 (Vite dev server 默认 5173)
    CORS_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # ---- PostgreSQL 数据库 (asyncpg URL) ----
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/research_colab",
        description="SQLAlchemy 异步数据库连接串",
    )

    # ---- WebSocket 协同 ----
    WS_MAX_CLIENTS_PER_DOC: int = 64

    # ---- AI 模型接口 (预留: DeepSeek-V3 / 通义千问) ----
    # 使用 OpenAI 兼容协议，可切换 base_url 实现不同厂商
    LLM_BASE_URL: str = "https://api.deepseek.com/v1"   # DeepSeek-V3
    LLM_API_KEY: str = ""                               # 从环境变量注入
    LLM_MODEL: str = "deepseek-chat"

    # 通义千问备用配置
    QWEN_BASE_URL: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    QWEN_API_KEY: str = ""
    QWEN_MODEL: str = "qwen-plus"

    # ---- 水印算法参数 (Kirchenbauer) ----
    WATERMARK_GAMMA: float = 0.5       # 绿名单比例
    WATERMARK_DELTA: float = 2.0       # logits 偏移强度
    WATERMARK_LLM_DELTA: float = 3.0   # 闭源 LLM logprobs 重采样偏移强度
                                       # (实测: delta=3 + 400token(~400字)
                                       #  z≈5 稳定检出且文本伪影最轻; delta=2
                                       #  仅 z~2 不足, delta=4 质量下降明显)
    WATERMARK_SECRET_KEY: bytes = b"research-colab-watermark-secret-key-2026"

    # ---- 操作日志哈希链 ----
    HASHCHAIN_SALT: str = "research-colab-oplog-salt"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """获取全局单例配置 (lru_cache 避免重复加载 .env)"""
    return Settings()


# 模块级导出，便于直接 from config import settings
settings: Settings = get_settings()