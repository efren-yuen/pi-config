#!/usr/bin/env node
/** 假语言服务器：故意把客户端必须应答的几类服务器请求全发一遍，并记录客户端的应答。 */
const fs = require("node:fs");
const RECORD = process.env.FAKE_RECORD;
const record = { responses: {}, received: [] };
const flush = () => fs.writeFileSync(RECORD, JSON.stringify(record, null, 2));

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const header = buffer.subarray(0, end).toString("ascii");
		const len = Number(/content-length:\s*(\d+)/i.exec(header)[1]);
		const start = end + 4;
		if (buffer.length < start + len) return;
		const body = buffer.subarray(start, start + len).toString("utf8");
		buffer = buffer.subarray(start + len);
		handle(JSON.parse(body));
	}
});

function send(msg) {
	const body = Buffer.from(JSON.stringify(msg), "utf8");
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

let openedUri = null;

function handle(msg) {
	if (msg.id !== undefined && msg.method === undefined) {
		// 这是客户端对我们请求的应答，记下来。
		record.responses[String(msg.id)] = msg.error ? { error: msg.error } : { result: msg.result };
		flush();
		return;
	}
	record.received.push(msg.method);
	flush();

	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, documentSymbolProvider: true, referencesProvider: true } } });
		return;
	}
	if (msg.method === "initialized") {
		// 五类服务器→客户端请求，全部必须被应答。
		send({ jsonrpc: "2.0", id: 100, method: "client/registerCapability", params: { registrations: [] } });
		send({ jsonrpc: "2.0", id: 101, method: "workspace/configuration", params: { items: [{ section: "fake.deep" }, { section: "fake.missing" }] } });
		send({ jsonrpc: "2.0", id: 102, method: "window/workDoneProgress/create", params: { token: "t1" } });
		send({ jsonrpc: "2.0", id: 103, method: "workspace/applyEdit", params: { edit: {} } });
		send({ jsonrpc: "2.0", id: 104, method: "frobnicate/unknown", params: {} });
		setTimeout(() => send({ jsonrpc: "2.0", method: "fake/status", params: { type: "Ready" } }), 20);
		return;
	}
	if (msg.method === "textDocument/didOpen") {
		openedUri = msg.params.textDocument.uri;
		const text = msg.params.textDocument.text;
		// 正文里出现 BOOM 就报一条错误诊断，用来验证改文件后诊断会跟着变。
		const diagnostics = text.includes("BOOM")
			? [{ range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, severity: 1, code: "E42", source: "fake", message: "爆炸了" }]
			: [];
		setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: openedUri, diagnostics } }), 15);
		return;
	}
	if (msg.method === "textDocument/definition") {
		send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: openedUri, range: { start: { line: 5, character: 2 }, end: { line: 5, character: 9 } } }] });
		return;
	}
	if (msg.method === "textDocument/documentSymbol") {
		send({ jsonrpc: "2.0", id: msg.id, result: [
			{ name: "外层", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } },
			  children: [{ name: "目标方法", kind: 6, range: { start: { line: 3, character: 2 }, end: { line: 5, character: 3 } }, selectionRange: { start: { line: 3, character: 7 }, end: { line: 3, character: 11 } } }] },
		] });
		return;
	}
	if (msg.method === "shutdown") {
		send({ jsonrpc: "2.0", id: msg.id, result: null });
		return;
	}
	if (msg.method === "exit") process.exit(0);
	if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "fake server: no such method" } });
}
