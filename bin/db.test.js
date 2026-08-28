#!/usr/bin/env node
/** db CLI 的离线安全测试，不连接真实数据库。 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
	MYCLI_PATH,
	parseArgs,
	validateTableName,
	validateReadOnlySql,
	buildSql,
	buildMycliArgs,
} = require("./db");

function throws(fn) {
	assert.throws(fn);
}

for (const command of ["tables", "schema", "query", "explain"]) {
	assert.equal(parseArgs(["mysql", command, ...(command === "tables" ? [] : [command === "schema" ? "users" : "SELECT 1"]) ]).command, command);
}
for (const args of [[], ["mysql"], ["postgres", "tables"], ["mysql", "nope"], ["mysql", "tables", "x"], ["mysql", "schema"], ["mysql", "schema", "a.b"], ["mysql", "query"], ["mysql", "query", "SELECT 1", "extra"], ["mysql", "query", "--password=x"]]) throws(() => parseArgs(args));
assert.deepEqual(parseArgs(["--help"]), { help: true });
assert.equal(validateTableName("users_2024$"), true);
for (const name of ["", "a.b", "`users`", "users;DROP", "--help", "users name"]) assert.equal(validateTableName(name), false);
for (const sql of ["SELECT 1", "SHOW TABLES;", "DESCRIBE users", "DESC users"]) assert.doesNotThrow(() => validateReadOnlySql(sql));
for (const sql of [
	"DROP TABLE users", "DELETE FROM users", "UPDATE users SET x=1", "INSERT INTO users VALUES (1)",
	"ALTER TABLE users ADD x INT", "TRUNCATE users", "CREATE TABLE x (id INT)", "CALL p()", "SET @x=1",
	"SELECT 1; SELECT 2", "SELECT 1 -- comment", "SELECT 1 # comment", "SELECT /* x */ 1",
	"SELECT * INTO OUTFILE '/tmp/x' FROM users", "SELECT LOAD_FILE('/tmp/x')", "SELECT * FROM users FOR UPDATE",
]) throws(() => validateReadOnlySql(sql));
for (const sql of ["EXPLAIN ANALYZE SELECT 1", "SHOW TABLES", "UPDATE users SET x=1"]) throws(() => validateReadOnlySql(sql, "explain"));
assert.equal(buildSql("tables"), "SHOW TABLES");
assert.equal(buildSql("schema", "users"), "SHOW CREATE TABLE `users`");
assert.equal(buildSql("query", "SELECT 1;"), "SELECT 1");
assert.equal(buildSql("explain", "SELECT * FROM users"), "EXPLAIN SELECT * FROM users");
assert.equal(MYCLI_PATH, "/home/efren/.local/bin/mycli");
assert.deepEqual(buildMycliArgs("SHOW TABLES"), ["--noninteractive", "--execute", "SHOW TABLES"]);
assert.equal(buildMycliArgs("SHOW TABLES").includes("--password"), false);
const help = execFileSync(process.execPath, [require.resolve("./db"), "--help"], { encoding: "utf8" });
assert.match(help, /mysql tables/);
console.log("db.test.js: 全部通过");
