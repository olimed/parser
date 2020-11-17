const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const syntax = require("postcss-less");
const autoprefixer = require("autoprefixer");

/**
 * Function devides str into an ordered list of substrings
 *
 * @param {String} str
 *
 * @return {Array<String>}
 */
function parseParams(str) {
  if (str.includes("(")) {
    const allParams = str.split("(").reduce((allArgs, args) => {
      allArgs = [
        ...allArgs,
        ...args.split(",").filter((val) => !val.trim().indexOf("@")),
      ];
      return allArgs;
    }, []);
    return allParams;
  }
  const params = str.split(",").map((p) => p.trim());
  return params.filter((p) => !p.toString().trim().indexOf("@"));
}

/**
 * Get full selectors
 *
 * @param {Array<String>|String} selector
 * @param {postcss.Node} decl
 *
 * @return {Array<String>}
 */
function parseSelector(selector, decl) {
  if (decl.type == "root") return selector;
  const selectors = Array.isArray(selector)
    ? [...selector]
    : selector.replace(/(\r\n|\n|\r)/gm, "").split(",");
  const parentSelectors = decl.parent.selector
    ? decl.parent.selector.replace(/(\r\n|\n|\r)/gm, "").split(",")
    : [""];
  const mapSelectors = [];
  selectors.forEach((selectr) => {
    parentSelectors.forEach((parentSelector) => {
      const fullSelector = selectr.trim().split("&")[1]
        ? `${parentSelector}${selectr.trim().split("&")[1]}`
        : `${parentSelector ? parentSelector : ""} ${selectr.trim()}`.trim();
      mapSelectors.push(fullSelector);
    });
  });
  return parseSelector(mapSelectors, decl.parent);
}

function findAllSelectorsByVar(allVars, nameVar, selectors = {}) {
  if (allVars[nameVar].value) {
    if (!allVars[nameVar].value.includes("@")) {
      allVars[nameVar].selectors = {
        ...allVars[nameVar].selectors,
        ...selectors,
      };
      return allVars[nameVar].selectors;
    }
    const names = parseParams(allVars[nameVar].value);
    selectors = {
      ...selectors,
      ...allVars[nameVar].selectors,
    };
    names.forEach((name) => {
      const selector = findAllSelectorsByVar(allVars, name, selectors);
      selectors = { ...selectors, ...selector };
    });
  }
  return selectors;
}

function parseVariables(allVars) {
  Object.keys(allVars).forEach((key) => {
    if (allVars[key].value && allVars[key].value.includes("@")) {
      const selectors = findAllSelectorsByVar(allVars, key);
      allVars[key].selectors = {
        ...allVars[key].selectors,
        ...selectors,
      };
    }
  });
}

/**
 * Get all selectors and value for variables
 *
 * @param {postcss.Root} root
 *
 * @return {{selectors: Object<String, Array<String>, value: String}}
 */
function walkDecls(root) {
  const output = {};
  const { vars } = getVarsAndMixins(root);
  root.walkDecls((decl) => {
    const ind = decl.value.toString().indexOf("@");
    if (ind != -1) {
      const selectors = parseSelector(
        decl.parent.selector.toString
          ? decl.parent.selector.toString()
          : decl.parent.selector.split('"')[1],
        decl.parent
      );
      const varName = ind == 0 ? [decl.value] : parseParams(decl.value);
      varName.forEach((v) => {
        selectors.forEach((selector) => {
          output[v] = {
            [selector.toString()]: [],
            ...output[v],
          };
          output[v][selector.toString()].push(decl.prop);
        });
      });
    }
  });

  const map = vars.reduce((prev, currValue) => {
    prev[currValue.name] = {
      selectors: output[currValue.name] || {},
      value: currValue.value,
    };
    return prev;
  }, output);
  return map;
}

/**
 * Get all mixins (that are called) and variables
 *
 * @param {postcss.Root} root
 *
 * @return {{atRuleMixins: Array<postcss.AtRule>, vars: Array<{name: String, value: String}>}}
 */
function getVarsAndMixins(root) {
  const result = { atRuleMixins: [], vars: [] };
  root.walkAtRules((atrule) => {
    if (atrule.mixin) {
      result.atRuleMixins.push(atrule);
    } else if (atrule.name != "import" && atrule.name != "media") {
      // todo
      result.vars.push({
        name: `@${atrule.name.toString().split(":")[0]}`,
        value: atrule.params,
      });
    }
  });
  return result;
}

function checkRule(rule) {
  let isCheck = true;
  rule.walkAtRules((atrule) => {
    if (atrule) {
      isCheck = false;
    }
  });
  rule.walkRules((r) => {
    if (r) {
      isCheck = false;
    }
  });
  return isCheck;
}

function getAllMixins(root) {
  const mapMixins = {};
  function parseRule(node) {
    if (!node.nodes || node.nodes.length) {
      if (node.type === "decl") {
        return node;
      }
      if (node.mixin) {
        const mixinName = `${node.raws.identifier}${node.name}`;
        mapMixins[mixinName].nodes.forEach((child) => {
          node.before(child.clone());
        });
        node.remove();
        return { mixin: true };
      }
    }
    node.each((child) => {
      if (child.type === "rule" && !mapMixins[child.selector.split("(")[0]]) {
        const name =
          child.selector[0] === "&"
            ? parseSelector(child.selector.split("(")[0], child)
            : child.selector.split("(")[0];
        mapMixins[name] = parseRule(child);
      } else {
        const newChild = parseRule(child);
        if (!newChild.mixin) {
          child.replaceWith(newChild);
        }
      }
    });
    return node;
  }

  root.walkRules((node) => {
    if (node.type === "rule") {
      let newRule = node;
      if (!checkRule(node)) {
        newRule = parseRule(node);
      }
      const mixinName =
        newRule.selector[0] === "&"
          ? parseSelector(newRule.selector.split("(")[0], node)
          : newRule.selector.split("(")[0];
      mapMixins[mixinName] = newRule;
    }
  });
  return mapMixins;
}

function getCleanTree(ast) {
  const newAst = { ...ast };
  newAst.root.walkComments((comment) => {
    comment.remove();
  });
  return newAst;
}

function getAllFilesName(root, mainPath) {
  const pathFiles = [];
  const mainDir = path.dirname(mainPath);
  root.walkAtRules((rule) => {
    if (rule.name === "import") {
      pathFiles.push(path.join(mainDir, rule.params.split('"')[1]));
    }
  });
  return pathFiles;
}

async function importAllFiles(pathes) {
  try {
    const mainPath = path.join(__dirname, "./dist/main.less");
    if (!fs.existsSync(path.join(__dirname, "./dist"))) {
      fs.mkdirSync(path.join(__dirname, "./dist"));
    }
    const fd = fs.openSync(mainPath, "w+");
    pathes.forEach((p) => {
      const newLess = fs.readFileSync(p, "utf8");
      if (newLess) {
        fs.appendFileSync(mainPath, Buffer.from(newLess));
      }
    });
    fs.closeSync(fd);
    const less = fs.readFileSync(
      path.join(__dirname, "dist/main.less"),
      "utf8"
    );
    const res = await postcss(autoprefixer()).process(less, {
      syntax,
      from: mainPath,
    });
    return res;
  } catch (error) {
    console.log(error);
    throw error;
  }
}

function writeToFile(text) {
  try {
    const mainPath = "./dist/result.json";
    if (!fs.existsSync("./dist")) {
      fs.mkdirSync("./dist");
    }
    const fd = fs.openSync(mainPath, "w+");
    fs.writeFileSync(mainPath, Buffer.from(JSON.stringify(text)));
    fs.closeSync(fd);
  } catch (error) {
    console.log(error);
    throw error;
  }
}

function filterVariables(allVars, vars) {
  return vars.reduce((prevValue, currentValue) => {
    prevValue[currentValue] = allVars[currentValue] || {};
    return prevValue;
  }, {});
}

async function start(varPath, mainPath) {
  try {
    let vars = fs.readFileSync(varPath, "utf8");
    vars = JSON.parse(vars);
    const mainLess = fs.readFileSync(mainPath, "utf8");
    const mainRoot = await postcss(autoprefixer()).process(mainLess, {
      syntax,
      from: mainPath,
    });
    const allImports = getAllFilesName(mainRoot.root, mainPath);
    allImports.push(mainPath);
    const newRoot = await importAllFiles(allImports);

    const ast = getCleanTree(newRoot);
    const mapMixins = getAllMixins(ast.root);
    const allDecl = walkDecls(newRoot.root);
    parseVariables(allDecl);
    const filteredVars = filterVariables(allDecl, vars);
    writeToFile(filteredVars);
  } catch (error) {
    console.log(error);
    throw error;
  }
}

start(
  path.join(__dirname, "variables.json"),
  path.join(__dirname, "example/example.less")
);
