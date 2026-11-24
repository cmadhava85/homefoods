const ts = require("typescript");
const path = require("path");
const cfgPath = path.resolve("tsconfig.json");
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, path.dirname(cfgPath));
const file = path.resolve(".scratch-agent/types.ts");
const prog = ts.createProgram([file], { ...cfg.options, noEmit: true });
const chk = prog.getTypeChecker();
const sf = prog.getSourceFile(file);
for (const st of sf.statements) if (ts.isTypeAliasDeclaration(st) && (!process.argv[2] || st.name.text===process.argv[2])) {
  const t = chk.getTypeAtLocation(st.name);
  console.log("=== " + st.name.text + "\n" + chk.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias));
}
