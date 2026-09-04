"""
arXiv 文献联网检索客户端 (标准化版)
=====================================
通过 arXiv API (export.arxiv.org/api/query, Atom XML) 检索真实论文元数据。

- 数据来源: arXiv 公开开放接口 (arXiv Terms of Use), 无需 API Key;
- 供「文献检索面板 /search」与调研 (Research) Agent 共用;
- 网络不可用 / 超时时抛出类型化异常, 由调用方降级 (本地文献库)。

健壮性规范 (联网搜索修复):
- 请求超时 15 秒;
- 对 502/503/504 及连接类传输错误自动重试, 最多 3 次尝试 (退避 1s/2s);
- 请求头固定携带 User-Agent; 若配置了环境变量 LITERATURE_SEARCH_API_KEY
  (可选, 供代理网关鉴权), 自动附加 `Authorization: Bearer <key>` —— 密钥
  仅从环境变量读取, 严禁硬编码;
- 发请求前校验目标 URL: 仅允许 http/https, 拒绝 localhost/环回/私有/保留地址;
- 异常分类: SearchTimeoutError / SearchNetworkError / SearchParseError,
  供 API 层映射为标准化错误 JSON (TIMEOUT / NETWORK_ERROR / PARSE_ERROR)。

检索词建议: arXiv 全文检索 (all:), 支持引号短语, 如
  all:"AI watermark"  /  all:watermark  /  all:"retrieval augmented generation"
"""

import asyncio
import ipaddress
import logging
import os
import re
import traceback
from typing import Dict, List, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("uvicorn.error")

ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_USER_AGENT = "research-collab/0.1 (academic integrity research project)"

# 可选网关鉴权密钥 (仅从环境变量读取; arXiv 官方接口不需要, 配置代理时使用)
SEARCH_API_KEY_ENV = "LITERATURE_SEARCH_API_KEY"

# 健壮性参数: 超时 15s; 502/503/504 与传输错误最多 3 次尝试 (退避 1s, 2s)
SEARCH_TIMEOUT_SECONDS = 15.0
_MAX_ATTEMPTS = 3
_RETRY_STATUS = frozenset({502, 503, 504})
_RETRY_BACKOFF_SECONDS = (1.0, 2.0)

# arXiv 网页 URL 模式: http://arxiv.org/abs/XXXX.XXXXX
_ID_RE = re.compile(r"arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})")


# ---------------------------------------------------------------------------
# 类型化检索异常 (API 层据此映射标准化错误 JSON)
# ---------------------------------------------------------------------------
class SearchTimeoutError(Exception):
    """联网搜索超时 (含全部重试)"""


class SearchNetworkError(Exception):
    """网络请求失败 (含 HTTP 状态码错误 / 全部重试后仍失败)"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class SearchParseError(Exception):
    """API 返回数据格式异常 (无法解析)"""


# ---------------------------------------------------------------------------
# 安全: 发请求前校验目标 URL (仅 http/https, 拒绝内网/环回/保留地址)
# ---------------------------------------------------------------------------
def _assert_public_http_url(url: str) -> None:
    """校验目标 URL 安全性, 不合规直接抛 SearchNetworkError。"""
    def _deny(reason: str) -> None:
        raise SearchNetworkError(f"目标地址不合规: {reason}")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        _deny(f"仅允许 http/https 协议, 实际为 {parsed.scheme!r}")
    host = parsed.hostname or ""
    if not host:
        _deny("URL 缺少主机名")
    if host in ("localhost",) or host.endswith((".local", ".internal")):
        _deny(f"拒绝本地/内网主机名 {host}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return  # 域名 (非 IP 字面量), 校验通过
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_reserved
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
    ):
        _deny(f"拒绝私有/保留 IP 地址 {host}")


def _search_headers() -> Dict[str, str]:
    """构造请求头: User-Agent 必带; 配置了密钥时附加 Bearer Authorization。"""
    headers = {"User-Agent": ARXIV_USER_AGENT}
    api_key = (os.getenv(SEARCH_API_KEY_ENV) or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


# ---------------------------------------------------------------------------
# 底层请求: 重试 + 超时 + 日志 (入口/出口/异常三处按规范打点)
# ---------------------------------------------------------------------------
async def _fetch_search_response(query: str, max_results: int) -> httpx.Response:
    """
    带重试的检索请求, 返回最终 HTTP 响应。

    入口/出口/异常日志规范:
      入口: [Search] 收到搜索请求，关键词: {query}，最大结果数: {max_results}
      出口: [Search] API 响应状态码: {code}，返回结果数: {count} (由解析层补充)
      异常: [Search] 发生异常: {详细堆栈}
    """
    logger.info(
        "[Search] 收到搜索请求，关键词: %s，最大结果数: %s", query, max_results
    )
    _assert_public_http_url(ARXIV_API)

    params = {
        "search_query": query,
        "start": 0,
        "max_results": max_results,
        "sortBy": "relevance",
        "sortOrder": "descending",
    }

    last_exc: Optional[Exception] = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(
                timeout=SEARCH_TIMEOUT_SECONDS,
                headers=_search_headers(),
                follow_redirects=True,
            ) as client:
                resp = await client.get(ARXIV_API, params=params)

            if resp.status_code in _RETRY_STATUS and attempt < _MAX_ATTEMPTS:
                backoff = _RETRY_BACKOFF_SECONDS[attempt - 1]
                logger.warning(
                    "[Search] 上游返回 %s, %.1fs 后进行第 %d/%d 次重试",
                    resp.status_code, backoff, attempt + 1, _MAX_ATTEMPTS,
                )
                await asyncio.sleep(backoff)
                continue
            return resp

        except httpx.TimeoutException as exc:
            last_exc = exc
            logger.error("[Search] 发生异常: %s", traceback.format_exc())
            if attempt < _MAX_ATTEMPTS:
                backoff = _RETRY_BACKOFF_SECONDS[attempt - 1]
                logger.warning(
                    "[Search] 请求超时, %.1fs 后进行第 %d/%d 次重试",
                    backoff, attempt + 1, _MAX_ATTEMPTS,
                )
                await asyncio.sleep(backoff)
                continue
            raise SearchTimeoutError("联网搜索超时") from exc

        except httpx.HTTPError as exc:
            last_exc = exc
            logger.error("[Search] 发生异常: %s", traceback.format_exc())
            if attempt < _MAX_ATTEMPTS:
                backoff = _RETRY_BACKOFF_SECONDS[attempt - 1]
                logger.warning(
                    "[Search] 网络异常 (%s), %.1fs 后进行第 %d/%d 次重试",
                    type(exc).__name__, backoff, attempt + 1, _MAX_ATTEMPTS,
                )
                await asyncio.sleep(backoff)
                continue
            raise SearchNetworkError(f"{type(exc).__name__}: {exc}") from exc

    # 循环耗尽 (仅当最后一次命中可重试状态码时到达)
    status = getattr(last_exc, "response", None)
    reason = f"上游持续返回服务端错误 (最后一次状态码 {resp.status_code})" if False else (
        f"重试 {_MAX_ATTEMPTS} 次后仍失败"
    )
    logger.error("[Search] 发生异常: %s", traceback.format_exc())
    raise SearchNetworkError(reason)


# ---------------------------------------------------------------------------
# Atom feed 解析 (无第三方依赖, 轻量正则/字符串提取)
# ---------------------------------------------------------------------------
def _parse_feed(xml: str) -> List[Dict[str, object]]:
    """解析 arXiv Atom feed; 解析失败抛 SearchParseError。"""
    try:
        if "<entry>" not in xml:
            return []  # arXiv 返回空 feed (无结果), 属正常空态非解析错误
        entries = xml.split("<entry>")[1:]  # 丢弃 feed 头
        results: List[Dict[str, object]] = []
        for entry in entries:
            entry = entry.split("</entry>")[0]

            title = _extract_tag(entry, "title").replace("\n ", "").strip()
            summary = _extract_tag(entry, "summary").replace("\n", " ").strip()
            published = _extract_tag(entry, "published").strip()
            # 完整发布日期 (YYYY-MM-DD) + 年份 (兼容旧字段)
            published_date = published[:10] if len(published) >= 10 else ""
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
                    "published_date": published_date,
                    "source": f"arXiv:{arxiv_id}" if arxiv_id else "arXiv",
                    "abstract": abstract,
                    "keywords": keywords,
                    "url": url,
                }
            )
        return results
    except SearchParseError:
        raise
    except Exception as exc:
        logger.error("[Search] 发生异常: %s", traceback.format_exc())
        raise SearchParseError(f"arXiv 响应解析失败: {exc}") from exc


def _extract_tag(xml_block: str, tag: str) -> str:
    """提取 <tag>...</tag> 内容 (仅第一个匹配)"""
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", xml_block, re.S)
    return m.group(1) if m else ""


def _extract_attr(xml_block: str, tag: str, attr: str) -> str:
    """提取 <tag ... attr="..."> 中的属性值 (仅第一个匹配)"""
    m = re.search(rf"<{tag}[^>]*\b{attr}=\"([^\"]*)\"", xml_block)
    return m.group(1) if m else ""


# ---------------------------------------------------------------------------
# 标准化映射: arXiv 原始条目 -> 统一文献结构 (严禁原始数据直接透传前端)
# ---------------------------------------------------------------------------
def _standardize_items(items: List[Dict[str, object]]) -> List[Dict[str, object]]:
    """
    字段映射 (Mapping):
      title         -> title (必填)
      authors(逗号串) -> authors (字符串数组)
      abstract      -> abstract (必填, 缺失以标题占位)
      url           -> url (必填, 缺失回退 arXiv 检索页)
      published_date-> published_date (YYYY-MM-DD, 无则 null)
      source        -> source (固定 "arXiv")
      序号          -> id (字符串, 从 "1" 起)
    """
    data: List[Dict[str, object]] = []
    for idx, item in enumerate(items, start=1):
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or "").strip()
        abstract = str(item.get("abstract") or "").strip()
        authors_raw = str(item.get("authors") or "").strip()
        data.append(
            {
                "id": str(idx),
                "title": title or "(无标题)",
                "authors": [a.strip() for a in authors_raw.split(",") if a.strip()],
                "abstract": abstract or title or "(无摘要)",
                "url": url or "https://arxiv.org",
                "published_date": str(item.get("published_date") or "").strip() or None,
                "source": "arXiv",
            }
        )
    return data


def _build_arxiv_query(keyword: str) -> str:
    """构造 arXiv search_query: 短语含空格时加引号, 全量编码交给 httpx。"""
    keyword = keyword.strip()
    if " " in keyword:
        return f'all:"{keyword}"'
    return f"all:{keyword}"


# ---------------------------------------------------------------------------
# 对外入口 1: 标准化信封 (文献检索面板 /api/literature/search 使用)
# ---------------------------------------------------------------------------
async def search_arxiv_standard(
    query: str,
    max_results: int = 5,
) -> Dict[str, object]:
    """
    联网检索并返回标准化信封 JSON:

      成功: {"status": "success", "message": "...", "data": [统一文献结构...]}
      超时: {"status": "error", "code": "TIMEOUT",       "message": "联网搜索超时，请稍后重试"}
      网络: {"status": "error", "code": "NETWORK_ERROR", "message": "网络请求失败：{具体原因}"}
      解析: {"status": "error", "code": "PARSE_ERROR",   "message": "API返回数据格式异常"}
      空结果由调用方处理 (status=success, data=[] 时按规范提示更换关键词)。
    """
    try:
        arxiv_query = _build_arxiv_query(query)
        resp = await _fetch_search_response(arxiv_query, max_results)
        if resp.status_code >= 400:
            logger.error(
                "[Search] 发生异常: 上游 HTTP %s (query=%r)",
                resp.status_code, query,
            )
            return {
                "status": "error",
                "code": "NETWORK_ERROR",
                "message": f"网络请求失败：arXiv 上游返回 HTTP {resp.status_code}",
            }
        items = _parse_feed(resp.text)
        data = _standardize_items(items)
        logger.info(
            "[Search] API 响应状态码: %s，返回结果数: %d", resp.status_code, len(data)
        )
        return {
            "status": "success",
            "message": f"在线检索成功，共 {len(data)} 条结果 (来源: arXiv)",
            "data": data,
        }
    except SearchTimeoutError:
        return {
            "status": "error",
            "code": "TIMEOUT",
            "message": "联网搜索超时，请稍后重试",
        }
    except SearchNetworkError as exc:
        return {
            "status": "error",
            "code": "NETWORK_ERROR",
            "message": f"网络请求失败：{exc.reason}",
        }
    except SearchParseError:
        return {
            "status": "error",
            "code": "PARSE_ERROR",
            "message": "API返回数据格式异常",
        }


# ---------------------------------------------------------------------------
# 对外入口 2: 兼容旧签名 (调研 Research Agent / 历史调用方, 返回原始列表)
# ---------------------------------------------------------------------------
class ArxivClient:
    """arXiv API 客户端 (异步, 带重试; 失败抛类型化异常供上层降级)"""

    def __init__(self, timeout: float = SEARCH_TIMEOUT_SECONDS) -> None:
        self.timeout = timeout

    async def search(
        self,
        query: str,
        max_results: int = 6,
    ) -> List[Dict[str, object]]:
        """
        按查询串检索 arXiv 论文, 返回原始映射列表
        [{title, authors, year, published_date, source, abstract, keywords, url}]。

        Raises:
            SearchTimeoutError / SearchNetworkError / SearchParseError
        """
        resp = await _fetch_search_response(query, max_results)
        if resp.status_code >= 400:
            raise SearchNetworkError(f"arXiv 上游返回 HTTP {resp.status_code}")
        items = _parse_feed(resp.text)
        logger.info(
            "[Search] API 响应状态码: %s，返回结果数: %d", resp.status_code, len(items)
        )
        return items


async def search_arxiv(
    query: str,
    max_results: int = 6,
) -> List[Dict[str, object]]:
    """
    检索 arXiv 并返回论文列表 (保持历史签名, Agent 编排调用方兼容);
    网络失败时抛出类型化异常, 上层应捕获并降级到本地文献库。
    """
    client = ArxivClient()
    return await client.search(query, max_results=max_results)
