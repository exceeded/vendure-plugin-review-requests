/**
 * PostgreSQL corpus test.
 *
 * Every SQL template literal in `src/**` is extracted, its `${…}` interpolations
 * are replaced with representative fragments, the statement is translated by the
 * licence-sdk dialect adapter and then PREPAREd + EXECUTEd against a scratch
 * PostgreSQL database that holds the plugin DDL plus quoted-camelCase stand-ins
 * for the Vendure tables the plugin reads. A statement that Postgres rejects
 * (unquoted camelCase column, MySQL-only function, SUM(boolean), …) fails the test.
 *
 * Skipped unless HULO_PG_URL is set, e.g.
 *   HULO_PG_URL=postgres://hulo_pg:hulo_pg_local@127.0.0.1:5432/hulo_rr_pg npx vitest run
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createDbAdapter, translateSql } from '@huloglobal/vendure-licence-sdk';

const PG_URL = process.env.HULO_PG_URL || '';
const run = PG_URL ? describe : describe.skip;

const SRC = path.resolve(__dirname, '..', 'src');

/** Representative replacements for `${expr}` interpolations found in the corpus. */
const SUBS: Record<string, string | string[]> = {
    'scope': 'table_catalog = current_database() AND table_schema = current_schema()',
    'table': 'review_config',
    'column': ['reviewMode', 'productReviewUrlTemplate'],
    'ddl': `VARCHAR(400) NOT NULL DEFAULT ''`,
    'where': ['', 'WHERE status = ?'],
    'Math.min(take, 500)': '100',
};

/** MySQL-only statements the plugin guards with a dialect check at runtime. */
const SKIP: Array<{ re: RegExp; why: string }> = [
    { re: /MODIFY\s+body\s+MEDIUMTEXT/i, why: 'MySQL-only column widening (dialect-guarded in widenTemplateBody)' },
    { re: /table_schema = DATABASE\(\)/i, why: 'MySQL information_schema scope (dialect-guarded)' },
];

/** Conflict targets for ON DUPLICATE KEY UPDATE statements, by table. */
const CONFLICT: Record<string, string[]> = {
    review_config: ['channelId'],
    review_template: ['channelId'],
};

/** Vendure tables the plugin queries — camelCase columns quoted exactly as TypeORM creates them. */
const VENDURE_DDL = [
    `CREATE TABLE "order" (id SERIAL PRIMARY KEY, code VARCHAR(16), state VARCHAR(255), "subTotalWithTax" INT, "orderPlacedAt" TIMESTAMP, "customerId" INT)`,
    `CREATE TABLE customer (id SERIAL PRIMARY KEY, "firstName" VARCHAR(255), "lastName" VARCHAR(255), "emailAddress" VARCHAR(255), "phoneNumber" VARCHAR(255), "deletedAt" TIMESTAMP, "userId" INT)`,
    `CREATE TABLE order_channels_channel ("orderId" INT, "channelId" INT, PRIMARY KEY ("orderId", "channelId"))`,
    `CREATE TABLE channel (id SERIAL PRIMARY KEY, code VARCHAR(255), token VARCHAR(255))`,
    `CREATE TABLE order_line (id SERIAL PRIMARY KEY, "orderId" INT, "productVariantId" INT)`,
    `CREATE TABLE product_variant (id SERIAL PRIMARY KEY, "productId" INT, "deletedAt" TIMESTAMP)`,
    `CREATE TABLE product (id SERIAL PRIMARY KEY, "deletedAt" TIMESTAMP)`,
    `CREATE TABLE product_translation (id SERIAL PRIMARY KEY, "baseId" INT, "languageCode" VARCHAR(255), name VARCHAR(255), slug VARCHAR(255))`,
];

// ── template-literal extraction ─────────────────────────────────────────────

interface Literal { file: string; line: number; raw: string; parts: Array<{ text: string } | { expr: string }> }

/** Walk a TS source and return every template literal, with `${}` expressions kept separate. */
function extractTemplateLiterals(src: string, file: string): Literal[] {
    const out: Literal[] = [];
    let i = 0;
    const n = src.length;
    const lineAt = (pos: number) => src.slice(0, pos).split('\n').length;
    const skipString = (quote: string) => { // i at opening quote
        i++;
        while (i < n && src[i] !== quote) { if (src[i] === '\\') i++; i++; }
        i++;
    };
    const skipComment = () => {
        if (src.startsWith('//', i)) { while (i < n && src[i] !== '\n') i++; return true; }
        if (src.startsWith('/*', i)) { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; return true; }
        return false;
    };
    const readTemplate = (): Literal['parts'] => { // i at opening backtick
        const parts: Literal['parts'] = [];
        let text = '';
        i++;
        while (i < n) {
            const ch = src[i];
            if (ch === '\\') { text += src[i + 1] === '`' ? '`' : src.slice(i, i + 2); i += 2; continue; }
            if (ch === '`') { i++; break; }
            if (ch === '$' && src[i + 1] === '{') {
                if (text) parts.push({ text }); text = '';
                i += 2;
                const start = i;
                let depth = 1;
                while (i < n && depth > 0) {
                    const c = src[i];
                    if (c === '\'' || c === '"') { skipString(c); continue; }
                    if (c === '`') { readTemplate(); continue; }
                    if (c === '{') depth++;
                    if (c === '}') { depth--; if (depth === 0) break; }
                    i++;
                }
                parts.push({ expr: src.slice(start, i).trim() });
                i++; // closing }
                continue;
            }
            text += ch; i++;
        }
        if (text) parts.push({ text });
        return parts;
    };
    // A `/` that starts a regex literal (after an operator or opening bracket)
    // must be skipped whole: a quote inside `/[,"\n]/` would otherwise open a string.
    const skipRegex = () => {
        i++;
        let inClass = false;
        while (i < n) {
            const c = src[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) { i++; return; }
            else if (c === '\n') return;
            i++;
        }
    };
    let lastSig = '';
    while (i < n) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig))) { skipRegex(); lastSig = '/'; continue; }
        if (skipComment()) continue;
        if (!/\s/.test(ch)) lastSig = ch;
        if (ch === '\'' || ch === '"') { skipString(ch); continue; }
        if (ch === '`') {
            const line = lineAt(i);
            const parts = readTemplate();
            const raw = parts.map(p => 'text' in p ? p.text : '${' + p.expr + '}').join('');
            out.push({ file, line, raw, parts });
            continue;
        }
        i++;
    }
    return out;
}

function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listTsFiles(p));
        else if (/\.ts$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) out.push(p);
    }
    return out.sort();
}

const SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i;

function substitute(expr: string): string | string[] {
    if (expr in SUBS) return SUBS[expr];
    if (/\.map\(\(\)\s*=>\s*'\?'\)\.join\(','\)$/.test(expr)) return '?';
    if (/Ph$/.test(expr)) return '?';
    throw new Error(`no substitution for \${${expr}} — add it to SUBS in pg-corpus.test.ts`);
}

/** Expand a literal into one or more concrete SQL strings. */
function concrete(lit: Literal): string[] {
    let variants: string[] = [''];
    for (const p of lit.parts) {
        const piece = 'text' in p ? [p.text] : ([] as string[]).concat(substitute(p.expr));
        variants = variants.flatMap(v => piece.map(x => v + x));
    }
    return variants;
}

function dummyFor(pgType: string): string {
    const t = pgType.toLowerCase();
    if (/int|numeric|double|real|serial/.test(t)) return '1';
    if (/timestamp|date/.test(t)) return `'2026-01-01 00:00:00'`;
    if (/bool/.test(t)) return 'true';
    return `'x@example.com'`;
}

run('PostgreSQL corpus (review-requests)', () => {
    it('every SQL statement in src/ prepares and executes on PostgreSQL', async () => {
        const { Pool } = await import('pg');
        const pool = new Pool({ connectionString: PG_URL, max: 2 });
        const raw = { options: { type: 'postgres' }, query: (sql: string, params?: any[]) => pool.query(sql, params).then(r => r.rows) };
        const db = createDbAdapter(raw as any);
        const failures: string[] = [];
        let executed = 0;
        let literals: Literal[] = [];
        let statements: Array<Literal & { sql: string }> = [];
        try {
            await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
            for (const ddl of VENDURE_DDL) await pool.query(ddl);

            literals = listTsFiles(SRC)
                .flatMap(f => extractTemplateLiterals(fs.readFileSync(f, 'utf8'), path.relative(SRC, f)))
                .filter(l => SQL_RE.test(l.raw));
            expect(literals.length).toBeGreaterThan(20);

            statements = literals.flatMap(l => concrete(l).map(sql => ({ ...l, sql })));
            const isDdl = (s: string) => /^\s*(CREATE|ALTER|DROP)\b/i.test(s);
            const ordered = [...statements.filter(s => isDdl(s.sql)), ...statements.filter(s => !isDdl(s.sql))];

            for (const st of ordered) {
                const label = `${st.file}:${st.line}`;
                const skip = SKIP.find(k => k.re.test(st.sql));
                if (skip) continue;
                try {
                    if (isDdl(st.sql)) { await db.query(st.sql); executed++; continue; }
                    const table = (st.sql.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+`?([A-Za-z0-9_]+)`?/i) || [])[1] || '';
                    const translated = translateSql(st.sql, 'postgres', { conflictColumns: CONFLICT[table] });
                    const name = `corpus_${executed}`;
                    await pool.query(`PREPARE ${name} AS ${translated}`);
                    const { rows } = await pool.query(`SELECT parameter_types::text[] AS t FROM pg_prepared_statements WHERE name = $1`, [name]);
                    const types: string[] = rows[0]?.t || [];
                    await pool.query(`EXECUTE ${name}${types.length ? `(${types.map(dummyFor).join(', ')})` : ''}`);
                    await pool.query(`DEALLOCATE ${name}`);
                    executed++;
                } catch (e: any) {
                    failures.push(`${label}: ${e.message}\n    ${st.sql.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
                }
            }
        } finally {
            await pool.end();
        }
        console.log(`pg-corpus: ${literals.length} literals, ${statements.length} statements, ${executed} executed, ${failures.length} failed`);
        if (failures.length) console.error(failures.join('\n\n'));
        expect(failures, failures.join('\n')).toEqual([]);
        expect(executed).toBeGreaterThan(20);
    }, 60_000);
});
