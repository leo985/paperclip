const fs = require("node:fs");
const path = require("node:path");

const modules = path.join(process.cwd(), "node_modules", ".pnpm");
function dependency(name) {
  const candidates = fs.readdirSync(modules).filter(entry => entry.startsWith(name + "@"));
  const versions = candidates.toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const version of versions) {
    const module = path.join(modules, version, "node_modules", name);
    if (fs.existsSync(path.join(module, "package.json"))) return require(module);
  }
  throw Error("Release requires the workspace dependency " + name);
}
const acorn = dependency("acorn");
const esbuild = dependency("esbuild");
const parse = text => acorn.parse(text, { ecmaVersion: "latest", sourceType: "module" });
function find(node, predicate, result = []) {
  if (!node || typeof node.type !== "string") return result;
  if (predicate(node)) result.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) find(child, predicate, result);
    else find(value, predicate, result);
  }
  return result;
}
function compile(file, jsx = false) {
  return esbuild.transformSync(fs.readFileSync(file, "utf8"), {
    loader: jsx ? "tsx" : "ts", jsx: "automatic", format: "esm", target: "es2022", charset: "utf8", sourcefile: file,
  }).code;
}
function edit(source, patches) {
  let remaining = source.length;
  const trailing = [];
  for (const patch of patches.toSorted((a, b) => b.start - a.start || b.end - a.end)) {
    if (patch.end > remaining) throw Error("Release patch overlaps another edit");
    trailing.push(source.slice(patch.end, remaining), patch.text);
    remaining = patch.start;
  }
  const result = source.slice(0, remaining) + trailing.reverse().join("");
  parse(result);
  return result;
}
function patchRoute(live, candidate, route) {
  const matches = node => {
    const call = node.expression;
    const argument = call?.arguments?.[0];
    return node.type === "ExpressionStatement" && call?.type === "CallExpression" &&
      call.callee.object?.name === "router" && call.callee.property?.name === route.method &&
      (argument?.value === route.path || (argument?.left?.name === "base" && argument.right?.value === route.path));
  };
  const before = parse(live), after = parse(candidate);
  const originals = find(before, matches), replacements = find(after, matches);
  if (originals.length !== 1 || replacements.length !== 1) throw Error("Route anchor is absent or ambiguous: " + route.path);
  const imports = find(before, node => node.type === "ImportDeclaration");
  const extra = [];
  for (const { from, name } of route.imports ?? []) {
    const existing = imports.find(node => node.specifiers.some(specifier => specifier.local.name === name));
    if (existing && existing.source.value !== from) throw Error("Conflicting import " + name);
    if (!existing) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw Error("Invalid import name");
      const found = find(after, node => node.type === "ImportDeclaration" && node.source.value === from &&
        node.specifiers.some(specifier => specifier.imported?.name === name && specifier.local.name === name));
      if (!found.length) throw Error("Import not found in source: " + name);
      extra.push(`import { ${name} } from ${JSON.stringify(from)};\n`);
    }
  }
  return edit(live, [{
    start: originals[0].start, end: originals[0].end,
    text: candidate.slice(replacements[0].start, replacements[0].end),
  }, { start: 0, end: 0, text: extra.join("") }]);
}
function patchComponents(live, asset) {
  const ast = parse(live);
  const patches = [];
  for (const component of asset.components ?? []) {
    const { name } = component;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw Error("Invalid component name");
    const candidate = compile(component.source, true);
    const candidateAst = parse(candidate);
    if (!candidateAst.body.some(node => node.type === "FunctionDeclaration" && node.id.name === name))
      throw Error("Expected top-level function " + name);
    const body = candidateAst.body.filter(node => !["ImportDeclaration", "ExportNamedDeclaration"].includes(node.type))
      .map(node => candidate.slice(node.start, node.end)).join("\n");
    const targets = find(ast, node => node.type === "FunctionDeclaration" && node.id?.name === name &&
      live.slice(node.start, node.end).includes(component.anchor));
    if (targets.length !== component.count) throw Error(`Expected ${component.count} occurrences of ${name}, found ${targets.length}`);
    const bindings = Object.entries(component.bindings ?? {});
    if (bindings.some(([key, value]) => !/^[\w$]+$/.test(key) || !/^[\w$.]+$/.test(value)))
      throw Error("Component bindings must be identifiers or property paths");
    const parameters = bindings.map(([key]) => key).join(", ");
    const values = bindings.map(([, value]) => value).join(", ");
    for (const target of targets) {
      const wrapper = find(ast, node => node.type === "VariableDeclaration" && node.declarations[0]?.id.name === name &&
        node.start < target.start && node.end > target.end &&
        live.slice(node.start, target.start).includes("/* intranet-release component */")).at(-1);
      patches.push({
        start: (wrapper ?? target).start, end: (wrapper ?? target).end,
        text: `const ${name} = /* intranet-release component */ ((${parameters}) => {\n${body}\nreturn ${name};\n})(${values});`,
      });
    }
  }
  for (const replacement of asset.replacements ?? []) {
    if (!replacement.from || replacement.from === replacement.to) throw Error("Invalid exact UI replacement");
    const occurrences = [];
    let start = 0;
    while ((start = live.indexOf(replacement.from, start)) !== -1) {
      occurrences.push({ start, end: start + replacement.from.length, text: replacement.to });
      start += replacement.from.length;
    }
    if (!occurrences.length && replacement.alreadyApplied && live.includes(replacement.to)) continue;
    if (occurrences.length !== 1) throw Error("Expected one exact UI replacement");
    patches.push(...occurrences);
  }
  return edit(live, patches);
}

const [kind, input, baseline, output] = process.argv.slice(2);
const item = JSON.parse(input);
const live = baseline === "-" ? "" : fs.readFileSync(baseline, "utf8");
const content = kind === "ui" || item.replacements ? patchComponents(live, item) : item.route
  ? patchRoute(live, compile(item.source), item.route) : compile(item.source);
fs.writeFileSync(output, content);
