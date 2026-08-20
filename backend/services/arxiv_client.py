"""
arXiv 文献实时检索客户端
=========================
通过 arXiv API (export.arxiv.org/api/query, Atom XML) 检索真实论文元数据。

- 数据来源: arXiv 公开开放接口 (arXiv Terms of Use), 无 API Key 要求;
- 用于 ResearchAgent 的实时文献检索, 提升科研信息真实性;
- 网络不可用 / 超时时抛出异常, 由调用方降级到本地文献库。

检索词建议: arXiv 全文检索 (all:), 支持引号短语, 如
  all:"AI watermark"  /  all:watermark  /  all:"retrieval augmented generation"
"""

import asyncio
import logging
import re
from typing import Dict, List, Optional
from urllib.parse import quote

import httpx

logger = logging.getLogger("uvicorn.error")

ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_USER_AGENT = "research-collab/0.1 (academic integrity research project)"

# arXiv 网页 URL 模式: http://arxiv.org/abs/XXXX.XXXXX
_ID_RE = re.compile(r"arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})")


class ArxivClient:
    """arXiv API 客户端 (异步)"""

    def __init__(self, timeout: float = 15.0) -> None:
        self.timeout = timeout

    async def search(
        self,
        query: str,
        max_results: int = 6,
    ) -> List[Dict[str, object]]:
        """
        按查询串检索 arXiv 论文。

        Args:
            query:       检索词 (支持 all: 前缀与引号短语)
            max_results: 返回条数上限

        Returns:
            [{title, authors, year, source, abstract, keywords, url}]
            按相关性 (arXiv 默认排序) 返回。

        Raises:
            httpx.HTTPError / ValueError: 网络或解析失败 (供上层降级)
        """
        params = {
            "search_query": query,
            "start": 0,
            "max_results": max_results,
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
        async with httpx.AsyncClient(
            timeout=self.timeout,
            headers={"User-Agent": ARXIV_USER_AGENT},
        ) as client:
            resp = await client.get(ARXIV_API, params=params)
            resp.raise_for_status()
            xml = resp.text

        if "<entry>" not in xml:
            # arXiv 返回空 feed (无结果)
            return []
        return self._parse_feed(xml)

    # ------------------------------------------------------------------
    # Atom feed 解析 (无第三方依赖, 轻量正则/字符串提取)
    # ------------------------------------------------------------------
    @staticmethod
    def _parse_feed(xml: str) -> List[Dict[str, object]]:
        entries = xml.split("<entry>")[1:]  # 丢弃 feed 头
        results: List[Dict[str, object]] = []
        for entry in entries:
            entry = entry.split("</entry>")[0]

            title = _extract_tag(entry, "title").replace("\n ", "").strip()
            summary = _extract_tag(entry, "summary").replace("\n", " ").strip()
            published = _extract_tag(entry, "published").strip()
            year = int(published[:4]) if published[:4].isdigit() else 0

            # 作者列表 (author > name)
            authors = re.findall(r"<name>(.*?)</name>", entry)
            authors_str = ", ".join(a.replace("\n", "").strip() for a in authors[:6])

            # arXiv 标识与链接
            id_href = _extract_attr(entry, "id", "href")
            arxiv_id = ""
            m = _ID_RE.search(entry)
            if m:
                arxiv_id = m.group(1)
            url = id_href if id_href else (
                f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else ""
            )

            # 分类标签 (作为 keywords 使用)
            cats = re.findall(r'<arxiv:primary_category[^>]*term="([^"]+)"', entry)
            if not cats:
                cats = re.findall(r'<category[^>]*term="([^"]+)"', entry)
            keywords = ", ".join(cats[:5])

            # 摘要截断 (存储用)
            abstract = summary[:1000]

            results.append(
                {
                    "title": title,
                    "authors": authors_str,
                    "year": year,
                    "source": f"arXiv:{arxiv_id}" if arxiv_id else "arXiv",
                    "abstract": abstract,
                    "keywords": keywords,
                    "url": url,
                }
            )
        return results


def _extract_tag(xml_block: str, tag: str) -> str:
    """提取 <tag>...</tag> 内容 (仅第一个匹配)"""
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", xml_block, re.S)
    return m.group(1) if m else ""


def _extract_attr(xml_block: str, tag: str, attr: str) -> str:
    """提取 <tag ... attr="..."> 中的属性值 (仅第一个匹配)"""
    m = re.search(rf"<{tag}[^>]*\b{attr}=\"([^\"]*)\"", xml_block)
    return m.group(1) if m else ""


# ---------------------------------------------------------------------------
# 便捷入口: 供 ResearchAgent / API 层同步调用
# ---------------------------------------------------------------------------
async def search_arxiv(
    query: str,
    max_results: int = 6,
) -> List[Dict[str, object]]:
    """
    检索 arXiv 并返回论文列表; 网络失败时抛出异常。

    上层应捕获异常并降级到本地文献库 (见 agent_orchestrator.py)。
    """
    client = ArxivClient()
    return await client.search(query, max_results=max_results)
