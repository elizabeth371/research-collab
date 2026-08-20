-- ============================================================
-- 面向科研诚信的多Agent实时协同与版权溯源系统
-- PostgreSQL 数据库初始化脚本
--
-- 说明: 使用 postgres 超级用户执行:
--   psql -U postgres -f database/init.sql
-- ============================================================

-- 确保使用 UTF8 编码
CREATE DATABASE research_colab
    WITH ENCODING 'UTF8'
    TEMPLATE template0;

\connect research_colab;

-- ============================================================
-- 扩展: pgcrypto 用于哈希、uuid 生成
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. 用户表
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(64)  NOT NULL UNIQUE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    display_name  VARCHAR(128) NOT NULL,
    avatar_url    TEXT,
    role          VARCHAR(32)  NOT NULL DEFAULT 'researcher'
                  CHECK (role IN ('admin', 'researcher', 'collaborator', 'ai_agent')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. 文档表
--    yjs_state 存储 Yjs CRDT 更新快照 (二进制)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title             VARCHAR(512) NOT NULL,
    owner_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Yjs 协同状态快照 (update message 二进制)
    yjs_state         BYTEA,
    -- 文档明文快照，便于快速预览与全文检索
    content           TEXT NOT NULL DEFAULT '',
    -- 0-未检测 1-含AI水印 2-纯人类
    watermark_status  SMALLINT NOT NULL DEFAULT 0,
    agent_session_id  UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 文档-协作者中间表
CREATE TABLE IF NOT EXISTS document_collaborators (
    document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, user_id)
);

-- ============================================================
-- 3. 操作日志表 (版权溯源哈希链)
--    prev_hash -> current_hash = sha256(prev_hash + operation + ts)
--    operation_jsonb 为操作详细内容
-- ============================================================
CREATE TABLE IF NOT EXISTS op_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id        UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    op_type       VARCHAR(32) NOT NULL
                  CHECK (op_type IN ('insert', 'delete', 'replace',
                                     'ai_generate', 'watermark_checked')),
    operation     JSONB NOT NULL DEFAULT '{}'::jsonb,
    prev_hash     CHAR(64) NOT NULL DEFAULT '',
    current_hash  CHAR(64) NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. 水印记录表 (Kirchenbauer 算法记录: 绿名单种子/密钥)
-- ============================================================
CREATE TABLE IF NOT EXISTS watermark_records (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id        UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    model_name    VARCHAR(128) NOT NULL,
    -- 绿名单比例 gamma (默认 0.5)
    gamma         FLOAT NOT NULL DEFAULT 0.5,
    -- 水印强度 delta (默认 2.0)
    delta         FLOAT NOT NULL DEFAULT 2.0,
    -- 哈希函数使用的密钥 (Kirchenbauer scheme key)
    secret_key    BYTEA NOT NULL,
    -- 涉及水印的 token 序列 (调试用, JSONB)
    token_seq     JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 索引
-- ============================================================

-- 文档索引
CREATE INDEX IF NOT EXISTS idx_documents_owner       ON documents (owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_updated_at  ON documents (updated_at DESC);

-- 操作日志索引: 按文档 + 创建时间 (支持溯源链路回放)
CREATE INDEX IF NOT EXISTS idx_oplogs_doc_created    ON op_logs (doc_id, created_at ASC);
-- 操作日志哈希链: 按前序哈希查询 (支持链校验与回溯)
CREATE INDEX IF NOT EXISTS idx_oplogs_prev_hash      ON op_logs (prev_hash);
CREATE INDEX IF NOT EXISTS idx_oplogs_op_type        ON op_logs (op_type);

-- 水印记录索引
CREATE INDEX IF NOT EXISTS idx_watermarks_doc         ON watermark_records (doc_id);

-- 用户索引
CREATE INDEX IF NOT EXISTS idx_users_role             ON users (role);