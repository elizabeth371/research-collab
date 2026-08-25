"""
LLM 客户端 (可插拔, OpenAI 兼容协议)
====================================
通过 openai SDK + 自定义 base_url 对接任意 OpenAI 兼容服务
(DeepSeek / 通义千问 / OpenAI / 本地 vLLM / Ollama 等)。

降级策略 (保证演示链路离线可用):
- 未配置 API Key            -> is_available()=False, chat()=None
- 网络失败 / 超时 / 解析失败 -> chat()=None (异常吞掉, 记日志)
调用方 (Agent 节点 / API 端点) 在得到 None 时回退到规则引擎,
因此 LLM 是纯增强项: 配了 key 就智能, 不配也能跑。

Key 读取优先级: settings.LLM_API_KEY (.env / 环境变量) > OPENAI_API_KEY。
"""

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

from config import settings  # noqa: E402  (避免循环导入: config 不依赖本模块)


class LLMClient:
    """OpenAI 兼容 LLM 客户端 (无 key 时自动降级)"""

    def __init__(self) -> None:
        self._client: Any = None
        self._client_key: str = ""

    # ------------------------------------------------------------------
    # 可用性
    # ------------------------------------------------------------------
    @property
    def api_key(self) -> str:
        """Key 优先级: 项目配置 (.env / 环境变量) > 通用 OPENAI_API_KEY"""
        return (settings.LLM_API_KEY or os.getenv("OPENAI_API_KEY") or "").strip()

    def is_available(self) -> bool:
        return bool(self.api_key)

    def mode(self) -> str:
        """当前生效模式: 'llm' (已配置 Key) / 'rule' (降级规则引擎)"""
        return "llm" if self.is_available() else "rule"

    # ------------------------------------------------------------------
    # 底层调用
    # ------------------------------------------------------------------
    def _get_client(self) -> Any:
        """懒加载 AsyncOpenAI 实例 (按 key 缓存, key 变化时重建)"""
        key = self.api_key
        if not key:
            return None
        if self._client is None or self._client_key != key:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(
                base_url=settings.LLM_BASE_URL,
                api_key=key,
                timeout=45.0,
                max_retries=1,
            )
            self._client_key = key
        return self._client

    async def chat(
        self,
        messages: List[Dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> Optional[str]:
        """
        单轮对话, 返回回复文本。

        未配置 Key / 调用失败 / 返回为空 时返回 None (调用方自行降级)。
        """
        client = self._get_client()
        if client is None:
            logger.info("[LLM] 未配置 API Key, 降级到规则引擎")
            return None
        try:
            resp = await client.chat.completions.create(
                model=settings.LLM_MODEL,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            content = resp.choices[0].message.content
            return (content or "").strip() or None
        except Exception as e:  # 网络/超时/鉴权失败 -> 降级, 不阻断主流程
            logger.warning("[LLM] 调用失败 (%s: %s), 降级到规则引擎", type(e).__name__, e)
            return None

    @staticmethod
    def _extract_json(text: str) -> Optional[Dict[str, Any]]:
        """
        从模型回复中容错提取 JSON 对象:
        - 去掉 ```json ... ``` 代码围栏
        - 取首个 '{' 到最后一个 '}' 之间的子串
        - 解析失败返回 None
        """
        if not text:
            return None
        cleaned = text.strip()
        fence = re.search(r"```(?:json)?\s*(.*?)```", cleaned, re.S)
        if fence:
            cleaned = fence.group(1).strip()
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            return None
        try:
            parsed = json.loads(cleaned[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    async def chat_json(
        self,
        messages: List[Dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 2000,
    ) -> Optional[Dict[str, Any]]:
        """对话并要求模型输出 JSON, 解析失败返回 None (调用方降级)。"""
        text = await self.chat(
            messages, temperature=temperature, max_tokens=max_tokens
        )
        return self._extract_json(text) if text else None

    # ------------------------------------------------------------------
    # 业务能力 (返回 None 即表示应降级到规则引擎)
    # ------------------------------------------------------------------
    async def polish_text(self, text: str) -> Optional[Dict[str, Any]]:
        """
        LLM 语义润色, 返回与规则引擎同构的 PolishResult
        {original, polished, changes[{type,before,after}], stats}。
        解析失败 / 无 Key 返回 None。
        """
        if not text or not text.strip():
            return None
        prompt = (
            "你是一位资深学术论文编辑。请对下列中文科研文本进行学术化润色：\n"
            "1. 保持原意与篇幅基本不变；\n"
            "2. 升级口语化表达为学术措辞，清理冗余，规范标点与句式；\n"
            "3. 若文本已符合学术规范，polished 返回原文，changes 返回空数组。\n"
            "仅输出 JSON，不要输出任何其他内容：\n"
            '{"polished": "<润色后全文>", "changes": [{"type": "phrasing|redundancy|punctuation|sentence", "before": "...", "after": "..."}]}\n'
            "\n待润色文本：\n" + text
        )
        raw = await self.chat_json(
            [{"role": "user", "content": prompt}], max_tokens=3000
        )
        if not raw or not raw.get("polished"):
            return None

        polished = str(raw["polished"]).strip()
        changes = [
            {
                "type": str(c.get("type", "phrasing")),
                "before": str(c.get("before", "")),
                "after": str(c.get("after", "")),
            }
            for c in (raw.get("changes") or [])
            if isinstance(c, dict) and c.get("before")
        ]
        return {
            "original": text,
            "polished": polished or text,
            "changes": changes,
            "stats": {
                "chars_before": len(text),
                "chars_after": len(polished or text),
                "change_count": len(changes),
            },
        }

    async def write_draft(
        self, writing_task: str, research_output: str
    ) -> Optional[str]:
        """
        WriterAgent 草稿生成: 基于写作任务 + 研究背景撰写学术章节草稿。
        无 Key / 调用失败返回 None (回退到模拟草稿模板)。
        """
        task = (writing_task or "").strip() or "围绕研究背景撰写论文引言与相关工作章节"
        research = (research_output or "").strip()[:2500]
        prompt = (
            "你是科研论文写作助手。请根据给定的研究背景与写作任务，"
            "撰写一段规范的中文学术论文章节草稿：\n"
            "1. 结构清晰，可包含小标题或要点；\n"
            "2. 引用研究背景中给出的文献支撑论点；\n"
            "3. 篇幅 300-600 字，直接输出正文，不要代码块。\n"
            f"\n【研究背景】\n{research}\n\n【写作任务】\n{task}"
        )
        return await self.chat(
            [
                {"role": "system", "content": "你是一位严谨的中文学术论文写作者。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_tokens=1500,
        )


# 模块级单例 (与 orchestrator / api 共享)
llm_client = LLMClient()
