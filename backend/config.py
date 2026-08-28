"""
全局配置模块
================
集中管理数据库连接、COR、Agent 模型 API Key 等环境配置。
使用 pydantic-settings 从环境变量 / .env 文件读取。

密钥解析优先级 (安全):
  1. 环境变量 / .env 显式配置 (生产环境推荐)
  2. 本地密钥文件 (<SECRETS_DIR>/ 下, 首次自动生成后持久化, 重启不丢失)
  3. 均不存在时自动生成随机密钥并尽力写入密钥文件
源码中不再内置任何默认密钥; 历史版本的演示数据库通过运行时兼容探测
沿用旧盐 (见 database.init_db -> _ensure_chain_salt_continuity)。
"""

import logging
import secrets as _secrets
from functools import lru_cache
from pathlib import Path
from typing import List, Optional, Tuple

from pydantic import Field, PrivateAttr
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("uvicorn.error")

# ---------------------------------------------------------------------------
# 历史版本兼容常量 (已废弃): 仅用于识别早期硬编码版本写入的数据, 不作为任何
# 新环境的密钥来源。2026-08 之前该值曾直接写在源码中。
# ---------------------------------------------------------------------------
LEGACY_HASHCHAIN_SALT = "research-colab-oplog-salt"


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

    # ---- 水印密钥 / 哈希链盐 (安全敏感, 见模块 docstring 的解析优先级) ----
    # 输入留空时自动生成并持久化到本地密钥文件; 下游统一通过
    # settings.WATERMARK_SECRET_KEY (bytes) / settings.HASHCHAIN_SALT (str) 读取。
    WATERMARK_SECRET_KEY_INPUT: str = Field(
        default="",
        validation_alias="WATERMARK_SECRET_KEY",
        description="水印密钥: 十六进制串或任意 UTF-8 口令, 建议 `openssl rand -hex 32` 生成",
    )
    HASHCHAIN_SALT_INPUT: str = Field(
        default="",
        validation_alias="HASHCHAIN_SALT",
        description="操作日志哈希链盐值, 随机串即可",
    )
    # 本地密钥文件目录 (相对后端工作目录, 已被 .gitignore 忽略)
    SECRETS_DIR: str = ".secrets"

    _watermark_key_resolved: Optional[bytes] = PrivateAttr(default=None)
    _watermark_key_origin: str = PrivateAttr(default="")
    _hashchain_salt_resolved: Optional[str] = PrivateAttr(default=None)
    _hashchain_salt_origin: str = PrivateAttr(default="")

    @property
    def WATERMARK_SECRET_KEY(self) -> bytes:
        """解析后的水印密钥字节 (惰性: 环境变量 > 密钥文件 > 自动生成)"""
        if self._watermark_key_resolved is None:
            key, origin = self._resolve_watermark_key()
            self._watermark_key_resolved = key
            self._watermark_key_origin = origin
        return self._watermark_key_resolved

    @property
    def HASHCHAIN_SALT(self) -> str:
        """解析后的哈希链盐 (惰性: 环境变量 > 盐文件 > 自动生成)"""
        if self._hashchain_salt_resolved is None:
            salt, origin = self._resolve_hashchain_salt()
            self._hashchain_salt_resolved = salt
            self._hashchain_salt_origin = origin
        return self._hashchain_salt_resolved

    @property
    def hashchain_salt_origin(self) -> str:
        """当前盐的来源 ('env' / 'file' / 'generated-file' / 'legacy-compat' / 'ephemeral')"""
        return self._hashchain_salt_origin

    def adopt_hashchain_salt(self, salt: str, origin: str) -> None:
        """运行时替换哈希链盐 (供 database.init_db 的旧数据兼容探测调用), 并回写盐文件"""
        self._hashchain_salt_resolved = salt
        self._hashchain_salt_origin = origin
        if origin == "legacy-compat":
            try:
                self._write_secret_file("hashchain_salt.txt", salt.encode("utf-8"))
            except OSError:
                pass

    # ---- 密钥文件 IO ----
    def _secret_file_path(self, name: str) -> Path:
        return Path(self.SECRETS_DIR) / name

    def _read_secret_file(self, name: str, min_bytes: int) -> Optional[bytes]:
        path = self._secret_file_path(name)
        try:
            data = path.read_bytes()
        except OSError:
            return None
        return data if len(data) >= min_bytes else None

    def _write_secret_file(self, name: str, data: bytes) -> None:
        path = self._secret_file_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    # ---- 解析逻辑 ----
    def _resolve_watermark_key(self) -> Tuple[bytes, str]:
        env_value = self.WATERMARK_SECRET_KEY_INPUT.strip()
        if env_value:
            try:
                decoded = bytes.fromhex(env_value)
                if len(decoded) >= 16:
                    return decoded, "env"
            except ValueError:
                pass
            return env_value.encode("utf-8"), "env"

        from_file = self._read_secret_file("watermark_key.bin", min_bytes=16)
        if from_file is not None:
            return from_file, "file"

        key = _secrets.token_bytes(32)
        try:
            self._write_secret_file("watermark_key.bin", key)
            logger.warning(
                "🔐 未配置 WATERMARK_SECRET_KEY，已生成随机密钥并写入 %s "
                "(生产环境请通过环境变量显式配置)",
                self._secret_file_path("watermark_key.bin"),
            )
            return key, "generated-file"
        except OSError as exc:
            logger.warning(
                "🔐 未配置 WATERMARK_SECRET_KEY 且无法写密钥文件 (%s)，"
                "使用进程内临时随机密钥 (重启后变更)",
                exc,
            )
            return key, "ephemeral"

    def _resolve_hashchain_salt(self) -> Tuple[str, str]:
        env_value = self.HASHCHAIN_SALT_INPUT.strip()
        if env_value:
            return env_value, "env"

        from_file = self._read_secret_file("hashchain_salt.txt", min_bytes=8)
        if from_file is not None:
            return from_file.decode("utf-8").strip(), "file"

        salt = _secrets.token_hex(16)
        try:
            self._write_secret_file("hashchain_salt.txt", salt.encode("utf-8"))
            logger.warning(
                "🔐 未配置 HASHCHAIN_SALT，已生成随机盐并写入 %s "
                "(生产环境请通过环境变量显式配置)",
                self._secret_file_path("hashchain_salt.txt"),
            )
            return salt, "generated-file"
        except OSError as exc:
            logger.warning(
                "🔐 未配置 HASHCHAIN_SALT 且无法写盐文件 (%s)，使用进程内临时随机盐",
                exc,
            )
            return salt, "ephemeral"

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