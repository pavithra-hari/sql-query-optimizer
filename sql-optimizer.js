const sqlInput = document.querySelector("#sqlInput");
const schemaInput = document.querySelector("#schemaInput");
const dialectInput = document.querySelector("#dialect");
const optimizeButton = document.querySelector("#optimize");
const sampleButton = document.querySelector("#loadSample");
const copyButton = document.querySelector("#copyOutput");
const buildQueryButton = document.querySelector("#buildQuery");
const analyzeExplainButton = document.querySelector("#analyzeExplain");
const saveRunButton = document.querySelector("#saveRun");
const queryStats = document.querySelector("#queryStats");
const optimizedOutput = document.querySelector("#optimizedOutput");
const tabContent = document.querySelector("#tabContent");
const tabs = document.querySelectorAll(".tab");
const intentInput = document.querySelector("#intentInput");
const explainInput = document.querySelector("#explainInput");

const scoreRing = document.querySelector("#scoreRing");
const scoreValue = document.querySelector("#scoreValue");
const scoreTitle = document.querySelector("#scoreTitle");
const scoreText = document.querySelector("#scoreText");
const costMetric = document.querySelector("#costMetric");
const riskMetric = document.querySelector("#riskMetric");
const indexMetric = document.querySelector("#indexMetric");

let activeTab = "findings";
let lastReport = null;
const historyKey = "sqlOptimizerHistory";

const sampleSql = `SELECT *
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE LOWER(c.email) = 'maya@example.com'
  AND YEAR(o.created_at) = 2025
  AND o.status != 'cancelled'
ORDER BY o.created_at DESC;`;

const sampleSchema = `orders(id PK, customer_id, status, created_at, total)
customers(id PK, email, region)
order_items(id PK, order_id, sku, quantity)

Existing indexes:
customers(id)
orders(id)`;

function updateStats() {
  const text = sqlInput.value.trim();
  const lines = text ? text.split(/\n/).length : 0;
  queryStats.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
}

function normalizeWhitespace(sql) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*;\s*$/, "")
    .trim();
}

function formatSql(sql) {
  const keywords = [
    "SELECT",
    "FROM",
    "WHERE",
    "GROUP BY",
    "HAVING",
    "ORDER BY",
    "LIMIT",
    "OFFSET",
    "INNER JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "FULL JOIN",
    "CROSS JOIN",
    "UNION",
  ];
  let formatted = normalizeWhitespace(sql);

  keywords.forEach((keyword) => {
    const pattern = new RegExp(`\\s+${keyword}\\s+`, "gi");
    formatted = formatted.replace(pattern, `\n${keyword} `);
  });

  formatted = formatted.replace(
    /\s+(JOIN)\s+/gi,
    (match, keyword, offset, text) => {
      const prefix = text.slice(Math.max(0, offset - 6), offset).toUpperCase();
      return /(INNER|LEFT|RIGHT|FULL|CROSS)\s*$/.test(prefix) ? match : `\n${keyword} `;
    }
  );
  formatted = formatted.replace(/\s+AND\s+/gi, "\n  AND ");
  formatted = formatted.replace(/\s+OR\s+/gi, "\n  OR ");
  formatted = formatted.replace(/\s+ON\s+/gi, "\n  ON ");
  return `${formatted};`;
}

const SQL_KEYWORDS = new Set([
  "where", "group", "order", "having", "limit", "offset", "fetch", "on", "using",
  "join", "left", "right", "inner", "full", "cross", "union", "select", "and",
  "or", "as", "set", "into", "values", "top", "by",
]);

function parenDepthAt(sql, index) {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if (sql[i] === "(") {
      depth += 1;
    } else if (sql[i] === ")") {
      depth -= 1;
    }
  }
  return depth;
}

function extractFromClause(sql) {
  const fromMatches = [...sql.matchAll(/\bfrom\b/gi)];
  const topLevelFrom = fromMatches.find((match) => parenDepthAt(sql, match.index) === 0);
  if (!topLevelFrom) {
    return "";
  }

  const rest = sql.slice(topLevelFrom.index + topLevelFrom[0].length);
  const endMatch = rest.match(
    /\bjoin\b|\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\boffset\b|\bunion\b/i
  );
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

function tableAliases(sql) {
  const aliases = new Map();

  extractFromClause(sql)
    .split(",")
    .forEach((part) => {
      const tableMatch = part.trim().match(/^([a-z_][\w.]*)\s*(?:as\s+)?([a-z_][\w]*)?/i);
      if (!tableMatch) {
        return;
      }
      const table = tableMatch[1].split(".").pop();
      const alias = tableMatch[2] && !SQL_KEYWORDS.has(tableMatch[2].toLowerCase()) ? tableMatch[2] : table;
      aliases.set(alias, table);
    });

  const joinPattern = /\bjoin\s+([a-z_][\w.]*)\s+(?:as\s+)?([a-z_][\w]*)?/gi;
  let match;
  while ((match = joinPattern.exec(sql))) {
    const table = match[1].split(".").pop();
    const alias = match[2] && !SQL_KEYWORDS.has(match[2].toLowerCase()) ? match[2] : table;
    aliases.set(alias, table);
  }

  return aliases;
}

function stripStringLiterals(sql) {
  return sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function detectColumns(sql) {
  const clean = stripStringLiterals(sql);
  const aliases = tableAliases(clean);
  const columns = [];
  const pattern = /\b([a-z_][\w]*)\.([a-z_][\w]*)\b/gi;
  let match;
  while ((match = pattern.exec(clean))) {
    columns.push({
      alias: match[1],
      table: aliases.get(match[1]) || match[1],
      column: match[2],
    });
  }
  return columns;
}

function existingIndexSet(schema) {
  const singles = new Set();
  const compounds = new Set();
  let inIndexSection = false;

  schema.split(/\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (/^(?:existing\s+)?indexe?s?\s*:?$/i.test(trimmed)) {
      inIndexSection = true;
      return;
    }

    const tableColumns = trimmed.match(/^([a-z_][\w.]*)\s*\(([^)]+)\)/i);
    if (inIndexSection && tableColumns) {
      const table = tableColumns[1].split(".").pop().toLowerCase();
      const cols = tableColumns[2]
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)
        .map((col) => col.toLowerCase());
      cols.forEach((col) => singles.add(`${table}.${col}`));
      if (cols.length > 1) {
        compounds.add(`${table}.${[...cols].sort().join("_")}`);
      }
      return;
    }

    const inline = trimmed.match(/^(?:idx|index|key)\b[:\s]*([a-z_][\w]*)[\s,]+([a-z_][\w]*)/i);
    if (inline) {
      singles.add(`${inline[1].toLowerCase()}.${inline[2].toLowerCase()}`);
    }
  });

  return { singles, compounds };
}

function filterClauses(sql) {
  const whereMatch = sql.match(
    /\bwhere\b([\s\S]*?)(?=\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\boffset\b|\bunion\b|$)/i
  );
  const onClauses = [...sql.matchAll(
    /\bon\b([\s\S]*?)(?=\bjoin\b|\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\boffset\b|\bunion\b|$)/gi
  )].map((match) => match[1]);
  const usingClauses = [...sql.matchAll(/\busing\s*\(([^)]*)\)/gi)].map((match) => match[1]);

  return {
    qualified: [whereMatch ? whereMatch[1] : "", ...onClauses].join(" "),
    bare: usingClauses.join(" "),
  };
}

function appearsInFilter(alias, column, clauses) {
  const qualifiedPattern = new RegExp(`\\b${alias}\\.${column}\\b`, "i");
  const barePattern = new RegExp(`\\b${column}\\b`, "i");
  return qualifiedPattern.test(clauses.qualified) || barePattern.test(clauses.bare);
}

function pushFinding(report, severity, title, body) {
  report.findings.push({ severity, title, body });
}

function pushPlan(report, severity, title, body) {
  report.plan.push({ severity, title, body });
}

function pushBreakdown(report, impact, title, body) {
  report.breakdown.push({
    severity: impact < 0 ? "high" : "good",
    impact,
    title,
    body,
  });
}

function analyzeSql(rawSql, schema, dialect, explainText) {
  const report = {
    findings: [],
    indexes: [],
    plan: [],
    explain: [],
    tree: [],
    breakdown: [],
    diff: [],
    history: [],
    cost: 20,
    risks: 0,
    original: rawSql.trim(),
    optimized: rawSql.trim(),
  };
  pushBreakdown(report, -20, "Baseline cost", "Every query carries a baseline analysis cost before specific findings are applied.");

  const sql = normalizeWhitespace(rawSql);
  const columns = detectColumns(sql);
  const existingIndexes = existingIndexSet(schema);
  const explainFindings = analyzeExplain(explainText);
  report.explain.push(...explainFindings.items);
  report.tree.push(...explainFindings.nodes);
  report.cost += explainFindings.cost;
  report.risks += explainFindings.risks;
  explainFindings.breakdown.forEach((item) => report.breakdown.push(item));

  if (!sql) {
    pushFinding(report, "medium", "No query entered", "Paste a SELECT, UPDATE, INSERT, or DELETE statement to analyze.");
    report.optimized = "No SQL query provided.";
    report.cost = Math.max(10, Math.min(100, report.cost));
    report.diff = buildDiff(report.original, report.optimized);
    report.history = readHistory();
    return report;
  }

  if (/select\s+\*/i.test(sql)) {
    report.cost += 18;
    report.risks += 1;
    pushBreakdown(report, -18, "SELECT *", "Unneeded columns increase reads, memory pressure, and transfer size.");
    pushFinding(
      report,
      "high",
      "Avoid SELECT *",
      "Select only the columns your screen, API, or job actually needs so the database reads and transfers less data."
    );
    report.optimized = report.optimized.replace(/select\s+\*/i, "SELECT /* choose explicit columns */");
  }

  if (!/\bwhere\b/i.test(sql) && /\b(select|update|delete)\b/i.test(sql)) {
    report.cost += 25;
    report.risks += 1;
    pushBreakdown(report, -25, "Broad scan risk", "No WHERE clause means the database may inspect every row.");
    pushFinding(report, "high", "Missing WHERE filter", "A broad scan can be expensive and risky on large tables.");
  }

  if (/\blower\s*\(|\bupper\s*\(|\bdate\s*\(|\byear\s*\(|\bmonth\s*\(|\bextract\s*\(|\bstrftime\s*\(/i.test(sql)) {
    report.cost += 18;
    report.risks += 1;
    pushBreakdown(report, -18, "Function predicate", "Function-wrapped columns often block normal index access.");
    pushFinding(
      report,
      "medium",
      "Function-wrapped columns",
      "Wrapping indexed columns in functions can prevent normal index usage. Prefer normalized values or range predicates."
    );
  }

  const dateExtractionRewrite = {
    postgres: {
      test: /\bextract\s*\(\s*year\s+from\s+[a-z_][\w]*\.[a-z_][\w]*\s*\)\s*=\s*\d{4}/i,
      apply: (text) =>
        text.replace(
          /\bextract\s*\(\s*year\s+from\s+([a-z_][\w]*\.[a-z_][\w]*)\s*\)\s*=\s*(\d{4})/gi,
          (_, column, year) => `${column} >= '${year}-01-01' AND ${column} < '${Number(year) + 1}-01-01'`
        ),
    },
    sqlite: {
      test: /\bstrftime\s*\(\s*'%Y'\s*,\s*[a-z_][\w]*\.[a-z_][\w]*\s*\)\s*=\s*'?\d{4}'?/i,
      apply: (text) =>
        text.replace(
          /\bstrftime\s*\(\s*'%Y'\s*,\s*([a-z_][\w]*\.[a-z_][\w]*)\s*\)\s*=\s*'?(\d{4})'?/gi,
          (_, column, year) => `${column} >= '${year}-01-01' AND ${column} < '${Number(year) + 1}-01-01'`
        ),
    },
  }[dialect] || {
    test: /\byear\s*\(\s*[a-z_][\w]*\.[a-z_][\w]*\s*\)\s*=\s*\d{4}/i,
    apply: (text) =>
      text.replace(
        /\byear\s*\(\s*([a-z_][\w]*\.[a-z_][\w]*)\s*\)\s*=\s*(\d{4})/gi,
        (_, column, year) => `${column} >= '${year}-01-01' AND ${column} < '${Number(year) + 1}-01-01'`
      ),
  };

  if (dateExtractionRewrite.test.test(sql)) {
    report.optimized = dateExtractionRewrite.apply(report.optimized);
    pushPlan(report, "good", "Converted date-extraction predicate", "The rewrite uses a date range that can use a normal index.");
  }

  if (/\bnot\s+in\s*\(/i.test(sql)) {
    report.cost += 12;
    report.risks += 1;
    pushBreakdown(report, -12, "NOT IN", "NULL handling can make NOT IN both slower and easier to get wrong.");
    pushFinding(report, "medium", "NOT IN can be fragile", "If the subquery returns NULL, NOT IN can behave unexpectedly. Prefer NOT EXISTS when possible.");
  }

  if (/\bor\b/i.test(sql)) {
    report.cost += 8;
    pushBreakdown(report, -8, "OR predicate", "OR branches can make it harder for the planner to use selective indexes.");
    pushFinding(report, "medium", "OR predicate detected", "Several OR branches can reduce index selectivity. Consider UNION ALL when branches target different indexed columns.");
  }

  if (/\blike\s+['"]%/i.test(sql)) {
    report.cost += 16;
    report.risks += 1;
    pushBreakdown(report, -16, "Leading wildcard", "A leading wildcard usually prevents b-tree index seeks.");
    const fullTextAlternative = {
      postgres: "consider a trigram index (CREATE EXTENSION pg_trgm; CREATE INDEX ... USING GIN (col gin_trgm_ops))",
      mysql: "consider a FULLTEXT index instead of LIKE for substring search",
      sqlserver: "consider Full-Text Search (CREATE FULLTEXT INDEX) instead of LIKE for substring search",
      sqlite: "consider an FTS5 virtual table instead of LIKE for substring search",
    }[dialect] || "consider a full-text search index instead of LIKE for substring search";
    pushFinding(
      report,
      "high",
      "Leading wildcard search",
      `LIKE '%value' usually cannot use a standard b-tree index; ${fullTextAlternative}.`
    );
  }

  if (/\border\s+by\b/i.test(sql) && !/\blimit\b|\bfetch\s+first\b|\btop\s+\d+/i.test(sql)) {
    report.cost += 8;
    pushBreakdown(report, -8, "Unbounded sort", "Sorting without pagination can force large memory or disk work.");
    pushFinding(report, "medium", "Unbounded sort", "ORDER BY without a row limit can force large sorts. Add pagination when the caller only needs one page.");
  }

  const hasImplicitCommaJoin = extractFromClause(sql).includes(",");
  const joinCount = (sql.match(/\bjoin\b/gi) || []).length;
  const crossJoinCount = (sql.match(/\bcross\s+join\b/gi) || []).length;
  const joinPredicateCount = (sql.match(/\bon\b/gi) || []).length + (sql.match(/\busing\s*\(/gi) || []).length;

  if (hasImplicitCommaJoin || joinCount - crossJoinCount > joinPredicateCount) {
    report.cost += 22;
    report.risks += 1;
    pushBreakdown(report, -22, "Missing join predicate", "Missing join predicates can multiply rows unexpectedly.");
    pushFinding(
      report,
      "high",
      "Possible Cartesian product",
      hasImplicitCommaJoin
        ? "The FROM clause lists multiple tables separated by commas with no join predicate. Use explicit JOIN ... ON syntax instead."
        : "A JOIN is missing its ON/USING predicate, which can create a Cartesian product."
    );
  }

  const clauses = filterClauses(sql);
  const indexCandidates = new Map();
  columns.forEach(({ alias, table, column }) => {
    const columnRef = `${table}.${column}`.toLowerCase();
    if (appearsInFilter(alias, column, clauses) && !existingIndexes.singles.has(columnRef)) {
      indexCandidates.set(columnRef, { table, column });
    }
  });

  indexCandidates.forEach(({ table, column }) => {
    const statement = indexStatement(table, column, dialect);
    report.indexes.push({
      severity: "good",
      title: `${table}.${column}`,
      body: statement,
    });
  });

  if (report.indexes.length) {
    report.cost -= Math.min(22, report.indexes.length * 6);
    pushBreakdown(report, Math.min(22, report.indexes.length * 6), "Index opportunities", "Suggested indexes can reduce scan and join work after validation.");
    pushPlan(report, "good", "Added index candidates", "Create indexes after checking cardinality, write volume, and existing compound indexes.");
  }

  const compoundCandidates = compoundIndexCandidates(sql, columns, existingIndexes, dialect);
  if (compoundCandidates.length) {
    const compoundBonus = Math.min(15, compoundCandidates.length * 5);
    report.cost -= compoundBonus;
    pushBreakdown(report, compoundBonus, "Compound index candidates", "A multi-column index may match filter plus sort/join access better than single-column indexes.");
  }
  compoundCandidates.forEach((index) => {
    report.indexes.unshift(index);
  });

  if (!report.findings.length) {
    pushFinding(report, "good", "Looks reasonably efficient", "No obvious anti-patterns were detected by the static analyzer.");
  }

  if (!report.plan.length) {
    pushPlan(report, "good", "Run EXPLAIN", "Compare the current and rewritten query with EXPLAIN ANALYZE on production-like data.");
  }

  if (!report.explain.length) {
    report.explain.push({
      severity: "medium",
      title: "No EXPLAIN plan pasted",
      body: "For complex queries, paste EXPLAIN ANALYZE output here to catch real scan, join, sort, and estimate problems.",
    });
  }

  report.cost = Math.max(10, Math.min(100, report.cost));
  report.optimized = formatSql(report.optimized);
  report.diff = buildDiff(report.original, report.optimized);
  report.history = readHistory();
  return report;
}

function indexStatement(table, column, dialect) {
  const name = `idx_${table}_${column}`.replace(/[^\w]+/g, "_").replace(/_$/, "");
  if (dialect === "postgres") {
    return `CREATE INDEX CONCURRENTLY ${name} ON ${table} (${column}); -- run outside a transaction block`;
  }
  if (dialect === "mysql") {
    return `CREATE INDEX ${name} ON ${table} (${column}) ALGORITHM=INPLACE, LOCK=NONE; -- requires InnoDB`;
  }
  if (dialect === "sqlserver") {
    return `CREATE INDEX ${name} ON ${table} (${column}) WITH (ONLINE = ON); -- ONLINE requires Enterprise/Azure SQL`;
  }
  return `CREATE INDEX ${name} ON ${table} (${column});`;
}

function compoundIndexCandidates(sql, columns, existingIndexes, dialect) {
  const byTable = new Map();
  const clauses = filterClauses(sql);
  columns.forEach(({ alias, table, column }) => {
    if (!byTable.has(table)) {
      byTable.set(table, new Set());
    }
    if (appearsInFilter(alias, column, clauses)) {
      byTable.get(table).add(column);
    }
  });

  const aliasToTable = tableAliases(sql);
  const orderMatch = sql.match(/\border\s+by\s+([a-z_][\w]*)\.([a-z_][\w]*)/i);
  if (orderMatch) {
    const orderTable = aliasToTable.get(orderMatch[1]) || orderMatch[1];
    if (byTable.has(orderTable)) {
      byTable.get(orderTable).add(orderMatch[2]);
    }
  }

  return [...byTable.entries()]
    .filter(([, columnSet]) => columnSet.size >= 2)
    .slice(0, 3)
    .map(([table, columnSet]) => {
      const compoundColumns = [...columnSet].slice(0, 3);
      const key = `${table}.${[...compoundColumns].sort().join("_")}`.toLowerCase();
      return {
        severity: existingIndexes.compounds.has(key) ? "medium" : "good",
        title: `${table} (${compoundColumns.join(", ")})`,
        body: indexStatement(table, compoundColumns.join(", "), dialect),
      };
    });
}

function buildDiff(original, optimized) {
  const left = formatComparableSql(original).split("\n").filter(Boolean);
  const right = formatComparableSql(optimized).split("\n").filter(Boolean);
  const maxLength = Math.max(left.length, right.length);
  const rows = [];

  for (let index = 0; index < maxLength; index += 1) {
    if (left[index] === right[index]) {
      rows.push({ severity: "good", marker: "=", body: right[index] || "" });
    } else {
      if (left[index]) {
        rows.push({ severity: "high", marker: "-", body: left[index] });
      }
      if (right[index]) {
        rows.push({ severity: "good", marker: "+", body: right[index] });
      }
    }
  }

  return rows.length
    ? rows
    : [{ severity: "good", marker: "=", body: "No text-level query changes were made." }];
}

function formatComparableSql(sql) {
  if (!sql.trim()) {
    return "";
  }
  return formatSql(sql).replace(/;$/, "");
}

function parseSchemaTables(schema) {
  const tables = [];
  let inIndexSection = false;

  schema.split(/\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (/^(?:existing\s+)?indexe?s?\s*:?$/i.test(trimmed)) {
      inIndexSection = true;
      return;
    }
    if (inIndexSection) {
      return;
    }

    const match = trimmed.match(/^([a-z_][\w.]*)\s*\(([^)]+)\)/i);
    if (match) {
      tables.push({
        name: match[1].split(".").pop(),
        columns: match[2]
          .split(",")
          .map((column) => column.trim().split(/\s+/)[0])
          .filter(Boolean),
      });
    }
  });

  return tables;
}

function chooseTable(tables, intent) {
  const lowered = intent.toLowerCase();
  if (/\btotal|sum|revenue|spend|spent|amount|sales|orders?\b/.test(lowered)) {
    const factTable = tables.find((table) =>
      table.columns.some((column) => /total|amount|price|revenue|cost|created|date/.test(column))
    );
    if (factTable) {
      return factTable;
    }
  }
  return (
    tables.find((table) => lowered.includes(table.name.toLowerCase())) ||
    tables.find((table) => lowered.includes(table.name.toLowerCase().replace(/s$/, ""))) ||
    tables[0] || { name: "your_table", columns: ["id", "created_at"] }
  );
}

function matchingColumns(table, intent, fallbacks) {
  const lowered = intent.toLowerCase();
  const matches = table.columns.filter((column) => {
    const readable = column.replace(/_/g, " ").toLowerCase();
    return lowered.includes(column.toLowerCase()) || lowered.includes(readable);
  });
  return matches.length ? matches : fallbacks.filter((column) => table.columns.includes(column));
}

function buildSqlFromIntent(intent, schema, dialect) {
  const tables = parseSchemaTables(schema);
  const primary = chooseTable(tables, intent);
  const lowered = intent.toLowerCase();
  const selected = matchingColumns(primary, intent, ["id", "name", "email", "status", "created_at"]).slice(0, 5);
  const selectColumns = selected.length ? selected.map((column) => `${primary.name}.${column}`) : [`${primary.name}.*`];
  const filters = [];
  const joins = [];
  const groupColumns = [];
  const orderParts = [];
  let limit = "";

  tables
    .filter((table) => table.name !== primary.name)
    .forEach((table) => {
      const singular = table.name.replace(/s$/, "");
      const foreignKey = `${singular}_id`;
      if (primary.columns.includes(foreignKey) || table.columns.includes(`${primary.name.replace(/s$/, "")}_id`)) {
        const left = primary.columns.includes(foreignKey)
          ? `${primary.name}.${foreignKey}`
          : `${primary.name}.id`;
        const right = primary.columns.includes(foreignKey)
          ? `${table.name}.id`
          : `${table.name}.${primary.name.replace(/s$/, "")}_id`;
        if (lowered.includes(table.name.toLowerCase()) || lowered.includes(singular.toLowerCase())) {
          joins.push(`JOIN ${table.name} ON ${left} = ${right}`);
        }
      }
    });

  const yearMatch = lowered.match(/\b(20\d{2}|19\d{2})\b/);
  const dateColumn = primary.columns.find((column) => /date|created|updated|time/.test(column));
  if (yearMatch && dateColumn) {
    const nextYear = Number(yearMatch[1]) + 1;
    filters.push(`${primary.name}.${dateColumn} >= '${yearMatch[1]}-01-01'`);
    filters.push(`${primary.name}.${dateColumn} < '${nextYear}-01-01'`);
  }

  ["active", "completed", "cancelled", "pending", "paid", "failed"].forEach((status) => {
    if (lowered.includes(status) && primary.columns.includes("status")) {
      filters.push(`${primary.name}.status = '${status}'`);
    }
  });

  if (/\btotal|sum|revenue|spend|spent|amount\b/.test(lowered)) {
    const amountTable =
      [primary, ...tables].find((table) =>
        table.columns.some((column) => /total|amount|price|revenue|cost/.test(column))
      ) || primary;
    const amountColumn = amountTable.columns.find((column) => /total|amount|price|revenue|cost/.test(column)) || "amount";
    selectColumns.push(`SUM(${amountTable.name}.${amountColumn}) AS total_${amountColumn}`);
    orderParts.push(`total_${amountColumn} DESC`);
  }

  if (/\bcount|number of|how many\b/.test(lowered)) {
    selectColumns.push("COUNT(*) AS row_count");
  }

  if (/\bby customer|each customer|per customer\b/.test(lowered)) {
    const customerTable = tables.find((table) => table.name === "customers");
    if (customerTable && primary.name !== "customers") {
      if (!joins.some((join) => join.includes("customers"))) {
        joins.push(`JOIN customers ON ${primary.name}.customer_id = customers.id`);
      }
      groupColumns.push("customers.id");
      selectColumns.unshift("customers.id");
      if (customerTable.columns.includes("email")) {
        selectColumns.unshift("customers.email");
        groupColumns.push("customers.email");
      }
    }
  }

  if (/\bgroup|each|per\b/.test(lowered) && !groupColumns.length) {
    const groupColumn = primary.columns.find((column) => /status|region|category|type/.test(column));
    if (groupColumn) {
      groupColumns.push(`${primary.name}.${groupColumn}`);
    }
  }

  if (/\bnewest|latest|recent|desc|highest|top\b/.test(lowered) && !orderParts.length) {
    const orderColumn =
      primary.columns.find((column) => /created|date|time|total|amount|price/.test(column)) || primary.columns[0] || "id";
    orderParts.push(`${primary.name}.${orderColumn} DESC`);
  } else if (/\boldest|ascending|lowest\b/.test(lowered)) {
    const orderColumn = primary.columns.find((column) => /created|date|time|total|amount|price/.test(column)) || "id";
    orderParts.push(`${primary.name}.${orderColumn} ASC`);
  }

  const limitMatch = lowered.match(/\btop\s+(\d+)|\blimit\s+(\d+)|\bfirst\s+(\d+)/);
  if (limitMatch) {
    limit = dialect === "sqlserver" ? "" : `LIMIT ${limitMatch[1] || limitMatch[2] || limitMatch[3]}`;
  }

  const hasAggregate = selectColumns.some((column) => /\b(?:SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(column));
  const groupSet = new Set(groupColumns);
  const finalSelectColumns = hasAggregate
    ? selectColumns.filter((column) => /\b(?:SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(column) || groupSet.has(column))
    : selectColumns;
  const uniqueSelect = [...new Set(finalSelectColumns)];
  const sqlServerTop = dialect === "sqlserver" && limitMatch ? `TOP ${limitMatch[1] || limitMatch[2] || limitMatch[3]} ` : "";
  const lines = [
    `SELECT ${sqlServerTop}${uniqueSelect.join(", ")}`,
    `FROM ${primary.name}`,
    ...joins,
  ];
  if (filters.length) {
    lines.push(`WHERE ${filters.join("\n  AND ")}`);
  }
  if (groupColumns.length) {
    lines.push(`GROUP BY ${[...new Set(groupColumns)].join(", ")}`);
  }
  if (orderParts.length) {
    lines.push(`ORDER BY ${orderParts.join(", ")}`);
  }
  if (limit) {
    lines.push(limit);
  }

  return `${lines.join("\n")};`;
}

function analyzeExplain(planText) {
  const text = planText.trim();
  const result = { items: [], nodes: [], breakdown: [], cost: 0, risks: 0 };
  if (!text) {
    return result;
  }

  const checks = [
    {
      pattern: /\b(seq scan|table scan|full table scan)\b/i,
      severity: "high",
      cost: 18,
      title: "Sequential or full table scan",
      body: "A large table scan is often the biggest bottleneck. Check filters and indexes for the scanned table.",
    },
    {
      pattern: /\bnested loop\b/i,
      severity: "medium",
      cost: 10,
      title: "Nested loop join",
      body: "Nested loops are fine for small inputs, but expensive when the outer side has many rows.",
    },
    {
      pattern: /\b(?:external merge|disk|temp)\b/i,
      severity: "high",
      cost: 16,
      title: "Sort or hash spilled to disk",
      body: "Disk spill usually means the query needs less data before sorting/hash work, better indexes, or more work memory.",
    },
    {
      pattern: /\b(?:filesort|temporary)\b/i,
      severity: "medium",
      cost: 10,
      title: "Temporary sort work",
      body: "The database is doing extra sort or temp-table work. An index matching filters and ORDER BY may help.",
    },
    {
      pattern: /\b(?:hash join|hash aggregate)\b/i,
      severity: "medium",
      cost: 6,
      title: "Hash operation",
      body: "Hash joins and aggregates can be healthy, but watch memory use and row counts on complex queries.",
    },
    {
      pattern: /\brows removed by filter\b/i,
      severity: "medium",
      cost: 8,
      title: "Many rows filtered late",
      body: "Rows are being read before being discarded. Try moving selective filters earlier or indexing them.",
    },
  ];

  checks.forEach((check) => {
    if (check.pattern.test(text)) {
      result.items.push({
        severity: check.severity,
        title: check.title,
        body: check.body,
      });
      result.cost += check.cost;
      result.risks += check.severity === "high" ? 1 : 0;
      result.breakdown.push({
        severity: check.severity,
        impact: -check.cost,
        title: check.title,
        body: check.body,
      });
    }
  });

  result.nodes = parseExplainNodes(text);

  const costMatches = [...text.matchAll(/cost=(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)/gi)];
  if (costMatches.length) {
    const highestCost = Math.max(...costMatches.map((match) => Number(match[2])));
    if (highestCost > 10000) {
      result.items.push({
        severity: "high",
        title: "High estimated plan cost",
        body: `The highest estimated cost is ${Math.round(highestCost).toLocaleString()}. Focus on the node with that cost first.`,
      });
      result.cost += 14;
      result.risks += 1;
      result.breakdown.push({
        severity: "high",
        impact: -14,
        title: "High plan cost",
        body: "A high-cost plan branch deserves first inspection.",
      });
    }
  }

  const actualMatches = [...text.matchAll(/actual time=(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)/gi)];
  if (actualMatches.length) {
    const slowest = Math.max(...actualMatches.map((match) => Number(match[2])));
    if (slowest > 1000) {
      result.items.push({
        severity: "high",
        title: "Slow actual runtime node",
        body: `One plan node reports about ${Math.round(slowest).toLocaleString()} ms. Tune that branch of the plan first.`,
      });
      result.cost += 14;
      result.risks += 1;
      result.breakdown.push({
        severity: "high",
        impact: -14,
        title: "Slow runtime node",
        body: "Actual runtime points to the branch users are waiting on.",
      });
    }
  }

  const estimateMatches = [...text.matchAll(/rows=(\d+)[^\n]*actual[^\n]*rows=(\d+)/gi)];
  const badEstimate = estimateMatches.some((match) => {
    const estimated = Number(match[1]);
    const actual = Number(match[2]);
    return estimated > 0 && actual > 0 && Math.max(estimated, actual) / Math.min(estimated, actual) >= 10;
  });
  if (badEstimate) {
    result.items.push({
      severity: "medium",
      title: "Row estimate mismatch",
      body: "The planner expected very different row counts than it got. Refresh statistics or add better constraints/indexes.",
    });
    result.cost += 10;
    result.breakdown.push({
      severity: "medium",
      impact: -10,
      title: "Bad row estimate",
      body: "Bad estimates often lead the planner to choose the wrong join or scan strategy.",
    });
  }

  if (!result.items.length) {
    result.items.push({
      severity: "good",
      title: "No obvious EXPLAIN red flags",
      body: "The pasted plan did not match the main scan, join, spill, or estimate warning patterns.",
    });
  }

  return result;
}

function parseExplainNodes(text) {
  const lines = text.split("\n").filter((line) => /(?:->)?\s*[A-Za-z].*(cost=|actual time=)/.test(line));
  return lines.slice(0, 24).map((line) => {
    const indent = line.match(/^\s*/)[0].length;
    const cleaned = line.replace(/^\s*->\s*/, "").trim();
    const cost = cleaned.match(/cost=(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)/i);
    const actual = cleaned.match(/actual time=(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)/i);
    const rows = cleaned.match(/rows=(\d+)/i);
    let severity = "good";
    if (/\b(?:seq scan|full table scan|external merge|disk)\b/i.test(cleaned)) {
      severity = "high";
    } else if (/\b(?:nested loop|sort|hash)\b/i.test(cleaned)) {
      severity = "medium";
    }

    return {
      severity,
      title: cleaned.replace(/\s*\(.*/, ""),
      body: cleaned,
      indent,
      cost: cost ? Number(cost[2]) : null,
      actual: actual ? Number(actual[2]) : null,
      rows: rows ? Number(rows[1]) : null,
    };
  });
}

function scoreFromReport(report) {
  return Math.max(5, Math.min(98, 100 - report.cost));
}

function renderReport(report) {
  const score = scoreFromReport(report);
  scoreValue.textContent = score;
  scoreRing.style.setProperty("--score", `${score}%`);
  scoreRing.classList.remove("good", "warn", "bad");
  scoreRing.classList.add(score > 78 ? "good" : score > 55 ? "warn" : "bad");
  scoreTitle.textContent = score > 78 ? "Healthy shape" : score > 55 ? "Worth tuning" : "Needs attention";
  scoreText.textContent =
    score > 78
      ? "The query has a clean baseline. Validate with EXPLAIN and real table statistics."
      : "The analyzer found patterns that can increase scans, sorts, or unnecessary reads.";
  costMetric.textContent = report.cost;
  riskMetric.textContent = report.risks;
  indexMetric.textContent = report.indexes.length;
  optimizedOutput.textContent = report.optimized;
  renderTab();
}

function renderTab() {
  const list = lastReport?.[activeTab] || [];
  tabContent.innerHTML = "";

  if (activeTab === "tree") {
    renderTree(list);
    return;
  }

  if (activeTab === "diff") {
    renderDiff(list);
    return;
  }

  if (activeTab === "breakdown") {
    renderBreakdown(list);
    return;
  }

  if (activeTab === "history") {
    renderHistory(readHistory());
    return;
  }

  list.forEach((item) => {
    const row = document.createElement("article");
    row.className = "finding";
    row.innerHTML = `
      <span class="severity ${item.severity}" aria-hidden="true"></span>
      <div>
        <strong></strong>
        <p></p>
      </div>
    `;
    row.querySelector("strong").textContent = item.title;
    row.querySelector("p").textContent = item.body;
    tabContent.append(row);
  });
}

function renderTree(nodes) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-list";
  if (!nodes.length) {
    wrapper.append(emptyState("No EXPLAIN tree yet", "Paste an EXPLAIN plan and click Analyze."));
  }

  nodes.forEach((node) => {
    const item = document.createElement("article");
    item.className = `tree-node ${node.severity}`;
    item.style.marginLeft = `${Math.min(48, node.indent * 2)}px`;
    item.innerHTML = `
      <strong></strong>
      <span class="tree-meta"></span>
      <code></code>
    `;
    item.querySelector("strong").textContent = node.title;
    item.querySelector(".tree-meta").textContent = [
      node.cost === null ? "" : `cost ${Math.round(node.cost).toLocaleString()}`,
      node.actual === null ? "" : `actual ${Math.round(node.actual).toLocaleString()} ms`,
      node.rows === null ? "" : `${node.rows.toLocaleString()} rows`,
    ].filter(Boolean).join(" · ");
    item.querySelector("code").textContent = node.body;
    wrapper.append(item);
  });

  tabContent.append(wrapper);
}

function renderDiff(rows) {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-view";
  rows.forEach((row) => {
    const item = document.createElement("div");
    const className = row.marker === "+" ? "added" : row.marker === "-" ? "removed" : "";
    item.className = `diff-row ${className}`;
    item.innerHTML = "<span></span><code></code>";
    item.querySelector("span").textContent = row.marker;
    item.querySelector("code").textContent = row.body;
    wrapper.append(item);
  });
  tabContent.append(wrapper);
}

function renderBreakdown(items) {
  const wrapper = document.createElement("div");
  wrapper.className = "score-breakdown";
  if (!items.length) {
    wrapper.append(emptyState("No penalties found", "The score is currently driven by baseline cost and validation reminders."));
  }

  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = `breakdown-row ${item.impact > 0 ? "good" : ""}`;
    row.innerHTML = `
      <strong></strong>
      <div>
        <strong></strong>
        <p></p>
      </div>
    `;
    row.children[0].textContent = `${item.impact > 0 ? "+" : ""}${item.impact}`;
    row.querySelector("div strong").textContent = item.title;
    row.querySelector("p").textContent = item.body;
    wrapper.append(row);
  });

  tabContent.append(wrapper);
}

function renderHistory(history) {
  const wrapper = document.createElement("div");
  wrapper.className = "history-list";
  if (!history.length) {
    wrapper.append(emptyState("No saved runs", "Click Save after optimizing to keep a local history of attempts."));
  }

  history.forEach((entry, index) => {
    const item = document.createElement("article");
    item.className = "history-item";
    item.innerHTML = `
      <strong></strong>
      <span class="history-meta"></span>
      <div class="history-actions">
        <button type="button" data-load-history="${index}">Load</button>
        <button type="button" data-delete-history="${index}">Delete</button>
      </div>
    `;
    item.querySelector("strong").textContent = entry.title;
    item.querySelector(".history-meta").textContent = `${entry.dialect} · score ${entry.score} · ${entry.savedAt}`;
    wrapper.append(item);
  });

  tabContent.append(wrapper);
}

function emptyState(title, body) {
  const row = document.createElement("article");
  row.className = "finding";
  row.innerHTML = `
    <span class="severity medium" aria-hidden="true"></span>
    <div>
      <strong></strong>
      <p></p>
    </div>
  `;
  row.querySelector("strong").textContent = title;
  row.querySelector("p").textContent = body;
  return row;
}

function runOptimizer() {
  lastReport = analyzeSql(sqlInput.value, schemaInput.value, dialectInput.value, explainInput.value);
  renderReport(lastReport);
}

function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(historyKey) || "[]");
  } catch {
    return [];
  }
}

function writeHistory(history) {
  localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 12)));
}

function saveCurrentRun() {
  if (!lastReport) {
    runOptimizer();
  }

  const history = readHistory();
  const firstLine = normalizeWhitespace(sqlInput.value).slice(0, 72) || "Untitled query";
  history.unshift({
    title: firstLine,
    savedAt: new Date().toLocaleString(),
    dialect: dialectInput.value,
    score: scoreFromReport(lastReport),
    sql: sqlInput.value,
    schema: schemaInput.value,
    intent: intentInput.value,
    explain: explainInput.value,
  });
  writeHistory(history);
  lastReport.history = readHistory();
  activeTab = "history";
  tabs.forEach((item) => item.classList.toggle("active", item.dataset.tab === activeTab));
  renderTab();
}

function loadHistoryEntry(index) {
  const entry = readHistory()[index];
  if (!entry) {
    return;
  }
  dialectInput.value = entry.dialect || "postgres";
  sqlInput.value = entry.sql || "";
  schemaInput.value = entry.schema || "";
  intentInput.value = entry.intent || "";
  explainInput.value = entry.explain || "";
  updateStats();
  runOptimizer();
}

function deleteHistoryEntry(index) {
  const history = readHistory();
  history.splice(index, 1);
  writeHistory(history);
  if (lastReport) {
    lastReport.history = readHistory();
  }
  renderTab();
}

sampleButton.addEventListener("click", () => {
  sqlInput.value = sampleSql;
  schemaInput.value = sampleSchema;
  intentInput.value = "Show each customer and their total order value for completed orders in 2025, highest spenders first, only top 20.";
  explainInput.value = `Nested Loop  (cost=0.84..25340.18 rows=42000 width=96) (actual time=2.104..1842.551 rows=38120 loops=1)
  ->  Seq Scan on orders o  (cost=0.00..18420.00 rows=82000 width=40) (actual time=0.088..961.443 rows=79000 loops=1)
        Filter: (date_part('year'::text, created_at) = 2025)
        Rows Removed by Filter: 214000
  ->  Index Scan using customers_pkey on customers c  (cost=0.42..0.51 rows=1 width=56) (actual time=0.006..0.006 rows=1 loops=79000)`;
  updateStats();
  runOptimizer();
});

optimizeButton.addEventListener("click", runOptimizer);
dialectInput.addEventListener("change", runOptimizer);
saveRunButton.addEventListener("click", saveCurrentRun);

buildQueryButton.addEventListener("click", () => {
  sqlInput.value = buildSqlFromIntent(intentInput.value, schemaInput.value, dialectInput.value);
  updateStats();
  runOptimizer();
});

analyzeExplainButton.addEventListener("click", runOptimizer);

copyButton.addEventListener("click", async () => {
  const text = optimizedOutput.textContent;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
    copyButton.textContent = "Copied";
  } catch {
    copyButton.textContent = "Copy failed";
  }

  window.setTimeout(() => {
    copyButton.innerHTML =
      '<span class="icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5.5" y="5.5" width="8" height="8" rx="1.3" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.2V3.8A1.3 1.3 0 0 1 4.8 2.5h6.4" stroke="currentColor" stroke-width="1.3"/></svg></span> Copy';
  }, 1200);
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    activeTab = tab.dataset.tab;
    renderTab();
  });
});

tabContent.addEventListener("click", (event) => {
  const loadButton = event.target.closest("[data-load-history]");
  const deleteButton = event.target.closest("[data-delete-history]");
  if (loadButton) {
    loadHistoryEntry(Number(loadButton.dataset.loadHistory));
  }
  if (deleteButton) {
    deleteHistoryEntry(Number(deleteButton.dataset.deleteHistory));
  }
});

sqlInput.addEventListener("input", updateStats);

sqlInput.value = sampleSql;
schemaInput.value = sampleSchema;
intentInput.value = "Show each customer and their total order value for completed orders in 2025, highest spenders first, only top 20.";
updateStats();
runOptimizer();
