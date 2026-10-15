const src = require("fs").readFileSync("db.js", "utf8");
let depth = 0;
const stack = [];
let i = 0;
let line = 1;
let mode = "code";
let modeStack = [];
let tplStart = 0;

function err(msg) {
  console.log("line " + line + ": " + msg);
  process.exit(1);
}

while (i < src.length) {
  const c = src[i];
  const c2 = src[i + 1];
  if (c === "\n") line++;

  if (mode === "code") {
    if (c === "/" && c2 === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) err("unterminated block comment");
      line += (src.slice(i, end).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    if (c === "'") { mode = "sq"; i++; continue; }
    if (c === '"') { mode = "dq"; i++; continue; }
    if (c === "`") { modeStack.push("tpl"); mode = "tpl"; tplStart = line; i++; continue; }
    if (c === "{") { depth++; stack.push(line); }
    if (c === "}") {
      depth--;
      stack.pop();
      if (depth < 0) err("extra }");
      if (modeStack.length && modeStack[modeStack.length - 1] === "brace") {
        modeStack.pop();
        mode = "tpl";
      }
    }
  } else if (mode === "sq") {
    if (c === "\\") { i += 2; continue; }
    if (c === "'") mode = "code";
    if (c === "\n") err("unterminated single-quote string");
  } else if (mode === "dq") {
    if (c === "\\") { i += 2; continue; }
    if (c === '"') mode = "code";
    if (c === "\n") err("unterminated double-quote string");
  } else if (mode === "tpl") {
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      modeStack.pop();
      mode = modeStack.length ? "code" : "code";
      i++;
      continue;
    }
    if (c === "$" && c2 === "{") {
      modeStack.push("brace");
      mode = "code";
      i += 2;
      depth++;
      stack.push(line);
      continue;
    }
  }
  i++;
}

if (mode === "tpl") err("unterminated template literal opened at line " + tplStart);
if (mode !== "code") err("unterminated string");
console.log("final brace depth:", depth);
console.log("unclosed { opened at lines:", stack.join(", "));
console.log("modeStack remaining:", JSON.stringify(modeStack));
