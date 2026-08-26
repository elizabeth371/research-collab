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
    # PostgreSQL 不可用时的 SQLite 回退路径 (相对后端工作目录或绝对路径;
    # Docker 部署通过该配置把数据库持久化到数据卷)
    SQLITE_PATH: str = Field(
        default="./research_colab.db",
        description="SQLite 回退数据库文件路径",
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
    WATERMARK_LLM_DELTA: float = 4.0   # 闭源 LLM logprobs 重采样偏移强度
                                       # (实测: temp=1.5 + delta=4 多次运行
                                       #  z∈[8.6,12.7] 稳定检出; delta=3 时
                                       #  低熵内容 z 可低至 3.2 不稳定; 硬
                                       #  green-only 虽 z>8 但中文乱码不可用)
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